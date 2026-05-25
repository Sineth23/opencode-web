'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowPathIcon,
  BookOpenIcon,
  ChatBubbleLeftRightIcon,
  PuzzlePieceIcon,
} from '@heroicons/react/24/outline'
import { useWorkspace } from '@/components/providers/WorkspaceContext'
import { Skeleton } from '@/components/ui/Skeleton'
import { authorizedFetch } from '@/lib/api'
import { consumeDashboardFlashMessage } from '@/lib/dashboard-flash'
import {
  docJobErrorForDisplay,
  docJobStatusLabel,
  syncJobErrorForDisplay,
  syncJobStatusLabel,
} from '@/lib/sync-job-copy'

type SyncJob = {
  id: string
  status: string
  branch: string
  error_message: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

type DocJob = {
  id: string
  status: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  error_message: string | null
}

type Flash = { kind: 'success' | 'error'; text: string }

const POLL_ACTIVE_MS = 5000
const POLL_IDLE_MS = 20000
const RECENT_LIMIT = 40

function relativeActivityLabel(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function latestJobIso(sync?: SyncJob | null, doc?: DocJob | null): string | null {
  const times: number[] = []
  if (sync) times.push(new Date(sync.completed_at || sync.started_at || sync.created_at).getTime())
  if (doc) times.push(new Date(doc.completed_at || doc.started_at || doc.created_at).getTime())
  const max = Math.max(0, ...times)
  return max > 0 ? new Date(max).toISOString() : null
}

export default function DashboardPage() {
  const { workspace, loading: wsLoading } = useWorkspace()
  const [bb, setBb] = useState<{ connected: boolean } | null>(null)
  const [syncJobs, setSyncJobs] = useState<SyncJob[]>([])
  const [docJobs, setDocJobs] = useState<DocJob[]>([])
  const [loading, setLoading] = useState(true)
  const [flash, setFlash] = useState<Flash | null>(null)

  const loadJobs = useCallback(async () => {
    if (!workspace?.id) return
    try {
      const [jRes, dRes] = await Promise.all([
        authorizedFetch(`/api/sync/status?workspace_id=${workspace.id}&limit=120`),
        authorizedFetch(`/api/workspace/doc-jobs?workspace_id=${workspace.id}&limit=${RECENT_LIMIT}`),
      ])
      if (jRes.ok) {
        const j = (await jRes.json()) as { jobs: SyncJob[] }
        setSyncJobs(j.jobs ?? [])
      }
      if (dRes.ok) {
        const d = (await dRes.json()) as { jobs: DocJob[] }
        setDocJobs(d.jobs ?? [])
      }
    } catch (e) {
      console.error(e)
    }
  }, [workspace?.id])

  const syncActive = syncJobs.some((j) => j.status === 'queued' || j.status === 'running')
  const docActive = docJobs.some((j) => j.status === 'queued' || j.status === 'running')
  const hasActiveWork = syncActive || docActive

  useEffect(() => {
    const fromNav = consumeDashboardFlashMessage()
    if (fromNav) setFlash(fromNav)
  }, [])

  useEffect(() => {
    if (!flash) return
    const t = window.setTimeout(() => setFlash(null), 14000)
    return () => window.clearTimeout(t)
  }, [flash])

  useEffect(() => {
    if (!workspace?.id) return
    const ms = hasActiveWork ? POLL_ACTIVE_MS : POLL_IDLE_MS
    const id = window.setInterval(() => void loadJobs(), ms)
    return () => window.clearInterval(id)
  }, [workspace?.id, hasActiveWork, loadJobs])

  useEffect(() => {
    if (!workspace?.id) return
    const load = async () => {
      setLoading(true)
      try {
        const [st, j, d] = await Promise.all([
          authorizedFetch(`/api/integrations/bitbucket/status?workspace_id=${workspace.id}`),
          authorizedFetch(`/api/sync/status?workspace_id=${workspace.id}&limit=120`),
          authorizedFetch(`/api/workspace/doc-jobs?workspace_id=${workspace.id}&limit=${RECENT_LIMIT}`),
        ])
        if (st.ok) {
          const s = (await st.json()) as { connected: boolean }
          setBb(s)
        }
        if (j.ok) {
          const jd = (await j.json()) as { jobs: SyncJob[] }
          setSyncJobs(jd.jobs ?? [])
        }
        if (d.ok) {
          const dd = (await d.json()) as { jobs: DocJob[] }
          setDocJobs(dd.jobs ?? [])
        }
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [workspace?.id])

  const lastSync = syncJobs[0]
  const lastDoc = docJobs[0]
  const sourceCount = bb?.connected ? 1 : 0
  const latestActivityIso = latestJobIso(lastSync, lastDoc)

  const activeSync = syncJobs.filter((j) => j.status === 'queued' || j.status === 'running')
  const doneSync = syncJobs.filter((j) => j.status !== 'queued' && j.status !== 'running')
  const activeDoc = docJobs.filter((j) => j.status === 'queued' || j.status === 'running')
  const doneDoc = docJobs.filter((j) => j.status !== 'queued' && j.status !== 'running')

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-6">
      <header className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-surface)] via-[var(--color-surface)] to-[var(--color-accent-light)]/35 px-6 py-7 sm:px-8 sm:py-8 shadow-sm">
        <div className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full bg-primary/[0.06] blur-2xl" aria-hidden />
        <div className="relative max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">Workspace</p>
          <h1 className="mt-1.5 text-2xl sm:text-3xl font-bold text-[var(--color-text-primary)] tracking-tight">Overview</h1>
          <p className="mt-3 text-sm sm:text-[15px] text-[var(--color-text-secondary)] leading-relaxed">
            Connect your systems, keep knowledge current, then use the handbook and assistant with your team and clients, without digging through
            repositories.
          </p>
          {!wsLoading && workspace?.name ? (
            <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-white/70 px-3 py-1.5 text-xs text-[var(--color-text-secondary)] shadow-sm backdrop-blur-sm">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.25)]"
                aria-hidden
              />
              <span className="font-medium text-[var(--color-text-primary)]">{workspace.name}</span>
            </p>
          ) : null}
          {!wsLoading && workspace?.id && !loading ? (
            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--color-text-tertiary)] leading-relaxed">
              {hasActiveWork ? (
                <>
                  <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
                    <span className="motion-reduce:animate-none absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/35 opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                  </span>
                  <span>
                    <span className="font-medium text-[var(--color-text-secondary)]">Activity in progress</span>
                    {' · '}
                    sync or documentation is running; details are in{' '}
                    <strong className="font-medium text-[var(--color-text-primary)]">Sync &amp; jobs</strong> below.
                  </span>
                </>
              ) : latestActivityIso ? (
                <>
                  <span className="font-medium text-[var(--color-text-secondary)]">All caught up</span>
                  <span className="text-[var(--color-text-tertiary)]">·</span>
                  <span>Last job activity {relativeActivityLabel(latestActivityIso)}.</span>
                </>
              ) : (
                <span>
                  Connect <strong className="font-medium text-[var(--color-text-secondary)]">Bitbucket</strong> under
                  Integrations to unlock sync, documentation, and assistant search.
                </span>
              )}
            </p>
          ) : null}
        </div>
      </header>

      {flash && (
        <div
          role="status"
          className={`rounded-[var(--radius-lg)] border px-4 py-3 text-sm flex gap-3 items-start justify-between ${
            flash.kind === 'error'
              ? 'border-red-200 bg-red-50/90 text-red-950'
              : 'border-emerald-200 bg-emerald-50/90 text-emerald-950'
          }`}
        >
          <p className="leading-relaxed pr-2">{flash.text}</p>
          <button
            type="button"
            onClick={() => setFlash(null)}
            className="shrink-0 text-xs font-semibold uppercase tracking-wide opacity-70 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      <section aria-labelledby="dashboard-quick-heading" className="space-y-3">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-end sm:justify-between">
          <h2 id="dashboard-quick-heading" className="text-sm font-semibold text-[var(--color-text-primary)]">
            Where to go next
          </h2>
          <p className="text-xs text-[var(--color-text-tertiary)]">Handbook and Q&amp;A use the knowledge synced for this workspace.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="pk-card flex flex-col p-5 sm:p-6 transition-[box-shadow,transform] duration-200 ease-out hover:shadow-md border-[var(--color-border)] ring-1 ring-transparent hover:ring-primary/[0.08] hover:-translate-y-px motion-reduce:hover:translate-y-0"
          >
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent-light)] text-primary">
                <BookOpenIcon className="h-6 w-6" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-semibold text-[var(--color-text-primary)]">Documentation</h3>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)] leading-relaxed">
                  Features, workflows, configuration, and workarounds, written for delivery and client-facing teams.
                </p>
                {!loading && lastDoc ? (
                  <p className="mt-2.5 text-[11px] text-[var(--color-text-tertiary)] leading-snug">
                    Last handbook job ·{' '}
                    <span className="font-medium text-[var(--color-text-secondary)]">{docJobStatusLabel(lastDoc.status)}</span>
                    {(lastDoc.completed_at || lastDoc.created_at) && (
                      <> · {relativeActivityLabel(lastDoc.completed_at || lastDoc.created_at)}</>
                    )}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link href="/docs" className="pk-btn-primary w-full justify-center sm:w-auto">
                Open documentation
              </Link>
            </div>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
            className="pk-card flex flex-col p-5 sm:p-6 transition-[box-shadow,transform] duration-200 ease-out hover:shadow-md border-[var(--color-border)] ring-1 ring-transparent hover:ring-primary/[0.08] hover:-translate-y-px motion-reduce:hover:translate-y-0"
          >
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-primary/10 text-primary">
                <ChatBubbleLeftRightIcon className="h-6 w-6" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-semibold text-[var(--color-text-primary)]">Assistant</h3>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)] leading-relaxed">
                  Ask how something works or how to configure it. Answers draw on your connected knowledge when search-assisted mode is on.
                </p>
                {!loading && lastSync ? (
                  <p className="mt-2.5 text-[11px] text-[var(--color-text-tertiary)] leading-snug">
                    Last code index sync ·{' '}
                    <span className="font-medium text-[var(--color-text-secondary)]">{syncJobStatusLabel(lastSync.status)}</span>
                    {lastSync.branch ? <> · {lastSync.branch}</> : null}
                    {(lastSync.completed_at || lastSync.created_at) && (
                      <> · {relativeActivityLabel(lastSync.completed_at || lastSync.created_at)}</>
                    )}
                  </p>
                ) : !loading ? (
                  <p className="mt-2.5 text-[11px] text-[var(--color-text-tertiary)] leading-snug">
                    Sync a repository so answers can cite live paths from your codebase.
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link href="/assistant" className="pk-btn-primary w-full justify-center sm:w-auto">
                Open assistant
              </Link>
            </div>
          </motion.div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="pk-card p-0 overflow-hidden flex flex-col lg:col-span-2 border-[var(--color-border)] shadow-sm"
        >
          <div className="px-5 pt-5 pb-4 sm:px-6 sm:pt-6 border-b border-[var(--color-border)] bg-gradient-to-br from-[var(--color-surface)] to-[var(--color-bg-secondary)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-[var(--radius-md)] bg-[var(--color-accent-light)] flex items-center justify-center">
                  <PuzzlePieceIcon className="h-5 w-5 text-primary" aria-hidden />
                </div>
                <div>
                  <h2 className="font-semibold text-[var(--color-text-primary)] text-lg">Knowledge sources</h2>
                  <p className="text-sm text-[var(--color-text-secondary)] mt-0.5">
                    Integrations that feed documentation and search
                  </p>
                </div>
              </div>
              {wsLoading || loading ? (
                <Skeleton className="h-6 rounded-full shrink-0" style={{ width: 88 }} aria-hidden />
              ) : (
                <span
                  className={`text-xs font-semibold px-2.5 py-1 rounded-full shrink-0 ${
                    sourceCount > 0 ? 'bg-[var(--color-success-bg)] text-emerald-900' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
                  }`}
                >
                  {`${sourceCount} active`}
                </span>
              )}
            </div>
          </div>

          <div className="p-4 sm:p-5 flex-1 flex flex-col gap-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="h-10 w-10 rounded-md bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
                  <Image src="/images/logos/bitbucket.svg" alt="Bitbucket" width={22} height={22} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--color-text-primary)]">Bitbucket Cloud</p>
                  <p className="text-xs text-[var(--color-text-tertiary)]">Code & repositories</p>
                </div>
              </div>
              <div className="flex flex-col sm:items-end gap-2 shrink-0 sm:text-right min-w-[7.5rem]" aria-busy={wsLoading || loading}>
                {wsLoading || loading ? (
                  <div className="flex flex-col items-end gap-1.5 w-full max-w-[9rem]">
                    <Skeleton className="h-3.5 rounded-md w-full" />
                    <Skeleton className="h-2.5 rounded-md w-3/4 opacity-80" />
                  </div>
                ) : (
                  <>
                    <span
                      className={`text-xs font-semibold ${
                        bb?.connected ? 'text-emerald-800' : 'text-amber-900'
                      }`}
                    >
                      {bb?.connected ? 'Connected' : 'Not connected'}
                    </span>
                    <span className="text-[11px] text-[var(--color-text-tertiary)] leading-snug">
                      {bb?.connected ? 'Ready to sync repositories' : 'Connect under Integrations'}
                    </span>
                  </>
                )}
              </div>
            </div>

            <p className="text-xs text-[var(--color-text-tertiary)] leading-relaxed px-0.5">
              Connect sources under <strong className="font-medium text-[var(--color-text-secondary)]">Integrations</strong>. More connectors
              (e.g. GitHub) are added per deployment when your team is ready.
            </p>

            <Link href="/settings/integrations" className="pk-btn-primary mt-1 w-full justify-center sm:w-auto sm:justify-start">
              Manage integrations
            </Link>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="pk-card p-5 sm:p-6 flex flex-col border-[var(--color-border)] shadow-sm"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)] bg-sky-50 text-sky-700 mb-3">
            <ArrowPathIcon className="h-6 w-6" aria-hidden />
          </div>
          <h2 className="font-semibold text-[var(--color-text-primary)] text-lg">Sync &amp; jobs</h2>
          <div className="text-sm text-[var(--color-text-secondary)] mt-2 flex-1 leading-relaxed min-h-[4.5rem]">
            {loading ? (
              <div className="space-y-2.5 pt-0.5" aria-busy="true" aria-label="Loading sync and job status">
                <Skeleton className="h-4 rounded-md w-full" />
                <Skeleton className="h-4 rounded-md w-[92%]" />
                <Skeleton className="h-3 rounded-md w-2/3 opacity-90" />
              </div>
            ) : lastSync || lastDoc ? (
              <span className="block space-y-2">
                {lastSync ? (
                  <span className="block">
                    <span className="font-medium text-[var(--color-text-primary)]">Last repository sync:</span>{' '}
                    {syncJobStatusLabel(lastSync.status)}
                    {lastSync.branch ? ` · ${lastSync.branch}` : ''}.
                  </span>
                ) : null}
                {lastDoc ? (
                  <span className="block">
                    <span className="font-medium text-[var(--color-text-primary)]">Last documentation job:</span>{' '}
                    {docJobStatusLabel(lastDoc.status)}.
                  </span>
                ) : null}
              </span>
            ) : (
              'No jobs yet. Connect a source, then open Sync center to run a sync or refresh documentation.'
            )}
          </div>
          <Link href="/settings/sync" className="pk-btn-secondary mt-5 w-full justify-center text-center">
            Open Sync center
          </Link>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08 }}
          className="pk-card p-0 overflow-hidden flex flex-col lg:col-span-3 border-[var(--color-border)] shadow-sm"
        >
          <div className="px-5 py-4 sm:px-6 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40">
            <h2 className="font-semibold text-[var(--color-text-primary)] text-lg">Recent activity</h2>
            <p className="text-xs text-[var(--color-text-tertiary)] mt-2 leading-relaxed max-w-3xl">
              Repository syncs and documentation generation. This list refreshes on its own; anything in progress also appears in the banner under
              the top bar.
            </p>
          </div>
          {loading ? (
            <div className="p-5 sm:p-6 space-y-3" aria-busy="true" aria-label="Loading recent activity">
              <Skeleton className="h-4 rounded-md max-w-lg w-full" />
              <Skeleton className="h-4 rounded-md max-w-md w-full" />
              <Skeleton className="h-4 rounded-md max-w-sm w-4/5" />
              <div className="grid gap-2 sm:grid-cols-2 pt-2">
                <Skeleton className="h-24 rounded-[var(--radius-md)] w-full" />
                <Skeleton className="h-24 rounded-[var(--radius-md)] w-full" />
              </div>
            </div>
          ) : syncJobs.length === 0 && docJobs.length === 0 ? (
            <p className="p-5 text-sm text-[var(--color-text-secondary)]">
              Nothing here yet. Use Sync center to start a sync or refresh documentation.
            </p>
          ) : (
            <div className="grid gap-0 md:grid-cols-2 md:divide-x divide-[var(--color-border)]">
              <div className="divide-y divide-[var(--color-border)]">
                <p className="px-4 py-2 text-xs font-semibold text-[var(--color-text-primary)] bg-[var(--color-bg-secondary)]/30">
                  Repository sync
                </p>
                {activeSync.length > 0 && (
                  <>
                    <p className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary bg-sky-50/50">Active</p>
                    <ul>
                      {activeSync.map((job) => (
                        <DashboardSyncRow key={job.id} job={job} />
                      ))}
                    </ul>
                  </>
                )}
                {doneSync.length > 0 && (
                  <>
                    {activeSync.length > 0 && (
                      <p className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
                        Recent
                      </p>
                    )}
                    <ul>
                      {doneSync.map((job) => (
                        <DashboardSyncRow key={job.id} job={job} />
                      ))}
                    </ul>
                  </>
                )}
                {syncJobs.length === 0 && (
                  <p className="px-4 py-3 text-sm text-[var(--color-text-secondary)]">No sync jobs yet.</p>
                )}
              </div>
              <div className="divide-y divide-[var(--color-border)] md:border-t-0 border-t border-[var(--color-border)]">
                <p className="px-4 py-2 text-xs font-semibold text-[var(--color-text-primary)] bg-[var(--color-bg-secondary)]/30">
                  Documentation
                </p>
                {activeDoc.length > 0 && (
                  <>
                    <p className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary bg-violet-50/50">Active</p>
                    <ul>
                      {activeDoc.map((job) => (
                        <DashboardDocRow key={job.id} job={job} />
                      ))}
                    </ul>
                  </>
                )}
                {doneDoc.length > 0 && (
                  <>
                    {activeDoc.length > 0 && (
                      <p className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
                        Recent
                      </p>
                    )}
                    <ul>
                      {doneDoc.map((job) => (
                        <DashboardDocRow key={job.id} job={job} />
                      ))}
                    </ul>
                  </>
                )}
                {docJobs.length === 0 && (
                  <p className="px-4 py-3 text-sm text-[var(--color-text-secondary)]">No documentation jobs yet.</p>
                )}
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}

function DashboardSyncRow({ job }: { job: SyncJob }) {
  const errorText = syncJobErrorForDisplay(job.error_message)
  const running = job.status === 'running'
  return (
    <li className="px-4 py-3 text-sm border-b border-[var(--color-border)] last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-[var(--color-text-tertiary)] font-mono" title={job.id}>
          {job.id.slice(0, 8)}…
        </span>
        <span
          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
            job.status === 'succeeded'
              ? 'bg-emerald-100 text-emerald-900'
              : job.status === 'failed'
                ? 'bg-red-100 text-red-900'
                : job.status === 'running'
                  ? 'bg-sky-100 text-sky-900'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
          }`}
        >
          {syncJobStatusLabel(job.status)}
        </span>
        <span className="text-xs text-[var(--color-text-secondary)]">{job.branch}</span>
      </div>
      <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1">
        {new Date(job.created_at).toLocaleString()}
        {job.completed_at && ` · ${new Date(job.completed_at).toLocaleString()}`}
      </p>
      {running && (
        <div className="mt-2 h-1 rounded-full bg-sky-100 overflow-hidden" aria-hidden>
          <div className="h-full w-full bg-sky-400/70 rounded-full animate-pulse" />
        </div>
      )}
      {errorText &&
        (errorText.length <= 160 ? (
          <p className="text-[11px] text-red-700 mt-1.5 leading-relaxed">{errorText}</p>
        ) : (
          <details className="mt-2 rounded-md border border-red-100 bg-red-50/50 px-2 py-1.5">
            <summary className="cursor-pointer list-none text-[11px] font-semibold text-red-900 [&::-webkit-details-marker]:hidden">
              Show details
            </summary>
            <p className="text-[11px] text-red-800/95 mt-2 leading-relaxed whitespace-pre-wrap">{errorText}</p>
          </details>
        ))}
    </li>
  )
}

function DashboardDocRow({ job }: { job: DocJob }) {
  const running = job.status === 'running'
  const friendly = job.status === 'failed' ? docJobErrorForDisplay(job.error_message) : null
  return (
    <li className="px-4 py-3 text-sm border-b border-[var(--color-border)] last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-[var(--color-text-tertiary)] font-mono" title={job.id}>
          {job.id.slice(0, 8)}…
        </span>
        <span
          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
            job.status === 'succeeded'
              ? 'bg-emerald-100 text-emerald-900'
              : job.status === 'failed'
                ? 'bg-red-100 text-red-900'
                : job.status === 'running'
                  ? 'bg-violet-100 text-violet-900'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
          }`}
        >
          {docJobStatusLabel(job.status)}
        </span>
      </div>
      <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1">
        {new Date(job.created_at).toLocaleString()}
        {job.completed_at && ` · ${new Date(job.completed_at).toLocaleString()}`}
      </p>
      {running && (
        <div className="mt-2 h-1 rounded-full bg-violet-100 overflow-hidden" aria-hidden>
          <div className="h-full w-full bg-violet-400/70 rounded-full animate-pulse" />
        </div>
      )}
      {friendly &&
        (friendly.length <= 160 ? (
          <p className="text-[11px] text-red-700 mt-1.5 leading-relaxed">{friendly}</p>
        ) : (
          <details className="mt-2 rounded-md border border-red-100 bg-red-50/50 px-2 py-1.5">
            <summary className="cursor-pointer list-none text-[11px] font-semibold text-red-900 [&::-webkit-details-marker]:hidden">
              Show details
            </summary>
            <p className="text-[11px] text-red-800/95 mt-2 leading-relaxed whitespace-pre-wrap">{friendly}</p>
          </details>
        ))}
    </li>
  )
}
