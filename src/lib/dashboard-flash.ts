export type DashboardFlash = { kind: 'success' | 'error'; text: string }

const KEY = 'autodoc_dashboard_flash'

/** Call from Sync center (or elsewhere) so Overview can show the same notice after navigation. */
export function setDashboardFlashMessage(flash: DashboardFlash) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(flash))
  } catch {
    /* ignore */
  }
}

export function consumeDashboardFlashMessage(): DashboardFlash | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    sessionStorage.removeItem(KEY)
    const j = JSON.parse(raw) as DashboardFlash
    if (j && (j.kind === 'success' || j.kind === 'error') && typeof j.text === 'string') return j
  } catch {
    /* ignore */
  }
  return null
}
