import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePlatformAdmin } from '@/server/admin/require-platform-admin'
import { findUserIdByEmail } from '@/server/admin/lookup-user-by-email'

const createSchema = z
  .object({
    name: z.string().min(1).max(200),
    owner_user_id: z.string().uuid().optional(),
    owner_email: z.string().email().optional(),
  })
  .refine((b) => Boolean(b.owner_user_id) !== Boolean(b.owner_email), {
    message: 'Provide exactly one of owner_user_id or owner_email',
  })

export async function GET(request: NextRequest) {
  const gate = await requirePlatformAdmin(request)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const { db } = gate

  const { data: workspaces, error: wsErr } = await db
    .from('pk_workspaces')
    .select('id, name, created_by, created_at, billing_plan')
    .order('created_at', { ascending: false })

  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 })
  }

  const ids = (workspaces ?? []).map((w) => w.id)
  if (ids.length === 0) {
    return NextResponse.json({ workspaces: [] })
  }

  const [{ data: members }, { data: bbRows }, { data: repoRows }] = await Promise.all([
    db.from('pk_workspace_members').select('workspace_id'),
    db.from('pk_bitbucket_connections').select('workspace_id'),
    db.from('pk_linked_repositories').select('workspace_id'),
  ])

  const memberCount = new Map<string, number>()
  for (const m of members ?? []) {
    const id = m.workspace_id as string
    memberCount.set(id, (memberCount.get(id) ?? 0) + 1)
  }
  const bitbucket = new Set((bbRows ?? []).map((r) => r.workspace_id as string))
  const repoCount = new Map<string, number>()
  for (const r of repoRows ?? []) {
    const id = r.workspace_id as string
    repoCount.set(id, (repoCount.get(id) ?? 0) + 1)
  }

  const ownerIds = [...new Set((workspaces ?? []).map((w) => w.created_by))]
  const ownerEmail = new Map<string, string | null>()
  for (const uid of ownerIds) {
    const { data, error } = await db.auth.admin.getUserById(uid)
    ownerEmail.set(uid, error ? null : data.user?.email ?? null)
  }

  const enriched = (workspaces ?? []).map((w) => ({
    id: w.id,
    name: w.name,
    created_by: w.created_by,
    created_by_email: ownerEmail.get(w.created_by) ?? null,
    created_at: w.created_at,
    billing_plan: w.billing_plan as string,
    member_count: memberCount.get(w.id) ?? 0,
    bitbucket_connected: bitbucket.has(w.id),
    linked_repo_count: repoCount.get(w.id) ?? 0,
  }))

  return NextResponse.json({ workspaces: enriched })
}

export async function POST(request: NextRequest) {
  const gate = await requirePlatformAdmin(request)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const { db } = gate

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { name } = parsed.data
  let owner_user_id: string | undefined = parsed.data.owner_user_id
  if (!owner_user_id && parsed.data.owner_email) {
    const found = await findUserIdByEmail(db, parsed.data.owner_email)
    owner_user_id = found ?? undefined
    if (!owner_user_id) {
      return NextResponse.json({ error: 'No Auth user with owner_email' }, { status: 404 })
    }
  }
  if (!owner_user_id) {
    return NextResponse.json({ error: 'owner_user_id required' }, { status: 400 })
  }

  const { data: ownerCheck, error: ownerErr } = await db.auth.admin.getUserById(owner_user_id)
  if (ownerErr || !ownerCheck.user) {
    return NextResponse.json({ error: 'owner_user_id is not a valid Auth user' }, { status: 400 })
  }

  const { data: ws, error: insertErr } = await db
    .from('pk_workspaces')
    .insert({ name, created_by: owner_user_id })
    .select('id, name, created_by, created_at')
    .single()

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  const { error: memErr } = await db.from('pk_workspace_members').insert({
    workspace_id: ws.id,
    user_id: owner_user_id,
    role: 'owner',
  })

  if (memErr) {
    await db.from('pk_workspaces').delete().eq('id', ws.id)
    return NextResponse.json({ error: memErr.message }, { status: 500 })
  }

  return NextResponse.json({ workspace: ws })
}
