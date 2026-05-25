/**
 * Polls pk_sync_jobs and pk_doc_generation_jobs, runs ingestion and documentation generation.
 *
 * Usage: `npm run worker:ingest` (loop) or `npm run worker:ingest -- --once`
 *
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
 *
 * CodeWiki (optional): `codewiki` on PATH after `npm run codewiki:setup`: uses OPENAI_API_KEY unless CODEWIKI_API_KEY is set.
 *
 * Logs: optional per-job files under PK_WORKER_LOG_DIR (default logs/worker/<YYYY-MM-DD>/…).
 */
import { existsSync } from 'fs'
import { config } from 'dotenv'
import { join } from 'path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  isJobCancelRequested,
  isJobPauseRequested,
  JobAbortRequestedError,
  JobPauseRequestedError,
} from '@/server/pipelines/job-abort'
import { processDocGenerationJob } from '@/server/pipelines/doc-job'
import { ingestBitbucketSyncJob } from '@/server/pipelines/repo-ingest'
import {
  buildJobLogAbsolutePath,
  loadDocJobLogContext,
  loadSyncJobLogContext,
  withConsoleTee,
  workerLogRootDir,
} from '@/worker/job-logging'

/**
 * Load env files. Use `override: true` so shell/System empty vars (e.g. NEXT_PUBLIC_SUPABASE_URL=)
 * do not block values from `.env.local`. Next convention: `.env.local`; some repos use `env.local`.
 */
const root = process.cwd()
config({ path: join(root, '.env.local'), override: true })
config({ path: join(root, 'env.local'), override: true })
config({ path: join(root, '.env'), override: true })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let shutdownRequested = false

async function claimNextSyncJob(supabase: SupabaseClient): Promise<string | null> {
  const { data: row } = await supabase
    .from('pk_sync_jobs')
    .select('id')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  const job = row as { id: string } | null
  if (!job?.id) return null

  const { data: claimed, error } = await supabase
    .from('pk_sync_jobs')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
      error_message: null,
    })
    .eq('id', job.id)
    .eq('status', 'queued')
    .select('id')

  if (error || !claimed?.length) return null
  return job.id
}

async function claimNextDocJob(supabase: SupabaseClient): Promise<string | null> {
  const { data: row } = await supabase
    .from('pk_doc_generation_jobs')
    .select('id')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  const job = row as { id: string } | null
  if (!job?.id) return null

  const { data: claimed, error } = await supabase
    .from('pk_doc_generation_jobs')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
      error_message: null,
    })
    .eq('id', job.id)
    .eq('status', 'queued')
    .select('id')

  if (error || !claimed?.length) return null
  return job.id
}

function installSignalHandlers(): void {
  const onStop = (sig: string) => {
    if (shutdownRequested) {
      console.log(`\n[worker] ${sig} again: forcing exit now.`)
      process.exit(130)
    }
    shutdownRequested = true
    console.log(
      `\n[worker] ${sig} received: stopping Bitbucket retries and finishing the current step; press Ctrl+C again to force quit.`
    )
  }
  process.on('SIGINT', () => onStop('SIGINT'))
  process.on('SIGTERM', () => onStop('SIGTERM'))
}

function printStartupBanner(once: boolean, logRoot: string | null): void {
  const cwd = process.cwd()
  const mode = once ? 'single pass (--once)' : 'continuous (4s idle poll)'
  const logBlock = logRoot
    ? ` Job logs root     | ${join(cwd, logRoot)}\n                   | <date>/<file>.log`
    : ` Job logs          | off (set PK_WORKER_LOG_DIR, e.g. logs/worker)`
  // One write: avoids garbled/overlapping lines in some Windows terminals with Unicode box chars
  console.log(
    `\n----------------------------------------------------------------\n` +
      ` PK ingest worker | pid ${process.pid}\n` +
      ` Mode             | ${mode}\n` +
      ` Started          | ${new Date().toISOString()}\n` +
      `${logBlock}\n` +
      ` Stop             | Ctrl+C (twice = force exit)\n` +
      `----------------------------------------------------------------\n`
  )
}

async function run() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) {
    const localPath = join(process.cwd(), '.env.local')
    const altPath = join(process.cwd(), 'env.local')
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    console.error(`  process.cwd(): ${process.cwd()}`)
    console.error(`  ${localPath}: ${existsSync(localPath) ? 'exists' : 'MISSING'}`)
    console.error(`  ${altPath}: ${existsSync(altPath) ? 'exists' : 'MISSING'}`)
    console.error(
      '  Tip: use file name .env.local (leading dot), UTF-8 without BOM, KEY=value per line. Unset empty env vars in Windows if they shadow these keys.'
    )
    process.exit(1)
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.error('Missing OPENAI_API_KEY')
    process.exit(1)
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const once = process.argv.includes('--once')
  const logRoot = workerLogRootDir()
  installSignalHandlers()
  printStartupBanner(once, logRoot)

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (shutdownRequested) {
      console.log(`[worker] Exiting at ${new Date().toISOString()} (shutdown requested).`)
      break
    }

    const syncJobId = await claimNextSyncJob(supabase)
    if (syncJobId) {
      let ctx = null as Awaited<ReturnType<typeof loadSyncJobLogContext>> | null
      try {
        ctx = await loadSyncJobLogContext(supabase, syncJobId)
      } catch (e) {
        console.warn('[worker] Could not load sync job context for file log:', e instanceof Error ? e.message : e)
      }
      const logAbs = ctx && logRoot ? buildJobLogAbsolutePath(logRoot, ctx) : null

      let userCancelRequested = false
      const refreshSyncCancelFromDb = async () => {
        const { data } = await supabase.from('pk_sync_jobs').select('status, meta').eq('id', syncJobId).maybeSingle()
        if (data && String((data as { status?: string }).status) !== 'running') {
          userCancelRequested = true
          return
        }
        if (isJobCancelRequested((data as { meta?: unknown })?.meta)) {
          userCancelRequested = true
        }
      }
      await refreshSyncCancelFromDb().catch(() => {})
      const cancelPoll = setInterval(() => {
        void refreshSyncCancelFromDb().catch(() => {})
      }, 500)

      const runSyncBody = async () => {
        const t0 = Date.now()
        console.log(`── Sync job start · ${syncJobId} · ${new Date().toISOString()} ──`)
        if (ctx) {
          console.log(
            `   workspace: ${ctx.workspaceName} (${ctx.workspaceId})  plan: ${ctx.billingPlan}  user: ${ctx.userLabel}`
          )
          if (ctx.repoLabel) console.log(`   repo: ${ctx.repoLabel}  branch: ${ctx.branch ?? '(default)'}`)
        }
        if (logAbs) console.log(`   log file: ${logAbs}`)
        await ingestBitbucketSyncJob(supabase, syncJobId, {
          onProgress: (m) => console.log(`   … ${m}`),
          shouldAbort: () => shutdownRequested || userCancelRequested,
        })
        const sec = ((Date.now() - t0) / 1000).toFixed(1)
        console.log(`── Sync job finished OK in ${sec}s · ${syncJobId} ──`)
      }

      try {
        if (logAbs) await withConsoleTee(logAbs, runSyncBody)
        else await runSyncBody()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (userCancelRequested && !shutdownRequested) {
          console.warn(`── Sync job CANCELLED · ${syncJobId} ──`)
          const { data: row } = await supabase.from('pk_sync_jobs').select('meta').eq('id', syncJobId).maybeSingle()
          const prevMeta = (row?.meta ?? {}) as Record<string, unknown>
          const { cancel_requested: _drop, ...rest } = prevMeta
          await supabase
            .from('pk_sync_jobs')
            .update({
              status: 'cancelled',
              completed_at: new Date().toISOString(),
              error_message: 'Cancelled at your request.',
              meta: { ...rest },
            })
            .eq('id', syncJobId)
            .eq('status', 'running')
        } else {
          console.error(`── Sync job FAILED · ${syncJobId} ──\n   ${msg}`)
          await supabase
            .from('pk_sync_jobs')
            .update({
              status: 'failed',
              completed_at: new Date().toISOString(),
              error_message: msg.slice(0, 2000),
            })
            .eq('id', syncJobId)
            .eq('status', 'running')
        }
      } finally {
        clearInterval(cancelPoll)
      }
      if (once) break
      continue
    }

    const docJobId = await claimNextDocJob(supabase)
    if (docJobId) {
      let ctx = null as Awaited<ReturnType<typeof loadDocJobLogContext>> | null
      try {
        ctx = await loadDocJobLogContext(supabase, docJobId)
      } catch (e) {
        console.warn('[worker] Could not load doc job context for file log:', e instanceof Error ? e.message : e)
      }
      const logAbs = ctx && logRoot ? buildJobLogAbsolutePath(logRoot, ctx) : null

      let docUserCancelRequested = false
      let docUserPauseRequested = false
      const refreshDocCancelFromDb = async () => {
        const { data } = await supabase.from('pk_doc_generation_jobs').select('status, meta').eq('id', docJobId).maybeSingle()
        if (data && String((data as { status?: string }).status) !== 'running') {
          docUserCancelRequested = true
          return
        }
        if (isJobCancelRequested(data?.meta)) {
          docUserCancelRequested = true
        }
        if (isJobPauseRequested(data?.meta)) {
          docUserPauseRequested = true
        }
      }
      await refreshDocCancelFromDb().catch(() => {})
      const docCancelPoll = setInterval(() => {
        void refreshDocCancelFromDb().catch(() => {})
      }, 500)

      const runDocBody = async () => {
        const t0 = Date.now()
        console.log(`── Documentation job start · ${docJobId} · ${new Date().toISOString()} ──`)
        if (ctx) {
          console.log(
            `   workspace: ${ctx.workspaceName} (${ctx.workspaceId})  plan: ${ctx.billingPlan}  user: ${ctx.userLabel}`
          )
          if (ctx.repoLabel) console.log(`   scope repo: ${ctx.repoLabel}`)
        }
        if (logAbs) console.log(`   log file: ${logAbs}`)
        await processDocGenerationJob(supabase, docJobId, {
          onProgress: (m) => console.log(`   … ${m}`),
          shouldAbort: () => shutdownRequested || docUserCancelRequested,
          shouldPause: () => docUserPauseRequested,
        })
        const sec = ((Date.now() - t0) / 1000).toFixed(1)
        console.log(`── Documentation job finished OK in ${sec}s · ${docJobId} ──`)
      }

      try {
        if (logAbs) await withConsoleTee(logAbs, runDocBody)
        else await runDocBody()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const isPause = e instanceof JobPauseRequestedError
        const isAbort = e instanceof JobAbortRequestedError
        if (isPause && !shutdownRequested) {
          console.warn(`── Documentation job PAUSED · ${docJobId} ──`)
          const { data: row } = await supabase.from('pk_doc_generation_jobs').select('meta').eq('id', docJobId).maybeSingle()
          const prevMeta = (row?.meta ?? {}) as Record<string, unknown>
          const { pause_requested: _pr, ...metaNoPause } = prevMeta
          const isUseCaseLibrary = String(prevMeta.doc_job_profile ?? '').trim() === 'use_case_library'
          const pauseMsg = isUseCaseLibrary
            ? 'Paused mid run. Set status back to queued and clear pause_requested in job meta to resume from the start of a use-case library job (partial guides may already be saved).'
            : 'Paused. To continue operational articles only: set status to queued and set meta.doc_ops_resume=true (keep doc_ops_checkpoint). For a full regeneration, clear doc_ops_checkpoint and doc_ops_resume first.'
          await supabase
            .from('pk_doc_generation_jobs')
            .update({
              status: 'paused',
              completed_at: new Date().toISOString(),
              error_message: pauseMsg,
              meta: { ...metaNoPause },
            })
            .eq('id', docJobId)
            .eq('status', 'running')
        } else if (isAbort && shutdownRequested) {
          console.error(`── Documentation job FAILED · ${docJobId} ──\n   ${msg}`)
          await supabase
            .from('pk_doc_generation_jobs')
            .update({
              status: 'failed',
              completed_at: new Date().toISOString(),
              error_message: 'Worker stopped before this job finished.',
            })
            .eq('id', docJobId)
            .eq('status', 'running')
        } else if (isAbort || (docUserCancelRequested && !shutdownRequested)) {
          console.warn(`── Documentation job CANCELLED · ${docJobId} ──`)
          const { data: row } = await supabase.from('pk_doc_generation_jobs').select('meta').eq('id', docJobId).maybeSingle()
          const prevMeta = (row?.meta ?? {}) as Record<string, unknown>
          const { cancel_requested: _dc, ...restDoc } = prevMeta
          await supabase
            .from('pk_doc_generation_jobs')
            .update({
              status: 'cancelled',
              completed_at: new Date().toISOString(),
              error_message: 'Cancelled at your request.',
              meta: { ...restDoc },
            })
            .eq('id', docJobId)
            .eq('status', 'running')
        } else {
          console.error(`── Documentation job FAILED · ${docJobId} ──\n   ${msg}`)
          await supabase
            .from('pk_doc_generation_jobs')
            .update({
              status: 'failed',
              completed_at: new Date().toISOString(),
              error_message: msg.slice(0, 2000),
            })
            .eq('id', docJobId)
            .eq('status', 'running')
        }
      } finally {
        clearInterval(docCancelPoll)
      }
      if (once) break
      continue
    }

    if (once) {
      console.log(`[worker] No queued sync or documentation jobs · ${new Date().toISOString()}`)
      break
    }
    if (shutdownRequested) {
      console.log(`[worker] Idle exit · ${new Date().toISOString()}`)
      break
    }
    await sleep(4000)
  }

  console.log(`[worker] Stopped · ${new Date().toISOString()}`)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
