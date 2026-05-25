import { z } from 'zod'
import type { DocSectionCategory } from '@/types/product-knowledge'
import type { DocContentDepth } from '@/server/plans/org-ai-settings'
import { requireOpenAI } from '@/server/llm/openai-embeddings'
import {
  canonicalSlotsPromptBlock,
  HANDBOOK_CANONICAL_SLOTS,
  HANDBOOK_DEPTH_EXTRA_MAX,
  HANDBOOK_DEPTH_PASS_MIN_CHUNKS,
  HANDBOOK_SLOT_BATCH_A,
  HANDBOOK_SLOT_BATCH_B,
  HANDBOOK_MAX_SECTIONS,
} from '@/server/docs/handbook-canonical'
import { DEFAULT_HANDBOOK_VOICE } from '@/server/docs/handbook-default-voice'
import {
  HANDBOOK_QUALITY,
  validateDepthPassSections,
  validateHandbookBatch,
  validateHandbookSection,
  validateNoDuplicateTitles,
} from '@/server/docs/handbook-quality'

export interface GeneratedDocSection {
  category: DocSectionCategory
  title: string
  summary: string
  bodyMd: string
  sourcePaths: string[]
}

const SectionSchema = z.object({
  category: z.enum([
    'features',
    'workflows',
    'configurations',
    'communications',
    'reporting',
    'workarounds',
    'system_overview',
    'integration_surface',
    'capabilities',
  ]),
  title: z.string().min(1).max(240),
  summary: z.string().max(1_200),
  body_md: z.string().min(1).max(9_500),
  source_paths: z.array(z.string()).max(120),
})

const PayloadBatch9 = z.object({
  sections: z.array(SectionSchema).min(9).max(9),
})

const PayloadDepth = z.object({
  sections: z.array(SectionSchema).min(2).max(HANDBOOK_DEPTH_EXTRA_MAX),
})

function pickDocGenerationModel(orgOverride?: string | null): string {
  const o = orgOverride?.trim()
  if (o) return o
  return process.env.OPENAI_DOC_GENERATION_MODEL?.trim() || 'gpt-4o'
}

function depthGuidance(depth: DocContentDepth): string {
  switch (depth) {
    case 'overview':
      return `Content depth: OVERVIEW: tighter prose; still cover every 7-part format subsection; honest evidence gaps; bodies ≥900 chars even when compressed.`
    case 'deep':
      return `Content depth: DEEP DIVE: push to the maximum allowed body size. Add more ### subsections, enumerate every known edge case, include cascading-effect chains, quote key config keys or function signatures verbatim (with path), and expand the Example Scenario into a full narrative. Use the full body_md allowance; thin sections fail QA.`
    case 'standard':
    default:
      return `Content depth: STANDARD: full 7-part format for every section; detailed enough that a new engineer or PM can operate the system without asking developers. Bodies ≥1,200 chars for substantive sections.`
  }
}

function brandBlock(workspaceName: string, handbookVoice: string | null | undefined): string {
  const voice = handbookVoice?.trim() || DEFAULT_HANDBOOK_VOICE
  return `Organization / workspace display name: **${workspaceName}**.

${voice}`
}

/**
 * Round-robin across file paths so excerpts span the repo, not only the first files alphabetically.
 */
export function buildStratifiedDocCatalog(
  rows: { path: string; text: string }[],
  opts: { maxExcerpts: number; maxCharsPerExcerpt: number; maxCatalogChars: number }
): { catalog: string; excerptPaths: Set<string> } {
  const byPath = new Map<string, string[]>()
  for (const r of rows) {
    const list = byPath.get(r.path) ?? []
    list.push(r.text)
    byPath.set(r.path, list)
  }
  const paths = [...byPath.keys()].sort((a, b) => a.localeCompare(b))
  const excerpts: { path: string; text: string }[] = []
  let round = 0
  let guard = 0
  const maxGuard = Math.max(paths.length * 80, 8000)
  while (excerpts.length < opts.maxExcerpts && guard < maxGuard) {
    guard++
    let addedThisRound = false
    for (const p of paths) {
      const chunks = byPath.get(p)!
      if (round < chunks.length) {
        excerpts.push({
          path: p,
          text: chunks[round].slice(0, opts.maxCharsPerExcerpt),
        })
        addedThisRound = true
        if (excerpts.length >= opts.maxExcerpts) break
      }
    }
    if (!addedThisRound) break
    round++
  }

  const excerptPaths = new Set<string>()
  let catalog = ''
  for (let i = 0; i < excerpts.length; i++) {
    const ex = excerpts[i]
    excerptPaths.add(ex.path)
    const block = `### Excerpt ${i + 1}: ${ex.path}\n${ex.text}\n\n---\n\n`
    if (catalog.length + block.length > opts.maxCatalogChars) break
    catalog += block
  }
  return { catalog, excerptPaths }
}

export function catalogProfileForDepth(contentDepth: DocContentDepth) {
  if (contentDepth === 'deep') {
    return {
      excerptCap: 280,
      maxCharsPerExcerpt: 4_200,
      maxCatalogChars: 200_000,
      minExcerpts: 120,
      chunkDiv: 3,
      chunkBias: 90,
    }
  }
  if (contentDepth === 'overview') {
    return {
      excerptCap: 160,
      maxCharsPerExcerpt: 2_800,
      maxCatalogChars: 120_000,
      minExcerpts: 72,
      chunkDiv: 5,
      chunkBias: 50,
    }
  }
  return {
    excerptCap: 220,
    maxCharsPerExcerpt: 3_600,
    maxCatalogChars: 165_000,
    minExcerpts: 96,
    chunkDiv: 4,
    chunkBias: 72,
  }
}

type SectionInput = z.infer<typeof SectionSchema>

function mapValidated(sections: SectionInput[]) {
  return sections.map((s) => ({
    category: s.category,
    title: s.title,
    summary: s.summary,
    bodyMd: s.body_md,
    sourcePaths: s.source_paths,
  }))
}

function normalizeTitleKey(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

async function completeHandbookJson(input: {
  model: string
  system: string
  user: string
}): Promise<string> {
  const openai = requireOpenAI()
  const res = await openai.chat.completions.create({
    model: input.model,
    temperature: 0.2,
    max_tokens: 16_384,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
  })
  const raw = res.choices[0]?.message?.content?.trim()
  if (!raw) throw new Error('Documentation model returned empty output')
  return raw
}

/**
 * Two-batch canonical handbook (16 core sections) plus optional depth pass (up to 4).
 * Chunk-grounded; workspace name and handbook_voice shape tone.
 */
export async function generateDocSectionsFromSources(input: {
  workspaceId: string
  workspaceName: string
  handbookVoice?: string | null
  /** When true and corpus is large enough, add a third LLM pass for 2–4 deep chapters (max 20 sections total). */
  handbookDepthPass?: boolean
  repositoryName: string
  rawChunks: { path: string; text: string }[]
  corpusSampled?: boolean
  totalChunkRowsScanned?: number
  model?: string | null
  codewiki?: { digest: string; styleNote: string; completedAt: string | null } | null
  targetAudience: string
  contentDepth: DocContentDepth
  /** Optional: pre-computed coverage strategy (capabilities, SOP/policy hooks, client questions) to stress in prose. */
  coveragePlanPromptBlock?: string | null
}): Promise<GeneratedDocSection[]> {
  if (input.rawChunks.length === 0) {
    throw new Error('No source excerpts to generate documentation from')
  }

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

  if (excerptPaths.size < HANDBOOK_QUALITY.minUniquePathsInCatalog) {
    throw new Error(
      `Handbook quality: excerpt catalog only spans ${excerptPaths.size} unique file paths (minimum ${HANDBOOK_QUALITY.minUniquePathsInCatalog}). Widen sync scope, raise doc_max_chunk_rows, or run a full sync before regenerating.`
    )
  }

  if (catalog.length < 400) {
    throw new Error('Not enough textual signal in chunks to generate documentation')
  }

  const half = Math.max(1, Math.floor(input.rawChunks.length / 2))
  const rawAlt = input.rawChunks.slice(half)
  const maxExcerptsB = Math.min(profile.excerptCap, Math.max(80, Math.floor(rawAlt.length / profile.chunkDiv) + 60))
  const catalogB = buildStratifiedDocCatalog(rawAlt, {
    maxExcerpts: maxExcerptsB,
    maxCharsPerExcerpt: profile.maxCharsPerExcerpt,
    maxCatalogChars: Math.min(profile.maxCatalogChars, 175_000),
  }).catalog

  const model = pickDocGenerationModel(input.model)
  const coverageNote =
    input.corpusSampled && input.totalChunkRowsScanned != null
      ? `\nNote: Corpus was capped; this run scanned ~${input.totalChunkRowsScanned} chunk rows and the prompt uses a stratified excerpt sample. Flag coverage limits honestly.`
      : ''

  const cw = input.codewiki
  const codewikiSystem = cw
    ? `Optional repository overview may appear in user messages. Treat it as weak structure only. SOURCE EXCERPTS are authoritative for facts, paths, and APIs.`
    : ''

  const codewikiUser = cw
    ? `\n\n--- REPOSITORY OVERVIEW (optional; generated ${cw.completedAt ?? 'unknown'}) ---\n${cw.styleNote}\n\n${cw.digest}\n`
    : ''

  const audienceLine = `Primary audience: ${input.targetAudience}.`
  const depthLine = depthGuidance(input.contentDepth)
  const brand = brandBlock(input.workspaceName, input.handbookVoice)

  const sharedSystemPreamble = `You are AutoDoc's principal technical author. ${brand}
${audienceLine}
${depthLine}

Output valid JSON only:
{"sections":[{"category":"...","title":"...","summary":"...","body_md":"markdown","source_paths":["paths"]}]}

## Global rules

### 7-part answer format (MANDATORY for every substantive section)
Structure every body_md using these ## subsections in order (omit only when evidence is absent):
1. ## Plain Language Summary: 2–4 sentences for a programme manager. Business outcome first, never "this function does X".
2. ## How It Works: Numbered steps or prose for the sequence of events, state changes, data flows, and side effects.
3. ## Where It Lives: Specific \`path/to/file.ext\` paths with backticks. At least 2 path citations. What each file owns.
4. ## Relationships & Dependencies: What else is affected or depends on this. Cascading effects. Cross-feature coupling.
5. ## Edge Cases & Constraints: What can go wrong, known limitations, timing issues, invalid inputs, race conditions.
6. ## Example Scenario: A concrete real-world example: actor, action, immediate effect, background consequences.
7. ## Code Reference: *(optional; use only when a short verbatim snippet clarifies a contract)* Max 12 lines; cite path above the fence.

### Depth requirement
Every data field, toggle, status value, or action must be described with its **business consequence**, not just its existence.
- BAD: "The event model contains a status field."
- GOOD: "The \`status\` field controls the event lifecycle; changing it from \`active\` to \`past\` suppresses pending outbound emails, removes the event from live reporting dashboards, and triggers a background reconciliation job that adjusts participant eligibility counts (visible 5–15 minutes later)."

### Markdown execution
- Use ## / ### headings per the 7-part structure above.
- Tables for comparisons, config key lists, file maps (columns: Area | Role | Path).
- Numbered steps for every sequential process.
- Bullets for rules, constraints, caveats.
- Backtick inline paths everywhere substantive.
- Fenced code blocks ONLY for verbatim excerpts with source path cited on line above.

### Evidence discipline
- No invented modules, env vars, endpoints, or file paths. Unknowns → "## Evidence gap" subsection explaining what to read next.
- source_paths: list every excerpt path that materially supports the section (min 4 for substantive sections).

### Quality bar (enforced by automated review)
A reviewer rejects batches where any section has: thin summary (<80 chars), short body (<1,200 chars for substantive sections), fewer than ${HANDBOOK_QUALITY.minPathLikeBacktickSpans} inline \`path/to/file.ext\` backtick citations, or fewer than ${HANDBOOK_QUALITY.minSourcePathsSubstantive} source_paths entries. One full-batch retry is allowed; then the job fails. **Write to pass on first try.**
${input.coveragePlanPromptBlock?.trim() ? '\n### Coverage strategy\nWhen DOCUMENTATION COVERAGE STRATEGY appears in the user message, emphasize those themes in Plain Language, How It Works, and Edge Cases—without inventing paths or features not evidenced in excerpts.\n' : ''}
${codewikiSystem}`

  const coverageStrategyBlock =
    input.coveragePlanPromptBlock && input.coveragePlanPromptBlock.trim().length > 0
      ? `

--- DOCUMENTATION COVERAGE STRATEGY (follow for emphasis; excerpts + paths remain authoritative for facts) ---
${input.coveragePlanPromptBlock.trim()}
`
      : ''

  const baseUserHeader = `Product / repo label: ${input.repositoryName}
Workspace id (reference only): ${input.workspaceId}
Unique source files in primary excerpt set: ${excerptPaths.size}${coverageNote}
${coverageStrategyBlock}`

  const runBatchWithQuality = async (slots: typeof HANDBOOK_SLOT_BATCH_A, catalogBody: string, label: string) => {
    const slotBlock = canonicalSlotsPromptBlock(slots)
    const slotCount = slots.length
    let lastQaErrors: string[] = []

    for (let attempt = 0; attempt < 2; attempt++) {
      const retryBlock =
        attempt === 0
          ? ''
          : `

--- BATCH QUALITY RETRY (${label}) ---
The previous output failed automated review:
${lastQaErrors.map((e) => `- ${e}`).join('\n')}
Regenerate **all ${slotCount}** sections in one JSON object. Every substantive section MUST:
- Follow the 7-part format (## Plain Language Summary, ## How It Works, ## Where It Lives, ## Relationships & Dependencies, ## Edge Cases & Constraints, ## Example Scenario).
- Body ≥1,200 chars with at least ${HANDBOOK_QUALITY.minPathLikeBacktickSpans} inline \`path/to/file.ext\` citations (backticks around actual file paths like \`src/app/api/route.ts\`).
- source_paths ≥${HANDBOOK_QUALITY.minSourcePathsSubstantive} excerpt paths (even glossary/overview sections must cite at least ${HANDBOOK_QUALITY.minSourcePathsSubstantive} files).
- Summary ≥80 chars that states a business outcome, not a generic description.`

      const system = `${sharedSystemPreamble}

${slotBlock}

This response must contain **exactly ${slotCount}** sections in \`sections\`, one per slot in order (${label}).${retryBlock}`

      const user = `${baseUserHeader}

Batch: **${label}**. Excerpts win over any overview block below.

--- SOURCE EXCERPTS ---

${catalogBody}${codewikiUser}`

      const raw = await completeHandbookJson({ model, system, user })
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('Documentation model returned non-JSON')
      }
      const DynamicBatchSchema = z.object({
        sections: z.array(SectionSchema).min(slotCount).max(slotCount),
      })
      const validated = DynamicBatchSchema.safeParse(parsed)
      if (!validated.success) {
        // Fallback: try PayloadBatch9 for backwards compat on retries
        const fallback = PayloadBatch9.safeParse(parsed)
        if (!fallback.success) {
          throw new Error(`Handbook batch ${label} failed validation: ${validated.error.message}`)
        }
        const sections = mapValidated(fallback.data.sections)
        lastQaErrors = validateHandbookBatch(sections, label, slotCount)
        if (lastQaErrors.length === 0) return sections
        continue
      }
      const sections = mapValidated(validated.data.sections)
      lastQaErrors = validateHandbookBatch(sections, label, slotCount)
      if (lastQaErrors.length === 0) {
        return sections
      }
    }

    throw new Error(
      `Handbook quality gate failed for ${label} after retry:\n${lastQaErrors.map((e) => `  • ${e}`).join('\n')}`
    )
  }

  const coreSlotCount = HANDBOOK_CANONICAL_SLOTS.length
  const batchAEnd = HANDBOOK_SLOT_BATCH_A.length
  const batchALabel = `H01–H${String(batchAEnd).padStart(2, '0')}`
  const batchBLabel = `H${String(batchAEnd + 1).padStart(2, '0')}–H${String(coreSlotCount).padStart(2, '0')}`
  const batchA = await runBatchWithQuality(HANDBOOK_SLOT_BATCH_A, catalog, batchALabel)
  const batchB = await runBatchWithQuality(HANDBOOK_SLOT_BATCH_B, catalogB.length >= 200 ? catalogB : catalog, batchBLabel)

  let merged: GeneratedDocSection[] = [...batchA, ...batchB]
  if (merged.length !== coreSlotCount) {
    throw new Error(`Handbook core incomplete: expected ${coreSlotCount} sections, got ${merged.length}`)
  }

  const depthPass =
    input.handbookDepthPass !== false &&
    input.rawChunks.length >= HANDBOOK_DEPTH_PASS_MIN_CHUNKS &&
    merged.length < HANDBOOK_MAX_SECTIONS

  if (depthPass) {
    const titles = merged.map((s) => `- ${s.title}`).join('\n')
    const depthSystem = `${sharedSystemPreamble}

### Depth pass (supplemental chapters only)
You will output **2 to ${HANDBOOK_DEPTH_EXTRA_MAX}** new sections. Each must:
- Start with title prefix **"Deep dive:"** followed by a specific theme grounded in excerpts.
- Not duplicate existing titles (listed below).
- Use the full 7-part format: ## Plain Language Summary, ## How It Works, ## Where It Lives, ## Relationships & Dependencies, ## Edge Cases & Constraints, ## Example Scenario, ## Code Reference (optional).
- Prefer: specific implementation detail, failure mode chains, invariants enforced by the system, cross-file interactions not fully covered in core chapters.
- Body ≥1,400 chars; ≥4 path citations; ≥4 source_paths.
- Stay within the same JSON schema fields as before (but array length 2–${HANDBOOK_DEPTH_EXTRA_MAX} only in this response).`

    const depthUser = `${baseUserHeader}

Existing handbook section titles (do not overlap):
${titles}

Use **supplemental** excerpts (alternate slice of the repo). Overview block if present is still non-authoritative.

--- SUPPLEMENTAL SOURCE EXCERPTS ---

${catalogB.length >= 200 ? catalogB : catalog}
${codewikiUser}`

    const rawD = await completeHandbookJson({ model, system: depthSystem, user: depthUser })
    let parsedD: unknown
    try {
      parsedD = JSON.parse(rawD)
    } catch {
      throw new Error('Handbook depth pass returned non-JSON')
    }
    const valD = PayloadDepth.safeParse(parsedD)
    if (valD.success) {
      const existing = new Set(merged.map((s) => normalizeTitleKey(s.title)))
      const extras = mapValidated(valD.data.sections).filter((s) => !existing.has(normalizeTitleKey(s.title)))
      const depthQa = validateDepthPassSections(extras)
      if (depthQa.length === 0) {
        merged = [...merged, ...extras].slice(0, HANDBOOK_MAX_SECTIONS)
      }
    }
  }

  const dup = validateNoDuplicateTitles(merged)
  if (dup.length) {
    throw new Error(`Handbook quality (merge): ${dup.join(' ')}`)
  }
  const finalQa: string[] = []
  merged.forEach((s, i) => {
    finalQa.push(...validateHandbookSection(s, i))
  })
  if (finalQa.length) {
    throw new Error(`Handbook quality (final review):\n${finalQa.map((e) => `  • ${e}`).join('\n')}`)
  }

  return merged
}
