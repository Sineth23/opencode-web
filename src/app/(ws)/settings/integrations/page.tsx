import { Suspense } from 'react'
import IntegrationsSettingsClient from './IntegrationsSettingsClient'

export default function IntegrationsPage() {
  return (
    <Suspense fallback={<div className="max-w-3xl mx-auto py-12 text-[var(--color-text-secondary)]">Loading…</div>}>
      <IntegrationsSettingsClient />
    </Suspense>
  )
}
