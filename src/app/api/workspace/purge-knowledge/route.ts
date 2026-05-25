import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient, createServiceRoleClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'
import { purgeWorkspaceKnowledge } from '@/server/workspace/purge-workspace-knowledge'

/** Large chunk tables can take several minutes to purge. */
export const maxDuration = 300

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  /** Must match the workspace name exactly (after trim on both sides). */
  confirm_workspace_name: z.string().min(1),
})

/**
 * Workspace owners and admins only. Irreversibly deletes generated/indexed data for the workspace.
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

  const { workspace_id, confirm_workspace_name } = parsed.data

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 })
  }

  if (access.role !== 'owner' && access.role !== 'admin') {
    return NextResponse.json(
      { error: 'Only workspace owners and admins can erase generated knowledge.' },
      { status: 403 },
    )
  }

  const expectedName = access.workspace.name.trim()
  if (confirm_workspace_name.trim() !== expectedName) {
    return NextResponse.json(
      { error: 'Confirmation does not match the workspace name. Type the name exactly as shown in the header.' },
      { status: 400 },
    )
  }

  const db = createServiceRoleClient()
  if (!db) {
    return NextResponse.json({ error: 'Service role not configured' }, { status: 503 })
  }

  try {
    await purgeWorkspaceKnowledge(db, workspace_id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('purgeWorkspaceKnowledge', workspace_id, msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    detail:
      'All indexed sources, guided documentation, repository overview artifacts, assistant chat history, sync and documentation job history, and usage counters for this workspace have been removed. Saved repository links and your Bitbucket connection are unchanged: run a new sync when you are ready.',
  })
}
