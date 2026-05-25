import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'

const querySchema = z.object({
  workspace_id: z.string().uuid(),
})

type ScopeRow = { repository_id: string; sync_branch: string; chunk_count: number }

/**
 * Repositories and branches that currently have ingested chunks (for Assistant / doc scope UI).
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

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, parsed.data.workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const [{ data: repos, error: repoErr }, { data: scopeRows, error: scopeErr }] = await Promise.all([
    supabase
      .from('pk_linked_repositories')
      .select('id, name, slug, default_branch')
      .eq('workspace_id', parsed.data.workspace_id)
      .order('name'),
    supabase.rpc('pk_knowledge_scope', { p_workspace_id: parsed.data.workspace_id }),
  ])

  if (repoErr) {
    return NextResponse.json({ error: repoErr.message }, { status: 500 })
  }
  if (scopeErr) {
    return NextResponse.json(
      {
        error:
          scopeErr.message.includes('pk_knowledge_scope') || scopeErr.message.includes('function')
            ? 'Knowledge scope is unavailable. Apply Supabase migration 009_knowledge_scope_branch.sql.'
            : scopeErr.message,
      },
      { status: 503 }
    )
  }

  const byRepo = new Map<string, { branch: string; chunk_count: number }[]>()
  for (const row of (scopeRows ?? []) as ScopeRow[]) {
    const rid = row.repository_id
    const list = byRepo.get(rid) ?? []
    list.push({ branch: row.sync_branch, chunk_count: Number(row.chunk_count) })
    byRepo.set(rid, list)
  }

  const repositories = (repos ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    default_branch: r.default_branch as string,
    branches: (byRepo.get(r.id as string) ?? []).sort((a, b) => a.branch.localeCompare(b.branch)),
  }))

  return NextResponse.json({ repositories })
}
