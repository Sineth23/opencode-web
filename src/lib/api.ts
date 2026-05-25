import { isSupabaseInitialized, supabase } from '@/lib/supabase'
import { isCognitoConfigured, cognitoGetIdToken } from '@/lib/cognito'

export async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let token: string | null = null
  if (isCognitoConfigured()) {
    token = cognitoGetIdToken()
  } else if (isSupabaseInitialized()) {
    const { data } = await supabase.auth.getSession()
    token = data.session?.access_token ?? null
  }
  if (!token) {
    throw new Error('Not signed in')
  }
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(path, { ...init, headers })
}
