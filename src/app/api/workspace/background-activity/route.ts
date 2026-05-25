import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

const querySchema = z.object({
  workspace_id: z.string().uuid(),
})

/**
 * Lightweight counts for global UI (sync + documentation jobs in flight).
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

  const ws = parsed.data.workspace_id

  const [
    syncQueuedRes,
    syncRunningRes,
    docQueuedRes,
    docRunningRes,
  ] = await Promise.all([
    supabase.from('pk_sync_jobs').select('*', { count: 'exact', head: true }).eq('workspace_id', ws).eq('status', 'queued'),
    supabase.from('pk_sync_jobs').select('*', { count: 'exact', head: true }).eq('workspace_id', ws).eq('status', 'running'),
    supabase
      .from('pk_doc_generation_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', ws)
      .eq('status', 'queued'),
    supabase
      .from('pk_doc_generation_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', ws)
      .eq('status', 'running'),
  ])

  if (syncQueuedRes.error) {
    return NextResponse.json({ error: syncQueuedRes.error.message }, { status: 500 })
  }
  if (syncRunningRes.error) {
    return NextResponse.json({ error: syncRunningRes.error.message }, { status: 500 })
  }
  if (docQueuedRes.error) {
    return NextResponse.json({ error: docQueuedRes.error.message }, { status: 500 })
  }
  if (docRunningRes.error) {
    return NextResponse.json({ error: docRunningRes.error.message }, { status: 500 })
  }

  const syncQueued = syncQueuedRes.count ?? 0
  const syncRunning = syncRunningRes.count ?? 0
  const docQueued = docQueuedRes.count ?? 0
  const docRunning = docRunningRes.count ?? 0

  return NextResponse.json({
    sync: { queued: syncQueued, running: syncRunning },
    documentation: { queued: docQueued, running: docRunning },
  })
}
