'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cdkGet, cdkPost, cdkDelete } from '@/lib/cdk-api'
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
  TrashIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline'

type JiraConnection = {
  connectionId: string
  displayName: string
  jiraBaseUrl?: string
  createdAt: string
}

type SyncStatus = 'SUBMITTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN'

type SyncJob = {
  jobId: string
  status: SyncStatus
  issueCount?: number
  totalInJira?: number
  errorDetail?: string
  completedAt?: string
}

export default function JiraConnectionsSection() {
  const [connections, setConnections] = useState<JiraConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Add form
  const [baseUrl, setBaseUrl] = useState('')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [saving, setSaving] = useState(false)

  // Revoke
  const [revoking, setRevoking] = useState<string | null>(null)

  // Sync
  const [syncConnId, setSyncConnId] = useState('')
  const [jqlFilter, setJqlFilter] = useState('ORDER BY updated DESC')
  const [projectId, setProjectId] = useState('default')
  const [maxIssues, setMaxIssues] = useState('5000')
  const [syncing, setSyncing] = useState(false)
  const [syncJob, setSyncJob] = useState<SyncJob | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const stopPoll = useCallback(() => {
    if (pollRef.current !== undefined) {
      clearInterval(pollRef.current)
      pollRef.current = undefined
    }
  }, [])

  useEffect(() => () => stopPoll(), [stopPoll])

  const loadConnections = useCallback(async () => {
    setLoading(true)
    try {
      const data = await cdkGet<{ ok: boolean; connections: JiraConnection[] }>('/jira/connections')
      setConnections(data.connections ?? [])
    } catch {
      // non-fatal
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadConnections() }, [loadConnections])

  const saveConnection = async () => {
    if (!baseUrl.trim() || !email.trim() || !token.trim()) {
      setMsg({ type: 'error', text: 'Base URL, email, and API token are all required.' })
      return
    }
    setSaving(true)
    setMsg(null)
    try {
      await cdkPost('/jira/connections', {
        jiraBaseUrl: baseUrl.trim().replace(/\/$/, ''),
        jiraEmail: email.trim(),
        jiraToken: token.trim(),
        displayName: displayName.trim() || 'Jira',
      })
      setBaseUrl('')
      setEmail('')
      setToken('')
      setDisplayName('')
      setMsg({ type: 'success', text: 'Jira connection saved. Your token is stored encrypted and cannot be retrieved.' })
      await loadConnections()
    } catch (e: unknown) {
      setMsg({ type: 'error', text: (e as Error)?.message ?? 'Failed to save connection.' })
    } finally {
      setSaving(false)
    }
  }

  const revokeConnection = async (connectionId: string) => {
    setRevoking(connectionId)
    setMsg(null)
    try {
      await cdkDelete(`/jira/connections/${connectionId}`)
      setConnections((prev) => prev.filter((c) => c.connectionId !== connectionId))
      if (syncConnId === connectionId) setSyncConnId('')
    } catch (e: unknown) {
      setMsg({ type: 'error', text: (e as Error)?.message ?? 'Failed to revoke connection.' })
    } finally {
      setRevoking(null)
    }
  }

  const pollSyncStatus = useCallback(
    async (jobId: string) => {
      try {
        const data = await cdkGet<SyncJob & { ok: boolean }>(`/jira/sync/${jobId}`)
        setSyncJob(data)
        if (data.status === 'COMPLETED' || data.status === 'FAILED') {
          stopPoll()
        }
      } catch {
        // transient
      }
    },
    [stopPoll],
  )

  const startSync = async () => {
    if (!syncConnId) return
    setSyncing(true)
    setSyncJob(null)
    stopPoll()
    try {
      const data = await cdkPost<{ ok: boolean; jobId: string }>('/jira/sync', {
        connectionId: syncConnId,
        jqlFilter: jqlFilter.trim() || 'ORDER BY updated DESC',
        projectId: projectId.trim() || 'default',
        maxIssues: parseInt(maxIssues) || 5000,
      })
      setSyncJob({ jobId: data.jobId, status: 'SUBMITTED' })
      setTimeout(() => {
        void pollSyncStatus(data.jobId)
        pollRef.current = setInterval(() => void pollSyncStatus(data.jobId), 10_000)
      }, 3_000)
    } catch (e: unknown) {
      setMsg({ type: 'error', text: (e as Error)?.message ?? 'Failed to start sync.' })
    } finally {
      setSyncing(false)
    }
  }

  const syncTerminal = syncJob?.status === 'COMPLETED' || syncJob?.status === 'FAILED'

  return (
    <section className="pk-card p-6 sm:p-8 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">Jira Connections</h2>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            Connect your Atlassian Jira instance to sync issues into your AutoDoc workspace for
            SR&amp;ED analysis. Tokens are stored encrypted and never returned after saving.
          </p>
        </div>
        {connections.length > 0 && (
          <span className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-[var(--color-success-bg)] text-emerald-800">
            <CheckCircleIcon className="h-3.5 w-3.5" aria-hidden />
            {connections.length === 1 ? '1 connection' : `${connections.length} connections`}
          </span>
        )}
      </div>

      {/* Feedback message */}
      {msg && (
        <div className={`rounded-[var(--radius-md)] border px-3 py-2.5 text-sm ${
          msg.type === 'success'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
            : 'border-red-200 bg-red-50 text-red-800'
        }`}>
          {msg.text}
        </div>
      )}

      {/* Existing connections */}
      {loading ? (
        <p className="text-sm text-[var(--color-text-tertiary)]">Loading connections…</p>
      ) : connections.length > 0 ? (
        <div className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)] overflow-hidden">
          {connections.map((conn) => (
            <div key={conn.connectionId} className="flex items-center justify-between gap-4 px-4 py-3 bg-[var(--color-surface)]">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">{conn.displayName}</p>
                <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5">
                  {conn.jiraBaseUrl && <span className="font-mono">{conn.jiraBaseUrl} · </span>}
                  Added {new Date(conn.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="inline-flex items-center gap-1 text-xs text-[var(--color-text-tertiary)]">
                  <LockClosedIcon className="h-3 w-3" aria-hidden />
                  Token hidden
                </span>
                <button
                  type="button"
                  onClick={() => void revokeConnection(conn.connectionId)}
                  disabled={revoking === conn.connectionId}
                  className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50 transition-colors"
                >
                  <TrashIcon className="h-3.5 w-3.5" aria-hidden />
                  {revoking === conn.connectionId ? 'Revoking…' : 'Revoke'}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-[var(--color-text-tertiary)] italic">No Jira connections yet.</p>
      )}

      {/* Add connection form */}
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-3">
        <p className="text-xs font-semibold text-[var(--color-text-primary)] uppercase tracking-wider">Add new connection</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              Display name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Acme Jira"
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              Jira base URL <span className="text-red-500">*</span>
            </label>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://yourcompany.atlassian.net"
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              Atlassian email <span className="text-red-500">*</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              API token <span className="text-red-500">*</span>
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="••••••••••••••••••••"
              autoComplete="off"
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30 font-mono"
            />
          </div>
        </div>
        <p className="text-xs text-[var(--color-text-tertiary)]">
          Generate an API token at{' '}
          <span className="font-mono text-[var(--color-text-secondary)]">id.atlassian.com → Security → API tokens</span>.
          The token is encrypted on save and cannot be retrieved — only revoked.
        </p>
        <button
          type="button"
          onClick={() => void saveConnection()}
          disabled={saving || !baseUrl.trim() || !email.trim() || !token.trim()}
          className="pk-btn-primary disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save connection'}
        </button>
      </div>

      {/* Sync section — only shown when at least one connection exists */}
      {connections.length > 0 && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-4">
          <p className="text-xs font-semibold text-[var(--color-text-primary)] uppercase tracking-wider">Run a Jira sync</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Connection <span className="text-red-500">*</span>
              </label>
              <select
                value={syncConnId}
                onChange={(e) => setSyncConnId(e.target.value)}
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Select a connection…</option>
                {connections.map((c) => (
                  <option key={c.connectionId} value={c.connectionId}>{c.displayName}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Project ID
              </label>
              <input
                type="text"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="default"
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                JQL filter
              </label>
              <input
                type="text"
                value={jqlFilter}
                onChange={(e) => setJqlFilter(e.target.value)}
                placeholder="ORDER BY updated DESC"
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Max issues
              </label>
              <input
                type="number"
                value={maxIssues}
                onChange={(e) => setMaxIssues(e.target.value)}
                min={1}
                max={50000}
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void startSync()}
            disabled={syncing || !syncConnId || (!!syncJob && !syncTerminal)}
            className="pk-btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            <ArrowPathIcon className="h-4 w-4" aria-hidden />
            {syncing ? 'Starting…' : 'Run sync'}
          </button>

          {/* Sync status */}
          {syncJob && (
            <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2">
              <div className="flex items-center gap-2">
                <SyncStatusIcon status={syncJob.status} />
                <span className="text-sm font-medium text-[var(--color-text-primary)]">
                  {syncStatusLabel(syncJob.status)}
                </span>
                <SyncStatusBadge status={syncJob.status} />
              </div>
              <p className="text-xs font-mono text-[var(--color-text-tertiary)]">Job: {syncJob.jobId}</p>

              {!syncTerminal && (
                <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                  <svg className="animate-spin h-3.5 w-3.5 text-primary shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden>
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Polling every 10 s…
                </div>
              )}

              {syncJob.status === 'COMPLETED' && (
                <div className="rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                  <CheckCircleIcon className="h-4 w-4 inline-block mr-1.5 align-text-bottom" aria-hidden />
                  Synced {syncJob.issueCount ?? '?'} issues
                  {syncJob.totalInJira ? ` of ${syncJob.totalInJira} total in Jira` : ''} to S3.
                </div>
              )}

              {syncJob.status === 'FAILED' && (
                <div className="rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  <ExclamationTriangleIcon className="h-4 w-4 inline-block mr-1.5 align-text-bottom" aria-hidden />
                  Sync failed.
                  {syncJob.errorDetail && (
                    <span className="block mt-1 text-xs text-red-700">{syncJob.errorDetail}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function SyncStatusIcon({ status }: { status: SyncStatus }) {
  if (status === 'COMPLETED') return <CheckCircleIcon className="h-4 w-4 text-emerald-600 shrink-0" />
  if (status === 'FAILED') return <ExclamationTriangleIcon className="h-4 w-4 text-red-500 shrink-0" />
  return (
    <svg className="animate-spin h-4 w-4 text-primary shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  )
}

function SyncStatusBadge({ status }: { status: SyncStatus }) {
  const styles: Record<SyncStatus, string> = {
    SUBMITTED: 'bg-blue-50 text-blue-700 ring-blue-200',
    RUNNING:   'bg-blue-50 text-blue-700 ring-blue-200',
    COMPLETED: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    FAILED:    'bg-red-50 text-red-700 ring-red-200',
    UNKNOWN:   'bg-gray-100 text-gray-500 ring-gray-200',
  }
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${styles[status]}`}>
      {status}
    </span>
  )
}

function syncStatusLabel(status: SyncStatus): string {
  switch (status) {
    case 'SUBMITTED': return 'Job submitted…'
    case 'RUNNING':   return 'Syncing issues from Jira…'
    case 'COMPLETED': return 'Sync complete'
    case 'FAILED':    return 'Sync failed'
    default:          return 'Checking status…'
  }
}
