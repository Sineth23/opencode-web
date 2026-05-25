'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  UserPlusIcon,
  TrashIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  EnvelopeIcon,
} from '@heroicons/react/24/outline'
import { useWorkspace } from '@/components/providers/WorkspaceContext'
import { authorizedFetch } from '@/lib/api'

type Member = {
  user_id: string
  email: string | null
  name: string | null
  role: string
  is_owner: boolean
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
}

const ROLE_COLORS: Record<string, string> = {
  owner: 'bg-violet-100 text-violet-900',
  admin: 'bg-primary/10 text-primary',
  member: 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]',
}

export default function TeamPage() {
  const { workspace } = useWorkspace()
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member')
  const [inviting, setInviting] = useState(false)
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)

  const [removingId, setRemovingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!workspace?.id) return
    setLoading(true)
    setError(null)
    try {
      const res = await authorizedFetch(`/api/workspace/invite?workspace_id=${workspace.id}`)
      if (!res.ok) {
        const j = await res.json() as { error?: string }
        setError(j.error ?? 'Could not load members')
        return
      }
      const data = await res.json() as { members: Member[] }
      setMembers(data.members)
    } catch {
      setError('Could not load team members')
    } finally {
      setLoading(false)
    }
  }, [workspace?.id])

  useEffect(() => { void load() }, [load])

  async function sendInvite() {
    if (!workspace?.id || !email.trim()) return
    setInviting(true)
    setInviteError(null)
    setInviteSuccess(null)
    try {
      const res = await authorizedFetch('/api/workspace/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspace.id, email: email.trim(), role: inviteRole }),
      })
      const j = await res.json() as { ok?: boolean; error?: string; email?: string }
      if (!res.ok) {
        setInviteError(j.error ?? 'Invitation failed')
      } else {
        setInviteSuccess(`Invitation sent to ${j.email ?? email.trim()}`)
        setEmail('')
        void load()
      }
    } catch {
      setInviteError('Invitation failed. Please try again.')
    } finally {
      setInviting(false)
    }
  }

  async function removeMember(userId: string) {
    if (!workspace?.id) return
    setRemovingId(userId)
    try {
      const res = await authorizedFetch(
        `/api/workspace/invite?workspace_id=${workspace.id}&user_id=${userId}`,
        { method: 'DELETE' }
      )
      if (res.ok) {
        setMembers((prev) => prev.filter((m) => m.user_id !== userId))
      }
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-[var(--color-text-primary)] tracking-tight">Team</h1>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)] leading-relaxed">
          Invite team members to give them access to Documentation and the AI Assistant. Admins can also manage integrations and trigger syncs.
        </p>
      </div>

      {/* Invite form */}
      <div className="pk-card p-6 space-y-4">
        <h2 className="text-base font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
          <UserPlusIcon className="h-5 w-5 text-primary" />
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
              className="w-full pl-9 pr-3 py-2.5 text-sm rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
            />
          </div>
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as 'member' | 'admin')}
            disabled={inviting}
            className="text-sm rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] px-3 py-2.5 disabled:opacity-60"
          >
            <option value="member">Member: read only</option>
            <option value="admin">Admin: can manage syncs</option>
          </select>
          <button
            type="button"
            disabled={inviting || !email.trim()}
            onClick={() => void sendInvite()}
            className="shrink-0 pk-btn-primary px-5 py-2.5 disabled:opacity-50"
          >
            {inviting ? 'Sending…' : 'Send invite'}
          </button>
        </div>

        <AnimatePresence>
          {inviteSuccess && (
            <motion.div
              key="success"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2 rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900"
            >
              <CheckCircleIcon className="h-4 w-4 shrink-0" />
              {inviteSuccess}: they&apos;ll get an email with a sign-in link.
            </motion.div>
          )}
          {inviteError && (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2 rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900"
            >
              <ExclamationTriangleIcon className="h-4 w-4 shrink-0" />
              {inviteError}
            </motion.div>
          )}
        </AnimatePresence>

        <p className="text-xs text-[var(--color-text-tertiary)] leading-relaxed">
          They&apos;ll receive an email invitation. New users set their password on first login; existing users are added directly.
          <strong className="font-medium text-[var(--color-text-secondary)]"> Members</strong> can read Documentation and use the Assistant.{' '}
          <strong className="font-medium text-[var(--color-text-secondary)]">Admins</strong> can also manage integrations, trigger syncs, and invite others.
        </p>
      </div>

      {/* Members list */}
      <div className="pk-card overflow-hidden">
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
          <p className="p-5 text-sm text-[var(--color-text-secondary)]">{error}</p>
        ) : members.length === 0 ? (
          <p className="p-5 text-sm text-[var(--color-text-secondary)]">No members yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {members.map((m) => {
              const initials = (m.name ?? m.email ?? '?').charAt(0).toUpperCase()
              return (
                <li key={m.user_id} className="flex items-center gap-3 px-5 py-3.5">
                  <div className="h-9 w-9 rounded-full bg-gradient-to-br from-primary/80 to-violet-500/80 text-white flex items-center justify-center text-sm font-semibold shrink-0">
                    {initials}
                  </div>
                  <div className="flex-1 min-w-0">
                    {m.name && (
                      <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">{m.name}</p>
                    )}
                    <p className={`truncate ${m.name ? 'text-xs text-[var(--color-text-tertiary)]' : 'text-sm text-[var(--color-text-primary)]'}`}>
                      {m.email ?? '-'}
                    </p>
                  </div>
                  <span className={`text-xs font-semibold px-2 py-1 rounded-full shrink-0 ${ROLE_COLORS[m.role] ?? ROLE_COLORS.member}`}>
                    {ROLE_LABELS[m.role] ?? m.role}
                  </span>
                  {!m.is_owner && (
                    <button
                      type="button"
                      disabled={removingId === m.user_id}
                      onClick={() => void removeMember(m.user_id)}
                      className="shrink-0 ml-1 p-1.5 rounded text-[var(--color-text-tertiary)] hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40"
                      title={`Remove ${m.email ?? 'this member'}`}
                    >
                      {removingId === m.user_id
                        ? <span className="text-xs">…</span>
                        : <TrashIcon className="h-4 w-4" />}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
