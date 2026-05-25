import type { SupabaseClient } from '@supabase/supabase-js'

/** Paginates Auth users until a matching email is found (MVP; not ideal at huge scale). */
export async function findUserIdByEmail(db: SupabaseClient, email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase()
  let page = 1
  const perPage = 200
  for (let i = 0; i < 50; i++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage })
    if (error || !data?.users?.length) break
    const hit = data.users.find((u) => u.email?.toLowerCase() === normalized)
    if (hit) return hit.id
    if (data.users.length < perPage) break
    page += 1
  }
  return null
}
