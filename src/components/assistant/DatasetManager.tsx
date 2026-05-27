'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  CircleStackIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  FolderOpenIcon,
  DocumentTextIcon,
  CodeBracketIcon,
} from '@heroicons/react/24/outline'
import {
  listDatasets,
  listAvailableRepos,
  indexDataset,
  deleteDataset,
  type Dataset,
  type AvailableRepo,
} from '@/lib/assistant-api'

const STATUS_CONFIG = {
  READY:    { label: 'Ready',    color: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  INDEXING: { label: 'Indexing', color: 'text-amber-700 bg-amber-50 border-amber-200' },
  FAILED:   { label: 'Failed',   color: 'text-red-700 bg-red-50 border-red-200' },
  DELETING: { label: 'Deleting', color: 'text-gray-500 bg-gray-50 border-gray-200' },
}

type IndexMode = 'full' | 'catalog'

export default function DatasetManager({ activeTenantId }: { activeTenantId?: string | null }) {
  const [open, setOpen] = useState(false)
  const [datasets, setDatasets]   = useState<Dataset[]>([])
  const [repos, setRepos]         = useState<AvailableRepo[]>([])
  const [loading, setLoading]     = useState(false)
  const [reposLoading, setReposLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  // Indexing form state
  const [showForm, setShowForm]   = useState(false)
  const [selectedRepo, setSelectedRepo] = useState<AvailableRepo | null>(null)
  const [indexMode, setIndexMode] = useState<IndexMode>('full')
  const [indexing, setIndexing]   = useState(false)
  const [indexError, setIndexError] = useState<string | null>(null)

  const [removingId, setRemovingId] = useState<string | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchDatasets = useCallback(async () => {
    try {
      const d = await listDatasets(activeTenantId ?? undefined)
      setDatasets(d.datasets ?? [])
    } catch (e) {
      setError((e as Error).message)
    }
  }, [activeTenantId])

  const fetchRepos = useCallback(async () => {
    setReposLoading(true)
    try {
      const d = await listAvailableRepos(activeTenantId ?? undefined)
      setRepos(d.repos ?? [])
    } catch {
      // silently fail — repos will be empty
    } finally {
      setReposLoading(false)
    }
  }, [activeTenantId])

  // Load datasets when panel opens
  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    void fetchDatasets().finally(() => setLoading(false))
    void fetchRepos()
  }, [open, fetchDatasets, fetchRepos])

  // Poll while any dataset is indexing or deleting
  useEffect(() => {
    const busy = datasets.some((d) => d.status === 'INDEXING' || d.status === 'DELETING')
    if (busy && !pollRef.current) {
      pollRef.current = setInterval(() => void fetchDatasets(), 4000)
    } else if (!busy && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [datasets, fetchDatasets])

  async function handleIndex() {
    if (!selectedRepo) return
    setIndexing(true)
    setIndexError(null)
    const prefix = indexMode === 'catalog' && selectedRepo.catalogPrefix
      ? selectedRepo.catalogPrefix
      : selectedRepo.worktreePrefix
    try {
      await indexDataset(selectedRepo.name, prefix, indexMode, activeTenantId ?? undefined)
      setShowForm(false)
      setSelectedRepo(null)
      setIndexMode('full')
      await fetchDatasets()
    } catch (e) {
      setIndexError((e as Error).message)
    } finally {
      setIndexing(false)
    }
  }

  async function handleDelete(datasetId: string) {
    if (!confirm('Delete this dataset? All indexed vectors will be removed permanently.')) return
    setRemovingId(datasetId)
    try {
      await deleteDataset(datasetId)
      setDatasets((prev) => prev.filter((d) => d.datasetId !== datasetId))
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setRemovingId(null)
    }
  }

  const readyCount = datasets.filter((d) => d.status === 'READY').length

  return (
    <>
      {/* Sidebar trigger */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center justify-between w-full px-3 py-2 rounded-lg
          text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]
          hover:bg-[var(--color-bg-secondary)] transition-colors group"
      >
        <span className="flex items-center gap-2">
          <CircleStackIcon className="h-3.5 w-3.5 shrink-0" />
          Knowledge bases
        </span>
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
          readyCount > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]'
        }`}>
          {readyCount}
        </span>
      </button>

      {/* Modal overlay */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setOpen(false)} />

            <motion.div
              className="relative w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] flex flex-col max-h-[80vh]"
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
                <div>
                  <h2 className="text-base font-semibold text-[var(--color-text-primary)]">Knowledge bases</h2>
                  <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5">
                    Index repos or doc directories so the assistant can answer questions about them.
                  </p>
                </div>
                <button
                  onClick={() => setOpen(false)}
                  className="p-1.5 rounded-lg text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto min-h-0 p-6 space-y-6">

                {/* Index new form */}
                <div className="rounded-xl border border-[var(--color-border)] overflow-hidden">
                  <button
                    onClick={() => { setShowForm((v) => !v); setIndexError(null) }}
                    className="flex items-center gap-2 w-full px-4 py-3 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors text-left"
                  >
                    <PlusIcon className="h-4 w-4 text-primary shrink-0" />
                    Index a repo or directory
                  </button>

                  <AnimatePresence>
                    {showForm && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 pb-4 border-t border-[var(--color-border)] space-y-4 pt-4">

                          {/* Repo picker */}
                          <div>
                            <p className="text-xs font-medium text-[var(--color-text-secondary)] mb-2">Select repo</p>
                            {reposLoading ? (
                              <div className="space-y-2">
                                {[1, 2].map((i) => (
                                  <div key={i} className="h-12 rounded-lg bg-[var(--color-bg-tertiary)] animate-pulse" />
                                ))}
                              </div>
                            ) : repos.length === 0 ? (
                              <p className="text-xs text-[var(--color-text-tertiary)] py-3 text-center">
                                No cloned repos found. Clone a repo first via Sync center.
                              </p>
                            ) : (
                              <div className="space-y-2">
                                {repos.map((repo) => (
                                  <button
                                    key={repo.worktreePrefix}
                                    onClick={() => setSelectedRepo(repo)}
                                    className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg border text-left transition-all ${
                                      selectedRepo?.worktreePrefix === repo.worktreePrefix
                                        ? 'border-primary bg-[var(--color-accent-light)]'
                                        : 'border-[var(--color-border)] hover:border-primary/50 hover:bg-[var(--color-bg-secondary)]'
                                    }`}
                                  >
                                    <FolderOpenIcon className={`h-4 w-4 shrink-0 ${
                                      selectedRepo?.worktreePrefix === repo.worktreePrefix ? 'text-primary' : 'text-[var(--color-text-tertiary)]'
                                    }`} />
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">{repo.name}</p>
                                      <p className="text-[10px] text-[var(--color-text-tertiary)]">
                                        Cloned {new Date(repo.clonedAt).toLocaleDateString()}
                                      </p>
                                    </div>
                                    {selectedRepo?.worktreePrefix === repo.worktreePrefix && (
                                      <CheckCircleIcon className="h-4 w-4 text-primary shrink-0" />
                                    )}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Mode toggle */}
                          {selectedRepo && (
                            <div>
                              <p className="text-xs font-medium text-[var(--color-text-secondary)] mb-2">What to index</p>
                              <div className="grid grid-cols-2 gap-2">
                                <button
                                  onClick={() => setIndexMode('full')}
                                  className={`flex items-start gap-2.5 px-3 py-3 rounded-lg border text-left transition-all ${
                                    indexMode === 'full'
                                      ? 'border-primary bg-[var(--color-accent-light)]'
                                      : 'border-[var(--color-border)] hover:border-primary/40'
                                  }`}
                                >
                                  <CodeBracketIcon className={`h-4 w-4 mt-0.5 shrink-0 ${indexMode === 'full' ? 'text-primary' : 'text-[var(--color-text-tertiary)]'}`} />
                                  <div>
                                    <p className="text-xs font-semibold text-[var(--color-text-primary)]">Full repo</p>
                                    <p className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5 leading-snug">
                                      All code and markdown files. Best for code questions.
                                    </p>
                                  </div>
                                </button>
                                <button
                                  onClick={() => setIndexMode('catalog')}
                                  disabled={!selectedRepo.catalogPrefix}
                                  className={`flex items-start gap-2.5 px-3 py-3 rounded-lg border text-left transition-all ${
                                    !selectedRepo.catalogPrefix ? 'opacity-40 cursor-not-allowed border-[var(--color-border)]' :
                                    indexMode === 'catalog'
                                      ? 'border-primary bg-[var(--color-accent-light)]'
                                      : 'border-[var(--color-border)] hover:border-primary/40'
                                  }`}
                                >
                                  <DocumentTextIcon className={`h-4 w-4 mt-0.5 shrink-0 ${indexMode === 'catalog' ? 'text-primary' : 'text-[var(--color-text-tertiary)]'}`} />
                                  <div>
                                    <p className="text-xs font-semibold text-[var(--color-text-primary)]">Docs only</p>
                                    <p className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5 leading-snug">
                                      Generated catalog markdown. Faster and smaller.
                                      {!selectedRepo.catalogPrefix && ' (not available)'}
                                    </p>
                                  </div>
                                </button>
                              </div>
                            </div>
                          )}

                          {indexError && (
                            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{indexError}</p>
                          )}

                          <div className="flex gap-2 justify-end">
                            <button
                              onClick={() => { setShowForm(false); setSelectedRepo(null); setIndexError(null) }}
                              className="px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => void handleIndex()}
                              disabled={!selectedRepo || indexing}
                              className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-2"
                            >
                              {indexing ? (
                                <>
                                  <motion.div
                                    className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white"
                                    animate={{ rotate: 360 }}
                                    transition={{ duration: 0.7, repeat: Infinity, ease: 'linear' }}
                                  />
                                  Starting…
                                </>
                              ) : 'Start indexing'}
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Datasets list */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-3">
                    Indexed datasets
                  </p>

                  {loading ? (
                    <div className="space-y-2">
                      {[1, 2].map((i) => (
                        <div key={i} className="h-16 rounded-xl bg-[var(--color-bg-tertiary)] animate-pulse" />
                      ))}
                    </div>
                  ) : error ? (
                    <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">{error}</p>
                  ) : datasets.length === 0 ? (
                    <div className="text-center py-10 text-[var(--color-text-tertiary)]">
                      <CircleStackIcon className="h-8 w-8 mx-auto mb-3 opacity-30" />
                      <p className="text-sm">No datasets yet.</p>
                      <p className="text-xs mt-1">Index a repo above to get started.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {datasets.map((ds) => {
                        const cfg = STATUS_CONFIG[ds.status]
                        const isBusy = ds.status === 'INDEXING' || ds.status === 'DELETING'
                        return (
                          <div
                            key={ds.datasetId}
                            className="flex items-center gap-3 px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 min-w-0">
                                <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">{ds.name}</p>
                                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border shrink-0 flex items-center gap-1 ${cfg.color}`}>
                                  {isBusy && (
                                    <motion.span
                                      className="inline-block h-1.5 w-1.5 rounded-full bg-current"
                                      animate={{ opacity: [1, 0.3, 1] }}
                                      transition={{ duration: 1, repeat: Infinity }}
                                    />
                                  )}
                                  {cfg.label}
                                </span>
                              </div>
                              <p className="text-[11px] text-[var(--color-text-tertiary)] mt-0.5">
                                {ds.status === 'READY'
                                  ? `${ds.fileCount.toLocaleString()} files · ${ds.chunkCount.toLocaleString()} chunks`
                                  : ds.status === 'INDEXING'
                                    ? 'Indexing in progress…'
                                    : ds.status === 'FAILED'
                                      ? 'Indexing failed — try again'
                                      : 'Removing…'}
                              </p>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {ds.status === 'FAILED' && (
                                <button
                                  title="Retry indexing"
                                  className="p-1.5 rounded text-[var(--color-text-tertiary)] hover:text-primary hover:bg-[var(--color-accent-light)] transition-colors"
                                >
                                  <ArrowPathIcon className="h-4 w-4" />
                                </button>
                              )}
                              {ds.status === 'INDEXING' && (
                                <ExclamationCircleIcon className="h-4 w-4 text-amber-500" />
                              )}
                              <button
                                disabled={removingId === ds.datasetId || isBusy}
                                onClick={() => void handleDelete(ds.datasetId)}
                                className="p-1.5 rounded text-[var(--color-text-tertiary)] hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                title="Delete dataset"
                              >
                                {removingId === ds.datasetId
                                  ? <span className="text-xs">…</span>
                                  : <TrashIcon className="h-4 w-4" />}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
