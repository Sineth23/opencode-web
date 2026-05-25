import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  persona: z.enum(['pm', 'developer', 'executive']).optional(),
  repository_id: z.string().uuid().optional().nullable(),
  branch: z.string().max(200).optional().nullable(),
  response_mode: z.enum(['grounded', 'power']).optional(),
})

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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

  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const updates: Record<string, unknown> = {}
  if (parsed.data.title !== undefined) updates.title = parsed.data.title
  if (parsed.data.persona !== undefined) updates.persona = parsed.data.persona
  if ('repository_id' in parsed.data) updates.repository_id = parsed.data.repository_id ?? null
  if ('branch' in parsed.data) updates.branch = parsed.data.branch ?? null
  if (parsed.data.response_mode !== undefined) updates.response_mode = parsed.data.response_mode

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('pk_chat_threads')
    .update(updates)
    .eq('id', id)
    .eq('user_id', userData.user.id)
    .select('id, title, updated_at, persona, repository_id, branch, response_mode')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({ thread: data })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = createRouteHandlerClient(request)
  if (!supabase) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await supabase
    .from('pk_chat_threads')
    .delete()
    .eq('id', id)
    .eq('user_id', userData.user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
