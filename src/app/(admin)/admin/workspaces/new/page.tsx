'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { authorizedFetch } from '@/lib/api'

export default function NewWorkspacePage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [ownerUserId, setOwnerUserId] = useState('')
  const [mode, setMode] = useState<'email' | 'uuid'>('email')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null)
    setSubmitting(true)
    try {
      const body =
        mode === 'email'
          ? { name, owner_email: ownerEmail.trim() }
          : { name, owner_user_id: ownerUserId.trim() }
      const res = await authorizedFetch('/api/admin/workspaces', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const t = await res.text()
        setErr(t)
        return
      }
      const data = (await res.json()) as { workspace: { id: string } }
      router.push(`/admin/workspaces/${data.workspace.id}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-lg">
      <Link href="/admin" className="text-sm text-primary font-medium hover:underline mb-6 inline-block">
        ← Organizations
      </Link>
      <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mt-2">New organization</h1>
      <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
        Creates a workspace (tenant). The owner must already exist in Supabase Auth (sign up or invite them first).
      </p>

      <form onSubmit={submit} className="mt-8 space-y-5">
        <div>
          <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Organization name</label>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm"
            placeholder="e.g. ExtendMed"
          />
        </div>

        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={mode === 'email'} onChange={() => setMode('email')} />
            Owner email
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={mode === 'uuid'} onChange={() => setMode('uuid')} />
            Owner user UUID
          </label>
        </div>

        {mode === 'email' ? (
          <div>
            <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Owner email</label>
            <input
              type="email"
              required
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm"
            />
          </div>
        ) : (
          <div>
            <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Owner user id (uuid)</label>
            <input
              type="text"
              required
              value={ownerUserId}
              onChange={(e) => setOwnerUserId(e.target.value)}
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-xs font-mono"
            />
          </div>
        )}

        {err && <div className="rounded-lg bg-red-50 text-red-800 text-sm px-4 py-3 border border-red-100">{err}</div>}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="rounded-[var(--radius-md)] bg-primary px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
          <Link href="/admin" className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-2.5 text-sm font-medium">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
