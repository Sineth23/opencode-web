/** Product support email: include on user-visible errors and failure copy. */
export const SUPPORT_EMAIL = 'support@autodocai.io' as const

/** mailto: link for upgrade / plan flows (subject pre-filled). */
export const SUPPORT_MAILTO =
  'mailto:support@autodocai.io?subject=AutoDoc%20support' as const

/**
 * Appends a single support line for in-app errors. Idempotent if the email is already present.
 */
export function withSupportContact(text: string): string {
  const t = text.trim()
  if (!t) return `Please contact ${SUPPORT_EMAIL} if you need help.`
  if (t.includes(SUPPORT_EMAIL)) return t
  return `${t}\n\nContact: ${SUPPORT_EMAIL}`
}
