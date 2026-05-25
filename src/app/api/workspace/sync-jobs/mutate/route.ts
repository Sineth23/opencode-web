import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient, createServiceRoleClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'
import { deleteWorkerLogFilesForSyncJob } from '@/server/workspace/sync-job-log-files'

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  job_id: z.string().uuid(),
  action: z.enum(['cancel', 'abandon', 'remove', 'delete_log']),
})

/**
 * cancel: queued → cancelled immediately; running → sets meta.cancel_requested (worker stops soon).
 * abandon: running → cancelled immediately in the DB (use when the worker is gone or a job is stuck in progress).
 * remove: deletes the job row (queued, cancelled, failed, succeeded: not running).
 * delete_log: removes matching files under PK_WORKER_LOG_DIR on this server only.
 */
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

  const { workspace_id, job_id, action } = parsed.data

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (!access.effective_features.trigger_sync) {
    return NextResponse.json(
      { error: 'You do not have permission to manage sync jobs for this workspace.' },
      { status: 403 }
    )
  }

  const admin = createServiceRoleClient()
  if (!admin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const { data: job, error: jobErr } = await admin
    .from('pk_sync_jobs')
    .select('id, workspace_id, status, meta')
    .eq('id', job_id)
    .eq('workspace_id', workspace_id)
    .maybeSingle()

  if (jobErr || !job) {
    return NextResponse.json({ error: 'Job not found for this workspace.' }, { status: 404 })
  }

  const status = job.status as string
  const meta = (job.meta ?? {}) as Record<string, unknown>

  if (action === 'cancel') {
    if (status === 'queued') {
      const { data: updated, error: upErr } = await admin
        .from('pk_sync_jobs')
        .update({
          status: 'cancelled',
          completed_at: new Date().toISOString(),
          error_message: 'Cancelled before processing started.',
        })
        .eq('id', job_id)
        .eq('workspace_id', workspace_id)
        .eq('status', 'queued')
        .select('id')

      if (upErr) {
        return NextResponse.json({ error: upErr.message }, { status: 500 })
      }
      if (!updated?.length) {
        return NextResponse.json(
          { error: 'This job is no longer waiting: it may have already started. Try again or use stop on the running job.' },
          { status: 409 }
        )
      }
      return NextResponse.json({ ok: true, detail: 'Waiting job removed from the queue.' })
    }

    if (status === 'running') {
      const nextMeta = { ...meta, cancel_requested: true }
      const { error: upErr } = await admin
        .from('pk_sync_jobs')
        .update({ meta: nextMeta })
        .eq('id', job_id)
        .eq('workspace_id', workspace_id)
        .eq('status', 'running')

      if (upErr) {
        return NextResponse.json({ error: upErr.message }, { status: 500 })
      }
      return NextResponse.json({
        ok: true,
        detail: 'Stop requested. The worker will finish the current step and mark this job as cancelled.',
      })
    }

    return NextResponse.json({ error: 'Only waiting or in-progress jobs can be stopped.' }, { status: 400 })
  }

  if (action === 'abandon') {
    if (status !== 'running') {
      return NextResponse.json({ error: 'Only in-progress jobs can be cleared from the database this way.' }, { status: 400 })
    }
    const { cancel_requested: _ab, ...restAb } = meta
    const { data: updated, error: upErr } = await admin
      .from('pk_sync_jobs')
      .update({
        status: 'cancelled',
        completed_at: new Date().toISOString(),
        error_message:
          'Cancelled from Sync center (database). If a worker was still on this job, stop the worker process; a live worker should notice within about a second.',
        meta: { ...restAb },
      })
      .eq('id', job_id)
      .eq('workspace_id', workspace_id)
      .eq('status', 'running')
      .select('id')

    if (upErr) {
      return NextResponse.json({ error: upErr.message }, { status: 500 })
    }
    if (!updated?.length) {
      return NextResponse.json({ error: 'This job is no longer in progress.' }, { status: 409 })
    }
    return NextResponse.json({
      ok: true,
      detail: 'In-progress job cleared in the database. No new work until you queue another sync.',
    })
  }

  if (action === 'remove') {
    if (status === 'running') {
      return NextResponse.json(
        { error: 'Stop the in-progress job first, then you can remove it from the list.' },
        { status: 400 }
      )
    }

    const { error: delErr } = await admin.from('pk_sync_jobs').delete().eq('id', job_id).eq('workspace_id', workspace_id)

    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, detail: 'Removed from activity history.' })
  }

  // delete_log
  const { deleted, note } = await deleteWorkerLogFilesForSyncJob(job_id)
  return NextResponse.json({
    ok: true,
    deleted_count: deleted.length,
    detail:
      deleted.length > 0
        ? `Deleted ${deleted.length} log file(s) on this server.`
        : note ?? 'No matching log files were found on this server (logs may live only on the worker machine).',
  })
}
