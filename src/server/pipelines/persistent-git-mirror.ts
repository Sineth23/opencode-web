import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { bitbucketAuthenticatedCloneUrl, runGit, runGitStdout } from '@/server/pipelines/bitbucket-git-clone'

function safeBranchDir(branch: string): string {
  const s = branch.replace(/[^\w.\-/]+/g, '_').replace(/\//g, '_').slice(0, 120)
  return s || 'branch'
}

/** Root for persisted mirrors (worker disk). Override with PK_REPO_MIRROR_ROOT. */
export function persistentMirrorRoot(): string {
  const v = (process.env.PK_REPO_MIRROR_ROOT ?? '').trim()
  return v || join(homedir(), '.product-knowledge', 'repo-mirrors')
}

export function persistentMirrorDir(workspaceId: string, repositoryId: string, branch: string): string {
  return join(persistentMirrorRoot(), workspaceId, repositoryId, safeBranchDir(branch))
}

/**
 * Create or update a shallow mirror at a stable path (for clone-only jobs).
 * Uses --no-checkout so Windows-illegal filenames do not break checkout.
 */
export async function ensurePersistentMirrorClone(input: {
  workspaceId: string
  repositoryId: string
  branch: string
  bbWorkspace: string
  repoSlug: string
  token: string
  gitUsername?: string | null
  shouldAbort?: () => boolean
}): Promise<{ path: string; commitSha: string }> {
  const target = persistentMirrorDir(input.workspaceId, input.repositoryId, input.branch)
  const url = bitbucketAuthenticatedCloneUrl(input.bbWorkspace, input.repoSlug, input.token, input.gitUsername)

  await mkdir(dirname(target), { recursive: true })

  if (existsSync(target) && !existsSync(join(target, '.git'))) {
    throw new Error(`Path exists but is not a git repository: ${target}`)
  }

  if (existsSync(join(target, '.git'))) {
    let { code, stderr } = await runGit(['remote', 'set-url', 'origin', url], { cwd: target, shouldAbort: input.shouldAbort })
    if (code !== 0) {
      throw new Error(`git remote set-url failed: ${stderr.slice(0, 500)}`)
    }
    ;({ code, stderr } = await runGit(['fetch', '--depth', '1', 'origin', input.branch], {
      cwd: target,
      shouldAbort: input.shouldAbort,
    }))
    if (code !== 0) {
      throw new Error(`git fetch failed: ${stderr.slice(0, 800)}`)
    }
    ;({ code, stderr } = await runGit(['reset', '--hard', 'FETCH_HEAD'], { cwd: target, shouldAbort: input.shouldAbort }))
    if (code !== 0) {
      throw new Error(`git reset failed: ${stderr.slice(0, 800)}`)
    }
  } else {
    const { code, stderr } = await runGit(
      ['clone', '--depth', '1', '--branch', input.branch, '--no-checkout', url, target],
      { shouldAbort: input.shouldAbort }
    )
    if (code !== 0) {
      const low = stderr.toLowerCase()
      const authHint =
        low.includes('403') || low.includes('401') || low.includes('authentication')
          ? ' App password: set PK_BITBUCKET_GIT_USERNAME. HTTP access token: ensure read access to this repo.'
          : ''
      throw new Error(`git clone failed (exit ${code}). Branch "${input.branch}" exists? ${stderr.slice(0, 800)}${authHint}`)
    }
  }

  const rev = await runGitStdout(['rev-parse', 'HEAD'], { cwd: target })
  if (rev.code !== 0) {
    throw new Error(`git rev-parse failed: ${rev.stderr.slice(0, 400)}`)
  }
  const commitSha = rev.stdout.toString('utf8').trim()
  if (!/^[a-f0-9]{7,40}$/i.test(commitSha)) {
    throw new Error(`Unexpected rev-parse output: ${commitSha.slice(0, 80)}`)
  }

  return { path: target, commitSha }
}
