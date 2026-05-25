import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient, createServiceRoleClient } from '@/lib/supabase/server-client'
import { loadWorkspaceAccessForUser } from '@/server/access/workspace-access'
import { userFacingBitbucketOrSyncError } from '@/lib/bitbucket-user-errors'
import { BitbucketCloudClient } from '@/server/integrations/bitbucket/client'
import { resolveBitbucketApiCredentials } from '@/server/integrations/bitbucket/auth-resolve'
import type { BitbucketMemberRepository } from '@/server/integrations/bitbucket/types'

const querySchema = z
  .object({
    workspace_id: z.string().uuid(),
    bb_workspace: z.string().min(1).optional(),
    repo_slug: z.string().min(1).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.repo_slug && !q.bb_workspace) {
      ctx.addIssue({ code: 'custom', message: 'bb_workspace is required when repo_slug is set' })
    }
  })

/**
 * Lists Bitbucket workspaces, repositories in a workspace, or branches in a repo using
 * PK_BITBUCKET_GIT_ACCESS_TOKEN (when set) or the stored OAuth token.
 *
 * Workspace list: prefers GET /repositories?role=member (rich), then GET /workspaces?role=member
 * when the first call fails or returns no workspaces (common for some token scopes).
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
    bb_workspace: request.nextUrl.searchParams.get('bb_workspace') ?? undefined,
    repo_slug: request.nextUrl.searchParams.get('repo_slug') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { workspace_id, bb_workspace, repo_slug } = parsed.data

  const access = await loadWorkspaceAccessForUser(supabase, userData.user.id, workspace_id)
  if (!access) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (!access.workspace.allowed_integration_slugs.includes('bitbucket')) {
    return NextResponse.json({ error: 'Bitbucket is not enabled for this organization.' }, { status: 403 })
  }

  const admin = createServiceRoleClient()
  if (!admin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  let creds: { accessToken: string; basicAuthUsername: string | null }
  try {
    creds = await resolveBitbucketApiCredentials(admin, workspace_id)
  } catch (e) {
    const raw = e instanceof Error ? e.message : 'Bitbucket is not connected'
    return NextResponse.json({ error: userFacingBitbucketOrSyncError(raw) }, { status: 400 })
  }

  const client = new BitbucketCloudClient({
    accessToken: creds.accessToken,
    basicAuthUsername: creds.basicAuthUsername,
  })

  if (!bb_workspace) {
    let memberRepositories: BitbucketMemberRepository[] = []
    let listErr: string | null = null
    try {
      memberRepositories = await client.listMemberRepositories()
    } catch (e) {
      listErr = e instanceof Error ? e.message : String(e)
    }
    const wsMap = new Map<string, string>()
    for (const r of memberRepositories) {
      if (!wsMap.has(r.workspaceSlug)) {
        wsMap.set(r.workspaceSlug, r.workspaceName || r.workspaceSlug)
      }
    }
    let usedWorkspaceListFallback = false
    if (wsMap.size === 0) {
      try {
        const fromWs = await client.listWorkspaces()
        for (const w of fromWs) {
          wsMap.set(w.slug, w.name || w.slug)
        }
        if (fromWs.length > 0) usedWorkspaceListFallback = true
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2)
        if (!listErr) listErr = msg
      }
    }
    const workspaces = [...wsMap.entries()]
      .map(([slug, name]) => ({ slug, name }))
      .sort((a, b) => a.slug.localeCompare(b.slug))
    if (workspaces.length > 0) {
      return NextResponse.json({
        workspaces,
        memberRepositories,
        ...(usedWorkspaceListFallback ? { used_workspace_list_fallback: true } : {}),
      })
    }
    return NextResponse.json(
      { error: userFacingBitbucketOrSyncError(listErr ?? 'Bitbucket did not return any workspaces.') },
      { status: 502 },
    )
  }

  if (!repo_slug) {
    let listErr: string | null = null
    let repositories: { slug: string; name: string; defaultBranch: string }[] = []
    try {
      const list = await client.listRepositories(bb_workspace)
      repositories = list.map((r) => ({
        slug: r.slug,
        name: r.name,
        defaultBranch: r.defaultBranch,
      }))
    } catch (e) {
      listErr = e instanceof Error ? e.message : String(e)
    }
    if (repositories.length > 0) {
      return NextResponse.json({ repositories })
    }
    return NextResponse.json(
      { error: userFacingBitbucketOrSyncError(listErr ?? 'Could not list repositories for this workspace.') },
      { status: 502 },
    )
  }

  try {
    const branches = await client.listBranchNames(bb_workspace, repo_slug)
    return NextResponse.json({ branches })
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: userFacingBitbucketOrSyncError(raw) }, { status: 502 })
  }
}
