import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

const createSchema = z.object({
  workspace_id: z.string().uuid(),
  dataset_id:   z.string().min(1),
  dataset_name: z.string().min(1),
  model:        z.string().min(1),
  title:        z.string().max(200).optional(),
  messages:     z.array(z.object({
    role:    z.enum(['user', 'assistant']),
    content: z.string(),
    sources: z.array(z.any()).optional(),
  })).default([]),
})

const updateSchema = z.object({
  id:       z.string().uuid(),
  messages: z.array(z.object({
    role:    z.enum(['user', 'assistant']),
    content: z.string(),
    sources: z.array(z.any()).optional(),
  })),
  title: z.string().max(200).optional(),
})

export async function GET(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = request.nextUrl.searchParams.get('workspace_id')
  if (!workspaceId) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 })

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, workspaceId)
  if (!access) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data, error } = await supabase
    .from('pk_rag_conversations')
    .select('id, dataset_id, dataset_name, model, title, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userData.user.id)
    .order('updated_at', { ascending: false })
    .limit(50)

  if (error) {
    // Table might not exist yet — return empty list gracefully
    if (error.code === '42P01') return NextResponse.json({ conversations: [] })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ conversations: data ?? [] })
}

export async function POST(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  // Detect update vs create
  const hasId = typeof (body as Record<string, unknown>).id === 'string'

  if (hasId) {
    // Update existing conversation (append messages, update title)
    const parsed = updateSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

    const { id, messages, title } = parsed.data
    const update: Record<string, unknown> = { messages, updated_at: new Date().toISOString() }
    if (title) update.title = title

    const { data, error } = await supabase
      .from('pk_rag_conversations')
      .update(update)
      .eq('id', id)
      .eq('user_id', userData.user.id)
      .select('id, dataset_id, dataset_name, model, title, updated_at')
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ conversation: data })
  }

  // Create new conversation
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, parsed.data.workspace_id)
  if (!access) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const title = parsed.data.title
    ?? ((parsed.data.messages.find((m) => m.role === 'user')?.content ?? '').slice(0, 80) || 'RAG conversation')

  const { data, error } = await supabase
    .from('pk_rag_conversations')
    .insert({
      workspace_id: parsed.data.workspace_id,
      user_id:      userData.user.id,
      dataset_id:   parsed.data.dataset_id,
      dataset_name: parsed.data.dataset_name,
      model:        parsed.data.model,
      title,
      messages:     parsed.data.messages,
    })
    .select('id, dataset_id, dataset_name, model, title, created_at, updated_at')
    .single()

  if (error) {
    if (error.code === '42P01') {
      return NextResponse.json({
        error: 'RAG history table not set up. Run supabase/migrations/020_rag_conversations.sql in your Supabase SQL editor.',
      }, { status: 503 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ conversation: data }, { status: 201 })
}
