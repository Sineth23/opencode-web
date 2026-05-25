'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import type { ExtraProps } from 'react-markdown'
import Link from 'next/link'
import {
  ChatBubbleLeftRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PencilSquareIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { isSupabaseInitialized, supabase } from '@/lib/supabase'
import { isCognitoConfigured } from '@/lib/cognito'
import { authorizedFetch } from '@/lib/api'
import { useWorkspace } from '@/components/providers/WorkspaceContext'
import { withSupportContact } from '@/lib/support-copy'
import type { DocArchetype, DocSectionCategory } from '@/types/product-knowledge'
import { Skeleton } from '@/components/ui/Skeleton'
import S3DocsBrowser from '@/components/docs/S3DocsBrowser'

const categoryLabels: Record<DocSectionCategory, string> = {
  features: 'Features',
  workflows: 'Workflows',
  configurations: 'Configuration',
  communications: 'Communications & automations',
  reporting: 'Reporting',
  workarounds: 'Edge cases & workarounds',
  system_overview: 'System overview',
  integration_surface: 'Integrations & APIs',
  capabilities: "What's possible",
  operations_policy: 'Policy',
  operations_sop: 'SOP',
  operations_playbook: 'Playbook',
  operations_feature_brief: 'Feature brief',
  operations_use_case: 'Use-case guide',
}

const handbookCategoryOrder: DocSectionCategory[] = [
  'system_overview',
  'capabilities',
  'features',
  'workflows',
  'configurations',
  'integration_surface',
  'communications',
  'reporting',
  'workarounds',
  'operations_policy',
  'operations_sop',
  'operations_playbook',
  'operations_feature_brief',
  'operations_use_case',
]

type DocLibrary = 'use_cases' | 'handbook' | 'policies' | 'sops' | 'playbooks' | 'feature_briefs'

function rowDocArchetype(row: { doc_archetype?: DocArchetype | null }): DocArchetype {
  return row.doc_archetype ?? 'handbook'
}

function libraryMatchesRow(lib: DocLibrary, row: { doc_archetype?: DocArchetype | null }): boolean {
  const a = rowDocArchetype(row)
  if (lib === 'use_cases') return a === 'use_case'
  if (lib === 'handbook') return a === 'handbook'
  if (lib === 'policies') return a === 'policy'
  if (lib === 'sops') return a === 'sop'
  if (lib === 'playbooks') return a === 'playbook'
  return a === 'feature_brief'
}

function compareHandbookCategory(a: DocSectionCategory, b: DocSectionCategory): number {
  const ia = handbookCategoryOrder.indexOf(a)
  const ib = handbookCategoryOrder.indexOf(b)
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
}

/** Stable nav order: manual display_order first, then title. */
function sortRowsByOrder(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const oa = a.display_order ?? 0
    const ob = b.display_order ?? 0
    if (oa !== ob) return oa - ob
    return a.title.localeCompare(b.title)
  })
}

const depthLabels: Record<string, string> = {
  overview: 'Overview',
  standard: 'Standard',
  deep: 'Deep dive',
}

type Row = {
  id: string
  repository_id: string | null
  sync_branch: string
  target_audience: string
  content_depth: string
  category: DocSectionCategory
  title: string
  summary: string | null
  body_md: string
  source_paths: string[] | null
  updated_at: string
  doc_archetype?: DocArchetype | null
  display_order?: number | null
}

function articleKindLabel(row: Row): string {
  const a = rowDocArchetype(row)
  if (a === 'handbook') return categoryLabels[row.category]
  if (a === 'policy') return 'Operating policy'
  if (a === 'sop') return 'Standard procedure'
  if (a === 'playbook') return 'Scenario playbook'
  if (a === 'feature_brief') return 'Feature brief'
  if (a === 'use_case') return 'Use-case guide'
  return 'Article'
}

type ScopeRepo = {
  id: string
  name: string
  slug: string
  default_branch: string
  branches: { branch: string; chunk_count: number }[]
}

type ScopeSelection =
  | { kind: 'org' }
  | { kind: 'repo'; repoId: string; branch: 'combined' | string }

function rowMatchesScope(row: Row, scope: ScopeSelection): boolean {
  if (scope.kind === 'org') return row.repository_id == null
  if (row.repository_id !== scope.repoId) return false
  if (scope.branch === 'combined') return row.sync_branch === ''
  return row.sync_branch === scope.branch
}

function scopeHeading(row: Row, repoById: Map<string, ScopeRepo>): string {
  if (row.repository_id == null) return 'Workspace-wide'
  const r = repoById.get(row.repository_id)
  const slug = r?.slug ?? row.repository_id.slice(0, 8)
  const br = row.sync_branch ? row.sync_branch : 'All branches combined'
  return `${slug} · ${br}`
}

/** Estimated reading time in minutes for markdown text. */
function readingTime(text: string): number {
  const words = text.trim().split(/\s+/).length
  return Math.max(1, Math.round(words / 220))
}

/** Extract top-level (##) headings from markdown for in-article TOC. */
function extractTocItems(md: string): { text: string; slug: string }[] {
  const lines = md.split('\n')
  const items: { text: string; slug: string }[] = []
  for (const line of lines) {
    const m = /^## (.+)$/.exec(line)
    if (m) {
      const text = m[1].replace(/[*_`]/g, '').trim()
      const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      items.push({ text, slug })
    }
  }
  return items
}

/** Group file paths by directory for display. */
function groupPathsByDir(paths: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const p of paths) {
    const parts = p.replace(/\\/g, '/').split('/')
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.'
    const list = m.get(dir) ?? []
    list.push(parts[parts.length - 1] ?? p)
    m.set(dir, list)
  }
  return m
}

/** Category color tokens for the left accent bar and chips. */
const categoryColors: Record<DocSectionCategory, { bar: string; chip: string }> = {
  system_overview:    { bar: 'bg-violet-500',  chip: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20' },
  capabilities:       { bar: 'bg-sky-500',     chip: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20' },
  features:           { bar: 'bg-emerald-500', chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20' },
  workflows:          { bar: 'bg-amber-500',   chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20' },
  configurations:     { bar: 'bg-orange-500',  chip: 'bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20' },
  integration_surface:{ bar: 'bg-blue-500',    chip: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20' },
  communications:     { bar: 'bg-pink-500',    chip: 'bg-pink-500/10 text-pink-700 dark:text-pink-400 border-pink-500/20' },
  reporting:          { bar: 'bg-teal-500',    chip: 'bg-teal-500/10 text-teal-700 dark:text-teal-400 border-teal-500/20' },
  workarounds:        { bar: 'bg-red-500',     chip: 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20' },
  operations_policy:  { bar: 'bg-indigo-500', chip: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/25' },
  operations_sop:     { bar: 'bg-fuchsia-500', chip: 'bg-fuchsia-500/10 text-fuchsia-800 dark:text-fuchsia-300 border-fuchsia-500/25' },
  operations_playbook: { bar: 'bg-cyan-500', chip: 'bg-cyan-500/10 text-cyan-800 dark:text-cyan-300 border-cyan-500/25' },
  operations_feature_brief: {
    bar: 'bg-lime-500',
    chip: 'bg-lime-500/10 text-lime-900 dark:text-lime-300 border-lime-500/25',
  },
  operations_use_case: {
    bar: 'bg-rose-500',
    chip: 'bg-rose-500/10 text-rose-900 dark:text-rose-300 border-rose-500/25',
  },
}

type MdCodeProps = ComponentPropsWithoutRef<'code'> & ExtraProps

/** Custom ReactMarkdown components: syntax highlighting + GFM tables. */
const mdComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  code({ className, children, ...props }: MdCodeProps) {
    const match = /language-(\w+)/.exec(className ?? '')
    const codeStr = String(children).replace(/\n$/, '')
    if (match) {
      return (
        <SyntaxHighlighter
          {...props}
          style={oneDark as { [key: string]: React.CSSProperties }}
          language={match[1]}
          PreTag="div"
          customStyle={{ borderRadius: '0.5rem', fontSize: '0.82em', margin: '1em 0' }}
        >
          {codeStr}
        </SyntaxHighlighter>
      )
    }
    return (
      <code
        className="rounded px-1 py-0.5 text-[0.86em] bg-[var(--color-bg-tertiary)] text-primary font-mono"
        {...props}
      >
        {children}
      </code>
    )
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto my-4 rounded-[var(--radius-md)] border border-[var(--color-border)]">
        <table className="w-full text-sm border-collapse">{children}</table>
      </div>
    )
  },
  thead({ children }) {
    return <thead className="bg-[var(--color-bg-secondary)]">{children}</thead>
  },
  th({ children }) {
    return (
      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)] border-b border-[var(--color-border)]">
        {children}
      </th>
    )
  },
  td({ children }) {
    return (
      <td className="px-3 py-2 text-[var(--color-text-secondary)] border-b border-[var(--color-border)] last:border-b-0 align-top">
        {children}
      </td>
    )
  },
  tr({ children }) {
    return <tr className="hover:bg-[var(--color-bg-secondary)] transition-colors">{children}</tr>
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-4 border-l-4 border-primary/40 pl-4 text-[var(--color-text-secondary)] italic bg-[var(--color-bg-secondary)] rounded-r-[var(--radius-md)] py-2 pr-3">
        {children}
      </blockquote>
    )
  },
  h2({ children }) {
    const text = String(children)
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    return (
      <h2
        id={slug}
        className="text-lg font-semibold text-[var(--color-text-primary)] mt-8 mb-3 pb-2 border-b border-[var(--color-border)] scroll-mt-6"
      >
        {children}
      </h2>
    )
  },
  h3({ children }) {
    return (
      <h3 className="text-base font-semibold text-[var(--color-text-primary)] mt-5 mb-2">
        {children}
      </h3>
    )
  },
  ul({ children }) {
    return <ul className="my-3 space-y-1 list-disc list-inside text-[var(--color-text-secondary)]">{children}</ul>
  },
  ol({ children }) {
    return <ol className="my-3 space-y-1.5 list-decimal list-inside text-[var(--color-text-secondary)]">{children}</ol>
  },
  li({ children }) {
    return <li className="leading-relaxed text-[var(--color-text-secondary)] pl-1">{children}</li>
  },
  p({ children }) {
    return <p className="my-3 leading-relaxed text-[var(--color-text-secondary)]">{children}</p>
  },
  strong({ children }) {
    return <strong className="font-semibold text-[var(--color-text-primary)]">{children}</strong>
  },
  a({ children, href }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2 hover:opacity-80"
      >
        {children}
      </a>
    )
  },
  hr() {
    return <hr className="my-6 border-[var(--color-border)]" />
  },
}

export default function DocsPage() {
  if (isCognitoConfigured()) return <S3DocsBrowser />
  return <SupabaseDocsPage />
}

function SupabaseDocsPage() {
  const { workspace } = useWorkspace()
  const articleRef = useRef<HTMLElement>(null)
  const [sections, setSections] = useState<Row[]>([])
  const [scopeRepos, setScopeRepos] = useState<ScopeRepo[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [browseAllScopes, setBrowseAllScopes] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [scope, setScope] = useState<ScopeSelection>({ kind: 'org' })
  const [scopeAutoApplied, setScopeAutoApplied] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfExportErr, setPdfExportErr] = useState<string | null>(null)
  const [docLibrary, setDocLibrary] = useState<DocLibrary>('use_cases')
  const [docAccess, setDocAccess] = useState<{
    queue_doc_refresh: boolean
    role: 'owner' | 'admin' | 'member' | null
  } | null>(null)
  const [useCaseQueueBusy, setUseCaseQueueBusy] = useState(false)
  const [useCaseGenMsg, setUseCaseGenMsg] = useState<string | null>(null)
  const [useCaseGenErr, setUseCaseGenErr] = useState<string | null>(null)
  const [docMutateMsg, setDocMutateMsg] = useState<string | null>(null)
  const [docMutateErr, setDocMutateErr] = useState<string | null>(null)
  const [editingDoc, setEditingDoc] = useState(false)
  const [editDraft, setEditDraft] = useState<{ title: string; summary: string; body_md: string; source_paths: string } | null>(
    null
  )
  const [docSaveBusy, setDocSaveBusy] = useState(false)
  const [reorderBusy, setReorderBusy] = useState(false)
  const [platformAdmin, setPlatformAdmin] = useState(false)

  // Auto-select the repo with the most doc sections once data is loaded
  useEffect(() => {
    if (loading || sections.length === 0 || scopeAutoApplied) return

    // Count sections per repo
    const repoCount = new Map<string, number>()
    for (const s of sections) {
      if (s.repository_id) {
        repoCount.set(s.repository_id, (repoCount.get(s.repository_id) ?? 0) + 1)
      }
    }

    const rankedRepos = [...repoCount.entries()].sort(([, a], [, b]) => b - a)

    if (rankedRepos.length > 0) {
      const [bestRepoId] = rankedRepos[0]
      // Find best branch for that repo (prefer 'combined' first, then most-chunked)
      const bestRepo = scopeRepos.find((r) => r.id === bestRepoId)
      const branchesWithDocs = new Set<string>()
      for (const s of sections) {
        if (s.repository_id === bestRepoId && s.sync_branch) branchesWithDocs.add(s.sync_branch)
      }
      const hasCombined = sections.some((s) => s.repository_id === bestRepoId && s.sync_branch === '')
      const branch = hasCombined
        ? 'combined'
        : (bestRepo?.branches.sort((a, b) => b.chunk_count - a.chunk_count)[0]?.branch ??
           [...branchesWithDocs][0] ??
           'combined')

      setScopeAutoApplied(true)
      setScope({ kind: 'repo', repoId: bestRepoId, branch })
    } else if (!sections.some((s) => s.repository_id == null)) {
      // No sections at all: leave as org
      setScopeAutoApplied(true)
    }
  }, [loading, sections, scopeRepos, scopeAutoApplied])

  useEffect(() => {
    if (!workspace?.id) return
    const load = async () => {
      setLoading(true)
      setLoadError(null)

      if (!isSupabaseInitialized()) {
        setSections([])
        setLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('pk_doc_sections')
        .select(
          'id, repository_id, sync_branch, target_audience, content_depth, category, title, summary, body_md, source_paths, updated_at, doc_archetype, display_order'
        )
        .eq('workspace_id', workspace.id)
        .order('category')
        .order('display_order')
        .order('title')

      if (error) {
        console.error(error)
        setSections([])
        setLoadError(
          withSupportContact(
            error.message.includes('target_audience') || error.message.includes('content_depth')
              ? 'Documentation could not load because this workspace needs a one-time update on the hosting side. Ask your administrator to apply the latest AutoDoc database setup, then reload this page.'
              : error.message
          )
        )
      } else {
        const rows = (data as Row[]) ?? []
        setSections(rows.map((r) => ({ ...r, doc_archetype: rowDocArchetype(r) })))
      }

      try {
        const scRes = await authorizedFetch(`/api/workspace/knowledge-scope?workspace_id=${workspace.id}`)
        if (scRes.ok) {
          const sc = (await scRes.json()) as { repositories?: ScopeRepo[] }
          setScopeRepos(sc.repositories ?? [])
        }
      } catch (e) {
        console.error(e)
      }

      setLoading(false)
    }
    void load()
  }, [workspace?.id])

  useEffect(() => {
    if (!workspace?.id) return
    void (async () => {
      try {
        const res = await authorizedFetch(`/api/workspace/access?workspace_id=${workspace.id}`)
        if (!res.ok) return
        const a = (await res.json()) as {
          role?: 'owner' | 'admin' | 'member'
          effective_features?: { queue_doc_refresh?: boolean }
        }
        const q = a.effective_features?.queue_doc_refresh
        const role = a.role === 'owner' || a.role === 'admin' || a.role === 'member' ? a.role : null
        setDocAccess({ queue_doc_refresh: Boolean(q), role })
      } catch {
        setDocAccess(null)
      }
    })()
  }, [workspace?.id])

  useEffect(() => {
    void (async () => {
      try {
        const res = await authorizedFetch('/api/admin/me')
        if (!res.ok) {
          setPlatformAdmin(false)
          return
        }
        const j = (await res.json()) as { platformAdmin?: boolean }
        setPlatformAdmin(Boolean(j.platformAdmin))
      } catch {
        setPlatformAdmin(false)
      }
    })()
  }, [])

  const repoById = useMemo(() => new Map(scopeRepos.map((r) => [r.id, r])), [scopeRepos])

  const libraryCounts = useMemo(() => {
    const inScope = (s: Row) => (browseAllScopes ? true : rowMatchesScope(s, scope))
    const base = sections.filter(inScope)
    return {
      use_cases: base.filter((s) => libraryMatchesRow('use_cases', s)).length,
      handbook: base.filter((s) => libraryMatchesRow('handbook', s)).length,
      policies: base.filter((s) => libraryMatchesRow('policies', s)).length,
      sops: base.filter((s) => libraryMatchesRow('sops', s)).length,
      playbooks: base.filter((s) => libraryMatchesRow('playbooks', s)).length,
      feature_briefs: base.filter((s) => libraryMatchesRow('feature_briefs', s)).length,
    }
  }, [sections, browseAllScopes, scope])

  const filtered = useMemo(() => {
    const scopeFiltered = browseAllScopes ? sections : sections.filter((s) => rowMatchesScope(s, scope))
    const libFiltered = sortRowsByOrder(scopeFiltered.filter((s) => libraryMatchesRow(docLibrary, s)))
    if (!searchQuery.trim()) return libFiltered
    const q = searchQuery.toLowerCase()
    return sortRowsByOrder(
      libFiltered.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          (s.summary ?? '').toLowerCase().includes(q) ||
          categoryLabels[s.category].toLowerCase().includes(q) ||
          articleKindLabel(s).toLowerCase().includes(q)
      )
    )
  }, [sections, browseAllScopes, scope, searchQuery, docLibrary])

  const groupedByCategory = useMemo(() => {
    const m = new Map<DocSectionCategory, Row[]>()
    for (const s of filtered) {
      const list = m.get(s.category) ?? []
      list.push(s)
      m.set(s.category, list)
    }
    for (const [k, list] of m) {
      m.set(k, sortRowsByOrder(list))
    }
    return m
  }, [filtered])

  const groupedByScopeThenCategory = useMemo(() => {
    const scopeKeys = new Map<string, Row[]>()
    for (const s of filtered) {
      const key = scopeHeading(s, repoById)
      const list = scopeKeys.get(key) ?? []
      list.push(s)
      scopeKeys.set(key, list)
    }
    const ordered = [...scopeKeys.entries()].sort(([a], [b]) => a.localeCompare(b))
    return ordered.map(([heading, rows]) => {
      const byCat = new Map<DocSectionCategory, Row[]>()
      for (const r of rows) {
        const list = byCat.get(r.category) ?? []
        list.push(r)
        byCat.set(r.category, list)
      }
      for (const [k, list] of byCat) {
        byCat.set(k, sortRowsByOrder(list))
      }
      return { heading, byCat }
    })
  }, [filtered, repoById])

  const groupedByScopeFlat = useMemo(() => {
    const scopeKeys = new Map<string, Row[]>()
    for (const s of filtered) {
      const key = scopeHeading(s, repoById)
      const list = scopeKeys.get(key) ?? []
      list.push(s)
      scopeKeys.set(key, list)
    }
    return [...scopeKeys.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([heading, rows]) => ({
        heading,
        rows: sortRowsByOrder(rows),
      }))
  }, [filtered, repoById])

  const active = useMemo(() => filtered.find((s) => s.id === activeId) ?? null, [filtered, activeId])

  /** Any workspace member may edit article text and reorder (when list is unambiguous). */
  const canEditDocs = useMemo(() => Boolean(docAccess), [docAccess])

  /** Delete: workspace owner/admin or platform operator only. */
  const canDeleteDocs = useMemo(
    () =>
      Boolean(
        platformAdmin || (docAccess && (docAccess.role === 'owner' || docAccess.role === 'admin'))
      ),
    [docAccess, platformAdmin]
  )

  const reorderAllowed = Boolean(canEditDocs && !browseAllScopes && !searchQuery.trim())

  const libRowsOrdered = useCallback((): Row[] => {
    const scopeFiltered = browseAllScopes ? sections : sections.filter((s) => rowMatchesScope(s, scope))
    return sortRowsByOrder(scopeFiltered.filter((s) => libraryMatchesRow(docLibrary, s)))
  }, [sections, browseAllScopes, scope, docLibrary])

  const persistReorderIds = useCallback(
    async (orderedIds: string[]) => {
      if (!workspace?.id) return
      setReorderBusy(true)
      setDocMutateErr(null)
      setDocMutateMsg(null)
      try {
        const res = await authorizedFetch('/api/workspace/doc-sections/reorder', {
          method: 'POST',
          body: JSON.stringify({ workspace_id: workspace.id, section_ids: orderedIds }),
        })
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) {
          setDocMutateErr(typeof j.error === 'string' ? j.error : 'Could not save order.')
          return
        }
        setSections((prev) =>
          prev.map((row) => {
            const idx = orderedIds.indexOf(row.id)
            if (idx === -1) return row
            return { ...row, display_order: idx }
          })
        )
        setDocMutateMsg('Order saved for everyone in this workspace.')
      } catch {
        setDocMutateErr('Could not save order.')
      } finally {
        setReorderBusy(false)
      }
    },
    [workspace?.id]
  )

  const moveDocInList = useCallback(
    async (sectionId: string, delta: -1 | 1) => {
      const list = libRowsOrdered()
      const idx = list.findIndex((r) => r.id === sectionId)
      const j = idx + delta
      if (idx < 0 || j < 0 || j >= list.length) return
      const ids = list.map((r) => r.id)
      const next = [...ids]
      const tmp = next[idx]!
      next[idx] = next[j]!
      next[j] = tmp
      await persistReorderIds(next)
    },
    [libRowsOrdered, persistReorderIds]
  )

  const moveDocInHandbookCategory = useCallback(
    async (sectionId: string, category: DocSectionCategory, delta: -1 | 1) => {
      const scopeFiltered = browseAllScopes ? sections : sections.filter((s) => rowMatchesScope(s, scope))
      const handbookRows = sortRowsByOrder(scopeFiltered.filter((s) => libraryMatchesRow('handbook', s)))
      const inCat = sortRowsByOrder(handbookRows.filter((r) => r.category === category))
      const idx = inCat.findIndex((r) => r.id === sectionId)
      const j = idx + delta
      if (idx < 0 || j < 0 || j >= inCat.length) return
      const inCatNext = [...inCat]
      const t = inCatNext[idx]!
      inCatNext[idx] = inCatNext[j]!
      inCatNext[j] = t
      const flatIds: string[] = []
      for (const cat of handbookCategoryOrder) {
        if (cat === category) {
          flatIds.push(...inCatNext.map((r) => r.id))
        } else {
          flatIds.push(...sortRowsByOrder(handbookRows.filter((r) => r.category === cat)).map((r) => r.id))
        }
      }
      await persistReorderIds(flatIds)
    },
    [browseAllScopes, sections, scope, persistReorderIds]
  )

  const deleteDoc = useCallback(
    async (sectionId: string) => {
      if (!workspace?.id) return
      if (!confirm('Delete this article for everyone in the workspace? This cannot be undone.')) return
      setDocSaveBusy(true)
      setDocMutateErr(null)
      try {
        const sp = new URLSearchParams({ workspace_id: workspace.id })
        const res = await authorizedFetch(`/api/workspace/doc-sections/${sectionId}?${sp.toString()}`, { method: 'DELETE' })
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) {
          setDocMutateErr(typeof j.error === 'string' ? j.error : 'Could not delete.')
          return
        }
        setSections((p) => p.filter((r) => r.id !== sectionId))
        setActiveId((cur) => (cur === sectionId ? null : cur))
        setEditingDoc(false)
        setEditDraft(null)
        setDocMutateMsg('Article deleted.')
      } catch {
        setDocMutateErr('Could not delete.')
      } finally {
        setDocSaveBusy(false)
      }
    },
    [workspace?.id]
  )

  const startEdit = useCallback(() => {
    if (!active) return
    setEditingDoc(true)
    setEditDraft({
      title: active.title,
      summary: active.summary ?? '',
      body_md: active.body_md,
      source_paths: (active.source_paths ?? []).join('\n'),
    })
  }, [active])

  const saveEdit = useCallback(async () => {
    if (!workspace?.id || !active || !editDraft) return
    setDocSaveBusy(true)
    setDocMutateErr(null)
    const paths = editDraft.source_paths
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    try {
      const res = await authorizedFetch(`/api/workspace/doc-sections/${active.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          workspace_id: workspace.id,
          title: editDraft.title.trim(),
          summary: editDraft.summary.trim() || null,
          body_md: editDraft.body_md,
          source_paths: paths.length ? paths : null,
        }),
      })
      const j = (await res.json().catch(() => ({}))) as { error?: string; section?: Row }
      if (!res.ok) {
        setDocMutateErr(typeof j.error === 'string' ? j.error : 'Could not save.')
        return
      }
      if (j.section) {
        const s = j.section as Row
        setSections((p) =>
          p.map((r) =>
            r.id === s.id
              ? {
                  ...r,
                  ...s,
                  doc_archetype: rowDocArchetype(s),
                }
              : r
          )
        )
      }
      setEditingDoc(false)
      setEditDraft(null)
      setDocMutateMsg('Changes saved for everyone in this workspace.')
    } catch {
      setDocMutateErr('Could not save.')
    } finally {
      setDocSaveBusy(false)
    }
  }, [workspace?.id, active, editDraft])

  useEffect(() => {
    setEditingDoc(false)
    setEditDraft(null)
  }, [activeId])

  const libraryCopy: Record<
    DocLibrary,
    { title: string; subtitle: string }
  > = {
    use_cases: {
      title: 'Use-case specific docs',
      subtitle:
        'Deep, stakeholder-ready guides grounded in your product and UI: the model maps the repo, inventories many real workflows, then writes rich scenario packs (description, guardrails, numbered situations with verification). Queue a dedicated job—your handbook and other operational libraries stay untouched.',
    },
    handbook: {
      title: 'Engineering handbook',
      subtitle:
        'Architecture, capabilities, and technical workflows—grounded in your repository, written for mixed audiences.',
    },
    policies: {
      title: 'Policies & operating model',
      subtitle:
        'How teams decide what to do when: intake, triage-style gates, boundaries, and timing—plain language, still tied to real code paths.',
    },
    sops: {
      title: 'Standard procedures',
      subtitle:
        'Ordered, safe-to-follow runbooks where sequence matters: communications, approvals, and verification steps.',
    },
    playbooks: {
      title: 'Scenario playbooks',
      subtitle:
        '“When this happens, do that” guides for coordinators and PMs: scenarios, checks, and product touchpoints.',
    },
    feature_briefs: {
      title: 'Feature briefs',
      subtitle:
        'Sales- and CS-ready capability stories: who it helps, outcomes, scope, FAQs—grounded in product behavior. No filler on cosmetic UI.',
    },
  }

  useEffect(() => {
    if (filtered.length === 0) {
      setActiveId(null)
      return
    }
    if (!activeId || !filtered.some((s) => s.id === activeId)) {
      setActiveId(filtered[0].id)
    }
  }, [filtered, activeId])

  // Scroll article to top when switching sections
  useEffect(() => {
    if (activeId && articleRef.current) {
      articleRef.current.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [activeId])

  const hasOrgDocs = sections.some((s) => s.repository_id == null)
  const repoIdsWithDocs = useMemo(() => {
    const ids = new Set<string>()
    for (const s of sections) {
      if (s.repository_id) ids.add(s.repository_id)
    }
    return ids
  }, [sections])

  const branchOptionsForRepo = (repoId: string) => {
    const r = scopeRepos.find((x) => x.id === repoId)
    const branches = r?.branches ?? []
    const docBranches = new Set<string>()
    for (const s of sections) {
      if (s.repository_id === repoId && s.sync_branch) docBranches.add(s.sync_branch)
    }
    const merged = new Map<string, number>()
    for (const b of branches) merged.set(b.branch, b.chunk_count)
    for (const b of docBranches) if (!merged.has(b)) merged.set(b, 0)
    return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))
  }

  const scopeSummary = (row: Row | null) => {
    if (!row) return null
    if (row.repository_id == null) return 'Workspace-wide (all connected sources)'
    const r = repoById.get(row.repository_id)
    const slug = r?.slug ?? 'Repository'
    const br = row.sync_branch ? `Branch: ${row.sync_branch}` : 'All synced branches combined'
    return `${slug} · ${br}`
  }

  const queueUseCaseLibrary = async () => {
    if (!workspace?.id) return
    if (browseAllScopes) {
      setUseCaseGenErr('Choose a single documentation scope (not “All saved”) before generating use-case docs.')
      return
    }
    if (!platformAdmin) {
      setUseCaseGenErr('Only AutoDoc platform operators can generate the use-case library.')
      return
    }
    if (!docAccess) {
      setUseCaseGenErr('You do not have access to this workspace.')
      return
    }
    setUseCaseQueueBusy(true)
    setUseCaseGenErr(null)
    setUseCaseGenMsg(null)
    try {
      const body: Record<string, string> = { workspace_id: workspace.id }
      if (scope.kind === 'repo') {
        body.repository_id = scope.repoId
        if (scope.branch !== 'combined') body.branch = scope.branch
      }
      const res = await authorizedFetch('/api/docs/generate-use-cases', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const j = (await res.json().catch(() => ({}))) as { error?: string; detail?: string }
      if (!res.ok) {
        setUseCaseGenErr(withSupportContact(typeof j.error === 'string' ? j.error : 'Could not queue use-case library job.'))
        return
      }
      setUseCaseGenMsg(typeof j.detail === 'string' ? j.detail : 'Queued. Keep the worker running; reload this page when the job finishes.')
    } catch {
      setUseCaseGenErr(withSupportContact('Could not queue use-case library job.'))
    } finally {
      setUseCaseQueueBusy(false)
    }
  }

  const downloadHandbookPdf = async () => {
    if (!workspace?.id) return
    if (browseAllScopes) {
      setPdfExportErr('Choose a single documentation scope before exporting PDF.')
      return
    }
    setPdfBusy(true)
    setPdfExportErr(null)
    try {
      const sp = new URLSearchParams({ workspace_id: workspace.id })
      if (scope.kind === 'repo') {
        sp.set('repository_id', scope.repoId)
        if (scope.branch !== 'combined') sp.set('branch', scope.branch)
      }
      const res = await authorizedFetch(`/api/docs/handbook-pdf?${sp.toString()}`)
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText)
        setPdfExportErr(withSupportContact(errText.slice(0, 400) || 'Could not generate PDF.'))
        return
      }
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition')
      const m = cd?.match(/filename="([^"]+)"/)
      const fname = m?.[1] ?? 'handbook.pdf'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fname
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      setPdfExportErr(withSupportContact('Could not download handbook PDF.'))
    } finally {
      setPdfBusy(false)
    }
  }

  // ── Scope controls (used in handbook tab) ──────────────────────────────────
  const scopeBar = !loading && (sections.length > 0 || scopeRepos.length > 0) && (
    <div className="flex flex-wrap items-center gap-2 mb-6">
      {/* View toggle */}
      <div className="flex items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-0.5 shrink-0">
        <button
          type="button"
          onClick={() => setBrowseAllScopes(false)}
          className={`px-3 py-1.5 text-xs font-medium rounded-[calc(var(--radius-md)-2px)] transition-colors ${
            !browseAllScopes
              ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-sm'
              : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
          }`}
        >
          Single scope
        </button>
        <button
          type="button"
          onClick={() => setBrowseAllScopes(true)}
          className={`px-3 py-1.5 text-xs font-medium rounded-[calc(var(--radius-md)-2px)] transition-colors ${
            browseAllScopes
              ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-sm'
              : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
          }`}
        >
          All saved
        </button>
      </div>

      {!browseAllScopes && (
        <>
          {/* Repo selector */}
          <select
            className="text-sm rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 bg-[var(--color-surface)] text-[var(--color-text-primary)] min-w-[180px] flex-1 max-w-[260px]"
            value={scope.kind === 'org' ? 'org' : scope.repoId}
            onChange={(e) => {
              const v = e.target.value
              if (v === 'org') {
                setScope({ kind: 'org' })
                return
              }
              setScope({ kind: 'repo', repoId: v, branch: 'combined' })
            }}
          >
            <option value="org" disabled={!hasOrgDocs}>
              Workspace-wide{!hasOrgDocs ? ' (no articles yet)' : ''}
            </option>
            {scopeRepos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.slug || r.name || r.id.slice(0, 8)}
              </option>
            ))}
          </select>

          {/* Branch selector */}
          {scope.kind === 'repo' && (
            <select
              className="text-sm rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 bg-[var(--color-surface)] text-[var(--color-text-primary)] min-w-[160px]"
              value={scope.branch === 'combined' ? 'combined' : scope.branch}
              onChange={(e) => {
                const v = e.target.value
                setScope({ kind: 'repo', repoId: scope.repoId, branch: v === 'combined' ? 'combined' : v })
              }}
            >
              <option value="combined">All branches combined</option>
              {branchOptionsForRepo(scope.repoId).map(([b]) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          )}
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {docLibrary === 'use_cases' && platformAdmin && docAccess && (
        <button
          type="button"
          disabled={useCaseQueueBusy || browseAllScopes}
          onClick={() => void queueUseCaseLibrary()}
          title={
            browseAllScopes
              ? 'Select a single scope first'
              : 'Queue a job that rebuilds only use-case guides for this scope'
          }
          className="shrink-0 rounded-[var(--radius-md)] bg-primary px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-95 disabled:opacity-40 transition-opacity"
        >
          {useCaseQueueBusy ? 'Queuing…' : 'Generate use case library'}
        </button>
      )}

      {/* PDF export */}
      <button
        type="button"
        disabled={pdfBusy || browseAllScopes || filtered.length === 0 || docLibrary !== 'handbook'}
        onClick={() => void downloadHandbookPdf()}
        title={
          docLibrary !== 'handbook'
            ? 'PDF export is available for the Engineering handbook tab'
            : browseAllScopes
              ? 'Select a single scope to export'
              : 'Export handbook as PDF'
        }
        className="shrink-0 flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] disabled:opacity-40 transition-colors"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="shrink-0">
          <path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        {pdfBusy ? 'Building…' : 'PDF'}
      </button>
    </div>
  )

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start gap-4">
        <div className="flex-1 min-w-0">
          <h1 className="text-3xl font-bold text-[var(--color-text-primary)]">{libraryCopy[docLibrary].title}</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)] leading-relaxed">{libraryCopy[docLibrary].subtitle}</p>
        </div>
        {/* Search */}
        {!loading && (sections.length > 0 || scopeRepos.length > 0) && (
          <div className="relative shrink-0 w-full sm:w-64">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--color-text-tertiary)] pointer-events-none" viewBox="0 0 16 16" fill="none">
              <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4"/>
              <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
            <input
              type="text"
              placeholder="Search articles…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        )}
      </div>

      {/* Library: handbook vs operational archetypes */}
      {!loading && (sections.length > 0 || scopeRepos.length > 0) && (
        <div
          className="mb-5 flex flex-wrap gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 p-1"
          role="tablist"
          aria-label="Documentation library"
        >
          {(
            [
              ['use_cases', 'Use-case docs', libraryCounts.use_cases],
              ['handbook', 'Handbook', libraryCounts.handbook],
              ['policies', 'Policies', libraryCounts.policies],
              ['sops', 'SOPs', libraryCounts.sops],
              ['playbooks', 'Playbooks', libraryCounts.playbooks],
              ['feature_briefs', 'Feature briefs', libraryCounts.feature_briefs],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={docLibrary === id}
              onClick={() => setDocLibrary(id as DocLibrary)}
              className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
                docLibrary === id
                  ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-sm ring-1 ring-[var(--color-border)]'
                  : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]/80'
              }`}
            >
              {label}
              <span
                className={`ml-1.5 tabular-nums rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                  docLibrary === id ? 'bg-primary/10 text-primary' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]'
                }`}
              >
                {count}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Scope bar */}
      {scopeBar}

      {/* PDF error */}
      {pdfExportErr && (
        <div className="mb-4 rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-[var(--color-text-primary)]">
          {pdfExportErr}
        </div>
      )}
      {useCaseGenErr && (
        <div className="mb-4 rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-[var(--color-text-primary)]">
          {useCaseGenErr}
        </div>
      )}
      {useCaseGenMsg && (
        <div className="mb-4 rounded-[var(--radius-md)] border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs text-[var(--color-text-primary)]">
          {useCaseGenMsg}
        </div>
      )}
      {docMutateErr && (
        <div className="mb-4 rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-[var(--color-text-primary)]">
          {docMutateErr}
        </div>
      )}
      {docMutateMsg && (
        <div className="mb-4 rounded-[var(--radius-md)] border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs text-[var(--color-text-primary)]">
          {docMutateMsg}
        </div>
      )}

      {loadError && (
        <div className="mb-5 rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-[var(--color-text-primary)]">
          {loadError}
        </div>
      )}

      {!loading && (sections.length > 0 || scopeRepos.length > 0) && (
        <Link
          href="/assistant"
          className="group relative mb-6 flex items-start gap-4 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 shadow-sm ring-1 ring-inset ring-white/40 transition-[box-shadow,border-color,transform] duration-200 ease-out before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-primary/25 before:to-transparent hover:border-primary/20 hover:shadow-md hover:-translate-y-px motion-reduce:hover:translate-y-0 sm:px-5 sm:py-5"
        >
          <div
            className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-gradient-to-b from-primary/80 to-violet-500/50 opacity-90"
            aria-hidden
          />
          <div
            className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/12 to-violet-500/10 text-primary ring-1 ring-primary/10"
            aria-hidden
          >
            <ChatBubbleLeftRightIcon className="h-5 w-5" />
          </div>
          <div className="relative min-w-0 flex-1 pl-1 sm:pl-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-primary/90">Assistant</p>
            <p className="mt-0.5 text-[14px] font-semibold text-[var(--color-text-primary)] tracking-tight leading-snug">
              Ask this documentation and your codebase together
            </p>
            <p className="mt-1.5 text-[13px] text-[var(--color-text-secondary)] leading-relaxed max-w-2xl">
              Default answer style is product-manager oriented (clear outcomes, less jargon, still detailed). You can switch to engineering or
              executive tone in the chat toolbar. Replies use these articles and your synced repositories.
            </p>
            <span className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-primary">
              Open Assistant
              <span className="transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden>
                →
              </span>
            </span>
          </div>
        </Link>
      )}

      {/* Handbook content */}
      {loading ? (
        <div className="grid lg:grid-cols-12 gap-6 items-start" aria-hidden="true">
          {/* Skeleton nav */}
          <div className="lg:col-span-4 space-y-5">
            {[['55%', '70%', '60%'], ['80%', '50%'], ['65%', '75%', '45%', '68%']].map((widths, gi) => (
              <div key={gi}>
                <Skeleton className="h-2.5 mb-2.5" style={{ width: '35%' }} />
                <div className="space-y-0.5">
                  {widths.map((w, i) => (
                    <Skeleton key={i} className="h-8 rounded-[var(--radius-md)]" style={{ width: w }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {/* Skeleton article */}
          <div className="lg:col-span-8 pk-card p-8">
            <Skeleton className="h-3 mb-2" style={{ width: '18%' }} />
            <Skeleton className="h-8 mb-5" style={{ width: '70%' }} />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 pb-5 mb-5 border-b border-[var(--color-border)]">
              {[1,2,3,4,5].map((i) => (
                <div key={i}>
                  <Skeleton className="h-2 mb-1.5" style={{ width: '55%' }} />
                  <Skeleton className="h-3.5" style={{ width: '80%' }} />
                </div>
              ))}
            </div>
            <div className="space-y-2">
              {['100%', '92%', '78%', '95%', '85%', '70%', '88%', '60%'].map((w, i) => (
                <Skeleton key={i} className="h-3.5" style={{ width: w }} />
              ))}
            </div>
          </div>
        </div>
      ) : sections.length === 0 && scopeRepos.length === 0 ? (
        <div className="pk-card p-12 text-center">
          <p className="text-[var(--color-text-primary)] font-semibold mb-2">No documentation yet</p>
          <p className="text-sm text-[var(--color-text-secondary)] mb-6 max-w-md mx-auto leading-relaxed">
            Connect a repository and sync content first. Then open Sync center to queue a handbook refresh.
            {platformAdmin
              ? ' Platform operators can later generate the use-case library from the Use-case docs tab once sources are connected.'
              : ''}
          </p>
          <Link href="/settings/sync" className="pk-btn-primary inline-flex px-6 py-2.5">
            Open Sync center
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <div className="pk-card p-10 text-center">
          <p className="text-[var(--color-text-primary)] font-semibold mb-2">
            {searchQuery ? `No articles matching "${searchQuery}"` : 'Nothing saved for this scope yet'}
          </p>
          <p className="text-sm text-[var(--color-text-secondary)] mb-4 max-w-lg mx-auto">
            {searchQuery
              ? 'Try a different search term, or clear the search to browse all articles.'
              : docLibrary === 'use_cases'
                ? platformAdmin
                  ? 'No use-case guides for this scope yet. Pick a repository and branch above, then run “Generate use case library” (only replaces these guides; handbooks and other operational packs stay as they are).'
                  : 'No use-case guides for this scope yet. Pick a repository or branch, or open Sync center for a full documentation refresh. If you expected guides here, contact your organization administrator or support.'
                : docLibrary !== 'handbook'
                  ? 'Policies, SOPs, playbooks, and feature briefs are generated on each full documentation refresh when the indexed corpus is large enough. Apply the latest database update if counts stay at zero, then queue a refresh from Sync center—or try another scope.'
                  : 'Switch scope, select "All saved", or queue a doc refresh in Sync center for this repository and branch.'}
          </p>
          {searchQuery ? (
            <button onClick={() => setSearchQuery('')} className="pk-btn-primary inline-flex px-6 py-2.5">
              Clear search
            </button>
          ) : (
            <Link href="/settings/sync" className="pk-btn-primary inline-flex px-6 py-2.5">
              Sync center
            </Link>
          )}
        </div>
      ) : (
        <div className="grid lg:grid-cols-12 gap-5 items-start">
          {/* Left nav */}
          <nav className="lg:col-span-4 xl:col-span-3 space-y-4 lg:sticky lg:top-6 max-h-[calc(100vh-10rem)] overflow-y-auto pr-1 scrollbar-thin">
            {docLibrary === 'handbook' && browseAllScopes
              ? groupedByScopeThenCategory.map(({ heading, byCat }) => (
                  <div key={heading}>
                    <h2 className="text-[10px] font-bold uppercase tracking-widest text-primary mb-2 px-1">{heading}</h2>
                    {Array.from(byCat.entries())
                      .sort(([a], [b]) => compareHandbookCategory(a, b))
                      .map(([cat, rows]) => (
                        <div key={`${heading}-${cat}`} className="mb-3">
                          <div className="flex items-center gap-2 mb-1 px-1">
                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${categoryColors[cat].bar}`} />
                            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                              {categoryLabels[cat]}
                            </h3>
                            <span className="ml-auto text-[10px] text-[var(--color-text-tertiary)] font-mono">{rows.length}</span>
                          </div>
                          <ul className="space-y-0.5">
                            {sortRowsByOrder(rows).map((r, idx, arr) => (
                              <li key={r.id} className="flex items-stretch gap-0.5 group/navrow">
                                {reorderAllowed && (
                                  <div className="flex flex-col justify-center shrink-0 w-7 opacity-0 group-hover/navrow:opacity-100 transition-opacity">
                                    <button
                                      type="button"
                                      disabled={reorderBusy || idx <= 0}
                                      title="Move up"
                                      onClick={() => void moveDocInHandbookCategory(r.id, cat, -1)}
                                      className="rounded p-0.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] hover:text-primary disabled:opacity-30"
                                    >
                                      <ChevronUpIcon className="h-4 w-4" />
                                    </button>
                                    <button
                                      type="button"
                                      disabled={reorderBusy || idx >= arr.length - 1}
                                      title="Move down"
                                      onClick={() => void moveDocInHandbookCategory(r.id, cat, 1)}
                                      className="rounded p-0.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] hover:text-primary disabled:opacity-30"
                                    >
                                      <ChevronDownIcon className="h-4 w-4" />
                                    </button>
                                  </div>
                                )}
                                <button
                                  type="button"
                                  onClick={() => setActiveId(r.id)}
                                  className={`min-w-0 flex-1 text-left rounded-[var(--radius-md)] px-3 py-2 text-sm transition-colors leading-snug ${
                                    activeId === r.id
                                      ? 'bg-[var(--color-accent-light)] text-primary font-medium'
                                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
                                  }`}
                                >
                                  {r.title}
                                </button>
                                {canDeleteDocs && (
                                  <div className="flex items-center shrink-0 pr-0.5">
                                    <button
                                      type="button"
                                      title="Delete article"
                                      disabled={docSaveBusy}
                                      onClick={() => void deleteDoc(r.id)}
                                      className="rounded p-1.5 text-[var(--color-text-tertiary)] hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40"
                                    >
                                      <TrashIcon className="h-4 w-4" />
                                    </button>
                                  </div>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                  </div>
                ))
              : docLibrary === 'handbook' && !browseAllScopes
                ? Array.from(groupedByCategory.entries())
                    .sort(([a], [b]) => compareHandbookCategory(a, b))
                    .map(([cat, rows]) => (
                      <div key={cat}>
                        <div className="flex items-center gap-2 mb-1.5 px-1">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${categoryColors[cat].bar}`} />
                          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                            {categoryLabels[cat]}
                          </h2>
                          <span className="ml-auto text-[10px] text-[var(--color-text-tertiary)] font-mono">{rows.length}</span>
                        </div>
                        <ul className="space-y-0.5">
                          {sortRowsByOrder(rows).map((r, idx, arr) => (
                            <li key={r.id} className="flex items-stretch gap-0.5 group/navrow2">
                              {reorderAllowed && (
                                <div className="flex flex-col justify-center shrink-0 w-7 opacity-0 group-hover/navrow2:opacity-100 transition-opacity">
                                  <button
                                    type="button"
                                    disabled={reorderBusy || idx <= 0}
                                    title="Move up"
                                    onClick={() => void moveDocInHandbookCategory(r.id, cat, -1)}
                                    className="rounded p-0.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] hover:text-primary disabled:opacity-30"
                                  >
                                    <ChevronUpIcon className="h-4 w-4" />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={reorderBusy || idx >= arr.length - 1}
                                    title="Move down"
                                    onClick={() => void moveDocInHandbookCategory(r.id, cat, 1)}
                                    className="rounded p-0.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] hover:text-primary disabled:opacity-30"
                                  >
                                    <ChevronDownIcon className="h-4 w-4" />
                                  </button>
                                </div>
                              )}
                              <button
                                type="button"
                                onClick={() => setActiveId(r.id)}
                                className={`min-w-0 flex-1 text-left rounded-[var(--radius-md)] px-3 py-2 transition-colors leading-snug ${
                                  activeId === r.id
                                    ? 'bg-[var(--color-accent-light)] text-primary font-medium'
                                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
                                }`}
                              >
                                <span className={`block text-[13px] leading-snug ${activeId === r.id ? 'font-medium' : ''}`}>
                                  {r.title}
                                </span>
                                {r.summary && activeId !== r.id && (
                                  <span className="block text-[11px] text-[var(--color-text-tertiary)] mt-0.5 line-clamp-1 leading-relaxed">
                                    {r.summary}
                                  </span>
                                )}
                              </button>
                              {canDeleteDocs && (
                                <div className="flex items-center shrink-0 pr-0.5">
                                  <button
                                    type="button"
                                    title="Delete article"
                                    disabled={docSaveBusy}
                                    onClick={() => void deleteDoc(r.id)}
                                    className="rounded p-1.5 text-[var(--color-text-tertiary)] hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40"
                                  >
                                    <TrashIcon className="h-4 w-4" />
                                  </button>
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                : browseAllScopes
                  ? groupedByScopeFlat.map(({ heading, rows }) => (
                      <div key={heading}>
                        <h2 className="text-[10px] font-bold uppercase tracking-widest text-primary mb-2 px-1">{heading}</h2>
                        <ul className="space-y-0.5">
                          {rows.map((r) => (
                            <li key={r.id} className="flex items-stretch gap-0.5 group/navrow4">
                              <button
                                type="button"
                                onClick={() => setActiveId(r.id)}
                                className={`min-w-0 flex-1 text-left rounded-[var(--radius-md)] px-3 py-2 text-sm transition-colors leading-snug ${
                                  activeId === r.id
                                    ? 'bg-[var(--color-accent-light)] text-primary font-medium'
                                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
                                }`}
                              >
                                <span className={`block ${activeId === r.id ? 'font-medium' : ''}`}>{r.title}</span>
                                {r.summary && activeId !== r.id && (
                                  <span className="block text-[11px] text-[var(--color-text-tertiary)] mt-0.5 line-clamp-2 leading-relaxed">
                                    {r.summary}
                                  </span>
                                )}
                              </button>
                              {canDeleteDocs && (
                                <div className="flex items-center shrink-0 pr-0.5">
                                  <button
                                    type="button"
                                    title="Delete article"
                                    disabled={docSaveBusy}
                                    onClick={() => void deleteDoc(r.id)}
                                    className="rounded p-1.5 text-[var(--color-text-tertiary)] hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40"
                                  >
                                    <TrashIcon className="h-4 w-4" />
                                  </button>
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  : (
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-2 px-1">
                          {docLibrary === 'policies'
                            ? 'Policies in this scope'
                            : docLibrary === 'sops'
                              ? 'Procedures in this scope'
                              : docLibrary === 'playbooks'
                                ? 'Playbooks in this scope'
                                : docLibrary === 'feature_briefs'
                                  ? 'Feature briefs in this scope'
                                  : 'Use-case guides in this scope'}
                        </p>
                        <ul className="space-y-0.5">
                          {filtered.map((r, idx, arr) => (
                            <li key={r.id} className="flex items-stretch gap-0.5 group/navrow3">
                              {reorderAllowed && (
                                <div className="flex flex-col justify-center shrink-0 w-7 opacity-0 group-hover/navrow3:opacity-100 transition-opacity">
                                  <button
                                    type="button"
                                    disabled={reorderBusy || idx <= 0}
                                    title="Move up"
                                    onClick={() => void moveDocInList(r.id, -1)}
                                    className="rounded p-0.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] hover:text-primary disabled:opacity-30"
                                  >
                                    <ChevronUpIcon className="h-4 w-4" />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={reorderBusy || idx >= arr.length - 1}
                                    title="Move down"
                                    onClick={() => void moveDocInList(r.id, 1)}
                                    className="rounded p-0.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] hover:text-primary disabled:opacity-30"
                                  >
                                    <ChevronDownIcon className="h-4 w-4" />
                                  </button>
                                </div>
                              )}
                              <button
                                type="button"
                                onClick={() => setActiveId(r.id)}
                                className={`min-w-0 flex-1 text-left rounded-[var(--radius-md)] px-3 py-2 transition-colors leading-snug ${
                                  activeId === r.id
                                    ? 'bg-[var(--color-accent-light)] text-primary font-medium'
                                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
                                }`}
                              >
                                <span className={`block text-[13px] leading-snug ${activeId === r.id ? 'font-medium' : ''}`}>
                                  {r.title}
                                </span>
                                {r.summary && activeId !== r.id && (
                                  <span className="block text-[11px] text-[var(--color-text-tertiary)] mt-0.5 line-clamp-2 leading-relaxed">
                                    {r.summary}
                                  </span>
                                )}
                              </button>
                              {canDeleteDocs && (
                                <div className="flex items-center shrink-0 pr-0.5">
                                  <button
                                    type="button"
                                    title="Delete article"
                                    disabled={docSaveBusy}
                                    onClick={() => void deleteDoc(r.id)}
                                    className="rounded p-1.5 text-[var(--color-text-tertiary)] hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40"
                                  >
                                    <TrashIcon className="h-4 w-4" />
                                  </button>
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
          </nav>

          {/* Article */}
          <article
            ref={articleRef}
            className="lg:col-span-8 xl:col-span-9 min-h-[500px] max-h-[calc(100vh-8rem)] overflow-y-auto scrollbar-thin"
          >
            {active ? (
              <div className="pk-card overflow-hidden">
                {/* Category accent bar + header */}
                <div className={`h-1 w-full ${categoryColors[active.category].bar}`} />
                <div className="p-7 pb-5 border-b border-[var(--color-border)]">
                  <div className="flex items-start gap-3 mb-3 flex-wrap">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold shrink-0 ${categoryColors[active.category].chip}`}>
                      {articleKindLabel(active)}
                    </span>
                    <div className="flex items-center gap-3 ml-auto text-[11px] text-[var(--color-text-tertiary)] shrink-0 flex-wrap gap-y-1">
                      <span title="Estimated reading time">
                        {readingTime(editingDoc && editDraft ? editDraft.body_md : active.body_md)} min read
                      </span>
                      <span>·</span>
                      <span>{depthLabels[active.content_depth] ?? active.content_depth}</span>
                      <span>·</span>
                      <span>
                        {new Date(active.updated_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                      </span>
                    </div>
                    {canEditDocs && !editingDoc && (
                      <button
                        type="button"
                        onClick={startEdit}
                        className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:border-primary/40 hover:text-primary transition-colors shrink-0"
                      >
                        <PencilSquareIcon className="h-4 w-4" />
                        Edit
                      </button>
                    )}
                    {canEditDocs && editingDoc && (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={docSaveBusy || !editDraft?.title.trim()}
                          onClick={() => void saveEdit()}
                          className="rounded-[var(--radius-md)] bg-primary px-3 py-1.5 text-xs font-semibold text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-40"
                        >
                          {docSaveBusy ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          disabled={docSaveBusy}
                          onClick={() => {
                            setEditingDoc(false)
                            setEditDraft(null)
                          }}
                          className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                  {editingDoc && editDraft ? (
                    <>
                      <label className="sr-only" htmlFor="doc-edit-title">
                        Title
                      </label>
                      <input
                        id="doc-edit-title"
                        value={editDraft.title}
                        onChange={(e) => setEditDraft((d) => (d ? { ...d, title: e.target.value } : null))}
                        className="w-full text-2xl font-bold text-[var(--color-text-primary)] leading-tight mb-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
                      />
                      <label className="sr-only" htmlFor="doc-edit-summary">
                        Summary
                      </label>
                      <textarea
                        id="doc-edit-summary"
                        value={editDraft.summary}
                        onChange={(e) => setEditDraft((d) => (d ? { ...d, summary: e.target.value } : null))}
                        placeholder="Summary (optional)"
                        rows={3}
                        className="w-full text-[15px] text-[var(--color-text-secondary)] leading-relaxed rounded-[var(--radius-md)] border border-[var(--color-border)] border-l-[3px] border-l-primary/40 bg-[var(--color-surface)] px-3 py-2 mb-1 italic"
                      />
                    </>
                  ) : (
                    <>
                      <h2 className="text-2xl font-bold text-[var(--color-text-primary)] leading-tight mb-3">
                        {active.title}
                      </h2>
                      {active.summary && (
                        <p className="text-[15px] text-[var(--color-text-secondary)] leading-relaxed border-l-2 border-primary/30 pl-3 italic">
                          {active.summary}
                        </p>
                      )}
                    </>
                  )}
                </div>

                {/* Inline TOC if 3+ ## headings */}
                {(() => {
                  const mdForToc = editingDoc && editDraft ? editDraft.body_md : active.body_md
                  const toc = extractTocItems(mdForToc)
                  if (toc.length < 3) return null
                  return (
                    <div className="px-7 py-4 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-tertiary)] mb-2">In this article</p>
                      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
                        {toc.map((item) => (
                          <li key={item.slug}>
                            <a
                              href={`#${item.slug}`}
                              className="text-xs text-[var(--color-text-secondary)] hover:text-primary transition-colors"
                            >
                              {item.text}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })()}

                {/* Body */}
                <div className="px-7 py-6">
                  {editingDoc && editDraft ? (
                    <>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-tertiary)] mb-2">
                        Body (Markdown)
                      </p>
                      <label className="sr-only" htmlFor="doc-edit-body">
                        Article body
                      </label>
                      <textarea
                        id="doc-edit-body"
                        value={editDraft.body_md}
                        onChange={(e) => setEditDraft((d) => (d ? { ...d, body_md: e.target.value } : null))}
                        rows={22}
                        className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[13px] leading-relaxed text-[var(--color-text-primary)]"
                      />
                    </>
                  ) : (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                      {active.body_md}
                    </ReactMarkdown>
                  )}
                </div>

                {/* Source paths */}
                {editingDoc && editDraft ? (
                  <div className="px-7 py-5 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                    <div className="flex items-center gap-2 mb-3">
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-[var(--color-text-tertiary)] shrink-0">
                        <path d="M2 3h5l2 2h5v9H2V3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                      </svg>
                      <p className="text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wide">
                        Evidence paths (one per line)
                      </p>
                    </div>
                    <label className="sr-only" htmlFor="doc-edit-paths">
                      Source file paths
                    </label>
                    <textarea
                      id="doc-edit-paths"
                      value={editDraft.source_paths}
                      onChange={(e) => setEditDraft((d) => (d ? { ...d, source_paths: e.target.value } : null))}
                      rows={5}
                      placeholder="src/foo.ts"
                      className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[12px] text-[var(--color-text-secondary)]"
                    />
                  </div>
                ) : active.source_paths && active.source_paths.length > 0 ? (
                  <div className="px-7 py-5 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                    <div className="flex items-center gap-2 mb-4">
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-[var(--color-text-tertiary)] shrink-0">
                        <path d="M2 3h5l2 2h5v9H2V3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                      </svg>
                      <p className="text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wide">
                        Evidence in codebase: {active.source_paths.length} source {active.source_paths.length === 1 ? 'file' : 'files'}
                      </p>
                    </div>
                    {(() => {
                      const grouped = groupPathsByDir([...active.source_paths].sort())
                      return (
                        <div className="space-y-3">
                          {[...grouped.entries()].map(([dir, files]) => (
                            <div key={dir}>
                              {dir !== '.' && (
                                <p className="text-[10px] font-mono text-[var(--color-text-tertiary)] mb-1.5 px-0.5">
                                  {dir}/
                                </p>
                              )}
                              <div className="flex flex-wrap gap-1.5">
                                {files.map((f) => (
                                  <span
                                    key={f}
                                    className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] font-mono text-[var(--color-text-secondary)] hover:border-primary/40 hover:text-primary transition-colors"
                                  >
                                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="shrink-0 opacity-50">
                                      <rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                                    </svg>
                                    {f}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )
                    })()}
                  </div>
                ) : null}

                {/* Footer meta */}
                <div className="px-7 py-3 border-t border-[var(--color-border)] flex flex-wrap gap-4 text-[11px] text-[var(--color-text-tertiary)]">
                  <span>Written for: <span className="text-[var(--color-text-secondary)]">{active.target_audience}</span></span>
                  <span>Scope: <span className="text-[var(--color-text-secondary)]">{scopeSummary(active)}</span></span>
                </div>
              </div>
            ) : null}
          </article>
        </div>
      )}

      <p className="mt-10 text-xs text-[var(--color-text-tertiary)] max-w-2xl leading-relaxed">
        Articles are generated from indexed source code. When details conflict, the cited file paths are the ground truth; check those directly in your repository.
      </p>
    </div>
  )
}
