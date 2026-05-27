import { cognitoGetIdToken } from '@/lib/cognito'

const CDK_API_URL =
  process.env.NEXT_PUBLIC_CDK_API_URL ||
  'https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com'

export async function cdkFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await cognitoGetIdToken()
  if (!token) throw new Error('Not signed in')
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(`${CDK_API_URL}${path}`, { ...init, headers })
}

export async function cdkGet<T = unknown>(path: string): Promise<T> {
  const res = await cdkFetch(path)
  if (!res.ok) throw new Error(`CDK API error ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function cdkPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await cdkFetch(path, { method: 'POST', body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`CDK API error ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function cdkDelete<T = unknown>(path: string): Promise<T> {
  const res = await cdkFetch(path, { method: 'DELETE' })
  if (!res.ok) throw new Error(`CDK API error ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}
