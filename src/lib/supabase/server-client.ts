import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'

/**
 * Supabase client scoped to the caller's JWT (Authorization: Bearer <access_token>).
 * Use in Route Handlers so RLS applies per user.
 */
export function createRouteHandlerClient(request: NextRequest): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const authHeader = request.headers.get('authorization')
  if (!url || !anon || !authHeader) return null

  return createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
  })
}

export function createServiceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
