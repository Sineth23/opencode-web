'use client'

import { useEffect, useState } from 'react'
import { BuildingOfficeIcon, ChevronDownIcon } from '@heroicons/react/20/solid'
import { Menu, Transition } from '@headlessui/react'
import { Fragment } from 'react'
import { cdkGet } from '@/lib/cdk-api'
import { useSuperAdmin } from '@/lib/use-super-admin'

type Tenant = {
  tenantId: string
  companyName: string
  status: string
}

export default function SuperAdminSwitcher() {
  const { isSuperAdmin, activeTenantId, setActiveTenantId, loading } = useSuperAdmin()
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [fetching, setFetching] = useState(false)

  useEffect(() => {
    if (!isSuperAdmin) return
    setFetching(true)
    cdkGet<{ ok: boolean; tenants: Tenant[] }>('/admin/tenants')
      .then((d) => setTenants(d.tenants ?? []))
      .catch(() => {/* silent — user may not have superadmin yet */})
      .finally(() => setFetching(false))
  }, [isSuperAdmin])

  if (loading || !isSuperAdmin) return null

  const active = tenants.find((t) => t.tenantId === activeTenantId)

  return (
    <Menu as="div" className="relative">
      <Menu.Button className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 transition-colors">
        <BuildingOfficeIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="max-w-[140px] truncate">
          {fetching ? 'Loading…' : active?.companyName ?? 'All tenants'}
        </span>
        <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-amber-600" />
      </Menu.Button>

      <Transition
        as={Fragment}
        enter="transition ease-out duration-100"
        enterFrom="transform opacity-0 scale-95"
        enterTo="transform opacity-100 scale-100"
        leave="transition ease-in duration-75"
        leaveFrom="transform opacity-100 scale-100"
        leaveTo="transform opacity-0 scale-95"
      >
        <Menu.Items className="absolute left-0 mt-1 w-64 origin-top-left rounded-lg bg-white shadow-lg ring-1 ring-black/5 py-1 z-50 max-h-72 overflow-y-auto">
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            SuperAdmin — switch tenant
          </div>

          <Menu.Item>
            {({ active: a }) => (
              <button
                type="button"
                onClick={() => setActiveTenantId(null)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm ${
                  a ? 'bg-gray-50' : ''
                } ${!activeTenantId ? 'text-primary font-medium' : 'text-gray-700'}`}
              >
                <span className="h-2 w-2 rounded-full bg-gray-300 shrink-0" />
                My own tenant
              </button>
            )}
          </Menu.Item>

          <div className="my-1 border-t border-gray-100" />

          {tenants.map((t) => (
            <Menu.Item key={t.tenantId}>
              {({ active: a }) => (
                <button
                  type="button"
                  onClick={() => setActiveTenantId(t.tenantId)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-sm ${
                    a ? 'bg-gray-50' : ''
                  } ${activeTenantId === t.tenantId ? 'text-primary font-medium' : 'text-gray-700'}`}
                >
                  <span className={`h-2 w-2 rounded-full shrink-0 ${
                    activeTenantId === t.tenantId ? 'bg-primary' : 'bg-gray-200'
                  }`} />
                  <span className="truncate">{t.companyName}</span>
                </button>
              )}
            </Menu.Item>
          ))}

          {!fetching && tenants.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-400">No tenants found</p>
          )}
        </Menu.Items>
      </Transition>
    </Menu>
  )
}
