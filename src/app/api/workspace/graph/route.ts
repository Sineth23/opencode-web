import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'
import { appendVirtualExternalReality, type GraphEdgeRow, type GraphEntityRow } from '@/server/workspace/graph-virtual'

const querySchema = z.object({
  workspace_id: z.string().uuid(),
})

export async function GET(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = querySchema.safeParse({ workspace_id: request.nextUrl.searchParams.get('workspace_id') })
  if (!parsed.success) {
    return NextResponse.json({ error: 'workspace_id (uuid) required' }, { status: 400 })
  }

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, parsed.data.workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const ws = parsed.data.workspace_id

  const [{ data: nodeRows, error: nErr }, { data: edgeRows, error: eErr }] = await Promise.all([
    supabase.from('pk_system_entities').select('*').eq('workspace_id', ws).order('kind').order('title'),
    supabase.from('pk_system_edges').select('*').eq('workspace_id', ws),
  ])

  if (nErr || eErr) {
    return NextResponse.json(
      { error: nErr?.message || eErr?.message || 'Graph query failed' },
      { status: 503 }
    )
  }

  const nodes = (nodeRows ?? []) as GraphEntityRow[]
  const edges = (edgeRows ?? []) as GraphEdgeRow[]
  appendVirtualExternalReality(nodes, edges, ws)

  return NextResponse.json({ nodes, edges })
}
