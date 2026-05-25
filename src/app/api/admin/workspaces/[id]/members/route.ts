import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePlatformAdmin } from '@/server/admin/require-platform-admin'
import { findUserIdByEmail } from '@/server/admin/lookup-user-by-email'

const roleSchema = z.enum(['owner', 'admin', 'member'])

const postSchema = z
  .object({
    user_id: z.string().uuid().optional(),
    email: z.string().email().optional(),
    role: roleSchema.default('member'),
  })
  .refine((b) => Boolean(b.user_id) !== Boolean(b.email), {
    message: 'Provide exactly one of user_id or email',
  })

const permissionFlagsSchema = z
  .object({
    manage_integrations: z.boolean().optional(),
    trigger_sync: z.boolean().optional(),
    queue_doc_refresh: z.boolean().optional(),
  })
  .strict()

const patchSchema = z
  .object({
    user_id: z.string().uuid(),
    role: roleSchema.optional(),
    permission_flags: permissionFlagsSchema.optional(),
  })
  .refine((b) => b.role !== undefined || b.permission_flags !== undefined, {
    message: 'Provide role and/or permission_flags',
  })

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdmin(request)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const { db } = gate
  const { id: workspaceId } = await params

  const { data: ws } = await db.from('pk_workspaces').select('id').eq('id', workspaceId).maybeSingle()
  if (!ws) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  }

  const { data: rows, error } = await db
    .from('pk_workspace_members')
    .select('user_id, role, permission_flags')
    .eq('workspace_id', workspaceId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const members = []
  for (const row of rows ?? []) {
    const { data: u } = await db.auth.admin.getUserById(row.user_id)
    members.push({
      user_id: row.user_id,
      role: row.role,
      permission_flags: row.permission_flags ?? {},
      email: u.user?.email ?? null,
    })
  }

  return NextResponse.json({ members })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdmin(request)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const { db } = gate
  const { id: workspaceId } = await params

  const { data: ws } = await db.from('pk_workspaces').select('id').eq('id', workspaceId).maybeSingle()
  if (!ws) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = postSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  let targetUserId: string | undefined = parsed.data.user_id
  if (!targetUserId && parsed.data.email) {
    const found = await findUserIdByEmail(db, parsed.data.email)
    targetUserId = found ?? undefined
    if (!targetUserId) {
      return NextResponse.json({ error: 'No Auth user with that email' }, { status: 404 })
    }
  }

  if (!targetUserId) {
    return NextResponse.json({ error: 'user_id required' }, { status: 400 })
  }

  const { data: existing } = await db
    .from('pk_workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', targetUserId)
    .maybeSingle()

  const { error } = existing
    ? await db
        .from('pk_workspace_members')
        .update({ role: parsed.data.role })
        .eq('workspace_id', workspaceId)
        .eq('user_id', targetUserId)
    : await db.from('pk_workspace_members').insert({
        workspace_id: workspaceId,
        user_id: targetUserId,
        role: parsed.data.role,
      })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, user_id: targetUserId, role: parsed.data.role })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdmin(request)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const { db } = gate
  const { id: workspaceId } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const updates: Record<string, unknown> = {}
  if (parsed.data.role !== undefined) updates.role = parsed.data.role
  if (parsed.data.permission_flags !== undefined) updates.permission_flags = parsed.data.permission_flags

  const { error } = await db
    .from('pk_workspace_members')
    .update(updates)
    .eq('workspace_id', workspaceId)
    .eq('user_id', parsed.data.user_id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdmin(request)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const { db } = gate
  const { id: workspaceId } = await params

  const url = new URL(request.url)
  const userId = url.searchParams.get('user_id')
  if (!userId || !z.string().uuid().safeParse(userId).success) {
    return NextResponse.json({ error: 'user_id query param (uuid) required' }, { status: 400 })
  }

  const { data: ws } = await db.from('pk_workspaces').select('created_by').eq('id', workspaceId).maybeSingle()
  if (!ws) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  }

  if (ws.created_by === userId) {
    return NextResponse.json({ error: 'Cannot remove the workspace creator; transfer ownership first' }, { status: 400 })
  }

  const { error } = await db.from('pk_workspace_members').delete().eq('workspace_id', workspaceId).eq('user_id', userId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
