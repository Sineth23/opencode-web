import type { SupabaseClient } from '@supabase/supabase-js'

export type RepoMirrorStateRow = {
  id: string
  workspace_id: string
  repository_id: string
  sync_branch: string
  filesystem_path: string
  head_commit_sha: string | null
  environment: string
  last_clone_job_id: string | null
  last_embed_job_id: string | null
  updated_at: string
}

export async function fetchMirrorState(
  supabase: SupabaseClient,
  workspaceId: string,
  repositoryId: string,
  branch: string
): Promise<RepoMirrorStateRow | null> {
  const { data, error } = await supabase
    .from('pk_repo_mirror_state')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('repository_id', repositoryId)
    .eq('sync_branch', branch)
    .maybeSingle()

  if (error || !data) return null
  return data as RepoMirrorStateRow
}

export async function upsertMirrorState(
  supabase: SupabaseClient,
  input: {
    workspaceId: string
    repositoryId: string
    syncBranch: string
    filesystemPath: string
    headCommitSha: string | null
    environment: string
    lastCloneJobId: string | null
    lastEmbedJobId?: string | null
  }
): Promise<void> {
  const env = input.environment === 'cloud' ? 'cloud' : 'local'
  const { error } = await supabase.from('pk_repo_mirror_state').upsert(
    {
      workspace_id: input.workspaceId,
      repository_id: input.repositoryId,
      sync_branch: input.syncBranch,
      filesystem_path: input.filesystemPath,
      head_commit_sha: input.headCommitSha,
      environment: env,
      last_clone_job_id: input.lastCloneJobId,
      last_embed_job_id: input.lastEmbedJobId ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'workspace_id,repository_id,sync_branch', ignoreDuplicates: false }
  )
  if (error) {
    throw new Error(`pk_repo_mirror_state upsert: ${error.message}`)
  }
}

export async function updateMirrorLastEmbedJob(
  supabase: SupabaseClient,
  workspaceId: string,
  repositoryId: string,
  branch: string,
  embedJobId: string
): Promise<void> {
  await supabase
    .from('pk_repo_mirror_state')
    .update({ last_embed_job_id: embedJobId, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('repository_id', repositoryId)
    .eq('sync_branch', branch)
}
