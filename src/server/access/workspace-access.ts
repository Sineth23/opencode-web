import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type BillingPlan,
  type FeatureKey,
  type IntegrationSlug,
  IMPLEMENTED_INTEGRATION_SLUGS,
  integrationCatalog,
  minimumPlanForSlug,
  planElevatorPitch,
  planLabel,
  planMeetsMinimum,
  resolveFeatureFlags,
} from '@/server/plans/catalog'

export type ResolvedMemberContext = {
  role: 'owner' | 'admin' | 'member'
  permission_flags: Record<string, unknown>
}

export type IntegrationAccessRow = {
  slug: IntegrationSlug
  name: string
  tagline: string
  org_enabled: boolean
  implemented: boolean
  user_can_connect: boolean
  user_can_use_when_ready: boolean
  upgrade_hint: string | null
  locked_reason: 'org_plan' | 'role' | 'not_built_yet' | null
}

export type WorkspaceAccessPayload = {
  workspace: {
    id: string
    name: string
    billing_plan: BillingPlan
    allowed_integration_slugs: IntegrationSlug[]
  }
  role: ResolvedMemberContext['role']
  effective_features: Record<FeatureKey, boolean>
  integrations: IntegrationAccessRow[]
  plan: { key: BillingPlan; label: string; pitch: string }
}

function parseBillingPlan(raw: string | null | undefined): BillingPlan {
  if (raw === 'professional' || raw === 'enterprise' || raw === 'standard') return raw
  return 'standard'
}

function parseAllowlist(raw: string[] | null | undefined): IntegrationSlug[] {
  if (!raw?.length) return ['bitbucket']
  const lower = raw.map((s) => s.trim().toLowerCase())
  const catalog = integrationCatalog()
  const known = new Set(catalog.map((c) => c.slug))
  return lower.filter((s): s is IntegrationSlug => known.has(s as IntegrationSlug))
}

export async function loadWorkspaceAccessForUser(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string
): Promise<WorkspaceAccessPayload | null> {
  const { data: ws, error: wsErr } = await supabase
    .from('pk_workspaces')
    .select('id, name, created_at, created_by, billing_plan, allowed_integration_slugs')
    .eq('id', workspaceId)
    .maybeSingle()

  if (wsErr || !ws) return null

  const { data: mem } = await supabase
    .from('pk_workspace_members')
    .select('role, permission_flags')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle()

  let role: 'owner' | 'admin' | 'member'
  let permission_flags: Record<string, unknown> = {}

  if (mem?.role === 'owner' || mem?.role === 'admin' || mem?.role === 'member') {
    role = mem.role
    permission_flags =
      mem.permission_flags && typeof mem.permission_flags === 'object' && !Array.isArray(mem.permission_flags)
        ? (mem.permission_flags as Record<string, unknown>)
        : {}
  } else if (ws.created_by === userId) {
    role = 'owner'
  } else {
    return null
  }

  const billing_plan = parseBillingPlan(ws.billing_plan as string)
  const allowed_integration_slugs = parseAllowlist(ws.allowed_integration_slugs as string[] | null)
  const effective_features = resolveFeatureFlags(role, permission_flags)

  const integrations: IntegrationAccessRow[] = integrationCatalog().map((item) => {
    const org_enabled = allowed_integration_slugs.includes(item.slug)
    const implemented = IMPLEMENTED_INTEGRATION_SLUGS.includes(item.slug)
    const user_can_connect = org_enabled && implemented && effective_features.manage_integrations
    const user_can_use_when_ready = org_enabled && effective_features.manage_integrations

    let locked_reason: IntegrationAccessRow['locked_reason'] = null
    let upgrade_hint: string | null = null

    if (!org_enabled) {
      locked_reason = 'org_plan'
      const need = minimumPlanForSlug(item.slug)
      upgrade_hint = `Included on ${planLabel(need)} and above. Contact your AutoDoc admin or support to enable ${item.name} for your organization.`
      if (!planMeetsMinimum(billing_plan, need)) {
        upgrade_hint = `Your workspace is on ${planLabel(billing_plan)}. ${planLabel(need)} unlocks ${item.name}; contact support to upgrade.`
      }
    } else if (!effective_features.manage_integrations) {
      locked_reason = 'role'
      upgrade_hint = `Your role can view integrations but not connect them. Ask an organization owner or admin, or request access from support.`
    } else if (!implemented) {
      locked_reason = 'not_built_yet'
      upgrade_hint = `${item.name} is approved for your organization and will appear here when the connector is enabled for your deployment. Contact support for early access.`
    }

    return {
      slug: item.slug,
      name: item.name,
      tagline: item.tagline,
      org_enabled,
      implemented,
      user_can_connect,
      user_can_use_when_ready,
      upgrade_hint,
      locked_reason,
    }
  })

  return {
    workspace: {
      id: ws.id,
      name: ws.name,
      billing_plan,
      allowed_integration_slugs,
    },
    role,
    effective_features,
    integrations,
    plan: {
      key: billing_plan,
      label: planLabel(billing_plan),
      pitch: planElevatorPitch(billing_plan),
    },
  }
}

export function integrationAllowedForWorkspace(allowlist: IntegrationSlug[], slug: IntegrationSlug): boolean {
  return allowlist.includes(slug)
}
