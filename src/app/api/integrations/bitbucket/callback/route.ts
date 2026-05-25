import { NextRequest, NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/server-client'
import { verifyBitbucketOAuthState } from '@/server/integrations/bitbucket/oauth-state'

/**
 * Bitbucket redirects here without Supabase session cookies.
 * Verifies HMAC state, exchanges code, persists tokens with service role.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const err = searchParams.get('error')

  const base = new URL('/settings/integrations', request.url).toString()

  if (err) {
    return NextResponse.redirect(`${base}?bb=error&message=${encodeURIComponent(err)}`)
  }
  if (!code || !state) {
    return NextResponse.redirect(`${base}?bb=error&message=missing_code`)
  }

  const stateSecret = process.env.BITBUCKET_OAUTH_STATE_SECRET
  if (!stateSecret) {
    return NextResponse.redirect(`${base}?bb=error&message=oauth_not_configured`)
  }

  const verified = verifyBitbucketOAuthState(state, stateSecret)
  if (!verified) {
    return NextResponse.redirect(`${base}?bb=error&message=bad_state`)
  }
  const { workspaceId, userId } = verified

  const clientId = process.env.BITBUCKET_CLIENT_ID
  const clientSecret = process.env.BITBUCKET_CLIENT_SECRET
  const redirectUri = process.env.BITBUCKET_OAUTH_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.redirect(`${base}?bb=error&message=oauth_not_configured`)
  }

  const adminPrecheck = createServiceRoleClient()
  if (!adminPrecheck) {
    return NextResponse.redirect(`${base}?bb=error&message=service_role_missing`)
  }

  const { data: wsRow } = await adminPrecheck
    .from('pk_workspaces')
    .select('created_by')
    .eq('id', workspaceId)
    .maybeSingle()

  if (!wsRow) {
    return NextResponse.redirect(`${base}?bb=error&message=invalid_workspace`)
  }

  const isOwner = wsRow.created_by === userId
  if (!isOwner) {
    const { data: memberRow } = await adminPrecheck
      .from('pk_workspace_members')
      .select('user_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!memberRow) {
      return NextResponse.redirect(`${base}?bb=error&message=forbidden_workspace`)
    }
  }

  const tokenRes = await fetch('https://bitbucket.org/site/oauth2/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  })

  if (!tokenRes.ok) {
    const t = await tokenRes.text()
    return NextResponse.redirect(`${base}?bb=error&message=${encodeURIComponent(t.slice(0, 120))}`)
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }

  const { error: upsertErr } = await adminPrecheck.from('pk_bitbucket_connections').upsert(
    {
      workspace_id: workspaceId,
      user_id: userId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
      token_expires_at: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'workspace_id' }
  )

  if (upsertErr) {
    console.error('pk_bitbucket_connections upsert', upsertErr)
    return NextResponse.redirect(`${base}?bb=error&message=db_write_failed`)
  }

  return NextResponse.redirect(`${base}?bb=connected`)
}
