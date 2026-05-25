'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { authorizedFetch } from '@/lib/api'
import { userFacingBitbucketOrSyncError } from '@/lib/bitbucket-user-errors'
import { withSupportContact } from '@/lib/support-copy'

type LinkedRepo = {
  id: string
  bitbucket_workspace: string
  slug: string
  name: string
  default_branch: string
  last_sync_at: string | null
}

type DiscoverRepo = { slug: string; name: string; defaultBranch: string }

type Props = {
  workspaceId: string
  connected: boolean
  canSync: boolean
  onSyncQueued?: () => void
  /** Called when multiple sync jobs are queued at once (repos or branches). */
  onBulkSyncQueued?: (count: number, kind?: 'repos' | 'branches') => void
  /** Optional extra controls (e.g. Integrations page doc shortcut). */
  extraActions?: React.ReactNode
}

export default function BitbucketSyncSection({
  workspaceId,
  connected,
  canSync,
  onSyncQueued,
  onBulkSyncQueued,
  extraActions,
}: Props) {
  const [linked, setLinked] = useState<LinkedRepo[]>([])
  const [loadingLinked, setLoadingLinked] = useState(true)

  const [mode, setMode] = useState<'saved' | 'browse'>('browse')
  const [linkedId, setLinkedId] = useState('')

  const [workspaces, setWorkspaces] = useState<{ slug: string; name: string }[]>([])
  const [loadingWs, setLoadingWs] = useState(false)
  const [pickListError, setPickListError] = useState<string | null>(null)
  const [bbWs, setBbWs] = useState('')
  const [repos, setRepos] = useState<DiscoverRepo[]>([])
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [repoSlug, setRepoSlug] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [branch, setBranch] = useState('main')

  const [manualOpen, setManualOpen] = useState(false)
  const [manualWs, setManualWs] = useState('')
  const [manualRepo, setManualRepo] = useState('')
  const [manualBranch, setManualBranch] = useState('main')

  const [busy, setBusy] = useState(false)
  const [syncAllBusy, setSyncAllBusy] = useState(false)
  const [localMsg, setLocalMsg] = useState<string | null>(null)
  const [infoNote, setInfoNote] = useState<string | null>(null)
  const [fullReindex, setFullReindex] = useState(false)
  /** Saved-repo: one branch, Bitbucket “all” list (capped per request), or explicit multi-select. */
  const [branchQueueMode, setBranchQueueMode] = useState<'single' | 'all' | 'pick'>('single')
  const [savedRepoBranches, setSavedRepoBranches] = useState<string[]>([])
  const [savedBranchesLoading, setSavedBranchesLoading] = useState(false)
  const [savedBranchesError, setSavedBranchesError] = useState<string | null>(null)
  const [branchPickSearch, setBranchPickSearch] = useState('')
  const [pickedBranches, setPickedBranches] = useState<string[]>([])
  const [advSyncOpen, setAdvSyncOpen] = useState(false)
  /** Dev: use an existing clone on the ingest worker machine (see PK_ALLOW_LOCAL_WORKING_COPY). */
  const [localWorkingCopyPath, setLocalWorkingCopyPath] = useState('')
  const [mirrorEnvironment, setMirrorEnvironment] = useState<'local' | 'cloud'>('local')
  type MirrorRow = {
    filesystem_path: string
    head_commit_sha: string | null
    sync_branch: string
    updated_at: string
  }

  const [mirrorRow, setMirrorRow] = useState<MirrorRow | null>(null)
  const [mirrorLoading, setMirrorLoading] = useState(false)

  const showLocalMirrorUi = process.env.NEXT_PUBLIC_LOCAL_WORKING_COPY_UI === '1'
  const canUseSplitPipeline = mode === 'saved' && Boolean(linkedId)

  const loadSavedRepoBranches = useCallback(async () => {
    if (!workspaceId || !linkedId) return
    const row = linked.find((r) => r.id === linkedId)
    if (!row) return
    setSavedBranchesLoading(true)
    setSavedBranchesError(null)
    try {
      const q = new URLSearchParams({
        workspace_id: workspaceId,
        bb_workspace: row.bitbucket_workspace,
        repo_slug: row.slug,
      })
      const res = await authorizedFetch(`/api/integrations/bitbucket/discover?${q.toString()}`)
      const j = (await res.json()) as { branches?: string[]; error?: string }
      if (!res.ok) {
        setSavedRepoBranches([])
        setSavedBranchesError(
          typeof j.error === 'string'
            ? userFacingBitbucketOrSyncError(j.error)
            : withSupportContact('Could not load branches from Bitbucket.')
        )
        return
      }
      const list = (j.branches ?? []).slice().sort((a, b) => a.localeCompare(b))
      setSavedRepoBranches(list)
      const def = (row.default_branch || 'main').trim()
      setPickedBranches(list.includes(def) ? [def] : [])
    } catch {
      setSavedRepoBranches([])
      setSavedBranchesError(withSupportContact('Could not load branches. Check your connection and try again.'))
    } finally {
      setSavedBranchesLoading(false)
    }
  }, [workspaceId, linkedId, linked])

  const loadMirror = useCallback(async () => {
    if (!workspaceId || !linkedId || !branch.trim() || mode !== 'saved') {
      setMirrorRow(null)
      return
    }
    setMirrorLoading(true)
    try {
      const res = await authorizedFetch(
        `/api/workspace/repo-mirror?workspace_id=${encodeURIComponent(workspaceId)}&repository_id=${encodeURIComponent(linkedId)}&branch=${encodeURIComponent(branch.trim())}`
      )
      const j = (await res.json()) as { mirror?: MirrorRow | null; error?: string }
      if (res.ok && j.mirror) {
        setMirrorRow(j.mirror)
      } else {
        setMirrorRow(null)
      }
    } catch {
      setMirrorRow(null)
    } finally {
      setMirrorLoading(false)
    }
  }, [workspaceId, linkedId, branch, mode])

  const loadLinked = useCallback(async () => {
    setLoadingLinked(true)
    try {
      const res = await authorizedFetch(`/api/workspace/repositories?workspace_id=${workspaceId}`)
      if (!res.ok) {
        setLinked([])
        setMode('browse')
        setLinkedId('')
        return
      }
      const j = (await res.json()) as { repositories: LinkedRepo[] }
      const list = j.repositories ?? []
      setLinked(list)
      if (list.length > 0) {
        setMode('saved')
        setLinkedId(list[0].id)
        setBranch(list[0].default_branch || 'main')
      } else {
        setMode('browse')
        setLinkedId('')
      }
    } catch {
      setLinked([])
      setMode('browse')
    } finally {
      setLoadingLinked(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void loadLinked()
  }, [loadLinked])

  useEffect(() => {
    void loadMirror()
  }, [loadMirror])

  useEffect(() => {
    if (mode !== 'saved') setBranchQueueMode('single')
  }, [mode])

  useEffect(() => {
    setSavedRepoBranches([])
    setPickedBranches([])
    setBranchPickSearch('')
    setSavedBranchesError(null)
  }, [linkedId])

  useEffect(() => {
    if (!loadingLinked && linked.length === 0 && connected) {
      setAdvSyncOpen(true)
    }
  }, [loadingLinked, linked.length, connected])

  useEffect(() => {
    if (!connected || !workspaceId || mode !== 'browse') return
    let cancelled = false
    void (async () => {
      setLoadingWs(true)
      setPickListError(null)
      setWorkspaces([])
      setBbWs('')
      setRepoSlug('')
      setRepos([])
      setBranches([])
      try {
        const res = await authorizedFetch(`/api/integrations/bitbucket/discover?workspace_id=${workspaceId}`)
        const j = (await res.json()) as {
          error?: string
          workspaces?: { slug: string; name: string }[]
          used_workspace_list_fallback?: boolean
        }
        if (cancelled) return
        if (!res.ok) {
          setPickListError(
            typeof j.error === 'string'
              ? userFacingBitbucketOrSyncError(j.error)
              : withSupportContact('Could not load your Bitbucket workspaces and repositories.')
          )
          return
        }
        if (j.used_workspace_list_fallback) {
          setInfoNote(
            'Workspace list came from Bitbucket’s Workspaces API (the global “repositories you’re a member of” list was empty or unavailable for this token). Pick a workspace, then repositories and branches should load as usual.',
          )
        }
        const ws = j.workspaces ?? []
        setWorkspaces(ws)
        if (ws.length === 0) {
          setPickListError(
            withSupportContact(
              'Bitbucket did not return any repositories for this connection. Reconnect Bitbucket under Integrations (use Reconnect) so the app can refresh access, then try again.'
            )
          )
        }
        if (ws.length === 1) {
          setBbWs(ws[0]!.slug)
        }
      } catch {
        if (!cancelled) {
          setWorkspaces([])
          setPickListError(withSupportContact('Could not reach Bitbucket. Try reconnecting under Integrations.'))
        }
      } finally {
        if (!cancelled) setLoadingWs(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connected, workspaceId, mode])

  useEffect(() => {
    if (!connected || !workspaceId || mode !== 'browse' || !bbWs) {
      setRepos([])
      setRepoSlug('')
      setBranches([])
      return
    }

    // Always load repos via GET /repositories/{workspace} (discover API). Do not use only
    // listMemberRepositories() here: role=member can omit private repos that still appear
    // under the workspace listing for the same OAuth user.
    let cancelled = false
    void (async () => {
      setLoadingRepos(true)
      try {
        const res = await authorizedFetch(
          `/api/integrations/bitbucket/discover?workspace_id=${workspaceId}&bb_workspace=${encodeURIComponent(bbWs)}`
        )
        if (cancelled) return
        const j = (await res.json()) as { repositories?: DiscoverRepo[]; error?: string }
        if (!res.ok) {
          if (!cancelled) {
            setRepos([])
            setRepoSlug('')
            setBranches([])
            setPickListError(
              typeof j.error === 'string'
                ? userFacingBitbucketOrSyncError(j.error)
                : withSupportContact('Could not load repositories for this workspace. Try reconnecting Bitbucket.')
            )
          }
          return
        }
        const list = (j.repositories ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
        if (cancelled) return
        setPickListError(null)
        setRepos(list)
        if (list.length === 1) {
          setRepoSlug(list[0]!.slug)
          setBranch(list[0]!.defaultBranch || 'main')
        } else {
          setRepoSlug('')
          setBranch('main')
        }
      } catch {
        if (!cancelled) {
          setRepos([])
          setPickListError(
            withSupportContact('Could not load repositories for this workspace. Try reconnecting Bitbucket.')
          )
        }
      } finally {
        if (!cancelled) setLoadingRepos(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connected, workspaceId, mode, bbWs])

  useEffect(() => {
    if (!connected || !workspaceId || mode !== 'browse' || !bbWs || !repoSlug) {
      setBranches([])
      return
    }
    let cancelled = false
    void (async () => {
      setLoadingBranches(true)
      try {
        const q = new URLSearchParams({
          workspace_id: workspaceId,
          bb_workspace: bbWs,
          repo_slug: repoSlug,
        })
        const res = await authorizedFetch(`/api/integrations/bitbucket/discover?${q.toString()}`)
        if (cancelled || !res.ok) return
        const j = (await res.json()) as { branches?: string[] }
        const list = j.branches ?? []
        if (cancelled) return
        setBranches(list)
        setBranch((prev) => {
          if (list.length === 0) return prev
          return list.includes(prev) ? prev : list[0]!
        })
      } catch {
        if (!cancelled) setBranches([])
      } finally {
        if (!cancelled) setLoadingBranches(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connected, workspaceId, mode, bbWs, repoSlug])

  useEffect(() => {
    if (mode !== 'saved' || !linkedId) return
    const row = linked.find((r) => r.id === linkedId)
    if (row) setBranch(row.default_branch || 'main')
  }, [mode, linkedId, linked])

  const onRepoPick = (slug: string) => {
    setRepoSlug(slug)
    const r = repos.find((x) => x.slug === slug)
    if (r) setBranch(r.defaultBranch || 'main')
  }

  const selectValue = mode === 'browse' ? '__browse__' : linkedId

  const branchPickFiltered = useMemo(() => {
    const q = branchPickSearch.trim().toLowerCase()
    if (!q) return savedRepoBranches
    return savedRepoBranches.filter((b) => b.toLowerCase().includes(q))
  }, [savedRepoBranches, branchPickSearch])

  const runSync = async (pipeline: 'full' | 'clone_only' | 'embed_only' | 'codewiki_only' = 'full') => {
    setLocalMsg(null)
    setInfoNote(null)
    setPickListError(null)
    if (!connected) {
      setLocalMsg('Connect Bitbucket under Integrations first.')
      return
    }
    const multiSaved =
      mode === 'saved' && !manualOpen && linkedId && (branchQueueMode === 'all' || branchQueueMode === 'pick')
    if ((branchQueueMode === 'all' || branchQueueMode === 'pick') && (manualOpen || mode !== 'saved' || !linkedId)) {
      setLocalMsg('Multiple-branch sync only works for a saved repository (pick it in the list, not manual entry).')
      return
    }
    if (multiSaved && showLocalMirrorUi && localWorkingCopyPath.trim()) {
      setLocalMsg('Use a single branch with a local working copy path, or clear the path to queue many branches.')
      return
    }
    if (branchQueueMode === 'pick' && mode === 'saved' && !manualOpen) {
      if (savedRepoBranches.length === 0) {
        setLocalMsg('Load the branch list from Bitbucket first, then select branches.')
        return
      }
      if (pickedBranches.length === 0) {
        setLocalMsg('Select at least one branch to queue.')
        return
      }
    }
    if ((pipeline === 'clone_only' || pipeline === 'embed_only' || pipeline === 'codewiki_only') && !canUseSplitPipeline) {
      setLocalMsg('Two-step sync needs a saved repository. Pick one in the list above (not “browse manually” for this flow).')
      return
    }
    if (manualOpen) {
      if (!manualWs.trim() || !manualRepo.trim()) {
        setLocalMsg('Enter Bitbucket workspace and repository, or choose from the lists above.')
        return
      }
    } else if (mode === 'saved') {
      if (!linkedId) {
        setLocalMsg('Select a repository.')
        return
      }
    } else {
      if (!bbWs.trim() || !repoSlug.trim()) {
        setLocalMsg('Choose Bitbucket workspace and repository.')
        return
      }
    }

    setBusy(true)
    try {
      let body: Record<string, string>
      if (manualOpen) {
        body = {
          workspace_id: workspaceId,
          bitbucket_workspace: manualWs.trim(),
          repo_slug: manualRepo.trim(),
          branch: manualBranch.trim() || 'main',
        }
      } else if (mode === 'saved') {
        if (branchQueueMode === 'all') {
          body = {
            workspace_id: workspaceId,
            repository_id: linkedId,
          }
        } else {
          body = {
            workspace_id: workspaceId,
            repository_id: linkedId,
            branch: branch.trim() || 'main',
          }
        }
      } else {
        body = {
          workspace_id: workspaceId,
          bitbucket_workspace: bbWs.trim(),
          repo_slug: repoSlug.trim(),
          branch: branch.trim() || 'main',
        }
      }

      const payload: Record<string, unknown> = {
        ...body,
        pipeline,
        ...(fullReindex && (pipeline === 'full' || pipeline === 'embed_only') ? { full_reindex: true } : {}),
        ...(mode === 'saved' && branchQueueMode === 'all' ? { sync_all_branches: true } : {}),
        ...(mode === 'saved' && branchQueueMode === 'pick' && pickedBranches.length > 0
          ? { branch_names: pickedBranches }
          : {}),
      }
      if (showLocalMirrorUi && localWorkingCopyPath.trim() && pipeline === 'full' && branchQueueMode === 'single') {
        payload.local_working_copy_abs_path = localWorkingCopyPath.trim()
        payload.mirror_environment = mirrorEnvironment
      }

      const res = await authorizedFetch('/api/sync/trigger', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      const j = (await res.json()) as {
        error?: string | { formErrors?: string[]; fieldErrors?: Record<string, string[]> }
        branches_queued?: number
        branches_truncated?: boolean
        max_branches?: number
        branches_total_found?: number
      }
      if (!res.ok) {
        const err = j.error
        const msg =
          typeof err === 'string'
            ? userFacingBitbucketOrSyncError(err)
            : err && typeof err === 'object' && 'formErrors' in err
              ? 'Could not start this sync. Check the highlighted fields and try again.'
              : 'Could not start this sync.'
        setLocalMsg(withSupportContact(msg))
        return
      }
      setLocalMsg(null)
      const n = typeof j.branches_queued === 'number' ? j.branches_queued : 0
      const multiQueued =
        mode === 'saved' &&
        !manualOpen &&
        n >= 1 &&
        (branchQueueMode === 'all' || branchQueueMode === 'pick')
      if (multiQueued) {
        onBulkSyncQueued?.(n, 'branches')
        if (!onBulkSyncQueued) onSyncQueued?.()
        if (branchQueueMode === 'all' && j.branches_truncated && typeof j.max_branches === 'number') {
          const found = typeof j.branches_total_found === 'number' ? j.branches_total_found : n
          setInfoNote(
            `Queued ${n} of ${found} branches. Each run is limited to ${j.max_branches} jobs for stability. Use “Choose branches…” to load the full list and queue the next batch, or ask your administrator to raise that limit in server configuration.`
          )
        }
      } else {
        onSyncQueued?.()
      }
      void loadLinked()
      void loadMirror()
    } catch {
      setLocalMsg(withSupportContact('Could not start this sync. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  const runSyncAll = async () => {
    setLocalMsg(null)
    setInfoNote(null)
    setPickListError(null)
    if (!connected) {
      setLocalMsg('Connect Bitbucket under Integrations first.')
      return
    }
    if (!canSync) return
    if (linked.length === 0) {
      setLocalMsg('No saved repositories yet. Use the options below to pick a repository first.')
      setAdvSyncOpen(true)
      return
    }
    setSyncAllBusy(true)
    let ok = 0
    try {
      for (const r of linked) {
        const b = (r.default_branch || 'main').trim() || 'main'
        const res = await authorizedFetch('/api/sync/trigger', {
          method: 'POST',
          body: JSON.stringify({
            workspace_id: workspaceId,
            repository_id: r.id,
            branch: b,
            pipeline: 'full' as const,
          }),
        })
        const j = (await res.json()) as { error?: string }
        if (!res.ok) {
          setLocalMsg(
            withSupportContact(
              typeof j.error === 'string'
                ? userFacingBitbucketOrSyncError(j.error)
                : `Could not queue all syncs (${ok} were queued).`
            )
          )
          break
        }
        ok += 1
      }
      if (ok === linked.length && ok > 0) {
        setLocalMsg(null)
        onBulkSyncQueued?.(ok, 'repos')
        if (!onBulkSyncQueued) onSyncQueued?.()
        void loadLinked()
      }
      if (ok > 0 && ok < linked.length) {
        void loadLinked()
        onBulkSyncQueued?.(ok, 'repos')
        if (!onBulkSyncQueued) onSyncQueued?.()
      }
    } catch {
      setLocalMsg(withSupportContact('Could not queue syncs. Try again.'))
    } finally {
      setSyncAllBusy(false)
    }
  }

  const browseBusy = mode === 'browse' && (loadingWs || loadingRepos || loadingBranches)
  const pickNeedsSelection =
    !manualOpen && mode === 'saved' && branchQueueMode === 'pick' && pickedBranches.length === 0
  const syncDisabled =
    busy ||
    !canSync ||
    !connected ||
    loadingLinked ||
    (manualOpen ? !manualWs.trim() || !manualRepo.trim() : false) ||
    (!manualOpen && browseBusy) ||
    (!manualOpen && mode === 'saved' && !linkedId) ||
    (!manualOpen && mode === 'browse' && (!bbWs || !repoSlug)) ||
    pickNeedsSelection

  const selectClass =
    'w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm bg-[var(--color-surface)] text-[var(--color-text-primary)]'

  return (
    <div className="space-y-4">
      {!connected && (
        <p className="text-sm text-[var(--color-text-secondary)] rounded-[var(--radius-md)] border border-amber-200/80 bg-amber-50/40 px-3 py-2">
          Connect Bitbucket under{' '}
          <Link href="/settings/integrations" className="text-primary font-medium hover:underline">
            Integrations
          </Link>{' '}
          to choose workspaces and repositories from your account.
        </p>
      )}

      {pickListError && mode === 'browse' && connected && (
        <p className="text-sm text-amber-950 bg-amber-50 border border-amber-200 rounded-[var(--radius-md)] px-3 py-2">
          {pickListError}
        </p>
      )}

      {loadingLinked ? (
        <p className="text-sm text-[var(--color-text-tertiary)]">Loading saved repositories…</p>
      ) : (
        <>
          {linked.length > 0 && connected && (
            <div className="rounded-[var(--radius-lg)] border border-primary/25 bg-[var(--color-accent-light)]/40 px-4 py-4 space-y-3">
              <div>
                <p className="text-sm font-semibold text-[var(--color-text-primary)]">Sync everything (recommended)</p>
                <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                  Queues one <strong>full</strong> sync job per saved repository (clone + index + embed in one step) on its
                  default branch. Unchanged files are not re-embedded. Open the options below for split sync, another branch,
                  or a full vector rebuild.
                </p>
              </div>
              <button
                type="button"
                className="pk-btn-primary w-full sm:w-auto min-h-[44px] px-6"
                disabled={busy || syncAllBusy || !canSync || !connected}
                onClick={() => void runSyncAll()}
              >
                {syncAllBusy ? 'Queueing…' : `Sync all repositories (${linked.length})`}
              </button>
            </div>
          )}

          {extraActions ? (
            <div className="flex flex-wrap items-center gap-3">{extraActions}</div>
          ) : null}

          <details
            className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden group"
            open={advSyncOpen}
            onToggle={(e) => setAdvSyncOpen(e.currentTarget.open)}
          >
            <summary className="px-4 py-3 text-sm font-semibold text-[var(--color-text-primary)] cursor-pointer list-none flex items-center justify-between gap-2 marker:content-none [&::-webkit-details-marker]:hidden">
              <span>
                {linked.length > 0
                  ? 'Sync one repository or branch'
                  : 'Choose a repository and branch to sync'}
              </span>
              <span className="text-xs font-normal text-[var(--color-text-tertiary)] shrink-0 group-open:rotate-180 transition-transform">
                ▾
              </span>
            </summary>
            <div className="px-4 pb-4 pt-0 space-y-4 border-t border-[var(--color-border)]">
              {linked.length > 0 && (
                <div className="pt-4">
                  <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Repository</label>
                  <select
                    className={selectClass}
                    value={selectValue}
                    disabled={!connected || manualOpen}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '__browse__') {
                        setMode('browse')
                        setLinkedId('')
                        setManualOpen(false)
                      } else {
                        setMode('saved')
                        setLinkedId(v)
                        setManualOpen(false)
                      }
                    }}
                  >
                    {linked.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.bitbucket_workspace}/{r.slug} ({r.name})
                      </option>
                    ))}
                    <option value="__browse__">Another repository on Bitbucket…</option>
                  </select>
                  <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
                    Repositories you have synced before appear here first.
                  </p>
                </div>
              )}

              {mode === 'browse' && connected && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                      Bitbucket workspace
                    </label>
                    <select
                      className={selectClass}
                      value={bbWs}
                      disabled={manualOpen || loadingWs}
                      onChange={(e) => setBbWs(e.target.value)}
                    >
                      <option value="">{loadingWs ? 'Loading workspaces…' : 'Select workspace'}</option>
                      {workspaces.map((w) => (
                        <option key={w.slug} value={w.slug}>
                          {w.name} ({w.slug})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Repository</label>
                    <select
                      className={selectClass}
                      value={repoSlug}
                      disabled={manualOpen || !bbWs || loadingRepos}
                      onChange={(e) => onRepoPick(e.target.value)}
                    >
                      <option value="">
                        {loadingRepos ? 'Loading repositories…' : bbWs ? 'Select repository' : 'Choose a workspace first'}
                      </option>
                      {repos.map((r) => (
                        <option key={r.slug} value={r.slug}>
                          {r.name} ({r.slug})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Branch</label>
                    {branches.length > 0 && !loadingBranches ? (
                      <select
                        className={selectClass}
                        value={branches.includes(branch) ? branch : (branches[0] ?? '')}
                        disabled={manualOpen || !repoSlug}
                        onChange={(e) => setBranch(e.target.value)}
                      >
                        {branches.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm"
                        value={branch}
                        disabled={manualOpen || !repoSlug}
                        onChange={(e) => setBranch(e.target.value)}
                        placeholder={loadingBranches ? 'Loading branches…' : 'e.g. main'}
                      />
                    )}
                  </div>
                </div>
              )}

              {mode === 'saved' && linkedId && !manualOpen && (
                <div className="space-y-3 max-w-3xl">
                  <fieldset className="space-y-2">
                    <legend className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                      Branches to sync
                    </legend>
                    <label className="flex items-start gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
                      <input
                        type="radio"
                        name="branch-queue-mode"
                        className="mt-1"
                        checked={branchQueueMode === 'single'}
                        onChange={() => setBranchQueueMode('single')}
                      />
                      <span>
                        <span className="font-medium text-[var(--color-text-primary)]">Single branch</span>
                        <span className="block text-xs text-[var(--color-text-tertiary)] mt-0.5">
                          One job for the branch name below (default is the saved repository branch).
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
                      <input
                        type="radio"
                        name="branch-queue-mode"
                        className="mt-1"
                        checked={branchQueueMode === 'all'}
                        onChange={() => setBranchQueueMode('all')}
                        disabled={Boolean(showLocalMirrorUi && localWorkingCopyPath.trim())}
                      />
                      <span>
                        <span className="font-medium text-[var(--color-text-primary)]">All branches (first batch)</span>
                        <span className="block text-xs text-[var(--color-text-tertiary)] mt-0.5 leading-relaxed">
                          Fetches every branch from Bitbucket and queues one job per branch, default branch first. Each run is
                          limited to a maximum number of jobs for stability: use “Choose branches” to queue the rest in batches.
                          Not available together with a local working copy path.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
                      <input
                        type="radio"
                        name="branch-queue-mode"
                        className="mt-1"
                        checked={branchQueueMode === 'pick'}
                        onChange={() => setBranchQueueMode('pick')}
                        disabled={Boolean(showLocalMirrorUi && localWorkingCopyPath.trim())}
                      />
                      <span>
                        <span className="font-medium text-[var(--color-text-primary)]">Choose branches…</span>
                        <span className="block text-xs text-[var(--color-text-tertiary)] mt-0.5 leading-relaxed">
                          Load the branch list from Bitbucket, search, then tick the branches you want. Same per-run job limit as
                          “all branches.”
                        </span>
                      </span>
                    </label>
                  </fieldset>

                  {branchQueueMode === 'single' && (
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Branch name</label>
                      <input
                        type="text"
                        className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm max-w-md"
                        value={branch}
                        onChange={(e) => setBranch(e.target.value)}
                        placeholder="default branch for this sync"
                      />
                      <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
                        Override the default for a one-time sync, or leave as-is to use the saved branch.
                      </p>
                    </div>
                  )}

                  {branchQueueMode === 'pick' && (
                    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-3 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)] disabled:opacity-50"
                          disabled={savedBranchesLoading}
                          onClick={() => void loadSavedRepoBranches()}
                        >
                          {savedBranchesLoading ? 'Loading…' : savedRepoBranches.length ? 'Refresh branch list' : 'Load branch list from Bitbucket'}
                        </button>
                        {savedRepoBranches.length > 0 ? (
                          <span className="text-xs text-[var(--color-text-secondary)]">
                            {savedRepoBranches.length} branch{savedRepoBranches.length === 1 ? '' : 'es'} · {pickedBranches.length}{' '}
                            selected
                          </span>
                        ) : null}
                      </div>
                      {savedBranchesError ? (
                        <p className="text-xs text-red-700">{savedBranchesError}</p>
                      ) : null}
                      {savedRepoBranches.length > 0 ? (
                        <>
                          <input
                            type="search"
                            className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm"
                            value={branchPickSearch}
                            onChange={(e) => setBranchPickSearch(e.target.value)}
                            placeholder="Filter branches…"
                            autoComplete="off"
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="text-xs font-medium text-primary hover:underline"
                              onClick={() => {
                                const next = new Set(pickedBranches)
                                for (const b of branchPickFiltered) next.add(b)
                                setPickedBranches([...next].sort((a, b) => a.localeCompare(b)))
                              }}
                            >
                              Select all matching filter
                            </button>
                            <button
                              type="button"
                              className="text-xs font-medium text-primary hover:underline"
                              onClick={() => setPickedBranches([])}
                            >
                              Clear selection
                            </button>
                          </div>
                          <div className="max-h-56 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs font-mono space-y-1">
                            {branchPickFiltered.length === 0 ? (
                              <p className="text-[var(--color-text-tertiary)] px-1">No branches match this filter.</p>
                            ) : (
                              branchPickFiltered.map((b) => (
                                <label key={b} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-[var(--color-bg-secondary)] cursor-pointer">
                                  <input
                                    type="checkbox"
                                    className="rounded border-[var(--color-border)] shrink-0"
                                    checked={pickedBranches.includes(b)}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setPickedBranches((prev) => [...prev, b].sort((x, y) => x.localeCompare(y)))
                                      } else {
                                        setPickedBranches((prev) => prev.filter((x) => x !== b))
                                      }
                                    }}
                                  />
                                  <span className="break-all">{b}</span>
                                </label>
                              ))
                            )}
                          </div>
                        </>
                      ) : null}
                    </div>
                  )}
                </div>
              )}

              <details
                className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2"
                onToggle={(e) => setManualOpen(e.currentTarget.open)}
              >
                <summary className="text-sm font-medium text-[var(--color-text-primary)] cursor-pointer">
                  Enter workspace, repository, and branch manually
                </summary>
                <div className="grid gap-3 sm:grid-cols-2 mt-3 pt-3 border-t border-[var(--color-border)]">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Workspace slug</label>
                    <input
                      className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm"
                      value={manualWs}
                      onChange={(e) => setManualWs(e.target.value)}
                      placeholder="e.g. your-company"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Repository slug</label>
                    <input
                      className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm"
                      value={manualRepo}
                      onChange={(e) => setManualRepo(e.target.value)}
                      placeholder="e.g. main-product"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Branch</label>
                    <input
                      className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm"
                      value={manualBranch}
                      onChange={(e) => setManualBranch(e.target.value)}
                      placeholder="main"
                    />
                  </div>
                </div>
              </details>

              {canUseSplitPipeline && (
                <div className="rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50/80 px-3 py-3 space-y-2 max-w-2xl">
                  <p className="text-sm font-semibold text-emerald-950">Split sync (large repos)</p>
                  <p className="text-xs text-emerald-900/90 leading-relaxed">
                    <strong>1. Prepare clone</strong> pulls from Bitbucket to the worker disk only (no embeddings yet).{' '}
                    <strong>2. Index &amp; embed</strong> reads that copy and updates Supabase. Unchanged files are{' '}
                    <strong>not</strong> re-embedded automatically (same as a normal sync). Use &quot;Full rebuild&quot; below
                    only when you need to wipe and rebuild vectors for this branch.{' '}
                    <strong>3. CodeWiki only</strong> re-runs the structure graph and repository overview from the saved mirror
                    without touching vectors (useful after a failed overview or config change).
                  </p>
                  <p className="text-xs text-emerald-900/85 leading-relaxed border-t border-emerald-200/80 pt-2">
                    On the worker, enable git-based ingest when your admin has configured it: the worker clones with{' '}
                    <strong>no checkout</strong> and reads the tree via git, which avoids most Bitbucket REST rate limits and
                    avoids Windows checkout failures when the repository contains paths that are not valid local file names.
                    Individual files that still fail to read are skipped so the rest of the branch can finish.
                  </p>
                  {mirrorLoading ? (
                    <p className="text-xs text-emerald-800">Checking saved mirror…</p>
                  ) : mirrorRow ? (
                    <p className="text-xs text-emerald-900">
                      Last mirror for <span className="font-mono">{mirrorRow.sync_branch}</span>:{' '}
                      <span className="font-mono">{mirrorRow.head_commit_sha?.slice(0, 7) ?? '?'}</span>
                      {mirrorRow.updated_at ? (
                        <span className="text-emerald-800/80">
                          {' '}
                          · updated {new Date(mirrorRow.updated_at).toLocaleString()}
                        </span>
                      ) : null}
                    </p>
                  ) : (
                    <p className="text-xs text-amber-900 bg-amber-50 border border-amber-100 rounded px-2 py-1.5">
                      No prepared mirror for this branch yet. Run <strong>Prepare clone</strong> before Index &amp; embed.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      className="rounded-lg border border-emerald-600 bg-white px-3 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-100 disabled:opacity-50"
                      disabled={syncDisabled}
                      onClick={() => void runSync('clone_only')}
                    >
                      1. Prepare clone
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-emerald-700 bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                      disabled={syncDisabled}
                      onClick={() => void runSync('embed_only')}
                    >
                      2. Index &amp; embed
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-emerald-600 bg-emerald-100/90 px-3 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-200/90 disabled:opacity-50"
                      disabled={syncDisabled}
                      onClick={() => void runSync('codewiki_only')}
                    >
                      3. CodeWiki only
                    </button>
                  </div>
                </div>
              )}

              {showLocalMirrorUi && (
                <div className="rounded-[var(--radius-md)] border border-primary/20 bg-primary/5 px-3 py-3 space-y-2 max-w-2xl">
                  <p className="text-sm font-medium text-[var(--color-text-primary)]">Local working copy (optional)</p>
                  <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                    If your ingest worker runs on this PC and you already ran <code className="text-[11px]">git clone</code>{' '}
                    here, paste the repo folder path. Indexing reads from that tree (no fresh clone). Requires server env{' '}
                    <code className="text-[11px]">PK_ALLOW_LOCAL_WORKING_COPY=1</code> and{' '}
                    <code className="text-[11px]">PK_LOCAL_WORKING_COPY_ALLOW_PREFIXES</code> covering that folder.
                  </p>
                  <input
                    type="text"
                    className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm font-mono"
                    value={localWorkingCopyPath}
                    onChange={(e) => setLocalWorkingCopyPath(e.target.value)}
                    placeholder="e.g. C:\Users\you\repos\health-expert-connect"
                    autoComplete="off"
                  />
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                    <span>Recorded as:</span>
                    <label className="inline-flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="mirror-env"
                        checked={mirrorEnvironment === 'local'}
                        onChange={() => setMirrorEnvironment('local')}
                      />
                      Local dev
                    </label>
                    <label className="inline-flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="mirror-env"
                        checked={mirrorEnvironment === 'cloud'}
                        onChange={() => setMirrorEnvironment('cloud')}
                      />
                      Cloud worker
                    </label>
                  </div>
                </div>
              )}

              <label className="flex items-start gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer max-w-xl">
                <input
                  type="checkbox"
                  checked={fullReindex}
                  onChange={(e) => setFullReindex(e.target.checked)}
                  className="mt-1 rounded border-[var(--color-border)]"
                />
                <span>
                  <span className="font-medium text-[var(--color-text-primary)]">Full rebuild for this branch</span>
                  <span className="block text-xs text-[var(--color-text-tertiary)] mt-0.5">
                    Applies to <strong>Full sync (one step)</strong> and <strong>Index &amp; embed</strong> only: ignored for{' '}
                    <strong>Prepare clone</strong>. Wipes stored chunks/embeddings for this branch, then re-indexes from the
                    mirror (unchanged-file skipping is bypassed). Leave off for normal incremental updates.
                  </span>
                </span>
              </label>

              <div className="pt-1 space-y-1">
                <button
                  type="button"
                  className="pk-btn-primary"
                  disabled={syncDisabled}
                  onClick={() => void runSync('full')}
                >
                  {busy ? 'Starting…' : 'Full sync (one step)'}
                </button>
                <p className="text-xs text-[var(--color-text-tertiary)] max-w-xl">
                  Clone/index/embed in one job. Prefer <strong>split sync</strong> above if Bitbucket times out or you want
                  control over when indexing runs.
                </p>
              </div>
            </div>
          </details>
        </>
      )}

      {!loadingLinked && infoNote && (
        <p className="text-sm text-amber-950 bg-amber-50 border border-amber-200 rounded-[var(--radius-md)] px-3 py-2">
          {infoNote}
        </p>
      )}
      {!loadingLinked && localMsg && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-[var(--radius-md)] px-3 py-2">{localMsg}</p>
      )}
    </div>
  )
}
