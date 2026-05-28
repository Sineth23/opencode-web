'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  CircleStackIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
  ArrowPathIcon,
  ExclamationCircleIcon,
  FolderIcon,
  FolderOpenIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  CheckIcon,
} from '@heroicons/react/24/outline'
import { cdkGet } from '@/lib/cdk-api'
import { listDatasets, indexDataset, deleteDataset, type Dataset } from '@/lib/assistant-api'

// ── S3 browser types ──────────────────────────────────────────────────────────
type S3Folder = { prefix: string; name: string }
type S3File   = { key: string; name: string; size: number; lastModified: string }
type ListResp  = { ok: boolean; folders: S3Folder[]; files: S3File[] }

type FolderNode = {
  prefix: string
  name: string
  state: 'idle' | 'loading' | 'loaded' | 'error'
  open: boolean
  children: FolderNode[]
}

function makeNode(prefix: string, name: string): FolderNode {
  return { prefix, name, state: 'idle', open: false, children: [] }
}

const STATUS_CONFIG = {
  READY:    { label: 'Ready',    color: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  INDEXING: { label: 'Indexing', color: 'text-amber-700 bg-amber-50 border-amber-200' },
  FAILED:   { label: 'Failed',   color: 'text-red-700 bg-red-50 border-red-200' },
  DELETING: { label: 'Deleting', color: 'text-gray-500 bg-gray-50 border-gray-200' },
}

// ── S3 folder tree (recursive) ────────────────────────────────────────────────
function FolderRow({
  node,
  depth,
  selected,
  onSelect,
  onToggle,
}: {
  node: FolderNode
  depth: number
  selected: string
  onSelect: (prefix: string, name: string) => void
  onToggle: (prefix: string) => void
}) {
  const isSelected = selected === node.prefix

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer text-[12px] transition-colors select-none ${
          isSelected
            ? 'bg-primary/10 text-primary font-medium'
            : 'hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]'
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => onToggle(node.prefix)}
      >
        {node.state === 'loading' ? (
          <motion.div
            className="h-3.5 w-3.5 rounded-full border-2 border-primary/30 border-t-primary flex-shrink-0"
            animate={{ rotate: 360 }}
            transition={{ duration: 0.7, repeat: Infinity, ease: 'linear' }}
          />
        ) : node.open ? (
          <ChevronDownIcon className="h-3 w-3 flex-shrink-0 opacity-50" />
        ) : (
          <ChevronRightIcon className="h-3 w-3 flex-shrink-0 opacity-40" />
        )}
        {node.open
          ? <FolderOpenIcon className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
          : <FolderIcon className="h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
        }
        <span className="truncate flex-1">{node.name}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onSelect(node.prefix, node.name) }}
          className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${
            isSelected
              ? 'bg-primary text-white'
              : 'opacity-0 group-hover:opacity-100 bg-primary/10 text-primary hover:bg-primary hover:text-white'
          }`}
          title="Index this directory"
        >
          {isSelected ? <CheckIcon className="h-3 w-3" /> : 'Select'}
        </button>
      </div>

      {node.open && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <FolderRow
              key={child.prefix}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
      {node.open && node.state === 'loaded' && node.children.length === 0 && (
        <p
          className="text-[10px] text-[var(--color-text-tertiary)] italic py-1"
          style={{ paddingLeft: `${8 + (depth + 1) * 14 + 18}px` }}
        >
          No sub-folders
        </p>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function DatasetManager({ activeTenantId }: { activeTenantId?: string | null }) {
  const [open, setOpen]         = useState(false)
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  // form
  const [showForm, setShowForm]     = useState(false)
  const [indexing, setIndexing]     = useState(false)
  const [indexError, setIndexError] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  // S3 browser state
  const [roots, setRoots]             = useState<FolderNode[]>([])
  const [browserLoading, setBrowserLoading] = useState(false)
  const [selectedPrefix, setSelectedPrefix] = useState('')
  const [selectedName, setSelectedName]     = useState('')

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── data fetching ────────────────────────────────────────────────────────────
  const fetchDatasets = useCallback(async () => {
    try {
      const d = await listDatasets(activeTenantId ?? undefined)
      setDatasets(d.datasets ?? [])
    } catch (e) {
      setError((e as Error).message)
    }
  }, [activeTenantId])

  const loadChildren = useCallback(async (prefix: string): Promise<FolderNode[]> => {
    const qs = new URLSearchParams({ prefix })
    if (activeTenantId) qs.set('tenantId', activeTenantId)
    const data = await cdkGet<ListResp>(`/opencode/files?${qs.toString()}`)
    return (data.folders ?? []).map((f) => makeNode(f.prefix, f.name))
  }, [activeTenantId])

  // Load root folders when form opens
  const loadRoots = useCallback(async () => {
    setBrowserLoading(true)
    try {
      const children = await loadChildren('projects/')
      setRoots(children)
    } catch {
      setRoots([])
    } finally {
      setBrowserLoading(false)
    }
  }, [loadChildren])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    void fetchDatasets().finally(() => setLoading(false))
  }, [open, fetchDatasets])

  useEffect(() => {
    if (showForm && roots.length === 0 && !browserLoading) void loadRoots()
  }, [showForm, roots.length, browserLoading, loadRoots])

  useEffect(() => {
    const busy = datasets.some((d) => d.status === 'INDEXING' || d.status === 'DELETING')
    if (busy && !pollRef.current) {
      pollRef.current = setInterval(() => void fetchDatasets(), 4000)
    } else if (!busy && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [datasets, fetchDatasets])

  // ── tree toggle ──────────────────────────────────────────────────────────────
  const toggleNode = useCallback(async (prefix: string) => {
    const update = (nodes: FolderNode[]): FolderNode[] =>
      nodes.map((n) => {
        if (n.prefix === prefix) {
          if (n.open) return { ...n, open: false }
          if (n.state === 'loaded') return { ...n, open: true }
          return { ...n, open: true, state: 'loading' }
        }
        return { ...n, children: update(n.children) }
      })

    setRoots((prev) => update(prev))

    // find node to check if we need to load
    const find = (nodes: FolderNode[]): FolderNode | null => {
      for (const n of nodes) {
        if (n.prefix === prefix) return n
        const found = find(n.children)
        if (found) return found
      }
      return null
    }

    const node = find(roots)
    if (!node || node.state === 'loaded' || node.open) return

    try {
      const children = await loadChildren(prefix)
      const fill = (nodes: FolderNode[]): FolderNode[] =>
        nodes.map((n) =>
          n.prefix === prefix
            ? { ...n, state: 'loaded', open: true, children }
            : { ...n, children: fill(n.children) }
        )
      setRoots((prev) => fill(prev))
    } catch {
      const err = (nodes: FolderNode[]): FolderNode[] =>
        nodes.map((n) =>
          n.prefix === prefix
            ? { ...n, state: 'error', open: false }
            : { ...n, children: err(n.children) }
        )
      setRoots((prev) => err(prev))
    }
  }, [roots, loadChildren])

  // ── actions ──────────────────────────────────────────────────────────────────
  function resetForm() {
    setShowForm(false)
    setSelectedPrefix('')
    setSelectedName('')
    setIndexError(null)
  }

  async function handleIndex() {
    setIndexError(null)
    if (!selectedPrefix) { setIndexError('Select a directory to index.'); return }
    setIndexing(true)
    try {
      await indexDataset(selectedName || selectedPrefix, selectedPrefix, 'full', activeTenantId ?? undefined)
      resetForm()
      setRoots([])
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

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Sidebar trigger */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center justify-between w-full px-3 py-2 rounded-lg
          text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]
          hover:bg-[var(--color-bg-secondary)] transition-colors"
      >
        <span className="flex items-center gap-2">
          <CircleStackIcon className="h-3.5 w-3.5 shrink-0" />
          Knowledge bases
        </span>
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
          readyCount > 0
            ? 'bg-emerald-100 text-emerald-700'
            : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]'
        }`}>
          {readyCount}
        </span>
      </button>

      {/* Modal */}
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
              className="relative w-full max-w-xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] flex flex-col max-h-[85vh]"
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)] flex-shrink-0">
                <div>
                  <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Knowledge bases</h2>
                  <p className="text-[11px] text-[var(--color-text-tertiary)] mt-0.5">
                    Browse your S3 bucket and index a directory for the assistant.
                  </p>
                </div>
                <button
                  onClick={() => setOpen(false)}
                  className="p-1.5 rounded-lg text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto min-h-0 p-5 space-y-5">

                {/* Index form */}
                <div className="rounded-xl border border-[var(--color-border)] overflow-hidden">
                  <button
                    onClick={() => { setShowForm((v) => !v); setIndexError(null) }}
                    className="flex items-center gap-2 w-full px-4 py-3 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors text-left"
                  >
                    <PlusIcon className="h-4 w-4 text-primary shrink-0" />
                    Index a directory
                  </button>

                  <AnimatePresence>
                    {showForm && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                      >
                        <div className="border-t border-[var(--color-border)]">

                          {/* Selected path banner */}
                          {selectedPrefix ? (
                            <div className="px-4 pt-3 pb-2">
                              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-700">
                                <CheckIcon className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Selected for indexing</p>
                                  <p className="text-[11px] font-mono text-emerald-800 dark:text-emerald-300 truncate">{selectedPrefix}</p>
                                </div>
                                <button
                                  onClick={() => { setSelectedPrefix(''); setSelectedName('') }}
                                  className="text-emerald-600 hover:text-emerald-800 flex-shrink-0"
                                >
                                  <XMarkIcon className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          ) : (
                            <p className="px-4 pt-3 pb-1 text-[11px] text-[var(--color-text-tertiary)]">
                              Browse and click <strong>Select</strong> on any folder to index it.
                            </p>
                          )}

                          {/* S3 folder tree */}
                          <div className="px-2 pb-2 max-h-64 overflow-y-auto">
                            {browserLoading ? (
                              <div className="flex items-center gap-2 px-3 py-4 text-[12px] text-[var(--color-text-tertiary)]">
                                <motion.div
                                  className="h-3.5 w-3.5 rounded-full border-2 border-primary/30 border-t-primary"
                                  animate={{ rotate: 360 }}
                                  transition={{ duration: 0.7, repeat: Infinity, ease: 'linear' }}
                                />
                                Loading directories…
                              </div>
                            ) : roots.length === 0 ? (
                              <p className="px-3 py-4 text-[12px] text-[var(--color-text-tertiary)]">No directories found.</p>
                            ) : (
                              <div className="group">
                                {roots.map((node) => (
                                  <FolderRow
                                    key={node.prefix}
                                    node={node}
                                    depth={0}
                                    selected={selectedPrefix}
                                    onSelect={(prefix, name) => { setSelectedPrefix(prefix); setSelectedName(name) }}
                                    onToggle={toggleNode}
                                  />
                                ))}
                              </div>
                            )}
                          </div>

                          {indexError && (
                            <p className="mx-4 mb-3 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{indexError}</p>
                          )}

                          <div className="flex gap-2 justify-end px-4 pb-4">
                            <button
                              onClick={resetForm}
                              className="px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => void handleIndex()}
                              disabled={!selectedPrefix || indexing}
                              className="px-4 py-1.5 text-sm font-medium bg-primary text-white rounded-lg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-2"
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
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-3">
                    Indexed datasets
                  </p>

                  {loading ? (
                    <div className="space-y-2">
                      {[1, 2].map((i) => (
                        <div key={i} className="h-14 rounded-xl bg-[var(--color-bg-tertiary)] animate-pulse" />
                      ))}
                    </div>
                  ) : error ? (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">{error}</p>
                  ) : datasets.length === 0 ? (
                    <div className="text-center py-8 text-[var(--color-text-tertiary)]">
                      <CircleStackIcon className="h-7 w-7 mx-auto mb-2 opacity-30" />
                      <p className="text-xs">No datasets yet. Index a directory above to get started.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {datasets.map((ds) => {
                        const cfg    = STATUS_CONFIG[ds.status]
                        const isBusy = ds.status === 'INDEXING' || ds.status === 'DELETING'
                        return (
                          <div
                            key={ds.datasetId}
                            className="flex items-center gap-3 px-4 py-3 rounded-xl border border-[var(--color-border)]"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
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
                                  : ds.status === 'INDEXING' ? 'Indexing in progress…'
                                  : ds.status === 'FAILED'   ? 'Indexing failed — try again'
                                  : 'Removing…'}
                              </p>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {ds.status === 'FAILED' && (
                                <button title="Retry" className="p-1.5 rounded text-[var(--color-text-tertiary)] hover:text-primary hover:bg-[var(--color-accent-light)] transition-colors">
                                  <ArrowPathIcon className="h-4 w-4" />
                                </button>
                              )}
                              {ds.status === 'INDEXING' && (
                                <ExclamationCircleIcon className="h-4 w-4 text-amber-400" />
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
