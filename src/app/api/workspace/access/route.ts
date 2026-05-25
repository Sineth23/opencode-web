import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

const querySchema = z.object({
  workspace_id: z.string().uuid(),
})

/**
 * Effective plan, integration visibility, and feature flags for the signed-in user in a workspace.
 */
export async function GET(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const parsed = querySchema.safeParse({ workspace_id: url.searchParams.get('workspace_id') })
  if (!parsed.success) {
    return NextResponse.json({ error: 'workspace_id (uuid) query required' }, { status: 400 })
  }

  const payload = await loadWorkspaceAccessForUser(supabase, userData.user.id, parsed.data.workspace_id)
  if (!payload) {
    return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 })
  }

  return NextResponse.json(payload)
}
