import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkPlatformAdmin } from '@/server/admin/require-platform-admin'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  sync_job_id: z.string().uuid().optional(),
  repository_id: z.string().uuid().optional(),
  branch: z.string().max(200).optional(),
  target_audience: z.string().min(1).max(180).optional(),
  content_depth: z.enum(['overview', 'standard', 'deep']).optional(),
})

/**
 * Queues a job that only regenerates **use-case specific** documentation for the chosen scope.
 * Does not replace the engineering handbook or other operational archetypes.
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

  const { platformAdmin } = await checkPlatformAdmin(request)
  if (!platformAdmin) {
    return NextResponse.json(
      {
        error:
          'Only AutoDoc platform operators can queue use-case library generation. Contact support if you need this for your workspace.',
      },
      { status: 403 }
    )
  }

  const meta: Record<string, string> = { doc_job_profile: 'use_case_library' }
  if (parsed.data.repository_id) meta.repository_id = parsed.data.repository_id
  if (parsed.data.branch?.trim()) meta.branch = parsed.data.branch.trim()
  if (parsed.data.target_audience?.trim()) meta.target_audience = parsed.data.target_audience.trim()
  if (parsed.data.content_depth) meta.content_depth = parsed.data.content_depth

  const { error } = await supabase.from('pk_doc_generation_jobs').insert({
    workspace_id: parsed.data.workspace_id,
    requested_by: userData.user.id,
    status: 'queued',
    source_sync_job_id: parsed.data.sync_job_id ?? null,
    meta,
  })

  if (error) {
    console.error('pk_doc_generation_jobs insert (use-case library)', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const scoped = Boolean(parsed.data.repository_id || parsed.data.branch?.trim())
  return NextResponse.json({
    status: 'queued',
    detail: scoped
      ? 'Use-case library generation is queued for the selected repository (and branch, if chosen). When it finishes, only that scope’s use-case guides are replaced; handbooks, policies, SOPs, playbooks, and feature briefs stay as they are. Keep the background worker running.'
      : 'Use-case library generation is queued for workspace-wide scope. When it finishes, only workspace-wide use-case guides are replaced; other documentation is unchanged. Keep the background worker running.',
  })
}
