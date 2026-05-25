import { z } from 'zod'
import type { DocContentDepth } from '@/server/plans/org-ai-settings'
import type { DocSectionCategory } from '@/types/product-knowledge'
import { JobAbortRequestedError, JobPauseRequestedError } from '@/server/pipelines/job-abort'
import { requireOpenAI } from '@/server/llm/openai-embeddings'
import { buildStratifiedDocCatalog, catalogProfileForDepth } from '@/server/pipelines/doc-generation'
import { DEFAULT_HANDBOOK_VOICE } from '@/server/docs/handbook-default-voice'
import { HANDBOOK_QUALITY, isEvidenceGapSection, pathLikeBacktickSpans } from '@/server/docs/handbook-quality'

export type OpsDocArchetype = 'policy' | 'sop' | 'playbook' | 'feature_brief'

export interface GeneratedOpsDocSection {
  archetype: OpsDocArchetype
  category: DocSectionCategory
  title: string
  summary: string
  bodyMd: string
  sourcePaths: string[]
}

/** One catalog LLM response must stay within ~16k completion tokens; large batches truncate JSON. */
const OPS_CATALOG_BATCH_MAX = 45

const CatalogArtifactSchema = z.object({
  archetype: z.preprocess((val) => {
    if (typeof val !== 'string') return val
    const s = val.trim().toLowerCase()
    if (s === 'policies') return 'policy'
    if (s === 'sops' || s === 'procedure' || s === 'procedures') return 'sop'
    if (s === 'playbooks') return 'playbook'
    if (s === 'feature_brief' || s === 'feature brief' || s === 'featurebrief' || s === 'capability_brief' || s === 'brief')
      return 'feature_brief'
    return s
  }, z.enum(['policy', 'sop', 'playbook', 'feature_brief'])),
  title: z.string().min(12).max(220),
  summary: z.string().min(1).max(600),
  grounding_rationale: z.string().min(1).max(900),
  anchor_paths: z.array(z.string()).min(2).max(50),
})

/** Model may return many rows across multiple catalog passes; we trim and dedupe before generation. */
const CatalogPayloadSchema = z.object({
  artifacts: z.array(CatalogArtifactSchema).max(OPS_CATALOG_BATCH_MAX),
})

export type OpsArtifactPlan = z.infer<typeof CatalogArtifactSchema>

const OneDocSchema = z.object({
  summary: z.string().min(80).max(1_200),
  body_md: z.string().min(1).max(40_000),
  source_paths: z.array(z.string()).min(2).max(120),
})

/** Default max operational articles per doc job (hard upper bound 250). Override with AUTODOC_OPS_MAX_ARTIFACTS. */
const OPS_MAX_TOTAL_DEFAULT = 200

function readOpsMaxTotal(): number {
  const raw = process.env.AUTODOC_OPS_MAX_ARTIFACTS?.trim()
  if (!raw) return OPS_MAX_TOTAL_DEFAULT
  const n = Number.parseInt(raw, 10)
  if (Number.isFinite(n) && n >= 12 && n <= 250) return n
  return OPS_MAX_TOTAL_DEFAULT
}

/** Per-archetype ceilings before global trim (generous for client-scale coverage). */
const OPS_CAPS = { policy: 48, sop: 82, playbook: 82, feature_brief: 36 } as const

export function normalizeOpsArtifactTitleKey(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function pickDocModel(orgOverride?: string | null): string {
  const o = orgOverride?.trim()
  if (o) return o
  return process.env.OPENAI_DOC_GENERATION_MODEL?.trim() || 'gpt-4o'
}

function opsDepthLine(depth: DocContentDepth): string {
  switch (depth) {
    case 'overview':
      return 'Length: still handbook-grade—every ## section complete; prefer dense bullets and tables; target article length comparable to a compressed handbook chapter when evidence exists.'
    case 'deep':
      return 'Length: match handbook DEEP mode—multiple ### subsections per ##, extended scenarios, explicit failure chains, every surfaced knob with business consequence; maximize body_md within JSON limits when excerpts support it.'
    case 'standard':
    default:
      return 'Length: match handbook STANDARD mode—each article should feel like a standalone handbook-quality chapter for programme managers: long prose, numbered procedures, rich tables, and explicit evidence ties.'
  }
}

function voiceBlock(workspaceName: string, handbookVoice: string | null | undefined): string {
  const voice = handbookVoice?.trim() || DEFAULT_HANDBOOK_VOICE
  return [
    'Organization name: **' + workspaceName + '**.',
    '',
    'Voice and tone (follow closely):',
    voice,
    '',
    'Additional tone for these documents:',
    '- Write for operations, programme managers, coordinators, and (for feature_brief) sales and customer-success readers.',
    '- Prefer plain language, short paragraphs, and numbered steps where order matters.',
    '- Cite real repository paths in backticks only when they appear in SOURCE EXCERPTS; never invent paths.',
    '- Do not mention CodeWiki, embeddings, RAG, or the model.',
    '- When uncertain, add a short ## Evidence gap section in plain language.',
  ].join('\n')
}

async function completeJson(input: {
  model: string
  system: string
  user: string
  maxTokens?: number
}): Promise<string> {
  const openai = requireOpenAI()
  const res = await openai.chat.completions.create({
    model: input.model,
    temperature: 0.25,
    max_tokens: input.maxTokens ?? 12_288,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
  })
  const raw = res.choices[0]?.message?.content?.trim()
  if (!raw) throw new Error('Operations documentation model returned empty output')
  return raw
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function completeJsonWithRetry(input: Parameters<typeof completeJson>[0]): Promise<string> {
  const maxAttempts = 8
  let last: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await completeJson(input)
    } catch (e) {
      last = e
      const msg = e instanceof Error ? e.message : String(e)
      const retryable =
        /rate limit|429|503|502|500|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|ENOTFOUND|network|socket|TLS|too many requests|overloaded|abort|closed/i.test(
          msg
        )
      if (!retryable || attempt === maxAttempts) {
        throw e instanceof Error ? e : new Error(String(e))
      }
      const delay = Math.min(60_000, 800 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400)
      console.warn(`[ops-doc] chat completion retry ${attempt}/${maxAttempts - 1} in ${delay}ms (${msg.slice(0, 140)})`)
      await sleep(delay)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

function knownPathsSet(chunks: { path: string; text: string }[]): Set<string> {
  return new Set(chunks.map((c) => c.path))
}

function filterAnchorPaths(paths: string[], valid: Set<string>): string[] {
  const out: string[] = []
  for (const p of paths) {
    if (valid.has(p) && !out.includes(p)) out.push(p)
  }
  return out
}

function buildFocusedCatalog(
  chunks: { path: string; text: string }[],
  preferredPaths: string[],
  profile: ReturnType<typeof catalogProfileForDepth>
): string {
  const valid = knownPathsSet(chunks)
  const want = new Set(preferredPaths.filter((p) => valid.has(p)))
  const ordered: { path: string; text: string }[] = []
  for (const p of want) {
    for (const c of chunks) {
      if (c.path === p) {
        ordered.push({ path: c.path, text: c.text })
        break
      }
    }
  }
  for (const c of chunks) {
    if (ordered.length >= profile.excerptCap) break
    if (!want.has(c.path)) ordered.push(c)
  }
  const { catalog } = buildStratifiedDocCatalog(ordered.slice(0, Math.min(ordered.length, chunks.length)), {
    maxExcerpts: Math.min(profile.excerptCap, Math.max(96, ordered.length)),
    maxCharsPerExcerpt: profile.maxCharsPerExcerpt,
    maxCatalogChars: profile.maxCatalogChars,
  })
  if (catalog.length >= 200) return catalog
  return buildStratifiedDocCatalog(chunks, {
    maxExcerpts: profile.excerptCap,
    maxCharsPerExcerpt: profile.maxCharsPerExcerpt,
    maxCatalogChars: profile.maxCatalogChars,
  }).catalog
}

function categoryForArchetype(a: OpsDocArchetype): DocSectionCategory {
  switch (a) {
    case 'policy':
      return 'operations_policy'
    case 'sop':
      return 'operations_sop'
    case 'playbook':
      return 'operations_playbook'
    case 'feature_brief':
      return 'operations_feature_brief'
  }
}

const OPS_FLUFF_RE = /\b(lorem ipsum|todo:|tbd\b|as an ai language model)\b/i

/**
 * Operational articles use the same *spirit* of evidence and depth as the handbook:
 * long structured bodies, business-outcome summaries, and path discipline.
 * Overview depth uses slightly lower floors; optional Evidence gap sections stay shorter.
 */
function validateGeneratedDoc(
  archetype: OpsDocArchetype,
  title: string,
  summary: string,
  body: string,
  paths: string[],
  validPaths: Set<string>,
  depth: DocContentDepth
): string[] {
  const errs: string[] = []
  const tag = `[${archetype}] `
  const gap = isEvidenceGapSection(body, title)

  const minSummary = gap ? 80 : depth === 'overview' ? 80 : HANDBOOK_QUALITY.minSummaryLength
  if (summary.trim().length < minSummary) {
    errs.push(
      tag +
        `summary too thin (min ${minSummary} chars)—state a concrete business outcome, not a generic blurb (same bar as the engineering handbook).`
    )
  }

  if (title.trim().length < HANDBOOK_QUALITY.minTitleLength) {
    errs.push(tag + `title too short or generic (min ${HANDBOOK_QUALITY.minTitleLength} chars).`)
  }

  if (OPS_FLUFF_RE.test(body) || OPS_FLUFF_RE.test(summary)) {
    errs.push(tag + 'remove placeholder / disallowed phrasing')
  }

  const minBodySubstantive =
    depth === 'deep'
      ? HANDBOOK_QUALITY.minBodyCharsSubstantive + 500
      : depth === 'overview'
        ? 960
        : HANDBOOK_QUALITY.minBodyCharsSubstantive
  const minBody = gap ? HANDBOOK_QUALITY.minBodyCharsEvidenceGap : minBodySubstantive
  if (body.trim().length < minBody) {
    errs.push(
      tag +
        `body_md shorter than ${minBody} chars—expand every ## section from the template, add ### subsections, tables, and numbered steps until it reads like a handbook chapter (currently ${body.trim().length}).`
    )
  }

  const minSourcePaths = gap ? 2 : depth === 'overview' ? 2 : Math.max(3, HANDBOOK_QUALITY.minSourcePathsSubstantive)
  if (paths.length < minSourcePaths) {
    errs.push(
      tag + `need at least ${minSourcePaths} grounded source_paths from excerpts (found ${paths.length}).`
    )
  }

  const bad = paths.filter((p) => !validPaths.has(p))
  if (bad.length) {
    errs.push(tag + `source_paths contain paths not in excerpts: ${bad.slice(0, 3).join(', ')}`)
  }

  if (!gap) {
    const ticks = (body.match(/`/g) ?? []).length
    if (ticks < HANDBOOK_QUALITY.minInlineBacktickChars) {
      errs.push(
        tag +
          `need more inline \`path/to/file\` citations (≥${HANDBOOK_QUALITY.minInlineBacktickChars} backtick characters total in body_md).`
      )
    }
    const pathSpans = pathLikeBacktickSpans(body)
    const minSpans = depth === 'overview' ? 2 : HANDBOOK_QUALITY.minPathLikeBacktickSpans
    if (pathSpans < minSpans) {
      errs.push(
        tag +
          `need ≥${minSpans} path-like \`dir/file.ext\` citations in body (found ${pathSpans})—match handbook path discipline.`
      )
    }
  }

  return errs
}

/** Ensure enough grounded paths for QA when the model returns fewer than 4. */
function padSourcePathsToMinimum(
  paths: string[],
  anchors: string[],
  validPaths: Set<string>,
  min: number
): string[] {
  const out = [...new Set(paths.filter((p) => validPaths.has(p)))]
  for (const p of anchors) {
    if (out.length >= min) break
    if (validPaths.has(p) && !out.includes(p)) out.push(p)
  }
  return out
}

const CATALOG_SYSTEM = [
  'You inventory documentation for programme managers, coordinators, sales, and customer success (NOT low-level engineering handbooks).',
  'When the user message includes DOCUMENTATION COVERAGE STRATEGY, use it to prioritize titles and archetypes—still every artifact must be grounded in SOURCE EXCERPTS below.',
  'Goal: many DISTINCT, commercially and operationally MATERIAL artifacts—only what excerpts plausibly support.',
  'Output valid JSON ONLY: {"artifacts":[{"archetype":"policy|sop|playbook|feature_brief","title":"...","summary":"...","grounding_rationale":"...","anchor_paths":["path1","path2",...]}]}',
  'Use archetype exactly one of: policy, sop, playbook, feature_brief (lowercase).',
  'THIS RESPONSE: propose at most ' +
    String(OPS_CATALOG_BATCH_MAX) +
    ' artifacts—narrow titles, one topic each; other passes may add more.',
  'policy = triage/intake, boundaries, definitions, cadence, timing bands, governance.',
  'sop = ordered workflows where sequence matters (e.g. cancellations, approvals, comms).',
  'playbook = when-X-then-Y scenarios (e.g. change date, change speaker, onsite to virtual).',
  'feature_brief = buyer/CS/PM-facing capability story for a PRODUCT DOMAIN or revenue-impacting workflow: problem, who it helps, outcomes/metrics, scope/limits, FAQs, dependencies—grounded in behavior described in excerpts.',
  'STRICT EXCLUSIONS (do not create artifacts for these unless excerpts prove revenue, compliance, accessibility law, or major customer-facing risk): color pickers, font stacks, theme tokens, banner aesthetics, icon swaps, spacing tweaks, purely internal refactors, dev-only tooling, or "nice to have" UI polish.',
  'Prefer NARROW titles—one focused topic per artifact (split broad themes into multiple artifacts).',
  'Every artifact MUST cite at least 2 anchor_paths that appear VERBATIM in excerpts.',
  'Do NOT invent processes not hinted in excerpts; DO enumerate every distinct surfaced workflow you can ground.',
  'If excerpts mention events, registration, speakers, venues, email/notification, sync jobs, tickets, billing, roles, or SLAs—surface separate artifacts per distinct pattern.',
].join('\n')

function catalogUser(params: {
  repositoryName: string
  workspaceId: string
  uniquePaths: number
  coverageNote: string
  catalog: string
  /** Second pass: avoid duplicating these titles. */
  excludeTitles?: string[]
  strategyBlock?: string | null
}): string {
  const ex =
    params.excludeTitles && params.excludeTitles.length > 0
      ? [
          '',
          'Already planned titles (do NOT duplicate or trivially rephrase):',
          params.excludeTitles.slice(0, 200).join(' | '),
        ].join('\n')
      : ''
  const strat =
    params.strategyBlock && params.strategyBlock.trim().length > 0
      ? [
          '',
          '--- DOCUMENTATION COVERAGE STRATEGY (prioritize; excerpts remain authoritative) ---',
          '',
          params.strategyBlock.trim(),
        ].join('\n')
      : ''
  return [
    'Product / repo label: ' + params.repositoryName,
    'Workspace id: ' + params.workspaceId,
    'Unique paths in excerpts: ' + String(params.uniquePaths),
    params.coverageNote,
    ex,
    strat,
    '',
    '--- SOURCE EXCERPTS ---',
    '',
    params.catalog,
    '',
    'Return JSON only. In this response propose up to ' +
      String(OPS_CATALOG_BATCH_MAX) +
      ' grounded artifacts—each row one narrow doc.',
    'When excerpts support many topics, fill this batch; omit only what you cannot ground.',
  ].join('\n')
}

const POLICY_WRITER = [
  'Write one policy / operating model in markdown (stored in JSON field body_md).',
  'Audience: programme managers, service leads, coordinators (not engineers).',
  'Mirror internal client docs: calm, direct, no jargon.',
  'Use ## headings in order: Purpose and who this is for; How we decide what to do when (decision gates, if-yes/if-no); Cadence and forums; Intake and channels; What we do not do; Definitions and promotion criteria; How we communicate timing (Now / Next / Later style); Evidence and source files.',
  'Under EACH ## heading write dense prose or bullet lists (not one-liners): every section should feel as substantive as a handbook chapter section.',
  'Use bullet questions for gates; cite real fields or statuses from excerpts when they exist.',
  'Cite many repository paths in backticks from excerpts only; long, paste-into-Confluence prose.',
].join('\n')

const SOP_WRITER = [
  'Write one standard operating procedure in markdown (body_md in JSON).',
  'Audience: coordinators and PMs executing sensitive workflows.',
  'Sections: Overview (why order matters); Preconditions; The procedure as numbered phases (1, 2, 3) each with Required actions, In the product, Verify before leaving, and Warnings where comms must not be out of order; Key reminders; optional Evidence gap.',
  'Each phase must include multiple sentences or bullet clusters—depth comparable to a handbook “How it works” section, not a checklist skeleton.',
  'Non-technical tone; numbered steps; backtick paths from excerpts only.',
].join('\n')

const PLAYBOOK_WRITER = [
  'Write one scenario playbook in markdown (body_md in JSON).',
  'Audience: programme managers and event or coordination staff.',
  'Sections: What this guide covers; General rules; Scenarios numbered 1, 2, 3 with When this applies, Steps, Who is affected, Communications or calendar notes only if evidenced, Double-check bullets; After you make a change (save, confirmations) when excerpts support it; optional Evidence gap.',
  'Each scenario block must be long enough to execute without guesswork—tables for decision branches when helpful; same narrative density as handbook example scenarios.',
  'Conversational headings; cite paths from excerpts.',
].join('\n')

const FEATURE_BRIEF_WRITER = [
  'Write one **feature / capability brief** in markdown (body_md in JSON) for sales, CS, and programme leads—not engineers.',
  'Purpose: help win, onboard, and expand customers; reduce support load; make cross-team language consistent.',
  'Use ## headings in order: What this capability is (plain language); Who it is for and the job-to-be-done; Customer-visible outcomes and "how we measure success" when excerpts support metrics; What it does NOT cover; Dependencies and handoffs; Common questions (numbered FAQs); Risks, misuse, or compliance touchpoints only if evidenced; Evidence and source files.',
  'Each ## section needs rich paragraphs (and FAQs with substantive answers)—not marketing slogans; match the evidentiary density of a handbook chapter.',
  'Tone: confident, specific, non-hype. Tie claims to repository evidence via many backtick paths from excerpts only.',
  'Do NOT write about cosmetic UI (colors, fonts, themes) unless excerpts tie them to accessibility law, brand compliance, or revenue-critical presentation.',
].join('\n')

function docJsonSystem(archetype: OpsDocArchetype): string {
  const bodyHint =
    archetype === 'policy'
      ? POLICY_WRITER
      : archetype === 'sop'
        ? SOP_WRITER
        : archetype === 'playbook'
          ? PLAYBOOK_WRITER
          : FEATURE_BRIEF_WRITER
  const jsonShape =
    '{"summary":"plain-language abstract","body_md":"full markdown article","source_paths":["path1","path2"]}'
  return [
    bodyHint,
    '',
    'Respond with JSON only (no markdown outside JSON):',
    jsonShape,
    '',
    'Handbook-quality bar: summary must read like a handbook abstract (business outcome first). body_md must be as long and structured as a handbook chapter—many ## and ### sections, tables, numbered steps, and dense prose.',
    'summary and body_md must match; at least 2 source_paths from excerpts (standard/deep: prefer 3–6 paths when evidence supports it).',
    'Cite real repository paths in backticks throughout body_md (same path discipline as the engineering handbook QA).',
    'Do not stop short to save tokens; incomplete drafts fail automated review.',
  ].join('\n')
}

function docJsonUser(params: {
  title: string
  archetype: OpsDocArchetype
  grounding: string
  anchors: string[]
  repositoryName: string
  audienceLine: string
  depthLine: string
  voice: string
  catalog: string
  strategyDigest?: string | null
}): string {
  const digest =
    params.strategyDigest && params.strategyDigest.trim().length > 0
      ? [
          '',
          '--- Coverage strategy digest (align topics; cite only paths from excerpts) ---',
          '',
          params.strategyDigest.trim().slice(0, 2_800),
        ].join('\n')
      : ''
  return [
    params.voice,
    '',
    params.audienceLine,
    params.depthLine,
    '',
    'Artifact type: ' + params.archetype,
    'Working title: ' + params.title,
    'Planner notes: ' + params.grounding,
    'Priority anchors: ' + params.anchors.join(', '),
    'Product label: ' + params.repositoryName,
    digest,
    '',
    '--- SOURCE EXCERPTS ---',
    '',
    params.catalog,
  ].join('\n')
}

function dedupeArtifacts(
  artifacts: z.infer<typeof CatalogArtifactSchema>[]
): z.infer<typeof CatalogArtifactSchema>[] {
  const seen = new Set<string>()
  const out: z.infer<typeof CatalogArtifactSchema>[] = []
  for (const a of artifacts) {
    const k = normalizeOpsArtifactTitleKey(a.title)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(a)
  }
  return out
}

function trimArtifacts(
  artifacts: z.infer<typeof CatalogArtifactSchema>[],
  maxTotal: number
): z.infer<typeof CatalogArtifactSchema>[] {
  const counts = { policy: 0, sop: 0, playbook: 0, feature_brief: 0 }
  const out: z.infer<typeof CatalogArtifactSchema>[] = []
  for (const a of artifacts) {
    if (out.length >= maxTotal) break
    const t = a.archetype
    if (counts[t] >= OPS_CAPS[t]) continue
    out.push(a)
    counts[t]++
  }
  return out
}

export type OpsInventoryBuildInput = {
  workspaceId: string
  workspaceName: string
  handbookVoice?: string | null
  repositoryName: string
  rawChunks: { path: string; text: string }[]
  corpusSampled: boolean
  totalChunkRowsScanned: number
  model?: string | null
  targetAudience: string
  contentDepth: DocContentDepth
  shouldAbort?: () => boolean
  onProgress?: (message: string) => void
  /** Optional: coverage planner output — steers catalog toward useful policies/SOPs/playbooks. */
  coveragePlanPromptBlock?: string | null
}

/**
 * Phase 1 only: LLM catalog passes over excerpts → trimmed artifact plans (persist in job meta for resume).
 */
export async function buildOperationalArtifactsInventory(input: OpsInventoryBuildInput): Promise<OpsArtifactPlan[]> {
  const minChunks = 24
  if (input.rawChunks.length < minChunks) {
    input.onProgress?.(
      `Operational docs skipped: need at least ${minChunks} chunk rows (have ${input.rawChunks.length}).`
    )
    return []
  }

  const validPaths = knownPathsSet(input.rawChunks)
  const profile = catalogProfileForDepth(input.contentDepth)
  const maxExcerpts = Math.min(
    profile.excerptCap,
    Math.max(profile.minExcerpts, Math.floor(input.rawChunks.length / profile.chunkDiv) + profile.chunkBias)
  )
  const { catalog, excerptPaths } = buildStratifiedDocCatalog(input.rawChunks, {
    maxExcerpts,
    maxCharsPerExcerpt: profile.maxCharsPerExcerpt,
    maxCatalogChars: profile.maxCatalogChars,
  })

  if (excerptPaths.size < 6 || catalog.length < 500) {
    input.onProgress?.('Operational docs skipped: excerpt catalog too thin for inventory.')
    return []
  }

  const model = pickDocModel(input.model)
  const coverageNote =
    input.corpusSampled && input.totalChunkRowsScanned != null
      ? `Note: corpus was row-capped (~${input.totalChunkRowsScanned} chunk rows); stay honest about coverage.`
      : ''

  input.onProgress?.(`Operational docs catalog (${excerptPaths.size} paths, model ${model})`)
  if (input.shouldAbort?.()) return []

  const maxOps = readOpsMaxTotal()

  type CatalogArt = z.infer<typeof CatalogArtifactSchema>
  let artifactsAccum: CatalogArt[] = []

  const titlesForExclude = () => dedupeArtifacts(artifactsAccum).map((a) => a.title)

  async function runCatalogPass(label: string, catalogStr: string, minCatalogChars: number): Promise<void> {
    if (input.shouldAbort?.()) return
    if (catalogStr.length < minCatalogChars) {
      input.onProgress?.(`Operational docs catalog ${label} skipped (excerpt text below ${minCatalogChars} chars).`)
      return
    }
    input.onProgress?.(`Operational docs catalog pass ${label}…`)
    try {
      const rawCatalog = await completeJsonWithRetry({
        model,
        maxTokens: 16_384,
        system: CATALOG_SYSTEM,
        user: catalogUser({
          repositoryName: input.repositoryName,
          workspaceId: input.workspaceId,
          uniquePaths: excerptPaths.size,
          coverageNote,
          catalog: catalogStr,
          excludeTitles: titlesForExclude(),
          strategyBlock: input.coveragePlanPromptBlock,
        }),
      })
      let parsed: unknown
      try {
        parsed = JSON.parse(rawCatalog)
      } catch {
        input.onProgress?.(`Operational docs catalog ${label}: response was not valid JSON (often truncated—retry smaller catalog pass).`)
        return
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed !== null &&
        'artifacts' in parsed &&
        Array.isArray((parsed as { artifacts: unknown }).artifacts)
      ) {
        const rec = parsed as { artifacts: unknown[] }
        const len = rec.artifacts.length
        if (len > OPS_CATALOG_BATCH_MAX) {
          input.onProgress?.(
            `Operational docs catalog ${label}: model returned ${len} artifacts; keeping first ${OPS_CATALOG_BATCH_MAX} (batch cap).`
          )
          parsed = { ...(parsed as object), artifacts: rec.artifacts.slice(0, OPS_CATALOG_BATCH_MAX) }
        }
      }
      const validated = CatalogPayloadSchema.safeParse(parsed)
      if (!validated.success) {
        input.onProgress?.(`Operational docs catalog ${label} validation: ${validated.error.message}`)
        return
      }
      const mapped = validated.data.artifacts
        .map((a) => ({
          ...a,
          anchor_paths: filterAnchorPaths(a.anchor_paths, validPaths),
        }))
        .filter((a) => a.anchor_paths.length >= 2)
      artifactsAccum.push(...mapped)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      input.onProgress?.(`Operational docs catalog ${label} skipped (${msg}).`)
    }
  }

  await runCatalogPass('A (full corpus)', catalog, 500)

  const half = Math.max(1, Math.floor(input.rawChunks.length / 2))
  const rawAlt = input.rawChunks.slice(half)
  if (rawAlt.length >= 16 && !input.shouldAbort?.()) {
    const maxExcerptsB = Math.min(profile.excerptCap, Math.max(80, Math.floor(rawAlt.length / profile.chunkDiv) + 60))
    const catalogB = buildStratifiedDocCatalog(rawAlt, {
      maxExcerpts: maxExcerptsB,
      maxCharsPerExcerpt: profile.maxCharsPerExcerpt,
      maxCatalogChars: Math.min(profile.maxCatalogChars, 175_000),
    }).catalog
    await runCatalogPass('B (second-half chunks)', catalogB, 280)
  }

  const n = input.rawChunks.length
  const q = Math.max(1, Math.floor(n / 4))
  const quarters: { label: string; slice: { path: string; text: string }[] }[] = [
    { label: 'C (chunks 0–25%)', slice: input.rawChunks.slice(0, q) },
    { label: 'D (chunks 25–50%)', slice: input.rawChunks.slice(q, 2 * q) },
    { label: 'E (chunks 50–75%)', slice: input.rawChunks.slice(2 * q, 3 * q) },
    { label: 'F (chunks 75–100%)', slice: input.rawChunks.slice(3 * q) },
  ]
  for (const qpass of quarters) {
    if (input.shouldAbort?.()) break
    if (qpass.slice.length < 12) continue
    const maxEq = Math.min(profile.excerptCap, Math.max(64, Math.floor(qpass.slice.length / profile.chunkDiv) + 40))
    const catQ = buildStratifiedDocCatalog(qpass.slice, {
      maxExcerpts: maxEq,
      maxCharsPerExcerpt: profile.maxCharsPerExcerpt,
      maxCatalogChars: Math.min(profile.maxCatalogChars, 140_000),
    }).catalog
    await runCatalogPass(qpass.label, catQ, 260)
  }

  let artifacts = dedupeArtifacts(artifactsAccum)
  artifacts = trimArtifacts(artifacts, maxOps)
  if (artifacts.length === 0) {
    input.onProgress?.('Operational docs: inventory returned no grounded artifacts.')
  }
  return artifacts
}

/**
 * Phase 1 (catalog) + phase 2 (one LLM article per plan). Optional streaming persist via `onOperationalDocReady`.
 */
export async function generateOperationalDocsFromSources(input: OpsInventoryBuildInput & {
  artifactPlansOverride?: OpsArtifactPlan[] | null
  skipTitleKeys?: Set<string>
  onOperationalDocReady?: (section: GeneratedOpsDocSection) => Promise<void>
  shouldPause?: () => boolean
}): Promise<GeneratedOpsDocSection[]> {
  const minChunks = 24
  if (input.rawChunks.length < minChunks) {
    input.onProgress?.(
      `Operational docs skipped: need at least ${minChunks} chunk rows (have ${input.rawChunks.length}).`
    )
    return []
  }

  const validPaths = knownPathsSet(input.rawChunks)
  const profile = catalogProfileForDepth(input.contentDepth)
  const maxOps = readOpsMaxTotal()
  const model = pickDocModel(input.model)

  let artifacts: OpsArtifactPlan[]
  const ov = input.artifactPlansOverride
  if (ov && ov.length > 0) {
    const parsed = z.array(CatalogArtifactSchema).safeParse(ov)
    if (!parsed.success) {
      input.onProgress?.(`Operational docs: saved artifact inventory failed validation (${parsed.error.message}).`)
      return []
    }
    input.onProgress?.(`Operational docs using saved inventory (${parsed.data.length} plans, cap ${maxOps})`)
    artifacts = trimArtifacts(dedupeArtifacts(parsed.data), maxOps)
  } else {
    artifacts = await buildOperationalArtifactsInventory(input)
    if (artifacts.length === 0) return []
  }

  artifacts = artifacts.filter((a) => !input.skipTitleKeys?.has(normalizeOpsArtifactTitleKey(a.title)))
  if (artifacts.length === 0) {
    input.onProgress?.('Operational docs: nothing to generate (inventory empty or all titles already saved).')
    return []
  }

  input.onProgress?.(
    `Operational docs generating ${artifacts.length} articles (cap ${maxOps}, no CodeWiki). Set AUTODOC_OPS_MAX_ARTIFACTS (12–250) to tune.`
  )

  const audienceLine = `Primary audience: ${input.targetAudience}.`
  const depthLine = opsDepthLine(input.contentDepth)
  const voice = voiceBlock(input.workspaceName, input.handbookVoice)

  const results: GeneratedOpsDocSection[] = []
  const maxAttempts = 6

  for (let i = 0; i < artifacts.length; i++) {
    if (input.shouldPause?.()) throw new JobPauseRequestedError()
    if (input.shouldAbort?.()) throw new JobAbortRequestedError()

    const art = artifacts[i]!
    input.onProgress?.(
      `Operational docs article ${i + 1}/${artifacts.length} starting (${art.archetype}): ${art.title.slice(0, 56)}`
    )
    const focusedCatalog = buildFocusedCatalog(input.rawChunks, art.anchor_paths, profile)
    let lastErrs: string[] = []
    let wrote = false

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (input.shouldPause?.()) throw new JobPauseRequestedError()
      if (input.shouldAbort?.()) throw new JobAbortRequestedError()
      const retry =
        attempt === 0
          ? ''
          : [
              '',
              '--- RETRY (QA failed) ---',
              lastErrs.map((e) => '- ' + e).join('\n'),
              'Regenerate JSON to pass the SAME automated depth checks as the engineering handbook: longer summary (business outcome), much longer body_md with every ## section filled, ≥3 path-like backticks and ≥3 excerpt source_paths (standard/deep), and more tables or numbered steps.',
            ].join('\n')

      const userMsg = docJsonUser({
        title: art.title,
        archetype: art.archetype,
        grounding: art.grounding_rationale,
        anchors: art.anchor_paths,
        repositoryName: input.repositoryName,
        audienceLine,
        depthLine,
        voice,
        catalog: focusedCatalog,
        strategyDigest: input.coveragePlanPromptBlock,
      })

      const docMaxTokens = input.contentDepth === 'overview' ? 14_000 : 16_384

      const rawDoc = await completeJsonWithRetry({
        model,
        maxTokens: docMaxTokens,
        system: docJsonSystem(art.archetype) + retry,
        user: userMsg,
      })

      let docParsed: unknown
      try {
        docParsed = JSON.parse(rawDoc)
      } catch {
        lastErrs = ['non-JSON document response']
        continue
      }

      const docVal = OneDocSchema.safeParse(docParsed)
      if (!docVal.success) {
        lastErrs = [`schema: ${docVal.error.message}`]
        continue
      }

      const padMin =
        input.contentDepth === 'overview' ? 2 : Math.max(3, HANDBOOK_QUALITY.minSourcePathsSubstantive)
      const paths = padSourcePathsToMinimum(
        [...new Set(docVal.data.source_paths)].filter((p) => validPaths.has(p)),
        art.anchor_paths,
        validPaths,
        padMin
      )
      const errs = validateGeneratedDoc(
        art.archetype,
        art.title,
        docVal.data.summary,
        docVal.data.body_md,
        paths,
        validPaths,
        input.contentDepth
      )
      if (errs.length === 0) {
        const section: GeneratedOpsDocSection = {
          archetype: art.archetype,
          category: categoryForArchetype(art.archetype),
          title: art.title,
          summary: docVal.data.summary,
          bodyMd: docVal.data.body_md,
          sourcePaths: paths,
        }
        results.push(section)
        await input.onOperationalDocReady?.(section)
        wrote = true
        input.onProgress?.(`Operational docs ${i + 1}/${artifacts.length} done (${art.archetype}): ${art.title.slice(0, 48)}`)
        break
      }
      lastErrs = errs
    }
    if (!wrote && lastErrs.length) {
      input.onProgress?.(
        `Operational docs article ${i + 1}/${artifacts.length} skipped (QA): ${lastErrs.slice(0, 2).join('; ')}`
      )
    }
  }

  input.onProgress?.(`Operational docs finished ${results.length}/${artifacts.length} articles`)
  return results
}
