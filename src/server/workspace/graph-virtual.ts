/**
 * Layer 5 preview: synthetic nodes not yet backed by Confluence / tickets / CRM connectors.
 */

export type GraphEntityRow = {
  id: string
  workspace_id: string
  kind: string
  title: string
  summary: string | null
  metadata?: Record<string, unknown>
  complexity_score?: number | null
  risk_score?: number | null
}

export type GraphEdgeRow = {
  id: string
  workspace_id: string
  from_entity_id: string
  to_entity_id: string
  relation: string
  confidence: number
}

export function appendVirtualExternalReality(
  nodes: GraphEntityRow[],
  edges: GraphEdgeRow[],
  workspaceId: string
): void {
  const root = nodes.find((n) => n.kind === 'system_root')
  if (!root) return
  const vid = `virt_ext_${workspaceId}`
  if (nodes.some((n) => n.id === vid)) return
  nodes.push({
    id: vid,
    workspace_id: workspaceId,
    kind: 'external_service',
    title: 'Outside the repository',
    summary:
      'Vendor APIs, hosted services, and operational context that are not in Git. Future connectors (Confluence, Jira, CRM) land here.',
    metadata: { virtual: true, source_kind: 'unknown' },
    complexity_score: null,
    risk_score: 0.35,
  })
  edges.push({
    id: `virt_edge_${vid}`,
    workspace_id: workspaceId,
    from_entity_id: root.id,
    to_entity_id: vid,
    relation: 'integrates_with',
    confidence: 0.4,
  })
}
