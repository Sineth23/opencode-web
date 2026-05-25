import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'

export async function GET(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const uid = userData.user.id

  const { data: memberRows, error: memErr } = await supabase
    .from('pk_workspace_members')
    .select('workspace_id, role')
    .eq('user_id', uid)

  if (memErr) {
    return NextResponse.json({ error: memErr.message }, { status: 500 })
  }

  const { data: ownedRows, error: ownErr } = await supabase
    .from('pk_workspaces')
    .select('id')
    .eq('created_by', uid)

  if (ownErr) {
    return NextResponse.json({ error: ownErr.message }, { status: 500 })
  }

  const idSet = new Set<string>()
  const roleByWs = new Map<string, string>()
  for (const row of memberRows ?? []) {
    idSet.add(row.workspace_id as string)
    roleByWs.set(row.workspace_id as string, row.role as string)
  }
  for (const row of ownedRows ?? []) {
    idSet.add(row.id as string)
  }

  if (idSet.size === 0) {
    return NextResponse.json({ workspaces: [] })
  }

  const ids = [...idSet]
  const { data: workspaces, error } = await supabase
    .from('pk_workspaces')
    .select('id, name, created_at, billing_plan, allowed_integration_slugs, created_by')
    .in('id', ids)
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const list = (workspaces ?? []).map((w) => {
    const createdBy = w.created_by as string
    const memRole = roleByWs.get(w.id as string)
    const membership_role =
      memRole === 'owner' || memRole === 'admin' || memRole === 'member'
        ? memRole
        : createdBy === uid
          ? 'owner'
          : 'member'
    return {
      id: w.id as string,
      name: w.name as string,
      created_at: w.created_at as string,
      billing_plan: w.billing_plan as string,
      allowed_integration_slugs: w.allowed_integration_slugs as string[],
      membership_role,
    }
  })

  return NextResponse.json({ workspaces: list })
}

export async function POST(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: ws, error } = await supabase
    .from('pk_workspaces')
    .insert({ name: 'Primary workspace', created_by: userData.user.id })
    .select('id, name, created_at, billing_plan, allowed_integration_slugs')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await supabase.from('pk_workspace_members').insert({
    workspace_id: ws.id,
    user_id: userData.user.id,
    role: 'owner',
  })

  return NextResponse.json({
    workspace: {
      id: ws.id as string,
      name: ws.name as string,
      created_at: ws.created_at as string,
      billing_plan: ws.billing_plan as string,
      allowed_integration_slugs: ws.allowed_integration_slugs as string[],
      membership_role: 'owner' as const,
    },
  })
}
