import type { SupabaseClient } from '@supabase/supabase-js'

function topLevelRoots(paths: string[]): string[] {
  const roots = new Set<string>()
  for (const p of paths) {
    const t = p.replace(/^\//, '')
    const i = t.indexOf('/')
    roots.add(i === -1 ? t || '.' : t.slice(0, i))
  }
  return [...roots].filter((r) => r && r !== '.').slice(0, 40)
}

function countUnderPrefix(paths: string[], prefix: string): number {
  const pre = prefix.endsWith('/') ? prefix : `${prefix}/`
  return paths.filter((p) => p === prefix || p.startsWith(pre)).length
}

/**
 * Derives a minimal module graph from ingested file paths (Layer 1–2 seed).
 * Idempotent per repository via metadata.ingest + repository_id.
 */
export async function rebuildRepoStructureGraph(
  supabase: SupabaseClient,
  opts: {
    workspaceId: string
    repositoryId: string
    filePaths: string[]
    workspaceName?: string
  }
): Promise<void> {
  const { workspaceId, repositoryId, filePaths } = opts

  const { data: oldMods } = await supabase
    .from('pk_system_entities')
    .select('id')
    .eq('workspace_id', workspaceId)
    .filter('metadata->>ingest', 'eq', 'path_module')
    .filter('metadata->>repository_id', 'eq', repositoryId)

  const oldIds = (oldMods ?? []).map((r) => r.id as string)
  if (oldIds.length > 0) {
    await supabase.from('pk_system_edges').delete().eq('workspace_id', workspaceId).in('from_entity_id', oldIds)
    await supabase.from('pk_system_edges').delete().eq('workspace_id', workspaceId).in('to_entity_id', oldIds)
    await supabase.from('pk_system_entities').delete().in('id', oldIds)
  }

  let rootId: string
  const { data: existingRoot } = await supabase
    .from('pk_system_entities')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'system_root')
    .maybeSingle()

  if (existingRoot?.id) {
    rootId = existingRoot.id as string
    await supabase
      .from('pk_system_entities')
      .update({
        title: opts.workspaceName?.trim() || 'Product system',
        summary: 'Top-level view of modules derived from repository layout.',
        updated_at: new Date().toISOString(),
      })
      .eq('id', rootId)
  } else {
    const { data: inserted, error } = await supabase
      .from('pk_system_entities')
      .insert({
        workspace_id: workspaceId,
        kind: 'system_root',
        title: opts.workspaceName?.trim() || 'Product system',
        summary: 'Top-level view of modules derived from repository layout.',
        metadata: { ingest: 'workspace_root' },
        source_kind: 'bitbucket',
      })
      .select('id')
      .single()
    if (error || !inserted) {
      console.error('structure graph root', error)
      return
    }
    rootId = inserted.id as string
  }

  const roots = topLevelRoots(filePaths)
  if (roots.length === 0) return

  for (const name of roots) {
    const n = countUnderPrefix(filePaths, name)
    const complexity = Math.min(1, n / 45)
    const { data: mod, error: modErr } = await supabase
      .from('pk_system_entities')
      .insert({
        workspace_id: workspaceId,
        kind: 'module',
        title: name,
        summary: `Module folder "${name}": ${n} tracked source files in this sync.`,
        metadata: { ingest: 'path_module', repository_id: repositoryId, top_level: name },
        source_paths: filePaths.filter((p) => p === name || p.startsWith(`${name}/`)).slice(0, 200),
        complexity_score: complexity,
        risk_score: complexity > 0.65 ? 0.45 : 0.2,
        source_kind: 'bitbucket',
      })
      .select('id')
      .single()
    if (modErr || !mod) continue
    const modId = mod.id as string
    await supabase.from('pk_system_edges').insert({
      workspace_id: workspaceId,
      from_entity_id: rootId,
      to_entity_id: modId,
      relation: 'contains',
      confidence: 0.9,
      provenance: { source: 'path_tree', repository_id: repositoryId },
    })
  }
}
