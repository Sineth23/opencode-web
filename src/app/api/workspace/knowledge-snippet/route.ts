import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient, createServiceRoleClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

/**
 * Return one indexed code excerpt for a path (Assistant canvas). Uses service role after membership check.
 */
export async function GET(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const ws = url.searchParams.get('workspace_id')
  const path = url.searchParams.get('path')
  const workspaceId = z.string().uuid().safeParse(ws)
  if (!workspaceId.success || !path || path.trim().length === 0) {
    return NextResponse.json({ error: 'workspace_id and path required' }, { status: 400 })
  }

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, workspaceId.data)
  if (!access) return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 })

  const repoParam = url.searchParams.get('repository_id')
  const repoId = z.string().uuid().safeParse(repoParam).success ? repoParam! : null
  const branchRaw = url.searchParams.get('sync_branch')
  const branch = branchRaw && branchRaw.trim().length > 0 ? branchRaw.trim() : null

  const svc = createServiceRoleClient()
  if (!svc) return NextResponse.json({ error: 'Unavailable' }, { status: 500 })

  const sourcePath = path.trim()

  type Row = { body: string; source_path: string }
  const run = async (useRepo: boolean, useBranch: boolean) => {
    let q = svc
      .from('pk_knowledge_chunks')
      .select('body, source_path')
      .eq('workspace_id', workspaceId.data)
      .eq('source_path', sourcePath)
    if (useRepo && repoId) q = q.eq('repository_id', repoId)
    if (useBranch && branch) q = q.eq('sync_branch', branch)
    const { data, error } = await q.order('updated_at', { ascending: false }).limit(1).maybeSingle()
    return { data: data as Row | null, error }
  }

  const attempts: [boolean, boolean][] = branch
    ? [
        [true, true],
        [true, false],
        [false, false],
      ]
    : [
        [true, false],
        [false, false],
      ]

  for (const [useRepo, useBranch] of attempts) {
    const { data, error } = await run(useRepo, useBranch)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (data) {
      return NextResponse.json({ body: data.body, source_path: data.source_path })
    }
  }

  return NextResponse.json({ error: 'No indexed excerpt for this path yet' }, { status: 404 })
}
