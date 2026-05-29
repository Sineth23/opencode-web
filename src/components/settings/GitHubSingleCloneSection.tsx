'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cdkGet, cdkPost } from '@/lib/cdk-api'
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  CloudArrowDownIcon,
} from '@heroicons/react/24/outline'
import type { GhConnection } from './GitHubRepoWorkflowSection'

type CloneStatus = 'SUBMITTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'

type JobState = {
  jobId: string
  status: CloneStatus
  terminal: boolean
  repoPrefix?: string
  stoppedReason?: string
}

interface Props {
  connections: GhConnection[]
}

export default function GitHubSingleCloneSection({ connections }: Props) {
  const [connectionId, setConnectionId] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [projectId, setProjectId] = useState('default')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<JobState | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const stopPoll = useCallback(() => {
    if (pollRef.current !== undefined) {
      clearInterval(pollRef.current)
      pollRef.current = undefined
    }
  }, [])

  useEffect(() => () => stopPoll(), [stopPoll])

  const pollStatus = useCallback(
    async (jobId: string) => {
      try {
        const data = await cdkGet<{
          ok: boolean
          status: CloneStatus
          terminal: boolean
          debug?: { job?: { repoPrefix?: string } }
          task?: { stoppedReason?: string }
        }>(`/repos/clone-status/${jobId}`)

        const updated: JobState = {
          jobId,
          status: data.status,
          terminal: data.terminal,
          repoPrefix: data.debug?.job?.repoPrefix,
          stoppedReason: data.task?.stoppedReason ?? undefined,
        }
        setJob(updated)

        if (data.terminal) {
          stopPoll()
        }
      } catch {
        // transient — keep polling
      }
    },
    [stopPoll],
  )

  const handleClone = async () => {
    if (!connectionId || !repoUrl.trim()) return
    setError(null)
    setJob(null)
    setSubmitting(true)
    stopPoll()

    try {
      const data = await cdkPost<{
        ok: boolean
        jobId: string
        repoPrefix?: string
      }>('/repos/clone', {
        repoUrl: repoUrl.trim(),
        connectionId,
        branch: branch.trim() || undefined,
        projectId: projectId.trim() || 'default',
      })

      const initial: JobState = {
        jobId: data.jobId,
        status: 'SUBMITTED',
        terminal: false,
        repoPrefix: data.repoPrefix,
      }
      setJob(initial)

      // First poll after 5 s, then every 10 s
      setTimeout(() => {
        void pollStatus(data.jobId)
        pollRef.current = setInterval(() => void pollStatus(data.jobId), 10_000)
      }, 5_000)
    } catch (e: unknown) {
      setError((e as Error)?.message ?? 'Failed to start clone.')
    } finally {
      setSubmitting(false)
    }
  }

  const reset = () => {
    stopPoll()
    setJob(null)
    setError(null)
  }

  const canSubmit = connectionId && repoUrl.trim() && !submitting && (!job || job.terminal)

  return (
    <section className="pk-card p-6 sm:p-8 space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">Clone a Single Repo</h2>
        <p className="text-sm text-[var(--color-text-secondary)] mt-1">
          Clone one GitHub repository directly into your AutoDoc workspace. Use this for quick one-off
          imports before running the full org discovery workflow.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
          <ExclamationTriangleIcon className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
          {error}
        </div>
      )}

      {/* Form */}
      {(!job || job.terminal) && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">

            {/* Connection */}
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                GitHub connection <span className="text-red-500">*</span>
              </label>
              <select
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Select a connection…</option>
                {connections.map((c) => (
                  <option key={c.connectionId} value={c.connectionId}>
                    {c.displayName}
                  </option>
                ))}
              </select>
              {connections.length === 0 && (
                <p className="text-xs text-amber-700 mt-1">Add a GitHub connection above first.</p>
              )}
            </div>

            {/* Repo URL */}
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Repository URL <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/org/repo"
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            {/* Branch */}
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Branch <span className="text-[var(--color-text-tertiary)] font-normal">(leave blank for default)</span>
              </label>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            {/* Project ID */}
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Project ID <span className="text-[var(--color-text-tertiary)] font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="default"
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleClone()}
            disabled={!canSubmit}
            className="pk-btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            <CloudArrowDownIcon className="h-4 w-4" aria-hidden />
            {submitting ? 'Starting…' : 'Clone repo'}
          </button>
        </div>
      )}

      {/* Status panel */}
      {job && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusIcon status={job.status} />
              <span className="text-sm font-medium text-[var(--color-text-primary)]">
                {statusLabel(job.status)}
              </span>
              <StatusBadge status={job.status} />
            </div>
            {job.terminal && (
              <button
                type="button"
                onClick={reset}
                className="flex items-center gap-1 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
              >
                <ArrowPathIcon className="h-3.5 w-3.5" />
                Clone another
              </button>
            )}
          </div>

          <p className="text-xs font-mono text-[var(--color-text-tertiary)]">Job: {job.jobId}</p>

          {!job.terminal && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
              <svg className="animate-spin h-3.5 w-3.5 text-primary shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden>
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Polling every 10 s…
            </div>
          )}

          {job.status === 'SUCCEEDED' && (
            <div className="rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
              <div className="flex items-center gap-2">
                <CheckCircleIcon className="h-4 w-4 shrink-0" aria-hidden />
                <span>
                  Repository cloned successfully and ready in your workspace.
                  {job.repoPrefix && (
                    <span className="block mt-1 font-mono text-xs text-emerald-700 break-all">
                      S3 prefix: {job.repoPrefix}
                    </span>
                  )}
                </span>
              </div>
            </div>
          )}

          {job.status === 'FAILED' && (
            <div className="rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
              <div className="flex items-start gap-2">
                <ExclamationTriangleIcon className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
                <span>
                  Clone failed.
                  {job.stoppedReason && (
                    <span className="block mt-1 text-xs text-red-700">{job.stoppedReason}</span>
                  )}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function StatusIcon({ status }: { status: CloneStatus }) {
  if (status === 'SUCCEEDED') return <CheckCircleIcon className="h-4 w-4 text-emerald-600" />
  if (status === 'FAILED') return <ExclamationTriangleIcon className="h-4 w-4 text-red-500" />
  return (
    <svg className="animate-spin h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  )
}

function StatusBadge({ status }: { status: CloneStatus }) {
  const styles: Record<CloneStatus, string> = {
    SUBMITTED: 'bg-blue-50 text-blue-700 ring-blue-200',
    RUNNING: 'bg-blue-50 text-blue-700 ring-blue-200',
    SUCCEEDED: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    FAILED: 'bg-red-50 text-red-700 ring-red-200',
    UNKNOWN: 'bg-gray-100 text-gray-500 ring-gray-200',
  }
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${styles[status]}`}>
      {status}
    </span>
  )
}

function statusLabel(status: CloneStatus): string {
  switch (status) {
    case 'SUBMITTED': return 'Job submitted, waiting for ECS…'
    case 'RUNNING': return 'Cloning in progress…'
    case 'SUCCEEDED': return 'Clone complete'
    case 'FAILED': return 'Clone failed'
    default: return 'Checking status…'
  }
}
