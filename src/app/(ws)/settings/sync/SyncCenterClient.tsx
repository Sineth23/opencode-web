'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { authorizedFetch } from '@/lib/api'
import { useWorkspace } from '@/components/providers/WorkspaceContext'
import BitbucketSyncSection from '@/components/settings/BitbucketSyncSection'
import { setDashboardFlashMessage } from '@/lib/dashboard-flash'
import {
  docJobErrorForDisplay,
  docJobStatusLabel,
  syncJobErrorForDisplay,
  syncJobStatusLabel,
} from '@/lib/sync-job-copy'
import { PURGE_GUIDED_DOCS_CONFIRM_PHRASE } from '@/lib/purge-guided-confirm'
import { withSupportContact } from '@/lib/support-copy'
import { Skeleton } from '@/components/ui/Skeleton'

type SyncJob = {
  id: string
  status: string
  branch: string
  error_message: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  meta: Record<string, unknown> | null
}

type DocJob = {
  id: string
  status: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  error_message: string | null
}

type AccessFeatures = {
  trigger_sync: boolean
  queue_doc_refresh: boolean
}

type ScopeBranch = { branch: string; chunk_count: number }
type ScopeRepo = {
  id: string
  name: string
  slug: string
  default_branch: string
  branches: ScopeBranch[]
}

type Flash = { kind: 'success' | 'error'; text: string }

type KnowledgeHealth = {
  chunks: { total: number; scope_available: boolean; branch_scopes: number }
  overview_last: {
    status: string
    sync_branch: string
    repository_id: string
    started_at: string
    completed_at: string | null
    error_message: string | null
    repo_slug: string | null
  } | null
  guided_doc_last: {
    status: string
    created_at: string
    started_at: string | null
    completed_at: string | null
    error_message: string | null
  } | null
  guided_section_count: number | null
}

const POLL_ACTIVE_MS = 5000
const POLL_IDLE_MS = 20000
/** Must cover large “sync all branches” batches; list is ordered newest-first. */
const SYNC_CENTER_SYNC_LIST_LIMIT = 400
const SYNC_CENTER_DOC_LIST_LIMIT = 300

function formatActivityWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export default function SyncCenterClient() {
  const { workspace, refresh: refreshWorkspace } = useWorkspace()
  const [syncJobs, setSyncJobs] = useState<SyncJob[]>([])
  const [docJobs, setDocJobs] = useState<DocJob[]>([])
  const [access, setAccess] = useState<AccessFeatures | null>(null)
  const [canPurgeKnowledge, setCanPurgeKnowledge] = useState(false)
  const [bbStatus, setBbStatus] = useState<{
    connected: boolean
    updated_at: string | null
    connected_via_env_token_only?: boolean
  } | null>(null)
  const [docBusy, setDocBusy] = useState(false)
  const [docScopeRepos, setDocScopeRepos] = useState<ScopeRepo[]>([])
  const [docRepoId, setDocRepoId] = useState('')
  const [docBranch, setDocBranch] = useState('')
  const [docAudience, setDocAudience] = useState('')
  const [docDepth, setDocDepth] = useState<'org' | 'overview' | 'standard' | 'deep'>('org')
  const [flash, setFlash] = useState<Flash | null>(null)
  const [loading, setLoading] = useState(true)
  const [isLocalDev, setIsLocalDev] = useState(false)
  const [docAdvOpen, setDocAdvOpen] = useState(false)
  const [purgeModalOpen, setPurgeModalOpen] = useState(false)
  const [purgeConfirmName, setPurgeConfirmName] = useState('')
  const [purgeBusy, setPurgeBusy] = useState(false)
  const [purgeError, setPurgeError] = useState<string | null>(null)
  const [repoPurge, setRepoPurge] = useState<null | { id: string; slug: string; name: string; removeLink: boolean }>(null)
  const [repoPurgeSlugConfirm, setRepoPurgeSlugConfirm] = useState('')
  const [repoPurgeBusy, setRepoPurgeBusy] = useState(false)
  const [repoPurgeError, setRepoPurgeError] = useState<string | null>(null)
  const [guidedPurgeOpen, setGuidedPurgeOpen] = useState(false)
  const [guidedPurgeConfirm, setGuidedPurgeConfirm] = useState('')
  const [guidedPurgeBusy, setGuidedPurgeBusy] = useState(false)
  const [guidedPurgeError, setGuidedPurgeError] = useState<string | null>(null)
  const [health, setHealth] = useState<KnowledgeHealth | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [syncMutateBusyId, setSyncMutateBusyId] = useState<string | null>(null)
  const [stopAllSyncBusy, setStopAllSyncBusy] = useState(false)
  const [abandonAllSyncBusy, setAbandonAllSyncBusy] = useState(false)
  const [stopAllDocBusy, setStopAllDocBusy] = useState(false)

  const loadJobs = useCallback(async () => {
    if (!workspace?.id) return
    try {
      const [jRes, dRes, hRes] = await Promise.all([
        authorizedFetch(
          `/api/sync/status?workspace_id=${workspace.id}&limit=${SYNC_CENTER_SYNC_LIST_LIMIT}`
        ),
        authorizedFetch(
          `/api/workspace/doc-jobs?workspace_id=${workspace.id}&limit=${SYNC_CENTER_DOC_LIST_LIMIT}`
        ),
        authorizedFetch(`/api/workspace/knowledge-health?workspace_id=${workspace.id}`),
      ])
      if (jRes.ok) {
        const j = (await jRes.json()) as { jobs: SyncJob[] }
        setSyncJobs(j.jobs ?? [])
      }
      if (dRes.ok) {
        const d = (await dRes.json()) as { jobs: DocJob[] }
        setDocJobs(d.jobs ?? [])
      }
      if (hRes.ok) {
        const h = (await hRes.json()) as KnowledgeHealth
        setHealth(h)
        setHealthError(null)
      } else {
        const errBody = (await hRes.json().catch(() => ({}))) as { error?: string }
        setHealth(null)
        setHealthError(
          withSupportContact(
            typeof errBody.error === 'string' ? errBody.error : 'Could not load knowledge snapshot.'
          )
        )
      }
    } catch (e) {
      console.error(e)
    }
  }, [workspace?.id])

  const mutateSyncJob = useCallback(
    async (jobId: string, action: 'cancel' | 'abandon' | 'remove' | 'delete_log') => {
      if (!workspace?.id) return
      setSyncMutateBusyId(jobId)
      try {
        const res = await authorizedFetch('/api/workspace/sync-jobs/mutate', {
          method: 'POST',
          body: JSON.stringify({ workspace_id: workspace.id, job_id: jobId, action }),
        })
        const j = (await res.json()) as { error?: string; detail?: string; ok?: boolean }
        if (!res.ok) {
          setFlash({ kind: 'error', text: withSupportContact(j.error || 'Could not update this job.') })
        } else {
          setFlash({ kind: 'success', text: typeof j.detail === 'string' ? j.detail : 'Done.' })
          void loadJobs()
        }
      } catch {
        setFlash({ kind: 'error', text: withSupportContact('Request failed. Try again.') })
      } finally {
        setSyncMutateBusyId(null)
      }
    },
    [workspace?.id, loadJobs]
  )

  const stopAllActiveSyncJobs = useCallback(async () => {
    if (!workspace?.id) return
    setStopAllSyncBusy(true)
    try {
      const res = await authorizedFetch('/api/workspace/sync-jobs/cancel-all', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: workspace.id }),
      })
      const j = (await res.json()) as { error?: string; detail?: string }
      if (!res.ok) {
        setFlash({ kind: 'error', text: withSupportContact(j.error || 'Could not stop content updates.') })
      } else {
        setFlash({ kind: 'success', text: j.detail || 'Done.' })
        void loadJobs()
      }
    } catch {
      setFlash({ kind: 'error', text: withSupportContact('Request failed. Try again.') })
    } finally {
      setStopAllSyncBusy(false)
    }
  }, [workspace?.id, loadJobs])

  const abandonAllRunningSyncJobs = useCallback(async () => {
    if (!workspace?.id) return
    if (
      !confirm(
        'Clear all active and waiting sync jobs?\n\nThis cancels every in-progress and queued content update. Nothing will run again until you queue a new sync.'
      )
    ) {
      return
    }
    setAbandonAllSyncBusy(true)
    try {
      const res = await authorizedFetch('/api/workspace/sync-jobs/cancel-all', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: workspace.id, force_abandon_running: true }),
      })
      const j = (await res.json()) as { error?: string; detail?: string }
      if (!res.ok) {
        setFlash({ kind: 'error', text: withSupportContact(j.error || 'Could not clear in-progress jobs.') })
      } else {
        setFlash({ kind: 'success', text: j.detail || 'Done.' })
        void loadJobs()
      }
    } catch {
      setFlash({ kind: 'error', text: withSupportContact('Request failed. Try again.') })
    } finally {
      setAbandonAllSyncBusy(false)
    }
  }, [workspace?.id, loadJobs])

  const stopAllActiveDocJobs = useCallback(async () => {
    if (!workspace?.id) return
    setStopAllDocBusy(true)
    try {
      const res = await authorizedFetch('/api/workspace/doc-jobs/cancel-all', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: workspace.id }),
      })
      const j = (await res.json()) as { error?: string; detail?: string }
      if (!res.ok) {
        setFlash({ kind: 'error', text: withSupportContact(j.error || 'Could not stop documentation refreshes.') })
      } else {
        setFlash({ kind: 'success', text: j.detail || 'Done.' })
        void loadJobs()
      }
    } catch {
      setFlash({ kind: 'error', text: withSupportContact('Request failed. Try again.') })
    } finally {
      setStopAllDocBusy(false)
    }
  }, [workspace?.id, loadJobs])

  const syncActive = syncJobs.some((j) => j.status === 'queued' || j.status === 'running')
  const docActive = docJobs.some((j) => j.status === 'queued' || j.status === 'running')
  const hasActiveWork = syncActive || docActive

  useEffect(() => {
    if (typeof window === 'undefined') return
    const h = window.location.hostname
    setIsLocalDev(h === 'localhost' || h === '127.0.0.1')
  }, [])

  useEffect(() => {
    if (!workspace?.id) return
    const ms = hasActiveWork ? POLL_ACTIVE_MS : POLL_IDLE_MS
    const id = window.setInterval(() => void loadJobs(), ms)
    return () => window.clearInterval(id)
  }, [workspace?.id, hasActiveWork, loadJobs])

  useEffect(() => {
    if (!flash) return
    const t = window.setTimeout(() => setFlash(null), 14000)
    return () => window.clearTimeout(t)
  }, [flash])

  const loadSyncCenterPanels = useCallback(async () => {
    if (!workspace?.id) return
    setLoading(true)
    setCanPurgeKnowledge(false)
    try {
      const [jRes, dRes, aRes, stRes, scRes, hRes] = await Promise.all([
        authorizedFetch(`/api/sync/status?workspace_id=${workspace.id}&limit=${SYNC_CENTER_SYNC_LIST_LIMIT}`),
        authorizedFetch(`/api/workspace/doc-jobs?workspace_id=${workspace.id}&limit=${SYNC_CENTER_DOC_LIST_LIMIT}`),
        authorizedFetch(`/api/workspace/access?workspace_id=${workspace.id}`),
        authorizedFetch(`/api/integrations/bitbucket/status?workspace_id=${workspace.id}`),
        authorizedFetch(`/api/workspace/knowledge-scope?workspace_id=${workspace.id}`),
        authorizedFetch(`/api/workspace/knowledge-health?workspace_id=${workspace.id}`),
      ])
      if (jRes.ok) {
        const j = (await jRes.json()) as { jobs: SyncJob[] }
        setSyncJobs(j.jobs ?? [])
      }
      if (dRes.ok) {
        const d = (await dRes.json()) as { jobs: DocJob[] }
        setDocJobs(d.jobs ?? [])
      }
      if (aRes.ok) {
        const a = (await aRes.json()) as {
          effective_features: AccessFeatures
          role: 'owner' | 'admin' | 'member'
        }
        setAccess(a.effective_features)
        setCanPurgeKnowledge(a.role === 'owner' || a.role === 'admin')
      }
      if (stRes.ok) {
        const s = (await stRes.json()) as {
          connected: boolean
          updated_at: string | null
          connected_via_env_token_only?: boolean
        }
        setBbStatus(s)
      }
      if (scRes.ok) {
        const sc = (await scRes.json()) as { repositories?: ScopeRepo[] }
        setDocScopeRepos(sc.repositories ?? [])
      }
      if (hRes.ok) {
        const h = (await hRes.json()) as KnowledgeHealth
        setHealth(h)
        setHealthError(null)
      } else {
        const errBody = (await hRes.json().catch(() => ({}))) as { error?: string }
        setHealth(null)
        setHealthError(
          withSupportContact(
            typeof errBody.error === 'string' ? errBody.error : 'Could not load knowledge snapshot.'
          )
        )
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [workspace?.id])

  useEffect(() => {
    void loadSyncCenterPanels()
  }, [loadSyncCenterPanels])

  useEffect(() => {
    if (!purgeModalOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPurgeModalOpen(false)
        setPurgeConfirmName('')
        setPurgeError(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [purgeModalOpen])

  useEffect(() => {
    if (!repoPurge) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !repoPurgeBusy) {
        setRepoPurge(null)
        setRepoPurgeSlugConfirm('')
        setRepoPurgeError(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [repoPurge, repoPurgeBusy])

  useEffect(() => {
    if (!guidedPurgeOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !guidedPurgeBusy) {
        setGuidedPurgeOpen(false)
        setGuidedPurgeConfirm('')
        setGuidedPurgeError(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [guidedPurgeOpen, guidedPurgeBusy])

  const openPurgeModal = () => {
    setPurgeConfirmName('')
    setPurgeError(null)
    setPurgeModalOpen(true)
  }

  const runGuidedPurge = async () => {
    if (!workspace?.id) return
    setGuidedPurgeBusy(true)
    setGuidedPurgeError(null)
    try {
      const res = await authorizedFetch('/api/workspace/purge-guided-docs', {
        method: 'POST',
        body: JSON.stringify({
          workspace_id: workspace.id,
          confirm_phrase: guidedPurgeConfirm,
        }),
      })
      const j = (await res.json()) as { error?: string; detail?: string }
      if (!res.ok) {
        setGuidedPurgeError(
          withSupportContact(typeof j.error === 'string' ? j.error : 'Could not remove guided articles.'),
        )
        return
      }
      const text = j.detail ?? 'Guided articles removed.'
      setFlash({ kind: 'success', text })
      setDashboardFlashMessage({ kind: 'success', text })
      setGuidedPurgeOpen(false)
      setGuidedPurgeConfirm('')
      void loadSyncCenterPanels()
      void loadJobs()
    } catch {
      setGuidedPurgeError(withSupportContact('Request failed. Try again.'))
    } finally {
      setGuidedPurgeBusy(false)
    }
  }

  const runPurgeRepository = async () => {
    if (!workspace?.id || !repoPurge) return
    setRepoPurgeBusy(true)
    setRepoPurgeError(null)
    try {
      const res = await authorizedFetch('/api/workspace/purge-repository', {
        method: 'POST',
        body: JSON.stringify({
          workspace_id: workspace.id,
          repository_id: repoPurge.id,
          confirm_repository_slug: repoPurgeSlugConfirm,
          remove_link: repoPurge.removeLink,
        }),
      })
      const j = (await res.json()) as { error?: string; detail?: string }
      if (!res.ok) {
        setRepoPurgeError(withSupportContact(typeof j.error === 'string' ? j.error : 'Could not remove repository data.'))
        return
      }
      const text = j.detail || 'Repository data removed.'
      setFlash({ kind: 'success', text })
      setDashboardFlashMessage({ kind: 'success', text })
      setRepoPurge(null)
      setRepoPurgeSlugConfirm('')
      if (docRepoId === repoPurge.id) setDocRepoId('')
      void loadJobs()
      void loadSyncCenterPanels()
      void refreshWorkspace()
    } catch {
      setRepoPurgeError(withSupportContact('Request failed. Try again.'))
    } finally {
      setRepoPurgeBusy(false)
    }
  }

  const runPurgeKnowledge = async () => {
    if (!workspace?.id || !workspace.name) return
    setPurgeBusy(true)
    setPurgeError(null)
    try {
      const res = await authorizedFetch('/api/workspace/purge-knowledge', {
        method: 'POST',
        body: JSON.stringify({
          workspace_id: workspace.id,
          confirm_workspace_name: purgeConfirmName,
        }),
      })
      const j = (await res.json()) as { error?: string; detail?: string }
      if (!res.ok) {
        setPurgeError(withSupportContact(typeof j.error === 'string' ? j.error : 'Could not erase workspace data.'))
        return
      }
      const text = j.detail || 'Workspace knowledge and generated content have been erased.'
      setFlash({ kind: 'success', text })
      setDashboardFlashMessage({ kind: 'success', text })
      setPurgeModalOpen(false)
      setPurgeConfirmName('')
      void loadJobs()
      void loadSyncCenterPanels()
      void refreshWorkspace()
    } catch {
      setPurgeError(withSupportContact('Request failed. Try again.'))
    } finally {
      setPurgeBusy(false)
    }
  }

  const purgeNameMatches = Boolean(
    workspace?.name && purgeConfirmName.trim() === workspace.name.trim(),
  )

  const repoSlugMatches = Boolean(
    repoPurge && repoPurgeSlugConfirm.trim() === repoPurge.slug.trim(),
  )

  const guidedPhraseMatches =
    guidedPurgeConfirm.trim() === PURGE_GUIDED_DOCS_CONFIRM_PHRASE.trim()

  const docBranchesForRepo =
    docRepoId === '' ? [] : (docScopeRepos.find((r) => r.id === docRepoId)?.branches ?? [])

  const runDocGen = async (scope: 'workspace' | 'scoped') => {
    if (!workspace?.id) return
    setDocBusy(true)
    try {
      const body: Record<string, string> = { workspace_id: workspace.id }
      if (scope === 'scoped') {
        if (docRepoId) body.repository_id = docRepoId
        if (docRepoId && docBranch.trim()) body.branch = docBranch.trim()
        if (docAudience.trim()) body.target_audience = docAudience.trim()
        if (docDepth !== 'org') body.content_depth = docDepth
      }

      const res = await authorizedFetch('/api/docs/generate', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const j = (await res.json()) as { error?: string; detail?: string }
      if (!res.ok) {
        setFlash({ kind: 'error', text: withSupportContact(j.error || 'Could not start documentation refresh.') })
      } else {
        const text =
          j.detail ||
          'Documentation refresh is queued. Watch progress below or in the blue bar at the top of the app.'
        setFlash({ kind: 'success', text })
        setDashboardFlashMessage({ kind: 'success', text })
        void loadJobs()
      }
    } catch {
      setFlash({ kind: 'error', text: withSupportContact('Could not start documentation refresh.') })
    } finally {
      setDocBusy(false)
    }
  }

  const connected = bbStatus?.connected === true
  const canManageSyncJobs = Boolean(workspace?.id && access?.trigger_sync)
  const canManageDocJobs = Boolean(workspace?.id && access?.queue_doc_refresh)

  const activeSync = syncJobs.filter((j) => j.status === 'queued' || j.status === 'running')
  const doneSync = syncJobs.filter((j) => j.status !== 'queued' && j.status !== 'running')
  const activeDoc = docJobs.filter((j) => j.status === 'queued' || j.status === 'running')
  const doneDoc = docJobs.filter((j) => j.status !== 'queued' && j.status !== 'running')

  return (
    <div className="max-w-3xl mx-auto space-y-8 pb-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-primary mb-2">AutoDoc</p>
        <h1 className="text-3xl font-bold text-[var(--color-text-primary)] tracking-tight">Sync center</h1>
        <p className="mt-3 text-[var(--color-text-secondary)] leading-relaxed">
          Bring in the latest from your connected source, then refresh guided documentation when you want new articles. While
          something is running, the blue bar under the main menu shows status on every page. The summaries below stay up to
          date automatically.
        </p>
      </div>

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

      {loading && (
        <div className="space-y-8" aria-hidden="true">
          {/* Knowledge snapshot skeleton */}
          <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:p-6 shadow-sm space-y-4">
            <div>
              <Skeleton className="h-5 mb-2" style={{ width: '28%' }} />
              <Skeleton className="h-3" style={{ width: '60%' }} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[1,2,3,4].map((i) => (
                <div key={i} className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-4 py-3">
                  <Skeleton className="h-2.5 mb-3" style={{ width: '65%' }} />
                  <Skeleton className="h-7 mb-2" style={{ width: '45%' }} />
                  <Skeleton className="h-2.5" style={{ width: '55%' }} />
                </div>
              ))}
            </div>
          </div>
          {/* Action card skeleton */}
          <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:p-6 shadow-sm space-y-4">
            <Skeleton className="h-5 mb-2" style={{ width: '22%' }} />
            <Skeleton className="h-3" style={{ width: '50%' }} />
            <div className="flex gap-3 pt-2">
              <Skeleton className="h-10 rounded-[var(--radius-md)]" style={{ width: '140px' }} />
              <Skeleton className="h-10 rounded-[var(--radius-md)]" style={{ width: '120px' }} />
            </div>
          </div>
          {/* Job list skeleton */}
          <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:p-6 shadow-sm space-y-3">
            <Skeleton className="h-5 mb-3" style={{ width: '30%' }} />
            {[1,2,3].map((i) => (
              <div key={i} className="flex items-center gap-4 py-3 border-b border-[var(--color-border)]/60">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-3 flex-1" style={{ maxWidth: '45%' }} />
                <Skeleton className="h-3" style={{ width: '80px' }} />
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && workspace?.id && (
        <section className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:p-6 shadow-sm space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">Knowledge snapshot</h2>
              <p className="text-xs text-[var(--color-text-tertiary)] mt-1 leading-relaxed max-w-2xl">
                Live counts from your workspace. No need to open the database; counts refresh with the activity lists below.
              </p>
            </div>
          </div>
          {healthError ? (
            <div className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-950">
              {healthError}
            </div>
          ) : health ? (
            <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
                  Indexed chunks
                </p>
                <p className="text-2xl font-bold text-[var(--color-text-primary)] mt-1 tabular-nums">
                  {health.chunks.total.toLocaleString()}
                </p>
                <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5">
                  {health.chunks.branch_scopes} repo/branch scope{health.chunks.branch_scopes === 1 ? '' : 's'}
                </p>
              </div>
              <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
                  Last sync job
                </p>
                {health.overview_last ? (
                  <>
                    <p className="mt-1 flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                          health.overview_last.status === 'succeeded'
                            ? 'bg-emerald-100 text-emerald-900'
                            : health.overview_last.status === 'failed'
                              ? 'bg-red-100 text-red-900'
                              : 'bg-sky-100 text-sky-900'
                        }`}
                      >
                        {syncJobStatusLabel(health.overview_last.status)}
                      </span>
                    </p>
                    <p className="text-xs text-[var(--color-text-secondary)] mt-2 leading-relaxed">
                      {(health.overview_last.repo_slug || health.overview_last.repository_id.slice(0, 8)) +
                        (health.overview_last.sync_branch ? ` · ${health.overview_last.sync_branch}` : '')}
                    </p>
                    <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1">
                      {health.overview_last.completed_at
                        ? formatActivityWhen(health.overview_last.completed_at)
                        : formatActivityWhen(health.overview_last.started_at)}
                    </p>
                    {health.overview_last.status === 'failed' && health.overview_last.error_message ? (
                      <p className="text-[11px] text-red-800/90 mt-2 line-clamp-3">{health.overview_last.error_message}</p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-[var(--color-text-secondary)] mt-2 leading-relaxed">
                    None yet. Completes automatically after a successful content update when processing is enabled.
                  </p>
                )}
              </div>
              <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
                  Last guided-doc job
                </p>
                {health.guided_doc_last ? (
                  <>
                    <p className="mt-1">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                          health.guided_doc_last.status === 'succeeded'
                            ? 'bg-emerald-100 text-emerald-900'
                            : health.guided_doc_last.status === 'failed'
                              ? 'bg-red-100 text-red-900'
                              : 'bg-sky-100 text-sky-900'
                        }`}
                      >
                        {docJobStatusLabel(health.guided_doc_last.status)}
                      </span>
                    </p>
                    <p className="text-[11px] text-[var(--color-text-tertiary)] mt-2">
                      {health.guided_doc_last.completed_at
                        ? formatActivityWhen(health.guided_doc_last.completed_at)
                        : formatActivityWhen(health.guided_doc_last.created_at)}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-[var(--color-text-secondary)] mt-2">None yet.</p>
                )}
              </div>
              <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
                  Guided articles saved
                </p>
                <p className="text-2xl font-bold text-[var(--color-text-primary)] mt-1 tabular-nums">
                  {health.guided_section_count != null ? health.guided_section_count.toLocaleString() : '-'}
                </p>
                <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5">Documentation → Guided</p>
              </div>
            </div>
            {canPurgeKnowledge && (health.guided_section_count ?? 0) > 0 ? (
              <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text-primary)]">Guided documentation</p>
                  <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5 leading-relaxed">
                    Delete every saved handbook article for this workspace (all repositories and branches). Your indexed
                    code and Bitbucket links stay. Queue a new refresh when you want articles again.
                  </p>
                </div>
                <button
                  type="button"
                  className="pk-btn-secondary text-sm shrink-0 min-h-[40px] px-4"
                  onClick={() => {
                    setGuidedPurgeOpen(true)
                    setGuidedPurgeConfirm('')
                    setGuidedPurgeError(null)
                  }}
                >
                  Clear all guided articles…
                </button>
              </div>
            ) : null}
            </>
          ) : null}

          <details className="rounded-[var(--radius-md)] border border-primary/20 bg-primary/5 px-4 py-3 group">
            <summary className="text-sm font-semibold text-[var(--color-text-primary)] cursor-pointer list-none flex items-center justify-between gap-2 marker:content-none [&::-webkit-details-marker]:hidden">
              <span>After embeddings are already in AutoDoc (next steps)</span>
              <span className="text-xs font-normal text-[var(--color-text-tertiary)] shrink-0 group-open:rotate-180 transition-transform">
                ▾
              </span>
            </summary>
            <ol className="mt-3 space-y-2 text-sm text-[var(--color-text-secondary)] list-decimal pl-5 leading-relaxed">
              <li>
                <strong className="text-[var(--color-text-primary)]">Engineering handbook:</strong> use{' '}
                <strong className="text-[var(--color-text-primary)]">Refresh all guided documentation</strong> below (or a scoped
                refresh). Wait until <strong className="text-[var(--color-text-primary)]">Last guided-doc job</strong> shows{' '}
                <strong className="text-[var(--color-text-primary)]">Completed</strong> and <strong className="text-[var(--color-text-primary)]">Guided articles saved</strong> updates.
              </li>
              <li>
                <strong className="text-[var(--color-text-primary)]">Read &amp; ask:</strong> open{' '}
                <Link href="/docs" className="text-primary font-medium hover:underline">
                  Documentation
                </Link>{' '}
                to browse the handbook, and use the{' '}
                <Link href="/assistant" className="text-primary font-medium hover:underline">
                  Assistant
                </Link>
                {' '}for grounded Q&amp;A: pick the same repository/branch for tighter answers.
              </li>
            </ol>
          </details>
        </section>
      )}

      {hasActiveWork && (
        <div className="rounded-[var(--radius-lg)] border border-sky-200 bg-sky-50/80 px-4 py-3 flex flex-wrap items-center gap-3 text-sm text-sky-950">
          <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-50" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-sky-500" />
          </span>
          <p className="font-medium">
            {syncActive && docActive
              ? 'Content updates and a documentation refresh are running.'
              : syncActive
                ? 'A content update from your source is running.'
                : 'A documentation refresh is running.'}
          </p>
          <p className="text-sky-800/90 text-xs w-full sm:w-auto sm:ml-auto">
            You can leave this page. The blue bar under the menu keeps you informed.
          </p>
        </div>
      )}

      {access && !access.trigger_sync && (
        <div className="rounded-[var(--radius-lg)] border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-950">
          You do not have permission to start new syncs. Ask an organization admin to update your role, or contact support.
        </div>
      )}

      <section className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:p-6 space-y-5 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">Content updates</h2>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1 leading-relaxed">
            Keep AutoDoc aligned with your product code. Most teams tap <strong className="font-medium text-[var(--color-text-primary)]">Sync all</strong> once
            repositories are saved. Open the options below to update a single project, pick a branch, or do a deeper rebuild.
            Connect your source under{' '}
            <Link href="/settings/integrations" className="text-primary font-medium hover:underline">
              Integrations
            </Link>{' '}
            first if you have not already.
          </p>
        </div>

        {bbStatus?.connected_via_env_token_only ? (
          <div className="rounded-[var(--radius-md)] border border-sky-200 bg-sky-50/80 px-4 py-3 text-sm text-sky-950 leading-relaxed">
            <strong className="font-semibold">Server-configured Bitbucket token active.</strong>{' '} This workspace syncs via a server-configured access token. Sign-in and sync work as normal, and repository discovery runs automatically.
          </div>
        ) : null}

        {workspace?.id && (
          <BitbucketSyncSection
            workspaceId={workspace.id}
            connected={connected}
            canSync={Boolean(access?.trigger_sync)}
            onSyncQueued={() => {
              const text = 'Update queued. Follow progress below or in the blue bar at the top of the app.'
              setFlash({ kind: 'success', text })
              setDashboardFlashMessage({ kind: 'success', text })
              void loadJobs()
            }}
            onBulkSyncQueued={(n, kind) => {
              const text =
                kind === 'branches'
                  ? `${n} branch sync${n === 1 ? '' : 's'} queued (one job per branch). Follow progress below or in the blue bar.`
                  : n === 1
                    ? 'Update queued. Follow progress below or in the blue bar at the top of the app.'
                    : `${n} updates queued: one per saved repository. Follow progress below or in the blue bar.`
              setFlash({ kind: 'success', text })
              setDashboardFlashMessage({ kind: 'success', text })
              void loadJobs()
            }}
          />
        )}
      </section>

      <section className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:p-6 space-y-5 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">Engineering handbook</h2>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1 leading-relaxed">
            Regenerate the articles on the{' '}
            <Link href="/docs" className="text-primary font-medium hover:underline">
              Documentation
            </Link>{' '}
            page. Each run produces a rich, multi-chapter handbook covering system overview, features, workflows, configuration, integrations, and more: all grounded in your indexed code. Built-in quality checks ensure nothing incomplete is saved; jobs retry automatically if needed.{' '}
            <strong className="font-medium text-[var(--color-text-primary)]">Refresh all</strong>{' '}
            rebuilds workspace-wide guides. Use the options below to scope to one repository or branch, or to change audience and depth.
          </p>
        </div>

        <div className="rounded-[var(--radius-lg)] border border-violet-200/60 bg-violet-50/40 px-4 py-4 space-y-3">
          <p className="text-sm font-semibold text-[var(--color-text-primary)]">Refresh everything (recommended)</p>
          <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
            Workspace-wide guided articles using your organization&apos;s default audience and depth. Best run right after a
            content update so articles reflect the latest code.
          </p>
          <button
            type="button"
            className="pk-btn-primary w-full sm:w-auto min-h-[44px] px-6"
            disabled={docBusy || !access?.queue_doc_refresh}
            onClick={() => void runDocGen('workspace')}
          >
            {docBusy ? 'Queueing…' : 'Refresh all guided documentation'}
          </button>
        </div>

        <details
          className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden group"
          open={docAdvOpen}
          onToggle={(e) => setDocAdvOpen(e.currentTarget.open)}
        >
          <summary className="px-4 py-3 text-sm font-semibold text-[var(--color-text-primary)] cursor-pointer list-none flex items-center justify-between gap-2 marker:content-none [&::-webkit-details-marker]:hidden">
            <span>Refresh one repository, branch, or persona settings</span>
            <span className="text-xs font-normal text-[var(--color-text-tertiary)] shrink-0 group-open:rotate-180 transition-transform">
              ▾
            </span>
          </summary>
          <div className="px-4 pb-4 pt-0 space-y-4 border-t border-[var(--color-border)]">
            <div className="pt-4 flex flex-col gap-3 w-full sm:flex-row sm:flex-wrap sm:items-end">
              <div className="flex flex-col gap-1 min-w-[11rem] flex-1">
                <span className="text-xs font-medium text-[var(--color-text-secondary)]">Repository</span>
                <select
                  value={docRepoId}
                  onChange={(e) => {
                    setDocRepoId(e.target.value)
                    setDocBranch('')
                  }}
                  className="text-sm rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-2 bg-[var(--color-surface)] w-full max-w-[20rem]"
                >
                  <option value="">All repositories (workspace-wide)</option>
                  {docScopeRepos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name || r.slug}
                    </option>
                  ))}
                </select>
              </div>
              {docRepoId !== '' && (
                <div className="flex flex-col gap-1 min-w-[11rem] flex-1">
                  <span className="text-xs font-medium text-[var(--color-text-secondary)]">Branch</span>
                  <select
                    value={docBranch}
                    onChange={(e) => setDocBranch(e.target.value)}
                    className="text-sm rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-2 bg-[var(--color-surface)] w-full max-w-[20rem]"
                  >
                    <option value="">All branches with data</option>
                    {docBranchesForRepo.map((b) => (
                      <option key={b.branch} value={b.branch}>
                        {b.branch}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex flex-col gap-1 min-w-[11rem] flex-1 max-w-[22rem]">
                <span className="text-xs font-medium text-[var(--color-text-secondary)]">Audience (optional)</span>
                <input
                  type="text"
                  value={docAudience}
                  onChange={(e) => setDocAudience(e.target.value)}
                  placeholder="Org default if empty"
                  className="text-sm rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-2 bg-[var(--color-surface)] w-full"
                />
              </div>
              <div className="flex flex-col gap-1 min-w-[11rem]">
                <span className="text-xs font-medium text-[var(--color-text-secondary)]">Depth</span>
                <select
                  value={docDepth}
                  onChange={(e) => setDocDepth(e.target.value as typeof docDepth)}
                  className="text-sm rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-2 bg-[var(--color-surface)] w-full max-w-[16rem]"
                >
                  <option value="org">Org default</option>
                  <option value="overview">Overview</option>
                  <option value="standard">Standard</option>
                  <option value="deep">Deep dive</option>
                </select>
              </div>
              <button
                type="button"
                className="pk-btn-secondary shrink-0"
                disabled={docBusy || !access?.queue_doc_refresh}
                onClick={() => void runDocGen('scoped')}
              >
                {docBusy ? 'Queueing…' : 'Queue refresh for this scope'}
              </button>
            </div>
          </div>
        </details>
      </section>

      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden shadow-sm">
        <div className="px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-[var(--color-text-primary)]">Content update status</h2>
          <p className="text-xs text-[var(--color-text-tertiary)] mt-2 leading-relaxed">
            <strong className="font-medium text-[var(--color-text-secondary)]">Waiting</strong> means your update is queued.{' '}
            <strong className="font-medium text-[var(--color-text-secondary)]">In progress</strong> means AutoDoc is actively pulling in
            changes. Each row can be <strong className="font-medium text-[var(--color-text-secondary)]">stopped</strong> or{' '}
            <strong className="font-medium text-[var(--color-text-secondary)]">removed</strong> from this list. If a job appears stuck in progress,
            use <strong className="font-medium text-[var(--color-text-secondary)]">Clear stuck in DB</strong> to reset it,
            then contact your administrator if it recurs. Open the full activity log for older runs.
          </p>
          </div>
          {!loading && activeSync.length > 0 && canManageSyncJobs ? (
            <div className="flex flex-wrap gap-2 shrink-0">
              <button
                type="button"
                className="pk-btn-secondary text-sm min-h-[40px] px-4"
                disabled={stopAllSyncBusy || abandonAllSyncBusy || Boolean(syncMutateBusyId)}
                onClick={() => void stopAllActiveSyncJobs()}
              >
                {stopAllSyncBusy ? 'Stopping…' : `Stop all active (${activeSync.length})`}
              </button>
              <button
                type="button"
                className="text-sm min-h-[40px] px-4 rounded-[var(--radius-md)] border border-amber-600/50 bg-amber-50 text-amber-950 font-medium hover:bg-amber-100 disabled:opacity-50"
                disabled={stopAllSyncBusy || abandonAllSyncBusy || Boolean(syncMutateBusyId)}
                onClick={() => void abandonAllRunningSyncJobs()}
                title="Use when the worker was closed or jobs are stuck in progress"
              >
                {abandonAllSyncBusy ? 'Clearing…' : 'Clear stuck in DB'}
              </button>
            </div>
          ) : null}
        </div>
        {!loading && activeSync.some((j) => j.status === 'queued') && (
          <div className="px-5 py-3 border-b border-amber-200/90 bg-amber-50/70 text-sm text-amber-950 leading-relaxed">
            <span className="font-semibold">Waiting</span> is normal: your update will start shortly. If it stays that way for a
            long time, your deployment may need processing turned on.
            {isLocalDev ? (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer font-medium text-amber-900">Developing on this computer?</summary>
                <p className="mt-2 pl-1">
                  Run <code className="bg-white/70 px-1 rounded">npm run worker:ingest</code> in a separate terminal so queued
                  updates can finish.
                </p>
              </details>
            ) : null}
          </div>
        )}
        {loading ? (
          <p className="p-5 text-sm text-[var(--color-text-tertiary)]">Loading…</p>
        ) : syncJobs.length === 0 ? (
          <p className="p-5 text-sm text-[var(--color-text-secondary)] leading-relaxed">
            No activity yet. Start an update above: summary and timing will appear here.
          </p>
        ) : (
          <>
            <div className="p-5 space-y-5">
              {activeSync.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-primary mb-2">Right now</p>
                  <ul className="rounded-[var(--radius-md)] border border-[var(--color-border)] divide-y divide-[var(--color-border)] bg-[var(--color-bg-secondary)]/20">
                    {activeSync.map((job) => (
                      <CompactSyncJobRow
                        key={job.id}
                        job={job}
                        canManage={canManageSyncJobs}
                        busyId={syncMutateBusyId}
                        onMutate={(id, act) => void mutateSyncJob(id, act)}
                      />
                    ))}
                  </ul>
                </div>
              )}
              {doneSync[0] && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)] mb-2">
                    {activeSync.length > 0 ? 'Most recent finished update' : 'Latest update'}
                  </p>
                  <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                    <CompactSyncJobRow
                      job={doneSync[0]}
                      as="div"
                      canManage={canManageSyncJobs}
                      busyId={syncMutateBusyId}
                      onMutate={(id, act) => void mutateSyncJob(id, act)}
                    />
                  </div>
                </div>
              )}
              {!doneSync[0] && activeSync.length === 0 && syncJobs[0] && (
                <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                  <CompactSyncJobRow
                    job={syncJobs[0]}
                    as="div"
                    canManage={canManageSyncJobs}
                    busyId={syncMutateBusyId}
                    onMutate={(id, act) => void mutateSyncJob(id, act)}
                  />
                </div>
              )}
            </div>
            {syncJobs.length > 1 ? (
              <details className="group border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/20">
                <summary className="px-5 py-3 text-sm font-semibold text-primary cursor-pointer list-none flex items-center justify-between gap-2 marker:content-none [&::-webkit-details-marker]:hidden">
                  <span>Full activity log ({syncJobs.length} updates)</span>
                  <span className="text-xs font-normal text-[var(--color-text-tertiary)] group-open:rotate-180 transition-transform">
                    ▾
                  </span>
                </summary>
                <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
                  {syncJobs.map((job) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      canManage={canManageSyncJobs}
                      busyId={syncMutateBusyId}
                      onMutate={(id, act) => void mutateSyncJob(id, act)}
                    />
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden shadow-sm">
        <div className="px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-[var(--color-text-primary)]">Documentation refresh status</h2>
          <p className="text-xs text-[var(--color-text-tertiary)] mt-2 leading-relaxed">
            Each entry is a guided-documentation run from the section above. When one shows{' '}
            <strong className="font-medium text-[var(--color-text-secondary)]">Completed</strong>, open{' '}
            <Link href="/docs" className="text-primary font-medium hover:underline">
              Documentation
            </Link>{' '}
            for the scope you chose. Expand the log to review older runs.
          </p>
          </div>
          {!loading && activeDoc.length > 0 && canManageDocJobs ? (
            <button
              type="button"
              className="pk-btn-secondary text-sm shrink-0 min-h-[40px] px-4"
              disabled={stopAllDocBusy}
              onClick={() => void stopAllActiveDocJobs()}
            >
              {stopAllDocBusy ? 'Stopping…' : `Stop all active (${activeDoc.length})`}
            </button>
          ) : null}
        </div>
        {loading ? (
          <p className="p-5 text-sm text-[var(--color-text-tertiary)]">Loading…</p>
        ) : docJobs.length === 0 ? (
          <p className="p-5 text-sm text-[var(--color-text-secondary)] leading-relaxed">
            No refreshes yet. Use <strong className="font-medium text-[var(--color-text-primary)]">Refresh all guided documentation</strong>{' '}
            above to start.
          </p>
        ) : (
          <>
            <div className="p-5 space-y-5">
              {activeDoc.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-primary mb-2">Right now</p>
                  <ul className="rounded-[var(--radius-md)] border border-[var(--color-border)] divide-y divide-[var(--color-border)] bg-[var(--color-bg-secondary)]/20">
                    {activeDoc.map((job) => (
                      <CompactDocJobRow key={job.id} job={job} />
                    ))}
                  </ul>
                </div>
              )}
              {doneDoc[0] && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)] mb-2">
                    {activeDoc.length > 0 ? 'Most recent finished refresh' : 'Latest refresh'}
                  </p>
                  <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                    <CompactDocJobRow job={doneDoc[0]} as="div" />
                  </div>
                </div>
              )}
              {!doneDoc[0] && activeDoc.length === 0 && docJobs[0] && (
                <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                  <CompactDocJobRow job={docJobs[0]} as="div" />
                </div>
              )}
            </div>
            {docJobs.length > 1 ? (
              <details className="group border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/20">
                <summary className="px-5 py-3 text-sm font-semibold text-primary cursor-pointer list-none flex items-center justify-between gap-2 marker:content-none [&::-webkit-details-marker]:hidden">
                  <span>Full refresh log ({docJobs.length} runs)</span>
                  <span className="text-xs font-normal text-[var(--color-text-tertiary)] group-open:rotate-180 transition-transform">
                    ▾
                  </span>
                </summary>
                <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
                  {docJobs.map((job) => (
                    <DocJobRow key={job.id} job={job} />
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </div>

      {canPurgeKnowledge && workspace?.id && docScopeRepos.length > 0 && (
        <section className="rounded-[var(--radius-lg)] border border-amber-200/90 bg-amber-50/35 p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-amber-950">Remove one repository</h2>
            <p className="text-sm text-amber-950/90 mt-1 leading-relaxed">
              Owners and admins can permanently delete everything AutoDoc has stored for a single linked project: searchable
              code chunks and embeddings, handbook sections tied to that repo, assistant threads scoped to it,
              mirror state, and sync/documentation job history for that project only. Other linked repositories are untouched.
            </p>
            <p className="text-xs text-amber-950/75 mt-2 leading-relaxed">
              <strong className="font-medium text-amber-950">Remove data</strong> keeps the saved Bitbucket link (last sync is
              cleared); run a new sync when you want content back. <strong className="font-medium text-amber-950">Remove and
              unlink</strong> also deletes the saved project from this workspace: you can add it again under Integrations.
            </p>
          </div>
          <ul className="divide-y divide-amber-200/80 rounded-[var(--radius-md)] border border-amber-200/80 bg-[var(--color-surface)] overflow-hidden">
            {docScopeRepos.map((r) => (
              <li key={r.id} className="px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--color-text-primary)] truncate">{r.name || r.slug}</p>
                  <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5">
                    Confirm with slug:{' '}
                    <code className="text-[11px] text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] px-1 py-0.5 rounded">
                      {r.slug}
                    </code>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 shrink-0">
                  <button
                    type="button"
                    className="text-xs font-semibold rounded-[var(--radius-md)] border border-amber-700/35 bg-white px-3 py-2 text-amber-950 hover:bg-amber-50 transition-colors"
                    onClick={() => {
                      setRepoPurge({ id: r.id, slug: r.slug, name: r.name || r.slug, removeLink: false })
                      setRepoPurgeSlugConfirm('')
                      setRepoPurgeError(null)
                    }}
                  >
                    Remove this repo&apos;s data…
                  </button>
                  <button
                    type="button"
                    className="text-xs font-semibold rounded-[var(--radius-md)] border border-red-300 bg-white px-3 py-2 text-red-900 hover:bg-red-50 transition-colors"
                    onClick={() => {
                      setRepoPurge({ id: r.id, slug: r.slug, name: r.name || r.slug, removeLink: true })
                      setRepoPurgeSlugConfirm('')
                      setRepoPurgeError(null)
                    }}
                  >
                    Remove data and unlink…
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canPurgeKnowledge && workspace?.id && (
        <section className="rounded-[var(--radius-lg)] border border-red-200/80 bg-red-50/50 p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-red-950">Danger zone</h2>
            <p className="text-sm text-red-950/85 mt-1 leading-relaxed">
              Owners and admins can permanently remove everything AutoDoc has learned for this workspace: searchable code
              excerpts, handbook articles, assistant conversations, system map, and past activity on this
              page. Your connection to your source and your saved project list stay; only “last updated” timestamps on those
              projects are cleared.
            </p>
          </div>
          <button
            type="button"
            className="rounded-[var(--radius-md)] border border-red-300 bg-white px-4 py-2.5 text-sm font-semibold text-red-900 hover:bg-red-50 transition-colors"
            onClick={openPurgeModal}
          >
            Erase all workspace knowledge…
          </button>
        </section>
      )}

      <p className="text-xs text-[var(--color-text-tertiary)] leading-relaxed">
        Large codebases can take a few extra minutes after an update shows as finished. Run a documentation refresh once
        content updates are done so articles match the latest code. Open{' '}
        <Link href="/docs" className="text-primary font-medium hover:underline">
          Documentation
        </Link>{' '}
        for handbook articles and the AI assistant.
      </p>

      {purgeModalOpen && workspace?.name && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50"
          role="presentation"
          onClick={() => {
            if (!purgeBusy) {
              setPurgeModalOpen(false)
              setPurgeConfirmName('')
              setPurgeError(null)
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="purge-dialog-title"
            className="w-full max-w-lg rounded-[var(--radius-lg)] border border-red-200 bg-[var(--color-surface)] shadow-xl p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="purge-dialog-title" className="text-lg font-bold text-red-950">
              Erase all workspace knowledge?
            </h3>
            <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
              This cannot be undone. AutoDoc will permanently remove:
            </p>
            <ul className="text-sm text-[var(--color-text-secondary)] list-disc pl-5 space-y-1 leading-relaxed">
              <li>Searchable excerpts from your code</li>
              <li>Handbook articles and guided documentation</li>
              <li>Assistant conversation history</li>
              <li>System map</li>
              <li>Past activity shown on this page for this workspace</li>
              <li>Usage counters tied to this workspace</li>
            </ul>
            <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
              Type the workspace name <strong className="text-[var(--color-text-primary)]">{workspace.name}</strong> exactly to
              confirm.
            </p>
            <input
              type="text"
              autoComplete="off"
              value={purgeConfirmName}
              onChange={(e) => setPurgeConfirmName(e.target.value)}
              placeholder={workspace.name}
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm"
              disabled={purgeBusy}
            />
            {purgeError && (
              <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-[var(--radius-md)] px-3 py-2">
                {purgeError}
              </p>
            )}
            <div className="flex flex-wrap gap-3 justify-end pt-2">
              <button
                type="button"
                className="pk-btn-secondary"
                disabled={purgeBusy}
                onClick={() => {
                  setPurgeModalOpen(false)
                  setPurgeConfirmName('')
                  setPurgeError(null)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-[var(--radius-md)] bg-red-700 text-white px-4 py-2.5 text-sm font-semibold hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={purgeBusy || !purgeNameMatches}
                onClick={() => void runPurgeKnowledge()}
              >
                {purgeBusy ? 'Erasing…' : 'Erase everything'}
              </button>
            </div>
          </div>
        </div>
      )}

      {repoPurge && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50"
          role="presentation"
          onClick={() => {
            if (!repoPurgeBusy) {
              setRepoPurge(null)
              setRepoPurgeSlugConfirm('')
              setRepoPurgeError(null)
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="repo-purge-dialog-title"
            className="w-full max-w-lg rounded-[var(--radius-lg)] border border-amber-200 bg-[var(--color-surface)] shadow-xl p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="repo-purge-dialog-title" className="text-lg font-bold text-amber-950">
              {repoPurge.removeLink ? 'Remove data and unlink this project?' : 'Remove this project’s indexed data?'}
            </h3>
            <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
              <strong className="font-medium text-[var(--color-text-primary)]">{repoPurge.name}</strong>: this cannot be undone.
              AutoDoc will permanently remove for this repository only:
            </p>
            <ul className="text-sm text-[var(--color-text-secondary)] list-disc pl-5 space-y-1 leading-relaxed">
              <li>Searchable code chunks and embeddings</li>
              <li>Handbook and guided documentation sections tied to this repo</li>
              <li>Sync job history and processing state for this repo</li>
              <li>Assistant threads scoped to this project</li>
              <li>Git mirror bookkeeping and job history for this project</li>
            </ul>
            {repoPurge.removeLink ? (
              <p className="text-sm text-red-900/90 leading-relaxed">
                The saved Bitbucket link for this project will also be removed from this workspace.
              </p>
            ) : (
              <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
                The saved link stays; only stored knowledge and job rows for this project are cleared.
              </p>
            )}
            <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
              Type the repository slug{' '}
              <strong className="text-[var(--color-text-primary)]">
                <code className="text-[13px]">{repoPurge.slug}</code>
              </strong>{' '}
              exactly (case-sensitive) to confirm.
            </p>
            <input
              type="text"
              autoComplete="off"
              value={repoPurgeSlugConfirm}
              onChange={(e) => setRepoPurgeSlugConfirm(e.target.value)}
              placeholder={repoPurge.slug}
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm"
              disabled={repoPurgeBusy}
            />
            {repoPurgeError && (
              <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-[var(--radius-md)] px-3 py-2">
                {repoPurgeError}
              </p>
            )}
            <div className="flex flex-wrap gap-3 justify-end pt-2">
              <button
                type="button"
                className="pk-btn-secondary"
                disabled={repoPurgeBusy}
                onClick={() => {
                  setRepoPurge(null)
                  setRepoPurgeSlugConfirm('')
                  setRepoPurgeError(null)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-[var(--radius-md)] bg-red-700 text-white px-4 py-2.5 text-sm font-semibold hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={repoPurgeBusy || !repoSlugMatches}
                onClick={() => void runPurgeRepository()}
              >
                {repoPurgeBusy ? 'Removing…' : repoPurge.removeLink ? 'Remove and unlink' : 'Remove data'}
              </button>
            </div>
          </div>
        </div>
      )}

      {guidedPurgeOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50"
          role="presentation"
          onClick={() => {
            if (!guidedPurgeBusy) {
              setGuidedPurgeOpen(false)
              setGuidedPurgeConfirm('')
              setGuidedPurgeError(null)
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="guided-purge-dialog-title"
            className="w-full max-w-lg rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="guided-purge-dialog-title" className="text-lg font-bold text-[var(--color-text-primary)]">
              Clear all guided articles?
            </h3>
            <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
              This removes every saved handbook article for this workspace (all repositories and branches). It does not
              delete indexed code chunks, assistant threads, or your Bitbucket links.
            </p>
            <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
              Type{' '}
              <code className="text-[13px] bg-[var(--color-bg-secondary)] px-1.5 py-0.5 rounded">
                {PURGE_GUIDED_DOCS_CONFIRM_PHRASE}
              </code>{' '}
              exactly to confirm.
            </p>
            <input
              type="text"
              autoComplete="off"
              value={guidedPurgeConfirm}
              onChange={(e) => setGuidedPurgeConfirm(e.target.value)}
              placeholder={PURGE_GUIDED_DOCS_CONFIRM_PHRASE}
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm"
              disabled={guidedPurgeBusy}
            />
            {guidedPurgeError && (
              <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-[var(--radius-md)] px-3 py-2">
                {guidedPurgeError}
              </p>
            )}
            <div className="flex flex-wrap gap-3 justify-end pt-2">
              <button
                type="button"
                className="pk-btn-secondary"
                disabled={guidedPurgeBusy}
                onClick={() => {
                  setGuidedPurgeOpen(false)
                  setGuidedPurgeConfirm('')
                  setGuidedPurgeError(null)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-[var(--radius-md)] bg-red-700 text-white px-4 py-2.5 text-sm font-semibold hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={guidedPurgeBusy || !guidedPhraseMatches}
                onClick={() => void runGuidedPurge()}
              >
                {guidedPurgeBusy ? 'Removing…' : 'Clear guided articles'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

type SyncMutateAction = 'cancel' | 'abandon' | 'remove' | 'delete_log'

function SyncJobManageBar({
  job,
  canManage,
  busyId,
  onMutate,
  compact,
}: {
  job: SyncJob
  canManage: boolean
  busyId: string | null
  onMutate: (id: string, action: SyncMutateAction) => void
  compact?: boolean
}) {
  if (!canManage) return null
  const busy = busyId === job.id
  const btn =
    compact === true
      ? 'text-[11px] font-medium rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 hover:bg-[var(--color-bg-secondary)] disabled:opacity-50'
      : 'text-xs font-medium rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 hover:bg-[var(--color-bg-secondary)] disabled:opacity-50'
  const abandonBtn =
    compact === true
      ? 'text-[11px] font-medium rounded border border-amber-600/40 bg-amber-50/90 text-amber-950 px-2 py-1 hover:bg-amber-100 disabled:opacity-50'
      : 'text-xs font-medium rounded border border-amber-600/40 bg-amber-50/90 text-amber-950 px-2.5 py-1 hover:bg-amber-100 disabled:opacity-50'
  return (
    <div className={`flex flex-wrap gap-2 ${compact ? 'mt-2' : 'mt-3'}`}>
      {(job.status === 'queued' || job.status === 'running') && (
        <button type="button" className={btn} disabled={busy} onClick={() => onMutate(job.id, 'cancel')}>
          {busy ? '…' : 'Stop'}
        </button>
      )}
      {job.status === 'running' && (
        <button
          type="button"
          className={abandonBtn}
          disabled={busy}
          title="Mark this job as cancelled"
          onClick={() => {
            if (!confirm('Clear this in-progress job?\n\nThis marks it as cancelled. Contact your administrator if jobs continue to get stuck.')) {
              return
            }
            onMutate(job.id, 'abandon')
          }}
        >
          {busy ? '…' : 'Clear in DB'}
        </button>
      )}
      {job.status !== 'running' && (
        <button type="button" className={btn} disabled={busy} onClick={() => onMutate(job.id, 'remove')}>
          {busy ? '…' : 'Remove from list'}
        </button>
      )}
      <button
        type="button"
        className={btn}
        disabled={busy}
        onClick={() => {
          if (!confirm('Clear the log for this job?')) {
            return
          }
          onMutate(job.id, 'delete_log')
        }}
      >
        Clear log file
      </button>
    </div>
  )
}

function CompactSyncJobRow({
  job,
  as: El = 'li',
  canManage = false,
  busyId = null,
  onMutate,
}: {
  job: SyncJob
  as?: 'li' | 'div'
  canManage?: boolean
  busyId?: string | null
  onMutate?: (id: string, action: SyncMutateAction) => void
}) {
  const errorText = syncJobErrorForDisplay(job.error_message)
  const running = job.status === 'running'
  return (
    <El className={El === 'li' ? 'px-4 py-3 text-sm' : 'text-sm'}>
      <span className="sr-only">Reference {job.id.slice(0, 8)}</span>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            job.status === 'succeeded'
              ? 'bg-emerald-100 text-emerald-900'
              : job.status === 'failed'
                ? 'bg-red-100 text-red-900'
                : job.status === 'running'
                  ? 'bg-sky-100 text-sky-900'
                  : job.status === 'cancelled'
                    ? 'bg-amber-100 text-amber-900'
                    : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
          }`}
        >
          {syncJobStatusLabel(job.status)}
        </span>
        <span className="text-sm font-medium text-[var(--color-text-primary)]">Branch {job.branch}</span>
        <span className="text-xs text-[var(--color-text-tertiary)]">{formatActivityWhen(job.created_at)}</span>
      </div>
      {job.completed_at && (
        <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
          Finished {formatActivityWhen(job.completed_at)}
        </p>
      )}
      {running && (
        <div className="mt-2 h-1 rounded-full bg-sky-100 overflow-hidden max-w-xs" aria-hidden>
          <div className="h-full w-full bg-sky-400/70 rounded-full animate-pulse" />
        </div>
      )}
      {errorText && <p className="text-xs text-red-700 mt-2 leading-relaxed">{errorText}</p>}
      {onMutate ? (
        <SyncJobManageBar job={job} canManage={canManage} busyId={busyId} onMutate={onMutate} compact />
      ) : null}
    </El>
  )
}

function CompactDocJobRow({ job, as: El = 'li' }: { job: DocJob; as?: 'li' | 'div' }) {
  const running = job.status === 'running'
  const errDisp = docJobErrorForDisplay(job.error_message)
  return (
    <El className={El === 'li' ? 'px-4 py-3 text-sm' : 'text-sm'}>
      <span className="sr-only">Reference {job.id.slice(0, 8)}</span>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            job.status === 'succeeded'
              ? 'bg-emerald-100 text-emerald-900'
              : job.status === 'failed'
                ? 'bg-red-100 text-red-900'
                : job.status === 'running'
                  ? 'bg-violet-100 text-violet-900'
                  : job.status === 'cancelled'
                    ? 'bg-amber-100 text-amber-900'
                    : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
          }`}
        >
          {docJobStatusLabel(job.status)}
        </span>
        <span className="text-xs text-[var(--color-text-tertiary)]">Started {formatActivityWhen(job.created_at)}</span>
      </div>
      {job.completed_at && (
        <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
          Finished {formatActivityWhen(job.completed_at)}
        </p>
      )}
      {running && (
        <div className="mt-2 h-1 rounded-full bg-violet-100 overflow-hidden max-w-xs" aria-hidden>
          <div className="h-full w-full bg-violet-400/70 rounded-full animate-pulse" />
        </div>
      )}
      {errDisp && job.status === 'failed' && (
        <p className="text-xs text-red-700 mt-2 leading-relaxed">{errDisp}</p>
      )}
    </El>
  )
}

function JobRow({
  job,
  canManage = false,
  busyId = null,
  onMutate,
}: {
  job: SyncJob
  canManage?: boolean
  busyId?: string | null
  onMutate?: (id: string, action: SyncMutateAction) => void
}) {
  const errorText = syncJobErrorForDisplay(job.error_message)
  const running = job.status === 'running'
  return (
    <li className="px-5 py-4 text-sm">
      <span className="sr-only">Job reference {job.id}</span>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            job.status === 'succeeded'
              ? 'bg-emerald-100 text-emerald-900'
              : job.status === 'failed'
                ? 'bg-red-100 text-red-900'
                : job.status === 'running'
                  ? 'bg-sky-100 text-sky-900'
                  : job.status === 'cancelled'
                    ? 'bg-amber-100 text-amber-900'
                    : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
          }`}
        >
          {syncJobStatusLabel(job.status)}
        </span>
        <span className="text-[var(--color-text-secondary)] font-medium">Branch {job.branch}</span>
      </div>
      <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
        Started {formatActivityWhen(job.created_at)}
        {job.completed_at && ` · finished ${formatActivityWhen(job.completed_at)}`}
      </p>
      {running && (
        <div className="mt-3 h-1 rounded-full bg-sky-100 overflow-hidden" aria-hidden>
          <div className="h-full w-full bg-sky-400/70 rounded-full animate-pulse" />
        </div>
      )}
      {errorText && <p className="text-xs text-red-700 mt-2 leading-relaxed">{errorText}</p>}
      {onMutate ? (
        <SyncJobManageBar job={job} canManage={canManage} busyId={busyId} onMutate={onMutate} />
      ) : null}
    </li>
  )
}

function DocJobRow({ job }: { job: DocJob }) {
  const running = job.status === 'running'
  const errDisp = docJobErrorForDisplay(job.error_message)
  return (
    <li className="px-5 py-4 text-sm">
      <span className="sr-only">Job reference {job.id}</span>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            job.status === 'succeeded'
              ? 'bg-emerald-100 text-emerald-900'
              : job.status === 'failed'
                ? 'bg-red-100 text-red-900'
                : job.status === 'running'
                  ? 'bg-violet-100 text-violet-900'
                  : job.status === 'cancelled'
                    ? 'bg-amber-100 text-amber-900'
                    : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
          }`}
        >
          {docJobStatusLabel(job.status)}
        </span>
      </div>
      <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
        Started {formatActivityWhen(job.created_at)}
        {job.completed_at && ` · finished ${formatActivityWhen(job.completed_at)}`}
      </p>
      {running && (
        <div className="mt-3 h-1 rounded-full bg-violet-100 overflow-hidden" aria-hidden>
          <div className="h-full w-full bg-violet-400/70 rounded-full animate-pulse" />
        </div>
      )}
      {errDisp && job.status === 'failed' && (
        <p className="text-xs text-red-700 mt-2 leading-relaxed">{errDisp}</p>
      )}
    </li>
  )
}
