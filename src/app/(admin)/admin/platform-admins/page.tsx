'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { authorizedFetch } from '@/lib/api'

type AdminRow = { user_id: string; email: string | null; created_at: string; created_by: string | null }

export default function PlatformAdminsPage() {
  const [rows, setRows] = useState<AdminRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await authorizedFetch('/api/admin/platform-admins')
      if (!res.ok) {
        setErr(await res.text())
        return
      }
      const data = (await res.json()) as { admins: AdminRow[] }
      setRows(data.admins ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setErr(null)
    try {
      const res = await authorizedFetch('/api/admin/platform-admins', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      })
      if (!res.ok) setErr(await res.text())
      else {
        setEmail('')
        void load()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  const remove = async (userId: string) => {
    if (!confirm('Remove platform admin access for this user?')) return
    setErr(null)
    try {
      const res = await authorizedFetch(`/api/admin/platform-admins?user_id=${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      })
      if (!res.ok) setErr(await res.text())
      else void load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    }
  }

  return (
    <div>
      <Link href="/admin" className="text-sm text-primary font-medium hover:underline">
        ← Organizations
      </Link>
      <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mt-4">Platform admins</h1>
      <p className="mt-2 text-sm text-[var(--color-text-secondary)] max-w-2xl">
        Staff who can manage all tenants from this console. Users must exist in Supabase Auth first. You cannot remove the last admin.
      </p>

      {err && <div className="mt-4 rounded-lg bg-red-50 text-red-800 text-sm px-4 py-3 border border-red-100">{err}</div>}

      <form onSubmit={add} className="mt-8 flex flex-col sm:flex-row gap-2 max-w-xl">
        <input
          type="email"
          required
          placeholder="colleague@autodocai.io"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={submitting}
          className="rounded-[var(--radius-md)] bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Add admin
        </button>
      </form>

      <div className="mt-10 overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
        {loading ? (
          <p className="p-4 text-sm text-[var(--color-text-secondary)]">Loading…</p>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-tertiary)]">
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Since</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.user_id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-3">{r.email ?? r.user_id}</td>
                  <td className="px-4 py-3 text-[var(--color-text-secondary)]">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" onClick={() => void remove(r.user_id)} className="text-red-600 text-sm hover:underline">
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
