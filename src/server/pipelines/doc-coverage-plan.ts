import { z } from 'zod'
import type { DocContentDepth } from '@/server/plans/org-ai-settings'
import { requireOpenAI } from '@/server/llm/openai-embeddings'
import { buildStratifiedDocCatalog, catalogProfileForDepth } from '@/server/pipelines/doc-generation'

const TopicHintSchema = z.object({
  title_hint: z.string().min(4).max(200),
  why_it_matters: z.string().min(8).max(500),
  archetype_hint: z
    .string()
    .optional()
    .transform((s): 'policy' | 'sop' | 'playbook' | 'feature_brief' | 'any' | undefined => {
      const v = (s ?? '').toLowerCase().trim()
      if (v === 'policy' || v === 'sop' || v === 'playbook' || v === 'any') return v
      if (v === 'feature_brief' || v === 'feature brief' || v === 'brief') return 'feature_brief'
      return undefined
    }),
  priority: z.number().int().min(1).max(3).optional(),
})

const CoveragePlanSchema = z.object({
  executive_summary: z.string().min(20).max(1_800),
  /** What the system actually does for users (ground in excerpts). */
  product_capability_themes: z.array(z.string().min(3).max(320)).max(20),
  /** Who operates it and what jobs-to-be-done look like. */
  user_personas_and_jobs: z.array(z.string().min(3).max(280)).max(14),
  /** Policies / boundaries / governance the excerpts support. */
  policy_focus: z.array(TopicHintSchema).max(18),
  /** Ordered procedures where sequence matters. */
  sop_focus: z.array(TopicHintSchema).max(22),
  /** When-X-then-Y operational scenarios. */
  playbook_focus: z.array(TopicHintSchema).max(22),
  /** Feature- or module-specific angles worth handbook depth. */
  feature_handbook_angles: z.array(TopicHintSchema).max(16),
  /** Buyer / CS / PM-facing capability briefs (maps to doc archetype feature_brief in generation). */
  feature_brief_focus: z
    .array(TopicHintSchema)
    .max(14)
    .nullish()
    .transform((a) => a ?? []),
  /** Questions clients or coordinators would actually ask support / PMs (answerable from code+config). */
  client_question_types: z.array(z.string().min(6).max(360)).max(22),
  /** Cross-cutting risks, sync/async, comms, data integrity — stress in technical narrative. */
  risk_and_integrity_themes: z.array(z.string().min(6).max(300)).max(14),
  /** Honest gaps where excerpts are thin. */
  evidence_gaps: z.array(z.string().min(8).max(400)).max(12),
})

export type DocumentationCoveragePlan = z.infer<typeof CoveragePlanSchema>

export function parseStoredCoveragePlan(raw: unknown): DocumentationCoveragePlan | null {
  const r = CoveragePlanSchema.safeParse(raw)
  return r.success ? r.data : null
}

function pickDocModel(orgOverride?: string | null): string {
  const o = orgOverride?.trim()
  if (o) return o
  return process.env.OPENAI_DOC_GENERATION_MODEL?.trim() || 'gpt-4o'
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function completePlanJson(input: { model: string; system: string; user: string }): Promise<string> {
  const openai = requireOpenAI()
  const maxAttempts = 6
  let last: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await openai.chat.completions.create({
        model: input.model,
        temperature: 0.2,
        max_tokens: 12_288,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
      })
      const raw = res.choices[0]?.message?.content?.trim()
      if (!raw) throw new Error('Coverage planner returned empty output')
      return raw
    } catch (e) {
      last = e
      const msg = e instanceof Error ? e.message : String(e)
      const retryable =
        /rate limit|429|503|502|500|timeout|ETIMEDOUT|ECONNRESET|fetch failed|too many requests|overloaded/i.test(msg)
      if (!retryable || attempt === maxAttempts) {
        throw e instanceof Error ? e : new Error(String(e))
      }
      const delay = Math.min(45_000, 600 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400)
      console.warn(`[doc-coverage-plan] retry ${attempt}/${maxAttempts - 1} in ${delay}ms`)
      await sleep(delay)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

function pathForestSummary(paths: string[], maxLines: number): string {
  const uniq = [...new Set(paths)].sort((a, b) => a.localeCompare(b))
  const byRoot = new Map<string, number>()
  for (const p of uniq) {
    const seg = p.split(/[/\\]/)[0] ?? p
    byRoot.set(seg, (byRoot.get(seg) ?? 0) + 1)
  }
  const roots = [...byRoot.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([k, n]) => `- ${k}/ (${n} files)`)
    .join('\n')
  const sample = uniq.slice(0, maxLines).map((p) => `- ${p}`).join('\n')
  return ['### Path volume by top-level segment', roots, '', '### Sample paths (stratified; not exhaustive)', sample].join('\n')
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '\n…(truncated)…'
}

/** Compact block for handbook batches (canonical slots still apply). */
export function formatCoveragePlanForHandbook(plan: DocumentationCoveragePlan, maxChars = 14_000): string {
  const lines: string[] = [
    plan.executive_summary,
    '',
    '### Capability themes (weave into chapters where evidence exists)',
    ...plan.product_capability_themes.map((t) => `- ${t}`),
    '',
    '### Personas & jobs-to-be-done',
    ...plan.user_personas_and_jobs.map((t) => `- ${t}`),
    '',
    '### Feature / module angles for deeper handbook prose',
    ...plan.feature_handbook_angles.map((x) => `- **${x.title_hint}**: ${x.why_it_matters}`),
    '',
    '### Risk, integrity, coupling (surface in Relationships & Edge Cases sections)',
    ...plan.risk_and_integrity_themes.map((t) => `- ${t}`),
    '',
    '### Client-style questions the handbook should implicitly answer',
    ...plan.client_question_types.map((t) => `- ${t}`),
  ]
  if (plan.feature_brief_focus.length) {
    lines.push(
      '',
      '### Capability angles that also deserve buyer/CS-facing briefs (not trivial UI)',
      ...plan.feature_brief_focus.map((x) => `- **${x.title_hint}**: ${x.why_it_matters}`)
    )
  }
  if (plan.evidence_gaps.length) {
    lines.push('', '### Evidence gaps (call out honestly; do not invent)', ...plan.evidence_gaps.map((t) => `- ${t}`))
  }
  const out = lines.join('\n')
  return truncate(out, maxChars)
}

/** Compact block for operational inventory (policies, SOPs, playbooks). */
export function formatCoveragePlanForOps(plan: DocumentationCoveragePlan, maxChars = 12_000): string {
  const lines: string[] = [
    plan.executive_summary,
    '',
    '### Prioritize policies that match these angles',
    ...plan.policy_focus.map((x) => `- **${x.title_hint}** (p${x.priority ?? 2}): ${x.why_it_matters}`),
    '',
    '### Prioritize SOPs for these workflows',
    ...plan.sop_focus.map((x) => `- **${x.title_hint}** (p${x.priority ?? 2}): ${x.why_it_matters}`),
    '',
    '### Prioritize playbooks for these scenarios',
    ...plan.playbook_focus.map((x) => `- **${x.title_hint}** (p${x.priority ?? 2}): ${x.why_it_matters}`),
    '',
    '### Prioritize feature_brief artifacts (commercially material capabilities only)',
    ...plan.feature_brief_focus.map((x) => `- **${x.title_hint}** (p${x.priority ?? 2}): ${x.why_it_matters}`),
    '',
    '### Client / coordinator question types to cover with grounded articles',
    ...plan.client_question_types.map((t) => `- ${t}`),
    '',
    '### Capability themes (tie artifacts to real product behavior)',
    ...plan.product_capability_themes.map((t) => `- ${t}`),
  ]
  if (plan.evidence_gaps.length) {
    lines.push('', '### Where excerpts are thin (fewer or narrower artifacts)', ...plan.evidence_gaps.map((t) => `- ${t}`))
  }
  const out = lines.join('\n')
  return truncate(out, maxChars)
}

const PLANNER_SYSTEM = [
  'You are a principal product+engineering analyst planning documentation coverage for a real codebase.',
  'You receive: (1) stratified SOURCE EXCERPTS from the repo, (2) optional repository overview text, (3) a path listing.',
  'Infer actual product behavior, operational workflows, configuration surfaces, integrations, and failure modes.',
  'Output valid JSON ONLY matching the schema described in the user message.',
  'Ground every theme in what excerpts or overview plausibly support; use "evidence_gaps" where the corpus is silent.',
  'Think like a programme lead and a GTM lead: what policies, SOPs, playbooks, AND buyer-facing capability briefs would help win and retain clients?',
  'Distinguish: policy (rules/boundaries), sop (ordered steps), playbook (scenario branches), feature_handbook_angles (engineering narrative), feature_brief_focus (commercial / CS-ready capability stories grounded in product behavior—not cosmetics).',
  'title_hint values must be concrete and narrow (not generic like "General overview").',
].join('\n')

export type BuildCoveragePlanInput = {
  workspaceId: string
  workspaceName: string
  repositoryName: string
  rawChunks: { path: string; text: string }[]
  corpusSampled: boolean
  totalChunkRowsScanned: number
  model?: string | null
  targetAudience: string
  contentDepth: DocContentDepth
  codewiki?: { digest: string; styleNote: string; completedAt: string | null } | null
  shouldAbort?: () => boolean
  onProgress?: (message: string) => void
}

/**
 * One structured LLM pass over the corpus (+ optional CodeWiki) to steer handbook + operational doc inventory.
 * Returns null if aborted, too few chunks, or validation fails (caller continues without a plan block).
 */
export async function buildDocumentationCoveragePlan(
  input: BuildCoveragePlanInput
): Promise<DocumentationCoveragePlan | null> {
  if (input.rawChunks.length < 24) {
    input.onProgress?.('Coverage plan skipped: not enough chunks for a reliable plan.')
    return null
  }
  if (input.shouldAbort?.()) return null

  const profile = catalogProfileForDepth(input.contentDepth)
  const maxExcerpts = Math.min(
    profile.excerptCap,
    Math.max(96, Math.floor(input.rawChunks.length / profile.chunkDiv) + profile.chunkBias)
  )
  const { catalog, excerptPaths } = buildStratifiedDocCatalog(input.rawChunks, {
    maxExcerpts,
    maxCharsPerExcerpt: Math.min(profile.maxCharsPerExcerpt, 3_200),
    maxCatalogChars: Math.min(profile.maxCatalogChars, 120_000),
  })

  if (excerptPaths.size < 6 || catalog.length < 500) {
    input.onProgress?.('Coverage plan skipped: excerpt signal too thin.')
    return null
  }

  const model = pickDocModel(input.model)
  const cw = input.codewiki
  const codewikiBlock = cw
    ? `\n--- REPOSITORY OVERVIEW (non-authoritative vs excerpts) ---\n${cw.styleNote}\n\n${truncate(cw.digest, 22_000)}\n`
    : ''

  const pathSummary = pathForestSummary(
    input.rawChunks.map((c) => c.path),
    120
  )

  const coverageNote =
    input.corpusSampled && input.totalChunkRowsScanned != null
      ? `Corpus was row-capped; scanned ~${input.totalChunkRowsScanned} chunk rows.`
      : 'Full corpus sample within caps.'

  const schemaHint = `{
  "executive_summary": "string",
  "product_capability_themes": ["string", ...],
  "user_personas_and_jobs": ["string", ...],
  "policy_focus": [{"title_hint":"string","why_it_matters":"string","archetype_hint":"policy|sop|playbook|any","priority":1}],
  "sop_focus": [{"title_hint":"string","why_it_matters":"string","priority":2}],
  "playbook_focus": [{"title_hint":"string","why_it_matters":"string","priority":2}],
  "feature_handbook_angles": [{"title_hint":"string","why_it_matters":"string"}],
  "feature_brief_focus": [{"title_hint":"string","why_it_matters":"string","priority":2}],
  "client_question_types": ["string", ...],
  "risk_and_integrity_themes": ["string", ...],
  "evidence_gaps": ["string", ...]
}`

  const user = [
    `Workspace: ${input.workspaceName} (${input.workspaceId})`,
    `Product / repo label: ${input.repositoryName}`,
    `Primary audience for docs: ${input.targetAudience}`,
    coverageNote,
    '',
    '### Path / module signal',
    pathSummary,
    '',
    '--- SOURCE EXCERPTS (authoritative for facts) ---',
    '',
    catalog,
    codewikiBlock,
    '',
    'Return JSON only with this top-level shape:',
    schemaHint,
    '',
    'Fill arrays generously when evidence supports it; keep strings specific to THIS codebase.',
  ].join('\n')

  input.onProgress?.(`Coverage plan · model ${model} · ${excerptPaths.size} paths in excerpt set…`)
  if (input.shouldAbort?.()) return null

  try {
    const raw = await completePlanJson({
      model,
      system: PLANNER_SYSTEM,
      user,
    })
    const parsed: unknown = JSON.parse(raw)
    const validated = CoveragePlanSchema.safeParse(parsed)
    if (!validated.success) {
      input.onProgress?.(`Coverage plan validation failed (${validated.error.message}); continuing without plan.`)
      return null
    }
    input.onProgress?.('Coverage plan ready (handbook + operational inventory will follow this strategy).')
    return validated.data
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    input.onProgress?.(`Coverage plan skipped (${msg.slice(0, 200)}).`)
    return null
  }
}
