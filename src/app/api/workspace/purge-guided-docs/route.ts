import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { createRouteHandlerClient, createServiceRoleClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'
import { PURGE_GUIDED_DOCS_CONFIRM_PHRASE } from '@/lib/purge-guided-confirm'
import { purgeGuidedDocumentation } from '@/server/workspace/purge-guided-docs'

export const maxDuration = 120

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  confirm_phrase: z.string().min(1),
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

  const { workspace_id, confirm_phrase } = parsed.data

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 })
  }

  if (access.role !== 'owner' && access.role !== 'admin') {
    return NextResponse.json(
      { error: 'Only workspace owners and admins can remove guided documentation.' },
      { status: 403 },
    )
  }

  if (confirm_phrase.trim() !== PURGE_GUIDED_DOCS_CONFIRM_PHRASE) {
    return NextResponse.json(
      {
        error: `Type the phrase "${PURGE_GUIDED_DOCS_CONFIRM_PHRASE}" exactly to confirm.`,
      },
      { status: 400 },
    )
  }

  const db = createServiceRoleClient()
  if (!db) {
    return NextResponse.json({ error: 'Service role not configured' }, { status: 503 })
  }

  try {
    await purgeGuidedDocumentation(db, workspace_id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('purgeGuidedDocumentation', workspace_id, msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    detail:
      'All guided handbook articles for this workspace have been removed from the database. Indexed code chunks and your repository links are unchanged: run a documentation refresh when you want new articles.',
  })
}
