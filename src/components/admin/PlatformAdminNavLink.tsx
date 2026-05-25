'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ShieldCheckIcon } from '@heroicons/react/24/outline'
import { isSupabaseInitialized, supabase } from '@/lib/supabase'
import { isCognitoConfigured, cognitoGetIdToken } from '@/lib/cognito'

export default function PlatformAdminNavLink() {
  const pathname = usePathname()
  const [show, setShow] = useState(false)

  useEffect(() => {
    const run = async () => {
      let token: string | null = null
      if (isCognitoConfigured()) {
        token = cognitoGetIdToken()
      } else if (isSupabaseInitialized()) {
        const { data } = await supabase.auth.getSession()
        token = data.session?.access_token ?? null
      }
      if (!token) return
      const res = await fetch('/api/admin/me', { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return
      const json = (await res.json()) as { platformAdmin: boolean }
      setShow(json.platformAdmin)
    }
    void run()
  }, [])

  if (!show) return null

  const active = pathname?.startsWith('/admin')
  return (
    <Link
      href="/admin"
      className={`flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-sm font-medium transition-all ${
        active
          ? 'bg-amber-50 text-amber-900 shadow-sm ring-1 ring-amber-200/80'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border ${
          active ? 'border-amber-200 bg-white text-amber-800' : 'border-transparent bg-[var(--color-bg-tertiary)]/60 text-[var(--color-text-secondary)]'
        }`}
      >
        <ShieldCheckIcon className="h-5 w-5" aria-hidden />
      </span>
      <span className="truncate">Platform admin</span>
    </Link>
  )
}
