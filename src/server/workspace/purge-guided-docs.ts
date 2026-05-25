import type { SupabaseClient } from '@supabase/supabase-js'

async function run(label: string, exec: () => PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await exec()
  if (error) throw new Error(`${label}: ${error.message}`)
}

/**
 * Removes all rows in pk_doc_sections for the workspace (every scope: org-wide and per-repo/branch).
 * Does not remove chunks, CodeWiki, jobs, or links.
 */
export async function purgeGuidedDocumentation(supabase: SupabaseClient, workspaceId: string): Promise<void> {
  await run('pk_doc_sections', () => supabase.from('pk_doc_sections').delete().eq('workspace_id', workspaceId))
}
