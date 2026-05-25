import { readdir } from 'fs/promises'
import { unlink } from 'fs/promises'
import { join } from 'path'
import { workerLogRootDir } from '@/worker/job-logging'

/** First 8 hex chars of UUID without dashes: matches worker log filename suffix. */
export function syncJobLogFileSuffix(jobId: string): string {
  return jobId.replace(/-/g, '').slice(0, 8).toLowerCase()
}

/**
 * Deletes worker disk log files whose names end with `_${suffix}.log` under PK_WORKER_LOG_DIR.
 * Only runs on the host that serves this API (same machine as worker in typical dev).
 */
export async function deleteWorkerLogFilesForSyncJob(jobId: string): Promise<{ deleted: string[]; note?: string }> {
  const rootRel = workerLogRootDir()
  if (!rootRel) {
    return { deleted: [], note: 'Job file logging is not enabled on this server (no log directory configured).' }
  }
  const suffix = syncJobLogFileSuffix(jobId)
  const rootAbs = join(process.cwd(), rootRel)
  const deleted: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (e.isFile() && e.name.toLowerCase().endsWith(`_${suffix}.log`)) {
        try {
          await unlink(p)
          deleted.push(p)
        } catch {
          // file locked or race: skip
        }
      }
    }
  }

  try {
    await walk(rootAbs)
  } catch {
    return { deleted: [], note: 'Could not read the job log directory on this server.' }
  }
  return { deleted }
}
