import { NextRequest, NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/server-client'

const STALE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Enqueues sync jobs for linked repos whose last_sync_at is older than 14 days (or null).
 * Protect with header x-cron-secret matching env CRON_SECRET.
 */
export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  const secret = request.headers.get('x-cron-secret')
  if (secret !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceRoleClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Service role not configured' }, { status: 503 })
  }

  const now = Date.now()
  const { data: repos, error: rErr } = await supabase.from('pk_linked_repositories').select('*')
  if (rErr) {
    return NextResponse.json({ error: rErr.message }, { status: 500 })
  }

  let enqueued = 0
  for (const r of repos ?? []) {
    const last = r.last_sync_at ? new Date(r.last_sync_at as string).getTime() : 0
    if (last && now - last < STALE_MS) continue

    const wsId = r.workspace_id as string
    const { data: bb } = await supabase.from('pk_bitbucket_connections').select('workspace_id').eq('workspace_id', wsId).maybeSingle()
    if (!bb) continue

    const { data: ws } = await supabase.from('pk_workspaces').select('created_by').eq('id', wsId).maybeSingle()
    const requestedBy = ws?.created_by as string | undefined
    if (!requestedBy) continue

    const branch = (r.default_branch as string) || 'main'
    const bbWs = r.bitbucket_workspace as string
    const slug = r.slug as string

    const { error: insErr } = await supabase.from('pk_sync_jobs').insert({
      workspace_id: wsId,
      repository_id: r.id,
      requested_by: requestedBy,
      status: 'queued',
      branch,
      meta: {
        bitbucket_workspace: bbWs,
        repo_slug: slug,
        cron: 'enqueue-stale-syncs',
      },
    })
    if (!insErr) enqueued += 1
  }

  return NextResponse.json({ ok: true, enqueued })
}
