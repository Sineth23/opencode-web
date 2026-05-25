'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import type { ExtraProps } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentTextIcon,
  FolderIcon,
  FolderOpenIcon,
} from '@heroicons/react/24/outline'
import { cdkFetch, cdkGet } from '@/lib/cdk-api'

// ─── CDK API types ────────────────────────────────────────────────────────────

type S3File = { key: string; name: string; size: number; lastModified: string }
type S3Folder = { prefix: string; name: string }
type ListResponse = { ok: boolean; folders: S3Folder[]; files: S3File[] }
type ReadResponse = { ok: boolean; key: string; contentType: string; size: number; content: string }

// ─── Tree node ────────────────────────────────────────────────────────────────

type NodeState = 'idle' | 'loading' | 'loaded' | 'error'

type TreeNode = {
  prefix: string       // S3 prefix — unique ID
  name: string         // display name
  depth: number
  state: NodeState
  folders: TreeNode[]
  files: S3File[]
}

function makeNode(prefix: string, name: string, depth: number): TreeNode {
  return { prefix, name, depth, state: 'idle', folders: [], files: [] }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function titleFromFile(file: S3File): string {
  return file.name
    .replace(/\.md$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(0)} KB`
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

type CodeProps = ComponentPropsWithoutRef<'code'> & ExtraProps & { inline?: boolean }

function MarkdownBody({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ inline, className, children, ...props }: CodeProps) {
          const match = /language-(\w+)/.exec(className ?? '')
          return !inline && match ? (
            <SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div">
              {String(children).replace(/\n$/, '')}
            </SyntaxHighlighter>
          ) : (
            <code
              className={`${className ?? ''} bg-[var(--color-bg-tertiary)] px-1 py-0.5 rounded text-sm font-mono`}
              {...props}
            >
              {children}
            </code>
          )
        },
        h1: ({ children }) => <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mt-6 mb-3 leading-tight">{children}</h1>,
        h2: ({ children }) => <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-5 mb-2 leading-tight">{children}</h2>,
        h3: ({ children }) => <h3 className="text-base font-semibold text-[var(--color-text-primary)] mt-4 mb-1">{children}</h3>,
        p: ({ children }) => <p className="text-[var(--color-text-secondary)] leading-relaxed mb-3">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-inside space-y-1 mb-3 text-[var(--color-text-secondary)]">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside space-y-1 mb-3 text-[var(--color-text-secondary)]">{children}</ol>,
        li: ({ children }) => <li className="text-[var(--color-text-secondary)]">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-4 border-[var(--color-border-focus)] pl-4 italic text-[var(--color-text-tertiary)] my-3">
            {children}
          </blockquote>
        ),
        hr: () => <hr className="border-[var(--color-border)] my-4" />,
        strong: ({ children }) => <strong className="font-semibold text-[var(--color-text-primary)]">{children}</strong>,
        table: ({ children }) => (
          <div className="overflow-x-auto mb-4">
            <table className="w-full text-sm border-collapse">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-left font-semibold text-[var(--color-text-primary)]">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-[var(--color-border)] px-3 py-2 text-[var(--color-text-secondary)]">
            {children}
          </td>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

// ─── Tree node row ────────────────────────────────────────────────────────────

function FolderRow({
  node,
  open,
  onToggle,
}: {
  node: TreeNode
  open: boolean
  onToggle: () => void
}) {
  const indent = node.depth * 12

  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-sm hover:bg-[var(--color-bg-tertiary)] transition-colors text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
      style={{ paddingLeft: `${8 + indent}px` }}
    >
      {node.state === 'loading' ? (
        <svg className="animate-spin h-3.5 w-3.5 shrink-0 text-[var(--color-text-tertiary)]" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : open ? (
        <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <ChevronRightIcon className="h-3.5 w-3.5 shrink-0" />
      )}
      {open ? (
        <FolderOpenIcon className="h-4 w-4 shrink-0 text-amber-500" />
      ) : (
        <FolderIcon className="h-4 w-4 shrink-0 text-amber-500/70" />
      )}
      <span className="truncate text-left font-medium">{node.name}</span>
    </button>
  )
}

function FileRow({
  file,
  depth,
  selected,
  onSelect,
}: {
  file: S3File
  depth: number
  selected: boolean
  onSelect: () => void
}) {
  const indent = depth * 12

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full flex items-start gap-1.5 px-2 py-1.5 rounded text-sm transition-all ${
        selected
          ? 'bg-primary/10 text-primary font-medium'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
      }`}
      style={{ paddingLeft: `${8 + indent}px` }}
    >
      <DocumentTextIcon className="h-3.5 w-3.5 mt-0.5 shrink-0 opacity-60" />
      <span className="break-words text-left leading-snug">{titleFromFile(file)}</span>
    </button>
  )
}

// ─── Recursive tree renderer ──────────────────────────────────────────────────

function TreeView({
  node,
  openPrefixes,
  selectedKey,
  onToggle,
  onSelectFile,
}: {
  node: TreeNode
  openPrefixes: Set<string>
  selectedKey: string | null
  onToggle: (node: TreeNode) => void
  onSelectFile: (file: S3File) => void
}) {
  const open = openPrefixes.has(node.prefix)

  return (
    <div>
      <FolderRow node={node} open={open} onToggle={() => onToggle(node)} />
      {open && node.state === 'loaded' && (
        <div>
          {node.files
            .filter((f) => f.name.toLowerCase().endsWith('.md'))
            .map((f) => (
              <FileRow
                key={f.key}
                file={f}
                depth={node.depth + 1}
                selected={f.key === selectedKey}
                onSelect={() => onSelectFile(f)}
              />
            ))}
          {node.folders.map((child) => (
            <TreeView
              key={child.prefix}
              node={child}
              openPrefixes={openPrefixes}
              selectedKey={selectedKey}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
            />
          ))}
          {node.files.filter((f) => f.name.toLowerCase().endsWith('.md')).length === 0 &&
            node.folders.length === 0 && (
              <p
                className="text-xs text-[var(--color-text-tertiary)] py-1"
                style={{ paddingLeft: `${8 + (node.depth + 1) * 12}px` }}
              >
                No documents
              </p>
            )}
        </div>
      )}
      {open && node.state === 'error' && (
        <p
          className="text-xs text-[var(--color-error)] py-1"
          style={{ paddingLeft: `${8 + (node.depth + 1) * 12}px` }}
        >
          Failed to load
        </p>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function S3DocsBrowser() {
  // Root nodes (top-level project folders under projects/)
  const [roots, setRoots] = useState<TreeNode[]>([])
  const [rootState, setRootState] = useState<NodeState>('idle')

  // Which folder prefixes are expanded
  const [openPrefixes, setOpenPrefixes] = useState<Set<string>>(new Set())

  // Selected file + its loaded content
  const [selectedFile, setSelectedFile] = useState<S3File | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [contentLoading, setContentLoading] = useState(false)
  const [contentError, setContentError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const contentPaneRef = useRef<HTMLDivElement>(null)

  // Load root folders on mount
  useEffect(() => {
    const ac = new AbortController()
    const load = async () => {
      setRootState('loading')
      try {
        const res = await cdkFetch('/opencode/files?prefix=projects/', { signal: ac.signal })
        if (!res.ok) { setRootState('error'); return }
        const data = await res.json() as ListResponse
        if (!data.ok) { setRootState('error'); return }
        const nodes = data.folders.map((f) => makeNode(f.prefix, f.name, 0))
        setRoots(nodes)
        setRootState('loaded')
      } catch (e) {
        if (!ac.signal.aborted) setRootState('error')
      }
    }
    void load()
    return () => ac.abort()
  }, [])

  // Load a folder's contents when toggled open
  const handleToggle = useCallback(async (node: TreeNode) => {
    const isOpen = openPrefixes.has(node.prefix)

    if (isOpen) {
      // Close it
      setOpenPrefixes((prev) => {
        const next = new Set(prev)
        next.delete(node.prefix)
        return next
      })
      return
    }

    // Open it — if not loaded yet, fetch contents
    setOpenPrefixes((prev) => new Set([...prev, node.prefix]))

    if (node.state !== 'idle') return

    // Mark loading
    const setNodeState = (updater: (n: TreeNode) => TreeNode) => {
      const patch = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((n) => {
          if (n.prefix === node.prefix) return updater(n)
          return { ...n, folders: patch(n.folders) }
        })
      setRoots((prev) => patch(prev))
    }

    setNodeState((n) => ({ ...n, state: 'loading' }))

    try {
      const res = await cdkFetch(`/opencode/files?prefix=${encodeURIComponent(node.prefix)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as ListResponse
      if (!data.ok) throw new Error('API error')

      setNodeState((n) => ({
        ...n,
        state: 'loaded',
        files: data.files,
        folders: data.folders.map((f) => makeNode(f.prefix, f.name, n.depth + 1)),
      }))
    } catch {
      setNodeState((n) => ({ ...n, state: 'error' }))
    }
  }, [openPrefixes])

  // Load file content on selection
  const handleSelectFile = useCallback(async (file: S3File) => {
    if (file.key === selectedFile?.key) return
    setSelectedFile(file)
    setContent(null)
    setContentError(null)
    setContentLoading(true)
    contentPaneRef.current?.scrollTo({ top: 0 })
    try {
      const data = await cdkGet<ReadResponse>(`/opencode/files/read?key=${encodeURIComponent(file.key)}`)
      if (!data.ok) throw new Error('Failed to load document')
      setContent(data.content)
    } catch (e) {
      setContentError((e as Error).message)
    } finally {
      setContentLoading(false)
    }
  }, [selectedFile?.key])

  // Flatten tree for search results
  const searchResults = useCallback((): S3File[] => {
    if (!search.trim()) return []
    const q = search.toLowerCase()
    const results: S3File[] = []
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        for (const f of n.files) {
          if (f.name.toLowerCase().includes(q) || titleFromFile(f).toLowerCase().includes(q)) {
            results.push(f)
          }
        }
        walk(n.folders)
      }
    }
    walk(roots)
    return results
  }, [search, roots])

  const searched = searchResults()

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* ── Sidebar ── */}
      <aside className="w-72 shrink-0 flex flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        <div className="p-3 border-b border-[var(--color-border)] shrink-0">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search loaded documents…"
            className="w-full px-3 py-2 text-sm rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-border-focus)] focus:border-transparent"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {rootState === 'loading' && (
            <div className="flex items-center gap-2 p-4 text-sm text-[var(--color-text-tertiary)]">
              <svg className="animate-spin h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Loading folders…
            </div>
          )}

          {rootState === 'error' && (
            <div className="m-2 p-3 rounded-lg bg-[var(--color-error-bg)] border border-[var(--color-error)]/25">
              <p className="text-xs text-[var(--color-error)]">Failed to load project folders. Check your connection and try refreshing.</p>
            </div>
          )}

          {/* Search results overlay */}
          {search.trim() && searched.length > 0 && (
            <div className="mb-2">
              <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                {searched.length} result{searched.length !== 1 ? 's' : ''}
              </p>
              {searched.map((f) => (
                <FileRow
                  key={f.key}
                  file={f}
                  depth={0}
                  selected={f.key === selectedFile?.key}
                  onSelect={() => void handleSelectFile(f)}
                />
              ))}
            </div>
          )}

          {search.trim() && searched.length === 0 && rootState === 'loaded' && (
            <p className="p-4 text-sm text-[var(--color-text-tertiary)]">No documents match your search in expanded folders.</p>
          )}

          {/* Folder tree */}
          {!search.trim() && rootState === 'loaded' && roots.map((node) => (
            <TreeView
              key={node.prefix}
              node={node}
              openPrefixes={openPrefixes}
              selectedKey={selectedFile?.key ?? null}
              onToggle={(n) => void handleToggle(n)}
              onSelectFile={(f) => void handleSelectFile(f)}
            />
          ))}
        </div>
      </aside>

      {/* ── Content pane ── */}
      <main ref={contentPaneRef} className="flex-1 overflow-y-auto bg-[var(--color-bg-secondary)]">
        {!selectedFile && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center space-y-2 max-w-sm px-4">
              <DocumentTextIcon className="h-10 w-10 mx-auto text-[var(--color-text-tertiary)]" />
              <p className="text-[var(--color-text-secondary)] font-medium">Select a document</p>
              <p className="text-sm text-[var(--color-text-tertiary)]">
                Expand a folder in the sidebar, then click a file to read it here.
              </p>
            </div>
          </div>
        )}

        {selectedFile && (
          <div className="max-w-4xl mx-auto px-6 py-8">
            <div className="mb-6 pb-4 border-b border-[var(--color-border)]">
              <p className="text-xs text-[var(--color-text-tertiary)] mb-1 font-mono">{selectedFile.key}</p>
              <h1 className="text-2xl font-bold text-[var(--color-text-primary)] leading-tight">
                {titleFromFile(selectedFile)}
              </h1>
              <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
                {humanSize(selectedFile.size)} · Last modified{' '}
                {new Date(selectedFile.lastModified).toLocaleDateString(undefined, {
                  year: 'numeric', month: 'short', day: 'numeric',
                })}
              </p>
            </div>

            {contentLoading && (
              <div className="flex items-center gap-2 text-sm text-[var(--color-text-tertiary)] py-8">
                <svg className="animate-spin h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Loading…
              </div>
            )}

            {contentError && (
              <div className="p-4 rounded-xl bg-[var(--color-error-bg)] border border-[var(--color-error)]/25">
                <p className="text-sm text-[var(--color-error)]">{contentError}</p>
              </div>
            )}

            {content && !contentLoading && (
              <article className="prose-sm max-w-none">
                <MarkdownBody content={content} />
              </article>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
