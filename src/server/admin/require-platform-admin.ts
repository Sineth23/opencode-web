import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createRouteHandlerClient, createServiceRoleClient } from '@/lib/supabase/server-client'

export type PlatformAdminGate =
  | { ok: true; userId: string; db: SupabaseClient }
  | { ok: false; error: string; status: number }

export async function requirePlatformAdmin(request: NextRequest): Promise<PlatformAdminGate> {
  const routeClient = createRouteHandlerClient(request)
  if (!routeClient) {
    return { ok: false, error: 'Unauthorized', status: 401 }
  }

  const {
    data: { user },
    error: authErr,
  } = await routeClient.auth.getUser()
  if (authErr || !user) {
    return { ok: false, error: 'Unauthorized', status: 401 }
  }

  const db = createServiceRoleClient()
  if (!db) {
    return { ok: false, error: 'Service role not configured', status: 503 }
  }

  const { data: row } = await db.from('pk_platform_admins').select('user_id').eq('user_id', user.id).maybeSingle()
  if (!row) {
    return { ok: false, error: 'Forbidden', status: 403 }
  }

  return { ok: true, userId: user.id, db }
}

export async function checkPlatformAdmin(request: NextRequest): Promise<{ userId: string | null; platformAdmin: boolean }> {
  const routeClient = createRouteHandlerClient(request)
  if (!routeClient) {
    return { userId: null, platformAdmin: false }
  }
  const {
    data: { user },
    error: authErr,
  } = await routeClient.auth.getUser()
  if (authErr || !user) {
    return { userId: null, platformAdmin: false }
  }

  const db = createServiceRoleClient()
  if (!db) {
    return { userId: user.id, platformAdmin: false }
  }

  const { data: row } = await db.from('pk_platform_admins').select('user_id').eq('user_id', user.id).maybeSingle()
  return { userId: user.id, platformAdmin: !!row }
}
