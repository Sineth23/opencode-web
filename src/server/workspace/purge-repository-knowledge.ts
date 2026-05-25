import type { SupabaseClient } from '@supabase/supabase-js'

import { deleteKnowledgeChunksBatched } from '@/server/workspace/batched-chunk-delete'

async function run(label: string, exec: () => PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await exec()
  if (error) throw new Error(`${label}: ${error.message}`)
}

export type PurgeRepositoryKnowledgeOptions = {
  workspaceId: string
  repositoryId: string
  /** When true, delete the pk_linked_repositories row after clearing data (unlink project). */
  removeLink: boolean
}

/**
 * Deletes all indexed chunks, handbook sections, CodeWiki runs, mirror state, sync/doc job rows,
 * and assistant threads scoped to one linked repository. Optionally removes the link row.
 */
export async function purgeRepositoryKnowledge(
  supabase: SupabaseClient,
  input: PurgeRepositoryKnowledgeOptions
): Promise<void> {
  const { workspaceId, repositoryId, removeLink } = input

  const { data: link, error: linkErr } = await supabase
    .from('pk_linked_repositories')
    .select('id, workspace_id')
    .eq('id', repositoryId)
    .maybeSingle()

  if (linkErr) throw new Error(`Repository lookup: ${linkErr.message}`)
  if (!link?.id || link.workspace_id !== workspaceId) {
    throw new Error('Repository not found in this workspace.')
  }

  await run('pk_doc_sections', () =>
    supabase.from('pk_doc_sections').delete().eq('workspace_id', workspaceId).eq('repository_id', repositoryId)
  )

  await run('pk_chat_threads', () =>
    supabase.from('pk_chat_threads').delete().eq('workspace_id', workspaceId).eq('repository_id', repositoryId)
  )

  await run('pk_codewiki_runs', () =>
    supabase.from('pk_codewiki_runs').delete().eq('workspace_id', workspaceId).eq('repository_id', repositoryId)
  )

  await deleteKnowledgeChunksBatched(supabase, { workspaceId, repositoryId })

  await run('pk_repo_mirror_state', () =>
    supabase.from('pk_repo_mirror_state').delete().eq('workspace_id', workspaceId).eq('repository_id', repositoryId)
  )

  await run('pk_sync_jobs', () =>
    supabase.from('pk_sync_jobs').delete().eq('workspace_id', workspaceId).eq('repository_id', repositoryId)
  )

  const { data: docJobs, error: djErr } = await supabase
    .from('pk_doc_generation_jobs')
    .select('id, meta')
    .eq('workspace_id', workspaceId)
  if (djErr) throw new Error(`Doc job list: ${djErr.message}`)
  const toDelete = (docJobs ?? []).filter((row) => {
    const m = row.meta as Record<string, unknown> | null
    return typeof m?.repository_id === 'string' && m.repository_id === repositoryId
  })
  const ids = toDelete.map((r) => r.id as string).filter(Boolean)
  const chunkSize = 80
  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize)
    if (slice.length === 0) continue
    await run('pk_doc_generation_jobs', () =>
      supabase.from('pk_doc_generation_jobs').delete().eq('workspace_id', workspaceId).in('id', slice)
    )
  }

  if (removeLink) {
    await run('pk_linked_repositories', () =>
      supabase.from('pk_linked_repositories').delete().eq('id', repositoryId).eq('workspace_id', workspaceId)
    )
  } else {
    await run('pk_linked_repositories', () =>
      supabase.from('pk_linked_repositories').update({ last_sync_at: null }).eq('id', repositoryId).eq('workspace_id', workspaceId)
    )
  }
}
