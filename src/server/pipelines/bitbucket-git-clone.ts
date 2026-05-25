import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { sortPathsForIngest } from '@/server/pipelines/content-classification'
import { shouldSkipIndexedPath } from '@/server/pipelines/ingest-config'

const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|md|mdx|py|go|java|json|yaml|yml|sql|css|scss|less|html|htm|txt|rs|kt|kts|vue|svelte|rb|php|cs|fs|fsx|scala|groovy|xml|toml|ini|sh|bash|zsh|ps1|gradle|swift|dart|lua|pl|pm|h|hpp|c|cc|cpp|cxx|hxx|proto|graphql|gql|tf|tfvars|hcl)$/i

function isTextSourcePath(full: string): boolean {
  const base = full.split('/').pop() ?? ''
  if (
    /^(Dockerfile|dockerfile|Makefile|GNUmakefile|Rakefile|Gemfile|Vagrantfile|Jenkinsfile|Containerfile)$/i.test(base)
  ) {
    return true
  }
  return TEXT_EXT.test(full)
}

/**
 * Bitbucket Cloud HTTPS clone URL.
 * - Default: `x-token-auth` + token (HTTP access tokens / many machine users).
 * - With `gitUsername`: `username:password` form for classic **App passwords** (Bitbucket account username + app password).
 * @see https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud-with-git/
 */
export function bitbucketAuthenticatedCloneUrl(
  bbWorkspace: string,
  repoSlug: string,
  token: string,
  gitUsername?: string | null
): string {
  const user = (gitUsername ?? '').trim()
  const host = `bitbucket.org/${encodeURIComponent(bbWorkspace)}/${encodeURIComponent(repoSlug)}.git`
  if (user) {
    return `https://${encodeURIComponent(user)}:${encodeURIComponent(token)}@${host}`
  }
  return `https://x-token-auth:${encodeURIComponent(token)}@${host}`
}

export type GitCloneIngestEnv = {
  /** PK_INGEST_USE_GIT_CLONE=true and PK_BITBUCKET_GIT_ACCESS_TOKEN set */
  useGitClone: boolean
  token: string | null
  /** Bitbucket account username when the secret is an App password (not an HTTP access token). */
  gitUsername: string | null
}

export function loadGitCloneIngestEnv(): GitCloneIngestEnv {
  const flag = (process.env.PK_INGEST_USE_GIT_CLONE ?? '').trim().toLowerCase()
  const enabledByFlag = flag === '1' || flag === 'true' || flag === 'yes'
  const token = (process.env.PK_BITBUCKET_GIT_ACCESS_TOKEN ?? '').trim()
  const gitUsername = (process.env.PK_BITBUCKET_GIT_USERNAME ?? '').trim() || null
  if (!enabledByFlag || !token) {
    return { useGitClone: false, token: null, gitUsername: null }
  }
  return { useGitClone: true, token, gitUsername }
}

/** @internal Exported for persistent mirror updates */
export function runGit(
  args: string[],
  opts: { cwd?: string; shouldAbort?: () => boolean }
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      cwd: opts.cwd,
    })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.stdout?.on('data', () => {})
    const checkAbort = setInterval(() => {
      if (opts.shouldAbort?.()) {
        child.kill('SIGTERM')
        clearInterval(checkAbort)
      }
    }, 500)
    child.on('error', (err) => {
      clearInterval(checkAbort)
      reject(err)
    })
    child.on('close', (code) => {
      clearInterval(checkAbort)
      resolve({ code, stderr })
    })
  })
}

/** @internal */
export function runGitStdout(
  args: string[],
  opts: { cwd: string; shouldAbort?: () => boolean }
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const child = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      cwd: opts.cwd,
    })
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => {
      chunks.push(d)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    const checkAbort = setInterval(() => {
      if (opts.shouldAbort?.()) {
        child.kill('SIGTERM')
        clearInterval(checkAbort)
      }
    }, 500)
    child.on('error', (err) => {
      clearInterval(checkAbort)
      reject(err)
    })
    child.on('close', (code) => {
      clearInterval(checkAbort)
      resolve({ code, stdout: Buffer.concat(chunks), stderr })
    })
  })
}

/** Parse `git ls-tree -r -z HEAD` output (NUL-separated records). */
function parseLsTreeZ(buf: Buffer): { oid: string; path: string }[] {
  const out: { oid: string; path: string }[] = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) continue
    const chunk = buf.subarray(start, i)
    start = i + 1
    if (chunk.length === 0) continue
    const tab = chunk.indexOf(0x09)
    if (tab === -1) continue
    const head = chunk.subarray(0, tab).toString('utf8')
    const pathPart = chunk.subarray(tab + 1).toString('utf8')
    const sp1 = head.indexOf(' ')
    const sp2 = head.indexOf(' ', sp1 + 1)
    if (sp1 === -1 || sp2 === -1) continue
    const type = head.slice(sp1 + 1, sp2)
    const oid = head.slice(sp2 + 1).trim()
    if (type !== 'blob' || oid.length < 4) continue
    out.push({ oid, path: pathPart.replace(/\\/g, '/') })
  }
  return out
}

async function gitCatFileUtf8(repoDir: string, oid: string): Promise<string> {
  const { code, stdout, stderr } = await runGitStdout(['cat-file', '-p', oid], { cwd: repoDir })
  if (code !== 0) {
    throw new Error(`git cat-file failed: ${stderr.slice(0, 400)}`)
  }
  return stdout.toString('utf8')
}

export type GitSourceReader = {
  /** Sorted, capped paths to ingest */
  paths: string[]
  readUtf8: (repoRelativePosix: string) => Promise<string>
}

/**
 * After a `--no-checkout` clone: list blobs via `ls-tree`, read via `cat-file`.
 * Avoids checking out paths that are illegal on Windows (e.g. `:` in filenames) while still indexing them.
 */
export async function buildGitSourceReader(repoDir: string, maxFiles: number): Promise<GitSourceReader> {
  const { code, stdout, stderr } = await runGitStdout(['ls-tree', '-r', '-z', 'HEAD'], { cwd: repoDir })
  if (code !== 0) {
    throw new Error(`git ls-tree failed: ${stderr.slice(0, 600)}`)
  }
  const entries = parseLsTreeZ(stdout)
  const candidates: { oid: string; path: string }[] = []
  for (const e of entries) {
    if (shouldSkipIndexedPath(e.path)) continue
    if (!isTextSourcePath(e.path)) continue
    candidates.push(e)
  }
  const sorted = sortPathsForIngest(candidates.map((c) => c.path))
  const cap = maxFiles === Number.MAX_SAFE_INTEGER ? sorted.length : Math.min(sorted.length, maxFiles)
  const chosen = sorted.slice(0, cap)
  const oidByPath = new Map<string, string>()
  for (const c of candidates) {
    oidByPath.set(c.path, c.oid)
  }
  const readUtf8 = async (repoRelativePosix: string): Promise<string> => {
    const oid = oidByPath.get(repoRelativePosix)
    if (!oid) {
      throw new Error(`No blob for path in git index: ${repoRelativePosix}`)
    }
    return gitCatFileUtf8(repoDir, oid)
  }
  return { paths: chosen, readUtf8 }
}

/**
 * Shallow clone (no working tree checkout). Caller must `cleanup()` when done.
 * `--no-checkout` prevents Windows from failing on repo paths that are not valid local filenames.
 */
export async function shallowCloneBitbucketRepo(input: {
  bbWorkspace: string
  repoSlug: string
  branch: string
  token: string
  /** Set when using App password auth (see PK_BITBUCKET_GIT_USERNAME). */
  gitUsername?: string | null
  shouldAbort?: () => boolean
}): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'pk-ingest-'))
  const url = bitbucketAuthenticatedCloneUrl(input.bbWorkspace, input.repoSlug, input.token, input.gitUsername)
  const { code, stderr } = await runGit(
    ['clone', '--depth', '1', '--branch', input.branch, '--no-checkout', url, dir],
    { shouldAbort: input.shouldAbort }
  )
  if (code !== 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    const low = stderr.toLowerCase()
    const authHint =
      low.includes('403') || low.includes('401') || low.includes('authentication')
        ? ' If this is an App password, set PK_BITBUCKET_GIT_USERNAME to your Bitbucket username (same machine as PK_BITBUCKET_GIT_ACCESS_TOKEN). For HTTP access tokens, ensure the token has read access to this repository. Git often hides credentials in error text: check the token and repo access.'
        : ''
    throw new Error(
      `git clone failed (exit ${code}). Is git on PATH? Branch "${input.branch}" exists? ${stderr.slice(0, 800)}${authHint}`
    )
  }
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
