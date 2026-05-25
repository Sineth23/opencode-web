import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { createRouteHandlerClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'
import { buildHandbookPdfBuffer } from '@/server/docs/handbook-pdf'

export const runtime = 'nodejs'

const querySchema = z.object({
  workspace_id: z.string().uuid(),
  repository_id: z.string().uuid().optional(),
  /** Branch name, or omit / empty with repository_id for “all branches combined” (stored as ''). */
  branch: z.string().max(200).optional(),
})

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'handbook'
}

export async function GET(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { workspace_id, repository_id, branch } = parsed.data

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 })
  }

  let q = supabase
    .from('pk_doc_sections')
    .select('category, title, summary, body_md, source_paths')
    .eq('workspace_id', workspace_id)
    .eq('doc_archetype', 'handbook')
    .order('category')
    .order('title')

  if (repository_id) {
    q = q.eq('repository_id', repository_id).eq('sync_branch', branch?.trim() ?? '')
  } else {
    q = q.is('repository_id', null).eq('sync_branch', '')
  }

  const { data: rows, error } = await q
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!rows?.length) {
    return NextResponse.json({ error: 'No handbook sections for this scope' }, { status: 404 })
  }

  let repoLabel = 'Workspace-wide handbook'
  if (repository_id) {
    const { data: link } = await supabase
      .from('pk_linked_repositories')
      .select('slug')
      .eq('id', repository_id)
      .maybeSingle()
    const slug = link?.slug ?? repository_id.slice(0, 8)
    const br = branch?.trim() ? `Branch: ${branch.trim()}` : 'All branches combined'
    repoLabel = `${slug} · ${br}`
  }

  const scopeLine = repository_id ? repoLabel : 'All organization sources'

  const buf = await buildHandbookPdfBuffer({
    workspaceName: access.workspace.name,
    repoLabel,
    scopeLine,
    generatedAt: new Date().toISOString(),
    sections: rows.map((r) => ({
      category: String(r.category),
      title: String(r.title),
      summary: r.summary as string | null,
      bodyMd: String(r.body_md),
      sourcePaths: (r.source_paths as string[] | null) ?? null,
    })),
  })

  const fname = `handbook-${slugify(access.workspace.name)}-${repository_id ? slugify(repoLabel) : 'org'}.pdf`

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'no-store',
    },
  })
}
