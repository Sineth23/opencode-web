'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { cdkGet, cdkPost } from '@/lib/cdk-api'
import {
  CheckCircleIcon,
  MagnifyingGlassIcon,
  ServerIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline'

export type GhConnection = {
  connectionId: string
  displayName: string
  createdAt: string
  createdBy: string
}

type WorkflowPhase = 'idle' | 'discovering' | 'review' | 'cloning' | 'complete' | 'error'

type DiscoveryJob = {
  jobId: string
  status: string
  filteredCount?: number
  totalScanned?: number
  totalInOrg?: number
  skippedArchived?: number
  skippedDisabled?: number
  error?: string
}

type BulkSummary = {
  total?: number
  pending?: number
  running?: number
  succeeded?: number
  failed?: number
  SUBMITTED?: number
  RUNNING?: number
  SUCCEEDED?: number
  FAILED?: number
}

interface Props {
  connections: GhConnection[]
}

const STEPS = ['Discover', 'Review', 'Clone']

function phaseToStep(phase: WorkflowPhase): number {
  if (phase === 'idle' || phase === 'discovering' || phase === 'error') return 0
  if (phase === 'review') return 1
  return 2
}

function todayStr() {
  return new Date().toISOString().split('T')[0]
}

function oneYearAgoStr() {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return d.toISOString().split('T')[0]
}

function toIso(date: string, isEnd = false) {
  return `${date}T${isEnd ? '23:59:59' : '00:00:00'}Z`
}

export default function GitHubRepoWorkflowSection({ connections }: Props) {
  // ── Form ──────────────────────────────────────────────────────────────────
  const [connectionId, setConnectionId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [projectId, setProjectId] = useState('default')
  const [since, setSince] = useState(oneYearAgoStr)
  const [until, setUntil] = useState(todayStr)
  const [allBranches, setAllBranches] = useState(true)
  const [skipArchived, setSkipArchived] = useState(true)
  const [skipDisabled, setSkipDisabled] = useState(true)
  const [cloneFullHistory, setCloneFullHistory] = useState(true)
  const [includeGit, setIncludeGit] = useState(true)

  // ── Workflow state ────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<WorkflowPhase>('idle')
  const [discovery, setDiscovery] = useState<DiscoveryJob | null>(null)
  const [cloneSummary, setCloneSummary] = useState<BulkSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  const discoverPollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const clonePollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const stopDiscoverPoll = useCallback(() => {
    if (discoverPollRef.current !== undefined) {
      clearInterval(discoverPollRef.current)
      discoverPollRef.current = undefined
    }
  }, [])

  const stopClonePoll = useCallback(() => {
    if (clonePollRef.current !== undefined) {
      clearInterval(clonePollRef.current)
      clonePollRef.current = undefined
    }
  }, [])

  useEffect(() => () => { stopDiscoverPoll(); stopClonePoll() }, [stopDiscoverPoll, stopClonePoll])

  // ── Discovery ─────────────────────────────────────────────────────────────
  const pollDiscovery = useCallback(
    async (jobId: string, onComplete: (d: DiscoveryJob) => void) => {
      try {
        const data = await cdkGet<DiscoveryJob & { ok: boolean }>(`/repos/discover/${jobId}`)
        setDiscovery(prev => ({ ...prev!, ...data }))
        if (data.status === 'COMPLETED' || data.status === 'FAILED') {
          stopDiscoverPoll()
          onComplete(data)
        }
      } catch {
        // transient — keep polling
      }
    },
    [stopDiscoverPoll],
  )

  const runDiscovery = async () => {
    if (!connectionId || !orgName.trim() || !projectId.trim() || !since || !until) {
      setError('Fill in all required fields before running discovery.')
      return
    }
    setError(null)
    setPhase('discovering')
    setDiscovery(null)
    stopDiscoverPoll()
    try {
      const data = await cdkPost<{ ok: boolean; jobId: string }>('/repos/discover', {
        connectionId,
        orgName: orgName.trim(),
        projectId: projectId.trim(),
        since: toIso(since),
        until: toIso(until, true),
        allBranches,
        skipArchived,
        skipDisabled,
        autoBulkClone: false,
      })
      setDiscovery({ jobId: data.jobId, status: 'RUNNING' })
      discoverPollRef.current = setInterval(
        () =>
          void pollDiscovery(data.jobId, (d) => {
            if (d.status === 'COMPLETED') {
              setPhase('review')
            } else {
              setPhase('error')
              setError(d.error ?? 'Discovery job failed.')
            }
          }),
        15_000,
      )
    } catch (e: unknown) {
      setPhase('error')
      setError((e as Error)?.message ?? 'Failed to start discovery.')
    }
  }

  // ── Clone ─────────────────────────────────────────────────────────────────
  const pollCloneStatus = useCallback(
    async (pid: string) => {
      try {
        const data = await cdkPost<{ ok: boolean; summary: BulkSummary }>(
          '/repos/clone/status/bulk',
          { projectId: pid, limit: 200 },
        )
        setCloneSummary(data.summary)
        const active =
          (data.summary.pending ?? data.summary.SUBMITTED ?? 0) +
          (data.summary.running ?? data.summary.RUNNING ?? 0)
        const total = data.summary.total ?? 0
        if (active === 0 && total > 0) {
          stopClonePoll()
          setPhase('complete')
        }
      } catch {
        // transient — keep polling
      }
    },
    [stopClonePoll],
  )

  const launchClone = async () => {
    if (!discovery) return
    setError(null)
    setPhase('cloning')
    setCloneSummary(null)
    stopDiscoverPoll()
    try {
      await cdkPost('/repos/discover', {
        connectionId,
        orgName: orgName.trim(),
        projectId: projectId.trim(),
        since: toIso(since),
        until: toIso(until, true),
        allBranches,
        skipArchived,
        skipDisabled,
        autoBulkClone: true,
        cloneFullHistory,
        includeGit,
      })
      // Allow ~15 s for ECS provisioning before first poll
      setTimeout(() => {
        void pollCloneStatus(projectId.trim())
        clonePollRef.current = setInterval(() => void pollCloneStatus(projectId.trim()), 30_000)
      }, 15_000)
    } catch (e: unknown) {
      setPhase('error')
      setError((e as Error)?.message ?? 'Failed to launch clone jobs.')
    }
  }

  const reset = () => {
    stopDiscoverPoll()
    stopClonePoll()
    setPhase('idle')
    setDiscovery(null)
    setCloneSummary(null)
    setError(null)
  }

  // ── Derived values ────────────────────────────────────────────────────────
  const currentStep = phaseToStep(phase)
  const succeeded = cloneSummary?.SUCCEEDED ?? cloneSummary?.succeeded ?? 0
  const failed = cloneSummary?.FAILED ?? cloneSummary?.failed ?? 0
  const activeClones = (cloneSummary?.RUNNING ?? cloneSummary?.running ?? 0) +
                       (cloneSummary?.SUBMITTED ?? cloneSummary?.pending ?? 0)
  const totalClones = cloneSummary?.total ?? discovery?.filteredCount ?? 0
  const doneClones = succeeded + failed

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <section className="pk-card p-6 sm:p-8 space-y-6">

      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">Repository Discovery &amp; Clone</h2>
        <p className="text-sm text-[var(--color-text-secondary)] mt-1">
          Scan your GitHub org for repos with commit activity in a claim window, review the filtered list, then clone them all into your AutoDoc workspace for SR&amp;ED analysis.
        </p>
      </div>

      {/* Step breadcrumb */}
      <div className="flex items-center gap-0">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center">
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              i < currentStep
                ? 'bg-emerald-100 text-emerald-800'
                : i === currentStep
                ? 'bg-primary text-white'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]'
            }`}>
              {i < currentStep
                ? <CheckCircleIcon className="h-3.5 w-3.5" aria-hidden />
                : <span className="h-4 w-4 flex items-center justify-center text-[10px] font-bold">{i + 1}</span>
              }
              {label}
            </div>
            {i < STEPS.length - 1 && (
              <div className={`h-px w-6 mx-1 ${i < currentStep ? 'bg-emerald-300' : 'bg-[var(--color-border)]'}`} />
            )}
          </div>
        ))}
        {phase !== 'idle' && (
          <button
            type="button"
            onClick={reset}
            className="ml-auto text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors flex items-center gap-1"
          >
            <ArrowPathIcon className="h-3.5 w-3.5" aria-hidden />
            Start over
          </button>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
          <ExclamationTriangleIcon className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
          {error}
        </div>
      )}

      {/* ── Step 1: Discovery form ──────────────────────────────────────── */}
      {(phase === 'idle' || phase === 'error') && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">

            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                GitHub connection <span className="text-red-500">*</span>
              </label>
              <select
                value={connectionId}
                onChange={e => setConnectionId(e.target.value)}
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Select a connection…</option>
                {connections.map(c => (
                  <option key={c.connectionId} value={c.connectionId}>{c.displayName}</option>
                ))}
              </select>
              {connections.length === 0 && (
                <p className="text-xs text-amber-700 mt-1">Add a GitHub connection above first.</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                GitHub org name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={orgName}
                onChange={e => setOrgName(e.target.value)}
                placeholder="e.g. AutoDocAI"
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Project ID</label>
              <input
                type="text"
                value={projectId}
                onChange={e => setProjectId(e.target.value)}
                placeholder="default"
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Claim window <span className="text-red-500">*</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-[10px] text-[var(--color-text-tertiary)] mb-1">From</p>
                  <input
                    type="date"
                    value={since}
                    onChange={e => setSince(e.target.value)}
                    max={until}
                    className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <p className="text-[10px] text-[var(--color-text-tertiary)] mb-1">To</p>
                  <input
                    type="date"
                    value={until}
                    onChange={e => setUntil(e.target.value)}
                    min={since}
                    max={todayStr()}
                    className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {([
              { id: 'allBranches', label: 'Check all branches (not just default)', state: allBranches, set: setAllBranches },
              { id: 'skipArchived', label: 'Skip archived repos', state: skipArchived, set: setSkipArchived },
              { id: 'skipDisabled', label: 'Skip disabled repos', state: skipDisabled, set: setSkipDisabled },
            ] as const).map(({ id, label, state, set }) => (
              <label key={id} className="flex items-center gap-2 cursor-pointer select-none text-sm">
                <input
                  type="checkbox"
                  checked={state}
                  onChange={e => set(e.target.checked)}
                  className="h-4 w-4 rounded border-[var(--color-border)] text-primary focus:ring-primary/30"
                />
                <span className="text-[var(--color-text-secondary)]">{label}</span>
              </label>
            ))}
          </div>

          <p className="text-xs text-[var(--color-text-tertiary)]">
            Discovery runs inside AWS — your GitHub PAT never leaves Secrets Manager. A Lambda reads it via IAM role; every call is CloudTrail-audited (SOC 2 CC6.1 / CC6.3).
          </p>

          <button
            type="button"
            onClick={() => void runDiscovery()}
            disabled={!connectionId || !orgName.trim() || !since || !until}
            className="pk-btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            <MagnifyingGlassIcon className="h-4 w-4" aria-hidden />
            Run discovery
          </button>
        </div>
      )}

      {/* ── Discovering spinner ─────────────────────────────────────────── */}
      {phase === 'discovering' && (
        <div className="flex items-start gap-4 py-4">
          <svg className="animate-spin h-5 w-5 text-primary shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" aria-hidden>
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-[var(--color-text-primary)]">
              Scanning <strong>{orgName}</strong>{allBranches ? ' across all branches' : ''}…
            </p>
            <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
              Checking every repo for commits between <strong>{since}</strong> and <strong>{until}</strong>. Takes 5–20 minutes for large orgs.
            </p>
            {discovery?.jobId && (
              <p className="text-xs text-[var(--color-text-tertiary)] mt-1 font-mono">Job: {discovery.jobId}</p>
            )}
          </div>
        </div>
      )}

      {/* ── Step 2: Review ──────────────────────────────────────────────── */}
      {phase === 'review' && discovery && (
        <div className="space-y-5">

          {/* Stat tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Repos matched', value: discovery.filteredCount ?? 0, accent: true },
              { label: 'Total scanned', value: discovery.totalScanned ?? discovery.totalInOrg ?? 0 },
              { label: 'Skipped archived', value: discovery.skippedArchived ?? 0 },
              { label: 'Skipped disabled', value: discovery.skippedDisabled ?? 0 },
            ].map(({ label, value, accent }) => (
              <div
                key={label}
                className={`rounded-[var(--radius-md)] border p-3 text-center ${
                  accent
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)]'
                }`}
              >
                <p className={`text-2xl font-bold tabular-nums ${accent ? 'text-primary' : 'text-[var(--color-text-primary)]'}`}>
                  {value}
                </p>
                <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          <p className="text-sm text-[var(--color-text-secondary)]">
            <strong className="text-[var(--color-text-primary)]">{discovery.filteredCount ?? 0} repos</strong> had commit activity between{' '}
            <strong className="text-[var(--color-text-primary)]">{since}</strong> and{' '}
            <strong className="text-[var(--color-text-primary)]">{until}</strong>
            {allBranches ? ' (all branches checked)' : ' (default branch only)'}.
          </p>

          {(discovery.filteredCount ?? 0) === 0 ? (
            <div className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50/60 px-3 py-2.5 text-sm text-amber-900">
              No repos matched. Try widening the claim window or verify your org name.
              <button onClick={reset} className="ml-2 font-medium underline underline-offset-2">
                Go back
              </button>
            </div>
          ) : (
            <>
              {/* Clone options */}
              <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-3">
                <p className="text-xs font-semibold text-[var(--color-text-primary)] uppercase tracking-wider">Clone options</p>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {([
                    {
                      id: 'fullHistory',
                      label: 'Full git history',
                      desc: 'Required for SR&ED — commit dates and authors are the evidence',
                      state: cloneFullHistory,
                      set: setCloneFullHistory,
                    },
                    {
                      id: 'includeGit',
                      label: 'Include .git directory',
                      desc: 'Required for the AI workspace to read git log',
                      state: includeGit,
                      set: setIncludeGit,
                    },
                  ] as const).map(({ id, label, desc, state, set }) => (
                    <label key={id} className="flex items-start gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={state}
                        onChange={e => set(e.target.checked)}
                        className="h-4 w-4 rounded border-[var(--color-border)] text-primary focus:ring-primary/30 mt-0.5"
                      />
                      <span>
                        <span className="text-sm text-[var(--color-text-primary)] font-medium">{label}</span>
                        <span className="block text-xs text-[var(--color-text-tertiary)]">{desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <p className="text-xs text-[var(--color-text-tertiary)]">
                Each repo clones into an isolated Fargate task (ephemeral disk, released on exit) and lands in your tenant S3 bucket. All jobs logged to DynamoDB + CloudTrail (SOC 2 CC7.1).
              </p>

              <button
                type="button"
                onClick={() => void launchClone()}
                className="pk-btn-primary flex items-center gap-2"
              >
                <ServerIcon className="h-4 w-4" aria-hidden />
                Clone {discovery.filteredCount} repos
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Step 3: Clone monitoring ────────────────────────────────────── */}
      {(phase === 'cloning' || phase === 'complete') && (
        <div className="space-y-5">

          {/* Waiting for first poll */}
          {!cloneSummary && phase === 'cloning' && (
            <div className="flex items-center gap-3 py-2">
              <svg className="animate-spin h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" aria-hidden>
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-[var(--color-text-primary)]">
                  Launching clone jobs for {discovery?.filteredCount ?? 'all'} repos…
                </p>
                <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5">
                  Waiting ~15 s for ECS provisioning before first status check.
                </p>
              </div>
            </div>
          )}

          {cloneSummary && (
            <>
              {/* Header row */}
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-[var(--color-text-primary)]">
                  {phase === 'complete' ? 'All clones finished' : `Cloning ${totalClones} repos…`}
                </p>
                <p className="text-xs tabular-nums text-[var(--color-text-tertiary)]">
                  {doneClones} / {totalClones} done
                </p>
              </div>

              {/* Progress bar */}
              <div className="h-2.5 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    phase === 'complete' && failed > 0 ? 'bg-amber-500' : 'bg-emerald-500'
                  }`}
                  style={{ width: totalClones > 0 ? `${Math.round((doneClones / totalClones) * 100)}%` : '0%' }}
                />
              </div>

              {/* Status tiles */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Running', value: activeClones, color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
                  { label: 'Succeeded', value: succeeded, color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
                  { label: 'Failed', value: failed, color: 'text-red-700', bg: 'bg-red-50 border-red-200' },
                ].map(({ label, value, color, bg }) => (
                  <div key={label} className={`rounded-[var(--radius-md)] border ${bg} p-3 text-center`}>
                    <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
                    <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5">{label}</p>
                  </div>
                ))}
              </div>

              {/* Terminal summary */}
              {phase === 'complete' && (
                <div className={`rounded-[var(--radius-md)] border px-4 py-3 text-sm ${
                  failed > 0
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-900'
                }`}>
                  {failed > 0 ? (
                    <>
                      <strong>{succeeded}</strong> repos cloned.{' '}
                      <strong>{failed}</strong> failed — most likely empty repos with no commits (safe to ignore).
                    </>
                  ) : (
                    <>
                      All <strong>{succeeded}</strong> repos cloned. Catalog files written to S3 and ready for SR&amp;ED analysis in the AI Workspace.
                    </>
                  )}
                </div>
              )}

              {phase === 'cloning' && (
                <p className="text-xs text-[var(--color-text-tertiary)]">
                  Polling every 30 s via <code className="font-mono">POST /repos/clone/status/bulk</code>. Each Fargate task clones one repo to an isolated ephemeral disk, syncs to S3, then exits.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
