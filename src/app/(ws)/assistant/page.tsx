'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import type { ExtraProps } from 'react-markdown'
import { AnimatePresence, motion } from 'framer-motion'
import {
  PaperAirplaneIcon,
  PlusIcon,
  TrashIcon,
  ChevronDownIcon,
  SparklesIcon,
  XMarkIcon,
  DocumentTextIcon,
  CodeBracketIcon,
  ClipboardDocumentIcon,
  CheckIcon,
  MagnifyingGlassIcon,
  CpuChipIcon,
  LightBulbIcon,
  CircleStackIcon,
} from '@heroicons/react/24/outline'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useWorkspace } from '@/components/providers/WorkspaceContext'
import { authorizedFetch } from '@/lib/api'
import { withSupportContact } from '@/lib/support-copy'
import { Skeleton } from '@/components/ui/Skeleton'
import DatasetManager from '@/components/assistant/DatasetManager'
import { useSuperAdmin } from '@/lib/use-super-admin'
import { listDatasets, queryAssistant, type Dataset } from '@/lib/assistant-api'

// ── Types ─────────────────────────────────────────────────────────────────────

type MdCodeProps = ComponentPropsWithoutRef<'code'> & ExtraProps
type MdTableProps = ComponentPropsWithoutRef<'table'> & ExtraProps
type MdThProps = ComponentPropsWithoutRef<'th'> & ExtraProps
type MdTdProps = ComponentPropsWithoutRef<'td'> & ExtraProps

type Persona = 'pm' | 'developer' | 'executive'

type SourceRef = { label: string; path?: string; doc_section_id?: string; confidence: string; content?: string }

/** Right-hand canvas: code excerpt or full handbook article */
type CanvasState =
  | { kind: 'code'; code: string; lang: string; label: string }
  | {
      kind: 'doc'
      sectionId: string
      title: string
      category?: string | null
      summary?: string | null
      body_md?: string | null
      loading: boolean
      error?: string | null
    }

type Msg = {
  /** DB row id when loaded from API */
  id?: string
  /** Stable key for optimistic / streaming rows before persistence */
  clientId?: string
  role: 'user' | 'assistant'
  content: string
  low?: boolean
  sources?: SourceRef[]
  streaming?: boolean
}

type AssistantMode = 'grounded' | 'power'

type Thread = {
  id: string
  title: string | null
  created_at: string
  updated_at?: string | null
  persona?: Persona | null
  repository_id?: string | null
  branch?: string | null
  /** Persisted per thread: grounded (citation-first) vs power (deeper, richer). */
  response_mode?: AssistantMode | null
}

type ScopeBranch = { branch: string; chunk_count: number }
type ScopeRepo = {
  id: string
  name: string
  slug: string
  default_branch: string
  branches: ScopeBranch[]
}

type ChatSSEEvent =
  | { type: 'meta'; sources: SourceRef[]; lowGrounding: boolean }
  | { type: 'phase'; key: 'routing' | 'retrieval' | 'reasoning' | 'grounded' | 'power'; label: string }
  | { type: 'token'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

type ThinkPhase = { icon: typeof MagnifyingGlassIcon; label: string; color: string }

// ── Constants ─────────────────────────────────────────────────────────────────

const THINK_PHASES: ThinkPhase[] = [
  { icon: MagnifyingGlassIcon, label: 'Searching knowledge base…', color: 'text-blue-500' },
  { icon: CpuChipIcon,          label: 'Analysing code context…',  color: 'text-violet-500' },
  { icon: LightBulbIcon,        label: 'Composing answer…',        color: 'text-amber-500' },
]

const PERSONA_LABELS: Record<Persona, string> = {
  pm:        'Product manager (default tone)',
  developer: 'Engineering (more technical)',
  executive: 'Executive (brief outcomes)',
}

const STARTERS = [
  'How does moving a program to a past state affect communications?',
  'What are the main entry points and request flow in the codebase?',
  'Can we turn off outbound messages for a batch of programs?',
  'What data models power the reporting and exports feature?',
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Display label for threads with no title yet (distinct from the sidebar "Start new chat" action). */
function clip(str: string | null | undefined, max: number): string {
  if (!str) return 'Untitled conversation'
  return str.length > max ? str.slice(0, max) + '…' : str
}

function newClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `c-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function parseSourcesField(raw: unknown): SourceRef[] | undefined {
  if (raw == null) return undefined
  if (Array.isArray(raw)) return raw as SourceRef[]
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw) as unknown
      return Array.isArray(v) ? (v as SourceRef[]) : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

function normalizeMessagesFromApi(rows: unknown[]): Msg[] {
  return rows.map((row) => {
    const r = row as Record<string, unknown>
    const role = r.role === 'user' || r.role === 'assistant' ? r.role : 'assistant'
    return {
      id: typeof r.id === 'string' ? r.id : undefined,
      role,
      content: typeof r.content === 'string' ? r.content : '',
      low: Boolean(r.low_grounding),
      sources: parseSourcesField(r.sources),
      streaming: false,
    }
  })
}

function detectLanguage(path?: string): string {
  if (!path) return 'text'
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rb: 'ruby', java: 'java', kt: 'kotlin',
    go: 'go', rs: 'rust', cs: 'csharp', cpp: 'cpp', c: 'c',
    sql: 'sql', sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml',
    json: 'json', md: 'markdown', html: 'html', css: 'css',
  }
  return map[ext] ?? 'text'
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyBtn({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
      }}
      className={`p-1.5 rounded transition-colors ${
        copied
          ? 'text-emerald-400'
          : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/10'
      } ${className}`}
      title="Copy"
      aria-label="Copy code"
    >
      {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <ClipboardDocumentIcon className="h-3.5 w-3.5" />}
    </button>
  )
}

// ── Streaming cursor ──────────────────────────────────────────────────────────

function StreamCursor() {
  return (
    <motion.span
      className="inline-block w-[2px] h-[1.1em] bg-primary align-[-0.1em] ml-0.5 rounded-full"
      animate={{ opacity: [1, 0, 1] }}
      transition={{ duration: 0.9, repeat: Infinity, ease: 'linear' }}
    />
  )
}

// ── Thinking animation ────────────────────────────────────────────────────────

function ThinkingBubble({ phase, labelOverride }: { phase: number; labelOverride?: string }) {
  const p = THINK_PHASES[phase % THINK_PHASES.length]!
  const Icon = p.icon
  return (
    <div className="flex items-start gap-3 pl-1">
      {/* Avatar */}
      <motion.div
        className="flex-shrink-0 h-8 w-8 rounded-full bg-gradient-to-br from-primary/80 to-violet-500/80 text-white flex items-center justify-center shadow-sm"
        animate={{ scale: [1, 1.06, 1] }}
        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
      >
        <SparklesIcon className="h-4 w-4" />
      </motion.div>

      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-3 shadow-sm">
        {/* Phase icon */}
        <AnimatePresence mode="wait">
          <motion.div
            key={phase}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.2 }}
          >
            <Icon className={`h-4 w-4 ${p.color}`} />
          </motion.div>
        </AnimatePresence>

        {/* Dots */}
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="block h-1.5 w-1.5 rounded-full bg-primary/50"
              animate={{ y: [0, -4, 0], opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
            />
          ))}
        </div>

        {/* Label */}
        <AnimatePresence mode="wait">
          <motion.span
            key={phase}
            className="text-[13px] text-[var(--color-text-tertiary)] select-none whitespace-nowrap"
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.25 }}
          >
            {labelOverride?.trim() || p.label}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  )
}

// ── Markdown renderer with syntax highlighting + copy ────────────────────────

function AssistantMarkdown({
  content,
  onOpenCanvas,
}: {
  content: string
  onOpenCanvas?: (code: string, lang: string, label: string) => void
}) {
  return (
    <div className="prose prose-sm max-w-none text-[var(--color-text-primary)]
      [&_p]:my-1.5 [&_p]:text-[14px] [&_p]:leading-[1.7]
      [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:text-[14px] [&_li]:leading-[1.6]
      [&_strong]:font-semibold [&_strong]:text-[var(--color-text-primary)]
      [&_em]:italic
      [&_h1]:text-[16px] [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1.5
      [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1
      [&_h3]:text-[14px] [&_h3]:font-semibold [&_h3]:mt-2.5 [&_h3]:mb-1
      [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-[var(--color-text-secondary)] [&_blockquote]:italic [&_blockquote]:my-2
      [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2
      [&_hr]:border-[var(--color-border)] [&_hr]:my-3
      [&_table]:text-[13px] [&_th]:font-semibold [&_th]:text-left [&_td]:py-1 [&_th]:py-1.5
    ">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Inline code
          code({ className, children, ...props }: MdCodeProps) {
            const match = /language-(\w+)/.exec(className ?? '')
            const lang = match?.[1] ?? 'text'
            const codeStr = String(children).replace(/\n$/, '')
            const isBlock = codeStr.includes('\n') || className?.startsWith('language-')

            if (!isBlock) {
              return (
                <code
                  className="text-[12px] font-mono bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]/60 text-violet-600 dark:text-violet-400 px-1.5 py-0.5 rounded"
                  {...props}
                >
                  {children}
                </code>
              )
            }

            return (
              <div className="group relative my-3 rounded-xl overflow-hidden border border-[var(--color-border)]/60 shadow-sm">
                {/* Code header bar */}
                <div className="flex items-center justify-between px-4 py-2 bg-zinc-900/95 border-b border-white/10">
                  <span className="text-[11px] font-mono text-zinc-400 flex items-center gap-1.5">
                    <CodeBracketIcon className="h-3.5 w-3.5" />
                    {lang}
                  </span>
                  <div className="flex items-center gap-1">
                    {onOpenCanvas && (
                      <button
                        onClick={() => onOpenCanvas(codeStr, lang, lang)}
                        className="text-[11px] text-zinc-400 hover:text-white px-2 py-1 rounded hover:bg-white/10 transition-colors flex items-center gap-1"
                        title="Open in canvas"
                      >
                        <DocumentTextIcon className="h-3.5 w-3.5" />
                        Canvas
                      </button>
                    )}
                    <CopyBtn text={codeStr} />
                  </div>
                </div>

                {/* Code body */}
                <SyntaxHighlighter
                  style={oneDark}
                  language={lang}
                  PreTag="div"
                  customStyle={{
                    margin: 0,
                    padding: '1rem',
                    background: 'rgba(24,24,27,0.97)',
                    fontSize: '12.5px',
                    lineHeight: '1.65',
                    borderRadius: 0,
                  }}
                  codeTagProps={{ style: { fontFamily: "'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace" } }}
                >
                  {codeStr}
                </SyntaxHighlighter>
              </div>
            )
          },
          // Tables
          table({ children }: MdTableProps) {
            return (
              <div className="overflow-x-auto my-2 rounded-lg border border-[var(--color-border)]">
                <table className="w-full border-collapse">{children}</table>
              </div>
            )
          },
          th({ children }: MdThProps) {
            return (
              <th className="bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] px-3 py-2 text-[12px] font-semibold text-left">
                {children}
              </th>
            )
          },
          td({ children }: MdTdProps) {
            return (
              <td className="border-b border-[var(--color-border)]/60 px-3 py-1.5 text-[13px]">
                {children}
              </td>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

// ── Source cards ──────────────────────────────────────────────────────────────

function SourceCards({
  sources,
  onOpenCodeSnippet,
  onOpenDocSection,
}: {
  sources: SourceRef[]
  onOpenCodeSnippet: (path: string, label: string) => void
  onOpenDocSection: (sectionId: string, label: string) => void
}) {
  const [expanded, setExpanded] = useState(false)

  const handbookSources = sources.filter((s) => s.doc_section_id && !s.path)
  const codeSources = sources.filter((s) => s.path)
  const visibleCode = expanded ? codeSources : codeSources.slice(0, 4)

  if (sources.length === 0) return null

  return (
    <div className="mt-3 space-y-2">
      {/* Handbook article chips */}
      {handbookSources.length > 0 && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-primary/70 flex items-center gap-1.5 mb-1.5">
            <DocumentTextIcon className="h-3 w-3" />
            Handbook
          </p>
          <div className="flex flex-wrap gap-1.5">
            {handbookSources.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  if (s.doc_section_id) onOpenDocSection(s.doc_section_id, s.label)
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px]
                  border border-primary/30 bg-[var(--color-accent-light)] text-primary
                  hover:bg-primary/10 hover:border-primary transition-all duration-100 text-left"
                title={`Open in side panel: ${s.label}`}
              >
                <DocumentTextIcon className="h-3 w-3 shrink-0" />
                <span className="truncate max-w-[220px] font-medium">{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Code chunk chips */}
      {codeSources.length > 0 && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-tertiary)] flex items-center gap-1.5 mb-1.5">
            <CodeBracketIcon className="h-3 w-3" />
            Code · {codeSources.length}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {visibleCode.map((s, i) => (
              <button
                key={i}
                onClick={() => {
                  if (s.path) onOpenCodeSnippet(s.path, s.label)
                }}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-mono
                  border transition-all duration-100
                  ${s.confidence === 'high'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:border-emerald-800/60 dark:text-emerald-400'
                    : s.confidence === 'medium'
                      ? 'bg-amber-50 border-amber-200 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/20 dark:border-amber-700/60 dark:text-amber-400'
                      : 'bg-[var(--color-bg-secondary)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-primary hover:text-primary'
                  }
                  ${s.path ? 'cursor-pointer' : 'cursor-default'}
                `}
                title={s.path ? `Open ${s.label}` : s.label}
              >
                <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${
                  s.confidence === 'high' ? 'bg-emerald-500' :
                  s.confidence === 'medium' ? 'bg-amber-500' :
                  'bg-[var(--color-border)]'
                }`} />
                <span className="truncate max-w-[180px]">{s.label}</span>
              </button>
            ))}
            {codeSources.length > 4 && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px]
                  bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text-tertiary)]
                  hover:text-primary hover:border-primary transition-colors"
              >
                {expanded ? 'Less' : `+${codeSources.length - 4} more`}
                <ChevronDownIcon className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Code canvas panel ─────────────────────────────────────────────────────────

function CodeCanvas({
  code,
  lang,
  label,
  onClose,
}: {
  code: string
  lang: string
  label: string
  onClose: () => void
}) {
  return (
    <motion.div
      className="flex flex-col h-full w-full"
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
    >
      {/* Canvas header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-2 min-w-0">
          <CodeBracketIcon className="h-4 w-4 text-[var(--color-text-tertiary)] flex-shrink-0" />
          <span className="text-[13px] font-mono font-medium text-[var(--color-text-primary)] truncate">{label}</span>
          {lang !== 'text' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text-tertiary)] font-mono flex-shrink-0">
              {lang}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {code && <CopyBtn text={code} />}
          <button
            onClick={onClose}
            className="p-1.5 rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
            aria-label="Close canvas"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Canvas body */}
      <div className="flex-1 overflow-auto min-h-0">
        {code ? (
          <SyntaxHighlighter
            style={oneDark}
            language={lang}
            showLineNumbers
            PreTag="div"
            customStyle={{
              margin: 0,
              padding: '1.25rem',
              background: 'rgba(24,24,27,0.98)',
              fontSize: '12.5px',
              lineHeight: '1.7',
              borderRadius: 0,
              height: '100%',
            }}
            codeTagProps={{ style: { fontFamily: "'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace" } }}
          >
            {code}
          </SyntaxHighlighter>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <CodeBracketIcon className="h-10 w-10 text-[var(--color-text-tertiary)] mb-4 opacity-40" />
            <p className="text-sm font-medium text-[var(--color-text-secondary)] mb-1">{label}</p>
            <p className="text-xs text-[var(--color-text-tertiary)] leading-relaxed max-w-[220px]">
              Source reference from the codebase. Sync and index this repository to view inline code.
            </p>
          </div>
        )}
      </div>
    </motion.div>
  )
}

/** Handbook article in the side canvas: readable surface, same markdown treatment as answers */
function DocCanvas({
  title,
  category,
  summary,
  body_md,
  loading,
  error,
  onClose,
}: {
  title: string
  category?: string | null
  summary?: string | null
  body_md?: string | null
  loading: boolean
  error?: string | null
  onClose: () => void
}) {
  return (
    <div className="flex flex-col h-full w-full bg-[var(--color-surface)]">
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50">
        <div className="flex items-center gap-2 min-w-0 pr-2">
          <DocumentTextIcon className="h-4 w-4 text-primary flex-shrink-0" />
          <div className="min-w-0">
            <span className="text-[13px] font-semibold text-[var(--color-text-primary)] leading-snug block truncate">{title}</span>
            {category ? (
              <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">{category.replace(/_/g, ' ')}</span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors flex-shrink-0"
          aria-label="Close panel"
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-4">
        {loading && (
          <div className="space-y-3 animate-pulse">
            <div className="h-3 bg-[var(--color-bg-tertiary)] rounded w-3/4" />
            <div className="h-3 bg-[var(--color-bg-tertiary)] rounded w-full" />
            <div className="h-3 bg-[var(--color-bg-tertiary)] rounded w-5/6" />
          </div>
        )}
        {!loading && error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>
        )}
        {!loading && !error && (
          <>
            {summary ? (
              <p className="text-[13px] text-[var(--color-text-secondary)] leading-relaxed mb-4 pb-4 border-b border-[var(--color-border)]">
                {summary}
              </p>
            ) : null}
            {body_md ? (
              <div className="prose prose-sm max-w-none text-[var(--color-text-primary)]
                [&_p]:my-2 [&_p]:text-[13px] [&_p]:leading-[1.65]
                [&_ul]:my-2 [&_ol]:my-2 [&_li]:text-[13px]
                [&_strong]:font-semibold [&_h1]:text-[15px] [&_h2]:text-[14px] [&_h3]:text-[13px]
                [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-[var(--color-text-secondary)]
                [&_hr]:border-[var(--color-border)] [&_table]:text-[12px]">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({ className, children, ...props }: MdCodeProps) {
                      const match = /language-(\w+)/.exec(className ?? '')
                      const lang = match?.[1] ?? 'text'
                      const codeStr = String(children).replace(/\n$/, '')
                      const isBlock = codeStr.includes('\n') || className?.startsWith('language-')
                      if (!isBlock) {
                        return (
                          <code
                            className="text-[11px] font-mono bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]/60 px-1 py-0.5 rounded"
                            {...props}
                          >
                            {children}
                          </code>
                        )
                      }
                      return (
                        <div className="my-3 rounded-lg overflow-hidden border border-[var(--color-border)]">
                          <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/95 border-b border-white/10">
                            <span className="text-[10px] font-mono text-zinc-400">{lang}</span>
                            <CopyBtn text={codeStr} />
                          </div>
                          <SyntaxHighlighter
                            style={oneDark}
                            language={lang}
                            PreTag="div"
                            customStyle={{
                              margin: 0,
                              padding: '0.75rem',
                              background: 'rgba(24,24,27,0.97)',
                              fontSize: '11.5px',
                              lineHeight: 1.6,
                              borderRadius: 0,
                            }}
                            codeTagProps={{ style: { fontFamily: "'Fira Code', 'JetBrains Mono', monospace" } }}
                          >
                            {codeStr}
                          </SyntaxHighlighter>
                        </div>
                      )
                    },
                    table({ children }: MdTableProps) {
                      return (
                        <div className="overflow-x-auto my-2 rounded-lg border border-[var(--color-border)]">
                          <table className="w-full border-collapse">{children}</table>
                        </div>
                      )
                    },
                    th({ children }: MdThProps) {
                      return (
                        <th className="bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] px-2 py-1.5 text-[11px] font-semibold text-left">
                          {children}
                        </th>
                      )
                    },
                    td({ children }: MdTdProps) {
                      return (
                        <td className="border-b border-[var(--color-border)]/60 px-2 py-1 text-[12px]">{children}</td>
                      )
                    },
                  }}
                >
                  {body_md}
                </ReactMarkdown>
              </div>
            ) : (
              !summary && <p className="text-sm text-[var(--color-text-tertiary)]">No article body yet.</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AssistantPage() {
  const { workspace } = useWorkspace()
  const { activeTenantId } = useSuperAdmin()

  const [threads, setThreads] = useState<Thread[]>([])
  const [threadsLoading, setThreadsLoading] = useState(false)
  const [activeThread, setActiveThread] = useState<Thread | null>(null)
  const activeRef = useRef<Thread | null>(null)
  activeRef.current = activeThread

  const [messages, setMessages] = useState<Msg[]>([])
  const [msgsLoading, setMsgsLoading] = useState(false)

  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [thinkPhase, setThinkPhase] = useState(0)
  const [thinkLabel, setThinkLabel] = useState<string | null>(null)
  const [assistantMode, setAssistantMode] = useState<AssistantMode>('grounded')
  const pendingMsg = useRef('')

  const [scopeRepos, setScopeRepos] = useState<ScopeRepo[]>([])
  const [scopeRepoId, setScopeRepoId] = useState('')
  const [scopeBranch, setScopeBranch] = useState('')

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creatingThread, setCreatingThread] = useState(false)

  // RAG knowledge-base query mode
  const [ragDatasets, setRagDatasets]   = useState<Dataset[]>([])
  const [activeRagId, setActiveRagId]   = useState<string>('') // '' = OpenCode SSE | 'all' | datasetId
  const [ragModel, setRagModel]         = useState<string>('us.anthropic.claude-haiku-4-5-20251001-v1:0')

  // RAG conversation persistence
  type RagConv = { id: string; dataset_id: string; dataset_name: string; model: string; title: string; updated_at: string }
  const [ragConversations, setRagConversations] = useState<RagConv[]>([])
  const [activeRagConvId, setActiveRagConvId]   = useState<string | null>(null)
  const [ragConvsLoading, setRagConvsLoading]   = useState(false)

  // Side canvas: inline code from markdown, fetched snippet by path, or full handbook article
  const [canvas, setCanvas] = useState<CanvasState | null>(null)

  const openCodeInline = useCallback((code: string, lang: string, label: string) => {
    setCanvas({ kind: 'code', code, lang, label })
  }, [])

  const openDocFromId = useCallback(async (sectionId: string, title: string) => {
    if (!workspace?.id) return
    setCanvas({
      kind: 'doc',
      sectionId,
      title,
      loading: true,
      error: null,
    })
    try {
      const q = new URLSearchParams({
        workspace_id: workspace.id,
        section_id: sectionId,
      })
      const r = await authorizedFetch(`/api/workspace/doc-section?${q.toString()}`)
      const j = (await r.json()) as {
        title?: string
        summary?: string | null
        body_md?: string | null
        category?: string | null
        error?: string
      }
      if (!r.ok) {
        setCanvas({
          kind: 'doc',
          sectionId,
          title,
          loading: false,
          error: typeof j.error === 'string' ? j.error : 'Could not load article',
        })
        return
      }
      setCanvas({
        kind: 'doc',
        sectionId,
        title: j.title ?? title,
        summary: j.summary ?? null,
        body_md: j.body_md ?? null,
        category: j.category ?? null,
        loading: false,
        error: null,
      })
    } catch {
      setCanvas({
        kind: 'doc',
        sectionId,
        title,
        loading: false,
        error: 'Could not load article',
      })
    }
  }, [workspace?.id])

  const openCodeFromPath = useCallback(
    async (sourcePath: string, displayLabel: string) => {
      if (!workspace?.id) return
      setCanvas({
        kind: 'code',
        code: '',
        lang: detectLanguage(sourcePath),
        label: displayLabel,
      })
      const params = new URLSearchParams({
        workspace_id: workspace.id,
        path: sourcePath,
      })
      if (scopeRepoId) params.set('repository_id', scopeRepoId)
      if (scopeBranch) params.set('sync_branch', scopeBranch)
      try {
        const r = await authorizedFetch(`/api/workspace/knowledge-snippet?${params.toString()}`)
        const j = (await r.json()) as { body?: string; error?: string }
        if (!r.ok) {
          setCanvas({
            kind: 'code',
            code: `// ${j.error ?? 'Could not load this file excerpt'}`,
            lang: 'typescript',
            label: displayLabel,
          })
          return
        }
        setCanvas({
          kind: 'code',
          code: j.body ?? '',
          lang: detectLanguage(sourcePath),
          label: displayLabel,
        })
      } catch {
        setCanvas({
          kind: 'code',
          code: '// Could not load excerpt',
          lang: 'typescript',
          label: displayLabel,
        })
      }
    },
    [workspace?.id, scopeRepoId, scopeBranch]
  )

  const autoOpenFromSources = useCallback(
    (sources: SourceRef[]) => {
      const hb = sources.find((s) => s.doc_section_id && !s.path)
      if (hb?.doc_section_id) {
        void openDocFromId(hb.doc_section_id, hb.label)
        return
      }
      const code =
        sources.find((s) => s.path && s.confidence === 'high') ??
        sources.find((s) => s.path && s.confidence === 'medium') ??
        sources.find((s) => s.path)
      if (code) {
        if (code.content) {
          // RAG sources: we already have the chunk content, show it directly
          openCodeInline(code.content, detectLanguage(code.path ?? ''), code.label)
        } else if (code.path) {
          void openCodeFromPath(code.path, code.label)
        }
      }
    },
    [openDocFromId, openCodeFromPath, openCodeInline]
  )

  /** Defer opening the side canvas until the first streamed token (avoids layout jump during "thinking"). */
  const pendingAutoOpenSourcesRef = useRef<SourceRef[] | null>(null)
  const flushPendingAutoOpen = useCallback(() => {
    const pending = pendingAutoOpenSourcesRef.current
    pendingAutoOpenSourcesRef.current = null
    if (pending && pending.length > 0) autoOpenFromSources(pending)
  }, [autoOpenFromSources])

  const messagesEnd = useRef<HTMLDivElement>(null)
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const scopeAutoApplied = useRef(false)
  const previousThreadBeforeCreateRef = useRef<Thread | null>(null)
  const createThreadInFlightRef = useRef(false)

  // ── Thinking phase cycling ─────────────────────────────────────────────────
  useEffect(() => {
    if (!thinking) { setThinkPhase(0); setThinkLabel(null); return }
    const id = setInterval(() => setThinkPhase((s) => (s + 1) % THINK_PHASES.length), 2000)
    return () => clearInterval(id)
  }, [thinking])

  // ── Load threads ───────────────────────────────────────────────────────────
  const refreshThreads = useCallback(
    async (opts?: { autoSelect?: boolean; /** When true, update sidebar list without unmounting the main chat (no full-panel skeleton). */ soft?: boolean }) => {
      if (!workspace?.id) return
      const autoSelect = opts?.autoSelect ?? false
      const soft = opts?.soft ?? false
      if (!soft) setThreadsLoading(true)
      try {
        const r = await authorizedFetch(`/api/assistant/threads?workspace_id=${workspace.id}`)
        const d = (await r.json()) as { threads?: Thread[] }
        if (r.ok) {
          const list = d.threads ?? []
          setThreads(list)
          const cur = activeRef.current
          if (cur) {
            const updated = list.find((t) => t.id === cur.id)
            if (updated) setActiveThread(updated)
          }
          if (autoSelect && list.length > 0 && !activeRef.current) {
            setActiveThread(list[0]!)
          }
        }
      } catch (e) {
        console.error(e)
      } finally {
        if (!soft) setThreadsLoading(false)
      }
    },
    [workspace?.id]
  )

  useEffect(() => {
    void refreshThreads({ autoSelect: true })
  }, [refreshThreads])

  useEffect(() => {
    const rm = activeThread?.response_mode
    if (rm === 'grounded' || rm === 'power') setAssistantMode(rm)
  }, [activeThread?.id, activeThread?.response_mode])

  // ── Load RAG datasets (READY only) ────────────────────────────────────────
  useEffect(() => {
    void listDatasets(activeTenantId ?? undefined)
      .then((d) => setRagDatasets((d.datasets ?? []).filter((ds) => ds.status === 'READY')))
      .catch(console.error)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTenantId])

  // ── Load RAG conversation history ─────────────────────────────────────────
  const refreshRagConversations = useCallback(async () => {
    if (!workspace?.id) return
    setRagConvsLoading(true)
    try {
      const r = await authorizedFetch(`/api/assistant/rag-conversations?workspace_id=${workspace.id}`)
      if (r.ok) {
        const d = (await r.json()) as { conversations: RagConv[] }
        setRagConversations(d.conversations ?? [])
      }
    } catch { /* silently ignore — table may not be set up yet */ }
    finally { setRagConvsLoading(false) }
  }, [workspace?.id])

  useEffect(() => { void refreshRagConversations() }, [refreshRagConversations])

  const deleteRagConversation = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Delete this RAG conversation?')) return
    await authorizedFetch(`/api/assistant/rag-conversations/${id}`, { method: 'DELETE' })
    setRagConversations((prev) => prev.filter((c) => c.id !== id))
    if (activeRagConvId === id) { setActiveRagConvId(null); setMessages([]) }
  }, [activeRagConvId])

  const loadRagConversation = useCallback(async (conv: RagConv) => {
    setActiveRagId(conv.dataset_id)
    setRagModel(conv.model)
    setActiveRagConvId(conv.id)
    setActiveThread(null)
    setMessages([])
    // Fetch full messages
    const r = await authorizedFetch(`/api/assistant/rag-conversations/${conv.id}`)
    if (!r.ok) return
    const d = (await r.json()) as { conversation: { messages: Msg[] } }
    const msgs = (d.conversation.messages ?? []).map((m) => ({ ...m, clientId: newClientId() }))
    setMessages(msgs)
  }, [])

  // ── Load scope repos ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!workspace?.id) return
    authorizedFetch(`/api/workspace/knowledge-scope?workspace_id=${workspace.id}`)
      .then((r) => r.json() as Promise<{ repositories?: ScopeRepo[] }>)
      .then((d) => {
        const repos = d.repositories ?? []
        setScopeRepos(repos)
        if (repos.length > 0 && !scopeAutoApplied.current) {
          scopeAutoApplied.current = true
          const largest = [...repos].sort((a, b) => {
            const aChunks = a.branches.reduce((s, br) => s + br.chunk_count, 0)
            const bChunks = b.branches.reduce((s, br) => s + br.chunk_count, 0)
            return bChunks - aChunks
          })[0]!
          const topBranch = [...largest.branches].sort((a, b) => b.chunk_count - a.chunk_count)[0]
          setScopeRepoId(largest.id)
          if (topBranch?.branch) setScopeBranch(topBranch.branch)
        }
      })
      .catch(console.error)
  }, [workspace?.id])

  // ── Load messages ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeThread) {
      setMessages([])
      setMsgsLoading(false)
      return
    }
    const threadId = activeThread.id
    const ac = new AbortController()
    setMsgsLoading(true)
    setMessages([])
    authorizedFetch(`/api/assistant/threads/${threadId}/messages`, { signal: ac.signal })
      .then((r) => r.json() as Promise<{ messages?: unknown[] }>)
      .then((d) => {
        if (activeRef.current?.id !== threadId) return
        setMessages(normalizeMessagesFromApi(d.messages ?? []))
      })
      .catch((e) => {
        if ((e as Error)?.name === 'AbortError') return
        console.error(e)
      })
      .finally(() => {
        if (activeRef.current?.id === threadId) setMsgsLoading(false)
      })
    return () => ac.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread?.id])

  // ── Scroll bottom (throttled while streaming; skip if user scrolled up) ───
  const scrollRafRef = useRef<number | null>(null)
  useEffect(() => {
    const cancelScheduled = () => {
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }

    const end = messagesEnd.current
    const root = messagesScrollRef.current
    if (!end) return cancelScheduled

    const streaming =
      messages.length > 0 && messages[messages.length - 1]?.role === 'assistant' && messages[messages.length - 1]?.streaming

    const runScroll = () => {
      scrollRafRef.current = null
      if (!messagesEnd.current) return
      const behavior: ScrollBehavior = messages.length <= 1 ? 'instant' : 'smooth'
      messagesEnd.current.scrollIntoView({ behavior, block: 'end' })
    }

    if (streaming && root) {
      const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 140
      if (!nearBottom) return cancelScheduled
      cancelScheduled()
      scrollRafRef.current = requestAnimationFrame(runScroll)
      return cancelScheduled
    }

    cancelScheduled()
    runScroll()
    return cancelScheduled
  }, [messages, thinking])

  // ── Focus input ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeThread && !editingTitle) setTimeout(() => inputRef.current?.focus(), 80)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread?.id])

  // ── Sync scope from thread ─────────────────────────────────────────────────
  useEffect(() => {
    if (activeThread?.repository_id) {
      setScopeRepoId(activeThread.repository_id)
      setScopeBranch(activeThread.branch ?? '')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread?.id])

  // ── Auto-send pending ──────────────────────────────────────────────────────
  useEffect(() => {
    const msg = pendingMsg.current
    if (activeThread && msg) { pendingMsg.current = ''; void doSend(msg) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread?.id])

  // ── Create thread ──────────────────────────────────────────────────────────
  const createThread = useCallback(async (): Promise<Thread | null> => {
    if (!workspace?.id) { setCreateError('Workspace is loading: please wait a moment.'); return null }
    if (createThreadInFlightRef.current) return null
    createThreadInFlightRef.current = true
    setCreateError(null)
    previousThreadBeforeCreateRef.current = activeRef.current
    setCanvas(null)
    setCreatingThread(true)
    setActiveThread(null)
    setMessages([])
    try {
      const r = await authorizedFetch('/api/assistant/threads', {
        method: 'POST',
        body: JSON.stringify({
          workspace_id: workspace.id,
          persona: 'pm',
          response_mode: assistantMode,
        }),
      })
      const d = (await r.json()) as { thread?: Thread; error?: unknown }
      if (!r.ok) {
        const errMsg = typeof d.error === 'string' ? d.error
          : typeof d.error === 'object' && d.error !== null ? JSON.stringify(d.error)
          : `HTTP ${r.status}`
        setCreateError(`Could not create conversation: ${errMsg}`)
        const prev = previousThreadBeforeCreateRef.current
        previousThreadBeforeCreateRef.current = null
        if (prev) setActiveThread(prev)
        return null
      }
      if (d.thread) {
        setThreads((p) => [d.thread!, ...p])
        setActiveThread(d.thread!)
        previousThreadBeforeCreateRef.current = null
        return d.thread!
      }
    } catch {
      setCreateError('Network error: check your connection.')
      const prev = previousThreadBeforeCreateRef.current
      previousThreadBeforeCreateRef.current = null
      if (prev) setActiveThread(prev)
    } finally {
      setCreatingThread(false)
      createThreadInFlightRef.current = false
    }
    return null
  }, [workspace?.id, assistantMode])

  // ── Delete thread ──────────────────────────────────────────────────────────
  const removeThread = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setThreads((p) => p.filter((t) => t.id !== id))
    if (activeRef.current?.id === id) { setActiveThread(null); setMessages([]) }
    await authorizedFetch(`/api/assistant/threads/${id}`, { method: 'DELETE' }).catch(console.error)
  }

  // ── Save title ─────────────────────────────────────────────────────────────
  const saveTitle = async () => {
    setEditingTitle(false)
    const thread = activeRef.current
    if (!thread || !titleDraft.trim() || titleDraft.trim() === (thread.title ?? '')) return
    const title = titleDraft.trim()
    setActiveThread((t) => (t ? { ...t, title } : t))
    setThreads((p) => p.map((t) => (t.id === thread.id ? { ...t, title } : t)))
    await authorizedFetch(`/api/assistant/threads/${thread.id}`, {
      method: 'PATCH', body: JSON.stringify({ title }),
    }).catch(console.error)
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  const doSend = async (text: string) => {
    const q = text.trim()
    if (!q || !workspace?.id || sending) return

    // ── RAG path: query pgvector knowledge base ──────────────────────────────
    if (activeRagId) {
      const ids = activeRagId === 'all'
        ? ragDatasets.map((d) => d.datasetId)
        : [activeRagId]
      setSending(true)
      setThinking(true)
      setInput('')
      if (inputRef.current) inputRef.current.style.height = 'auto'
      const userMsg: Msg = { role: 'user', content: q, clientId: newClientId() }
      setMessages((m) => [...m, userMsg])
      try {
        const result = await queryAssistant(q, ids, activeTenantId ?? undefined, ragModel)
        const sources: SourceRef[] = result.sources.map((s) => ({
          label: s.filePath.split('/').pop() ?? s.filePath,
          path: s.filePath,
          confidence: 'high' as const,
          content: s.content,
        }))
        const asstMsg: Msg = {
          role: 'assistant',
          content: result.answer,
          sources: sources.length > 0 ? sources : undefined,
          clientId: newClientId(),
        }
        setMessages((m) => {
          const updated = [...m, asstMsg]
          // Persist to database (fire-and-forget)
          const allMsgs = updated.map(({ role, content, sources: s }) => ({ role, content, sources: s }))
          const datasetName = ragDatasets.find((d) => d.datasetId === (activeRagId === 'all' ? ids[0] : activeRagId))?.name ?? activeRagId
          if (activeRagConvId) {
            // Update existing conversation
            authorizedFetch(`/api/assistant/rag-conversations/${activeRagConvId}`, {
              method: 'POST',
              body: JSON.stringify({ id: activeRagConvId, messages: allMsgs }),
            }).catch(console.error)
          } else {
            // Create new conversation, then store ID
            authorizedFetch('/api/assistant/rag-conversations', {
              method: 'POST',
              body: JSON.stringify({
                workspace_id: workspace!.id,
                dataset_id: activeRagId === 'all' ? 'all' : activeRagId,
                dataset_name: activeRagId === 'all' ? 'All knowledge bases' : datasetName,
                model: ragModel,
                title: q.slice(0, 80),
                messages: allMsgs,
              }),
            }).then(async (r) => {
              if (r.ok) {
                const d = (await r.json()) as { conversation: { id: string } }
                setActiveRagConvId(d.conversation.id)
                void refreshRagConversations()
              }
            }).catch(console.error)
          }
          return updated
        })
        if (sources.length > 0) autoOpenFromSources(sources)
      } catch (e) {
        setMessages((m) => [...m, {
          role: 'assistant',
          content: (e as Error).message || 'Query failed.',
          low: true,
          clientId: newClientId(),
        }])
      } finally {
        setSending(false)
        setThinking(false)
      }
      return
    }

    const thread = activeRef.current
    if (!thread) { pendingMsg.current = q; await createThread(); return }

    setSending(true)
    setThinking(true)
    pendingAutoOpenSourcesRef.current = null
    setInput('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
    const userClientId = newClientId()
    setMessages((m) => [...m, { role: 'user', content: q, clientId: userClientId }])

    let streamingSources: SourceRef[] = []
    let streamingLow = false

    try {
      const r = await authorizedFetch('/api/assistant/chat', {
        method: 'POST',
        body: JSON.stringify({
          workspace_id: workspace.id,
          thread_id: thread.id,
          message: q,
          mode: assistantMode,
          persona: thread.persona ?? 'pm',
          repository_id: scopeRepoId || null,
          branch: scopeRepoId && scopeBranch ? scopeBranch : null,
        }),
      })

      if (!r.ok || !r.body) {
        setThinking(false)
        let errMsg = 'Something went wrong. Please try again.'
        try {
          const d = (await r.json()) as { error?: string }
          if (d.error && !/pk_|pgrst|postgres|schema|rpc\b|sql/i.test(d.error)) errMsg = d.error
        } catch { /* ignore */ }
        setMessages((m) => [...m, { role: 'assistant', content: withSupportContact(errMsg), low: true, clientId: newClientId() }])
        return
      }

      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamingContent = ''
      let streamingMsgAdded = false
      const assistantClientId = newClientId()

      const flushBuffer = () => {
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          if (!block.startsWith('data: ')) continue
          let event: ChatSSEEvent
          try { event = JSON.parse(block.slice(6)) as ChatSSEEvent } catch { continue }

          if (event.type === 'meta') {
            streamingSources = event.sources
            streamingLow = event.lowGrounding
            pendingAutoOpenSourcesRef.current = event.sources
          } else if (event.type === 'phase') {
            setThinkLabel(event.label)
          } else if (event.type === 'token') {
            if (!streamingMsgAdded) {
              streamingMsgAdded = true
              setThinking(false)
              flushPendingAutoOpen()
              setMessages((m) => [...m, { role: 'assistant', content: '', streaming: true, clientId: assistantClientId }])
            }
            streamingContent += event.content
            setMessages((m) => {
              const arr = [...m]
              arr[arr.length - 1] = {
                ...arr[arr.length - 1],
                role: 'assistant',
                content: streamingContent,
                streaming: true,
                clientId: assistantClientId,
              }
              return arr
            })
          } else if (event.type === 'done') {
            setThinking(false)
            flushPendingAutoOpen()
            setMessages((m) => {
              const arr = [...m]
              const last = arr[arr.length - 1]
              if (last?.role === 'assistant') {
                arr[arr.length - 1] = {
                  ...last,
                  content: streamingContent || last.content || 'No response.',
                  streaming: false,
                  low: streamingLow,
                  sources: streamingSources.length > 0 ? streamingSources : undefined,
                  clientId: assistantClientId,
                }
              } else {
                arr.push({
                  role: 'assistant',
                  content: streamingContent || 'No response.',
                  streaming: false,
                  low: streamingLow,
                  sources: streamingSources.length > 0 ? streamingSources : undefined,
                  clientId: assistantClientId,
                })
              }
              return arr
            })
            void refreshThreads({ soft: true })
          } else if (event.type === 'error') {
            setThinking(false)
            pendingAutoOpenSourcesRef.current = null
            setMessages((m) => {
              const arr = [...m]
              const last = arr[arr.length - 1]
              if (last?.role === 'assistant' && last.streaming) {
                arr[arr.length - 1] = {
                  ...last,
                  role: 'assistant',
                  content: event.message,
                  streaming: false,
                  low: true,
                  clientId: last.clientId ?? assistantClientId,
                }
              } else {
                arr.push({ role: 'assistant', content: event.message, low: true, streaming: false, clientId: newClientId() })
              }
              return arr
            })
          }
        }
      }

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        flushBuffer()
      }
      if (buffer) { buffer += '\n\n'; flushBuffer() }
      flushPendingAutoOpen()

    } catch {
      setThinking(false)
      pendingAutoOpenSourcesRef.current = null
      setMessages((m) => {
        const arr = [...m]
        const last = arr[arr.length - 1]
        if (last?.role === 'assistant' && last.streaming) {
          arr[arr.length - 1] = {
            ...last,
            role: 'assistant',
            content: withSupportContact('Network error.'),
            low: true,
            streaming: false,
          }
        } else {
          arr.push({ role: 'assistant', content: withSupportContact('Network error.'), low: true, clientId: newClientId() })
        }
        return arr
      })
    } finally {
      setSending(false)
      setThinking(false)
    }
  }

  const branchOpts = scopeRepoId ? (scopeRepos.find((r) => r.id === scopeRepoId)?.branches ?? []) : []
  const activeRepo = scopeRepos.find((r) => r.id === scopeRepoId)
  const totalChunks = scopeRepos.reduce((s, r) => s + r.branches.reduce((b, br) => b + br.chunk_count, 0), 0)

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="absolute inset-0 flex overflow-hidden">

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="w-[228px] flex-shrink-0 flex flex-col bg-[var(--color-surface)] border-r border-[var(--color-border)]">
        <div className="px-4 pt-5 pb-3 flex-shrink-0">
          <p className="text-[10px] font-bold tracking-widest uppercase text-[var(--color-text-tertiary)] mb-3">
            Conversations
          </p>
          <button
            onClick={() => void createThread()}
            className="flex items-center gap-2 w-full rounded-[var(--radius-md)] px-3 py-2.5
              text-[13px] text-[var(--color-text-secondary)] font-medium
              border border-dashed border-[var(--color-border)] hover:border-primary/60 hover:text-primary
              hover:bg-[var(--color-accent-light)] transition-all duration-150"
          >
            <PlusIcon className="h-3.5 w-3.5 flex-shrink-0" />
            Start new chat
          </button>
          {createError && (
            <p className="mt-2 text-[11px] text-red-600 leading-snug">{createError}</p>
          )}
        </div>

        {/* Scope status badge */}
        {(activeRepo || totalChunks > 0) && (
          <div className="mx-3 mb-2 px-2.5 py-2 rounded-[var(--radius-md)] bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
            <div className="flex items-center gap-1.5 mb-0.5">
              <motion.div
                className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                animate={{ scale: [1, 1.4, 1], opacity: [1, 0.6, 1] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              />
              <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
                {totalChunks.toLocaleString()} chunks indexed
              </span>
            </div>
            {activeRepo && (
              <p className="text-[11px] text-[var(--color-text-tertiary)] truncate">
                {activeRepo.name || activeRepo.slug}
                {scopeBranch && <span className="text-[var(--color-text-tertiary)]/70"> · {scopeBranch}</span>}
              </p>
            )}
          </div>
        )}

        {/* Knowledge bases */}
        <div className="px-3 pb-2 flex-shrink-0">
          <DatasetManager activeTenantId={activeTenantId ?? undefined} />
          {ragDatasets.length > 0 && (
            <div className="mt-2">
              <p className="text-[10px] font-bold tracking-widest uppercase text-[var(--color-text-tertiary)] mb-1 px-1">
                Chat with knowledge base
              </p>
              <select
                value={activeRagId}
                onChange={(e) => {
                  setActiveRagId(e.target.value)
                  setMessages([])
                  setActiveRagConvId(null)
                  if (e.target.value) setActiveThread(null)
                }}
                className={`w-full text-[12px] rounded-[var(--radius-md)] border px-2 py-1.5 ${
                  activeRagId
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-900/20 dark:border-emerald-700 dark:text-emerald-300'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)]'
                }`}
              >
                <option value="">— select to query —</option>
                {ragDatasets.length > 1 && <option value="all">All knowledge bases</option>}
                {ragDatasets.map((d) => (
                  <option key={d.datasetId} value={d.datasetId}>{d.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Thread list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {threadsLoading && (
            <div className="px-3 pt-1 space-y-0.5" aria-hidden="true">
              {[60, 80, 45, 70, 55].map((w, i) => (
                <div key={i} className="px-1 py-3 border-b border-[var(--color-border)]/40">
                  <Skeleton className="h-3 mb-2" style={{ width: `${w}%` }} />
                  <Skeleton className="h-2" style={{ width: '40%' }} />
                </div>
              ))}
            </div>
          )}
          {!threadsLoading && threads.length === 0 && (
            <p className="px-4 py-4 text-xs text-[var(--color-text-tertiary)] leading-relaxed">
              No conversations yet.
            </p>
          )}
          {/* RAG conversation history */}
          {ragConversations.length > 0 && (
            <div>
              <p className="px-4 pt-3 pb-1 text-[10px] font-bold tracking-widest uppercase text-[var(--color-text-tertiary)]">
                Knowledge base chats
              </p>
              {ragConversations.map((conv) => {
                const active = conv.id === activeRagConvId
                return (
                  <button
                    key={conv.id}
                    onClick={() => void loadRagConversation(conv)}
                    className={[
                      'group relative w-full text-left px-4 py-2.5 flex items-start gap-2',
                      'transition-colors duration-100 border-b border-[var(--color-border)]/30',
                      active ? 'bg-emerald-50 dark:bg-emerald-900/10' : 'hover:bg-[var(--color-bg-secondary)]',
                    ].join(' ')}
                  >
                    <CircleStackIcon className={`h-3.5 w-3.5 mt-0.5 flex-shrink-0 ${active ? 'text-emerald-600' : 'text-[var(--color-text-tertiary)]'}`} />
                    <div className="flex-1 min-w-0">
                      <p className={`text-[12px] font-medium leading-snug truncate ${active ? 'text-emerald-700 dark:text-emerald-400' : 'text-[var(--color-text-primary)]'}`}>
                        {conv.title ?? 'RAG conversation'}
                      </p>
                      <p className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5 truncate">{conv.dataset_name}</p>
                    </div>
                    <button
                      onClick={(e) => void deleteRagConversation(conv.id, e)}
                      className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-[var(--color-text-tertiary)] hover:text-red-500"
                      aria-label="Delete"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </button>
                )
              })}
            </div>
          )}

          {ragConversations.length > 0 && threads.length > 0 && (
            <p className="px-4 pt-3 pb-1 text-[10px] font-bold tracking-widest uppercase text-[var(--color-text-tertiary)]">
              Conversations
            </p>
          )}

          {threads.map((t) => {
            const active = t.id === activeThread?.id
            return (
              <button
                key={t.id}
                onClick={() => {
                  if (active) return
                  setActiveThread(t)
                  setCreateError(null)
                  const rm = t.response_mode
                  setAssistantMode(rm === 'power' || rm === 'grounded' ? rm : 'grounded')
                }}
                className={[
                  'group relative w-full text-left px-4 py-3 flex items-start gap-2',
                  'transition-colors duration-100 border-b border-[var(--color-border)]/30',
                  active
                    ? 'bg-[var(--color-accent-light)]'
                    : 'hover:bg-[var(--color-bg-secondary)]',
                ].join(' ')}
              >
                {active && (
                  <motion.span
                    layoutId="active-thread-bar"
                    className="absolute left-0 inset-y-1 w-[3px] bg-primary rounded-r"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p className={`text-[13px] font-medium leading-snug truncate ${active ? 'text-primary' : 'text-[var(--color-text-primary)]'}`}>
                    {clip(t.title, 32)}
                  </p>
                  <p className="text-[11px] text-[var(--color-text-tertiary)] mt-0.5">
                    {relativeTime(t.updated_at ?? t.created_at)}
                  </p>
                </div>
                <button
                  onClick={(e) => void removeThread(t.id, e)}
                  className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5 p-0.5 rounded text-[var(--color-text-tertiary)] hover:text-red-500"
                  aria-label="Delete"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </button>
            )
          })}
        </div>
      </aside>

      {/* ── Chat area ───────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 bg-[var(--color-surface)] relative overflow-hidden">

        {/* Loading state */}
        {threadsLoading && (
          <>
            <div className="flex-shrink-0 flex items-center gap-3 px-5 border-b border-[var(--color-border)]" style={{ height: 56 }}>
              <Skeleton className="h-4" style={{ width: 180 }} />
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              <div className="max-w-3xl mx-auto px-6 py-8 space-y-8" aria-hidden="true">
                <div className="flex justify-end"><div className="space-y-1.5" style={{ width: '60%' }}>
                  <Skeleton className="h-4" style={{ width: '85%', marginLeft: 'auto' }} />
                  <Skeleton className="h-4" style={{ width: '60%', marginLeft: 'auto' }} />
                </div></div>
                <div className="flex items-start gap-3">
                  <Skeleton className="h-8 w-8 rounded-full flex-shrink-0" />
                  <div className="flex-1 space-y-2 pt-0.5">
                    <Skeleton className="h-4" style={{ width: '90%' }} />
                    <Skeleton className="h-4" style={{ width: '75%' }} />
                    <Skeleton className="h-4" style={{ width: '55%' }} />
                  </div>
                </div>
              </div>
            </div>
            <div className="flex-shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
              <div className="max-w-3xl mx-auto flex items-end gap-3" aria-hidden>
                <Skeleton className="flex-1 rounded-2xl" style={{ height: 52 }} />
                <Skeleton className="rounded-2xl flex-shrink-0" style={{ height: 52, width: 52 }} />
              </div>
            </div>
          </>
        )}

        {!threadsLoading && (activeThread || activeRagId) ? (
          <>
            {/* Header */}
            <div className="flex-shrink-0 flex items-center gap-3 px-5 border-b border-[var(--color-border)] bg-[var(--color-surface)]/90 backdrop-blur-sm" style={{ height: 56 }}>
              <div className="flex-1 min-w-0">
                {activeRagId ? (
                  <div className="flex items-center gap-2">
                    <CircleStackIcon className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                    <span className="text-[14px] font-semibold text-[var(--color-text-primary)] truncate">
                      {activeRagId === 'all'
                        ? 'All knowledge bases'
                        : (ragDatasets.find((d) => d.datasetId === activeRagId)?.name ?? 'Knowledge base')}
                    </span>
                  </div>
                ) : activeThread && editingTitle ? (
                  <input
                    ref={titleRef}
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={() => void saveTitle()}
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveTitle(); if (e.key === 'Escape') setEditingTitle(false) }}
                    className="text-[14px] font-semibold w-full max-w-sm bg-transparent outline-none border-b border-primary text-[var(--color-text-primary)] pb-px"
                    maxLength={200}
                  />
                ) : activeThread ? (
                  <button
                    onClick={() => { setTitleDraft(activeThread.title ?? ''); setEditingTitle(true); setTimeout(() => titleRef.current?.select(), 20) }}
                    className="text-[14px] font-semibold text-[var(--color-text-primary)] hover:text-primary transition-colors truncate max-w-sm block text-left"
                    title="Click to rename"
                  >
                    {clip(activeThread.title, 55)}
                  </button>
                ) : null}
              </div>

              {/* Scope selects inline */}
              <div className="flex items-center gap-2 flex-shrink-0">
                {/* Knowledge-base selector */}
                <select
                  value={activeRagId}
                  onChange={(e) => { setActiveRagId(e.target.value); setMessages([]); setActiveRagConvId(null) }}
                  className={`text-[12px] rounded-[var(--radius-md)] border px-2 py-1.5 pr-6 ${
                    activeRagId
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-900/20 dark:border-emerald-700 dark:text-emerald-300'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)]'
                  }`}
                  title="Query a knowledge base (RAG) instead of the default codebase assistant"
                >
                  <option value="">Codebase assistant</option>
                  {ragDatasets.length > 1 && <option value="all">All knowledge bases</option>}
                  {ragDatasets.map((d) => (
                    <option key={d.datasetId} value={d.datasetId}>{d.name}</option>
                  ))}
                </select>

                {/* Model selector (RAG mode only) */}
                {activeRagId && (
                  <select
                    value={ragModel}
                    onChange={(e) => setRagModel(e.target.value)}
                    className="text-[12px] rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-1.5 pr-6 bg-[var(--color-surface)] text-[var(--color-text-secondary)]"
                    title="Claude model to use for answering"
                  >
                    <option value="us.anthropic.claude-haiku-4-5-20251001-v1:0">Haiku 4.5 (fast)</option>
                    <option value="us.anthropic.claude-sonnet-4-5-20251001-v1:0">Sonnet 4.5 (balanced)</option>
                    <option value="us.anthropic.claude-sonnet-4-6-20251101-v1:0">Sonnet 4.6 (latest)</option>
                    <option value="us.anthropic.claude-opus-4-7-20251101-v1:0">Opus 4.7 (best quality)</option>
                  </select>
                )}

                {!activeRagId && activeThread && (
                  <>
                    <select
                      value={assistantMode}
                      onChange={(e) => {
                        const mode = e.target.value as AssistantMode
                        setAssistantMode(mode)
                        const t = activeRef.current
                        if (!t) return
                        void authorizedFetch(`/api/assistant/threads/${t.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ response_mode: mode }),
                        })
                          .then(() => {
                            setActiveThread((prev) => (prev ? { ...prev, response_mode: mode } : prev))
                            setThreads((p) => p.map((x) => (x.id === t.id ? { ...x, response_mode: mode } : x)))
                          })
                          .catch(console.error)
                      }}
                      className={`text-[12px] rounded-[var(--radius-md)] border px-2 py-1.5 pr-6 ${
                        assistantMode === 'power'
                          ? 'border-violet-300 bg-violet-50 text-violet-900'
                          : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)]'
                      }`}
                      title={
                        assistantMode === 'power'
                          ? 'Power mode: deeper reasoning and richer answers; may be slower.'
                          : 'Grounded mode: source-anchored answers with stronger citation focus.'
                      }
                    >
                      <option value="grounded">Grounded mode</option>
                      <option value="power">Power mode</option>
                    </select>
                    <select
                      value={scopeRepoId}
                      onChange={(e) => { setScopeRepoId(e.target.value); setScopeBranch('') }}
                      className="text-[12px] rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-1.5 bg-[var(--color-surface)] pr-6 text-[var(--color-text-secondary)] max-w-[150px] truncate"
                    >
                      <option value="">All repos</option>
                      {scopeRepos.map((r) => <option key={r.id} value={r.id}>{r.name || r.slug}</option>)}
                    </select>
                    {scopeRepoId && (
                      <select
                        value={scopeBranch}
                        onChange={(e) => setScopeBranch(e.target.value)}
                        className="text-[12px] rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-1.5 bg-[var(--color-surface)] pr-6 text-[var(--color-text-secondary)] max-w-[120px]"
                      >
                        <option value="">All branches</option>
                        {branchOpts.map((b) => <option key={b.branch} value={b.branch}>{b.branch} ({b.chunk_count.toLocaleString()})</option>)}
                      </select>
                    )}
                    <div className="flex flex-col gap-0.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
                        Answer style
                      </label>
                      <select
                        aria-label="Answer style (persona)"
                        value={activeThread.persona ?? 'pm'}
                        onChange={async (e) => {
                          const persona = e.target.value as Persona
                          setActiveThread((t) => (t ? { ...t, persona } : t))
                          setThreads((p) => p.map((t) => (t.id === activeThread.id ? { ...t, persona } : t)))
                          await authorizedFetch(`/api/assistant/threads/${activeThread.id}`, { method: 'PATCH', body: JSON.stringify({ persona }) }).catch(console.error)
                        }}
                        title="Sets tone and how much technical depth the assistant uses for this conversation."
                        className="text-[12px] rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-1.5 bg-[var(--color-surface)] pr-6 text-[var(--color-text-secondary)]"
                      >
                        {Object.entries(PERSONA_LABELS).map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Messages + optional canvas */}
            <div className="flex-1 flex min-h-0 overflow-hidden">

              {/* Messages scroll area */}
              <div ref={messagesScrollRef} className="flex-1 overflow-y-auto min-h-0 scroll-smooth">
                <div className={`mx-auto px-6 py-8 space-y-8 transition-all duration-300 ${canvas ? 'max-w-2xl' : 'max-w-3xl'}`}>

                  {msgsLoading && (
                    <div
                      className="flex flex-col items-center justify-center py-24 text-center"
                      role="status"
                      aria-live="polite"
                      aria-busy="true"
                    >
                      <motion.div
                        className="h-9 w-9 rounded-full border-2 border-primary/25 border-t-primary mb-4"
                        animate={{ rotate: 360 }}
                        transition={{ duration: 0.75, repeat: Infinity, ease: 'linear' }}
                      />
                      <p className="text-[13px] font-medium text-[var(--color-text-primary)]">Loading conversation…</p>
                      <p className="text-[12px] text-[var(--color-text-tertiary)] mt-1 max-w-xs">
                        Fetching messages for this thread.
                      </p>
                    </div>
                  )}

                  {!msgsLoading && messages.length === 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.4, ease: 'easeOut' }}
                      className="flex flex-col items-center text-center py-16"
                    >
                      <motion.div
                        className="h-14 w-14 rounded-2xl bg-gradient-to-br from-primary/20 to-violet-500/20 flex items-center justify-center mb-5 border border-primary/20"
                        animate={{ scale: [1, 1.04, 1] }}
                        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                      >
                        <SparklesIcon className="h-7 w-7 text-primary" />
                      </motion.div>
                      <h3 className="text-[17px] font-semibold text-[var(--color-text-primary)] mb-2 tracking-tight">
                        Ask your codebase anything
                      </h3>
                      <p className="text-[13.5px] text-[var(--color-text-secondary)] leading-relaxed max-w-[340px] mb-8">
                        Grounded in {totalChunks.toLocaleString()} indexed code chunks. Ask about capabilities, data flow, how features work, or what files to look at.
                      </p>
                      <p className="text-[11.5px] text-[var(--color-text-tertiary)] mb-5">
                        Current response style:{' '}
                        <span className="font-semibold text-[var(--color-text-primary)]">
                          {assistantMode === 'power' ? 'Power mode (deeper, richer)' : 'Grounded mode (citation-first)'}
                        </span>
                      </p>
                      <div className="grid grid-cols-1 gap-2 w-full max-w-md">
                        {STARTERS.map((s, i) => (
                          <motion.button
                            key={s}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.06, duration: 0.3 }}
                            onClick={() => void doSend(s)}
                            className="text-[13px] text-left px-4 py-3 rounded-xl border border-[var(--color-border)]
                              text-[var(--color-text-secondary)] hover:border-primary/60 hover:text-[var(--color-text-primary)] hover:bg-[var(--color-accent-light)]
                              transition-all duration-150 group"
                          >
                            <span className="mr-2 text-[var(--color-text-tertiary)] group-hover:text-primary transition-colors">→</span>
                            {s}
                          </motion.button>
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {messages.map((msg, idx) => (
                    <motion.div
                      key={msg.id ?? msg.clientId ?? `m-${idx}`}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                    >
                      {msg.role === 'user' ? (
                        /* User bubble */
                        <div className="flex justify-end">
                          <div className="max-w-[78%]">
                            <div className="bg-primary text-white rounded-2xl rounded-tr-sm px-4 py-3 text-[14px] leading-[1.65] shadow-sm">
                              <span className="whitespace-pre-wrap">{msg.content}</span>
                            </div>
                          </div>
                        </div>
                      ) : (
                        /* Assistant message */
                        <div className="flex items-start gap-3 pl-1">
                          {/* Avatar with pulse when streaming */}
                          <div className="flex-shrink-0 relative mt-0.5">
                            <motion.div
                              className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-violet-500 text-white flex items-center justify-center shadow-sm"
                              animate={msg.streaming ? { scale: [1, 1.08, 1] } : {}}
                              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                            >
                              <SparklesIcon className="h-4 w-4" />
                            </motion.div>
                            {msg.streaming && (
                              <motion.div
                                className="absolute inset-0 rounded-full border-2 border-primary/40"
                                animate={{ scale: [1, 1.6, 1], opacity: [0.6, 0, 0.6] }}
                                transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                              />
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            {msg.streaming ? (
                              /* Streaming: partial text with cursor */
                              <div className="text-[14px] leading-[1.7] text-[var(--color-text-primary)] whitespace-pre-wrap">
                                {msg.content}
                                <StreamCursor />
                              </div>
                            ) : (
                              /* Completed: full markdown + code highlighting */
                              <AssistantMarkdown content={msg.content} onOpenCanvas={openCodeInline} />
                            )}

                            {/* Low grounding badge */}
                            {msg.role === 'assistant' && msg.low && !msg.streaming && (
                              <div className="mt-3 flex items-center gap-1.5 text-[11.5px] text-amber-700 dark:text-amber-400">
                                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 flex-shrink-0" />
                                Low grounding: verify this against your source before acting.
                              </div>
                            )}

                            {/* Source cards */}
                            {msg.role === 'assistant' && !msg.streaming && msg.sources && msg.sources.length > 0 && (
                              <SourceCards
                                sources={msg.sources}
                                onOpenCodeSnippet={openCodeFromPath}
                                onOpenDocSection={openDocFromId}
                              />
                            )}
                          </div>
                        </div>
                      )}
                    </motion.div>
                  ))}

                  {/* Thinking bubble */}
                  <AnimatePresence>
                    {thinking && (
                      <motion.div
                        key="thinking"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                      >
                        <ThinkingBubble phase={thinkPhase} labelOverride={thinkLabel ?? undefined} />
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div ref={messagesEnd} />
                </div>
              </div>

              {/* ── Canvas panel (code or handbook) ───────────────────────── */}
              <AnimatePresence mode="wait">
                {canvas && (
                  <motion.div
                    key={canvas.kind === 'doc' ? `doc-${canvas.sectionId}` : `code-${canvas.label}`}
                    initial={{ width: 0, opacity: 0 }}
                    animate={{
                      width: canvas.kind === 'doc' ? 460 : 420,
                      opacity: 1,
                    }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
                    className={`flex-shrink-0 border-l border-[var(--color-border)] overflow-hidden ${
                      canvas.kind === 'doc' ? 'bg-[var(--color-bg-secondary)]' : 'bg-[#18181b]'
                    }`}
                    style={{ willChange: 'width' }}
                  >
                    <div
                      className={`h-full flex flex-col ${canvas.kind === 'doc' ? 'w-[460px]' : 'w-[420px]'}`}
                    >
                      {canvas.kind === 'code' ? (
                        <CodeCanvas
                          code={canvas.code}
                          lang={canvas.lang}
                          label={canvas.label}
                          onClose={() => setCanvas(null)}
                        />
                      ) : (
                        <DocCanvas
                          title={canvas.title}
                          category={canvas.category}
                          summary={canvas.summary}
                          body_md={canvas.body_md}
                          loading={canvas.loading}
                          error={canvas.error ?? null}
                          onClose={() => setCanvas(null)}
                        />
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* ── Input bar ───────────────────────────────────────────────── */}
            <div className="flex-shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur-sm px-5 py-4">
              <div className={`mx-auto transition-all duration-300 ${canvas ? 'max-w-2xl' : 'max-w-3xl'}`}>
                <div className="flex items-end gap-3">
                  <div className="flex-1 relative">
                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={(e) => {
                        setInput(e.target.value)
                        e.target.style.height = 'auto'
                        e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doSend(input) }
                      }}
                      placeholder={activeRagId
                        ? 'Ask a question about your indexed knowledge base…'
                        : 'Ask about your codebase: how features work, where logic lives, what data models do…'
                      }
                      rows={1}
                      disabled={sending}
                      className="w-full resize-none rounded-2xl border border-[var(--color-border)] px-4 py-3.5 pr-12
                        text-[14px] leading-[1.55] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)]
                        placeholder:text-[var(--color-text-tertiary)]
                        focus:outline-none focus:border-primary/60 focus:ring-3 focus:ring-primary/10
                        disabled:opacity-50 transition-all duration-150
                        min-h-[52px] max-h-[160px] shadow-sm"
                    />
                  </div>

                  <button
                    onClick={() => void doSend(input)}
                    disabled={sending || !input.trim()}
                    className="flex-shrink-0 h-[52px] w-[52px] rounded-2xl bg-primary text-white flex items-center justify-center
                      hover:opacity-90 active:scale-95 transition-all duration-150 shadow-sm
                      disabled:opacity-35 disabled:cursor-not-allowed disabled:active:scale-100"
                    aria-label="Send"
                  >
                    {sending ? (
                      <motion.div
                        className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white"
                        animate={{ rotate: 360 }}
                        transition={{ duration: 0.7, repeat: Infinity, ease: 'linear' }}
                      />
                    ) : (
                      <PaperAirplaneIcon className="h-5 w-5" />
                    )}
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-[var(--color-text-tertiary)] text-center">
                  <kbd className="px-1 py-0.5 rounded bg-[var(--color-bg-secondary)] border border-[var(--color-border)] font-mono text-[10px]">Enter</kbd>
                  {' '}to send · {' '}
                  <kbd className="px-1 py-0.5 rounded bg-[var(--color-bg-secondary)] border border-[var(--color-border)] font-mono text-[10px]">Shift+Enter</kbd>
                  {' '}for new line
                </p>
              </div>
            </div>
          </>
        ) : !threadsLoading && creatingThread ? (
          <div className="flex-1 flex flex-col items-center justify-center px-10" role="status" aria-live="polite" aria-busy="true">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              className="flex flex-col items-center text-center max-w-sm"
            >
              <motion.div
                className="h-10 w-10 rounded-full border-2 border-primary/25 border-t-primary mb-4"
                animate={{ rotate: 360 }}
                transition={{ duration: 0.75, repeat: Infinity, ease: 'linear' }}
              />
              <p className="text-[15px] font-semibold text-[var(--color-text-primary)]">Creating your conversation…</p>
              <p className="text-[13px] text-[var(--color-text-secondary)] mt-2 leading-relaxed">
                Almost there: you can start typing as soon as this finishes.
              </p>
            </motion.div>
          </div>
        ) : !threadsLoading ? (

          /* ── Welcome state ────────────────────────────────────────────── */
          <div className="flex-1 flex flex-col items-center justify-center px-10">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
              className="w-full max-w-md"
            >
              <motion.div
                className="h-14 w-14 rounded-2xl bg-gradient-to-br from-primary/20 to-violet-500/15 flex items-center justify-center mb-6 border border-primary/15"
                animate={{ scale: [1, 1.04, 1] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              >
                <SparklesIcon className="h-7 w-7 text-primary" />
              </motion.div>

              <h2 className="text-[22px] font-semibold text-[var(--color-text-primary)] mb-2 tracking-tight">
                AutoDoc Assistant
              </h2>
              <p className="text-[14px] text-[var(--color-text-secondary)] leading-relaxed mb-2">
                Your codebase intelligence layer: grounded in {totalChunks > 0 ? <strong>{totalChunks.toLocaleString()} indexed chunks</strong> : 'your synced code'}.
              </p>
              <p className="text-[13px] text-[var(--color-text-tertiary)] leading-relaxed mb-8">
                Ask how features work, where logic lives, what data models exist, how components relate, or whether a change is safe to make.
              </p>

              {createError && (
                <div className="mb-4 px-3 py-2.5 rounded-xl bg-red-50 text-red-700 text-[13px] leading-snug border border-red-200">
                  {createError}
                </div>
              )}

              <button onClick={() => void createThread()} className="pk-btn-primary gap-2 mb-8 w-full sm:w-auto">
                <PlusIcon className="h-4 w-4" />
                Start a conversation
              </button>

              {threads.length > 0 && (
                <div className="mb-8">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-tertiary)] mb-3">Recent</p>
                  <div className="space-y-1">
                    {threads.slice(0, 4).map((t) => (
                      <button
                        key={t.id}
                        onClick={() => { setActiveThread(t); setCreateError(null) }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl
                          border border-[var(--color-border)] hover:border-primary/50 hover:bg-[var(--color-accent-light)]
                          transition-all duration-150 text-left"
                      >
                        <div className="h-1.5 w-1.5 rounded-full bg-primary/30 flex-shrink-0" />
                        <span className="flex-1 text-[13px] text-[var(--color-text-secondary)] truncate">{clip(t.title, 45)}</span>
                        <span className="text-[11px] text-[var(--color-text-tertiary)] flex-shrink-0">{relativeTime(t.updated_at ?? t.created_at)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-tertiary)] mb-3">Try asking</p>
                <div className="space-y-1.5">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      onClick={async () => { pendingMsg.current = s; await createThread() }}
                      className="w-full text-left text-[13px] px-3 py-2.5 rounded-xl
                        border border-[var(--color-border)] text-[var(--color-text-secondary)]
                        hover:border-primary/50 hover:text-[var(--color-text-primary)] hover:bg-[var(--color-accent-light)]
                        transition-all duration-150"
                    >
                      <span className="mr-2 text-[var(--color-text-tertiary)]">→</span>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
