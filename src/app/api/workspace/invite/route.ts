import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient, createServiceRoleClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

// ── Helpers ───────────────────────────────────────────────────────────────────

function isAdminRole(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

async function requireAdmin(request: NextRequest, workspaceId: string) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const access = await loadWorkspaceAccessForUser(supabase, user.id, workspaceId)
  if (!access) return { ok: false as const, status: 403, error: 'Workspace not found or access denied' }
  if (!isAdminRole(access.role)) return { ok: false as const, status: 403, error: 'Admin or owner role required' }
  return { ok: true as const, userId: user.id, access }
}

// ── GET: list workspace members ───────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const workspaceId = new URL(request.url).searchParams.get('workspace_id') ?? ''
  if (!workspaceId) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 })

  const gate = await requireAdmin(request, workspaceId)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const svc = createServiceRoleClient()
  if (!svc) return NextResponse.json({ error: 'Service client unavailable' }, { status: 500 })

  const { data: rows, error } = await svc
    .from('pk_workspace_members')
    .select('user_id, role, permission_flags')
    .eq('workspace_id', workspaceId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { data: ws } = await svc
    .from('pk_workspaces')
    .select('created_by')
    .eq('id', workspaceId)
    .single()

  const members = await Promise.all(
    (rows ?? []).map(async (row) => {
      const { data: u } = await svc.auth.admin.getUserById(row.user_id as string)
      return {
        user_id: row.user_id as string,
        email: u.user?.email ?? null,
        name: (u.user?.user_metadata as Record<string, unknown> | null)?.full_name as string | null ?? null,
        role: row.role as string,
        is_owner: (ws?.created_by as string | null) === row.user_id,
      }
    })
  )

  // Also include the workspace creator if they're not already in pk_workspace_members
  if (ws?.created_by && !rows?.some((r) => r.user_id === ws.created_by)) {
    const { data: creator } = await svc.auth.admin.getUserById(ws.created_by as string)
    if (creator.user) {
      members.unshift({
        user_id: ws.created_by as string,
        email: creator.user.email ?? null,
        name: (creator.user.user_metadata as Record<string, unknown> | null)?.full_name as string | null ?? null,
        role: 'owner',
        is_owner: true,
      })
    }
  }

  return NextResponse.json({ members })
}

// ── POST: invite a new member ─────────────────────────────────────────────────

const postSchema = z.object({
  workspace_id: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(['admin', 'member']).default('member'),
})

export async function POST(request: NextRequest) {
  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = postSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const gate = await requireAdmin(request, parsed.data.workspace_id)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const svc = createServiceRoleClient()
  if (!svc) return NextResponse.json({ error: 'Service client unavailable' }, { status: 500 })

  // Send Supabase magic-link invite (creates user if they don't exist yet)
  const { data: inviteData, error: inviteErr } = await svc.auth.admin.inviteUserByEmail(parsed.data.email, {
    data: { invited_to_workspace: parsed.data.workspace_id },
  })

  if (inviteErr || !inviteData.user) {
    console.error('[invite] inviteUserByEmail failed:', inviteErr)
    return NextResponse.json(
      { error: inviteErr?.message ?? 'Failed to send invitation' },
      { status: 500 }
    )
  }

  const invitedUserId = inviteData.user.id

  // Upsert workspace membership immediately so they land in the right workspace on first login
  const { data: existing } = await svc
    .from('pk_workspace_members')
    .select('user_id')
    .eq('workspace_id', parsed.data.workspace_id)
    .eq('user_id', invitedUserId)
    .maybeSingle()

  if (!existing) {
    const { error: memErr } = await svc.from('pk_workspace_members').insert({
      workspace_id: parsed.data.workspace_id,
      user_id: invitedUserId,
      role: parsed.data.role,
    })
    if (memErr) {
      console.error('[invite] membership insert failed:', memErr)
      return NextResponse.json({ error: memErr.message }, { status: 500 })
    }
  }

  return NextResponse.json({ ok: true, user_id: invitedUserId, email: parsed.data.email, role: parsed.data.role })
}

// ── DELETE: remove a member ───────────────────────────────────────────────────

export async function DELETE(request: NextRequest) {
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get('workspace_id') ?? ''
  const targetUserId = url.searchParams.get('user_id') ?? ''

  if (!workspaceId || !targetUserId) {
    return NextResponse.json({ error: 'workspace_id and user_id required' }, { status: 400 })
  }

  const gate = await requireAdmin(request, workspaceId)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  if (targetUserId === gate.userId) {
    return NextResponse.json({ error: 'You cannot remove yourself' }, { status: 400 })
  }

  const svc = createServiceRoleClient()
  if (!svc) return NextResponse.json({ error: 'Service client unavailable' }, { status: 500 })

  const { data: ws } = await svc
    .from('pk_workspaces')
    .select('created_by')
    .eq('id', workspaceId)
    .single()

  if ((ws?.created_by as string | null) === targetUserId) {
    return NextResponse.json({ error: 'Cannot remove the workspace owner' }, { status: 400 })
  }

  const { error } = await svc
    .from('pk_workspace_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', targetUserId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
