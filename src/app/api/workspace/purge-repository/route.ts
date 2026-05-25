import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { createRouteHandlerClient, createServiceRoleClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'
import { purgeRepositoryKnowledge } from '@/server/workspace/purge-repository-knowledge'

/** Large chunk tables can take several minutes to purge. */
export const maxDuration = 300

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  repository_id: z.string().uuid(),
  /** Must match the linked repository slug (Bitbucket project slug) exactly after trim. */
  confirm_repository_slug: z.string().min(1),
  /** When true, delete the saved repository link after clearing data. */
  remove_link: z.boolean().optional().default(false),
})

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

  const { workspace_id, repository_id, confirm_repository_slug, remove_link } = parsed.data

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 })
  }

  if (access.role !== 'owner' && access.role !== 'admin') {
    return NextResponse.json(
      { error: 'Only workspace owners and admins can remove repository data.' },
      { status: 403 },
    )
  }

  const { data: row, error: rowErr } = await supabase
    .from('pk_linked_repositories')
    .select('slug')
    .eq('id', repository_id)
    .eq('workspace_id', workspace_id)
    .maybeSingle()

  if (rowErr) {
    return NextResponse.json({ error: rowErr.message }, { status: 500 })
  }
  if (!row?.slug) {
    return NextResponse.json({ error: 'Repository not found.' }, { status: 404 })
  }

  if (confirm_repository_slug.trim() !== String(row.slug).trim()) {
    return NextResponse.json(
      { error: 'Confirmation does not match this repository’s slug. Copy the slug from the list exactly.' },
      { status: 400 },
    )
  }

  const db = createServiceRoleClient()
  if (!db) {
    return NextResponse.json({ error: 'Service role not configured' }, { status: 503 })
  }

  try {
    await purgeRepositoryKnowledge(db, {
      workspaceId: workspace_id,
      repositoryId: repository_id,
      removeLink: remove_link,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('purgeRepositoryKnowledge', workspace_id, repository_id, msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    detail: remove_link
      ? 'All indexed content, handbook articles, repository overview, jobs, and mirror state for this project were removed, and the saved repository link was deleted. Re-add the project under Integrations when you are ready.'
      : 'All indexed content, handbook articles, repository overview, jobs, and mirror state for this project were removed. The saved repository link remains (last sync cleared); run a new sync to rebuild.',
  })
}
