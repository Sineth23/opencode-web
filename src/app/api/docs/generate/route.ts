import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  sync_job_id: z.string().uuid().optional(),
  /** Optional: generate from one linked repository’s chunks only. */
  repository_id: z.string().uuid().optional(),
  /** Optional: with repository_id, limit to this ingested branch (sync_branch). */
  branch: z.string().max(200).optional(),
  /** Optional: overrides org default `doc_target_audience` for this job only. */
  target_audience: z.string().min(1).max(180).optional(),
  /** Optional: overrides org default `doc_content_depth` for this job only. */
  content_depth: z.enum(['overview', 'standard', 'deep']).optional(),
})

/**
 * Queues or runs documentation generation from latest ingested sources.
 * MVP: records intent; implement with worker calling generateDocSectionsFromSources.
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

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, parsed.data.workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 })
  }
  if (!access.effective_features.queue_doc_refresh) {
    return NextResponse.json(
      {
        error:
          'You do not have permission to queue documentation refresh. Ask an organization admin or contact support.',
      },
      { status: 403 }
    )
  }

  const meta: Record<string, string> = {}
  if (parsed.data.repository_id) meta.repository_id = parsed.data.repository_id
  if (parsed.data.branch?.trim()) meta.branch = parsed.data.branch.trim()
  if (parsed.data.target_audience?.trim()) meta.target_audience = parsed.data.target_audience.trim()
  if (parsed.data.content_depth) meta.content_depth = parsed.data.content_depth

  const { error } = await supabase.from('pk_doc_generation_jobs').insert({
    workspace_id: parsed.data.workspace_id,
    requested_by: userData.user.id,
    status: 'queued',
    source_sync_job_id: parsed.data.sync_job_id ?? null,
    meta: Object.keys(meta).length > 0 ? meta : {},
  })

  if (error) {
    console.error('pk_doc_generation_jobs insert', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const scoped = Boolean(parsed.data.repository_id || parsed.data.branch?.trim())
  return NextResponse.json({
    status: 'queued',
    detail: scoped
      ? 'Documentation refresh has been queued for the selected repository (and branch, if chosen). When it completes, only that scope’s saved articles are replaced; workspace-wide docs and other repositories are left as-is. Open Documentation and pick that scope to read them.'
      : 'Documentation refresh has been queued for the whole workspace. When it completes, only workspace-wide documentation (the “All organization” scope) is replaced. Per-repository docs are unchanged. Keep the background worker running so the job can finish.',
  })
}
