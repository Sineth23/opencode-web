/**
 * Turn Bitbucket / sync API errors into short, end-user-safe copy (no raw JSON blobs).
 */

import { withSupportContact } from '@/lib/support-copy'

function tryParseBitbucketMessage(body: string): string | null {
  const i = body.indexOf('{')
  if (i === -1) return null
  try {
    const j = JSON.parse(body.slice(i)) as { error?: { message?: string } }
    const m = j?.error?.message
    return typeof m === 'string' && m.trim() ? m.trim() : null
  } catch {
    return null
  }
}

function userFacingBitbucketOrSyncErrorInner(raw: string): string {
  const t = raw.trim()
  if (!t) return 'Something went wrong. Try again in a moment.'

  const lower = t.toLowerCase()
  if (lower.includes('oauth2 access token expired') || lower.includes('access token expired')) {
    return 'Your Bitbucket sign-in has expired. Open Integrations and reconnect Bitbucket, or configure PK_BITBUCKET_GIT_ACCESS_TOKEN on the server for token-based access.'
  }
  if (lower.includes('bitbucket_not_connected') || lower.includes('bitbucket is not connected')) {
    return 'Bitbucket is not connected for this workspace. Open Integrations to connect, or set PK_BITBUCKET_GIT_ACCESS_TOKEN on the server.'
  }
  if (/bitbucket\s+401/.test(lower)) {
    return 'Bitbucket did not accept the current credentials. Reconnect under Integrations or verify the server access token.'
  }
  if (/bitbucket\s+403/.test(lower)) {
    return 'Bitbucket denied access. Check that your token or account can read this workspace or repository (token scopes / repository permissions).'
  }
  if (/bitbucket\s+404/.test(lower)) {
    return 'Bitbucket could not find that repository or branch. Check the name and try again.'
  }
  if (/bitbucket\s+429/.test(lower)) {
    return 'Bitbucket is rate-limiting requests. Wait a minute and try again.'
  }
  if (lower.startsWith('bitbucket ')) {
    const parsed = tryParseBitbucketMessage(t)
    if (parsed) {
      if (parsed.toLowerCase().includes('access token expired')) {
        return 'Your Bitbucket sign-in has expired. Reconnect under Integrations or update the server access token.'
      }
      return parsed.length > 220 ? `${parsed.slice(0, 217)}…` : parsed
    }
    return 'Bitbucket returned an error. Reconnect under Integrations or try again later.'
  }

  if (t.length > 280) return `${t.slice(0, 277)}…`
  return t
}

export function userFacingBitbucketOrSyncError(raw: string): string {
  return withSupportContact(userFacingBitbucketOrSyncErrorInner(raw))
}
