import type { BillingPlan } from '@/server/plans/catalog'

/** Persona / reading level for generated documentation sections. */
export type DocContentDepth = 'overview' | 'standard' | 'deep'

/** Raw JSON stored on pk_workspaces.org_ai_settings (partial overrides). */
export type OrgAiSettingsStored = {
  embedding_model?: string
  rag_standard_model?: string
  rag_premium_model?: string
  /** Monthly cap for premium query-time model; null/omit uses plan default. */
  premium_rag_monthly_cap?: number | null
  doc_generation_model?: string
  force_standard_rag_only?: boolean
  skip_minified?: boolean
  ingest_max_file_bytes?: number
  ingest_file_batch_size?: number
  ingest_request_delay_ms?: number
  /** 0 or omit = unlimited */
  ingest_max_files?: number | null
  doc_max_chunk_rows?: number
  /** Default audience label for persona documentation (doc jobs can override per run in job meta). */
  doc_target_audience?: string | null
  /** Default depth for persona documentation. */
  doc_content_depth?: DocContentDepth | null
  /** Freeform tone / brand rules injected into handbook generation (max ~2k chars). */
  handbook_voice?: string | null
  /** When false, skip the optional third LLM pass (2–4 “Deep dive” sections). Core 16 sections always run. */
  handbook_depth_pass?: boolean | null
}

export type ResolvedOrgAiSettings = {
  embedding_model: string
  rag_standard_model: string
  rag_premium_model: string
  premium_rag_monthly_cap: number
  doc_generation_model: string
  force_standard_rag_only: boolean
  skip_minified: boolean
  ingest_max_file_bytes: number
  ingest_file_batch_size: number
  ingest_request_delay_ms: number
  ingest_max_files: number
  doc_max_chunk_rows: number
  doc_target_audience: string
  doc_content_depth: DocContentDepth
  handbook_voice: string
  handbook_depth_pass: boolean
}

const ALLOWED_EMBEDDING_MODELS = new Set(['text-embedding-3-small', 'text-embedding-ada-002'])

const ALLOWED_CHAT_MODELS = new Set([
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4o-2024-11-20',
  'gpt-4o-2024-08-06',
  'gpt-4.5-preview',
  'o1',
  'o1-mini',
  'o3-mini',
  'gpt-4-turbo',
  'gpt-4-turbo-preview',
  'gpt-3.5-turbo',
])

export function sanitizeEmbeddingModel(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null
  const t = raw.trim()
  return ALLOWED_EMBEDDING_MODELS.has(t) ? t : null
}

export function sanitizeChatModel(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null
  const t = raw.trim()
  return ALLOWED_CHAT_MODELS.has(t) ? t : null
}

const DOC_DEPTH_SET = new Set<DocContentDepth>(['overview', 'standard', 'deep'])

export function sanitizeDocContentDepth(raw: string | undefined | null): DocContentDepth | null {
  if (!raw || typeof raw !== 'string') return null
  const t = raw.trim().toLowerCase()
  return DOC_DEPTH_SET.has(t as DocContentDepth) ? (t as DocContentDepth) : null
}

/** Single-line audience label; null if invalid or empty. */
export function sanitizeDocTargetAudience(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null
  const t = raw.replace(/[\r\n]+/g, ' ').trim()
  if (!t) return null
  if (t.length > 180) return `${t.slice(0, 177)}...`
  return t
}

function planDefaults(plan: BillingPlan): ResolvedOrgAiSettings {
  const common: Omit<ResolvedOrgAiSettings, 'premium_rag_monthly_cap' | 'doc_generation_model'> = {
    embedding_model: 'text-embedding-3-small',
    rag_standard_model: 'gpt-4o-mini',
    rag_premium_model: 'gpt-4o',
    force_standard_rag_only: false,
    skip_minified: true,
    ingest_max_file_bytes: 8 * 1024 * 1024,
    ingest_file_batch_size: 25,
    ingest_request_delay_ms: 0,
    ingest_max_files: Number.MAX_SAFE_INTEGER,
    doc_max_chunk_rows: 120_000,
    doc_target_audience:
      'New engineers, product managers, and technical leadership (CTO / senior staff) onboarding to this codebase',
    doc_content_depth: 'deep',
    handbook_voice: '',
    handbook_depth_pass: true,
  }
  switch (plan) {
    case 'enterprise':
      return { ...common, premium_rag_monthly_cap: 8000, doc_generation_model: 'gpt-4o' }
    case 'professional':
      return { ...common, premium_rag_monthly_cap: 800, doc_generation_model: 'gpt-4o' }
    case 'standard':
    default:
      return { ...common, premium_rag_monthly_cap: 100, doc_generation_model: 'gpt-4o' }
  }
}

function parseStored(raw: unknown): OrgAiSettingsStored {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as OrgAiSettingsStored
}

export function resolveOrgAiSettings(plan: BillingPlan, org_ai_settings: unknown): ResolvedOrgAiSettings {
  const d = planDefaults(plan)
  const s = parseStored(org_ai_settings)

  const emb = sanitizeEmbeddingModel(s.embedding_model) ?? d.embedding_model
  const ragStd = sanitizeChatModel(s.rag_standard_model) ?? d.rag_standard_model
  const ragPrem = sanitizeChatModel(s.rag_premium_model) ?? d.rag_premium_model
  const docM = sanitizeChatModel(s.doc_generation_model) ?? d.doc_generation_model

  let cap = d.premium_rag_monthly_cap
  if (s.premium_rag_monthly_cap !== undefined && s.premium_rag_monthly_cap !== null) {
    const n = Number(s.premium_rag_monthly_cap)
    if (Number.isFinite(n) && n >= 0) {
      cap = Math.min(1_000_000, Math.floor(n))
    }
  }

  const forceStandard = s.force_standard_rag_only === true

  const skipMinified = s.skip_minified === false ? false : d.skip_minified

  let maxBytes = d.ingest_max_file_bytes
  if (s.ingest_max_file_bytes !== undefined) {
    const n = Number(s.ingest_max_file_bytes)
    if (Number.isFinite(n) && n >= 64 * 1024) {
      maxBytes = Math.min(50 * 1024 * 1024, Math.floor(n))
    }
  }

  let batch = d.ingest_file_batch_size
  if (s.ingest_file_batch_size !== undefined) {
    const n = Number(s.ingest_file_batch_size)
    if (Number.isFinite(n)) batch = Math.max(5, Math.min(200, Math.floor(n)))
  }

  let delay = d.ingest_request_delay_ms
  if (s.ingest_request_delay_ms !== undefined) {
    const n = Number(s.ingest_request_delay_ms)
    if (Number.isFinite(n)) delay = Math.max(0, Math.min(5000, Math.floor(n)))
  }

  let maxFiles = d.ingest_max_files
  if (s.ingest_max_files !== undefined && s.ingest_max_files !== null) {
    const n = Number(s.ingest_max_files)
    if (Number.isFinite(n) && n > 0) maxFiles = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(n))
  }

  let docChunks = d.doc_max_chunk_rows
  if (s.doc_max_chunk_rows !== undefined) {
    const n = Number(s.doc_max_chunk_rows)
    if (Number.isFinite(n) && n >= 1000) docChunks = Math.min(2_000_000, Math.floor(n))
  }

  let docAudience = d.doc_target_audience
  if (s.doc_target_audience !== undefined && s.doc_target_audience !== null) {
    const a = sanitizeDocTargetAudience(String(s.doc_target_audience))
    if (a) docAudience = a
  }

  let docDepth = d.doc_content_depth
  if (s.doc_content_depth !== undefined && s.doc_content_depth !== null) {
    const dep = sanitizeDocContentDepth(String(s.doc_content_depth))
    if (dep) docDepth = dep
  }

  let handbookVoice = d.handbook_voice
  if (s.handbook_voice === null) handbookVoice = ''
  else if (typeof s.handbook_voice === 'string') {
    handbookVoice = s.handbook_voice.replace(/\s+/g, ' ').trim().slice(0, 2000)
  }

  let handbookDepthPass = d.handbook_depth_pass
  if (s.handbook_depth_pass === null) handbookDepthPass = d.handbook_depth_pass
  if (s.handbook_depth_pass === false) handbookDepthPass = false
  if (s.handbook_depth_pass === true) handbookDepthPass = true

  return {
    embedding_model: emb,
    rag_standard_model: ragStd,
    rag_premium_model: ragPrem,
    premium_rag_monthly_cap: cap,
    doc_generation_model: docM,
    force_standard_rag_only: forceStandard,
    skip_minified: skipMinified,
    ingest_max_file_bytes: maxBytes,
    ingest_file_batch_size: batch,
    ingest_request_delay_ms: delay,
    ingest_max_files: maxFiles,
    doc_max_chunk_rows: docChunks,
    doc_target_audience: docAudience,
    doc_content_depth: docDepth,
    handbook_voice: handbookVoice,
    handbook_depth_pass: handbookDepthPass,
  }
}

export function parseBillingPlanForAi(raw: string | null | undefined): BillingPlan {
  if (raw === 'professional' || raw === 'enterprise' || raw === 'standard') return raw
  return 'standard'
}

const PATCH_KEYS = [
  'embedding_model',
  'rag_standard_model',
  'rag_premium_model',
  'premium_rag_monthly_cap',
  'doc_generation_model',
  'force_standard_rag_only',
  'skip_minified',
  'ingest_max_file_bytes',
  'ingest_file_batch_size',
  'ingest_request_delay_ms',
  'ingest_max_files',
  'doc_max_chunk_rows',
  'doc_target_audience',
  'doc_content_depth',
  'handbook_voice',
  'handbook_depth_pass',
] as const

export function mergeOrgAiSettingsPatch(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...existing }
  for (const k of PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      const v = patch[k]
      if (v === undefined) continue
      if (v === null) {
        delete out[k]
      } else {
        out[k] = v
      }
    }
  }
  return out
}
