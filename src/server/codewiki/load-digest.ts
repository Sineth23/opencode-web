import type { SupabaseClient } from '@supabase/supabase-js'

const MAX_DIGEST_CHARS = 120_000

export type CodewikiDigestBundle = {
  digest: string
  /** ISO timestamp of holistic doc generation */
  completedAt: string | null
  /** Human hint for prompts */
  styleNote: string
  /** Human-readable repository name: used in source citation labels */
  repoName?: string
}

const STYLE_NOTE = `The following block is generated repository documentation: hierarchical, architecture-oriented docs (overview, modules, diagrams in markdown/mermaid) for the customer's codebase at the sync time shown. Use it for system structure, module relationships, and high-level behavior; verify critical details against retrieved code excerpts when they disagree (code wins for line-level truth).`

function buildDigestFromArtifacts(
  files: { path: string; content: string }[],
  completedAt: string | null
): string {
  const byPath = new Map(files.map((f) => [f.path.replace(/\\/g, '/'), f.content]))
  const order: string[] = []
  const pushIf = (p: string) => {
    if (byPath.has(p)) order.push(p)
  }
  pushIf('overview.md')
  pushIf('metadata.json')
  const mods = [...byPath.keys()]
    .filter((p) => /^module.*\.md$/i.test(p.split('/').pop() || '') || p.endsWith('.md'))
    .filter((p) => p !== 'overview.md')
    .sort((a, b) => a.localeCompare(b))
  for (const p of mods) {
    if (!order.includes(p)) order.push(p)
  }
  for (const p of [...byPath.keys()].sort((a, b) => a.localeCompare(b))) {
    if (!order.includes(p)) order.push(p)
  }

  let out = `## Repository overview\n_Generated at ${completedAt ?? 'unknown time'}._\n\n`
  for (const p of order) {
    const body = byPath.get(p)
    if (!body) continue
    const block = `### File: ${p}\n\n${body}\n\n---\n\n`
    if (out.length + block.length > MAX_DIGEST_CHARS) {
      out += `\n_[Additional overview files omitted to stay within context budget.]_\n`
      break
    }
    out += block
  }
  return out
}

async function fetchRepoName(supabase: SupabaseClient, workspaceId: string, repositoryId: string): Promise<string> {
  const { data } = await supabase
    .from('pk_linked_repositories')
    .select('name, slug')
    .eq('id', repositoryId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return (data?.name || data?.slug || '') as string
}

/**
 * Latest succeeded overview run for a repository (any branch).
 */
export async function loadCodewikiDigestLatestForRepository(
  supabase: SupabaseClient,
  workspaceId: string,
  repositoryId: string
): Promise<CodewikiDigestBundle | null> {
  const [{ data: run, error }, repoName] = await Promise.all([
    supabase
      .from('pk_codewiki_runs')
      .select('id, completed_at')
      .eq('workspace_id', workspaceId)
      .eq('repository_id', repositoryId)
      .eq('status', 'succeeded')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    fetchRepoName(supabase, workspaceId, repositoryId),
  ])

  if (error || !run?.id) return null

  const { data: files, error: fErr } = await supabase
    .from('pk_codewiki_files')
    .select('path, content')
    .eq('run_id', run.id as string)

  if (fErr || !files?.length) return null

  const completedAt = (run.completed_at as string) ?? null
  return {
    digest: buildDigestFromArtifacts(files as { path: string; content: string }[], completedAt),
    completedAt,
    styleNote: STYLE_NOTE,
    repoName,
  }
}

export async function loadCodewikiDigestForRepoBranch(
  supabase: SupabaseClient,
  workspaceId: string,
  repositoryId: string,
  syncBranch: string
): Promise<CodewikiDigestBundle | null> {
  const [{ data: run, error }, repoName] = await Promise.all([
    supabase
      .from('pk_codewiki_runs')
      .select('id, completed_at')
      .eq('workspace_id', workspaceId)
      .eq('repository_id', repositoryId)
      .eq('sync_branch', syncBranch)
      .eq('status', 'succeeded')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    fetchRepoName(supabase, workspaceId, repositoryId),
  ])

  if (error || !run?.id) return null

  const { data: files, error: fErr } = await supabase
    .from('pk_codewiki_files')
    .select('path, content')
    .eq('run_id', run.id as string)

  if (fErr || !files?.length) return null

  const completedAt = (run.completed_at as string) ?? null
  return {
    digest: buildDigestFromArtifacts(files as { path: string; content: string }[], completedAt),
    completedAt,
    styleNote: STYLE_NOTE,
    repoName,
  }
}

/**
 * For workspace-wide queries: include the latest overview digest per (repository_id, sync_branch) pair.
 */
export async function loadCodewikiDigestsForWorkspace(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<CodewikiDigestBundle | null> {
  const { data: runs, error } = await supabase
    .from('pk_codewiki_runs')
    .select('id, repository_id, sync_branch, completed_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'succeeded')
    .order('completed_at', { ascending: false })

  if (error || !runs?.length) return null

  const seen = new Set<string>()
  const picked: { id: string; repository_id: string; sync_branch: string; completed_at: string | null }[] = []
  for (const r of runs as typeof picked) {
    const key = `${r.repository_id}\0${r.sync_branch}`
    if (seen.has(key)) continue
    seen.add(key)
    picked.push(r)
    if (picked.length >= 12) break
  }

  // Fetch repo names for all unique repository IDs
  const uniqueRepoIds = [...new Set(picked.map((p) => p.repository_id))]
  const { data: repoRows } = await supabase
    .from('pk_linked_repositories')
    .select('id, name, slug')
    .in('id', uniqueRepoIds)
    .eq('workspace_id', workspaceId)
  const repoNameMap = new Map<string, string>()
  for (const r of (repoRows ?? []) as { id: string; name: string; slug: string }[]) {
    repoNameMap.set(r.id, r.name || r.slug || r.id.slice(0, 8))
  }

  let combined = `## Documentation overview (${picked.length} repository snapshot(s))\n\n`
  const repoNamesUsed: string[] = []

  for (const pr of picked) {
    const { data: files } = await supabase
      .from('pk_codewiki_files')
      .select('path, content')
      .eq('run_id', pr.id)

    if (!files?.length) continue
    const rName = repoNameMap.get(pr.repository_id) ?? pr.repository_id.slice(0, 8)
    if (!repoNamesUsed.includes(rName)) repoNamesUsed.push(rName)
    const digest = buildDigestFromArtifacts(files as { path: string; content: string }[], pr.completed_at)
    const chunk = `### Repository: ${rName}: branch \`${pr.sync_branch || '(default)'}\`\n\n${digest}\n\n`
    if (combined.length + chunk.length > MAX_DIGEST_CHARS) {
      combined += `\n_[Additional repositories omitted for context budget.]_\n`
      break
    }
    combined += chunk
  }

  if (combined.length < 80) return null
  const repoName = repoNamesUsed.length === 1 ? repoNamesUsed[0] : repoNamesUsed.join(', ')
  return {
    digest: combined,
    completedAt: picked[0]?.completed_at ?? null,
    styleNote: STYLE_NOTE,
    repoName,
  }
}
