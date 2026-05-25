import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

const querySchema = z.object({
  workspace_id: z.string().uuid(),
})

/**
 * Linked Bitbucket repositories for this AutoDoc workspace (RLS: members can read).
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

  const { data, error } = await supabase
    .from('pk_linked_repositories')
    .select('id, bitbucket_workspace, slug, name, default_branch, last_sync_at')
    .eq('workspace_id', parsed.data.workspace_id)
    .order('last_sync_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ repositories: data ?? [] })
}
