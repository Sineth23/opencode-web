/**
 * End-user labels and messages for sync jobs (avoid exposing table names, CLI, env vars).
 */

import { withSupportContact } from '@/lib/support-copy'

export function syncJobStatusLabel(status: string): string {
  switch (status) {
    case 'queued':
      return 'Waiting'
    case 'running':
      return 'In progress'
    case 'succeeded':
      return 'Completed'
    case 'failed':
      return 'Unsuccessful'
    case 'cancelled':
      return 'Cancelled'
    default:
      return status
  }
}

/** Documentation jobs use the same lifecycle labels as repository syncs. */
export function docJobStatusLabel(status: string): string {
  return syncJobStatusLabel(status)
}

/** Short error line for documentation jobs (no raw internals). */
export function docJobErrorForDisplay(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null
  const low = raw.toLowerCase()
  if (
    low.includes('cancelled at your request') ||
    low.includes('cancelled before processing') ||
    low.includes('cancelled (stop all')
  ) {
    return null
  }
  const t = raw.trim()
  return withSupportContact(t.length > 280 ? `${t.slice(0, 277)}…` : t)
}

export function syncJobErrorForDisplay(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null
  const low = raw.toLowerCase()
  if (
    low.includes('cancelled at your request') ||
    low.includes('cancelled before processing') ||
    low.includes('cancelled (stop all') ||
    low.includes('cancelled from sync center')
  ) {
    return null
  }

  if (
    low.includes('pk_knowledge_chunks') ||
    low.includes('pk_match_knowledge_chunks') ||
    (low.includes('knowledge') && low.includes('chunk') && (low.includes('schema cache') || low.includes('does not exist')))
  ) {
    return withSupportContact(
      'Search storage for this environment is not ready yet. Your administrator needs to finish setup before syncs can complete.'
    )
  }

  if (low.includes('no bitbucket connection')) {
    return withSupportContact(
      'Bitbucket is not connected for this organization. Open Integrations, connect Bitbucket, then try again.'
    )
  }

  if (low.includes('job meta missing') || low.includes('missing bitbucket_workspace') || low.includes('missing repo_slug')) {
    return withSupportContact(
      'This sync was missing required repository details. Start a new sync and pick the workspace and repository again.'
    )
  }

  if (low.includes('bitbucket') && (low.includes('401') || low.includes('403') || low.includes('forbidden'))) {
    return withSupportContact('Bitbucket did not allow this request. Reconnect Bitbucket under Integrations and try again.')
  }

  if (low.includes('bitbucket') && /\b4\d\d\b|\b5\d\d\b/.test(low)) {
    return withSupportContact(
      'Bitbucket reported a problem while reading the repository. Check the branch and your access, then try again.'
    )
  }

  if (low.includes('openai') || low.includes('incorrect api key') || low.includes('invalid_api_key')) {
    return withSupportContact(
      'The content preparation service could not be reached. Your administrator should verify service configuration.'
    )
  }

  if (low.includes('no text files ingested') || low.includes('empty repo')) {
    return withSupportContact(
      'No supported text files were found on this branch. Try another branch or confirm the repository has source files we can read.'
    )
  }

  if (
    low.includes('could not create linked repository') ||
    low.includes('pk_linked_repositories') ||
    (low.includes('relation') && low.includes('does not exist'))
  ) {
    return withSupportContact(
      'Something in the hosting database is not ready for this step. Your administrator should confirm the latest setup has been applied.'
    )
  }

  if (low.includes('supabase') || low.includes('postgres') || low.includes('permission denied')) {
    return withSupportContact(
      'A hosting or permissions issue stopped this sync. Your administrator can review logs and try again.'
    )
  }

  return withSupportContact(
    'This sync did not finish. You can try again later, or ask your administrator to review the technical logs if it keeps happening.'
  )
}
