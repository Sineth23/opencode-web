'use client'

import { useCallback, useEffect, useState } from 'react'
import { cdkGet, cdkPost, cdkFetch } from '@/lib/cdk-api'
import { useSuperAdmin } from '@/lib/use-super-admin'

type TenantStatus = 'ACTIVE' | 'OFFBOARDING' | 'DELETED' | string

type Tenant = {
  tenantId: string
  companyName: string
  status: TenantStatus
  createdAt: string
  scheduledDeletionAt?: string
  offboardReason?: string
}

type DialogState =
  | { type: 'initiate'; tenant: Tenant }
  | { type: 'cancel'; tenant: Tenant }
  | { type: 'delete'; tenant: Tenant }
  | null

export default function AdminTenantsPage() {
  const { isSuperAdmin, loading: saLoading } = useSuperAdmin()
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [loading, setLoading] = useState(true)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [reason, setReason] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await cdkGet<{ ok: boolean; tenants: Tenant[] }>('/admin/tenants')
      const list = data.tenants ?? []

      // Enrich OFFBOARDING tenants with scheduledDeletionAt from offboard status endpoint
      const enriched = await Promise.all(
        list.map(async (t) => {
          if (t.status !== 'OFFBOARDING') return t
          try {
            const s = await cdkGet<{
              ok: boolean
              scheduledDeletionAt?: string
              offboardReason?: string
            }>(`/tenants/${t.tenantId}/offboard`)
            return { ...t, scheduledDeletionAt: s.scheduledDeletionAt, offboardReason: s.offboardReason }
          } catch {
            return t
          }
        })
      )
      setTenants(enriched)
    } catch (e) {
      console.error('Failed to load tenants', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isSuperAdmin) void load()
  }, [isSuperAdmin, load])

  function openDialog(d: DialogState) {
    setDialog(d)
    setReason('')
    setActionError(null)
  }

  async function handleInitiate() {
    if (dialog?.type !== 'initiate') return
    setActionLoading(true)
    setActionError(null)
    try {
      await cdkPost(`/tenants/${dialog.tenant.tenantId}/offboard`, { reason: reason.trim() || undefined })
      setDialog(null)
      await load()
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleCancel() {
    if (dialog?.type !== 'cancel') return
    setActionLoading(true)
    setActionError(null)
    try {
      await cdkPost(`/tenants/${dialog.tenant.tenantId}/offboard`, { action: 'cancel' })
      setDialog(null)
      await load()
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleDeleteNow() {
    if (dialog?.type !== 'delete') return
    setActionLoading(true)
    setActionError(null)
    try {
      const res = await cdkFetch(`/tenants/${dialog.tenant.tenantId}/offboard?confirm=true`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setDialog(null)
      await load()
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setActionLoading(false)
    }
  }

  if (saLoading) {
    return <div className="p-8 text-sm text-[var(--color-text-secondary)]">Loading…</div>
  }
  if (!isSuperAdmin) {
    return <div className="p-8 text-sm text-red-600">Access denied. SuperAdmin only.</div>
  }

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Tenant Management</h1>
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
            SuperAdmin
          </span>
        </div>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          Offboard and delete customer tenants. Offboarding enters a 30-day retention window before
          permanent deletion — you can cancel at any time during that window.
        </p>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        {loading ? (
          <div className="px-4 py-10 text-center text-sm text-[var(--color-text-secondary)]">
            Loading tenants…
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                  Tenant
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                  Created
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {tenants.map((t) => (
                <TenantRow
                  key={t.tenantId}
                  tenant={t}
                  onOffboard={() => openDialog({ type: 'initiate', tenant: t })}
                  onCancel={() => openDialog({ type: 'cancel', tenant: t })}
                  onDelete={() => openDialog({ type: 'delete', tenant: t })}
                />
              ))}
              {tenants.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-sm text-[var(--color-text-secondary)]">
                    No tenants found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Modal overlay */}
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl p-6">

            {dialog.type === 'initiate' && (
              <>
                <h2 className="text-lg font-semibold text-gray-900">
                  Offboard &ldquo;{dialog.tenant.companyName}&rdquo;?
                </h2>
                <p className="mt-2 text-sm text-gray-600">
                  This starts a <strong>30-day retention period</strong>. The tenant will be locked
                  and all data permanently deleted after that period. You can cancel at any time
                  before then.
                </p>
                <div className="mt-4">
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Reason <span className="text-gray-400">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Contract ended, customer request"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
                  />
                </div>
                {actionError && (
                  <p className="mt-3 text-xs text-red-600">{actionError}</p>
                )}
                <div className="mt-5 flex justify-end gap-3">
                  <button
                    onClick={() => setDialog(null)}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleInitiate}
                    disabled={actionLoading}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
                  >
                    {actionLoading ? 'Starting…' : 'Begin offboarding'}
                  </button>
                </div>
              </>
            )}

            {dialog.type === 'cancel' && (
              <>
                <h2 className="text-lg font-semibold text-gray-900">
                  Cancel offboarding for &ldquo;{dialog.tenant.companyName}&rdquo;?
                </h2>
                <p className="mt-2 text-sm text-gray-600">
                  The tenant will be restored to <strong>Active</strong> status and no data will be
                  deleted.
                </p>
                {actionError && (
                  <p className="mt-3 text-xs text-red-600">{actionError}</p>
                )}
                <div className="mt-5 flex justify-end gap-3">
                  <button
                    onClick={() => setDialog(null)}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Dismiss
                  </button>
                  <button
                    onClick={handleCancel}
                    disabled={actionLoading}
                    className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-60"
                  >
                    {actionLoading ? 'Cancelling…' : 'Cancel offboarding'}
                  </button>
                </div>
              </>
            )}

            {dialog.type === 'delete' && (
              <>
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100">
                    <svg className="h-5 w-5 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">
                      Permanently delete &ldquo;{dialog.tenant.companyName}&rdquo;?
                    </h2>
                    <p className="mt-2 text-sm text-gray-600">
                      This will immediately and permanently destroy all tenant data — S3 bucket,
                      DynamoDB records, IAM roles, and secrets.{' '}
                      <strong className="text-red-700">This cannot be undone.</strong>
                    </p>
                  </div>
                </div>
                {actionError && (
                  <p className="mt-3 text-xs text-red-600">{actionError}</p>
                )}
                <div className="mt-5 flex justify-end gap-3">
                  <button
                    onClick={() => setDialog(null)}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDeleteNow}
                    disabled={actionLoading}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
                  >
                    {actionLoading ? 'Deleting…' : 'Delete permanently'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TenantRow({
  tenant,
  onOffboard,
  onCancel,
  onDelete,
}: {
  tenant: Tenant
  onOffboard: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  return (
    <tr className="hover:bg-[var(--color-bg-secondary)]/50 transition-colors">
      <td className="px-4 py-3">
        <div className="font-medium text-[var(--color-text-primary)]">{tenant.companyName}</div>
        <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-tertiary)]">{tenant.tenantId}</div>
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={tenant.status} />
        {tenant.status === 'OFFBOARDING' && tenant.scheduledDeletionAt && (
          <div className="mt-1 text-[11px] text-amber-700">
            Deletes {new Date(tenant.scheduledDeletionAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-[var(--color-text-secondary)]">
        {tenant.createdAt
          ? new Date(tenant.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
          : '—'}
      </td>
      <td className="px-4 py-3 text-right">
        {tenant.status === 'ACTIVE' && (
          <button
            onClick={onOffboard}
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors"
          >
            Offboard
          </button>
        )}
        {tenant.status === 'OFFBOARDING' && (
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onCancel}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onDelete}
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors"
            >
              Delete now
            </button>
          </div>
        )}
        {tenant.status !== 'ACTIVE' && tenant.status !== 'OFFBOARDING' && (
          <span className="text-xs text-[var(--color-text-tertiary)]">—</span>
        )}
      </td>
    </tr>
  )
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ACTIVE: 'bg-green-50 text-green-700 ring-green-200',
    OFFBOARDING: 'bg-amber-50 text-amber-700 ring-amber-200',
    DELETED: 'bg-gray-100 text-gray-500 ring-gray-200',
  }
  const cls = styles[status] ?? 'bg-gray-100 text-gray-500 ring-gray-200'
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${cls}`}>
      {status}
    </span>
  )
}
