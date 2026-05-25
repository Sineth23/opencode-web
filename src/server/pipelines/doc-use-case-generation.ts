import { z } from 'zod'
import type { DocContentDepth } from '@/server/plans/org-ai-settings'
import type { DocSectionCategory } from '@/types/product-knowledge'
import { JobAbortRequestedError, JobPauseRequestedError } from '@/server/pipelines/job-abort'
import { requireOpenAI } from '@/server/llm/openai-embeddings'
import { buildStratifiedDocCatalog, catalogProfileForDepth } from '@/server/pipelines/doc-generation'
import { DEFAULT_HANDBOOK_VOICE } from '@/server/docs/handbook-default-voice'
import { HANDBOOK_QUALITY, isEvidenceGapSection, pathLikeBacktickSpans } from '@/server/docs/handbook-quality'
import { normalizeOpsArtifactTitleKey } from '@/server/pipelines/doc-ops-generation'

export interface GeneratedUseCaseDocSection {
  category: DocSectionCategory
  title: string
  summary: string
  bodyMd: string
  sourcePaths: string[]
}

const UC_CATALOG_BATCH_MAX = 48

const UseCaseGuidePlanSchema = z.object({
  title: z.string().min(16).max(220),
  summary: z.string().min(1).max(620),
  grounding_rationale: z.string().min(1).max(900),
  anchor_paths: z.array(z.string()).min(2).max(50),
})

const CatalogPayloadSchema = z.object({
  guides: z.array(UseCaseGuidePlanSchema).max(UC_CATALOG_BATCH_MAX),
})

const OneDocSchema = z.object({
  summary: z.string().min(80).max(1_200),
  body_md: z.string().min(1).max(40_000),
  source_paths: z.array(z.string()).min(2).max(120),
})

const USE_CASE_MAX_DEFAULT = 180

function readUseCaseMaxTotal(): number {
  const raw = process.env.AUTODOC_USE_CASE_MAX_ARTIFACTS?.trim()
  if (!raw) return USE_CASE_MAX_DEFAULT
  const n = Number.parseInt(raw, 10)
  if (Number.isFinite(n) && n >= 16 && n <= 250) return n
  return USE_CASE_MAX_DEFAULT
}

function pickDocModel(orgOverride?: string | null): string {
  const o = orgOverride?.trim()
  if (o) return o
  return process.env.OPENAI_DOC_GENERATION_MODEL?.trim() || 'gpt-4o'
}

function ucDepthLine(depth: DocContentDepth): string {
  switch (depth) {
    case 'overview':
      return 'Length: still substantial—every ## block filled; dense bullets; explicit UI labels from excerpts only.'
    case 'deep':
      return 'Length: maximum depth—many ### branches per scenario, long numbered steps, tables for decision forks, failure paths, and stakeholder comms when evidenced.'
    case 'standard':
    default:
      return 'Length: long-form like a premium client operations pack—each guide should read as a complete chapter with numbered scenarios and rich bullets.'
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
    'Additional tone for **use-case specific** guides:',
    '- Primary readers: programme managers, coordinators, CS leads, sales engineers, and exec sponsors—people who ship outcomes, not library authors.',
    '- Write the way a great internal product team documents “when X happens in the product, do Y”: calm, specific, confident.',
    '- Name real UI affordances (menus, buttons, tabs, page titles) **only when** they appear in SOURCE EXCERPTS; never invent screens.',
    '- Prefer “you / we” and short paragraphs; heavy use of numbered scenarios and bullets.',
    '- Cite repository paths in backticks only from excerpts; never mention embeddings, RAG, CodeWiki, or the model.',
    '- If evidence is thin, end with a short ## Evidence gap in plain language.',
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
  if (!raw) throw new Error('Use-case documentation model returned empty output')
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
      console.warn(`[use-case-doc] chat completion retry ${attempt}/${maxAttempts - 1} in ${delay}ms (${msg.slice(0, 140)})`)
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

const UC_FLUFF_RE = /\b(lorem ipsum|todo:|tbd\b|as an ai language model)\b/i

function validateUseCaseDoc(
  title: string,
  summary: string,
  body: string,
  paths: string[],
  validPaths: Set<string>,
  depth: DocContentDepth
): string[] {
  const errs: string[] = []
  const tag = '[use_case] '
  const gap = isEvidenceGapSection(body, title)

  const minSummary = gap ? 80 : depth === 'overview' ? 80 : HANDBOOK_QUALITY.minSummaryLength
  if (summary.trim().length < minSummary) {
    errs.push(
      tag +
        `summary too thin (min ${minSummary} chars)—state who the guide helps and the business outcome (same bar as handbook abstracts).`
    )
  }

  if (title.trim().length < HANDBOOK_QUALITY.minTitleLength) {
    errs.push(tag + `title too short or generic (min ${HANDBOOK_QUALITY.minTitleLength} chars).`)
  }

  if (UC_FLUFF_RE.test(body) || UC_FLUFF_RE.test(summary)) {
    errs.push(tag + 'remove placeholder / disallowed phrasing')
  }

  const minBodySubstantive =
    depth === 'deep'
      ? HANDBOOK_QUALITY.minBodyCharsSubstantive + 400
      : depth === 'overview'
        ? 960
        : HANDBOOK_QUALITY.minBodyCharsSubstantive
  const minBody = gap ? HANDBOOK_QUALITY.minBodyCharsEvidenceGap : minBodySubstantive
  if (body.trim().length < minBody) {
    errs.push(
      tag +
        `body_md shorter than ${minBody} chars—expand Description, General guidelines, and every numbered scenario with ### subheads, tables, and verification bullets (currently ${body.trim().length}).`
    )
  }

  const minSourcePaths = gap ? 2 : depth === 'overview' ? 2 : Math.max(3, HANDBOOK_QUALITY.minSourcePathsSubstantive)
  if (paths.length < minSourcePaths) {
    errs.push(tag + `need at least ${minSourcePaths} grounded source_paths from excerpts (found ${paths.length}).`)
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

const UC_CATALOG_SYSTEM = [
  'You are planning a **large library** of **use-case specific** documentation for people who run the product day-to-day (coordinators, PMs, CS, sales, exec sponsors).',
  'Each guide is ONE narrow workflow domain (e.g. “change event dates and comms”, “pause outbound messages for a cohort”, “audit who changed what”).',
  'Ground every guide in SOURCE EXCERPTS: routes, components, APIs, emails, jobs, permissions, data models, and copy that appear in the repo.',
  'Be exhaustive: enumerate **as many distinct, materially different use cases** as excerpts plausibly support—prefer splitting broad themes into multiple guides.',
  'STRICT exclusions: do not invent features; skip purely cosmetic UI unless excerpts tie it to accessibility, compliance, or revenue risk.',
  'Output JSON ONLY: {"guides":[{"title":"...","summary":"...","grounding_rationale":"...","anchor_paths":["path1","path2"]}]}',
  'THIS RESPONSE: at most ' + String(UC_CATALOG_BATCH_MAX) + ' guides—other passes will add more. Fill the batch when evidence allows.',
  'Each guide MUST include ≥2 anchor_paths that appear verbatim in excerpts.',
].join('\n')

function catalogUser(params: {
  repositoryName: string
  workspaceId: string
  uniquePaths: number
  coverageNote: string
  catalog: string
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
    'Return JSON only. Propose up to ' + String(UC_CATALOG_BATCH_MAX) + ' guides in this batch.',
  ].join('\n')
}

const USE_CASE_WRITER = [
  'Write one **use-case specific** guide in markdown (field body_md in JSON).',
  'Structure (use these ## headings in order):',
  '## Description — 4–8 bullets: what this area covers, who uses it, why it matters, boundaries.',
  '## General guidelines — principles, guardrails, “always / never”, coordination etiquette, data hygiene—grounded in excerpts.',
  '## Scenarios — numbered scenarios **1.** **2.** **3.** … (as many as excerpts support, minimum 4 scenarios for standard/deep unless evidence gap).',
  'Under each scenario include ### When this applies, ### What to do (numbered steps referencing real UI labels from excerpts), ### Who is affected, ### Double-check before you finish, ### If something goes wrong (branch bullets when excerpts support it).',
  'Mirror premium client ops packs: mix prose and bullets; tables for decision branches when helpful.',
  'Tone: confident, non-hype, stakeholder-ready; avoid deep stack traces unless excerpts show them.',
].join('\n')

function docJsonSystem(): string {
  return [
    USE_CASE_WRITER,
    '',
    'Respond with JSON only (no markdown outside JSON):',
    '{"summary":"plain-language abstract","body_md":"full markdown article","source_paths":["path1","path2"]}',
    '',
    'Handbook-quality bar: summary matches body; body is long, structured, and actionable.',
    'Cite many repository paths in backticks from excerpts only.',
    'Do not stop short to save tokens; incomplete drafts fail automated review.',
  ].join('\n')
}

function docJsonUser(params: {
  title: string
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

function dedupeGuides(artifacts: z.infer<typeof UseCaseGuidePlanSchema>[]): z.infer<typeof UseCaseGuidePlanSchema>[] {
  const seen = new Set<string>()
  const out: z.infer<typeof UseCaseGuidePlanSchema>[] = []
  for (const a of artifacts) {
    const k = normalizeOpsArtifactTitleKey(a.title)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(a)
  }
  return out
}

function trimGuides(artifacts: z.infer<typeof UseCaseGuidePlanSchema>[], maxTotal: number): z.infer<typeof UseCaseGuidePlanSchema>[] {
  return artifacts.slice(0, maxTotal)
}

export type UseCaseInventoryBuildInput = {
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
  coveragePlanPromptBlock?: string | null
}

export async function buildUseCaseGuidesInventory(input: UseCaseInventoryBuildInput): Promise<z.infer<typeof UseCaseGuidePlanSchema>[]> {
  const minChunks = 24
  if (input.rawChunks.length < minChunks) {
    input.onProgress?.(`Use-case library skipped: need at least ${minChunks} chunk rows (have ${input.rawChunks.length}).`)
    return []
  }

  const validPaths = knownPathsSet(input.rawChunks)
  const profile = catalogProfileForDepth(input.contentDepth)
  const maxGuides = readUseCaseMaxTotal()
  const model = pickDocModel(input.model)

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
    input.onProgress?.('Use-case library skipped: excerpt catalog too thin for inventory.')
    return []
  }

  const coverageNote =
    input.corpusSampled && input.totalChunkRowsScanned != null
      ? `Note: corpus was row-capped (~${input.totalChunkRowsScanned} chunk rows); stay honest about coverage.`
      : ''

  input.onProgress?.(`Use-case catalog (${excerptPaths.size} paths, model ${model})`)

  let guidesAccum: z.infer<typeof UseCaseGuidePlanSchema>[] = []
  const titlesForExclude = () => dedupeGuides(guidesAccum).map((a) => a.title)

  async function runCatalogPass(label: string, catalogStr: string, minCatalogChars: number): Promise<void> {
    if (input.shouldAbort?.()) return
    if (catalogStr.length < minCatalogChars) {
      input.onProgress?.(`Use-case catalog ${label} skipped (excerpt text below ${minCatalogChars} chars).`)
      return
    }
    input.onProgress?.(`Use-case catalog pass ${label}…`)
    try {
      const rawCatalog = await completeJsonWithRetry({
        model,
        maxTokens: 16_384,
        system: UC_CATALOG_SYSTEM,
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
        input.onProgress?.(`Use-case catalog ${label}: response was not valid JSON.`)
        return
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed !== null &&
        'guides' in parsed &&
        Array.isArray((parsed as { guides: unknown }).guides)
      ) {
        const rec = parsed as { guides: unknown[] }
        const len = rec.guides.length
        if (len > UC_CATALOG_BATCH_MAX) {
          input.onProgress?.(
            `Use-case catalog ${label}: model returned ${len} guides; keeping first ${UC_CATALOG_BATCH_MAX} (batch cap).`
          )
          parsed = { ...(parsed as object), guides: rec.guides.slice(0, UC_CATALOG_BATCH_MAX) }
        }
      }
      const validated = CatalogPayloadSchema.safeParse(parsed)
      if (!validated.success) {
        input.onProgress?.(`Use-case catalog ${label} validation: ${validated.error.message}`)
        return
      }
      const mapped = validated.data.guides
        .map((a) => ({
          ...a,
          anchor_paths: filterAnchorPaths(a.anchor_paths, validPaths),
        }))
        .filter((a) => a.anchor_paths.length >= 2)
      guidesAccum.push(...mapped)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      input.onProgress?.(`Use-case catalog ${label} skipped (${msg}).`)
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

  let guides = dedupeGuides(guidesAccum)
  guides = trimGuides(guides, maxGuides)
  if (guides.length === 0) {
    input.onProgress?.('Use-case library: inventory returned no grounded guides.')
  }
  return guides
}

export async function generateUseCaseDocsFromSources(
  input: UseCaseInventoryBuildInput & {
    onUseCaseDocReady?: (section: GeneratedUseCaseDocSection) => Promise<void>
    shouldPause?: () => boolean
  }
): Promise<GeneratedUseCaseDocSection[]> {
  const minChunks = 24
  if (input.rawChunks.length < minChunks) {
    input.onProgress?.(
      `Use-case library skipped: need at least ${minChunks} chunk rows (have ${input.rawChunks.length}).`
    )
    return []
  }

  const validPaths = knownPathsSet(input.rawChunks)
  const profile = catalogProfileForDepth(input.contentDepth)
  const model = pickDocModel(input.model)
  const maxGuides = readUseCaseMaxTotal()

  const guides = trimGuides(dedupeGuides(await buildUseCaseGuidesInventory(input)), maxGuides)
  if (guides.length === 0) return []

  input.onProgress?.(
    `Use-case library generating ${guides.length} guides (cap ${maxGuides}; set AUTODOC_USE_CASE_MAX_ARTIFACTS 16–250 to tune).`
  )

  const audienceLine = `Primary audience: ${input.targetAudience}.`
  const depthLine = ucDepthLine(input.contentDepth)
  const voice = voiceBlock(input.workspaceName, input.handbookVoice)

  const results: GeneratedUseCaseDocSection[] = []
  const maxAttempts = 6

  for (let i = 0; i < guides.length; i++) {
    if (input.shouldPause?.()) throw new JobPauseRequestedError()
    if (input.shouldAbort?.()) throw new JobAbortRequestedError()

    const g = guides[i]!
    input.onProgress?.(`Use-case guide ${i + 1}/${guides.length}: ${g.title.slice(0, 56)}`)

    const focusedCatalog = buildFocusedCatalog(input.rawChunks, g.anchor_paths, profile)
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
              'Regenerate JSON: longer summary, much longer body_md with every ## and ### filled, more scenarios, more path-like backticks, enough excerpt-backed source_paths.',
            ].join('\n')

      const userMsg = docJsonUser({
        title: g.title,
        grounding: g.grounding_rationale,
        anchors: g.anchor_paths,
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
        system: docJsonSystem() + retry,
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
        g.anchor_paths,
        validPaths,
        padMin
      )
      const errs = validateUseCaseDoc(g.title, docVal.data.summary, docVal.data.body_md, paths, validPaths, input.contentDepth)
      if (errs.length === 0) {
        const section: GeneratedUseCaseDocSection = {
          category: 'operations_use_case',
          title: g.title,
          summary: docVal.data.summary,
          bodyMd: docVal.data.body_md,
          sourcePaths: paths,
        }
        results.push(section)
        await input.onUseCaseDocReady?.(section)
        wrote = true
        input.onProgress?.(`Use-case guide ${i + 1}/${guides.length} done: ${g.title.slice(0, 48)}`)
        break
      }
      lastErrs = errs
    }
    if (!wrote && lastErrs.length) {
      input.onProgress?.(`Use-case guide ${i + 1}/${guides.length} skipped (QA): ${lastErrs.slice(0, 2).join('; ')}`)
    }
  }

  input.onProgress?.(`Use-case library finished ${results.length}/${guides.length} guides`)
  return results
}
