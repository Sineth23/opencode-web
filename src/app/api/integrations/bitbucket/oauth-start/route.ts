import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'
import { signBitbucketOAuthState } from '@/server/integrations/bitbucket/oauth-state'

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
})

/**
 * Returns Bitbucket authorize URL. Caller must send Authorization: Bearer <supabase access token>.
 * State is HMAC-signed (BITBUCKET_OAUTH_STATE_SECRET) so workspace/user cannot be forged.
 */
export async function POST(request: NextRequest) {
  const clientId = process.env.BITBUCKET_CLIENT_ID
  const redirectUri = process.env.BITBUCKET_OAUTH_REDIRECT_URI
  const stateSecret = process.env.BITBUCKET_OAUTH_STATE_SECRET
  if (!clientId || !redirectUri || !stateSecret) {
    return NextResponse.json(
      {
        error:
          'Bitbucket OAuth is not configured (BITBUCKET_CLIENT_ID / BITBUCKET_OAUTH_REDIRECT_URI / BITBUCKET_OAUTH_STATE_SECRET)',
      },
      { status: 503 }
    )
  }

  const supabase = createRouteHandlerClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'workspace_id (uuid) required' }, { status: 400 })
  }

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, parsed.data.workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 })
  }
  if (!access.workspace.allowed_integration_slugs.includes('bitbucket')) {
    return NextResponse.json(
      {
        error:
          'Bitbucket is not enabled for your organization. Contact your AutoDoc admin or support to add this integration.',
      },
      { status: 403 }
    )
  }
  if (!access.effective_features.manage_integrations) {
    return NextResponse.json(
      {
        error:
          'Your role cannot connect integrations. Ask an organization owner or admin, or contact support for a role update.',
      },
      { status: 403 }
    )
  }

  const state = signBitbucketOAuthState(
    {
      workspaceId: parsed.data.workspace_id,
      userId: userData.user.id,
      nonce: crypto.randomUUID(),
    },
    stateSecret
  )

  const authorize = new URL('https://bitbucket.org/site/oauth2/authorize')
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('redirect_uri', redirectUri)
  authorize.searchParams.set('state', state)
  // Must match permissions enabled on the Bitbucket OAuth consumer. `repository` covers listing repos (role=member) and sync.
  authorize.searchParams.set('scope', 'repository')

  return NextResponse.json({ url: authorize.toString() })
}
