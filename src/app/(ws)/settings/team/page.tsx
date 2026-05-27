'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  UserPlusIcon, TrashIcon, CheckCircleIcon,
  ExclamationTriangleIcon, EnvelopeIcon,
} from '@heroicons/react/24/outline'
import { cdkGet, cdkPost, cdkDelete } from '@/lib/cdk-api'
import { useSuperAdmin } from '@/lib/use-super-admin'

type Member = {
  userId: string
  email: string
  role: 'admin' | 'member'
  createdAt: string
  invitedBy: string
}

const ROLE_COLORS: Record<string, string> = {
  admin:  'bg-primary/10 text-primary',
  member: 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]',
}

export default function TeamPage() {
  const { isSuperAdmin, activeTenantId } = useSuperAdmin()

  const [members, setMembers]       = useState<Member[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [email, setEmail]           = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
  const [inviting, setInviting]     = useState(false)
  const [inviteMsg, setInviteMsg]   = useState<{ ok: boolean; text: string } | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const membersPath = isSuperAdmin && activeTenantId
    ? `/tenant/members?tenantId=${activeTenantId}`
    : '/tenant/members'

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await cdkGet<{ ok: boolean; members: Member[] }>(membersPath)
      setMembers(data.members ?? [])
    } catch (e) {
      setError((e as Error).message ?? 'Could not load members')
    } finally {
      setLoading(false)
    }
  }, [membersPath])

  useEffect(() => { void load() }, [load])

  async function sendInvite() {
    const trimmed = email.trim()
    if (!trimmed) return
    setInviting(true)
    setInviteMsg(null)
    try {
      await cdkPost('/tenant/members', { email: trimmed, role: inviteRole })
      setInviteMsg({ ok: true, text: `Invitation sent to ${trimmed}` })
      setEmail('')
      void load()
    } catch (e) {
      const msg = (e as Error).message ?? 'Invitation failed'
      // Show a friendly message for known conflict errors
      const friendly = msg.includes('already a member')
        ? `${trimmed} is already a member of this tenant.`
        : msg.includes('another tenant')
          ? `${trimmed} already belongs to a different tenant.`
          : msg
      setInviteMsg({ ok: false, text: friendly })
    } finally {
      setInviting(false)
    }
  }

  async function removeMember(userId: string, memberEmail: string) {
    if (!confirm(`Remove ${memberEmail} from this tenant? They will lose access immediately.`)) return
    setRemovingId(userId)
    try {
      const path = isSuperAdmin && activeTenantId
        ? `/admin/tenants/${activeTenantId}/members/${userId}`
        : `/tenant/members/${userId}`
      await cdkDelete(path)
      setMembers((prev) => prev.filter((m) => m.userId !== userId))
    } catch (e) {
      alert((e as Error).message ?? 'Could not remove member')
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Team</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          Invite client users to give them access to their tenant. Admins can also invite others and manage integrations.
        </p>
      </div>

      {/* Invite form */}
      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-6 space-y-4">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
          <UserPlusIcon className="h-4 w-4 text-primary" />
          Invite by email
        </h2>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <EnvelopeIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-text-tertiary)] pointer-events-none" />
            <input
              type="email"
              placeholder="colleague@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void sendInvite() }}
              disabled={inviting}
              className="w-full pl-9 pr-3 py-2.5 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
            />
          </div>
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
            disabled={inviting}
            className="text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] px-3 py-2.5 disabled:opacity-60"
          >
            <option value="member">Member — view only</option>
            <option value="admin">Admin — can manage &amp; invite</option>
          </select>
          <button
            type="button"
            disabled={inviting || !email.trim()}
            onClick={() => void sendInvite()}
            className="shrink-0 bg-primary text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-dark transition-colors disabled:opacity-50"
          >
            {inviting ? 'Sending…' : 'Send invite'}
          </button>
        </div>

        <AnimatePresence>
          {inviteMsg && (
            <motion.div
              key="msg"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
                inviteMsg.ok
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-red-200 bg-red-50 text-red-900'
              }`}
            >
              {inviteMsg.ok
                ? <CheckCircleIcon className="h-4 w-4 shrink-0" />
                : <ExclamationTriangleIcon className="h-4 w-4 shrink-0" />
              }
              {inviteMsg.text}
            </motion.div>
          )}
        </AnimatePresence>

        <p className="text-xs text-[var(--color-text-tertiary)]">
          The invited user receives an email with a temporary password. On first login they set a permanent password and enroll MFA.
          <strong className="font-medium text-[var(--color-text-secondary)]"> Members</strong> can view reports and launch the workspace.{' '}
          <strong className="font-medium text-[var(--color-text-secondary)]">Admins</strong> can also manage integrations and invite others.
        </p>
      </div>

      {/* Members list */}
      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Current members{!loading && members.length > 0 ? ` · ${members.length}` : ''}
          </h2>
        </div>

        {loading ? (
          <div className="p-5 space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 animate-pulse">
                <div className="h-9 w-9 rounded-full bg-[var(--color-bg-tertiary)]" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 rounded bg-[var(--color-bg-tertiary)] w-40" />
                  <div className="h-2.5 rounded bg-[var(--color-bg-tertiary)] w-24" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <p className="p-5 text-sm text-red-600">{error}</p>
        ) : members.length === 0 ? (
          <p className="p-5 text-sm text-[var(--color-text-secondary)]">No members yet. Invite your first team member above.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {members.map((m) => (
              <li key={m.userId} className="flex items-center gap-3 px-5 py-3.5">
                <div className="h-9 w-9 rounded-full bg-gradient-to-br from-primary/80 to-violet-500/80 text-white flex items-center justify-center text-sm font-semibold shrink-0">
                  {m.email.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[var(--color-text-primary)] truncate">{m.email}</p>
                  <p className="text-xs text-[var(--color-text-tertiary)]">
                    Joined {new Date(m.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <span className={`text-xs font-semibold px-2 py-1 rounded-full shrink-0 ${ROLE_COLORS[m.role] ?? ROLE_COLORS.member}`}>
                  {m.role.charAt(0).toUpperCase() + m.role.slice(1)}
                </span>
                <button
                  type="button"
                  disabled={removingId === m.userId}
                  onClick={() => void removeMember(m.userId, m.email)}
                  className="shrink-0 ml-1 p-1.5 rounded text-[var(--color-text-tertiary)] hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40"
                  title={`Remove ${m.email}`}
                >
                  {removingId === m.userId
                    ? <span className="text-xs">…</span>
                    : <TrashIcon className="h-4 w-4" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
