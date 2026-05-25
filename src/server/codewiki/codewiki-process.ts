import { createHash } from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

import { snapshotProgressEvery } from '@/server/codewiki/snapshot-checkpoint'

const MAX_FILE_STORE_CHARS = 600_000

export type CodewikiSpawnResult = {
  ok: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  docsDir: string
  /** Relative paths under docs dir with trimmed stored content */
  artifacts: { path: string; content: string }[]
  /** Set when `CODEWIKI_OK_IF_DOCS_DIR_NONEMPTY=1` accepted a non-zero CLI exit because docs/ had files. */
  partial_cli_exit?: number
}

function isCodewikiEnabled(): boolean {
  return process.env.CODEWIKI_ENABLED !== 'false' && process.env.CODEWIKI_ENABLED !== '0'
}

const CODEWIKI_SOURCE_FILE_CEILING = 10_000

/** Max source files passed to the CodeWiki CLI (env `CODEWIKI_MAX_SOURCE_FILES`, default 2000, cap 10k). */
export function codewikiSourceFileLimit(): number {
  const raw = Number(process.env.CODEWIKI_MAX_SOURCE_FILES)
  const fallback = 2_000
  const requested = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
  return Math.min(CODEWIKI_SOURCE_FILE_CEILING, Math.max(1, requested))
}

const WIN_DEVICE_NAMES = new Set(
  ['CON', 'PRN', 'AUX', 'NUL', 'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'].map((s) => s.toUpperCase())
)

/** Characters invalid in Windows file / directory names (not applied on other platforms). */
const WIN_BAD_FILE_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g

function sanitizeWindowsPathSegment(segment: string): string {
  let s = segment.replace(WIN_BAD_FILE_NAME_CHARS, '_')
  s = s.replace(/[.\u0020]+$/g, '')
  s = s.trimEnd()
  if (!s || s === '.' || s === '..') return '_'
  const stem = (s.includes('.') ? s.slice(0, s.lastIndexOf('.')) : s).toUpperCase()
  if (WIN_DEVICE_NAMES.has(stem)) return `_${s}`
  return s
}

/**
 * Maps a repo-relative posix path to a temp-disk path. On Windows, illegal filename characters (e.g. `:` in
 * timestamps) are sanitized; rare collisions get a short hash suffix on the last segment.
 */
function diskPathForCodewikiWrite(
  repoRoot: string,
  posixRel: string,
  claimedLower: Map<string, string>
): string | null {
  const norm = posixRel.replace(/^\/+/, '').replace(/\\/g, '/')
  if (!norm || norm.includes('..')) return null

  const parts = norm.split('/').filter(Boolean)
  const segments =
    process.platform === 'win32' ? parts.map(sanitizeWindowsPathSegment) : [...parts]

  const tryDest = (segs: string[]) => join(repoRoot, ...segs)
  let dest = tryDest(segments)
  const key = dest.toLowerCase()
  const prev = claimedLower.get(key)
  if (prev && prev !== posixRel) {
    const h = createHash('sha256').update(posixRel).digest('hex').slice(0, 8)
    const next = [...segments]
    const last = next[next.length - 1] ?? '_'
    next[next.length - 1] = `${last}__${h}`.slice(0, 240)
    dest = tryDest(next)
    claimedLower.set(dest.toLowerCase(), posixRel)
  } else {
    claimedLower.set(key, posixRel)
  }
  return dest
}

function codewikiCommand(): string {
  return (process.env.CODEWIKI_CLI || 'codewiki').trim() || 'codewiki'
}

/** Default 90m; env can raise for huge repos (capped at 12h so mis-set values do not hang forever). */
function codewikiTimeoutMs(): number {
  const n = Number(process.env.CODEWIKI_TIMEOUT_MS)
  const maxMs = 12 * 60 * 60 * 1000
  if (Number.isFinite(n) && n >= 60_000) return Math.min(n, maxMs)
  return 90 * 60 * 1000
}

/**
 * Merged into one `--exclude` for `codewiki generate` (upstream merges with its own defaults).
 * Tuned for Rails + large repos (fixtures, vendor, caches). Opt out: CODEWIKI_APPEND_DEFAULT_GENERATE_EXCLUDE=0
 */
const CODEWIKI_BUILTIN_GENERATE_EXCLUDE =
  'spec/support/fixtures,spec/fixtures,twilio_webhooks,vendor/bundle,vendor/cache,vendor/assets,.bundle,tmp/cache,tmp/pids,coverage,public/packs,*apache_poi*,*stanford_corenlp*,*corenlp*'

function mergeCommaExcludeParts(...parts: (string | undefined | null)[]): string {
  const out = new Set<string>()
  for (const part of parts) {
    if (!part?.trim()) continue
    for (const p of part.split(',')) {
      const s = p.trim()
      if (s) out.add(s)
    }
  }
  return [...out].join(',')
}

/** Removes `--exclude` / `-e` (and `--exclude=`) from tokens; returns remaining flags + merged exclude string. */
function extractExcludeFromArgTokens(tokens: string[]): { rest: string[]; exclude: string } {
  const rest: string[] = []
  let exclude = ''
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--exclude' || t === '-e') {
      if (i + 1 < tokens.length) {
        exclude = mergeCommaExcludeParts(exclude, tokens[i + 1])
        i++
      }
      continue
    }
    if (t.startsWith('--exclude=')) {
      exclude = mergeCommaExcludeParts(exclude, t.slice('--exclude='.length))
      continue
    }
    if (t.startsWith('-e=')) {
      exclude = mergeCommaExcludeParts(exclude, t.slice('-e='.length))
      continue
    }
    rest.push(t)
  }
  return { rest, exclude }
}

/**
 * Builds extra CLI args after `generate --output docs`.
 * - `CODEWIKI_GENERATE_ARGS`: space-separated (no spaces inside one token; use commas inside `--exclude`).
 * - `CODEWIKI_GENERATE_EXCLUDE`: comma-separated patterns merged into one `--exclude`.
 * - `CODEWIKI_GENERATE_FOCUS`: comma-separated paths for `--focus`.
 * - Builtin exclude list is appended unless `CODEWIKI_APPEND_DEFAULT_GENERATE_EXCLUDE=0`.
 */
function buildCodewikiGenerateExtraArgs(): string[] {
  const raw = (process.env.CODEWIKI_GENERATE_ARGS || '').trim()
  const baseTokens = raw ? raw.split(/\s+/).filter(Boolean) : []
  const { rest, exclude: fromManual } = extractExcludeFromArgTokens(baseTokens)

  const appendBuiltin = (process.env.CODEWIKI_APPEND_DEFAULT_GENERATE_EXCLUDE ?? '1').trim() !== '0'
  const extraExclude = (process.env.CODEWIKI_GENERATE_EXCLUDE || '').trim()
  const merged = mergeCommaExcludeParts(
    appendBuiltin ? CODEWIKI_BUILTIN_GENERATE_EXCLUDE : undefined,
    fromManual || undefined,
    extraExclude || undefined
  )

  const out = [...rest]
  if (merged) {
    out.push('--exclude', merged)
  }
  const focus = (process.env.CODEWIKI_GENERATE_FOCUS || '').trim()
  if (focus) {
    out.push('--focus', focus)
  }
  return out
}

function profileEnv(baseProfile: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  env.HOME = baseProfile
  env.USERPROFILE = baseProfile
  return env
}

function runConfigSet(cwd: string, env: NodeJS.ProcessEnv): { ok: boolean; stderr: string } {
  const cmd = codewikiCommand()
  const apiKey = (process.env.CODEWIKI_API_KEY || process.env.OPENAI_API_KEY || '').trim()
  if (!apiKey) {
    return { ok: false, stderr: 'Missing OPENAI_API_KEY or CODEWIKI_API_KEY for repository overview step' }
  }
  const baseUrl = (process.env.CODEWIKI_BASE_URL || 'https://api.openai.com/v1').trim()
  const main = (process.env.CODEWIKI_MAIN_MODEL || 'gpt-4o').trim()
  const cluster = (process.env.CODEWIKI_CLUSTER_MODEL || main).trim()
  const fallback = (process.env.CODEWIKI_FALLBACK_MODEL || 'gpt-4o-mini').trim()

  const args = [
    'config',
    'set',
    '--api-key',
    apiKey,
    '--base-url',
    baseUrl,
    '--main-model',
    main,
    '--cluster-model',
    cluster,
    '--fallback-model',
    fallback,
  ]

  /** CodeWiki defaults to 32768; many OpenAI chat models cap completion at 16384: set env if you see 400 on max_tokens. */
  const maxTok = Number(process.env.CODEWIKI_MAX_TOKENS)
  /** Avoid invalid_request_error when env or upstream config has a typo (e.g. 163840 for gpt-4o-class caps). */
  const OPENAI_TYPICAL_MAX_COMPLETION = 16_384
  if (Number.isFinite(maxTok) && maxTok >= 256) {
    const capped = Math.min(Math.floor(maxTok), OPENAI_TYPICAL_MAX_COMPLETION)
    args.push('--max-tokens', String(capped))
  }
  const maxTokMod = Number(process.env.CODEWIKI_MAX_TOKEN_PER_MODULE)
  if (Number.isFinite(maxTokMod) && maxTokMod >= 256) {
    args.push('--max-token-per-module', String(Math.floor(maxTokMod)))
  }
  const maxTokLeaf = Number(process.env.CODEWIKI_MAX_TOKEN_PER_LEAF_MODULE)
  if (Number.isFinite(maxTokLeaf) && maxTokLeaf >= 256) {
    args.push('--max-token-per-leaf-module', String(Math.floor(maxTokLeaf)))
  }

  const r = spawnSync(cmd, args, { cwd, env, shell: false, encoding: 'utf8', maxBuffer: 8_000_000 })
  const errText = `${r.stderr || ''}${r.error?.message || ''}`
  return { ok: r.status === 0, stderr: errText.slice(0, 8000) }
}

function walkDocsDir(docsDir: string, relBase = ''): { rel: string; abs: string }[] {
  if (!existsSync(docsDir)) return []
  const out: { rel: string; abs: string }[] = []
  for (const ent of readdirSync(docsDir, { withFileTypes: true })) {
    const abs = join(docsDir, ent.name)
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      out.push(...walkDocsDir(abs, rel))
    } else {
      out.push({ rel, abs })
    }
  }
  return out
}

function trimForStore(text: string): string {
  if (text.length <= MAX_FILE_STORE_CHARS) return text
  return (
    text.slice(0, MAX_FILE_STORE_CHARS) +
    `\n\n[AutoDoc: truncated at ${MAX_FILE_STORE_CHARS} characters for storage.]`
  )
}

/**
 * Writes sources to a temp tree, runs the configured overview CLI, reads `./docs` output.
 * No-op when CODEWIKI_ENABLED=false.
 */
export async function runCodewikiCliOnSourceTree(input: {
  /** Files as repo-relative posix paths */
  files: { path: string; content: string }[]
  repoSlug: string
  /** Optional worker progress lines (e.g. `ingestBitbucketSyncJob` `onProgress`). */
  onProgress?: (message: string) => void
}): Promise<CodewikiSpawnResult> {
  if (!isCodewikiEnabled()) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: 'CODEWIKI_ENABLED is false; skipping repository overview step.',
      docsDir: '',
      artifacts: [],
    }
  }

  if (input.files.length === 0) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: 'No source files for repository overview step.',
      docsDir: '',
      artifacts: [],
    }
  }

  const root = join(tmpdir(), `autodoc-cw-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const profile = join(root, 'profile')
  const repoRoot = join(root, 'repo', input.repoSlug.replace(/[^a-zA-Z0-9._-]+/g, '_'))
  mkdirSync(profile, { recursive: true })
  mkdirSync(repoRoot, { recursive: true })

  const maxFiles = codewikiSourceFileLimit()
  const useFiles = input.files.slice(0, maxFiles)
  const claimedLower = new Map<string, string>()
  const every = snapshotProgressEvery()
  let wrote = 0

  for (let wi = 0; wi < useFiles.length; wi++) {
    const f = useFiles[wi]!
    const dest = diskPathForCodewikiWrite(repoRoot, f.path, claimedLower)
    if (!dest) continue
    mkdirSync(dirname(dest), { recursive: true })
    const body = f.content.length > 2_000_000 ? f.content.slice(0, 2_000_000) + '\n[truncated]\n' : f.content
    writeFileSync(dest, body, 'utf8')
    wrote++
    const scanned = wi + 1
    if (input.onProgress && (wrote % every === 0 || scanned === useFiles.length)) {
      input.onProgress(
        `CodeWiki staging · ${wrote} file(s) written · ${scanned}/${useFiles.length} snapshot entries scanned`
      )
    }
  }

  input.onProgress?.('CodeWiki: configuring CLI (codewiki config set)…')
  const env = profileEnv(profile)
  const cfg = runConfigSet(repoRoot, env)
  if (!cfg.ok) {
    rmSync(root, { recursive: true, force: true })
    return {
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: cfg.stderr || 'codewiki config set failed',
      docsDir: '',
      artifacts: [],
    }
  }

  const docsDir = join(repoRoot, 'docs')
  const cmd = codewikiCommand()
  const extraArgs = buildCodewikiGenerateExtraArgs()
  const args = ['generate', '--output', 'docs', ...extraArgs]
  const exIdx = extraArgs.indexOf('--exclude')
  const foIdx = extraArgs.indexOf('--focus')
  const exSummary =
    exIdx >= 0 && extraArgs[exIdx + 1]
      ? `${String(extraArgs[exIdx + 1]).split(',').length} exclude patterns`
      : 'no extra exclude merge'
  const foSummary = foIdx >= 0 && extraArgs[foIdx + 1] ? `focus=${extraArgs[foIdx + 1]}` : 'no focus'
  input.onProgress?.(
    `CodeWiki: running codewiki generate (timeout ${Math.round(codewikiTimeoutMs() / 60_000)} min) · ${exSummary} · ${foSummary}`
  )
  const proc = spawn(cmd, args, { cwd: repoRoot, env, shell: false })
  let stdout = ''
  let stderr = ''
  proc.stdout?.on('data', (c: Buffer) => {
    stdout += c.toString()
  })
  proc.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString()
  })

  const exitCode = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => {
      try {
        proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      resolve(null)
    }, codewikiTimeoutMs())
    proc.on('close', (code) => {
      clearTimeout(t)
      resolve(code)
    })
    proc.on('error', (err) => {
      clearTimeout(t)
      stderr += `\n${err.message}`
      resolve(null)
    })
  })

  input.onProgress?.(
    exitCode === 0
      ? 'CodeWiki: CLI process finished · reading docs/ output…'
      : `CodeWiki: CLI process ended (exit ${exitCode === null ? 'timeout or spawn error' : String(exitCode)}) · reading any docs/ output…`
  )

  const artifacts: { path: string; content: string }[] = []
  if (existsSync(docsDir)) {
    for (const { rel, abs } of walkDocsDir(docsDir)) {
      try {
        const raw = readFileSync(abs, 'utf8')
        artifacts.push({ path: rel.replace(/\\/g, '/'), content: trimForStore(raw) })
      } catch {
        /* skip */
      }
    }
  }

  rmSync(root, { recursive: true, force: true })

  const allowNonzero =
    (process.env.CODEWIKI_OK_IF_DOCS_DIR_NONEMPTY ?? '').trim() === '1' ||
    (process.env.CODEWIKI_OK_IF_DOCS_DIR_NONEMPTY ?? '').trim().toLowerCase() === 'true'
  /** Timeouts / spawn failures use null: never treat as success. */
  const hasCliExit = typeof exitCode === 'number'
  const acceptPartial =
    allowNonzero && artifacts.length > 0 && hasCliExit && exitCode !== 0 && exitCode !== 130
  const ok = (exitCode === 0 && artifacts.length > 0) || acceptPartial

  let outStderr = stderr.slice(0, 24_000)
  if (acceptPartial) {
    outStderr =
      `[AutoDoc: codewiki exited with code ${exitCode} but docs/ contained ${artifacts.length} file(s); ` +
      `persisting because CODEWIKI_OK_IF_DOCS_DIR_NONEMPTY=1. Review upstream warnings/errors below.]\n` +
      outStderr
  }

  return {
    ok,
    exitCode,
    signal: null,
    stdout: stdout.slice(0, 24_000),
    stderr: outStderr,
    docsDir: 'docs',
    artifacts,
    ...(acceptPartial && typeof exitCode === 'number' ? { partial_cli_exit: exitCode } : {}),
  }
}

export { isCodewikiEnabled }
