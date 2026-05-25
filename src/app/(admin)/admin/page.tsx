'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { authorizedFetch } from '@/lib/api'

type Row = {
  id: string
  name: string
  created_by: string
  created_by_email: string | null
  created_at: string
  billing_plan: string
  member_count: number
  bitbucket_connected: boolean
  linked_repo_count: number
}

export default function AdminOrganizationsPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setErr(null)
      try {
        const res = await authorizedFetch('/api/admin/workspaces')
        if (!res.ok) {
          setErr(await res.text())
          setRows([])
          return
        }
        const data = (await res.json()) as { workspaces: Row[] }
        setRows(data.workspaces ?? [])
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Failed to load')
        setRows([])
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [])

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Organizations (workspaces)</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)] max-w-2xl">
            Each row is a tenant: repos, Bitbucket tokens, docs, and members are scoped here. Deploy once; every client org uses the same app.
          </p>
        </div>
        <Link
          href="/admin/workspaces/new"
          className="inline-flex justify-center items-center rounded-[var(--radius-md)] bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:opacity-95 shrink-0"
        >
          New organization
        </Link>
      </div>

      {err && (
        <div className="mb-4 rounded-lg bg-red-50 text-red-800 text-sm px-4 py-3 border border-red-100">{err}</div>
      )}

      {loading ? (
        <p className="text-sm text-[var(--color-text-secondary)]">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--color-text-secondary)]">No workspaces yet. Create one for a client org.</p>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-tertiary)]">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Owner</th>
                <th className="px-4 py-3 font-medium">Members</th>
                <th className="px-4 py-3 font-medium">Plan</th>
                <th className="px-4 py-3 font-medium">Bitbucket</th>
                <th className="px-4 py-3 font-medium">Repos</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-3 font-medium text-[var(--color-text-primary)]">{r.name}</td>
                  <td className="px-4 py-3 text-[var(--color-text-secondary)]">{r.created_by_email ?? r.created_by.slice(0, 8)}…</td>
                  <td className="px-4 py-3">{r.member_count}</td>
                  <td className="px-4 py-3 capitalize text-[var(--color-text-secondary)]">{r.billing_plan ?? '-'}</td>
                  <td className="px-4 py-3">{r.bitbucket_connected ? 'Connected' : '-'}</td>
                  <td className="px-4 py-3">{r.linked_repo_count}</td>
                  <td className="px-4 py-3 text-[var(--color-text-secondary)]">{new Date(r.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/admin/workspaces/${r.id}`} className="text-primary font-medium hover:underline">
                      Manage
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
