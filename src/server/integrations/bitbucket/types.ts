export interface BitbucketOAuthState {
  workspaceId: string
  nonce: string
}

export interface BitbucketRepositoryRef {
  uuid: string
  name: string
  slug: string
  fullName: string
  defaultBranch: string
  isPrivate: boolean
}

export interface BitbucketClientConfig {
  accessToken: string
  /**
   * When set with `accessToken`, REST calls use HTTP Basic (RFC 2617): Bitbucket app password or API token + username/email.
   * When unset, uses `Authorization: Bearer` (OAuth or repository HTTP access token).
   */
  basicAuthUsername?: string | null
  /** When true, in-flight HTTP retries exit immediately (e.g. worker Ctrl+C). */
  shouldAbort?: () => boolean
}

/** Repo returned from GET /repositories?role=member (all workspaces the user can access). */
export interface BitbucketMemberRepository {
  workspaceSlug: string
  workspaceName: string
  slug: string
  name: string
  defaultBranch: string
  fullName: string
}
