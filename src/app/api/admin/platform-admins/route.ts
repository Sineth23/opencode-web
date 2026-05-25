import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePlatformAdmin } from '@/server/admin/require-platform-admin'
import { findUserIdByEmail } from '@/server/admin/lookup-user-by-email'

const postSchema = z
  .object({
    user_id: z.string().uuid().optional(),
    email: z.string().email().optional(),
  })
  .refine((b) => Boolean(b.user_id) !== Boolean(b.email), {
    message: 'Provide exactly one of user_id or email',
  })

export async function GET(request: NextRequest) {
  const gate = await requirePlatformAdmin(request)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const { db } = gate

  const { data: rows, error } = await db.from('pk_platform_admins').select('user_id, created_at, created_by').order('created_at', {
    ascending: true,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const admins = []
  for (const row of rows ?? []) {
    const { data: u } = await db.auth.admin.getUserById(row.user_id)
    admins.push({
      user_id: row.user_id,
      email: u.user?.email ?? null,
      created_at: row.created_at,
      created_by: row.created_by,
    })
  }

  return NextResponse.json({ admins })
}

export async function POST(request: NextRequest) {
  const gate = await requirePlatformAdmin(request)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const { db, userId: actorId } = gate

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

  const { data: exists } = await db.from('pk_platform_admins').select('user_id').eq('user_id', targetUserId).maybeSingle()
  if (exists) {
    return NextResponse.json({ error: 'User is already a platform admin' }, { status: 409 })
  }

  const { error } = await db.from('pk_platform_admins').insert({
    user_id: targetUserId,
    created_by: actorId,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, user_id: targetUserId })
}

export async function DELETE(request: NextRequest) {
  const gate = await requirePlatformAdmin(request)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const { db, userId: actorId } = gate

  const url = new URL(request.url)
  const target = url.searchParams.get('user_id')
  if (!target || !z.string().uuid().safeParse(target).success) {
    return NextResponse.json({ error: 'user_id query param (uuid) required' }, { status: 400 })
  }

  const { count, error: countErr } = await db.from('pk_platform_admins').select('*', { count: 'exact', head: true })
  if (countErr || !count || count <= 1) {
    return NextResponse.json({ error: 'Cannot remove the last platform admin' }, { status: 400 })
  }

  const { error } = await db.from('pk_platform_admins').delete().eq('user_id', target)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
