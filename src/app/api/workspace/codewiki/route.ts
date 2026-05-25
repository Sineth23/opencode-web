import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

const querySchema = z.object({
  workspace_id: z.string().uuid(),
  repository_id: z.string().uuid().optional(),
  branch: z.string().max(200).optional(),
})

/**
 * Latest repository overview run metadata and file listing for Documentation UI.
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

  const sp = request.nextUrl.searchParams
  const parsed = querySchema.safeParse({
    workspace_id: sp.get('workspace_id'),
    repository_id: sp.get('repository_id') ?? undefined,
    branch: sp.get('branch') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, parsed.data.workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let q = supabase
    .from('pk_codewiki_runs')
    .select('id, repository_id, sync_branch, status, error_message, started_at, completed_at, meta, source_sync_job_id')
    .eq('workspace_id', parsed.data.workspace_id)
    .eq('status', 'succeeded')
    .order('completed_at', { ascending: false })

  if (parsed.data.repository_id) {
    q = q.eq('repository_id', parsed.data.repository_id)
  }
  const br = parsed.data.branch
  if (br !== undefined && br !== null && String(br).length > 0) {
    q = q.eq('sync_branch', String(br))
  }

  const { data: run, error: runErr } = await q.limit(1).maybeSingle()
  if (runErr) {
    return NextResponse.json({ error: runErr.message }, { status: 500 })
  }
  if (!run) {
    let q2 = supabase
      .from('pk_codewiki_runs')
      .select('status, error_message, completed_at, sync_branch, started_at')
      .eq('workspace_id', parsed.data.workspace_id)
      .order('started_at', { ascending: false })
    if (parsed.data.repository_id) {
      q2 = q2.eq('repository_id', parsed.data.repository_id)
    }
    const br2 = parsed.data.branch
    if (br2 !== undefined && br2 !== null && String(br2).length > 0) {
      q2 = q2.eq('sync_branch', String(br2))
    }
    const { data: attempt, error: attErr } = await q2.limit(1).maybeSingle()
    const last_attempt =
      !attErr && attempt && (attempt as { status: string }).status !== 'succeeded'
        ? {
            status: (attempt as { status: string }).status,
            error_message: (attempt as { error_message: string | null }).error_message,
            completed_at: (attempt as { completed_at: string | null }).completed_at,
            sync_branch: (attempt as { sync_branch: string }).sync_branch,
            started_at: (attempt as { started_at: string | null }).started_at,
          }
        : null
    return NextResponse.json({ run: null, files: [], last_attempt })
  }

  const { data: files, error: fErr } = await supabase
    .from('pk_codewiki_files')
    .select('path')
    .eq('run_id', run.id as string)
    .order('path')

  if (fErr) {
    return NextResponse.json({ error: fErr.message }, { status: 500 })
  }

  return NextResponse.json({
    run,
    files: (files ?? []).map((f) => ({ path: f.path as string })),
  })
}
