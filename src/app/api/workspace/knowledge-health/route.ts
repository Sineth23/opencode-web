import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

const querySchema = z.object({
  workspace_id: z.string().uuid(),
})

type ScopeRow = { repository_id: string; sync_branch: string; chunk_count: number }

/**
 * Sync center: chunk totals, latest repository overview run, latest guided-doc job, article count.
 */
export async function GET(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = querySchema.safeParse({
    workspace_id: request.nextUrl.searchParams.get('workspace_id'),
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'workspace_id required' }, { status: 400 })
  }

  const ws = parsed.data.workspace_id
  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, ws)
  if (!access) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const [scopeRes, cwRes, docRes, sectionsRes] = await Promise.all([
    supabase.rpc('pk_knowledge_scope', { p_workspace_id: ws }),
    supabase
      .from('pk_codewiki_runs')
      .select('id, status, sync_branch, repository_id, started_at, completed_at, error_message, meta')
      .eq('workspace_id', ws)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('pk_doc_generation_jobs')
      .select('id, status, created_at, started_at, completed_at, error_message')
      .eq('workspace_id', ws)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('pk_doc_sections').select('id', { count: 'exact', head: true }).eq('workspace_id', ws),
  ])

  if (scopeRes.error) {
    const msg = scopeRes.error.message
    const hint =
      msg.includes('pk_knowledge_scope') || msg.includes('function')
        ? 'Apply migration 009_knowledge_scope_branch.sql and reload PostgREST schema.'
        : msg
    return NextResponse.json(
      {
        error: hint,
        chunks: { total: 0, scope_available: false },
        overview_last: null,
        guided_doc_last: null,
        guided_section_count: null,
      },
      { status: 503 }
    )
  }

  const scopeRows = (scopeRes.data ?? []) as ScopeRow[]
  const totalChunks = scopeRows.reduce((acc, r) => acc + Number(r.chunk_count || 0), 0)
  const branchRows = scopeRows.length

  const cw = cwRes.error ? null : cwRes.data
  const overviewLast = cw
    ? {
        status: cw.status as string,
        sync_branch: (cw.sync_branch as string) ?? '',
        repository_id: cw.repository_id as string,
        started_at: cw.started_at as string,
        completed_at: (cw.completed_at as string) ?? null,
        error_message: (cw.error_message as string) ?? null,
        repo_slug:
          typeof (cw.meta as Record<string, unknown> | null)?.repo_slug === 'string'
            ? ((cw.meta as Record<string, unknown>).repo_slug as string)
            : null,
      }
    : null

  const dj = docRes.error ? null : docRes.data
  const guidedDocLast = dj
    ? {
        status: dj.status as string,
        created_at: dj.created_at as string,
        started_at: (dj.started_at as string) ?? null,
        completed_at: (dj.completed_at as string) ?? null,
        error_message: (dj.error_message as string) ?? null,
      }
    : null

  const sectionCount = sectionsRes.error ? null : sectionsRes.count ?? 0

  return NextResponse.json({
    chunks: {
      total: totalChunks,
      scope_available: true,
      branch_scopes: branchRows,
    },
    overview_last: overviewLast,
    guided_doc_last: guidedDocLast,
    guided_section_count: sectionCount,
  })
}
