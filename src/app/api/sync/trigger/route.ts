import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient, createServiceRoleClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'
import { userFacingBitbucketOrSyncError } from '@/lib/bitbucket-user-errors'
import { BitbucketCloudClient } from '@/server/integrations/bitbucket/client'
import { resolveBitbucketApiCredentials } from '@/server/integrations/bitbucket/auth-resolve'
import { describeIngestionPlan } from '@/server/pipelines/ingestion'
import { matchesLocalWorkingCopyAllowPrefixes } from '@/server/pipelines/local-working-copy'

const bodySchema = z
  .object({
    workspace_id: z.string().uuid(),
    repository_id: z.string().uuid().optional(),
    bitbucket_workspace: z.string().min(1).optional(),
    repo_slug: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    /**
     * When true with a saved `repository_id`, lists all branches from Bitbucket and queues one sync job per branch
     * (respects PK_SYNC_ALL_BRANCHES_MAX). Incompatible with `local_working_copy_abs_path`.
     */
    sync_all_branches: z.boolean().optional(),
    /**
     * With a saved `repository_id`, queue one job per listed branch (no Bitbucket list call). Mutually exclusive with
     * `sync_all_branches`. Same per-run cap as sync-all.
     */
    branch_names: z.array(z.string().min(1)).max(500).optional(),
    /** When true, worker wipes this branch’s vectors before re-indexing (slower; use for corruption or major refactors). */
    full_reindex: z.boolean().optional(),
    /**
     * Dev/local: absolute path to an existing git clone (branch at HEAD should match sync branch).
     * Requires PK_ALLOW_LOCAL_WORKING_COPY=1 and PK_LOCAL_WORKING_COPY_ALLOW_PREFIXES on the worker host.
     */
    local_working_copy_abs_path: z.string().min(1).optional(),
    /** Tag for job meta: local workstation vs cloud worker (informational). */
    mirror_environment: z.enum(['local', 'cloud']).optional(),
    /** full = one job (default); clone_only = Bitbucket → disk only; embed_only = embeddings from last prepared mirror; codewiki_only = structure graph + overview from mirror only (no vectors). */
    pipeline: z.enum(['full', 'clone_only', 'embed_only', 'codewiki_only']).optional(),
  })
  .superRefine((val, ctx) => {
    const pipe = val.pipeline ?? 'full'
    if (val.sync_all_branches && !val.repository_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'Sync all branches requires a saved linked repository (repository_id).',
        path: ['repository_id'],
      })
    }
    if (val.sync_all_branches && val.local_working_copy_abs_path?.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: 'Sync all branches cannot be combined with a local working copy path.',
        path: ['local_working_copy_abs_path'],
      })
    }
    const bn = val.branch_names?.map((b) => b.trim()).filter(Boolean) ?? []
    if (bn.length > 0 && !val.repository_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'Choosing multiple branches requires a saved linked repository.',
        path: ['repository_id'],
      })
    }
    if (bn.length > 0 && val.sync_all_branches) {
      ctx.addIssue({
        code: 'custom',
        message: 'Use either “sync all branches” or an explicit branch list, not both.',
        path: ['branch_names'],
      })
    }
    if (bn.length > 0 && val.local_working_copy_abs_path?.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: 'Multiple branches cannot be combined with a local working copy path.',
        path: ['local_working_copy_abs_path'],
      })
    }
    if ((pipe === 'clone_only' || pipe === 'embed_only' || pipe === 'codewiki_only') && !val.repository_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'Prepare clone and Index & embed require a saved linked repository (pick it in the list first).',
        path: ['repository_id'],
      })
    }
    if (!val.repository_id && (!val.bitbucket_workspace?.trim() || !val.repo_slug?.trim())) {
      ctx.addIssue({
        code: 'custom',
        message: 'Choose a saved repository, or enter Bitbucket workspace and repository.',
      })
    }
  })

/**
 * Creates a sync job row and returns job id. Actual ingestion runs in a worker that reads pk_sync_jobs.
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

  const payload = parsed.data

  let resolvedRepoId: string | null = payload.repository_id ?? null
  let bitbucketWorkspace = payload.bitbucket_workspace?.trim() ?? ''
  let repoSlug = payload.repo_slug?.trim() ?? ''
  let branch = payload.branch?.trim() || 'main'

  if (payload.repository_id) {
    const { data: row, error: rowErr } = await supabase
      .from('pk_linked_repositories')
      .select('id, bitbucket_workspace, slug, default_branch')
      .eq('id', payload.repository_id)
      .eq('workspace_id', payload.workspace_id)
      .single()

    if (rowErr || !row) {
      return NextResponse.json({ error: 'That repository is not linked to this workspace.' }, { status: 404 })
    }
    resolvedRepoId = row.id as string
    bitbucketWorkspace = row.bitbucket_workspace as string
    repoSlug = row.slug as string
    branch = payload.branch?.trim() || (row.default_branch as string) || 'main'
  }

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, payload.workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 })
  }
  if (!access.workspace.allowed_integration_slugs.includes('bitbucket')) {
    return NextResponse.json(
      { error: 'Sync from Bitbucket is not enabled for your organization. Contact support to upgrade your plan.' },
      { status: 403 }
    )
  }
  if (!access.effective_features.trigger_sync) {
    return NextResponse.json(
      {
        error:
          'You do not have permission to queue sync jobs. Ask an organization admin or contact support to grant sync access.',
      },
      { status: 403 }
    )
  }

  const pipeline = payload.pipeline ?? 'full'
  const syncAllBranches = payload.sync_all_branches === true
  const explicitBranchNames = [...new Set((payload.branch_names ?? []).map((b) => b.trim()).filter(Boolean))]

  const localPath = payload.local_working_copy_abs_path?.trim()
  if (localPath) {
    if (process.env.PK_ALLOW_LOCAL_WORKING_COPY !== '1') {
      return NextResponse.json(
        { error: 'Local working copy path is not enabled (set PK_ALLOW_LOCAL_WORKING_COPY=1 on the server).' },
        { status: 400 }
      )
    }
    if (!matchesLocalWorkingCopyAllowPrefixes(localPath)) {
      return NextResponse.json(
        {
          error:
            'Local path is not under an allowed prefix. Set PK_LOCAL_WORKING_COPY_ALLOW_PREFIXES (e.g. C:\\\\repos|D:\\\\code). The worker host must contain this folder.',
        },
        { status: 400 }
      )
    }
  }

  const rawMaxBranches = Number(process.env.PK_SYNC_ALL_BRANCHES_MAX ?? '150')
  const maxBranchesPerRequest = Number.isFinite(rawMaxBranches)
    ? Math.min(500, Math.max(1, Math.floor(rawMaxBranches)))
    : 150

  if (explicitBranchNames.length > 0) {
    if (!resolvedRepoId) {
      return NextResponse.json({ error: 'Choosing multiple branches requires a linked repository.' }, { status: 400 })
    }
    if (explicitBranchNames.length > maxBranchesPerRequest) {
      return NextResponse.json(
        {
          error: `You can queue at most ${maxBranchesPerRequest} branches in one request. Deselect some branches and run again, or queue another batch after these finish.`,
          max_branches: maxBranchesPerRequest,
        },
        { status: 400 }
      )
    }

    const rows = explicitBranchNames.map((br) => {
      const st = describeIngestionPlan({
        workspaceId: payload.workspace_id,
        repositoryId: resolvedRepoId ?? undefined,
        bitbucketWorkspace,
        repoSlug,
        branch: br,
      })
      return {
        workspace_id: payload.workspace_id,
        repository_id: resolvedRepoId,
        requested_by: userData.user.id,
        status: 'queued' as const,
        branch: br,
        meta: {
          stages: st,
          bitbucket_workspace: bitbucketWorkspace,
          repo_slug: repoSlug,
          pipeline,
          explicit_branch_pick_batch: true,
          ...(payload.full_reindex === true ? { full_reindex: true } : {}),
        },
      }
    })

    const { data: jobs, error: insErr2 } = await supabase.from('pk_sync_jobs').insert(rows).select('id')
    if (insErr2) {
      console.error('pk_sync_jobs bulk insert (branch_names)', insErr2)
      return NextResponse.json({ error: insErr2.message }, { status: 500 })
    }
    const jobIds = (jobs ?? []).map((j) => j.id as string)
    return NextResponse.json({
      job_ids: jobIds,
      branches_queued: jobIds.length,
      branches_total_found: explicitBranchNames.length,
      branches_truncated: false,
      max_branches: maxBranchesPerRequest,
      status: 'queued',
      message: `Queued ${jobIds.length} sync job(s) (one per branch).`,
    })
  }

  if (syncAllBranches) {
    if (!resolvedRepoId) {
      return NextResponse.json({ error: 'Sync all branches requires a linked repository.' }, { status: 400 })
    }
    const admin = createServiceRoleClient()
    if (!admin) {
      return NextResponse.json({ error: 'Server misconfigured (service role).' }, { status: 500 })
    }
    let creds: { accessToken: string; basicAuthUsername: string | null }
    try {
      creds = await resolveBitbucketApiCredentials(admin, payload.workspace_id)
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Bitbucket is not connected'
      return NextResponse.json({ error: userFacingBitbucketOrSyncError(raw) }, { status: 400 })
    }
    const bbClient = new BitbucketCloudClient({
      accessToken: creds.accessToken,
      basicAuthUsername: creds.basicAuthUsername,
    })
    let branchNames: string[] = []
    try {
      branchNames = await bbClient.listBranchNames(bitbucketWorkspace, repoSlug)
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Bitbucket branch list failed'
      return NextResponse.json({ error: userFacingBitbucketOrSyncError(raw) }, { status: 502 })
    }
    const unique = [...new Set(branchNames.map((b) => b.trim()).filter(Boolean))]
    if (unique.length === 0) {
      return NextResponse.json({ error: 'No branches returned from Bitbucket for this repository.' }, { status: 400 })
    }
    const maxBranches = maxBranchesPerRequest
    const { data: linkRow } = await supabase
      .from('pk_linked_repositories')
      .select('default_branch')
      .eq('id', resolvedRepoId)
      .eq('workspace_id', payload.workspace_id)
      .maybeSingle()
    const defBr = ((linkRow?.default_branch as string) || 'main').trim() || 'main'
    unique.sort((a, b) => {
      if (a === defBr) return -1
      if (b === defBr) return 1
      return a.localeCompare(b)
    })
    const truncated = unique.length > maxBranches
    const chosen = unique.slice(0, maxBranches)

    const rows = chosen.map((br) => {
      const st = describeIngestionPlan({
        workspaceId: payload.workspace_id,
        repositoryId: resolvedRepoId ?? undefined,
        bitbucketWorkspace,
        repoSlug,
        branch: br,
      })
      return {
        workspace_id: payload.workspace_id,
        repository_id: resolvedRepoId,
        requested_by: userData.user.id,
        status: 'queued' as const,
        branch: br,
        meta: {
          stages: st,
          bitbucket_workspace: bitbucketWorkspace,
          repo_slug: repoSlug,
          pipeline,
          sync_all_branches_batch: true,
          ...(payload.full_reindex === true ? { full_reindex: true } : {}),
        },
      }
    })

    const { data: jobs, error: insErr } = await supabase.from('pk_sync_jobs').insert(rows).select('id')
    if (insErr) {
      console.error('pk_sync_jobs bulk insert', insErr)
      return NextResponse.json({ error: insErr.message }, { status: 500 })
    }
    const jobIds = (jobs ?? []).map((j) => j.id as string)
    return NextResponse.json({
      job_ids: jobIds,
      branches_queued: jobIds.length,
      branches_total_found: unique.length,
      branches_truncated: truncated,
      max_branches: maxBranches,
      status: 'queued',
      message: `Queued ${jobIds.length} sync job(s) (one per branch).`,
    })
  }

  const stages = describeIngestionPlan({
    workspaceId: payload.workspace_id,
    repositoryId: resolvedRepoId ?? undefined,
    bitbucketWorkspace,
    repoSlug,
    branch,
  })

  const { data: job, error } = await supabase
    .from('pk_sync_jobs')
    .insert({
      workspace_id: payload.workspace_id,
      repository_id: resolvedRepoId,
      requested_by: userData.user.id,
      status: 'queued',
      branch,
      meta: {
        stages,
        bitbucket_workspace: bitbucketWorkspace,
        repo_slug: repoSlug,
        pipeline,
        ...(payload.full_reindex === true ? { full_reindex: true } : {}),
        ...(localPath
          ? {
              local_working_copy_abs_path: localPath,
              mirror_environment: payload.mirror_environment ?? 'local',
            }
          : {}),
      },
    })
    .select('id')
    .single()

  if (error) {
    console.error('pk_sync_jobs insert', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    job_id: job.id,
    status: 'queued',
    message: 'Your sync has been queued and will run in the background.',
  })
}
