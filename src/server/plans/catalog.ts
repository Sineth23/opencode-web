export type BillingPlan = 'standard' | 'professional' | 'enterprise'

export const BILLING_PLANS: BillingPlan[] = ['standard', 'professional', 'enterprise']

export type IntegrationSlug = 'bitbucket' | 'github' | 'gitlab' | 'jira' | 'confluence' | 'slack'

export type FeatureKey = 'manage_integrations' | 'trigger_sync' | 'queue_doc_refresh'

export const KNOWN_INTEGRATION_SLUGS: IntegrationSlug[] = [
  'bitbucket',
  'github',
  'gitlab',
  'jira',
  'confluence',
  'slack',
]

export const IMPLEMENTED_INTEGRATION_SLUGS: IntegrationSlug[] = ['bitbucket']

const PLAN_RANK: Record<BillingPlan, number> = {
  standard: 0,
  professional: 1,
  enterprise: 2,
}

/** Default integration allowlist when an org is assigned this plan (admin can override). */
export function defaultIntegrationSlugsForPlan(plan: BillingPlan): IntegrationSlug[] {
  switch (plan) {
    case 'standard':
      return ['bitbucket']
    case 'professional':
      return ['bitbucket', 'github', 'gitlab']
    case 'enterprise':
      return [...KNOWN_INTEGRATION_SLUGS]
    default:
      return ['bitbucket']
  }
}

export function normalizeIntegrationSlug(raw: string): IntegrationSlug | null {
  const s = raw.trim().toLowerCase()
  return (KNOWN_INTEGRATION_SLUGS as string[]).includes(s) ? (s as IntegrationSlug) : null
}

export function sanitizeIntegrationAllowlist(slugs: string[]): IntegrationSlug[] {
  const out: IntegrationSlug[] = []
  const seen = new Set<string>()
  for (const raw of slugs) {
    const n = normalizeIntegrationSlug(raw)
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

export function integrationCatalog() {
  return [
    {
      slug: 'bitbucket' as const,
      name: 'Bitbucket Cloud',
      tagline: 'Repositories and pull requests for grounded docs and answers.',
      minPlan: 'standard' as const,
    },
    {
      slug: 'github' as const,
      name: 'GitHub',
      tagline: 'Connect orgs and repos the same way, ideal when your code lives on GitHub.',
      minPlan: 'professional' as const,
    },
    {
      slug: 'gitlab' as const,
      name: 'GitLab',
      tagline: 'Self-managed or GitLab.com: bring merge requests and CI context in.',
      minPlan: 'professional' as const,
    },
    {
      slug: 'jira' as const,
      name: 'Jira Cloud',
      tagline: 'Issues and epics as first-class context for workflows and timelines.',
      minPlan: 'enterprise' as const,
    },
    {
      slug: 'confluence' as const,
      name: 'Confluence',
      tagline: 'Link wikis and decision logs next to code for richer documentation.',
      minPlan: 'enterprise' as const,
    },
    {
      slug: 'slack' as const,
      name: 'Slack',
      tagline: 'Optional notifications and assistant surfaces where your team already works.',
      minPlan: 'enterprise' as const,
    },
  ]
}

export function planLabel(plan: BillingPlan): string {
  switch (plan) {
    case 'standard':
      return 'Standard'
    case 'professional':
      return 'Professional'
    case 'enterprise':
      return 'Enterprise'
    default:
      return plan
  }
}

export function planElevatorPitch(plan: BillingPlan): string {
  switch (plan) {
    case 'standard':
      return 'Core code connectors and team workspace, perfect to prove value with one source of truth.'
    case 'professional':
      return 'Multiple Git hosts and faster iteration for growing product orgs.'
    case 'enterprise':
      return 'Tickets, wikis, messaging, and priority support, built for regulated and multi-tool fleets.'
    default:
      return ''
  }
}

export function roleDefaultFeatureFlags(role: 'owner' | 'admin' | 'member'): Record<FeatureKey, boolean> {
  if (role === 'member') {
    return {
      manage_integrations: false,
      trigger_sync: false,
      queue_doc_refresh: false,
    }
  }
  return {
    manage_integrations: true,
    trigger_sync: true,
    queue_doc_refresh: true,
  }
}

export function resolveFeatureFlags(
  role: 'owner' | 'admin' | 'member',
  permissionFlags: Record<string, unknown> | null | undefined
): Record<FeatureKey, boolean> {
  const base = roleDefaultFeatureFlags(role)
  const flags = permissionFlags && typeof permissionFlags === 'object' ? permissionFlags : {}
  const pick = (k: FeatureKey): boolean => {
    const v = flags[k]
    return typeof v === 'boolean' ? v : base[k]
  }
  return {
    manage_integrations: pick('manage_integrations'),
    trigger_sync: pick('trigger_sync'),
    queue_doc_refresh: pick('queue_doc_refresh'),
  }
}

export function minimumPlanForSlug(slug: IntegrationSlug): BillingPlan {
  const row = integrationCatalog().find((r) => r.slug === slug)
  return row?.minPlan ?? 'enterprise'
}

export function planMeetsMinimum(current: BillingPlan, required: BillingPlan): boolean {
  return PLAN_RANK[current] >= PLAN_RANK[required]
}
