import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient, createServiceRoleClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

const querySchema = z.object({
  workspace_id: z.string().uuid(),
})

/**
 * Returns whether Bitbucket is connected for a workspace without exposing tokens.
 */
export async function GET(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = querySchema.safeParse({
    workspace_id: request.nextUrl.searchParams.get('workspace_id'),
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'workspace_id required' }, { status: 400 })
  }

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, parsed.data.workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const admin = createServiceRoleClient()
  if (!admin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const envTok = (process.env.PK_BITBUCKET_GIT_ACCESS_TOKEN ?? '').trim()
  const { data: conn } = await admin
    .from('pk_bitbucket_connections')
    .select('updated_at')
    .eq('workspace_id', parsed.data.workspace_id)
    .maybeSingle()

  return NextResponse.json({
    /** True when OAuth is linked or the server has PK_BITBUCKET_GIT_ACCESS_TOKEN (REST + git on worker). */
    connected: Boolean(envTok || conn),
    /** True when REST/git use the env token and no workspace OAuth row exists (Integrations may look “disconnected”). */
    connected_via_env_token_only: Boolean(envTok && !conn),
    updated_at: conn?.updated_at ?? null,
  })
}
