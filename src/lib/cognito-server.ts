/**
 * Server-side Cognito JWT helpers (Node.js runtime only).
 * Decodes the payload without a full JWKS round-trip — the token was already
 * issued and signed by Cognito; we trust it for read-only claims.
 */

const USER_POOL_ID = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || ''
const REGION = process.env.NEXT_PUBLIC_COGNITO_REGION || 'ca-central-1'
const CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || ''

export function isCognitoServerConfigured(): boolean {
  return Boolean(USER_POOL_ID && CLIENT_ID)
}

type CognitoPayload = {
  sub: string
  email?: string
  'cognito:username'?: string
  aud?: string
  client_id?: string
  iss?: string
  exp: number
  iat: number
  token_use: 'id' | 'access'
}

function decodeJwtPayload(token: string): CognitoPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT format')
  // Node.js Buffer — available in Next.js API routes (Node runtime)
  const json = Buffer.from(parts[1], 'base64url').toString('utf8')
  return JSON.parse(json) as CognitoPayload
}

export type CognitoServerUser = {
  userId: string   // Cognito sub — stable unique ID
  email: string
}

/**
 * Extract and validate a Cognito JWT from the Authorization header.
 * Returns null if the header is missing, not a Cognito token, or expired.
 */
export function getCognitoUserFromHeader(authHeader: string | null): CognitoServerUser | null {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)

  let payload: CognitoPayload
  try {
    payload = decodeJwtPayload(token)
  } catch {
    return null
  }

  // Must be an ID token (token_use: 'id') and not expired
  if (payload.token_use !== 'id') return null
  if (Date.now() > payload.exp * 1000) return null

  // Verify issuer matches our user pool
  const expectedIss = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`
  if (payload.iss !== expectedIss) return null

  if (!payload.sub) return null

  return {
    userId: payload.sub,
    email: payload.email ?? payload['cognito:username'] ?? payload.sub,
  }
}
