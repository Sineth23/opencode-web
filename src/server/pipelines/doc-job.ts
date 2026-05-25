import type { SupabaseClient } from '@supabase/supabase-js'
import { JobAbortRequestedError } from '@/server/pipelines/job-abort'
import {
  loadCodewikiDigestForRepoBranch,
  loadCodewikiDigestLatestForRepository,
  loadCodewikiDigestsForWorkspace,
} from '@/server/codewiki/load-digest'
import { generateDocSectionsFromSources } from '@/server/pipelines/doc-generation'
import {
  buildOperationalArtifactsInventory,
  generateOperationalDocsFromSources,
  normalizeOpsArtifactTitleKey,
  type OpsArtifactPlan,
} from '@/server/pipelines/doc-ops-generation'
import {
  buildDocumentationCoveragePlan,
  formatCoveragePlanForHandbook,
  formatCoveragePlanForOps,
  parseStoredCoveragePlan,
} from '@/server/pipelines/doc-coverage-plan'
import {
  parseBillingPlanForAi,
  resolveOrgAiSettings,
  sanitizeDocContentDepth,
  sanitizeDocTargetAudience,
} from '@/server/plans/org-ai-settings'
import { processUseCaseLibraryJob } from '@/server/pipelines/doc-use-case-job'

type JobMeta = {
  repository_id?: string
  branch?: string
  target_audience?: string
  content_depth?: string
  /** When set to `use_case_library`, only use-case guides are regenerated for the scope (see doc-use-case-job). */
  doc_job_profile?: string
  doc_ops_resume?: unknown
  doc_ops_checkpoint?: { artifact_plans?: OpsArtifactPlan[]; saved_at?: string }
  doc_coverage_plan?: unknown
}

function metaFlagTrue(v: unknown): boolean {
  return v === true || v === 1 || (typeof v === 'string' && ['true', '1'].includes(v.toLowerCase().trim()))
}

async function loadExistingOpsTitleKeysForDocScope(
  supabase: SupabaseClient,
  workspaceId: string,
  repoFilter: string | null,
  syncBranchStored: string
): Promise<Set<string>> {
  let q = supabase
    .from('pk_doc_sections')
    .select('title')
    .eq('workspace_id', workspaceId)
    .in('doc_archetype', ['policy', 'sop', 'playbook', 'feature_brief'])
  if (repoFilter) {
    q = q.eq('repository_id', repoFilter).eq('sync_branch', syncBranchStored)
  }
  const { data, error } = await q
  if (error) {
    throw new Error(`Could not load existing operational docs for this scope: ${error.message}`)
  }
  const set = new Set<string>()
  for (const row of data ?? []) {
    const t = (row as { title?: string }).title
    if (typeof t === 'string' && t.length) set.add(normalizeOpsArtifactTitleKey(t))
  }
  return set
}

export type DocGenerationJobOptions = {
  onProgress?: (message: string) => void
  /** When true, long-running steps exit so the worker can mark the job cancelled. */
  shouldAbort?: () => boolean
  /** Between operational articles, worker may request pause (job moves to `paused`). */
  shouldPause?: () => boolean
}

/**
 * Runs one pk_doc_generation_jobs row: load chunks (paginated), generate sections, replace pk_doc_sections for workspace.
 * Expects service-role Supabase client.
 */
export async function processDocGenerationJob(
  supabase: SupabaseClient,
  jobId: string,
  options?: DocGenerationJobOptions
): Promise<void> {
  const prog = options?.onProgress
  const shouldAbort = options?.shouldAbort
  const { data: job, error: jobErr } = await supabase
    .from('pk_doc_generation_jobs')
    .select('*')
    .eq('id', jobId)
    .single()

  if (jobErr || !job) {
    throw new Error(`Doc job ${jobId} not found: ${jobErr?.message}`)
  }

  const workspaceId = job.workspace_id as string
  const meta = (job.meta ?? {}) as JobMeta
  if (String(meta.doc_job_profile ?? '').trim() === 'use_case_library') {
    await processUseCaseLibraryJob(supabase, job, jobId, options)
    return
  }

  const resumeOps = metaFlagTrue(meta.doc_ops_resume)
  const checkpoint = meta.doc_ops_checkpoint
  const sourceSyncJobId = job.source_sync_job_id as string | null

  const { data: wsAi, error: wsAiErr } = await supabase
    .from('pk_workspaces')
    .select('name, billing_plan, org_ai_settings')
    .eq('id', workspaceId)
    .single()
  if (wsAiErr || !wsAi) {
    throw new Error(`Workspace ${workspaceId} not found: ${wsAiErr?.message}`)
  }
  const orgAi = resolveOrgAiSettings(parseBillingPlanForAi(wsAi.billing_plan as string), wsAi.org_ai_settings)
  const rowCap = orgAi.doc_max_chunk_rows

  prog?.(`Loading knowledge chunks (workspace ${workspaceId.slice(0, 8)}…)`)

  const repoFilter = typeof meta.repository_id === 'string' && meta.repository_id.length > 0 ? meta.repository_id : null
  const branchFilter = typeof meta.branch === 'string' && meta.branch.trim().length > 0 ? meta.branch.trim() : null
  /** Stored on rows: empty string means “all synced branches merged” for that repository. */
  const syncBranchStored = repoFilter ? (branchFilter ?? '') : ''

  /** Keyset pages via RPC: avoids OFFSET + full sort timeouts on large tables. */
  const pageSize = 500
  let afterSourcePath: string | null = null
  let afterId: string | null = null
  const chunkRows: {
    source_path: string
    body: string
    repository_id: string
    metadata: unknown
    sync_branch: string
    id: string
  }[] = []

  for (;;) {
    if (shouldAbort?.()) {
      throw new JobAbortRequestedError()
    }
    const { data, error: chunkErr } = await supabase.rpc('pk_fetch_doc_job_chunk_page', {
      p_workspace_id: workspaceId,
      p_repository_id: repoFilter,
      p_sync_branch: branchFilter,
      p_after_source_path: afterSourcePath,
      p_after_id: afterId,
      p_limit: pageSize,
    })
    if (chunkErr) {
      throw new Error(`Failed to load knowledge chunks: ${chunkErr.message}`)
    }
    const page = (data ?? []) as typeof chunkRows
    if (page.length === 0) break
    chunkRows.push(...page)
    if (afterSourcePath === null && chunkRows.length > 0) {
      prog?.(`Chunk pages: ${chunkRows.length} rows on first page (page size ${pageSize}, keyset)…`)
    }
    const last = page[page.length - 1]
    afterSourcePath = last.source_path
    afterId = last.id
    if (page.length < pageSize) break
    if (chunkRows.length >= rowCap) break
  }

  prog?.(`Chunk load done · ${chunkRows.length} rows (cap ${rowCap}${chunkRows.length >= rowCap ? ', truncated' : ''})`)

  if (shouldAbort?.()) {
    throw new JobAbortRequestedError()
  }

  const corpusSampled = chunkRows.length >= rowCap

  let rows = chunkRows
  if (sourceSyncJobId) {
    rows = rows.filter((r) => String((r.metadata as Record<string, unknown> | null)?.sync_job_id) === sourceSyncJobId)
  }

  if (rows.length === 0) {
    throw new Error(
      'No ingested content matches this documentation scope. Sync a repository (and branch) first, or widen scope.'
    )
  }

  const rawChunks = rows.map((r) => ({
    path: r.source_path as string,
    text: r.body as string,
  }))

  /** Workspace-wide jobs mix all repos; do not label the run from whichever chunk sorts first (misleading). */
  let repositoryName = 'All linked repositories (combined sources)'
  if (repoFilter) {
    const { data: link } = await supabase
      .from('pk_linked_repositories')
      .select('name, slug')
      .eq('id', repoFilter)
      .maybeSingle()
    if (link?.slug) {
      repositoryName = String(link.slug)
    }
  }

  const model = orgAi.doc_generation_model

  const metaAudience = sanitizeDocTargetAudience(
    typeof meta.target_audience === 'string' ? meta.target_audience : null
  )
  const metaDepth = sanitizeDocContentDepth(typeof meta.content_depth === 'string' ? meta.content_depth : null)
  const targetAudience = metaAudience ?? orgAi.doc_target_audience
  const contentDepth = metaDepth ?? orgAi.doc_content_depth

  if (!resumeOps) {
    prog?.(`Handbook · model ${model} · ${rows.length} chunks (16 core sections in two batches + optional depth pass)…`)
  } else {
    prog?.('Resume mode: skipping handbook regeneration (existing handbook rows kept).')
  }

  if (shouldAbort?.()) {
    throw new JobAbortRequestedError()
  }

  let codewiki: Awaited<ReturnType<typeof loadCodewikiDigestForRepoBranch>> = null
  if (repoFilter) {
    if (syncBranchStored === '') {
      codewiki = await loadCodewikiDigestLatestForRepository(supabase, workspaceId, repoFilter)
    } else {
      codewiki = await loadCodewikiDigestForRepoBranch(supabase, workspaceId, repoFilter, syncBranchStored)
      if (!codewiki) {
        codewiki = await loadCodewikiDigestLatestForRepository(supabase, workspaceId, repoFilter)
      }
    }
  } else {
    codewiki = await loadCodewikiDigestsForWorkspace(supabase, workspaceId)
  }

  if (shouldAbort?.()) {
    throw new JobAbortRequestedError()
  }

  const workspaceName = typeof wsAi.name === 'string' && wsAi.name.trim() ? wsAi.name.trim() : 'Workspace'

  let metaAcc: Record<string, unknown> = { ...((job.meta as Record<string, unknown> | null) ?? {}) }

  const persistJobMeta = async () => {
    const { error } = await supabase
      .from('pk_doc_generation_jobs')
      .update({ meta: metaAcc })
      .eq('id', jobId)
      .eq('status', 'running')
    if (error) {
      throw new Error(`Could not update doc job meta: ${error.message}`)
    }
  }

  let handbookCoverageBlock: string | null = null
  let opsCoverageBlock: string | null = null

  if (!resumeOps) {
    const plan = await buildDocumentationCoveragePlan({
      workspaceId,
      workspaceName,
      repositoryName,
      rawChunks,
      corpusSampled,
      totalChunkRowsScanned: rows.length,
      model,
      targetAudience,
      contentDepth,
      codewiki,
      shouldAbort,
      onProgress: prog,
    })
    if (plan) {
      metaAcc = { ...metaAcc, doc_coverage_plan: plan }
      await persistJobMeta()
      handbookCoverageBlock = formatCoveragePlanForHandbook(plan)
      opsCoverageBlock = formatCoveragePlanForOps(plan)
      prog?.('Coverage strategy planned and saved (steers handbook + operational inventory).')
    }
  } else {
    const reused = parseStoredCoveragePlan(metaAcc.doc_coverage_plan)
    if (reused) {
      opsCoverageBlock = formatCoveragePlanForOps(reused)
      prog?.('Resume: reusing stored coverage strategy for operational articles.')
    }
  }

  if (shouldAbort?.()) {
    throw new JobAbortRequestedError()
  }

  let sections: Awaited<ReturnType<typeof generateDocSectionsFromSources>> = []
  if (!resumeOps) {
    sections = await generateDocSectionsFromSources({
      workspaceId,
      workspaceName,
      handbookVoice: orgAi.handbook_voice,
      handbookDepthPass: orgAi.handbook_depth_pass,
      repositoryName,
      rawChunks,
      corpusSampled,
      totalChunkRowsScanned: rows.length,
      model,
      codewiki,
      targetAudience,
      contentDepth,
      coveragePlanPromptBlock: handbookCoverageBlock,
    })
    prog?.(`Handbook complete · ${sections.length} sections. Building operational inventory (no CodeWiki)…`)
  }

  if (shouldAbort?.()) {
    throw new JobAbortRequestedError()
  }

  let artifactPlans: OpsArtifactPlan[] = []
  if (resumeOps) {
    const plans = checkpoint?.artifact_plans
    if (!Array.isArray(plans) || plans.length === 0) {
      throw new Error(
        'doc_ops_resume is set but meta.doc_ops_checkpoint.artifact_plans is missing or empty. Re-queue a fresh job or restore checkpoint meta.'
      )
    }
    artifactPlans = plans
    prog?.(`Resume: loaded ${artifactPlans.length} artifact plans from job checkpoint.`)
  } else {
    artifactPlans = await buildOperationalArtifactsInventory({
      workspaceId,
      workspaceName,
      handbookVoice: orgAi.handbook_voice,
      repositoryName,
      rawChunks,
      corpusSampled,
      totalChunkRowsScanned: rows.length,
      model,
      targetAudience,
      contentDepth,
      shouldAbort,
      onProgress: prog,
      coveragePlanPromptBlock: opsCoverageBlock,
    })
    if (artifactPlans.length > 0) {
      metaAcc = {
        ...metaAcc,
        doc_ops_checkpoint: {
          artifact_plans: artifactPlans,
          saved_at: new Date().toISOString(),
        },
      }
      await persistJobMeta()
      prog?.(`Checkpoint saved · ${artifactPlans.length} operational artifact plans in job meta.`)
    }
  }

  if (shouldAbort?.()) {
    throw new JobAbortRequestedError()
  }

  if (!resumeOps) {
    let del = supabase.from('pk_doc_sections').delete().eq('workspace_id', workspaceId)
    if (repoFilter) {
      del = del.eq('repository_id', repoFilter).eq('sync_branch', syncBranchStored)
    }
    const { error: delErr } = await del
    if (delErr) {
      throw new Error(`Could not clear old documentation sections for this scope: ${delErr.message}`)
    }

    const handbookRows = sections.map((s) => ({
      workspace_id: workspaceId,
      repository_id: repoFilter,
      sync_branch: syncBranchStored,
      target_audience: targetAudience,
      content_depth: contentDepth,
      generation_model: model,
      category: s.category,
      title: s.title,
      summary: s.summary,
      body_md: s.bodyMd,
      source_paths: s.sourcePaths.length > 0 ? s.sourcePaths : null,
      updated_at: new Date().toISOString(),
      doc_archetype: 'handbook' as const,
    }))
    const { error: insHErr } = await supabase.from('pk_doc_sections').insert(handbookRows)
    if (insHErr) {
      throw new Error(`Could not save handbook sections: ${insHErr.message}`)
    }
    prog?.(`Inserted ${sections.length} handbook sections. Streaming operational articles to the database…`)
  } else {
    prog?.('Resume: skipped scope delete and handbook insert; appending missing operational articles.')
  }

  const skipTitleKeys = await loadExistingOpsTitleKeysForDocScope(supabase, workspaceId, repoFilter, syncBranchStored)

  const opsSections = await generateOperationalDocsFromSources({
    workspaceId,
    workspaceName,
    handbookVoice: orgAi.handbook_voice,
    repositoryName,
    rawChunks,
    corpusSampled,
    totalChunkRowsScanned: rows.length,
    model,
    targetAudience,
    contentDepth,
    shouldAbort,
    shouldPause: options?.shouldPause,
    onProgress: prog,
    coveragePlanPromptBlock: opsCoverageBlock,
    artifactPlansOverride: artifactPlans,
    skipTitleKeys,
    onOperationalDocReady: async (s) => {
      const row = {
        workspace_id: workspaceId,
        repository_id: repoFilter,
        sync_branch: syncBranchStored,
        target_audience: targetAudience,
        content_depth: contentDepth,
        generation_model: model,
        category: s.category,
        title: s.title,
        summary: s.summary,
        body_md: s.bodyMd,
        source_paths: s.sourcePaths.length > 0 ? s.sourcePaths : null,
        updated_at: new Date().toISOString(),
        doc_archetype: s.archetype,
      }
      const { error: oneErr } = await supabase.from('pk_doc_sections').insert([row])
      if (oneErr) {
        throw new Error(`Could not save operational doc "${s.title.slice(0, 80)}": ${oneErr.message}`)
      }
    },
  })

  prog?.(
    resumeOps
      ? `Resume complete · streamed ${opsSections.length} operational articles (skipped titles already on disk).`
      : `Job storage complete · ${sections.length} handbook + ${opsSections.length} operational articles (ops saved as each finished).`
  )

  const doneMeta: Record<string, unknown> = { ...metaAcc }
  delete doneMeta.cancel_requested
  delete doneMeta.pause_requested
  delete doneMeta.doc_ops_checkpoint
  delete doneMeta.doc_ops_resume

  await supabase
    .from('pk_doc_generation_jobs')
    .update({
      status: 'succeeded',
      completed_at: new Date().toISOString(),
      error_message: null,
      meta: doneMeta,
    })
    .eq('id', jobId)
    .eq('status', 'running')
}
