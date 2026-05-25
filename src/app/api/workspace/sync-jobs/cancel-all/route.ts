import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient, createServiceRoleClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'
import { cancelAllActiveSyncJobs } from '@/server/workspace/cancel-active-jobs'

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  /** When true, every in-progress job is set to cancelled in the DB immediately (use if the worker was killed or jobs are stuck). */
  force_abandon_running: z.boolean().optional(),
})

/** Cancels every queued sync job in the workspace and requests stop for every running one (or abandons running rows in the DB when force_abandon_running is true). */
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
  if (!access.effective_features.trigger_sync) {
    return NextResponse.json(
      { error: 'You do not have permission to manage content sync jobs for this workspace.' },
      { status: 403 }
    )
  }

  const admin = createServiceRoleClient()
  if (!admin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  try {
    const abandon = parsed.data.force_abandon_running === true
    const { queued, running } = await cancelAllActiveSyncJobs(admin, workspace_id, {
      abandonRunning: abandon,
    })
    const total = queued + running
    return NextResponse.json({
      ok: true,
      queued_cancelled: queued,
      running_stop_requested: abandon ? 0 : running,
      running_abandoned_in_db: abandon ? running : 0,
      detail:
        total === 0
          ? 'No waiting or in-progress content updates to stop.'
          : abandon
            ? `Cancelled ${queued} waiting job(s) and cleared ${running} in-progress job(s) in the database. Restart the worker only when you want new syncs to run.`
            : `Stopped ${queued} waiting job(s) and requested stop for ${running} in-progress job(s).`,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Request failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
