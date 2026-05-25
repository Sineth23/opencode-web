import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'

const PAGE_SIZE = 60

const BASE_MSG_SELECT = 'id, role, content, low_grounding, created_at'
const FULL_MSG_SELECT = 'id, role, content, low_grounding, sources, created_at'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = createRouteHandlerClient(request)
  if (!supabase) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify thread ownership (works with or without migration 017)
  const { data: thread, error: tErr } = await supabase
    .from('pk_chat_threads')
    .select('id, user_id, title')
    .eq('id', id)
    .eq('user_id', userData.user.id)
    .single()

  if (tErr || !thread) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Try with sources column (migration 017), fall back to base if missing
  const full = await supabase
    .from('pk_chat_messages')
    .select(FULL_MSG_SELECT)
    .eq('thread_id', id)
    .order('created_at', { ascending: true })
    .limit(PAGE_SIZE)

  if (!full.error) {
    return NextResponse.json({ messages: full.data ?? [], summary: null })
  }

  // Fall back to base columns
  const base = await supabase
    .from('pk_chat_messages')
    .select(BASE_MSG_SELECT)
    .eq('thread_id', id)
    .order('created_at', { ascending: true })
    .limit(PAGE_SIZE)

  if (base.error) return NextResponse.json({ error: base.error.message }, { status: 500 })

  return NextResponse.json({ messages: base.data ?? [], summary: null })
}
