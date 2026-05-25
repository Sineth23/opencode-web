'use client'

import Image from 'next/image'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { authorizedFetch } from '@/lib/api'
import { SUPPORT_EMAIL, SUPPORT_MAILTO, withSupportContact } from '@/lib/support-copy'
import { useWorkspace } from '@/components/providers/WorkspaceContext'
import BitbucketSyncSection from '@/components/settings/BitbucketSyncSection'
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  LockClosedIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline'

type AccessPayload = {
  workspace: { id: string; name: string; billing_plan: string; allowed_integration_slugs: string[] }
  role: string
  effective_features: {
    manage_integrations: boolean
    trigger_sync: boolean
    queue_doc_refresh: boolean
  }
  integrations: Array<{
    slug: string
    name: string
    tagline: string
    org_enabled: boolean
    implemented: boolean
    user_can_connect: boolean
    user_can_use_when_ready: boolean
    upgrade_hint: string | null
    locked_reason: 'org_plan' | 'role' | 'not_built_yet' | null
  }>
  plan: { key: string; label: string; pitch: string }
}

function integrationLogo(slug: string) {
  if (slug === 'bitbucket') {
    return (
      <Image src="/images/logos/bitbucket.svg" alt="Bitbucket" width={28} height={28} className="opacity-90" />
    )
  }
  const initial = slug.slice(0, 1).toUpperCase()
  return (
    <span className="text-lg font-bold text-[var(--color-text-secondary)]" aria-hidden>
      {initial}
    </span>
  )
}

export default function IntegrationsSettingsClient() {
  const { workspace, refresh } = useWorkspace()
  const searchParams = useSearchParams()
  const [access, setAccess] = useState<AccessPayload | null>(null)
  const [accessLoading, setAccessLoading] = useState(true)
  const [bbStatus, setBbStatus] = useState<{
    connected: boolean
    updated_at: string | null
    connected_via_env_token_only?: boolean
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    if (searchParams.get('bb') === 'connected') {
      setMsg('Bitbucket connected successfully. It now appears as an active source for your organization.')
      void refresh()
    }
    if (searchParams.get('bb') === 'error') {
      setMsg(`Connection issue: ${searchParams.get('message') || 'unknown'}`)
    }
  }, [searchParams, refresh])

  useEffect(() => {
    if (!workspace?.id) {
      setAccess(null)
      setAccessLoading(false)
      return
    }
    setAccessLoading(true)
    void (async () => {
      const res = await authorizedFetch(`/api/workspace/access?workspace_id=${workspace.id}`)
      if (res.ok) {
        setAccess((await res.json()) as AccessPayload)
      } else {
        setAccess(null)
      }
      setAccessLoading(false)
    })()
  }, [workspace?.id])

  useEffect(() => {
    if (!workspace?.id) return
    void (async () => {
      const res = await authorizedFetch(`/api/integrations/bitbucket/status?workspace_id=${workspace.id}`)
      if (res.ok) {
        const j = (await res.json()) as {
          connected: boolean
          updated_at: string | null
          connected_via_env_token_only?: boolean
        }
        setBbStatus(j)
      }
    })()
  }, [workspace?.id])

  const connectBitbucket = async () => {
    if (!workspace?.id) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await authorizedFetch('/api/integrations/bitbucket/oauth-start', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: workspace.id }),
      })
      const j = (await res.json()) as { url?: string; error?: string }
      if (!res.ok || !j.url) {
        setMsg(withSupportContact(j.error || 'Could not start connection.'))
        setBusy(false)
        return
      }
      window.location.href = j.url
    } catch {
      setMsg(withSupportContact('Could not start connection.'))
    } finally {
      setBusy(false)
    }
  }

  const runDocGen = async () => {
    if (!workspace?.id) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await authorizedFetch('/api/docs/generate', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: workspace.id }),
      })
      const j = (await res.json()) as { error?: string; detail?: string }
      if (!res.ok) setMsg(withSupportContact(j.error || 'Could not queue documentation.'))
      else setMsg(j.detail || 'Documentation generation queued.')
    } catch {
      setMsg(withSupportContact('Could not queue documentation.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-10 pb-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-primary mb-2">Organization</p>
        <h1 className="text-3xl font-bold text-[var(--color-text-primary)] tracking-tight">Integrations</h1>
        <p className="mt-3 text-[var(--color-text-secondary)] leading-relaxed max-w-2xl">
          Every connector your team might use is listed here. What you can turn on today depends on your{' '}
          <strong className="font-medium text-[var(--color-text-primary)]">plan</strong> and{' '}
          <strong className="font-medium text-[var(--color-text-primary)]">role</strong>, so you always see the full roadmap and
          can upgrade when you are ready.
        </p>
      </div>

      {access && !accessLoading && (
        <div className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-surface)] via-[var(--color-bg-secondary)] to-primary/5 p-5 sm:p-6 shadow-sm">
          <div className="absolute top-0 right-0 p-3 opacity-[0.07] pointer-events-none" aria-hidden>
            <SparklesIcon className="h-24 w-24 text-primary" />
          </div>
          <div className="relative flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Current plan</p>
              <p className="text-xl font-bold text-[var(--color-text-primary)] mt-1">{access.plan.label}</p>
              <p className="text-sm text-[var(--color-text-secondary)] mt-2 max-w-xl leading-relaxed">{access.plan.pitch}</p>
            </div>
            <div className="shrink-0 flex flex-col gap-2 sm:items-end">
              <a
                href={SUPPORT_MAILTO}
                className="inline-flex items-center justify-center rounded-[var(--radius-md)] bg-primary px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-95 transition-opacity"
              >
                Talk to us about upgrading
              </a>
              <p className="text-xs text-[var(--color-text-tertiary)] text-center sm:text-right max-w-[220px]">
                Professional adds multi-Git; Enterprise adds Jira, Confluence, Slack, and priority rollout.
              </p>
            </div>
          </div>
        </div>
      )}

      {msg && (
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-info-bg)] px-4 py-3 text-sm text-[var(--color-text-primary)]">
          {msg}
        </div>
      )}

      <section>
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)] mb-1">Connectors</h2>
        <p className="text-sm text-[var(--color-text-secondary)] mb-4 max-w-2xl">
          Locked items stay visible so your team knows what is possible.{' '}
          <a href={SUPPORT_MAILTO} className="text-primary font-medium hover:underline">
            contact support
          </a>{' '}
          to change plans or enable a connector for your organization.
        </p>

        {accessLoading && (
          <p className="text-sm text-[var(--color-text-tertiary)]">Loading access and plan…</p>
        )}

        {!accessLoading && workspace?.id && !access && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-[var(--radius-md)] px-3 py-2">
            Could not load plan and permissions for this workspace. If you belong to this organization, try refreshing.
            Otherwise contact {SUPPORT_EMAIL}.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {(access?.integrations ?? []).map((item) => {
            const isBb = item.slug === 'bitbucket'
            const connected = isBb && bbStatus?.connected

            return (
              <div
                key={item.slug}
                className={`rounded-[var(--radius-lg)] border bg-[var(--color-surface)] shadow-sm overflow-hidden flex flex-col ${
                  item.org_enabled ? 'border-[var(--color-border)]' : 'border-dashed border-amber-200/80 bg-amber-50/20'
                }`}
              >
                <div className="flex flex-col flex-1 p-5 sm:p-6 gap-4">
                  <div className="flex items-start gap-4 min-w-0">
                    <div className="h-12 w-12 rounded-[var(--radius-md)] bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
                      {integrationLogo(item.slug)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold text-[var(--color-text-primary)]">{item.name}</h3>
                        {!item.org_enabled && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-200/80">
                            <LockClosedIcon className="h-3 w-3" aria-hidden />
                            Not on your plan
                          </span>
                        )}
                        {item.org_enabled && item.locked_reason === 'not_built_yet' && (
                          <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-violet-100 text-violet-900">
                            Approved · shipping
                          </span>
                        )}
                        {connected && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--color-success-bg)] text-emerald-800">
                            <CheckCircleIcon className="h-3.5 w-3.5" aria-hidden />
                            {bbStatus?.connected_via_env_token_only ? 'Active (server token)' : 'Connected'}
                          </span>
                        )}
                        {item.org_enabled && isBb && !connected && bbStatus && (
                          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--color-warning-bg)] text-amber-900">
                            Not connected
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-[var(--color-text-secondary)] mt-1 leading-relaxed">{item.tagline}</p>
                      {isBb && bbStatus?.connected_via_env_token_only && (
                        <p className="text-xs text-sky-900/90 mt-2 leading-relaxed rounded-[var(--radius-md)] border border-sky-200/80 bg-sky-50/60 px-2.5 py-2">
                          A server-configured access token is active for this deployment. Connecting Bitbucket via OAuth below is optional.
                        </p>
                      )}
                      {item.upgrade_hint && (
                        <p className="text-xs text-[var(--color-text-tertiary)] mt-3 leading-relaxed border-t border-[var(--color-border)] pt-3">
                          {item.upgrade_hint}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-auto flex flex-col gap-2">
                    {isBb ? (
                      <>
                        <button
                          type="button"
                          className="pk-btn-primary w-full sm:w-auto disabled:opacity-50"
                          disabled={busy || !workspace?.id || !item.user_can_connect}
                          onClick={() => void connectBitbucket()}
                        >
                          {connected ? 'Reconnect Bitbucket' : 'Connect Bitbucket'}
                        </button>
                        <a
                          href="https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary font-medium inline-flex items-center gap-1 hover:underline"
                        >
                          How OAuth works
                          <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                        </a>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled
                        className="pk-btn-secondary w-full sm:w-auto opacity-60 cursor-not-allowed"
                      >
                        {!item.user_can_connect ? 'Request access' : 'Connect (coming soon)'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        <p className="text-xs text-[var(--color-text-tertiary)] mt-4">
          Plan tiers: Standard → Professional → Enterprise. Your platform admin sets the live plan and which connectors are
          enabled per organization.
        </p>
      </section>

      <section className="pk-card p-6 sm:p-8 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">Ingestion & sync</h2>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            Choose a repository you have synced before, or browse your Bitbucket workspaces and repos after you connect.
            Additional connectors will use the same pattern when they are available.
          </p>
        </div>

        {access && !access.effective_features.trigger_sync && (
          <div className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50/50 px-3 py-2 text-sm text-amber-950">
            You do not have permission to start sync jobs. Ask an organization admin or{' '}
            <a href={SUPPORT_MAILTO} className="font-medium underline">
              contact support
            </a>{' '}
            to adjust roles.
          </div>
        )}
        {access && !access.effective_features.queue_doc_refresh && (
          <div className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50/50 px-3 py-2 text-sm text-amber-950">
            You do not have permission to refresh documentation. Admins can grant this per member from the platform console.
          </div>
        )}

        {workspace?.id && (
          <BitbucketSyncSection
            workspaceId={workspace.id}
            connected={bbStatus?.connected === true}
            canSync={Boolean(access?.effective_features.trigger_sync)}
            onSyncQueued={() => setMsg('Sync started. You can follow progress on the Sync center page.')}
            onBulkSyncQueued={(n, kind) =>
              setMsg(
                kind === 'branches'
                  ? `${n} branch sync(s) queued. Open Sync center to watch progress.`
                  : `${n} repo sync(s) queued. Open Sync center to watch progress.`,
              )
            }
            extraActions={
              <button
                type="button"
                className="pk-btn-secondary"
                disabled={busy || !access?.effective_features.queue_doc_refresh}
                onClick={() => void runDocGen()}
              >
                Refresh documentation
              </button>
            }
          />
        )}
        <p className="text-xs text-[var(--color-text-tertiary)]">
          Syncs run in the background. Open Sync center to see recent activity, optional documentation source filters (repository
          and branch), and the same refresh action with those scopes.
        </p>
      </section>

      <p className="text-sm text-[var(--color-text-tertiary)]">
        <Link href="/dashboard" className="text-primary font-medium hover:underline">
          ← Back to overview
        </Link>
      </p>
    </div>
  )
}
