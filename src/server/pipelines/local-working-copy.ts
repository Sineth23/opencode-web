import { existsSync, statSync } from 'fs'
import { relative, resolve } from 'path'

function allowPrefixList(): string[] {
  return (process.env.PK_LOCAL_WORKING_COPY_ALLOW_PREFIXES ?? '')
    .split(/[;|]/g)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Path resolves under one of PK_LOCAL_WORKING_COPY_ALLOW_PREFIXES (no existence check: safe for API routes on hosts without the disk). */
export function matchesLocalWorkingCopyAllowPrefixes(candidate: string): boolean {
  if (process.env.PK_ALLOW_LOCAL_WORKING_COPY !== '1') {
    return false
  }
  const prefixes = allowPrefixList()
  if (prefixes.length === 0) {
    return false
  }
  let abs: string
  try {
    abs = resolve(candidate)
  } catch {
    return false
  }
  for (const p of prefixes) {
    let prefixAbs: string
    try {
      prefixAbs = resolve(p)
    } catch {
      continue
    }
    const rel = relative(prefixAbs, abs)
    if (rel === '' || !rel.startsWith('..')) {
      return true
    }
  }
  return false
}

/**
 * Worker-side: allowlist + path exists + is a directory (git repo root).
 */
export function isAllowedLocalWorkingCopyPath(candidate: string): boolean {
  if (!matchesLocalWorkingCopyAllowPrefixes(candidate)) {
    return false
  }
  let abs: string
  try {
    abs = resolve(candidate)
  } catch {
    return false
  }
  return existsSync(abs) && statSync(abs).isDirectory()
}
