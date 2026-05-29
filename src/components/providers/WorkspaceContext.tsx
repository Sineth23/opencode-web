'use client'

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { authorizedFetch } from '@/lib/api'
import { isCognitoConfigured } from '@/lib/cognito'
import { cdkGet } from '@/lib/cdk-api'
import { subscribeToActiveTenant, resolveIsSuperAdmin } from '@/lib/use-super-admin'

export type WorkspaceSummary = {
  id: string
  name: string
  created_at: string
  billing_plan?: string
  allowed_integration_slugs?: string[]
  membership_role?: string
}

type TenantResponse = {
  ok: boolean
  tenant?: {
    tenantId: string
    companyName: string
    bucketName?: string
    status?: string
    createdAt?: string
  }
  role?: string
  error?: string
}

type Ctx = {
  workspace: WorkspaceSummary | null
  loading: boolean
  noTenant: boolean
  refresh: () => Promise<void>
}

const WorkspaceContext = createContext<Ctx | null>(null)

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [noTenant, setNoTenant] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setNoTenant(false)
    try {
      if (isCognitoConfigured()) {
        // Use CDK API — tenant is the equivalent of a workspace
        // withTenantId() in cdkFetch auto-injects ?tenantId= for SuperAdmin overrides
        const data = await cdkGet<TenantResponse>('/tenant')
        if (data.ok && data.tenant) {
          setWorkspace({
            id: data.tenant.tenantId,
            name: data.tenant.companyName,
            created_at: data.tenant.createdAt ?? '',
            billing_plan: 'standard',
            allowed_integration_slugs: [],
            membership_role: data.role ?? 'member',
          })
        } else {
          // SuperAdmins have no personal tenant — never show TenantSetup to them
          const superAdmin = await resolveIsSuperAdmin()
          if (superAdmin) {
            setWorkspace(null)
          } else {
            setNoTenant(true)
            setWorkspace(null)
          }
        }
        return
      }

      // Supabase path
      const res = await authorizedFetch('/api/workspace')
      if (!res.ok) throw new Error('workspace fetch failed')
      const data = (await res.json()) as { workspaces: WorkspaceSummary[] }
      const first = data.workspaces[0]
      if (first) {
        setWorkspace(first)
      } else {
        const create = await authorizedFetch('/api/workspace', { method: 'POST' })
        if (!create.ok) throw new Error('workspace create failed')
        const created = (await create.json()) as { workspace: WorkspaceSummary }
        setWorkspace({
          ...created.workspace,
          membership_role: created.workspace.membership_role ?? 'owner',
        })
      }
    } catch (e) {
      console.error(e)
      setWorkspace(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Re-fetch workspace when SuperAdmin switches active tenant
  useEffect(() => {
    return subscribeToActiveTenant(() => void refresh())
  }, [refresh])

  return (
    <WorkspaceContext.Provider value={{ workspace, loading, noTenant, refresh }}>{children}</WorkspaceContext.Provider>
  )
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace outside provider')
  return ctx
}
