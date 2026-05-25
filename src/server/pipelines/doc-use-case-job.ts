import type { SupabaseClient } from '@supabase/supabase-js'
import { JobAbortRequestedError } from '@/server/pipelines/job-abort'
import {
  loadCodewikiDigestForRepoBranch,
  loadCodewikiDigestLatestForRepository,
  loadCodewikiDigestsForWorkspace,
} from '@/server/codewiki/load-digest'
import { generateUseCaseDocsFromSources } from '@/server/pipelines/doc-use-case-generation'
import {
  buildDocumentationCoveragePlan,
  formatCoveragePlanForOps,
  parseStoredCoveragePlan,
} from '@/server/pipelines/doc-coverage-plan'
import {
  parseBillingPlanForAi,
  resolveOrgAiSettings,
  sanitizeDocContentDepth,
  sanitizeDocTargetAudience,
} from '@/server/plans/org-ai-settings'
import type { DocGenerationJobOptions } from '@/server/pipelines/doc-job'

type JobMeta = {
  repository_id?: string
  branch?: string
  target_audience?: string
  content_depth?: string
  doc_job_profile?: string
  doc_coverage_plan?: unknown
}

/**
 * Use-case library job: replaces only `doc_archetype = use_case` for the job scope.
 * Does not touch handbook, policies, SOPs, playbooks, or feature briefs.
 *
 * Chunk loading mirrors `processDocGenerationJob` — keep in sync when that path changes.
 */
export async function processUseCaseLibraryJob(
  supabase: SupabaseClient,
  job: { id: string; workspace_id: string; meta: unknown; source_sync_job_id: string | null },
  jobId: string,
  options?: DocGenerationJobOptions
): Promise<void> {
  const prog = options?.onProgress
  const shouldAbort = options?.shouldAbort
  const shouldPause = options?.shouldPause

  const workspaceId = job.workspace_id as string
  const meta = (job.meta ?? {}) as JobMeta
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

  prog?.(`Use-case library · loading knowledge chunks (workspace ${workspaceId.slice(0, 8)}…)`)

  const repoFilter = typeof meta.repository_id === 'string' && meta.repository_id.length > 0 ? meta.repository_id : null
  const branchFilter = typeof meta.branch === 'string' && meta.branch.trim().length > 0 ? meta.branch.trim() : null
  const syncBranchStored = repoFilter ? (branchFilter ?? '') : ''

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

  let opsCoverageBlock: string | null = null
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
    opsCoverageBlock = formatCoveragePlanForOps(plan)
    prog?.('Coverage strategy planned (steers use-case inventory).')
  } else {
    const reused = parseStoredCoveragePlan(metaAcc.doc_coverage_plan)
    if (reused) {
      opsCoverageBlock = formatCoveragePlanForOps(reused)
      prog?.('Reusing stored coverage strategy for use-case inventory.')
    }
  }

  if (shouldAbort?.()) {
    throw new JobAbortRequestedError()
  }

  prog?.(`Use-case library · model ${model} · ${rows.length} chunks · clearing prior use-case articles for this scope only…`)

  {
    let del = supabase.from('pk_doc_sections').delete().eq('workspace_id', workspaceId).eq('doc_archetype', 'use_case')
    if (repoFilter) {
      del = del.eq('repository_id', repoFilter).eq('sync_branch', syncBranchStored)
    } else {
      del = del.is('repository_id', null).eq('sync_branch', '')
    }
    const { error: delErr } = await del
    if (delErr) {
      throw new Error(`Could not clear prior use-case guides for this scope: ${delErr.message}`)
    }
  }

  const sections = await generateUseCaseDocsFromSources({
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
    shouldPause,
    onProgress: prog,
    coveragePlanPromptBlock: opsCoverageBlock,
    onUseCaseDocReady: async (s) => {
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
        doc_archetype: 'use_case' as const,
      }
      const { error: oneErr } = await supabase.from('pk_doc_sections').insert([row])
      if (oneErr) {
        throw new Error(`Could not save use-case guide "${s.title.slice(0, 80)}": ${oneErr.message}`)
      }
    },
  })

  prog?.(`Use-case library complete · ${sections.length} guides saved for this scope.`)

  const doneMeta: Record<string, unknown> = { ...metaAcc }
  delete doneMeta.cancel_requested
  delete doneMeta.pause_requested

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
