'use client'

import { useCallback, useEffect, useState } from 'react'
import ReactFlow, { Background, Controls, MiniMap, useEdgesState, useNodesState, type Edge, type Node } from 'reactflow'
import 'reactflow/dist/style.css'
import Link from 'next/link'
import { authorizedFetch } from '@/lib/api'
import { useWorkspace } from '@/components/providers/WorkspaceContext'
import { withSupportContact } from '@/lib/support-copy'

type GNode = {
  id: string
  kind: string
  title: string
  summary: string | null
  complexity_score?: number | null
  risk_score?: number | null
}

type GEdge = {
  id: string
  from_entity_id: string
  to_entity_id: string
  relation: string
  confidence: number
}

function layoutNodes(raw: GNode[]): Node[] {
  const cols = 4
  return raw.map((n, i) => ({
    id: n.id,
    position: { x: (i % cols) * 260, y: Math.floor(i / cols) * 130 },
    data: {
      label: `${n.kind.replace(/_/g, ' ')} · ${n.title}`,
      kind: n.kind,
      summary: n.summary,
      complexity: n.complexity_score,
      risk: n.risk_score,
    },
    style: {
      borderRadius: 12,
      border: '1px solid var(--color-border, #e5e7eb)',
      padding: 8,
      fontSize: 12,
      width: 220,
      background: 'var(--color-surface, #fff)',
    },
  }))
}

function toFlowEdges(raw: GEdge[]): Edge[] {
  return raw.map((e) => ({
    id: e.id,
    source: e.from_entity_id,
    target: e.to_entity_id,
    label: e.relation,
    style: { stroke: '#64748b', strokeWidth: 1.5 },
    labelStyle: { fontSize: 10, fill: '#64748b' },
  }))
}

export default function SystemMapPage() {
  const { workspace } = useWorkspace()
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!workspace?.id) return
    setLoading(true)
    setErr(null)
    try {
      const res = await authorizedFetch(`/api/workspace/graph?workspace_id=${workspace.id}`)
      const j = (await res.json()) as { nodes?: GNode[]; edges?: GEdge[]; error?: string }
      if (!res.ok) {
        setErr(withSupportContact(j.error || 'Could not load graph'))
        setNodes([])
        setEdges([])
        return
      }
      setNodes(layoutNodes(j.nodes ?? []))
      setEdges(toFlowEdges(j.edges ?? []))
    } catch {
      setErr(withSupportContact('Network error'))
      setNodes([])
      setEdges([])
    } finally {
      setLoading(false)
    }
  }, [workspace?.id, setNodes, setEdges])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="h-[calc(100vh-6rem)] flex flex-col max-w-[1400px] mx-auto">
      <div className="mb-4 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-[var(--color-text-primary)]">System map</h1>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)] max-w-2xl">
            Modules and relationships from your last sync, plus a preview of the &quot;outside the repo&quot; layer. Drag nodes,
            zoom, and use this as the control panel for how the system is structured.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="pk-btn-secondary text-sm px-4 py-2"
            disabled={loading}
          >
            Refresh
          </button>
          <Link href="/settings/sync" className="pk-btn-primary text-sm px-4 py-2 inline-flex items-center">
            Run sync
          </Link>
        </div>
      </div>

      {err && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-950">
          {err}. Apply migration <code className="text-xs">006_system_entities_graph.sql</code> if the graph tables are missing.
        </div>
      )}

      <div className="flex-1 min-h-[480px] rounded-[var(--radius-lg)] border border-[var(--color-border)] overflow-hidden bg-[var(--color-bg-secondary)]">
        {loading ? (
          <div className="h-full flex items-center justify-center text-sm text-[var(--color-text-tertiary)]">Loading graph…</div>
        ) : nodes.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6 text-[var(--color-text-secondary)] text-sm">
            <p>No graph yet. Queue a sync from Sync center; modules are built from your repository tree after each sync.</p>
            <Link href="/settings/sync" className="mt-3 text-primary font-medium hover:underline">
              Open Sync center
            </Link>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            fitView
            minZoom={0.2}
            maxZoom={1.4}
          >
            <MiniMap zoomable pannable />
            <Controls />
            <Background gap={16} />
          </ReactFlow>
        )}
      </div>
    </div>
  )
}
