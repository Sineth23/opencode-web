'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import { isSupabaseInitialized, supabase } from '@/lib/supabase'
import { isCognitoConfigured, cognitoGetSession, cognitoGetUser, cognitoSignOut } from '@/lib/cognito'
import { WorkspaceProvider, useWorkspace } from '@/components/providers/WorkspaceContext'
import ProductShell from '@/components/layout/ProductShell'
import TermsAcceptanceGate from '@/components/legal/TermsAcceptanceGate'
import { cdkPost } from '@/lib/cdk-api'

function TenantSetup({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true); setError(null)
    try {
      await cdkPost('/tenants', { companyName: name.trim() })
      await onCreated()
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-secondary)] p-4">
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-xl shadow-sm border border-[var(--color-border)] p-8 space-y-6">
        <div>
          <h2 className="text-2xl font-bold text-[var(--color-text-primary)]">Set up your workspace</h2>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Enter your organization name to get started.</p>
        </div>
        {error && (
          <div className="p-3 bg-[var(--color-error-bg)] border border-[var(--color-error)]/25 rounded-lg">
            <p className="text-sm text-[var(--color-error)]">{error}</p>
          </div>
        )}
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label htmlFor="company-name" className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Organization name</label>
            <input
              id="company-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
              autoFocus
              className="w-full px-4 py-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-border-focus)] focus:border-transparent transition-shadow"
            />
          </div>
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="w-full bg-primary text-white py-3 px-6 rounded-xl font-semibold hover:bg-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {submitting ? (
              <>
                <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24" aria-hidden>
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Creating workspace…
              </>
            ) : 'Create workspace'}
          </button>
        </form>
      </div>
    </div>
  )
}

function AuthenticatedChrome({ children, cognitoEmail }: { children: React.ReactNode; cognitoEmail?: string }) {
  const [user, setUser] = useState<User | null>(null)
  const { noTenant, refresh } = useWorkspace()

  useEffect(() => {
    if (isCognitoConfigured()) return // Cognito mode — no Supabase user needed
    void supabase.auth.getUser().then(({ data }) => setUser(data.user))
  }, [])

  useEffect(() => {
    if (isCognitoConfigured()) return
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  if (noTenant) {
    return <TenantSetup onCreated={refresh} />
  }

  // Synthesise a minimal user-like object for ProductShell when using Cognito
  const effectiveUser = isCognitoConfigured()
    ? (cognitoEmail ? { email: cognitoEmail } as unknown as User : null)
    : user

  return (
    <ProductShell user={effectiveUser}>
      <TermsAcceptanceGate user={effectiveUser}>{children}</TermsAcceptanceGate>
    </ProductShell>
  )
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [ready, setReady] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [cognitoEmail, setCognitoEmail] = useState<string | undefined>()

  useEffect(() => {
    const run = async () => {
      // Cognito takes priority if configured
      if (isCognitoConfigured()) {
        const session = cognitoGetSession()
        if (session?.valid) {
          const u = cognitoGetUser()
          setCognitoEmail(u?.email)
          setSignedIn(true)
        } else {
          setSignedIn(false)
        }
        setReady(true)
        return
      }

      // Fall back to Supabase
      if (!isSupabaseInitialized()) {
        setReady(true)
        return
      }
      const { data } = await supabase.auth.getSession()
      setSignedIn(Boolean(data.session))
      setReady(true)
    }
    void run()

    // Supabase auth state listener (no-op when Cognito is active)
    if (!isCognitoConfigured() && isSupabaseInitialized()) {
      const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
        setSignedIn(Boolean(session))
      })
      return () => sub.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    const usingCognito = isCognitoConfigured()
    if (usingCognito && !signedIn) {
      const next = encodeURIComponent(pathname || '/dashboard')
      router.replace(`/login?next=${next}`)
    } else if (!usingCognito && isSupabaseInitialized() && !signedIn) {
      const next = encodeURIComponent(pathname || '/dashboard')
      router.replace(`/login?next=${next}`)
    }
  }, [ready, signedIn, router, pathname])

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-secondary)]">
        <div
          className="h-10 w-10 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin"
          aria-hidden
        />
      </div>
    )
  }

  if (!signedIn) return null

  return (
    <WorkspaceProvider>
      <AuthenticatedChrome cognitoEmail={cognitoEmail}>{children}</AuthenticatedChrome>
    </WorkspaceProvider>
  )
}
