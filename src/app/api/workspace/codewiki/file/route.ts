import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

const querySchema = z.object({
  workspace_id: z.string().uuid(),
  run_id: z.string().uuid(),
  path: z.string().min(1).max(2048),
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

  const sp = request.nextUrl.searchParams
  const parsed = querySchema.safeParse({
    workspace_id: sp.get('workspace_id'),
    run_id: sp.get('run_id'),
    path: sp.get('path'),
  })
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, parsed.data.workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: run, error: runErr } = await supabase
    .from('pk_codewiki_runs')
    .select('id, workspace_id')
    .eq('id', parsed.data.run_id)
    .eq('workspace_id', parsed.data.workspace_id)
    .maybeSingle()

  if (runErr || !run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  }

  const { data: row, error } = await supabase
    .from('pk_codewiki_files')
    .select('content')
    .eq('run_id', parsed.data.run_id)
    .eq('path', parsed.data.path)
    .maybeSingle()

  if (error || !row) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  return NextResponse.json({ path: parsed.data.path, content: row.content as string })
}
