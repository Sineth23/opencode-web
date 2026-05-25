import { Buffer } from 'buffer'
import type { BitbucketClientConfig, BitbucketMemberRepository, BitbucketRepositoryRef } from './types'

const API = 'https://api.bitbucket.org/2.0'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Thrown when shouldAbort() is true during a Bitbucket call (worker shutdown). */
export class BitbucketRequestAbortedError extends Error {
  override readonly name = 'BitbucketRequestAbortedError'
  constructor() {
    super('Bitbucket request aborted (shutdown requested)')
  }
}

/** Prefer Retry-After (seconds or HTTP-date); else exponential backoff with jitter. */
function backoffMsForRetryable(res: Response, attempt: number): number {
  const ra = res.headers.get('retry-after')
  if (ra) {
    const sec = parseInt(ra.trim(), 10)
    if (Number.isFinite(sec) && sec >= 0) return Math.min(120_000, sec * 1000)
    const when = Date.parse(ra)
    if (Number.isFinite(when)) return Math.min(120_000, Math.max(0, when - Date.now()))
  }
  const cap = 60_000
  const base = Math.min(cap, 800 * 2 ** (attempt - 1))
  return base + Math.floor(Math.random() * 300)
}

/**
 * Minimal Bitbucket Cloud REST client for repo listing and (later) source download.
 */
export class BitbucketCloudClient {
  constructor(private readonly config: BitbucketClientConfig) {}

  private throwIfAborted(): void {
    if (this.config.shouldAbort?.()) {
      throw new BitbucketRequestAbortedError()
    }
  }

  /** Sleep in small steps so Ctrl+C can stop quickly during 429 backoff. */
  private async sleepInterruptible(ms: number): Promise<void> {
    const step = 250
    let left = ms
    while (left > 0) {
      this.throwIfAborted()
      const chunk = Math.min(step, left)
      await sleep(chunk)
      left -= chunk
    }
  }

  /**
   * Retries 429 / 503 (rate limit and transient overload). Other statuses fail immediately.
   */
  private async bitbucketFetch(target: string, headers: Record<string, string>): Promise<Response> {
    const maxAttempts = 6
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.throwIfAborted()
      const res = await fetch(target, { headers })
      if (res.ok) return res

      const retryable = res.status === 429 || res.status === 503
      const delayMs = backoffMsForRetryable(res, attempt)
      const text = await res.text()

      if (retryable && attempt < maxAttempts) {
        console.warn(
          `[bitbucket] HTTP ${res.status}, retry ${attempt}/${maxAttempts - 1} in ${delayMs}ms: ${text.slice(0, 120)}`
        )
        await this.sleepInterruptible(delayMs)
        continue
      }

      throw new Error(`Bitbucket ${res.status}: ${text.slice(0, 200)}`)
    }
    throw new Error('Bitbucket: retry loop exhausted')
  }

  private authHeaders(): Record<string, string> {
    const user = (this.config.basicAuthUsername ?? '').trim()
    if (user) {
      const b64 = Buffer.from(`${user}:${this.config.accessToken}`, 'utf8').toString('base64')
      return { Authorization: `Basic ${b64}`, Accept: 'application/json' }
    }
    return { Authorization: `Bearer ${this.config.accessToken}`, Accept: 'application/json' }
  }

  private async fetchJson<T>(pathOrAbsolute: string): Promise<T> {
    const target = pathOrAbsolute.startsWith('http') ? pathOrAbsolute : `${API}${pathOrAbsolute}`
    const res = await this.bitbucketFetch(target, this.authHeaders())
    return res.json() as Promise<T>
  }

  async listRepositories(workspace: string): Promise<BitbucketRepositoryRef[]> {
    type Row = {
      uuid: string
      name: string
      slug: string
      full_name: string
      is_private: boolean
      mainbranch?: { name?: string }
    }
    type RepoListPage = { values: Row[]; next?: string }

    const out: BitbucketRepositoryRef[] = []
    let pathOrUrl: string | null = `/repositories/${encodeURIComponent(workspace)}?pagelen=100`

    while (pathOrUrl) {
      const page: RepoListPage = await this.fetchJson<RepoListPage>(pathOrUrl)
      for (const r of page.values) {
        out.push({
          uuid: r.uuid,
          name: r.name,
          slug: r.slug,
          fullName: r.full_name,
          defaultBranch: r.mainbranch?.name ?? 'main',
          isPrivate: r.is_private,
        })
      }
      if (page.next) {
        pathOrUrl = page.next
      } else {
        pathOrUrl = null
      }
    }

    return out
  }

  /**
   * List files and subdirectories at a path in a repo (revision = branch name or commit hash).
   */
  async listSrcDirectory(
    workspace: string,
    repoSlug: string,
    revision: string,
    directoryPath: string
  ): Promise<{ files: string[]; directories: string[]; nextUrl: string | null }> {
    const base = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/src/${encodeURIComponent(revision)}`
    const suffix =
      directoryPath.trim() === ''
        ? '/'
        : `/${directoryPath
            .split('/')
            .filter(Boolean)
            .map((s) => encodeURIComponent(s))
            .join('/')}/`
    type Entry = { type: string; path: string }
    type Page = { values: Entry[]; next?: string }
    let url: string | null = `${API}${base}${suffix === '/' ? '/' : suffix}`
    const files: string[] = []
    const directories: string[] = []
    while (url) {
      const pg: Page = await this.fetchJson<Page>(url)
      for (const v of pg.values ?? []) {
        if (v.type === 'commit_file') files.push(v.path)
        else if (v.type === 'commit_directory') directories.push(v.path)
      }
      url = pg.next ?? null
    }
    return { files, directories, nextUrl: null }
  }

  /** Raw UTF-8 file contents (text sources only for ingestion). */
  async getSrcRawFile(workspace: string, repoSlug: string, revision: string, filePath: string): Promise<string> {
    const base = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/src/${encodeURIComponent(revision)}`
    const encPath = filePath
      .split('/')
      .filter(Boolean)
      .map((s) => encodeURIComponent(s))
      .join('/')
    const target = `${API}${base}/${encPath}`
    const headers = this.authHeaders()
    headers.Accept = 'text/plain, application/json;q=0.9,*/*;q=0.8'
    const res = await this.bitbucketFetch(target, headers)
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      const j = (await res.json()) as { data?: string }
      if (typeof j.data === 'string') return j.data
      return JSON.stringify(j)
    }
    return res.text()
  }

  /**
   * All repositories the authenticated user has access to (any workspace).
   * Uses GET /repositories?role=member, which works with typical `repository` OAuth scope.
   */
  async listMemberRepositories(): Promise<BitbucketMemberRepository[]> {
    type Ws = { slug?: string; name?: string }
    type Row = {
      slug: string
      name: string
      full_name: string
      mainbranch?: { name?: string }
      workspace?: Ws
    }
    type RepoListPage = { values: Row[]; next?: string }

    const out: BitbucketMemberRepository[] = []
    let pathOrUrl: string | null = '/repositories?role=member&pagelen=100'

    while (pathOrUrl) {
      const page: RepoListPage = await this.fetchJson<RepoListPage>(pathOrUrl)
      for (const r of page.values ?? []) {
        const wsSlug = r.workspace?.slug ?? r.full_name.split('/')[0] ?? ''
        const wsName = r.workspace?.name ?? wsSlug
        if (!wsSlug || !r.slug) continue
        out.push({
          workspaceSlug: wsSlug,
          workspaceName: wsName,
          slug: r.slug,
          name: r.name,
          defaultBranch: r.mainbranch?.name ?? 'main',
          fullName: r.full_name,
        })
      }
      pathOrUrl = page.next ?? null
    }

    return out
  }

  /** Workspaces the authenticated user can access (member role). */
  async listWorkspaces(): Promise<{ slug: string; name: string }[]> {
    type Row = { slug: string; name: string }
    type Page = { values: Row[]; next?: string }
    const out: { slug: string; name: string }[] = []
    let pathOrUrl: string | null = '/workspaces?role=member&pagelen=100'
    while (pathOrUrl) {
      const page: Page = await this.fetchJson<Page>(pathOrUrl)
      for (const w of page.values ?? []) {
        out.push({ slug: w.slug, name: w.name })
      }
      pathOrUrl = page.next ?? null
    }
    return out
  }

  /** Branch names for a repository (paginated). */
  async listBranchNames(workspace: string, repoSlug: string): Promise<string[]> {
    type Row = { name: string }
    type Page = { values: Row[]; next?: string }
    const names: string[] = []
    let pathOrUrl: string | null =
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/refs/branches?pagelen=100`
    while (pathOrUrl) {
      const page: Page = await this.fetchJson<Page>(pathOrUrl)
      for (const b of page.values ?? []) {
        names.push(b.name)
      }
      pathOrUrl = page.next ?? null
    }
    return names
  }
}
