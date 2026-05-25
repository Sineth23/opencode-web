import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase/server-client'

const listLimitSchema = z.coerce.number().int().min(1).max(500)

export async function GET(request: NextRequest) {
  const supabase = createRouteHandlerClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const jobId = request.nextUrl.searchParams.get('job_id')
  const workspaceId = request.nextUrl.searchParams.get('workspace_id')

  if (jobId) {
    const { data, error } = await supabase
      .from('pk_sync_jobs')
      .select('*')
      .eq('id', jobId)
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    return NextResponse.json({ job: data })
  }

  if (workspaceId) {
    const limRaw = request.nextUrl.searchParams.get('limit')
    const limParsed = limRaw ? listLimitSchema.safeParse(limRaw) : { success: true as const, data: 100 }
    const lim = limParsed.success ? limParsed.data : 100

    const { data, error } = await supabase
      .from('pk_sync_jobs')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(lim)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ jobs: data ?? [] })
  }

  return NextResponse.json({ error: 'job_id or workspace_id required' }, { status: 400 })
}
