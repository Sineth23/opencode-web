import type { SupabaseClient } from '@supabase/supabase-js'
import { isCodewikiEnabled, runCodewikiCliOnSourceTree } from '@/server/codewiki/codewiki-process'
import { clearSnapshotCheckpointDir } from '@/server/codewiki/snapshot-checkpoint'

export type SourceSnapshotFile = { path: string; content: string }

/**
 * After a successful Bitbucket sync, run the holistic overview step on the same file snapshot and persist `./docs` output.
 * Failures are recorded but do not fail the sync job.
 *
 * @returns `true` if CodeWiki ran and persisted successfully (or was disabled / had nothing to do); `false` if it failed or could not insert the run row.
 */
export async function runCodewikiAfterBitbucketSync(
  supabase: SupabaseClient,
  input: {
    workspaceId: string
    repositoryId: string
    syncBranch: string
    sourceSyncJobId: string
    repoSlug: string
    snapshotFiles: SourceSnapshotFile[]
    onProgress?: (message: string) => void
    /** When set and the overview succeeds, this directory is removed (CodeWiki-only snapshot resume cache). */
    snapshotCheckpointDirToClear?: string
  }
): Promise<boolean> {
  if (!isCodewikiEnabled()) {
    return true
  }

  const unique = new Map<string, string>()
  for (const f of input.snapshotFiles) {
    const p = f.path.replace(/^\/+/, '')
    if (p && !p.includes('..')) unique.set(p, f.content)
  }
  const files = [...unique.entries()].map(([path, content]) => ({ path, content }))
  if (files.length === 0) {
    return true
  }

  const { data: runRow, error: insErr } = await supabase
    .from('pk_codewiki_runs')
    .insert({
      workspace_id: input.workspaceId,
      repository_id: input.repositoryId,
      sync_branch: input.syncBranch,
      source_sync_job_id: input.sourceSyncJobId,
      status: 'running',
      meta: { source_file_count: files.length, repo_slug: input.repoSlug },
    })
    .select('id')
    .single()

  if (insErr || !runRow?.id) {
    console.error('pk_codewiki_runs insert', insErr)
    return false
  }

  const runId = runRow.id as string

  try {
    input.onProgress?.(`CodeWiki: starting overview run (${files.length} unique source files)…`)
    const result = await runCodewikiCliOnSourceTree({
      files,
      repoSlug: input.repoSlug,
      onProgress: input.onProgress,
    })

    if (!result.ok) {
      await supabase
        .from('pk_codewiki_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: (result.stderr || `exit ${result.exitCode}`).slice(0, 2000),
          meta: {
            source_file_count: files.length,
            repo_slug: input.repoSlug,
            stdout_tail: result.stdout.slice(0, 4000),
            stderr_tail: result.stderr.slice(0, 4000),
          },
        })
        .eq('id', runId)
      console.error('Repository overview step failed', input.repositoryId, result.stderr?.slice(0, 500))
      return false
    }

    if (result.artifacts.length === 0) {
      await supabase
        .from('pk_codewiki_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: 'Repository overview produced no files under docs/',
        })
        .eq('id', runId)
      return false
    }

    const rows = result.artifacts.map((a) => ({
      run_id: runId,
      path: a.path,
      content: a.content,
    }))

    const chunkSize = 40
    input.onProgress?.(`CodeWiki: saving ${rows.length} artifact file(s) to database…`)
    for (let i = 0; i < rows.length; i += chunkSize) {
      const slice = rows.slice(i, i + chunkSize)
      const { error: fErr } = await supabase.from('pk_codewiki_files').insert(slice)
      if (fErr) {
        throw new Error(fErr.message)
      }
    }

    await supabase
      .from('pk_codewiki_runs')
      .update({
        status: 'succeeded',
        completed_at: new Date().toISOString(),
        error_message: null,
        meta: {
          source_file_count: files.length,
          artifact_count: result.artifacts.length,
          repo_slug: input.repoSlug,
          artifact_paths: result.artifacts.map((a) => a.path).slice(0, 200),
          ...(typeof result.partial_cli_exit === 'number'
            ? { partial_codewiki_cli_exit: result.partial_cli_exit }
            : {}),
        },
      })
      .eq('id', runId)

    if (input.snapshotCheckpointDirToClear) {
      clearSnapshotCheckpointDir(input.snapshotCheckpointDirToClear)
    }

    const { data: oldRuns } = await supabase
      .from('pk_codewiki_runs')
      .select('id')
      .eq('workspace_id', input.workspaceId)
      .eq('repository_id', input.repositoryId)
      .eq('sync_branch', input.syncBranch)
      .eq('status', 'succeeded')
      .neq('id', runId)

    for (const r of oldRuns ?? []) {
      await supabase.from('pk_codewiki_runs').delete().eq('id', r.id as string)
    }

    input.onProgress?.('CodeWiki: overview completed successfully.')
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await supabase
      .from('pk_codewiki_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: msg.slice(0, 2000),
      })
      .eq('id', runId)
    console.error('Repository overview persist error', e)
    return false
  }
}
