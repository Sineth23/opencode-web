import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePlatformAdmin } from '@/server/admin/require-platform-admin'
import { defaultIntegrationSlugsForPlan, sanitizeIntegrationAllowlist, type BillingPlan } from '@/server/plans/catalog'
import {
  mergeOrgAiSettingsPatch,
  parseBillingPlanForAi,
  resolveOrgAiSettings,
} from '@/server/plans/org-ai-settings'

const orgAiFieldSchema = z
  .object({
    embedding_model: z.string().min(1).max(80).optional(),
    rag_standard_model: z.string().min(1).max(80).optional(),
    rag_premium_model: z.string().min(1).max(80).optional(),
    premium_rag_monthly_cap: z.number().int().min(0).max(1_000_000).nullable().optional(),
    doc_generation_model: z.string().min(1).max(80).optional(),
    force_standard_rag_only: z.boolean().optional(),
    skip_minified: z.boolean().optional(),
    ingest_max_file_bytes: z.number().int().min(65536).max(52428800).optional(),
    ingest_file_batch_size: z.number().int().min(5).max(200).optional(),
    ingest_request_delay_ms: z.number().int().min(0).max(5000).optional(),
    ingest_max_files: z.number().int().min(1).nullable().optional(),
    doc_max_chunk_rows: z.number().int().min(1000).max(2_000_000).optional(),
    doc_target_audience: z.string().min(1).max(180).nullable().optional(),
    doc_content_depth: z.enum(['overview', 'standard', 'deep']).nullable().optional(),
    handbook_voice: z.string().max(2000).nullable().optional(),
    handbook_depth_pass: z.boolean().nullable().optional(),
  })
  .strip()

const patchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    billing_plan: z.enum(['standard', 'professional', 'enterprise']).optional(),
    allowed_integration_slugs: z.array(z.string()).optional(),
    apply_default_integrations_for_plan: z.boolean().optional(),
    org_ai_settings: orgAiFieldSchema.optional(),
    /** When true with org_ai_settings, replaces the whole JSON object instead of merging keys. */
    org_ai_settings_replace: z.boolean().optional(),
    reset_org_ai_settings: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.billing_plan !== undefined ||
      b.allowed_integration_slugs !== undefined ||
      b.apply_default_integrations_for_plan !== undefined ||
      b.org_ai_settings !== undefined ||
      b.reset_org_ai_settings === true,
    { message: 'No changes' }
  )

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdmin(request)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const { db } = gate
  const { id } = await params

  const { data: ws, error } = await db
    .from('pk_workspaces')
    .select('id, name, created_by, created_at, billing_plan, allowed_integration_slugs, org_ai_settings')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!ws) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { data: bb } = await db.from('pk_bitbucket_connections').select('updated_at').eq('workspace_id', id).maybeSingle()

  const { count: memberCount } = await db
    .from('pk_workspace_members')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', id)

  const { count: repoCount } = await db
    .from('pk_linked_repositories')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', id)

  const { data: ownerUser } = await db.auth.admin.getUserById(ws.created_by)

  const plan = parseBillingPlanForAi(ws.billing_plan as string)
  const effective_org_ai = resolveOrgAiSettings(plan, ws.org_ai_settings)

  return NextResponse.json({
    workspace: {
      ...ws,
      created_by_email: ownerUser.user?.email ?? null,
      member_count: memberCount ?? 0,
      linked_repo_count: repoCount ?? 0,
      bitbucket: bb ? { connected: true, updated_at: bb.updated_at } : { connected: false },
      effective_org_ai,
    },
  })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdmin(request)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const { db } = gate
  const { id } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { data: existing } = await db
    .from('pk_workspaces')
    .select('billing_plan, org_ai_settings')
    .eq('id', id)
    .maybeSingle()
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const b = parsed.data
  let nextPlan: BillingPlan | undefined
  if (b.billing_plan !== undefined) {
    nextPlan = b.billing_plan
  }

  const mergedPlan: BillingPlan =
    nextPlan ??
    (existing.billing_plan === 'professional' || existing.billing_plan === 'enterprise' || existing.billing_plan === 'standard'
      ? existing.billing_plan
      : 'standard')

  let nextSlugs: string[] | undefined
  if (b.apply_default_integrations_for_plan) {
    nextSlugs = defaultIntegrationSlugsForPlan(mergedPlan)
  } else if (b.allowed_integration_slugs !== undefined) {
    nextSlugs = sanitizeIntegrationAllowlist(b.allowed_integration_slugs)
    if (nextSlugs.length === 0) {
      return NextResponse.json({ error: 'allowed_integration_slugs must include at least one known connector' }, { status: 400 })
    }
  }

  const updateRow: Record<string, unknown> = {}
  if (b.name !== undefined) updateRow.name = b.name
  if (nextPlan !== undefined) updateRow.billing_plan = nextPlan
  if (nextSlugs !== undefined) updateRow.allowed_integration_slugs = nextSlugs

  if (b.reset_org_ai_settings === true) {
    updateRow.org_ai_settings = {}
  } else if (b.org_ai_settings !== undefined) {
    if (b.org_ai_settings_replace === true) {
      updateRow.org_ai_settings = b.org_ai_settings
    } else {
      const cur = (existing.org_ai_settings as Record<string, unknown> | null) ?? {}
      updateRow.org_ai_settings = mergeOrgAiSettingsPatch(cur, b.org_ai_settings as Record<string, unknown>)
    }
  }

  if (Object.keys(updateRow).length === 0) {
    return NextResponse.json({ error: 'No changes' }, { status: 400 })
  }

  const { data, error } = await db
    .from('pk_workspaces')
    .update(updateRow)
    .eq('id', id)
    .select('id, name, created_by, created_at, billing_plan, allowed_integration_slugs, org_ai_settings')
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const planAfter = parseBillingPlanForAi(data.billing_plan as string)
  const effective_org_ai = resolveOrgAiSettings(planAfter, data.org_ai_settings)

  return NextResponse.json({ workspace: { ...data, effective_org_ai } })
}
