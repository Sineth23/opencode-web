import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { format } from 'util'
import type { SupabaseClient } from '@supabase/supabase-js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type WorkerJobKind = 'sync' | 'doc'

export type WorkerJobLogContext = {
  kind: WorkerJobKind
  jobId: string
  workspaceId: string
  workspaceName: string
  billingPlan: string
  userId: string
  userLabel: string
  repoLabel?: string
  branch?: string
}

/** Safe single path segment (Windows + Unix). */
export function sanitizePathSegment(raw: string, maxLen: number): string {
  const s = raw
    .trim()
    .replace(/[\s]+/g, '-')
    .replace(/[^a-zA-Z0-9._@-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
  return s.length > 0 ? s : 'unknown'
}

function utcCompactStamp(d = new Date()): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const h = String(d.getUTCHours()).padStart(2, '0')
  const min = String(d.getUTCMinutes()).padStart(2, '0')
  const sec = String(d.getUTCSeconds()).padStart(2, '0')
  return `${y}${m}${day}T${h}${min}${sec}Z`
}

export function workerLogRootDir(): string | null {
  const v = (process.env.PK_WORKER_LOG_DIR ?? 'logs/worker').trim()
  if (!v || v === '0' || v.toLowerCase() === 'off' || v.toLowerCase() === 'false') {
    return null
  }
  return v
}

export function buildJobLogAbsolutePath(rootRelative: string, ctx: WorkerJobLogContext): string {
  const day = new Date().toISOString().slice(0, 10)
  const client = sanitizePathSegment(ctx.workspaceName, 48)
  const org = sanitizePathSegment(ctx.billingPlan || 'plan', 24)
  const user = sanitizePathSegment(ctx.userLabel.replace(/@/g, '_at_'), 36)
  const jobShort = ctx.jobId.replace(/-/g, '').slice(0, 8)
  const stamp = utcCompactStamp()
  const file = `${stamp}_${ctx.kind}_${client}_${org}_${user}_${jobShort}.log`
  return join(process.cwd(), rootRelative, day, file)
}

async function resolveUserLabel(supabase: SupabaseClient, userId: string): Promise<string> {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId)
    if (!error && data?.user?.email) return data.user.email
  } catch {
    // ignore
  }
  return `id_${userId.replace(/-/g, '').slice(0, 8)}`
}

export async function loadSyncJobLogContext(supabase: SupabaseClient, jobId: string): Promise<WorkerJobLogContext> {
  const { data: job, error: jobErr } = await supabase.from('pk_sync_jobs').select('*').eq('id', jobId).single()
  if (jobErr || !job) {
    throw new Error(`Sync job ${jobId} not found: ${jobErr?.message}`)
  }
  const workspaceId = job.workspace_id as string
  const requestedBy = job.requested_by as string
  const branch = (job.branch as string) || 'main'
  const meta = (job.meta ?? {}) as Record<string, unknown>
  const bbWs = String(meta.bitbucket_workspace ?? '').trim()
  const repoSlug = String(meta.repo_slug ?? '').trim()
  const repoLabel = bbWs && repoSlug ? `${bbWs}/${repoSlug}` : undefined

  const { data: ws } = await supabase
    .from('pk_workspaces')
    .select('name, billing_plan')
    .eq('id', workspaceId)
    .maybeSingle()

  const userLabel = await resolveUserLabel(supabase, requestedBy)

  return {
    kind: 'sync',
    jobId,
    workspaceId,
    workspaceName: (ws?.name as string) || 'workspace',
    billingPlan: (ws?.billing_plan as string) || 'unknown',
    userId: requestedBy,
    userLabel,
    repoLabel,
    branch,
  }
}

export async function loadDocJobLogContext(supabase: SupabaseClient, jobId: string): Promise<WorkerJobLogContext> {
  const { data: job, error: jobErr } = await supabase.from('pk_doc_generation_jobs').select('*').eq('id', jobId).single()
  if (jobErr || !job) {
    throw new Error(`Doc job ${jobId} not found: ${jobErr?.message}`)
  }
  const workspaceId = job.workspace_id as string
  const requestedBy = job.requested_by as string
  const meta = (job.meta ?? {}) as Record<string, unknown>
  const repoId = typeof meta.repository_id === 'string' ? meta.repository_id : ''
  const br = typeof meta.branch === 'string' ? meta.branch.trim() : ''
  let repoLabel: string | undefined
  if (repoId) {
    const { data: link } = await supabase.from('pk_linked_repositories').select('slug').eq('id', repoId).maybeSingle()
    if (link?.slug) {
      repoLabel = br ? `${link.slug}@${br}` : String(link.slug)
    }
  }

  const { data: ws } = await supabase
    .from('pk_workspaces')
    .select('name, billing_plan')
    .eq('id', workspaceId)
    .maybeSingle()

  const userLabel = await resolveUserLabel(supabase, requestedBy)

  return {
    kind: 'doc',
    jobId,
    workspaceId,
    workspaceName: (ws?.name as string) || 'workspace',
    billingPlan: (ws?.billing_plan as string) || 'unknown',
    userId: requestedBy,
    userLabel,
    repoLabel,
    branch: br || undefined,
  }
}

type ConsoleFns = Pick<typeof console, 'log' | 'info' | 'debug' | 'warn' | 'error'>

/**
 * Mirrors stdout/stderr to a log file with ISO timestamps. Restores console when finished.
 */
export async function withConsoleTee(logFileAbsolute: string, run: () => Promise<void>): Promise<void> {
  await mkdir(dirname(logFileAbsolute), { recursive: true })
  const stream = createWriteStream(logFileAbsolute, { flags: 'a' })
  const originals: ConsoleFns = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  }

  const ts = () => new Date().toISOString()

  const writeFile = (line: string) => {
    stream.write(line + '\n')
  }

  const patch = (method: keyof ConsoleFns, streamFn: (s: string) => void) => {
    ;(console as ConsoleFns)[method] = (...args: unknown[]) => {
      const line = `[${ts()}] [${method}] ${format(...args)}`
      streamFn(line)
      originals[method](...args)
    }
  }

  patch('log', writeFile)
  patch('info', writeFile)
  patch('debug', writeFile)
  patch('warn', writeFile)
  patch('error', writeFile)

  const closeStream = () =>
    new Promise<void>((resolve, reject) => {
      stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()))
    })

  try {
    await run()
  } finally {
    ;(console as ConsoleFns).log = originals.log
    ;(console as ConsoleFns).info = originals.info
    ;(console as ConsoleFns).debug = originals.debug
    ;(console as ConsoleFns).warn = originals.warn
    ;(console as ConsoleFns).error = originals.error
    await closeStream().catch(() => sleep(50))
  }
}
