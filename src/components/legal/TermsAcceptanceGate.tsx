'use client'

import { useCallback, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { User } from '@supabase/supabase-js'
import { isSupabaseInitialized, supabase } from '@/lib/supabase'
import { isCognitoConfigured } from '@/lib/cognito'
import { useWorkspace } from '@/components/providers/WorkspaceContext'
import {
  type BillingPlan,
  planLabel,
  planElevatorPitch,
  defaultIntegrationSlugsForPlan,
  integrationCatalog,
} from '@/server/plans/catalog'

const TERMS_VERSION = '2026-04-24'

function parseBillingPlan(raw: string | undefined): BillingPlan {
  if (raw === 'professional' || raw === 'enterprise' || raw === 'standard') return raw
  return 'standard'
}

function hasAcceptedTerms(user: User | null): boolean {
  const meta = user?.user_metadata as Record<string, unknown> | undefined
  const v = meta?.terms_accepted_at
  return typeof v === 'string' && v.length > 0
}

export default function TermsAcceptanceGate({
  user,
  children,
}: {
  user: User | null
  children: React.ReactNode
}) {
  const { workspace, loading: wsLoading } = useWorkspace()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [agreed, setAgreed] = useState(false)

  // Cognito users don't have Supabase user_metadata — skip the gate
  const accepted = isCognitoConfigured() || hasAcceptedTerms(user)
  const showGate = !wsLoading && workspace && user && !accepted

  const plan = parseBillingPlan(workspace?.billing_plan)
  const planTitle = planLabel(plan)
  const planPitch = planElevatorPitch(plan)
  const allowedSlugs = workspace?.allowed_integration_slugs?.length
    ? workspace.allowed_integration_slugs
    : defaultIntegrationSlugsForPlan(plan)

  const connectorNames = useMemo(() => {
    const cat = integrationCatalog()
    return allowedSlugs.map((slug) => cat.find((c) => c.slug === slug)?.name ?? slug)
  }, [allowedSlugs])

  const signedDateLabel = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    []
  )

  const onContinue = useCallback(async () => {
    if (!agreed) return
    setSubmitting(true)
    setError(null)
    try {
      if (!isSupabaseInitialized()) { setSubmitting(false); return }
      const now = new Date().toISOString()
      const { data, error: upErr } = await supabase.auth.updateUser({
        data: {
          terms_accepted_at: now,
          terms_version: TERMS_VERSION,
          terms_workspace_id: workspace?.id ?? null,
        },
      })
      if (upErr) {
        setError(upErr.message)
        return
      }
      if (!data.user) setError('Session was not updated. Please refresh the page.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }, [agreed, workspace?.id])

  return (
    <>
      {children}
      <AnimatePresence>
        {showGate && (
          <motion.div
            key="terms-gate"
            role="dialog"
            aria-modal="true"
            aria-labelledby="terms-gate-title"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/55 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className="w-full max-w-lg max-h-[min(90vh,720px)] flex flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl overflow-hidden"
            >
              <div className="px-6 pt-6 pb-4 border-b border-[var(--color-border)] shrink-0">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-primary mb-1">
                  AutoDoc Solutions Inc.
                </p>
                <h1 id="terms-gate-title" className="text-xl font-bold text-[var(--color-text-primary)] tracking-tight">
                  Terms of use and agreement
                </h1>
                <p className="text-sm text-[var(--color-text-secondary)] mt-2 leading-relaxed">
                  Please read and accept before continuing. This is shown once when you first sign in.
                </p>
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 text-sm text-[var(--color-text-secondary)] leading-relaxed">
                <section>
                  <h2 className="text-[13px] font-semibold text-[var(--color-text-primary)] mb-1.5">About AutoDoc</h2>
                  <p>
                    AutoDoc helps your organization understand and operate software products: documentation grounded in your
                    codebase, an assistant that answers using your indexed sources, and tools to keep knowledge in sync with
                    your repositories. You use AutoDoc under the direction of your workspace administrators.
                  </p>
                </section>

                <section>
                  <h2 className="text-[13px] font-semibold text-[var(--color-text-primary)] mb-1.5">Your subscription &amp; workspace</h2>
                  <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 px-4 py-3 space-y-2">
                    <p>
                      <span className="text-[var(--color-text-tertiary)]">Workspace:</span>{' '}
                      <span className="font-medium text-[var(--color-text-primary)]">{workspace?.name}</span>
                    </p>
                    <p>
                      <span className="text-[var(--color-text-tertiary)]">Plan:</span>{' '}
                      <span className="font-medium text-[var(--color-text-primary)]">{planTitle}</span>
                      {': '}
                      {planPitch}
                    </p>
                    <p>
                      <span className="text-[var(--color-text-tertiary)]">Connectors enabled for this organization:</span>{' '}
                      <span className="text-[var(--color-text-primary)]">
                        {connectorNames.length > 0 ? connectorNames.join(', ') : 'As configured by your administrator'}
                      </span>
                    </p>
                  </div>
                </section>

                <section>
                  <h2 className="text-[13px] font-semibold text-[var(--color-text-primary)] mb-1.5">Acceptable use</h2>
                  <p>
                    You will not misuse the service, attempt to access data you are not entitled to, or use AutoDoc in a way
                    that violates applicable law or your employer&apos;s policies. Administrators control invitations, integrations,
                    and data retention for this workspace.
                  </p>
                </section>

                <section>
                  <h2 className="text-[13px] font-semibold text-[var(--color-text-primary)] mb-1.5">Privacy &amp; data</h2>
                  <p>
                    Content you sync (such as repository excerpts and generated documentation) is processed to provide AutoDoc
                    features. How long data is kept and who can access it is governed by your organization and your agreement with
                    AutoDoc Solutions Inc.
                  </p>
                </section>

                <p className="text-xs text-[var(--color-text-tertiary)] border-t border-[var(--color-border)] pt-4 leading-relaxed">
                  <strong className="text-[var(--color-text-secondary)]">Supersession.</strong> This agreement, accepted electronically on{' '}
                  <strong className="text-[var(--color-text-primary)]">{signedDateLabel}</strong>, together with the plan and workspace
                  details shown above, supersedes any prior agreement between you and AutoDoc regarding use of the AutoDoc product
                  for this account, unless a separate written agreement signed by AutoDoc Solutions Inc. expressly states otherwise.
                </p>
              </div>

              <div className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 shrink-0 space-y-3">
                <label className="flex items-start gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-[var(--color-border)] text-primary focus:ring-primary/30"
                  />
                  <span className="text-[13px] text-[var(--color-text-primary)] leading-snug">
                    I have read and agree to these terms on behalf of myself and, where applicable, the organization that invited me.
                  </span>
                </label>
                {error && <p className="text-xs text-red-700">{error}</p>}
                <button
                  type="button"
                  disabled={!agreed || submitting}
                  onClick={() => void onContinue()}
                  className="w-full pk-btn-primary py-3 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {submitting ? 'Saving…' : 'Agree and continue'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
