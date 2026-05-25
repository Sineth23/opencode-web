'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { authorizedFetch } from '@/lib/api'
import { KNOWN_INTEGRATION_SLUGS, resolveFeatureFlags } from '@/server/plans/catalog'

type Member = {
  user_id: string
  role: string
  email: string | null
  permission_flags: Record<string, boolean | undefined>
}

export default function AdminWorkspaceDetailPage({ params }: { params: { id: string } }) {
  const { id } = params
  const [name, setName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [detail, setDetail] = useState<{
    member_count: number
    linked_repo_count: number
    bitbucket: { connected: boolean; updated_at?: string }
    created_by_email: string | null
    billing_plan: string
    allowed_integration_slugs: string[]
  } | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [addEmail, setAddEmail] = useState('')
  const [addRole, setAddRole] = useState<'owner' | 'admin' | 'member'>('member')
  const [adding, setAdding] = useState(false)

  const [billingPlan, setBillingPlan] = useState<'standard' | 'professional' | 'enterprise'>('standard')
  const [integrationSlugs, setIntegrationSlugs] = useState<string[]>(['bitbucket'])
  const [savingPlan, setSavingPlan] = useState(false)

  const [orgAiJson, setOrgAiJson] = useState('{}')
  const [savingOrgAi, setSavingOrgAi] = useState(false)
  const [effectiveOrgAi, setEffectiveOrgAi] = useState<Record<string, unknown> | null>(null)

  const load = async () => {
    setLoading(true)
    setErr(null)
    try {
      const [dRes, mRes] = await Promise.all([
        authorizedFetch(`/api/admin/workspaces/${id}`),
        authorizedFetch(`/api/admin/workspaces/${id}/members`),
      ])
      if (!dRes.ok) {
        setErr(await dRes.text())
        return
      }
      if (!mRes.ok) {
        setErr(await mRes.text())
        return
      }
      const d = (await dRes.json()) as {
        workspace: {
          name: string
          member_count: number
          linked_repo_count: number
          bitbucket: { connected: boolean; updated_at?: string }
          created_by_email: string | null
          billing_plan: string
          allowed_integration_slugs: string[]
          org_ai_settings?: Record<string, unknown>
          effective_org_ai?: Record<string, unknown>
        }
      }
      const m = (await mRes.json()) as { members: Member[] }
      setName(d.workspace.name)
      setDetail({
        member_count: d.workspace.member_count,
        linked_repo_count: d.workspace.linked_repo_count,
        bitbucket: d.workspace.bitbucket,
        created_by_email: d.workspace.created_by_email,
        billing_plan: d.workspace.billing_plan,
        allowed_integration_slugs: d.workspace.allowed_integration_slugs ?? ['bitbucket'],
      })
      const bp = d.workspace.billing_plan
      if (bp === 'standard' || bp === 'professional' || bp === 'enterprise') {
        setBillingPlan(bp)
      }
      setIntegrationSlugs(d.workspace.allowed_integration_slugs?.length ? d.workspace.allowed_integration_slugs : ['bitbucket'])
      setOrgAiJson(JSON.stringify(d.workspace.org_ai_settings && Object.keys(d.workspace.org_ai_settings).length > 0 ? d.workspace.org_ai_settings : {}, null, 2))
      setEffectiveOrgAi(d.workspace.effective_org_ai ?? null)
      setMembers(m.members ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when workspace id changes
  }, [id])

  const saveName = async () => {
    setSavingName(true)
    setErr(null)
    try {
      const res = await authorizedFetch(`/api/admin/workspaces/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      })
      if (!res.ok) setErr(await res.text())
      else void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSavingName(false)
    }
  }

  const addMember = async (e: React.FormEvent) => {
    e.preventDefault()
    setAdding(true)
    setErr(null)
    try {
      const res = await authorizedFetch(`/api/admin/workspaces/${id}/members`, {
        method: 'POST',
        body: JSON.stringify({ email: addEmail.trim(), role: addRole }),
      })
      if (!res.ok) setErr(await res.text())
      else {
        setAddEmail('')
        void load()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setAdding(false)
    }
  }

  const setRole = async (userId: string, role: string) => {
    setErr(null)
    try {
      const res = await authorizedFetch(`/api/admin/workspaces/${id}/members`, {
        method: 'PATCH',
        body: JSON.stringify({ user_id: userId, role }),
      })
      if (!res.ok) setErr(await res.text())
      else void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    }
  }

  const savePlanAndIntegrations = async (applyDefaults: boolean) => {
    setSavingPlan(true)
    setErr(null)
    try {
      const res = await authorizedFetch(`/api/admin/workspaces/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(
          applyDefaults
            ? { billing_plan: billingPlan, apply_default_integrations_for_plan: true }
            : {
                billing_plan: billingPlan,
                allowed_integration_slugs: integrationSlugs,
              }
        ),
      })
      if (!res.ok) setErr(await res.text())
      else void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSavingPlan(false)
    }
  }

  const toggleIntegrationSlug = (slug: string) => {
    setIntegrationSlugs((prev) => {
      const has = prev.includes(slug)
      if (has) {
        const next = prev.filter((s) => s !== slug)
        return next.length === 0 ? prev : next
      }
      return [...prev, slug]
    })
  }

  const saveMemberFlags = async (userId: string, flags: Record<string, boolean>) => {
    setErr(null)
    try {
      const res = await authorizedFetch(`/api/admin/workspaces/${id}/members`, {
        method: 'PATCH',
        body: JSON.stringify({ user_id: userId, permission_flags: flags }),
      })
      if (!res.ok) setErr(await res.text())
      else void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    }
  }

  const saveOrgAiJson = async () => {
    setSavingOrgAi(true)
    setErr(null)
    let parsed: unknown
    try {
      parsed = JSON.parse(orgAiJson)
    } catch {
      setErr('Organization AI settings must be valid JSON.')
      setSavingOrgAi(false)
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setErr('Organization AI settings JSON must be an object (e.g. { "premium_rag_monthly_cap": 200 }).')
      setSavingOrgAi(false)
      return
    }
    try {
      const res = await authorizedFetch(`/api/admin/workspaces/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ org_ai_settings: parsed, org_ai_settings_replace: true }),
      })
      if (!res.ok) setErr(await res.text())
      else void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSavingOrgAi(false)
    }
  }

  const resetOrgAi = async () => {
    setSavingOrgAi(true)
    setErr(null)
    try {
      const res = await authorizedFetch(`/api/admin/workspaces/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ reset_org_ai_settings: true }),
      })
      if (!res.ok) setErr(await res.text())
      else void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSavingOrgAi(false)
    }
  }

  const removeMember = async (userId: string) => {
    if (!confirm('Remove this member from the organization?')) return
    setErr(null)
    try {
      const res = await authorizedFetch(`/api/admin/workspaces/${id}/members?user_id=${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      })
      if (!res.ok) setErr(await res.text())
      else void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    }
  }

  if (loading && !detail) {
    return <p className="text-sm text-[var(--color-text-secondary)]">Loading…</p>
  }

  return (
    <div>
      <Link href="/admin" className="text-sm text-primary font-medium hover:underline">
        ← Organizations
      </Link>

      <div className="mt-4 flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Organization</h1>
          {detail && (
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
              Owner: {detail.created_by_email ?? 'Not set'} · {detail.member_count} members · {detail.linked_repo_count} linked repos ·
              Plan: {detail.billing_plan} · Bitbucket:{' '}
              {detail.bitbucket.connected
                ? `connected (${detail.bitbucket.updated_at ? new Date(detail.bitbucket.updated_at).toLocaleString() : ''})`
                : 'not connected'}
            </p>
          )}
        </div>

        {err && <div className="rounded-lg bg-red-50 text-red-800 text-sm px-4 py-3 border border-red-100">{err}</div>}

        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">Plan & enabled integrations</h2>
          <p className="text-xs text-[var(--color-text-tertiary)] mb-4">
            Billing plan labels what the customer bought; the checkboxes are the live allowlist (you can diverge for pilots).
          </p>
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end mb-4">
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Plan</label>
              <select
                value={billingPlan}
                onChange={(e) => setBillingPlan(e.target.value as typeof billingPlan)}
                className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm min-w-[200px]"
              >
                <option value="standard">Standard</option>
                <option value="professional">Professional</option>
                <option value="enterprise">Enterprise</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={savingPlan}
                onClick={() => void savePlanAndIntegrations(true)}
                className="rounded-[var(--radius-md)] bg-[var(--color-bg-tertiary)] px-4 py-2 text-sm font-semibold border border-[var(--color-border)] disabled:opacity-50"
              >
                Apply plan default connectors
              </button>
              <button
                type="button"
                disabled={savingPlan}
                onClick={() => void savePlanAndIntegrations(false)}
                className="rounded-[var(--radius-md)] bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Save plan & custom list
              </button>
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-2">
            {KNOWN_INTEGRATION_SLUGS.map((slug) => (
              <label key={slug} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={integrationSlugs.includes(slug)}
                  onChange={() => toggleIntegrationSlug(slug)}
                  className="rounded border-[var(--color-border)]"
                />
                <span className="text-[var(--color-text-primary)] capitalize">{slug}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)] mb-2">AI, ingestion, and query cost</h2>
          <p className="text-xs text-[var(--color-text-tertiary)] mb-4 leading-relaxed">
            Plan tier supplies defaults (Standard / Professional / Enterprise). JSON below merges partial overrides per organization.
            Assistant uses the standard model by default and the premium model for up to{' '}
            <code className="text-[11px]">premium_rag_monthly_cap</code> user turns per UTC month, then falls back.
            Consult internal configuration docs for allowed model identifiers.
          </p>
          {effectiveOrgAi && (
            <div className="mb-4">
              <p className="text-xs font-medium text-[var(--color-text-secondary)] mb-1">Effective settings (plan + overrides)</p>
              <pre className="text-[11px] leading-relaxed p-3 rounded-[var(--radius-md)] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] overflow-x-auto max-h-48">
                {JSON.stringify(
                  Object.fromEntries(
                    Object.entries(effectiveOrgAi as Record<string, unknown>).map(([k, v]) =>
                      /model/i.test(k) ? [k, '[redacted]'] : [k, v]
                    )
                  ),
                  null, 2
                )}
              </pre>
            </div>
          )}
          <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Override JSON (merge)</label>
          <textarea
            value={orgAiJson}
            onChange={(e) => setOrgAiJson(e.target.value)}
            spellCheck={false}
            className="w-full min-h-[160px] font-mono text-xs rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 bg-[var(--color-bg-secondary)]"
            placeholder='{ "premium_rag_monthly_cap": 250 }'
          />
          <p className="text-xs text-[var(--color-text-tertiary)] mt-2 mb-3">
            Saving replaces the whole override object with this JSON (use <code className="text-[11px]">{'{}'}</code> to clear all
            overrides). Example keys: embedding_model, rag_standard_model, rag_premium_model, premium_rag_monthly_cap,
            doc_generation_model, doc_target_audience, doc_content_depth (<code className="text-[11px]">overview|standard|deep</code>
            ), doc_max_chunk_rows, <code className="text-[11px]">handbook_voice</code> (tone / brand instructions for handbook
            generation, max 2000 chars), <code className="text-[11px]">handbook_depth_pass</code> (boolean; when true and the corpus
            is large, adds up to four &ldquo;Deep dive&rdquo; sections after the 16 core chapters).
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={savingOrgAi}
              onClick={() => void saveOrgAiJson()}
              className="rounded-[var(--radius-md)] bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Save AI overrides
            </button>
            <button
              type="button"
              disabled={savingOrgAi}
              onClick={() => void resetOrgAi()}
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              Reset to plan defaults
            </button>
          </div>
        </div>

        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">Display name</h2>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => void saveName()}
              disabled={savingName}
              className="rounded-[var(--radius-md)] bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>

        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">Members, roles & permissions</h2>
          <p className="text-xs text-[var(--color-text-tertiary)] mb-4">
            Role sets defaults; explicit checkboxes override for that user (connect integrations, queue sync, queue doc refresh).
          </p>
          <div className="overflow-x-auto mb-6">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-tertiary)]">
                  <th className="py-2 pr-4 font-medium">Email</th>
                  <th className="py-2 pr-4 font-medium">Role</th>
                  <th className="py-2 pr-2 font-medium whitespace-nowrap">Integrations</th>
                  <th className="py-2 pr-2 font-medium whitespace-nowrap">Sync</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">Docs</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const role = m.role === 'owner' || m.role === 'admin' || m.role === 'member' ? m.role : 'member'
                  const eff = resolveFeatureFlags(role, m.permission_flags)
                  return (
                    <tr key={m.user_id} className="border-b border-[var(--color-border)] last:border-0 align-top">
                      <td className="py-2 pr-4">{m.email ?? m.user_id}</td>
                      <td className="py-2 pr-4">
                        <select
                          value={m.role}
                          onChange={(e) => void setRole(m.user_id, e.target.value)}
                          className="rounded border border-[var(--color-border)] px-2 py-1 text-sm"
                        >
                          <option value="owner">owner</option>
                          <option value="admin">admin</option>
                          <option value="member">member</option>
                        </select>
                      </td>
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={eff.manage_integrations}
                          onChange={(e) =>
                            void saveMemberFlags(m.user_id, {
                              manage_integrations: e.target.checked,
                              trigger_sync: eff.trigger_sync,
                              queue_doc_refresh: eff.queue_doc_refresh,
                            })
                          }
                          aria-label="Manage integrations"
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={eff.trigger_sync}
                          onChange={(e) =>
                            void saveMemberFlags(m.user_id, {
                              manage_integrations: eff.manage_integrations,
                              trigger_sync: e.target.checked,
                              queue_doc_refresh: eff.queue_doc_refresh,
                            })
                          }
                          aria-label="Queue sync"
                        />
                      </td>
                      <td className="py-2 pr-4">
                        <input
                          type="checkbox"
                          checked={eff.queue_doc_refresh}
                          onChange={(e) =>
                            void saveMemberFlags(m.user_id, {
                              manage_integrations: eff.manage_integrations,
                              trigger_sync: eff.trigger_sync,
                              queue_doc_refresh: e.target.checked,
                            })
                          }
                          aria-label="Queue documentation refresh"
                        />
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => void removeMember(m.user_id)}
                          className="text-red-600 text-sm hover:underline"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)] mb-2">Add member</h3>
          <form onSubmit={addMember} className="flex flex-col sm:flex-row gap-2 items-start sm:items-end">
            <input
              type="email"
              required
              placeholder="user@company.com"
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
              className="flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm min-w-[200px]"
            />
            <select
              value={addRole}
              onChange={(e) => setAddRole(e.target.value as typeof addRole)}
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm"
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
              <option value="owner">owner</option>
            </select>
            <button
              type="submit"
              disabled={adding}
              className="rounded-[var(--radius-md)] bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Add
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
