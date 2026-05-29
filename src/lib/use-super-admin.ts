'use client'

import { useEffect, useState } from 'react'
import { cognitoGetIdToken } from '@/lib/cognito'

const SUPERADMIN_GROUP = 'autodoc-superadmin'
const STORAGE_KEY = 'autodoc_superadmin_tenant'

type SuperAdminState = {
  isSuperAdmin: boolean
  activeTenantId: string | null
  setActiveTenantId: (id: string | null) => void
  loading: boolean
}

// Module-level state — read from localStorage on first import so it survives page refreshes
const _stored = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
let _activeTenantId: string | null = _stored || null
const _listeners = new Set<() => void>()
let _isSuperAdmin: boolean | null = null  // cached after first JWT decode

function notifyListeners() {
  _listeners.forEach((fn) => fn())
}

export function setGlobalActiveTenant(id: string | null) {
  _activeTenantId = id
  if (typeof window !== 'undefined') {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  }
  notifyListeners()
}

export function getActiveTenantId(): string | null {
  return _activeTenantId
}

export function subscribeToActiveTenant(fn: () => void): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}

export async function resolveIsSuperAdmin(): Promise<boolean> {
  if (_isSuperAdmin !== null) return _isSuperAdmin
  try {
    const token = await cognitoGetIdToken()
    if (token) {
      const groups = decodeJwtGroups(token)
      _isSuperAdmin = groups.includes(SUPERADMIN_GROUP)
    } else {
      _isSuperAdmin = false
    }
  } catch {
    _isSuperAdmin = false
  }
  return _isSuperAdmin
}

function decodeJwtGroups(token: string): string[] {
  try {
    const payload = token.split('.')[1]
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    const raw = decoded['cognito:groups']
    if (!raw) return []
    if (Array.isArray(raw)) return raw as string[]
    if (typeof raw === 'string') return raw.trim().startsWith('[')
      ? JSON.parse(raw) as string[]
      : raw.split(' ').filter(Boolean)
    return []
  } catch {
    return []
  }
}

export function useSuperAdmin(): SuperAdminState {
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const [activeTenantId, setLocalTenantId] = useState<string | null>(_activeTenantId)
  const [loading, setLoading] = useState(true)

  // Check JWT for superadmin group on mount
  useEffect(() => {
    void (async () => {
      try {
        const token = await cognitoGetIdToken()
        if (token) {
          const groups = decodeJwtGroups(token)
          setIsSuperAdmin(groups.includes(SUPERADMIN_GROUP))
        }
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // Subscribe to global tenant changes
  useEffect(() => {
    const sync = () => setLocalTenantId(_activeTenantId)
    _listeners.add(sync)
    return () => { _listeners.delete(sync) }
  }, [])

  function setActiveTenantId(id: string | null) {
    setGlobalActiveTenant(id)
    setLocalTenantId(id)
  }

  return { isSuperAdmin, activeTenantId, setActiveTenantId, loading }
}
