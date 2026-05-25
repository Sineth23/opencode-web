import type { SupabaseClient } from '@supabase/supabase-js'

const nowIso = () => new Date().toISOString()

/** PostgREST `in()` filters are safest in smaller chunks. */
const ID_BATCH = 80

async function cancelQueuedSyncJobsBatched(admin: SupabaseClient, workspaceId: string): Promise<number> {
  let total = 0
  for (;;) {
    const { data: batch, error: selErr } = await admin
      .from('pk_sync_jobs')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(ID_BATCH)

    if (selErr) {
      throw new Error(selErr.message)
    }
    if (!batch?.length) break

    const ids = batch.map((r) => r.id as string)
    const { error: upErr } = await admin
      .from('pk_sync_jobs')
      .update({
        status: 'cancelled',
        completed_at: nowIso(),
        error_message: 'Cancelled (stop all active content updates).',
      })
      .in('id', ids)
      .eq('workspace_id', workspaceId)
      .eq('status', 'queued')

    if (upErr) {
      throw new Error(upErr.message)
    }
    total += ids.length
    if (batch.length < ID_BATCH) break
  }
  return total
}

async function requestStopRunningSyncJobs(admin: SupabaseClient, workspaceId: string): Promise<number> {
  let running = 0
  for (;;) {
    const { data: batch, error: selErr } = await admin
      .from('pk_sync_jobs')
      .select('id, meta')
      .eq('workspace_id', workspaceId)
      .eq('status', 'running')
      .limit(ID_BATCH)

    if (selErr) {
      throw new Error(selErr.message)
    }
    if (!batch?.length) break

    for (const row of batch) {
      const id = row.id as string
      const prev = (row.meta ?? {}) as Record<string, unknown>
      const { error: upErr } = await admin
        .from('pk_sync_jobs')
        .update({ meta: { ...prev, cancel_requested: true } })
        .eq('id', id)
        .eq('workspace_id', workspaceId)
        .eq('status', 'running')
      if (!upErr) running += 1
    }
    if (batch.length < ID_BATCH) break
  }
  return running
}

async function cancelQueuedDocJobsBatched(admin: SupabaseClient, workspaceId: string): Promise<number> {
  let total = 0
  for (;;) {
    const { data: batch, error: selErr } = await admin
      .from('pk_doc_generation_jobs')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(ID_BATCH)

    if (selErr) {
      throw new Error(selErr.message)
    }
    if (!batch?.length) break

    const ids = batch.map((r) => r.id as string)
    const { error: upErr } = await admin
      .from('pk_doc_generation_jobs')
      .update({
        status: 'cancelled',
        completed_at: nowIso(),
        error_message: 'Cancelled before processing started.',
      })
      .in('id', ids)
      .eq('workspace_id', workspaceId)
      .eq('status', 'queued')

    if (upErr) {
      throw new Error(upErr.message)
    }
    total += ids.length
    if (batch.length < ID_BATCH) break
  }
  return total
}

async function requestStopRunningDocJobs(admin: SupabaseClient, workspaceId: string): Promise<number> {
  let running = 0
  for (;;) {
    const { data: batch, error: selErr } = await admin
      .from('pk_doc_generation_jobs')
      .select('id, meta')
      .eq('workspace_id', workspaceId)
      .eq('status', 'running')
      .limit(ID_BATCH)

    if (selErr) {
      throw new Error(selErr.message)
    }
    if (!batch?.length) break

    for (const row of batch) {
      const id = row.id as string
      const prev = (row.meta ?? {}) as Record<string, unknown>
      const { error: upErr } = await admin
        .from('pk_doc_generation_jobs')
        .update({ meta: { ...prev, cancel_requested: true } })
        .eq('id', id)
        .eq('workspace_id', workspaceId)
        .eq('status', 'running')
      if (!upErr) running += 1
    }
    if (batch.length < ID_BATCH) break
  }
  return running
}

/**
 * Marks every running sync job cancelled in the database (no cooperative cancel).
 * Use when the worker was killed so rows are not stuck "running", or to empty the queue before restarting the worker.
 */
export async function abandonRunningSyncJobsBatched(admin: SupabaseClient, workspaceId: string): Promise<number> {
  let total = 0
  for (;;) {
    const { data: batch, error: selErr } = await admin
      .from('pk_sync_jobs')
      .select('id, meta')
      .eq('workspace_id', workspaceId)
      .eq('status', 'running')
      .limit(ID_BATCH)

    if (selErr) {
      throw new Error(selErr.message)
    }
    if (!batch?.length) break

    for (const row of batch) {
      const id = row.id as string
      const prev = (row.meta ?? {}) as Record<string, unknown>
      const { cancel_requested: _c, ...rest } = prev
      const { error: upErr } = await admin
        .from('pk_sync_jobs')
        .update({
          status: 'cancelled',
          completed_at: nowIso(),
          error_message:
            'Cancelled from Sync center (database). The worker treats this as stop; if a process was still embedding, stop npm run worker:ingest as well.',
          meta: { ...rest },
        })
        .eq('id', id)
        .eq('workspace_id', workspaceId)
        .eq('status', 'running')
      if (!upErr) total += 1
    }
    if (batch.length < ID_BATCH) break
  }
  return total
}

export async function cancelAllActiveSyncJobs(
  admin: SupabaseClient,
  workspaceId: string,
  options?: { abandonRunning?: boolean }
): Promise<{ queued: number; running: number }> {
  const queued = await cancelQueuedSyncJobsBatched(admin, workspaceId)
  if (options?.abandonRunning) {
    const abandoned = await abandonRunningSyncJobsBatched(admin, workspaceId)
    return { queued, running: abandoned }
  }
  const running = await requestStopRunningSyncJobs(admin, workspaceId)
  return { queued, running }
}

export async function cancelAllActiveDocJobs(
  admin: SupabaseClient,
  workspaceId: string
): Promise<{ queued: number; running: number }> {
  const queued = await cancelQueuedDocJobsBatched(admin, workspaceId)
  const running = await requestStopRunningDocJobs(admin, workspaceId)
  return { queued, running }
}
