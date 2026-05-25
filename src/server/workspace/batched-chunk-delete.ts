import type { SupabaseClient } from '@supabase/supabase-js'

const SELECT_BATCH = 200
const DELETE_IN_CHUNK = 40

function rpcMissingOrUnavailable(err: { message?: string; code?: string }): boolean {
  const m = (err.message ?? '').toLowerCase()
  if (m.includes('could not find the function') || m.includes('schema cache')) return true
  if (m.includes('function public.pk_delete_knowledge_chunks_batch') && m.includes('does not exist')) return true
  if (err.code === '42883') return true
  return false
}

/**
 * Slow fallback when DB migration 018 is not applied: select ids + small `.in()` deletes.
 */
async function deleteKnowledgeChunksViaClientBatches(
  supabase: SupabaseClient,
  opts: { workspaceId: string; repositoryId?: string },
): Promise<void> {
  const { workspaceId, repositoryId } = opts
  const label = 'pk_knowledge_chunks'
  let total = 0
  const maxRows = 50_000_000
  for (;;) {
    if (total > maxRows) {
      throw new Error(`${label}: aborted batch loop after ${maxRows} rows (safety cap)`)
    }
    let sel = supabase
      .from('pk_knowledge_chunks')
      .select('id')
      .eq('workspace_id', workspaceId)
      .limit(SELECT_BATCH)
    if (repositoryId) sel = sel.eq('repository_id', repositoryId)
    const { data: rows, error: selErr } = await sel
    if (selErr) throw new Error(`${label} select: ${selErr.message}`)
    const ids = (rows ?? []).map((r) => (r as { id: string }).id).filter(Boolean)
    if (ids.length === 0) break
    for (let i = 0; i < ids.length; i += DELETE_IN_CHUNK) {
      const slice = ids.slice(i, i + DELETE_IN_CHUNK)
      const { error: delErr } = await supabase
        .from('pk_knowledge_chunks')
        .delete()
        .eq('workspace_id', workspaceId)
        .in('id', slice)
      if (delErr) throw new Error(`${label}: ${delErr.message}`)
    }
    total += ids.length
  }
}

/**
 * Deletes pk_knowledge_chunks in bounded server-side batches (migration 018 RPC) so purges
 * finish in minutes instead of tens of thousands of PostgREST round-trips. Falls back to
 * client-side batches if the RPC is not installed.
 */
export async function deleteKnowledgeChunksBatched(
  supabase: SupabaseClient,
  opts: { workspaceId: string; repositoryId?: string },
): Promise<void> {
  const { workspaceId, repositoryId } = opts
  const label = 'pk_knowledge_chunks'
  const pLimit = 12_000
  let total = 0
  const maxRows = 50_000_000

  for (;;) {
    if (total > maxRows) {
      throw new Error(`${label}: aborted batch loop after ${maxRows} rows (safety cap)`)
    }

    const { data, error } = await supabase.rpc('pk_delete_knowledge_chunks_batch', {
      p_workspace_id: workspaceId,
      p_repository_id: repositoryId ?? null,
      p_limit: pLimit,
    })

    if (error) {
      if (rpcMissingOrUnavailable(error)) {
        await deleteKnowledgeChunksViaClientBatches(supabase, opts)
        return
      }
      throw new Error(`${label}: ${error.message}`)
    }

    const n = typeof data === 'number' ? data : Number(data)
    if (!Number.isFinite(n) || n <= 0) break
    total += n
  }
}
