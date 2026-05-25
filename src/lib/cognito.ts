'use client'

const REGION     = process.env.NEXT_PUBLIC_COGNITO_REGION || 'ca-central-1'
const CLIENT_ID  = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || ''
const ENDPOINT   = `https://cognito-idp.${REGION}.amazonaws.com/`

const ID_TOKEN_KEY     = 'cognito_id_token'
const ACCESS_TOKEN_KEY = 'cognito_access_token'

export function isCognitoConfigured(): boolean {
  return Boolean(
    typeof window !== 'undefined' &&
    process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID &&
    process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID
  )
}

// ─── Raw Cognito API ───────────────────────────────────────────────────────

async function cognitoRequest(action: string, payload: Record<string, unknown>) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(payload),
  })
  const data = await res.json() as Record<string, unknown>
  if (!res.ok) throw new Error((data.message as string) || JSON.stringify(data))
  return data
}

export async function initiateAuth(email: string, password: string) {
  return cognitoRequest('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  })
}

export async function respondToMFA(session: string, email: string, code: string) {
  return cognitoRequest('RespondToAuthChallenge', {
    ClientId: CLIENT_ID,
    ChallengeName: 'SOFTWARE_TOKEN_MFA',
    Session: session,
    ChallengeResponses: { USERNAME: email, SOFTWARE_TOKEN_MFA_CODE: code },
  })
}

export async function respondToNewPassword(session: string, email: string, newPassword: string) {
  return cognitoRequest('RespondToAuthChallenge', {
    ClientId: CLIENT_ID,
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    Session: session,
    ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
  })
}

export async function associateSoftwareToken(sessionOrToken: string, isAccessToken = false) {
  const payload: Record<string, unknown> = isAccessToken
    ? { AccessToken: sessionOrToken }
    : { Session: sessionOrToken }
  return cognitoRequest('AssociateSoftwareToken', payload)
}

export async function verifySoftwareToken(code: string, sessionOrToken: string, isAccessToken = false) {
  const payload: Record<string, unknown> = {
    UserCode: code,
    FriendlyDeviceName: 'AutoDoc',
    ...(isAccessToken ? { AccessToken: sessionOrToken } : { Session: sessionOrToken }),
  }
  return cognitoRequest('VerifySoftwareToken', payload)
}

export async function setUserMFAPreference(accessToken: string) {
  return cognitoRequest('SetUserMFAPreference', {
    AccessToken: accessToken,
    SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
  })
}

export async function respondToMfaSetup(session: string, email: string) {
  return cognitoRequest('RespondToAuthChallenge', {
    ClientId: CLIENT_ID,
    ChallengeName: 'MFA_SETUP',
    Session: session,
    ChallengeResponses: { USERNAME: email },
  })
}

// ─── Session helpers ───────────────────────────────────────────────────────

export function saveAuthState(idToken: string, accessToken: string) {
  localStorage.setItem(ID_TOKEN_KEY, idToken)
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken)
}

export function cognitoSignOut() {
  localStorage.removeItem(ID_TOKEN_KEY)
  localStorage.removeItem(ACCESS_TOKEN_KEY)
}

export function cognitoGetIdToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(ID_TOKEN_KEY)
}

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(atob(token.split('.')[1])) as Record<string, unknown>
}

export function cognitoGetSession(): { valid: boolean; email?: string; sub?: string } | null {
  if (typeof window === 'undefined') return null
  const token = localStorage.getItem(ID_TOKEN_KEY)
  if (!token) return null
  try {
    const payload = decodePayload(token)
    const exp = (payload.exp as number) * 1000
    if (Date.now() > exp) {
      cognitoSignOut()
      return null
    }
    return { valid: true, email: payload.email as string, sub: payload.sub as string }
  } catch {
    cognitoSignOut()
    return null
  }
}

export function cognitoGetUser(): { email: string; sub: string } | null {
  const session = cognitoGetSession()
  if (!session?.valid) return null
  return { email: session.email!, sub: session.sub! }
}
