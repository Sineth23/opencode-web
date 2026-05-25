import type { SupabaseClient } from '@supabase/supabase-js'

import { deleteKnowledgeChunksBatched } from '@/server/workspace/batched-chunk-delete'

async function run(label: string, exec: () => PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await exec()
  if (error) throw new Error(`${label}: ${error.message}`)
}

/**
 * Removes all indexed knowledge, generated documentation, assistant threads, job history,
 * system map, and usage counters for a workspace. Does not delete the workspace, members,
 * Bitbucket connection, or saved repository links (only clears last_sync_at on links).
 */
export async function purgeWorkspaceKnowledge(supabase: SupabaseClient, workspaceId: string): Promise<void> {
  const ws = workspaceId

  await run('pk_chat_threads', () => supabase.from('pk_chat_threads').delete().eq('workspace_id', ws))

  await run('pk_codewiki_runs', () => supabase.from('pk_codewiki_runs').delete().eq('workspace_id', ws))

  await run('pk_system_edges', () => supabase.from('pk_system_edges').delete().eq('workspace_id', ws))

  await run('pk_system_entities', () => supabase.from('pk_system_entities').delete().eq('workspace_id', ws))

  await deleteKnowledgeChunksBatched(supabase, { workspaceId: ws })

  await run('pk_doc_sections', () => supabase.from('pk_doc_sections').delete().eq('workspace_id', ws))

  await run('pk_doc_generation_jobs', () => supabase.from('pk_doc_generation_jobs').delete().eq('workspace_id', ws))

  await run('pk_sync_jobs', () => supabase.from('pk_sync_jobs').delete().eq('workspace_id', ws))

  await run('pk_workspace_usage_counters', () =>
    supabase.from('pk_workspace_usage_counters').delete().eq('workspace_id', ws),
  )

  await run('pk_linked_repositories', () =>
    supabase.from('pk_linked_repositories').update({ last_sync_at: null }).eq('workspace_id', ws),
  )
}
