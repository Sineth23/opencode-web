/** Doc section categories: plain-language, operations-focused */
export type DocSectionCategory =
  | 'features'
  | 'workflows'
  | 'configurations'
  | 'communications'
  | 'reporting'
  | 'workarounds'
  | 'system_overview'
  | 'integration_surface'
  | 'capabilities'
  /** AI-generated policy / operating-model articles (doc_archetype policy) */
  | 'operations_policy'
  /** AI-generated ordered procedures (doc_archetype sop) */
  | 'operations_sop'
  /** AI-generated scenario playbooks (doc_archetype playbook) */
  | 'operations_playbook'
  /** Buyer / CS / PM-facing capability briefs (doc_archetype feature_brief) */
  | 'operations_feature_brief'
  /** Deep UI- and workflow-grounded use-case guides (doc_archetype use_case) */
  | 'operations_use_case'

/** Row storage: handbook vs operational archetypes */
export type DocArchetype = 'handbook' | 'policy' | 'sop' | 'playbook' | 'feature_brief' | 'use_case'

export type SyncJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface SyncJobSummary {
  id: string
  status: SyncJobStatus
  started_at: string | null
  completed_at: string | null
  error_message: string | null
}

export interface LinkedRepositoryRow {
  id: string
  workspace_id: string
  name: string
  slug: string
  default_branch: string
  last_sync_at: string | null
}

export interface DocSectionRow {
  id: string
  workspace_id: string
  category: DocSectionCategory
  title: string
  summary: string | null
  body_md: string
  source_paths: string[] | null
  updated_at: string
  doc_archetype?: DocArchetype
}

export interface ChatMessageSource {
  label: string
  path?: string
  doc_section_id?: string
  confidence: 'high' | 'medium' | 'low'
}
