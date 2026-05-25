import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

/**
 * Last known persisted mirror for a linked repo + branch (for Sync UI).
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

  const workspaceId = request.nextUrl.searchParams.get('workspace_id')
  const repositoryId = request.nextUrl.searchParams.get('repository_id')
  const branch = request.nextUrl.searchParams.get('branch')?.trim() || ''

  if (!workspaceId || !repositoryId) {
    return NextResponse.json({ error: 'workspace_id and repository_id are required' }, { status: 400 })
  }

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, workspaceId)
  if (!access) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let q = supabase
    .from('pk_repo_mirror_state')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('repository_id', repositoryId)
  if (branch) {
    q = q.eq('sync_branch', branch)
  }

  const { data, error } = await q.maybeSingle()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ mirror: data })
}
