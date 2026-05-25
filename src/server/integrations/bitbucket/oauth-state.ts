import { createHmac, timingSafeEqual } from 'crypto'

const ALG = 'sha256'
const MAX_AGE_SEC = 600

type StatePayload = {
  workspaceId: string
  userId: string
  nonce: string
  exp: number
}

export function signBitbucketOAuthState(
  payload: Omit<StatePayload, 'exp'>,
  secret: string
): string {
  const full: StatePayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC,
  }
  const encoded = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url')
  const sig = createHmac(ALG, secret).update(encoded).digest()
  const sigB64 = sig.toString('base64url')
  return `${encoded}.${sigB64}`
}

export function verifyBitbucketOAuthState(
  state: string,
  secret: string
): { workspaceId: string; userId: string } | null {
  const dot = state.lastIndexOf('.')
  if (dot <= 0) return null
  const encoded = state.slice(0, dot)
  const sigB64 = state.slice(dot + 1)
  let sig: Buffer
  try {
    sig = Buffer.from(sigB64, 'base64url')
  } catch {
    return null
  }
  if (sig.length === 0) return null
  const expected = createHmac(ALG, secret).update(encoded).digest()
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null

  let payload: StatePayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StatePayload
  } catch {
    return null
  }
  if (!payload.workspaceId || !payload.userId || typeof payload.exp !== 'number') return null
  if (Math.floor(Date.now() / 1000) > payload.exp) return null
  return { workspaceId: payload.workspaceId, userId: payload.userId }
}
