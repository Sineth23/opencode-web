import { createHash } from 'crypto'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BitbucketCloudClient, BitbucketRequestAbortedError } from '@/server/integrations/bitbucket/client'
import { resolveBitbucketApiCredentials } from '@/server/integrations/bitbucket/auth-resolve'
import type { KnowledgeChunk } from '@/server/knowledge/deeplake-store'
import { createPostgresKnowledgeStore } from '@/server/knowledge/postgres-vector-store'
import { embedTexts } from '@/server/llm/openai-embeddings'
import {
  isLikelyBinaryText,
  isLikelyMinifiedText,
  sortPathsForIngest,
} from '@/server/pipelines/content-classification'
import { buildGitSourceReader, loadGitCloneIngestEnv, shallowCloneBitbucketRepo } from '@/server/pipelines/bitbucket-git-clone'
import { isAllowedLocalWorkingCopyPath } from '@/server/pipelines/local-working-copy'
import { fetchMirrorState, updateMirrorLastEmbedJob, upsertMirrorState } from '@/server/pipelines/repo-mirror-db'
import { ensurePersistentMirrorClone } from '@/server/pipelines/persistent-git-mirror'
import { resolveIngestConfig, shouldSkipIndexedPath } from '@/server/pipelines/ingest-config'
import { parseBillingPlanForAi, resolveOrgAiSettings } from '@/server/plans/org-ai-settings'
import { rebuildRepoStructureGraph } from '@/server/pipelines/structure-ingest'
import { codewikiSourceFileLimit } from '@/server/codewiki/codewiki-process'
import { runCodewikiAfterBitbucketSync } from '@/server/codewiki/run-after-sync'
import {
  appendSnapshotCheckpointLine,
  initSnapshotCheckpointDir,
  loadSnapshotCheckpointMap,
  pathsHashForCheckpoint,
  snapshotCheckpointDir,
  snapshotCheckpointEnabled,
  snapshotProgressEvery,
  type SnapshotCheckpointMeta,
} from '@/server/codewiki/snapshot-checkpoint'

const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|md|mdx|py|go|java|json|yaml|yml|sql|css|scss|less|html|htm|txt|rs|kt|kts|vue|svelte|rb|php|cs|fs|fsx|scala|groovy|xml|toml|ini|sh|bash|zsh|ps1|gradle|swift|dart|lua|pl|pm|h|hpp|c|cc|cpp|cxx|hxx|proto|graphql|gql|tf|tfvars|hcl)$/i

const CHUNK_SIZE = 1000
const CHUNK_OVERLAP = 120

function isTextSourcePath(full: string): boolean {
  const base = full.split('/').pop() ?? ''
  if (
    /^(Dockerfile|dockerfile|Makefile|GNUmakefile|Rakefile|Gemfile|Vagrantfile|Jenkinsfile|Containerfile)$/i.test(base)
  ) {
    return true
  }
  return TEXT_EXT.test(full)
}

export function chunkText(text: string, maxChars = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const t = text.replace(/\r\n/g, '\n')
  if (!t.trim()) return []
  const chunks: string[] = []
  let i = 0
  while (i < t.length) {
    const end = Math.min(i + maxChars, t.length)
    chunks.push(t.slice(i, end))
    if (end >= t.length) break
    i = Math.max(end - overlap, i + 1)
  }
  return chunks
}

function normalizeChildPath(dirPrefix: string, name: string): string {
  if (!dirPrefix) return name.replace(/^\//, '')
  if (name.startsWith(dirPrefix + '/') || name === dirPrefix) return name.replace(/^\//, '')
  const n = name.replace(/^\//, '')
  return `${dirPrefix.replace(/\/$/, '')}/${n}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function sleepInterruptible(ms: number, shouldAbort?: () => boolean): Promise<void> {
  if (ms <= 0) return
  if (!shouldAbort) {
    await sleep(ms)
    return
  }
  const step = 250
  let left = ms
  while (left > 0) {
    if (shouldAbort()) throw new BitbucketRequestAbortedError()
    const chunk = Math.min(step, left)
    await sleep(chunk)
    left -= chunk
  }
}

async function refillSnapshotsForCodewiki(
  bb: BitbucketCloudClient | null,
  bbWs: string,
  repoSlug: string,
  branch: string,
  paths: string[],
  cfg: { maxFileBytes: number; requestDelayMs: number },
  orgAi: { skip_minified: boolean },
  out: { path: string; content: string }[],
  gitReadUtf8: ((path: string) => Promise<string>) | null,
  shouldAbort?: () => boolean
): Promise<void> {
  if (out.length > 0) return
  const cap = Math.min(paths.length, Number(process.env.CODEWIKI_MAX_SOURCE_FILES) || 400)
  for (const path of paths.slice(0, cap)) {
    const delayMs = gitReadUtf8 ? 0 : cfg.requestDelayMs
    if (delayMs > 0) await sleepInterruptible(delayMs, shouldAbort)
    let raw: string
    try {
      if (gitReadUtf8) {
        raw = await gitReadUtf8(path)
      } else if (bb) {
        raw = await bb.getSrcRawFile(bbWs, repoSlug, branch, path)
      } else {
        continue
      }
    } catch (e) {
      if (e instanceof BitbucketRequestAbortedError) throw e
      continue
    }
    if (isLikelyBinaryText(raw)) continue
    if (orgAi.skip_minified && isLikelyMinifiedText(raw)) continue
    let blob = raw
    if (blob.length > cfg.maxFileBytes) {
      blob =
        blob.slice(0, cfg.maxFileBytes) +
        `\n\n[AutoDoc: truncated at ${cfg.maxFileBytes} bytes for indexing. Increase org ingest_max_file_bytes if needed.]`
    }
    out.push({ path, content: blob })
  }
}

async function collectSourcePaths(
  client: BitbucketCloudClient,
  workspace: string,
  repoSlug: string,
  revision: string,
  maxFiles: number,
  requestDelayMs: number,
  shouldAbort?: () => boolean
): Promise<string[]> {
  const out: string[] = []
  const queue: string[] = ['']
  const seenDirs = new Set<string>()

  while (queue.length > 0 && out.length < maxFiles) {
    const dir = queue.shift()!
    if (requestDelayMs > 0) await sleepInterruptible(requestDelayMs, shouldAbort)
    const { files, directories } = await client.listSrcDirectory(workspace, repoSlug, revision, dir)
    for (const f of files) {
      const full = normalizeChildPath(dir, f)
      if (shouldSkipIndexedPath(full)) continue
      if (!isTextSourcePath(full)) continue
      out.push(full)
      if (out.length >= maxFiles) break
    }
    if (out.length >= maxFiles) break
    for (const d of directories) {
      const fullD = normalizeChildPath(dir, d)
      if (shouldSkipIndexedPath(fullD)) continue
      if (seenDirs.has(fullD)) continue
      seenDirs.add(fullD)
      queue.push(fullD)
    }
  }
  return out
}

async function collectDistinctIndexedPaths(
  supabase: SupabaseClient,
  workspaceId: string,
  repositoryId: string,
  syncBranch: string
): Promise<Set<string>> {
  const paths = new Set<string>()
  let from = 0
  const page = 2000
  for (;;) {
    const { data, error } = await supabase
      .from('pk_knowledge_chunks')
      .select('source_path')
      .eq('workspace_id', workspaceId)
      .eq('repository_id', repositoryId)
      .eq('sync_branch', syncBranch)
      .range(from, from + page - 1)
    if (error) {
      throw new Error(`list indexed paths: ${error.message}`)
    }
    if (!data?.length) break
    for (const r of data) {
      paths.add(r.source_path as string)
    }
    if (data.length < page) break
    from += page
  }
  return paths
}

async function deleteChunksForSourcePath(
  supabase: SupabaseClient,
  workspaceId: string,
  repositoryId: string,
  syncBranch: string,
  sourcePath: string
): Promise<void> {
  /** One DELETE for a path can be tens of thousands of rows (e.g. huge JS) and hit statement_timeout. */
  const batch = 400
  for (;;) {
    const { data: rows, error: selErr } = await supabase
      .from('pk_knowledge_chunks')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('repository_id', repositoryId)
      .eq('sync_branch', syncBranch)
      .eq('source_path', sourcePath)
      .limit(batch)
    if (selErr) {
      throw new Error(`delete chunks for ${sourcePath}: ${selErr.message}`)
    }
    if (!rows?.length) return
    const ids = rows.map((r) => r.id as string)
    const { error: delErr } = await supabase.from('pk_knowledge_chunks').delete().in('id', ids)
    if (delErr) {
      throw new Error(`delete chunks for ${sourcePath}: ${delErr.message}`)
    }
    if (rows.length < batch) return
    await sleep(25)
  }
}

function chunkId(
  workspaceId: string,
  repositoryId: string,
  branch: string,
  sourcePath: string,
  index: number
): string {
  const h = createHash('sha256')
    .update(`${workspaceId}|${repositoryId}|${branch}|${sourcePath}|${index}`)
    .digest('hex')
    .slice(0, 48)
  return `ch_${h}`
}

export type BitbucketIngestJobOptions = {
  /** Worker / CLI progress lines (not used from API routes). */
  onProgress?: (message: string) => void
  /** When true, Bitbucket calls and delay sleeps stop quickly (worker Ctrl+C). */
  shouldAbort?: () => boolean
}

function normalizePipeline(meta: Record<string, unknown>): 'full' | 'clone_only' | 'embed_only' | 'codewiki_only' {
  const p = meta.pipeline
  if (p === 'clone_only' || p === 'embed_only' || p === 'codewiki_only' || p === 'full') return p
  return 'full'
}

/**
 * Full ingestion for one pk_sync_jobs row (Bitbucket). Requires service-role Supabase client.
 */
export async function ingestBitbucketSyncJob(
  supabase: SupabaseClient,
  jobId: string,
  options?: BitbucketIngestJobOptions
): Promise<void> {
  const prog = options?.onProgress
  const shouldAbort = options?.shouldAbort
  const { data: job, error: jobErr } = await supabase.from('pk_sync_jobs').select('*').eq('id', jobId).single()
  if (jobErr || !job) {
    throw new Error(`Job ${jobId} not found: ${jobErr?.message}`)
  }

  const workspaceId = job.workspace_id as string
  const branch = (job.branch as string) || 'main'
  const meta = (job.meta ?? {}) as Record<string, unknown>
  const bbWs = String(meta.bitbucket_workspace ?? '').trim()
  const repoSlug = String(meta.repo_slug ?? '').trim()
  const fullReindex = meta.full_reindex === true

  if (!bbWs || !repoSlug) {
    throw new Error('Job meta missing bitbucket_workspace or repo_slug')
  }

  prog?.(`Bitbucket ${bbWs}/${repoSlug} · branch ${branch}${fullReindex ? ' · full reindex' : ''}`)

  const { data: wsRow, error: wsErr } = await supabase
    .from('pk_workspaces')
    .select('billing_plan, org_ai_settings')
    .eq('id', workspaceId)
    .single()
  if (wsErr || !wsRow) {
    throw new Error(`Workspace ${workspaceId} not found: ${wsErr?.message}`)
  }

  const orgAi = resolveOrgAiSettings(parseBillingPlanForAi(wsRow.billing_plan as string), wsRow.org_ai_settings)
  const cfg = resolveIngestConfig(orgAi)

  const bbCreds = await resolveBitbucketApiCredentials(supabase, workspaceId)

  const pipeline = normalizePipeline(meta)

  let repositoryId = job.repository_id as string | null
  if (!repositoryId) {
    const { data: existing } = await supabase
      .from('pk_linked_repositories')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('bitbucket_workspace', bbWs)
      .eq('slug', repoSlug)
      .maybeSingle()
    if (existing?.id) {
      repositoryId = existing.id as string
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from('pk_linked_repositories')
        .insert({
          workspace_id: workspaceId,
          bitbucket_workspace: bbWs,
          name: repoSlug,
          slug: repoSlug,
          default_branch: branch,
        })
        .select('id')
        .single()
      if (insErr || !inserted) {
        throw new Error(`Could not create linked repository: ${insErr?.message}`)
      }
      repositoryId = inserted.id as string
    }
  }

  const gitEnv = loadGitCloneIngestEnv()

  /** Bitbucket → disk only; embeddings run in a separate embed-only job. */
  if (pipeline === 'clone_only') {
    if (!gitEnv.token) {
      throw new Error(
        'Clone-only jobs require PK_INGEST_USE_GIT_CLONE=true and PK_BITBUCKET_GIT_ACCESS_TOKEN (HTTPS token for git).'
      )
    }
    prog?.('Prepare clone: fetching from Bitbucket into persistent mirror (no embeddings in this job).')
    const { path: mirrorPath, commitSha } = await ensurePersistentMirrorClone({
      workspaceId,
      repositoryId: repositoryId!,
      branch,
      bbWorkspace: bbWs,
      repoSlug,
      token: gitEnv.token,
      gitUsername: gitEnv.gitUsername,
      shouldAbort,
    })
    await upsertMirrorState(supabase, {
      workspaceId,
      repositoryId: repositoryId!,
      syncBranch: branch,
      filesystemPath: mirrorPath,
      headCommitSha: commitSha,
      environment: typeof meta.mirror_environment === 'string' ? meta.mirror_environment : 'local',
      lastCloneJobId: jobId,
    })
    await supabase
      .from('pk_sync_jobs')
      .update({
        status: 'succeeded',
        completed_at: new Date().toISOString(),
        error_message: null,
        meta: {
          ...meta,
          pipeline: 'clone_only',
          mirror_path: mirrorPath,
          head_commit_sha: commitSha,
          incremental_hint:
            'Next: run “Index & embed” for this branch. Embeddings skip unchanged files automatically unless you choose full rebuild.',
        },
      })
      .eq('id', jobId)
      .eq('status', 'running')
    prog?.(`Prepare clone done · ${mirrorPath} @ ${commitSha.slice(0, 7)}`)
    return
  }

  const skipVectorIngest = pipeline === 'codewiki_only'
  const store = skipVectorIngest ? null : createPostgresKnowledgeStore(supabase, 'readwrite')

  let dbPathsBefore: Set<string> | null = null
  if (!skipVectorIngest) {
    if (fullReindex) {
      await store!.deleteByRepositoryBranch(workspaceId, repositoryId!, branch)
    } else {
      dbPathsBefore = await collectDistinctIndexedPaths(supabase, workspaceId, repositoryId!, branch)
    }
  }

  const bb = new BitbucketCloudClient({
    accessToken: bbCreds.accessToken,
    basicAuthUsername: bbCreds.basicAuthUsername,
    shouldAbort,
  })

  let localRepoRoot: string | null = null
  let cleanupClone: (() => Promise<void>) | null = null
  let gitReadUtf8: ((path: string) => Promise<string>) | null = null
  let ingestSourceMeta:
    | 'local_working_copy'
    | 'git_temp_no_checkout'
    | 'bitbucket_rest_api'
    | 'persistent_mirror' = 'bitbucket_rest_api'

  try {
  let rawPaths: string[]
  const metaLocalPath =
    typeof meta.local_working_copy_abs_path === 'string' ? meta.local_working_copy_abs_path.trim() : ''
  const usePersistedLocal =
    metaLocalPath.length > 0 && isAllowedLocalWorkingCopyPath(metaLocalPath)

  if (metaLocalPath && !usePersistedLocal && process.env.PK_ALLOW_LOCAL_WORKING_COPY === '1') {
    prog?.(
      'Job requested local_working_copy_abs_path but path is missing or not under PK_LOCAL_WORKING_COPY_ALLOW_PREFIXES: using clone/API instead'
    )
  }

  if (pipeline === 'embed_only' || pipeline === 'codewiki_only') {
    const state = await fetchMirrorState(supabase, workspaceId, repositoryId!, branch)
    if (!state?.filesystem_path) {
      throw new Error(
        'No prepared mirror for this repository and branch. Run “Prepare clone” first (or use full sync). Nothing was indexed.'
      )
    }
    const p = state.filesystem_path
    if (!existsSync(p) || !statSync(p).isDirectory()) {
      throw new Error(
        `Mirror path missing on this machine: ${p}. Run “Prepare clone” again or check PK_REPO_MIRROR_ROOT.`
      )
    }
    ingestSourceMeta = 'persistent_mirror'
    prog?.(
      pipeline === 'codewiki_only'
        ? `CodeWiki only: reading from saved mirror (no embeddings): ${p}`
        : `Index & embed: reading from saved mirror (incremental: unchanged files skip re-embedding unless full rebuild is on): ${p}`
    )
    localRepoRoot = p
    cleanupClone = null
    const reader = await buildGitSourceReader(p, cfg.maxFiles)
    rawPaths = reader.paths
    gitReadUtf8 = reader.readUtf8
  } else if (usePersistedLocal) {
    ingestSourceMeta = 'local_working_copy'
    prog?.(
      `Using persisted local git tree (no temp clone): ${metaLocalPath} · environment=${String(meta.mirror_environment ?? 'local')}`
    )
    localRepoRoot = metaLocalPath
    cleanupClone = null
    const reader = await buildGitSourceReader(metaLocalPath, cfg.maxFiles)
    rawPaths = reader.paths
    gitReadUtf8 = reader.readUtf8
  } else if (gitEnv.useGitClone && gitEnv.token) {
    ingestSourceMeta = 'git_temp_no_checkout'
    prog?.(
      'Git shallow clone (--no-checkout) + tree read: avoids REST 429s and Windows illegal filenames during checkout'
    )
    const cl = await shallowCloneBitbucketRepo({
      bbWorkspace: bbWs,
      repoSlug,
      branch,
      token: gitEnv.token,
      gitUsername: gitEnv.gitUsername,
      shouldAbort,
    })
    localRepoRoot = cl.dir
    cleanupClone = cl.cleanup
    const reader = await buildGitSourceReader(cl.dir, cfg.maxFiles)
    rawPaths = reader.paths
    gitReadUtf8 = reader.readUtf8
  } else {
    if ((process.env.PK_INGEST_USE_GIT_CLONE ?? '').trim() && !gitEnv.token) {
      prog?.('PK_INGEST_USE_GIT_CLONE is set but PK_BITBUCKET_GIT_ACCESS_TOKEN is empty: using Bitbucket API')
    }
    rawPaths = await collectSourcePaths(
      bb,
      bbWs,
      repoSlug,
      branch,
      cfg.maxFiles,
      cfg.requestDelayMs,
      shouldAbort
    )
  }
  const paths = sortPathsForIngest(rawPaths)
  prog?.(
    `Collected ${paths.length} text paths (max ${cfg.maxFiles === Number.MAX_SAFE_INTEGER ? 'unlimited' : cfg.maxFiles} files)`
  )

  if (pipeline === 'codewiki_only') {
    const mirrorSnap = await fetchMirrorState(supabase, workspaceId, repositoryId!, branch)
    const cwCap = codewikiSourceFileLimit()
    const workPaths = paths.slice(0, cwCap)
    const pathsHash = pathsHashForCheckpoint(workPaths)
    const headSha = (mirrorSnap?.head_commit_sha ?? '').trim()
    const ckMeta: SnapshotCheckpointMeta = {
      v: 1,
      workspace_id: workspaceId,
      repository_id: repositoryId!,
      sync_branch: branch,
      head_sha: headSha,
      cw_cap: cwCap,
      paths_hash: pathsHash,
    }
    const ckDir = snapshotCheckpointDir({
      workspaceId,
      repositoryId: repositoryId!,
      syncBranch: branch,
      headSha: mirrorSnap?.head_commit_sha ?? null,
      cwCap,
      pathsHash,
    })

    let cached = new Map<string, string>()
    if (snapshotCheckpointEnabled()) {
      const loaded = loadSnapshotCheckpointMap(ckDir, ckMeta)
      if (loaded && loaded.size > 0) {
        cached = loaded
        prog?.(
          `CodeWiki snapshot: resumed ${loaded.size} file(s) from checkpoint (same branch & mirror commit). Re-reading missing paths only.`
        )
      }
    }

    const every = snapshotProgressEvery()
    prog?.(
      `CodeWiki only: loading up to ${cwCap} text files for the overview step (${workPaths.length} paths to scan).`
    )
    const snapshotOnly: { path: string; content: string }[] = []
    const delayCw = gitReadUtf8 ? 0 : cfg.requestDelayMs
    let reused = 0
    let freshlyRead = 0
    let ix = 0
    for (const path of workPaths) {
      ix++
      const fromDisk = cached.get(path)
      if (fromDisk !== undefined) {
        snapshotOnly.push({ path, content: fromDisk })
        reused++
        if (ix % every === 0 || ix === workPaths.length) {
          prog?.(
            `CodeWiki snapshot · path ${ix}/${workPaths.length} · ${reused} from checkpoint · ${freshlyRead} newly read · ${snapshotOnly.length} rows in snapshot`
          )
        }
        continue
      }

      if (shouldAbort?.()) {
        throw new BitbucketRequestAbortedError()
      }
      if (delayCw > 0) await sleepInterruptible(delayCw, shouldAbort)
      let raw: string
      try {
        if (gitReadUtf8) {
          raw = await gitReadUtf8(path)
        } else {
          raw = await bb.getSrcRawFile(bbWs, repoSlug, branch, path)
        }
      } catch (e) {
        if (e instanceof BitbucketRequestAbortedError) throw e
        continue
      }
      if (isLikelyBinaryText(raw)) continue
      if (orgAi.skip_minified && isLikelyMinifiedText(raw)) continue
      let blob = raw
      if (blob.length > cfg.maxFileBytes) {
        blob =
          blob.slice(0, cfg.maxFileBytes) +
          `\n\n[AutoDoc: truncated at ${cfg.maxFileBytes} bytes for indexing. Increase org ingest_max_file_bytes if needed.]`
      }
      snapshotOnly.push({ path, content: blob })
      freshlyRead++
      if (snapshotCheckpointEnabled()) {
        if (!existsSync(join(ckDir, 'meta.json'))) {
          initSnapshotCheckpointDir(ckDir, ckMeta)
        }
        appendSnapshotCheckpointLine(ckDir, { path, content: blob })
      }
      if (ix % every === 0 || ix === workPaths.length) {
        prog?.(
          `CodeWiki snapshot · path ${ix}/${workPaths.length} · ${reused} from checkpoint · ${freshlyRead} newly read · ${snapshotOnly.length} rows in snapshot`
        )
      }
    }

    const { data: wsNameCw } = await supabase.from('pk_workspaces').select('name').eq('id', workspaceId).maybeSingle()
    prog?.('Structure graph & CodeWiki follow-up…')
    try {
      await rebuildRepoStructureGraph(supabase, {
        workspaceId,
        repositoryId: repositoryId!,
        filePaths: paths,
        workspaceName: (wsNameCw?.name as string) ?? undefined,
      })
    } catch (e) {
      console.error('rebuildRepoStructureGraph', e)
    }
    const ckClear = snapshotCheckpointEnabled() ? ckDir : undefined
    await runCodewikiAfterBitbucketSync(supabase, {
      workspaceId,
      repositoryId: repositoryId!,
      syncBranch: branch,
      sourceSyncJobId: jobId,
      repoSlug,
      snapshotFiles: snapshotOnly,
      onProgress: prog,
      snapshotCheckpointDirToClear: ckClear,
    })

    await supabase
      .from('pk_sync_jobs')
      .update({
        status: 'succeeded',
        completed_at: new Date().toISOString(),
        error_message: null,
        meta: {
          ...meta,
          pipeline: 'codewiki_only',
          codewiki_snapshot_files: snapshotOnly.length,
          ingest_source: ingestSourceMeta,
        },
      })
      .eq('id', jobId)
      .eq('status', 'running')
    prog?.(`CodeWiki-only job finished · ${snapshotOnly.length} files in overview snapshot.`)
    return
  }

  const treeSet = new Set(paths)
  const snapshotFiles: { path: string; content: string }[] = []

  let totalChunks = 0
  const interFileDelayMs = gitReadUtf8 ? 0 : cfg.requestDelayMs

  for (let start = 0; start < paths.length; start += cfg.fileBatchSize) {
    if (shouldAbort?.()) {
      throw new BitbucketRequestAbortedError()
    }
    const pathSlice = paths.slice(start, start + cfg.fileBatchSize)
    const batchChunks: KnowledgeChunk[] = []

    for (const path of pathSlice) {
      if (interFileDelayMs > 0) await sleepInterruptible(interFileDelayMs, shouldAbort)
      let raw: string
      try {
        if (gitReadUtf8) {
          raw = await gitReadUtf8(path)
        } else {
          raw = await bb.getSrcRawFile(bbWs, repoSlug, branch, path)
        }
      } catch (e) {
        if (e instanceof BitbucketRequestAbortedError) throw e
        continue
      }
      if (isLikelyBinaryText(raw)) {
        continue
      }
      if (orgAi.skip_minified && isLikelyMinifiedText(raw)) {
        continue
      }

      let blob = raw
      if (blob.length > cfg.maxFileBytes) {
        blob =
          blob.slice(0, cfg.maxFileBytes) +
          `\n\n[AutoDoc: truncated at ${cfg.maxFileBytes} bytes for indexing. Increase org ingest_max_file_bytes if needed.]`
      }

      snapshotFiles.push({ path, content: blob })

      const contentSha = createHash('sha256').update(blob, 'utf8').digest('hex')
      const parts = chunkText(blob)

      const { data: existingRows } = await supabase
        .from('pk_knowledge_chunks')
        .select('metadata')
        .eq('workspace_id', workspaceId)
        .eq('repository_id', repositoryId)
        .eq('sync_branch', branch)
        .eq('source_path', path)

      const ex = existingRows ?? []
      if (ex.length === parts.length && parts.length > 0) {
        const allMatch = ex.every(
          (row) => String((row.metadata as Record<string, unknown> | null)?.content_sha256 ?? '') === contentSha
        )
        if (allMatch) {
          continue
        }
      }
      if (ex.length > 0) {
        await deleteChunksForSourcePath(supabase, workspaceId, repositoryId!, branch, path)
      }

      parts.forEach((text, i) => {
        batchChunks.push({
          id: chunkId(workspaceId, repositoryId!, branch, path, i),
          workspaceId,
          repositoryId: repositoryId!,
          sourcePath: path,
          text,
          metadata: {
            branch,
            bitbucket_workspace: bbWs,
            repo_slug: repoSlug,
            sync_job_id: jobId,
            content_sha256: contentSha,
          },
        })
      })
    }

    if (batchChunks.length === 0) continue

    const doneFiles = Math.min(start + cfg.fileBatchSize, paths.length)
    prog?.(`Embedding batch · files ${doneFiles}/${paths.length} · +${batchChunks.length} chunks this batch`)

    const embeddings = await embedTexts(batchChunks.map((c) => c.text), { model: orgAi.embedding_model })
    for (let i = 0; i < batchChunks.length; i++) {
      batchChunks[i].embedding = embeddings[i]
    }
    await store!.upsertChunks(batchChunks)
    totalChunks += batchChunks.length
    prog?.(`Upserted · ${totalChunks} chunks total`)
  }

  if (!fullReindex && dbPathsBefore) {
    for (const p of dbPathsBefore) {
      if (!treeSet.has(p)) {
        await deleteChunksForSourcePath(supabase, workspaceId, repositoryId!, branch, p)
      }
    }
  }

  const finalizeSyncAndCodewiki = async (workspaceName: string | undefined, filePaths: string[]) => {
    if (pipeline === 'embed_only') {
      await updateMirrorLastEmbedJob(supabase, workspaceId, repositoryId!, branch, jobId)
    }
    prog?.('Structure graph & CodeWiki follow-up…')
    try {
      await rebuildRepoStructureGraph(supabase, {
        workspaceId,
        repositoryId: repositoryId!,
        filePaths,
        workspaceName,
      })
    } catch (e) {
      console.error('rebuildRepoStructureGraph', e)
    }
    await refillSnapshotsForCodewiki(
      bb,
      bbWs,
      repoSlug,
      branch,
      filePaths,
      cfg,
      orgAi,
      snapshotFiles,
      gitReadUtf8,
      shouldAbort
    )
    await runCodewikiAfterBitbucketSync(supabase, {
      workspaceId,
      repositoryId: repositoryId!,
      syncBranch: branch,
      sourceSyncJobId: jobId,
      repoSlug,
      snapshotFiles,
      onProgress: prog,
    })
  }

  if (totalChunks === 0 && paths.length === 0) {
    await supabase
      .from('pk_sync_jobs')
      .update({
        status: 'succeeded',
        completed_at: new Date().toISOString(),
        error_message: 'No text files ingested (empty repo, skipped paths only, or fetch failures)',
      })
      .eq('id', jobId)
      .eq('status', 'running')
    await supabase
      .from('pk_linked_repositories')
      .update({ last_sync_at: new Date().toISOString() })
      .eq('id', repositoryId)
    const { data: wsRowEmpty } = await supabase.from('pk_workspaces').select('name').eq('id', workspaceId).maybeSingle()
    await finalizeSyncAndCodewiki((wsRowEmpty?.name as string) ?? undefined, paths)
    return
  }

  if (totalChunks === 0) {
    await supabase
      .from('pk_sync_jobs')
      .update({
        status: 'succeeded',
        completed_at: new Date().toISOString(),
        error_message:
          'No new chunks written (files unchanged, binary/minified skipped, or embedding failures). Indexed paths may still exist from prior syncs.',
      })
      .eq('id', jobId)
      .eq('status', 'running')
    await supabase
      .from('pk_linked_repositories')
      .update({ last_sync_at: new Date().toISOString() })
      .eq('id', repositoryId)
    const { data: wsRowPartial } = await supabase.from('pk_workspaces').select('name').eq('id', workspaceId).maybeSingle()
    await finalizeSyncAndCodewiki((wsRowPartial?.name as string) ?? undefined, paths)
    return
  }

  await supabase
    .from('pk_linked_repositories')
    .update({ last_sync_at: new Date().toISOString() })
    .eq('id', repositoryId)

  const successMeta: Record<string, unknown> = {
    ...meta,
    ingested_files: paths.length,
    ingested_chunks: totalChunks,
    ingest_max_file_bytes: cfg.maxFileBytes,
    full_reindex: fullReindex,
    incremental: !fullReindex,
    ingest_source: ingestSourceMeta,
  }
  delete successMeta.cancel_requested

  await supabase
    .from('pk_sync_jobs')
    .update({
      status: 'succeeded',
      completed_at: new Date().toISOString(),
      error_message: null,
      meta: successMeta,
    })
    .eq('id', jobId)
    .eq('status', 'running')

  const { data: wsNameRow } = await supabase.from('pk_workspaces').select('name').eq('id', workspaceId).maybeSingle()
  await finalizeSyncAndCodewiki((wsNameRow?.name as string) ?? undefined, paths)
  } finally {
    if (cleanupClone) {
      await cleanupClone().catch(() => {})
    }
  }
}
