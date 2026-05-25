import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

const querySchema = z.object({
  workspace_id: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

/**
 * Recent documentation generation jobs for Sync center.
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

  const sp = request.nextUrl.searchParams
  const parsed = querySchema.safeParse({
    workspace_id: sp.get('workspace_id'),
    limit: sp.get('limit') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, parsed.data.workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const lim = parsed.data.limit ?? 80

  const { data, error } = await supabase
    .from('pk_doc_generation_jobs')
    .select('id, status, created_at, started_at, completed_at, error_message')
    .eq('workspace_id', parsed.data.workspace_id)
    .order('created_at', { ascending: false })
    .limit(lim)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ jobs: data ?? [] })
}
