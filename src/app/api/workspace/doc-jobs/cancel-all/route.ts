import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient, createServiceRoleClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'
import { cancelAllActiveDocJobs } from '@/server/workspace/cancel-active-jobs'

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
})

/** Cancels every queued documentation job and requests stop for every running one. */
export async function POST(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { workspace_id } = parsed.data

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (!access.effective_features.queue_doc_refresh) {
    return NextResponse.json(
      { error: 'You do not have permission to manage documentation jobs for this workspace.' },
      { status: 403 }
    )
  }

  const admin = createServiceRoleClient()
  if (!admin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  try {
    const { queued, running } = await cancelAllActiveDocJobs(admin, workspace_id)
    const total = queued + running
    return NextResponse.json({
      ok: true,
      queued_cancelled: queued,
      running_stop_requested: running,
      detail:
        total === 0
          ? 'No waiting or in-progress documentation refreshes to stop.'
          : `Stopped ${queued} waiting refresh(es) and requested stop for ${running} in-progress refresh(es).`,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Request failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
