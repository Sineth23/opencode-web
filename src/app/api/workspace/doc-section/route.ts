import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

/**
 * Fetch one handbook section for the Assistant canvas (RLS: workspace member).
 */
export async function GET(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const ws = url.searchParams.get('workspace_id')
  const sid = url.searchParams.get('section_id')
  const workspaceId = z.string().uuid().safeParse(ws)
  const sectionId = z.string().uuid().safeParse(sid)
  if (!workspaceId.success || !sectionId.success) {
    return NextResponse.json({ error: 'workspace_id and section_id (uuid) required' }, { status: 400 })
  }

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, workspaceId.data)
  if (!access) return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 })

  const { data, error } = await supabase
    .from('pk_doc_sections')
    .select('id, title, summary, body_md, category')
    .eq('workspace_id', workspaceId.data)
    .eq('id', sectionId.data)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Section not found' }, { status: 404 })

  return NextResponse.json(data)
}
