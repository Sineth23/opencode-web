import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * When `PK_BITBUCKET_GIT_ACCESS_TOKEN` is set, Bitbucket REST (discover, ingest file API, sync-all branch list)
 * uses it instead of the workspace OAuth row: avoids expired OAuth for deployments that prefer a static token.
 * Optional `PK_BITBUCKET_GIT_USERNAME` + token uses HTTP Basic (app password style); otherwise Bearer (repository access token / OAuth).
 */
export async function resolveBitbucketApiCredentials(
  admin: SupabaseClient,
  workspaceId: string
): Promise<{ accessToken: string; basicAuthUsername: string | null }> {
  const envTok = (process.env.PK_BITBUCKET_GIT_ACCESS_TOKEN ?? '').trim()
  const basicUser = (process.env.PK_BITBUCKET_GIT_USERNAME ?? '').trim() || null
  if (envTok) {
    return { accessToken: envTok, basicAuthUsername: basicUser }
  }

  const { data: conn, error: connErr } = await admin
    .from('pk_bitbucket_connections')
    .select('access_token')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (connErr || !conn?.access_token) {
    throw new Error(
      'Bitbucket is not connected for this workspace. Connect under Integrations or set PK_BITBUCKET_GIT_ACCESS_TOKEN on the server.'
    )
  }
  return { accessToken: conn.access_token as string, basicAuthUsername: null }
}
