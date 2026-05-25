import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (typeof window !== 'undefined') {
  if (!supabaseUrl) console.error('Missing NEXT_PUBLIC_SUPABASE_URL')
  if (!supabaseAnonKey) console.error('Missing NEXT_PUBLIC_SUPABASE_ANON_KEY')
}

export const supabase =
  typeof window !== 'undefined' && supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      })
    : ({} as ReturnType<typeof createClient>)

export function isSupabaseInitialized(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(supabaseUrl && supabaseAnonKey && supabase && typeof supabase.auth !== 'undefined')
  )
}
