import type { ResolvedOrgAiSettings } from '@/server/plans/org-ai-settings'

/**
 * Ingestion limits (env-tunable). Defaults favor indexing the whole repo, bounded by a hard per-file cap to avoid OOM.
 *
 * PK_INGEST_MAX_FILES: max text files per sync (omit or 0 = no cap).
 * PK_INGEST_MAX_FILE_BYTES: max bytes read per file (default 8 MiB). Files larger than this are truncated with a marker.
 * PK_INGEST_FILE_BATCH_SIZE: files to fetch/chunk before each embed + vector upsert batch (memory control).
 * PK_INGEST_REQUEST_DELAY_MS: delay after each Bitbucket file fetch (0 = none; use ~25–50 if you hit rate limits).
 */

const MIB = 1024 * 1024
const DEFAULT_MAX_FILE_BYTES = 8 * MIB
/** Hard ceiling even if env asks for more (protects Node heap on a single string). */
const HARD_MAX_FILE_BYTES = 50 * MIB

export type IngestConfig = {
  maxFiles: number
  maxFileBytes: number
  fileBatchSize: number
  requestDelayMs: number
}

export function loadIngestConfig(): IngestConfig {
  const mf = parseInt(process.env.PK_INGEST_MAX_FILES ?? '0', 10)
  const mfb = parseInt(process.env.PK_INGEST_MAX_FILE_BYTES ?? String(DEFAULT_MAX_FILE_BYTES), 10)
  const batch = parseInt(process.env.PK_INGEST_FILE_BATCH_SIZE ?? '25', 10)
  const delay = parseInt(process.env.PK_INGEST_REQUEST_DELAY_MS ?? '0', 10)

  const maxFileBytes =
    mfb > 0 ? Math.min(mfb, HARD_MAX_FILE_BYTES) : Math.min(DEFAULT_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES)

  return {
    maxFiles: Number.isFinite(mf) && mf > 0 ? mf : Number.MAX_SAFE_INTEGER,
    maxFileBytes,
    fileBatchSize: Math.max(5, Number.isFinite(batch) ? batch : 25),
    requestDelayMs: Math.max(0, Number.isFinite(delay) ? delay : 0),
  }
}

/** Dependency / build output path segments to skip (still indexes all real source). */
const SKIP_PATH_SEGMENTS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.next',
  'out',
  'target',
  'venv',
  '.venv',
  'Pods',
  'DerivedData',
  'bower_components',
  '.turbo',
  '.parcel-cache',
])

export function shouldSkipIndexedPath(repoRelativePath: string): boolean {
  const norm = repoRelativePath.replace(/^\/+/, '')
  const segments = norm.split('/').filter(Boolean)
  return segments.some((s) => SKIP_PATH_SEGMENTS.has(s))
}

/** Org-level ingest knobs (plan defaults + org_ai_settings), clamped to deployment hard max file bytes. */
export function resolveIngestConfig(resolvedOrg: ResolvedOrgAiSettings): IngestConfig {
  const env = loadIngestConfig()
  const maxFileBytes = Math.min(resolvedOrg.ingest_max_file_bytes, HARD_MAX_FILE_BYTES)
  return {
    maxFiles: Math.min(env.maxFiles, resolvedOrg.ingest_max_files),
    maxFileBytes: Math.min(env.maxFileBytes, maxFileBytes),
    fileBatchSize: resolvedOrg.ingest_file_batch_size,
    requestDelayMs: Math.max(env.requestDelayMs, resolvedOrg.ingest_request_delay_ms),
  }
}
