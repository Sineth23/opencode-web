/**
 * Skip obvious binary payloads and minified bundles to save embedding cost and noise.
 */

const TEXT_EXT_PRIORITY: { re: RegExp; score: number }[] = [
  { re: /\.(md|mdx)$/i, score: 95 },
  { re: /\.(tsx?|jsx?|mjs|cjs)$/i, score: 90 },
  { re: /\.(py|rb|go|java|kt|kts|rs|swift|dart|scala|php|cs|fs|fsx)$/i, score: 88 },
  { re: /\.(vue|svelte)$/i, score: 86 },
  { re: /\.(yml|yaml|toml|json)$/i, score: 72 },
  { re: /\.(sql|graphql|gql)$/i, score: 80 },
  { re: /\.(css|scss|less|html|htm)$/i, score: 70 },
  { re: /\.(sh|bash|zsh|ps1)$/i, score: 65 },
  { re: /\.(tf|hcl)$/i, score: 68 },
  { re: /\.(proto|txt)$/i, score: 60 },
]

const NAMED_SOURCE_FILES = /^(Dockerfile|dockerfile|Makefile|GNUmakefile|Rakefile|Gemfile|Vagrantfile|Jenkinsfile|Containerfile)$/i

export function pathIngestPriority(repoRelativePath: string): number {
  const base = repoRelativePath.split('/').pop() ?? ''
  if (NAMED_SOURCE_FILES.test(base)) return 92
  for (const { re, score } of TEXT_EXT_PRIORITY) {
    if (re.test(repoRelativePath)) return score
  }
  return 40
}

export function sortPathsForIngest(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const pa = pathIngestPriority(a)
    const pb = pathIngestPriority(b)
    if (pb !== pa) return pb - pa
    return a.localeCompare(b)
  })
}

/** Null bytes or high control-character ratio → treat as binary. */
export function isLikelyBinaryText(raw: string): boolean {
  if (raw.includes('\0')) return true
  const sample = raw.slice(0, 50_000)
  if (sample.length === 0) return false
  let ctrl = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c < 9 || (c > 13 && c < 32)) ctrl++
  }
  return ctrl / sample.length > 0.03
}

/** Heuristic for minified JS/CSS/JSON: huge lines, few newlines. */
export function isLikelyMinifiedText(raw: string): boolean {
  if (raw.length < 6000) return false
  const lines = raw.split('\n').length
  const avg = raw.length / Math.max(lines, 1)
  if (avg > 4000 && lines < 12) return true
  const firstLine = raw.split('\n')[0] ?? ''
  if (firstLine.length > 12_000 && lines < 8) return true
  return false
}
