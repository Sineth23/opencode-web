'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { isSupabaseInitialized, supabase } from '@/lib/supabase'
import AdminShell from '@/components/admin/AdminShell'

export default function AdminAuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [ready, setReady] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [platformAdmin, setPlatformAdmin] = useState<boolean | null>(null)

  useEffect(() => {
    if (!isSupabaseInitialized()) {
      setReady(true)
      return
    }

    const run = async () => {
      const { data } = await supabase.auth.getSession()
      setSignedIn(Boolean(data.session))
      setReady(true)
    }
    void run()

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setSignedIn(Boolean(session))
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!ready || !isSupabaseInitialized() || !signedIn) return

    const check = async () => {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) {
        setPlatformAdmin(false)
        return
      }
      const res = await fetch('/api/admin/me', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        setPlatformAdmin(false)
        return
      }
      const json = (await res.json()) as { platformAdmin: boolean }
      setPlatformAdmin(json.platformAdmin)
    }
    void check()
  }, [ready, signedIn])

  useEffect(() => {
    if (!ready || !isSupabaseInitialized()) return
    if (!signedIn) {
      const next = encodeURIComponent(pathname || '/admin')
      router.replace(`/login?next=${next}`)
    }
  }, [ready, signedIn, router, pathname])

  useEffect(() => {
    if (platformAdmin === false) {
      router.replace('/dashboard')
    }
  }, [platformAdmin, router])

  if (!ready || !isSupabaseInitialized() || !signedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-secondary)]">
        <div
          className="h-10 w-10 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin"
          aria-hidden
        />
      </div>
    )
  }

  if (platformAdmin !== true) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-secondary)]">
        <div
          className="h-10 w-10 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin"
          aria-hidden
        />
      </div>
    )
  }

  return <AdminShell>{children}</AdminShell>
}
