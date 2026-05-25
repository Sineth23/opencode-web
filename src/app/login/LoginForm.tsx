'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { isSupabaseInitialized, supabase } from '@/lib/supabase'
import {
  isCognitoConfigured,
  initiateAuth,
  respondToMFA,
  respondToNewPassword,
  associateSoftwareToken,
  verifySoftwareToken,
  setUserMFAPreference,
  respondToMfaSetup,
  saveAuthState,
  cognitoGetSession,
} from '@/lib/cognito'

type AuthMode = 'login' | 'signup'
type CognitoStep = 'credentials' | 'mfa' | 'new-password' | 'mfa-setup'

export default function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const next = searchParams.get('next') || '/dashboard'

  const [mounted, setMounted] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (isCognitoConfigured()) {
      if (cognitoGetSession()?.valid) router.replace(next)
      return
    }
    if (!isSupabaseInitialized()) return
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.replace(next)
    })
  }, [router, next])

  const AUTH_TIMEOUT_MS = 45_000

  const handleLogin = async (email: string, password: string) => {
    setAuthError(null)
    const timeoutError = { message: 'Sign-in timed out. Check VPN/network and that Supabase is reachable.' }
    const race = Promise.race([
      supabase.auth.signInWithPassword({ email, password }),
      new Promise<{ data: null; error: { message: string } }>((res) =>
        setTimeout(() => res({ data: null, error: timeoutError }), AUTH_TIMEOUT_MS)
      ),
    ])
    const { error } = await race
    if (error) {
      setAuthError(error.message)
      throw new Error(error.message)
    }
    router.replace(next)
  }

  const handleSignup = async (email: string, password: string, name: string) => {
    setAuthError(null)
    const timeoutError = { message: 'Sign-up timed out. Check VPN/network and that Supabase is reachable.' }
    const race = Promise.race([
      supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: name } },
      }),
      new Promise<{ data: null; error: { message: string } }>((res) =>
        setTimeout(() => res({ data: null, error: timeoutError }), AUTH_TIMEOUT_MS)
      ),
    ])
    const { error } = await race
    if (error) {
      setAuthError(error.message)
      throw new Error(error.message)
    }
    router.replace(next)
  }

  return (
    <div className="min-h-screen flex bg-[var(--color-bg-secondary)]">
      <div className="hidden lg:flex lg:w-[46%] xl:w-[42%] relative flex-col justify-between p-10 xl:p-14 bg-gradient-to-br from-primary via-[#243a7a] to-primary-dark text-white overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.07] pointer-events-none"
          style={{ backgroundImage: 'url(/images/grid.svg)', backgroundSize: 'cover' }}
        />
        <div className="relative z-10">
          <Link
            href="/"
            className="inline-flex items-center rounded-xl bg-white/10 backdrop-blur-sm px-4 py-2.5 ring-1 ring-white/15 hover:bg-white/15 transition-colors"
          >
            <span className="text-xl font-bold tracking-tight text-white">AutoDoc</span>
          </Link>
        </div>
        <div className="relative z-10 space-y-6 max-w-md">
          <h1 className="text-3xl xl:text-4xl font-bold leading-tight tracking-tight">
            Understand your product without waiting on engineering for every question.
          </h1>
          <p className="text-white/80 text-lg leading-relaxed">
            Connect knowledge sources, read plain-language documentation, and ask how workflows and capabilities really work.
          </p>
          <ul className="space-y-3 text-sm text-white/75">
            <li className="flex gap-2">
              <span className="text-secondary font-bold">·</span>
              Built for program managers and client-facing teams
            </li>
            <li className="flex gap-2">
              <span className="text-secondary font-bold">·</span>
              Grounded answers from your repo and generated docs
            </li>
          </ul>
        </div>
        <p className="relative z-10 text-xs text-white/50">Part of the AutoDoc ecosystem</p>
      </div>

      <div className="flex-1 flex items-center justify-center py-12 px-4 sm:px-8">
        <div className="w-full max-w-md space-y-8">
          <div className="lg:hidden flex justify-center mb-2">
            <Link href="/" className="flex items-center justify-center py-1" aria-label="AutoDoc home">
              <Image src="/images/logos/logo.svg" alt="AutoDoc" width={140} height={40} className="h-9 w-auto max-w-[85vw] object-contain" priority />
            </Link>
          </div>

          {mounted && isCognitoConfigured() ? (
            <CognitoAuthForm onSuccess={() => router.replace(next)} />
          ) : (
            <>
              {mounted && (
                <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} className="text-center lg:text-left">
                  <h2 className="text-3xl font-bold text-[var(--color-text-primary)] mb-2">
                    {authMode === 'login' ? 'Welcome back' : 'Create your account'}
                  </h2>
                  <p className="text-[var(--color-text-secondary)]">
                    {authMode === 'login'
                      ? 'Sign in to your knowledge workspace'
                      : 'Get started with documentation and grounded answers'}
                  </p>
                </motion.div>
              )}

              {mounted && (
                <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
                  {authError && (
                    <div className="mb-4 p-4 bg-[var(--color-error-bg)] border border-[var(--color-error)]/25 rounded-xl">
                      <p className="text-sm text-[var(--color-error)]">{authError}</p>
                    </div>
                  )}
                  <AuthForm
                    mode={authMode}
                    onLogin={handleLogin}
                    onSignup={handleSignup}
                    onConfigError={() => setAuthError('Supabase is not configured. Add keys to .env.local.')}
                  />
                </motion.div>
              )}

              {mounted && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.15 }}
                  className="text-center lg:text-left text-sm text-[var(--color-text-secondary)]"
                >
                  {authMode === 'login' ? (
                    <>
                      Don&apos;t have an account?{' '}
                      <button
                        type="button"
                        onClick={() => { setAuthMode('signup'); setAuthError(null) }}
                        className="font-semibold text-primary hover:text-primary-dark transition-colors"
                      >
                        Sign up
                      </button>
                    </>
                  ) : (
                    <>
                      Already have an account?{' '}
                      <button
                        type="button"
                        onClick={() => { setAuthMode('login'); setAuthError(null) }}
                        className="font-semibold text-primary hover:text-primary-dark transition-colors"
                      >
                        Sign in
                      </button>
                    </>
                  )}
                </motion.p>
              )}
            </>
          )}

          <p className="text-center text-sm text-[var(--color-text-tertiary)]">
            <Link href="/" className="font-medium text-primary hover:underline">
              ← Back to overview
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── Cognito multi-step auth form ─────────────────────────────────────────────

function CognitoAuthForm({ onSuccess }: { onSuccess: () => void }) {
  const [step, setStep] = useState<CognitoStep>('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [mfaSecret, setMfaSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const sessionRef = useRef('')
  const accessTokenRef = useRef('')

  const inputClass = (hasError = false) =>
    `w-full px-4 py-2.5 rounded-[var(--radius-md)] border bg-[var(--color-surface)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-border-focus)] focus:border-transparent transition-shadow ${
      hasError ? 'border-[var(--color-error)]' : 'border-[var(--color-border)]'
    }`

  const handleCredentials = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password.trim()) { setError('Email and password are required'); return }
    setError(null); setInfo(null); setIsSubmitting(true)
    try {
      const data = await initiateAuth(email, password) as Record<string, unknown>
      sessionRef.current = (data.Session as string) || ''
      const challenge = data.ChallengeName as string | undefined

      if (data.AuthenticationResult) {
        const result = data.AuthenticationResult as Record<string, string>
        saveAuthState(result.IdToken, result.AccessToken)
        onSuccess()
        return
      }
      if (challenge === 'SOFTWARE_TOKEN_MFA') {
        setInfo('Enter the 6-digit code from your authenticator app.')
        setStep('mfa')
      } else if (challenge === 'NEW_PASSWORD_REQUIRED') {
        setInfo('You must set a new password before continuing.')
        setStep('new-password')
      } else if (challenge === 'MFA_SETUP') {
        await beginMfaSetup()
      } else {
        setError(`Unexpected challenge: ${challenge ?? 'unknown'}`)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleMfa = async (e: React.FormEvent) => {
    e.preventDefault()
    if (mfaCode.length !== 6) { setError('Enter a 6-digit code'); return }
    setError(null); setIsSubmitting(true)
    try {
      const data = await respondToMFA(sessionRef.current, email, mfaCode) as Record<string, unknown>
      if (data.AuthenticationResult) {
        const result = data.AuthenticationResult as Record<string, string>
        saveAuthState(result.IdToken, result.AccessToken)
        onSuccess()
      } else {
        setError('MFA verification failed')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleNewPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newPassword || newPassword !== confirmPassword) { setError('Passwords do not match'); return }
    if (newPassword.length < 12) { setError('Password must be at least 12 characters'); return }
    setError(null); setIsSubmitting(true)
    try {
      const data = await respondToNewPassword(sessionRef.current, email, newPassword) as Record<string, unknown>
      sessionRef.current = (data.Session as string) || sessionRef.current
      const challenge = data.ChallengeName as string | undefined

      if (data.AuthenticationResult) {
        const result = data.AuthenticationResult as Record<string, string>
        saveAuthState(result.IdToken, result.AccessToken)
        onSuccess()
        return
      }
      if (challenge === 'MFA_SETUP') {
        await beginMfaSetup()
      } else if (challenge === 'SOFTWARE_TOKEN_MFA') {
        setInfo('Enter the 6-digit code from your authenticator app.')
        setStep('mfa')
      } else {
        setError(`Unexpected challenge: ${challenge ?? 'unknown'}`)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const beginMfaSetup = async () => {
    setIsSubmitting(true)
    try {
      const useAccessToken = Boolean(accessTokenRef.current)
      const token = accessTokenRef.current || sessionRef.current
      const data = await associateSoftwareToken(token, useAccessToken) as Record<string, unknown>
      if (data.Session) sessionRef.current = data.Session as string
      setMfaSecret(data.SecretCode as string)
      setMfaCode('')
      setInfo('Scan the secret below with your authenticator app, then enter the 6-digit code.')
      setStep('mfa-setup')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleMfaSetupVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    if (mfaCode.length !== 6) { setError('Enter a 6-digit code'); return }
    setError(null); setIsSubmitting(true)
    try {
      const useAccessToken = Boolean(accessTokenRef.current)
      const token = accessTokenRef.current || sessionRef.current
      const data = await verifySoftwareToken(mfaCode, token, useAccessToken) as Record<string, unknown>

      if (data.Status !== 'SUCCESS') { setError(`Unexpected status: ${data.Status as string}`); return }

      if (accessTokenRef.current) {
        await setUserMFAPreference(accessTokenRef.current)
        setInfo('MFA enrolled! You can now sign in with your authenticator.')
        setStep('credentials')
        return
      }

      sessionRef.current = (data.Session as string) || sessionRef.current
      const setupData = await respondToMfaSetup(sessionRef.current, email) as Record<string, unknown>
      if (setupData.AuthenticationResult) {
        const result = setupData.AuthenticationResult as Record<string, string>
        saveAuthState(result.IdToken, result.AccessToken)
        onSuccess()
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const Spinner = () => (
    <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  )

  const stepLabel: Record<CognitoStep, string> = {
    'credentials': 'Welcome back',
    'mfa': 'Two-factor verification',
    'new-password': 'Set your password',
    'mfa-setup': 'Set up authenticator',
  }
  const stepSub: Record<CognitoStep, string> = {
    'credentials': 'Sign in to your knowledge workspace',
    'mfa': 'Verify your identity to continue',
    'new-password': 'Choose a strong password for your account',
    'mfa-setup': 'Scan the code with Google Authenticator or Authy',
  }

  return (
    <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }}>
      <div className="text-center lg:text-left mb-8">
        <h2 className="text-3xl font-bold text-[var(--color-text-primary)] mb-2">{stepLabel[step]}</h2>
        <p className="text-[var(--color-text-secondary)]">{stepSub[step]}</p>
      </div>

      <div className="bg-[var(--color-surface)] rounded-xl shadow-sm border border-[var(--color-border)] p-8 space-y-5">
        {error && (
          <div className="p-4 bg-[var(--color-error-bg)] border border-[var(--color-error)]/25 rounded-xl">
            <p className="text-sm text-[var(--color-error)]">{error}</p>
          </div>
        )}
        {info && (
          <div className="p-4 bg-[var(--color-accent-bg,#eff6ff)] border border-[var(--color-accent,#3b82f6)]/25 rounded-xl">
            <p className="text-sm text-[var(--color-accent,#1d4ed8)]">{info}</p>
          </div>
        )}

        {step === 'credentials' && (
          <form onSubmit={(e) => void handleCredentials(e)} className="space-y-5">
            <div>
              <label htmlFor="cog-email" className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Email</label>
              <input id="cog-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass()} placeholder="you@company.com" disabled={isSubmitting} />
            </div>
            <div>
              <label htmlFor="cog-password" className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Password</label>
              <input id="cog-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass()} placeholder="••••••••" disabled={isSubmitting} />
            </div>
            <button type="submit" disabled={isSubmitting} className="w-full bg-primary text-white py-3 px-6 rounded-xl font-semibold hover:bg-primary-dark transition-colors disabled:bg-[var(--color-bg-tertiary)] disabled:text-[var(--color-text-tertiary)] disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-sm mt-2">
              {isSubmitting ? <><Spinner /> Signing in…</> : 'Sign in'}
            </button>
          </form>
        )}

        {step === 'mfa' && (
          <form onSubmit={(e) => void handleMfa(e)} className="space-y-5">
            <div>
              <label htmlFor="cog-mfa" className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Authentication code</label>
              <input id="cog-mfa" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))} className={inputClass()} placeholder="123456" disabled={isSubmitting} autoFocus />
            </div>
            <button type="submit" disabled={isSubmitting} className="w-full bg-primary text-white py-3 px-6 rounded-xl font-semibold hover:bg-primary-dark transition-colors disabled:bg-[var(--color-bg-tertiary)] disabled:text-[var(--color-text-tertiary)] disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-sm">
              {isSubmitting ? <><Spinner /> Verifying…</> : 'Verify'}
            </button>
            <button type="button" onClick={() => { setStep('credentials'); setError(null); setInfo(null) }} className="w-full text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors">← Back to sign in</button>
          </form>
        )}

        {step === 'new-password' && (
          <form onSubmit={(e) => void handleNewPassword(e)} className="space-y-5">
            <div>
              <label htmlFor="cog-newpw" className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">New password</label>
              <input id="cog-newpw" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={inputClass()} placeholder="Min 12 chars, upper + lower + digit" disabled={isSubmitting} autoFocus />
            </div>
            <div>
              <label htmlFor="cog-confirmpw" className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Confirm password</label>
              <input id="cog-confirmpw" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={inputClass(newPassword !== confirmPassword && confirmPassword.length > 0)} placeholder="Repeat your password" disabled={isSubmitting} />
            </div>
            <button type="submit" disabled={isSubmitting} className="w-full bg-primary text-white py-3 px-6 rounded-xl font-semibold hover:bg-primary-dark transition-colors disabled:bg-[var(--color-bg-tertiary)] disabled:text-[var(--color-text-tertiary)] disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-sm">
              {isSubmitting ? <><Spinner /> Setting password…</> : 'Set password'}
            </button>
          </form>
        )}

        {step === 'mfa-setup' && (
          <form onSubmit={(e) => void handleMfaSetupVerify(e)} className="space-y-5">
            <div className="rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4">
              <p className="text-xs font-medium text-[var(--color-text-secondary)] mb-2 uppercase tracking-wide">Authenticator secret key</p>
              <code className="block text-sm font-mono text-[var(--color-text-primary)] break-all select-all">{mfaSecret}</code>
              <p className="text-xs text-[var(--color-text-tertiary)] mt-2">Or use <strong>Google Authenticator</strong>, <strong>Authy</strong>, or any TOTP app — add account by entering the key above.</p>
            </div>
            <div>
              <label htmlFor="cog-setup-code" className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">6-digit code from your app</label>
              <input id="cog-setup-code" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))} className={inputClass()} placeholder="123456" disabled={isSubmitting} autoFocus />
            </div>
            <button type="submit" disabled={isSubmitting} className="w-full bg-primary text-white py-3 px-6 rounded-xl font-semibold hover:bg-primary-dark transition-colors disabled:bg-[var(--color-bg-tertiary)] disabled:text-[var(--color-text-tertiary)] disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-sm">
              {isSubmitting ? <><Spinner /> Completing setup…</> : 'Complete setup'}
            </button>
          </form>
        )}
      </div>
    </motion.div>
  )
}

// ─── Supabase auth form ────────────────────────────────────────────────────────

function AuthForm({
  mode,
  onLogin,
  onSignup,
  onConfigError,
}: {
  mode: AuthMode
  onLogin: (email: string, password: string) => Promise<void>
  onSignup: (email: string, password: string, name: string) => Promise<void>
  onConfigError: () => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const validate = () => {
    const next: Record<string, string> = {}
    if (!email) next.email = 'Email is required'
    else if (!/\S+@\S+\.\S+/.test(email)) next.email = 'Enter a valid email'
    if (!password) next.password = 'Password is required'
    else if (password.length < 8) next.password = 'At least 8 characters'
    if (mode === 'signup' && !name.trim()) next.name = 'Name is required'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isSupabaseInitialized()) { onConfigError(); return }
    if (!validate()) return
    setIsSubmitting(true)
    try {
      if (mode === 'login') await onLogin(email, password)
      else await onSignup(email, password, name.trim())
    } catch {
      /* parent sets authError */
    } finally {
      setIsSubmitting(false)
    }
  }

  const inputClass = (key: string) =>
    `w-full px-4 py-2.5 rounded-[var(--radius-md)] border bg-[var(--color-surface)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-border-focus)] focus:border-transparent transition-shadow ${
      errors[key] ? 'border-[var(--color-error)]' : 'border-[var(--color-border)]'
    }`

  return (
    <div className="bg-[var(--color-surface)] rounded-xl shadow-sm border border-[var(--color-border)] p-8">
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
        {mode === 'signup' && (
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Full name</label>
            <input id="name" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass('name')} placeholder="Jane Lee" />
            {errors.name && <p className="mt-1 text-sm text-[var(--color-error)]">{errors.name}</p>}
          </div>
        )}

        <div>
          <label htmlFor="email" className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Email</label>
          <input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass('email')} placeholder="you@company.com" />
          {errors.email && <p className="mt-1 text-sm text-[var(--color-error)]">{errors.email}</p>}
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">Password</label>
          <input id="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass('password')} placeholder="••••••••" />
          {errors.password && <p className="mt-1 text-sm text-[var(--color-error)]">{errors.password}</p>}
        </div>

        {mode === 'login' && (
          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
              <input type="checkbox" className="rounded border-[var(--color-border)] text-primary focus:ring-primary" />
              Remember me
            </label>
            <Link href="/forgot-password" className="text-sm font-semibold text-primary hover:text-primary-dark">Forgot password?</Link>
          </div>
        )}

        <button type="submit" disabled={isSubmitting} className="w-full bg-primary text-white py-3 px-6 rounded-xl font-semibold hover:bg-primary-dark transition-colors disabled:bg-[var(--color-bg-tertiary)] disabled:text-[var(--color-text-tertiary)] disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-sm mt-2">
          {isSubmitting ? (
            <>
              <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24" aria-hidden>
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              {mode === 'login' ? 'Signing in…' : 'Creating account…'}
            </>
          ) : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>
    </div>
  )
}
