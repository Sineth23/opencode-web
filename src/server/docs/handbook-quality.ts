/** Shape passed into QA (same fields as generated sections). */
export type SectionQualityInput = {
  title: string
  summary: string
  bodyMd: string
  sourcePaths: string[]
}

/**
 * AutoDoc handbook quality bar: enforced after each model batch (and on final merge).
 * Tune here; failures surface as job errors with explicit reasons (no silent low-quality saves).
 */
export const HANDBOOK_QUALITY = {
  /** Unique source paths in the stratified catalog below this → refuse to generate (thin signal). */
  minUniquePathsInCatalog: 8,
  /** Section titles should be specific, not one-word placeholders. */
  minTitleLength: 12,
  /** Summary must state a business outcome, not a generic description. */
  minSummaryLength: 80,
  /** Substantive sections: body must carry full 7-part structure (headings, lists, tables, prose). */
  minBodyCharsSubstantive: 1_200,
  /** Evidence-gap sections (honest "no excerpts") can be shorter but not empty. */
  minBodyCharsEvidenceGap: 280,
  /** Substantive sections must cite multiple paths inline. */
  minInlineBacktickChars: 6,
  /** At least this many path-like backtick spans (e.g. `app/models/x.rb`). */
  minPathLikeBacktickSpans: 3,
  /** Substantive sections must list enough paths for audit. */
  minSourcePathsSubstantive: 2,
} as const

/**
 * True when the section is definitional/meta rather than implementation-focused.
 * These sections (glossaries, evidence gaps) get reduced path-citation requirements.
 */
export function isEvidenceGapSection(bodyMd: string, title?: string): boolean {
  // Glossary and similar meta sections don't naturally contain file path citations
  if (title && /^(glossary|naming|terminology|abbreviations?)\b/i.test(title.trim())) return true
  const head = bodyMd.slice(0, 1200)
  return /(^|\n)#{1,3}\s*Evidence\s+gap\b/i.test(head) || /\bEvidence\s+gap\b/i.test(head.slice(0, 400))
}

/** Counts inline `…` spans that look like repo paths (slashes, backslashes, or common dotted filenames). */
export function pathLikeBacktickSpans(bodyMd: string): number {
  const re = /`([^`\n]+)`/g
  let n = 0
  for (const m of bodyMd.matchAll(re)) {
    const inner = (m[1] ?? '').trim()
    if (
      inner.includes('/') ||
      inner.includes('\\') ||
      /\.[a-z0-9]{1,10}$/i.test(inner) ||
      /^(config|Gemfile|Rakefile|Dockerfile|Makefile)/i.test(inner)
    ) {
      n++
    }
  }
  return n
}

const FLUFF_RE = /\b(lorem ipsum|todo:|tbd\b|as an ai language model)\b/i

export function validateHandbookSection(s: SectionQualityInput, index: number): string[] {
  const errs: string[] = []
  const prefix = `Section ${index + 1} ("${s.title.slice(0, 60)}…")`

  if (s.title.trim().length < HANDBOOK_QUALITY.minTitleLength) {
    errs.push(`${prefix}: title too short or generic (min ${HANDBOOK_QUALITY.minTitleLength} chars).`)
  }
  if (s.summary.trim().length < HANDBOOK_QUALITY.minSummaryLength) {
    errs.push(
      `${prefix}: summary too thin (min ${HANDBOOK_QUALITY.minSummaryLength} chars). Must state a business outcome, not just describe what the section contains.`,
    )
  }
  if (FLUFF_RE.test(s.bodyMd) || FLUFF_RE.test(s.summary)) {
    errs.push(`${prefix}: remove placeholder / disallowed phrasing.`)
  }

  const gap = isEvidenceGapSection(s.bodyMd, s.title)
  const minBody = gap ? HANDBOOK_QUALITY.minBodyCharsEvidenceGap : HANDBOOK_QUALITY.minBodyCharsSubstantive
  if (s.bodyMd.trim().length < minBody) {
    errs.push(
      `${prefix}: body too short (${s.bodyMd.trim().length} chars; need ≥${minBody}${gap ? ' for evidence-gap' : ' for substantive sections: use the full 7-part format with ## headings, tables, numbered steps'}). `,
    )
  }

  if (!gap) {
    const ticks = (s.bodyMd.match(/`/g) ?? []).length
    if (ticks < HANDBOOK_QUALITY.minInlineBacktickChars) {
      errs.push(
        `${prefix}: cite more repo paths inline using backticks (at least ${HANDBOOK_QUALITY.minInlineBacktickChars} \` characters).`,
      )
    }
    const pathSpans = pathLikeBacktickSpans(s.bodyMd)
    if (pathSpans < HANDBOOK_QUALITY.minPathLikeBacktickSpans) {
      errs.push(
        `${prefix}: need ≥${HANDBOOK_QUALITY.minPathLikeBacktickSpans} path-like \`dir/file.ext\` citations from excerpts (found ${pathSpans}). Every section must include a "## Where It Lives" subsection with at least ${HANDBOOK_QUALITY.minPathLikeBacktickSpans} file paths.`,
      )
    }
    const spMin = HANDBOOK_QUALITY.minSourcePathsSubstantive
    if (s.sourcePaths.length < spMin) {
      errs.push(`${prefix}: source_paths must list ≥${spMin} excerpt paths for audit (found ${s.sourcePaths.length}).`)
    }
  }

  return errs
}

export function validateHandbookBatch(sections: SectionQualityInput[], batchLabel: string, expectedCount?: number): string[] {
  const out: string[] = []
  const expected = expectedCount ?? 8
  if (sections.length !== expected) {
    out.push(`${batchLabel}: expected ${expected} sections, got ${sections.length}.`)
  }
  sections.forEach((s, i) => {
    out.push(...validateHandbookSection(s, i))
  })
  return out
}

export function validateNoDuplicateTitles(sections: SectionQualityInput[]): string[] {
  const seen = new Map<string, number>()
  const errs: string[] = []
  const norm = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  for (const s of sections) {
    const k = norm(s.title)
    if (!k) continue
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  for (const [k, c] of seen) {
    if (c > 1) errs.push(`Duplicate or near-duplicate section title (${c}×): "${k}".`)
  }
  return errs
}

export function validateDepthPassSections(sections: SectionQualityInput[]): string[] {
  const errs: string[] = []
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!
    if (!s.title.trim().toLowerCase().startsWith('deep dive:')) {
      errs.push(`Depth section ${i + 1}: title must start with "Deep dive:" (found: "${s.title.slice(0, 48)}…").`)
    }
    errs.push(...validateHandbookSection(s, i))
  }
  return errs
}

/** User-visible summary of standards (e.g. admin docs). */
export const HANDBOOK_QUALITY_SUMMARY = [
  `${HANDBOOK_QUALITY.minUniquePathsInCatalog}+ unique files in the excerpt catalog required before generation.`,
  `Each substantive section: title ≥${HANDBOOK_QUALITY.minTitleLength} chars, summary ≥${HANDBOOK_QUALITY.minSummaryLength} chars (must state a business outcome), body ≥${HANDBOOK_QUALITY.minBodyCharsSubstantive} chars with 7-part format.`,
  `Path discipline: ≥${HANDBOOK_QUALITY.minPathLikeBacktickSpans} path-like \`dir/file.ext\` citations and ≥${HANDBOOK_QUALITY.minSourcePathsSubstantive} entries in source_paths.`,
  `Evidence-gap sections: shorter body allowed if clearly labeled; no invented behavior.`,
  `One automatic model retry per batch if QA fails; then the job errors with a checklist (no silent save).`,
].join(' ')
