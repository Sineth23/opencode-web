/** True when job `meta` asks the worker to pause after the current operational article (cooperative). */
export function isJobPauseRequested(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') return false
  const v = (meta as Record<string, unknown>).pause_requested
  if (v === true) return true
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim()
    return s === 'true' || s === '1'
  }
  if (typeof v === 'number') return v === 1
  return false
}

/** True when job `meta` asks the worker to stop (tolerates odd JSON shapes from clients). */
export function isJobCancelRequested(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') return false
  const v = (meta as Record<string, unknown>).cancel_requested
  if (v === true) return true
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim()
    return s === 'true' || s === '1'
  }
  if (typeof v === 'number') return v === 1
  return false
}

/** Cooperative stop: worker / UI requested abort before the job finished normally. */
export class JobAbortRequestedError extends Error {
  override readonly name = 'JobAbortRequestedError'
  constructor() {
    super('Job stopped before completion')
  }
}

/** Cooperative pause: worker finished the current article; job row should move to `paused` for later resume. */
export class JobPauseRequestedError extends Error {
  override readonly name = 'JobPauseRequestedError'
  constructor() {
    super('Documentation job paused at your request')
  }
}
