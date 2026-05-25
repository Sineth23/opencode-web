import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

const THREADS_PER_PAGE = 40

/**
 * Columns that exist in the base schema (migration 001). New columns from
 * migration 017 are selected via try-fallback: if they don't exist yet the
 * route still works using only the base columns.
 */
const BASE_SELECT = 'id, title, created_at'
const FULL_SELECT =
  'id, title, created_at, updated_at, persona, repository_id, branch, summary_at_count, response_mode'

async function selectThreads(
  supabase: NonNullable<ReturnType<typeof createRouteHandlerClient>>,
  workspaceId: string,
  userId: string
) {
  // Try with all columns (requires migration 017)
  const full = await supabase
    .from('pk_chat_threads')
    .select(FULL_SELECT)
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(THREADS_PER_PAGE)

  if (!full.error) return full.data ?? []

  // Fall back to base columns (migration 017 not yet applied)
  const base = await supabase
    .from('pk_chat_threads')
    .select(BASE_SELECT)
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(THREADS_PER_PAGE)

  return base.data ?? []
}

export async function GET(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sp = request.nextUrl.searchParams
  const workspaceId = sp.get('workspace_id')
  if (!workspaceId) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 })

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, workspaceId)
  if (!access) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const threads = await selectThreads(supabase, workspaceId, userData.user.id)
  return NextResponse.json({ threads })
}

const createSchema = z.object({
  workspace_id: z.string().uuid(),
  title: z.string().max(200).optional().nullable(),
  repository_id: z.string().uuid().optional().nullable(),
  branch: z.string().max(200).optional().nullable(),
  persona: z.enum(['pm', 'developer', 'executive']).optional().default('pm'),
  response_mode: z.enum(['grounded', 'power']).optional().default('grounded'),
})

export async function POST(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, parsed.data.workspace_id)
  if (!access) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Try inserting with all migration-017 columns first
  const fullInsert = await supabase
    .from('pk_chat_threads')
    .insert({
      workspace_id: parsed.data.workspace_id,
      user_id: userData.user.id,
      title: parsed.data.title ?? null,
      repository_id: parsed.data.repository_id ?? null,
      branch: parsed.data.branch ?? null,
      persona: parsed.data.persona,
      response_mode: parsed.data.response_mode,
    })
    .select(FULL_SELECT)
    .single()

  if (!fullInsert.error && fullInsert.data) {
    return NextResponse.json({ thread: fullInsert.data }, { status: 201 })
  }

  // Fall back: base columns only (migration 017 not yet applied)
  const baseInsert = await supabase
    .from('pk_chat_threads')
    .insert({
      workspace_id: parsed.data.workspace_id,
      user_id: userData.user.id,
      title: parsed.data.title ?? null,
    })
    .select(BASE_SELECT)
    .single()

  if (baseInsert.error) {
    console.error('[threads POST]', baseInsert.error)
    return NextResponse.json({ error: baseInsert.error.message }, { status: 500 })
  }

  return NextResponse.json({ thread: baseInsert.data }, { status: 201 })
}
