import { createHash } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const META = 'meta.json'
const DATA = 'snapshot.wip.ndjson'

export type SnapshotCheckpointMeta = {
  v: 1
  workspace_id: string
  repository_id: string
  sync_branch: string
  head_sha: string
  cw_cap: number
  paths_hash: string
}

function safeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'branch'
}

/** Stable directory for this mirror revision + snapshot cap + path list. */
export function snapshotCheckpointDir(input: {
  workspaceId: string
  repositoryId: string
  syncBranch: string
  headSha: string | null
  cwCap: number
  pathsHash: string
}): string {
  const head = (input.headSha ?? '').replace(/[^a-f0-9]/gi, '').slice(0, 40) || 'unknown'
  const key = createHash('sha256')
    .update(
      [
        input.workspaceId,
        input.repositoryId,
        safeBranch(input.syncBranch),
        head,
        String(input.cwCap),
        input.pathsHash,
      ].join('|'),
      'utf8'
    )
    .digest('hex')
    .slice(0, 24)
  return join(tmpdir(), 'pk-codewiki-checkpoint', input.workspaceId, input.repositoryId, key)
}

function readMeta(dir: string): SnapshotCheckpointMeta | null {
  const p = join(dir, META)
  if (!existsSync(p)) return null
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as SnapshotCheckpointMeta
    if (j.v !== 1 || typeof j.paths_hash !== 'string') return null
    return j
  } catch {
    return null
  }
}

function metaMatches(a: SnapshotCheckpointMeta, b: SnapshotCheckpointMeta): boolean {
  return (
    a.workspace_id === b.workspace_id &&
    a.repository_id === b.repository_id &&
    a.sync_branch === b.sync_branch &&
    a.head_sha === b.head_sha &&
    a.cw_cap === b.cw_cap &&
    a.paths_hash === b.paths_hash
  )
}

/** Load checkpoint lines into a map path → content. Returns null if dir/meta mismatch or corrupt. */
export function loadSnapshotCheckpointMap(
  dir: string,
  expected: SnapshotCheckpointMeta
): Map<string, string> | null {
  const meta = readMeta(dir)
  if (!meta || !metaMatches(meta, expected)) return null
  const fp = join(dir, DATA)
  if (!existsSync(fp)) return new Map()
  let raw: string
  try {
    raw = readFileSync(fp, 'utf8')
  } catch {
    return null
  }
  const out = new Map<string, string>()
  const lines = raw.split(/\n+/).filter(Boolean)
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as { path?: string; content?: string }
      if (typeof row.path === 'string' && typeof row.content === 'string') out.set(row.path, row.content)
    } catch {
      /* skip bad line */
    }
  }
  return out
}

export function initSnapshotCheckpointDir(dir: string, meta: SnapshotCheckpointMeta): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, META), JSON.stringify(meta), 'utf8')
}

export function appendSnapshotCheckpointLine(dir: string, row: { path: string; content: string }): void {
  appendFileSync(join(dir, DATA), `${JSON.stringify(row)}\n`, 'utf8')
}

export function clearSnapshotCheckpointDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

export function pathsHashForCheckpoint(workPaths: readonly string[]): string {
  return createHash('sha256').update(workPaths.join('\n'), 'utf8').digest('hex')
}

export function snapshotCheckpointEnabled(): boolean {
  const v = (process.env.CODEWIKI_SNAPSHOT_CHECKPOINT ?? '1').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no'
}

export function snapshotProgressEvery(): number {
  const n = Number(process.env.CODEWIKI_PROGRESS_EVERY)
  if (Number.isFinite(n) && n >= 1) return Math.min(5000, Math.floor(n))
  return 150
}
