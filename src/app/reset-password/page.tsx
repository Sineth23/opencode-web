'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { isSupabaseInitialized, supabase } from '@/lib/supabase'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!isSupabaseInitialized()) {
      setReady(true)
      return
    }
    void supabase.auth.getSession().then(({ data }) => {
      setReady(true)
      if (!data.session) setError('This link is invalid or expired. Request a new reset from sign in.')
    })
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    if (!isSupabaseInitialized()) return
    setSubmitting(true)
    const { error: upd } = await supabase.auth.updateUser({ password })
    setSubmitting(false)
    if (upd) {
      setError(upd.message)
      return
    }
    setDone(true)
    setTimeout(() => router.push('/login'), 2000)
  }

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-secondary)]">
        <div className="h-10 w-10 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    )
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-secondary)] px-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full text-center bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-10"
        >
          <h1 className="text-xl font-bold text-[var(--color-text-primary)] mb-2">Password updated</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">Redirecting to sign in…</p>
        </motion.div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-secondary)] py-12 px-4">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-md w-full space-y-8">
        <div className="text-center">
          <Link href="/" className="inline-block mb-6">
            <Image src="/images/logos/logo.svg" alt="AutoDoc" width={120} height={32} className="h-8 w-auto mx-auto" />
          </Link>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mb-2">Choose a new password</h1>
        </div>
        <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm p-8">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-[var(--color-error-bg)] text-sm text-[var(--color-error)]">{error}</div>
          )}
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <div>
              <label htmlFor="pw" className="block text-sm font-medium mb-1">
                New password
              </label>
              <input
                id="pw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] focus:ring-2 focus:ring-primary outline-none"
              />
            </div>
            <div>
              <label htmlFor="pw2" className="block text-sm font-medium mb-1">
                Confirm password
              </label>
              <input
                id="pw2"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full px-4 py-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] focus:ring-2 focus:ring-primary outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-primary text-white py-3 rounded-xl font-semibold hover:bg-primary-dark disabled:opacity-60"
            >
              {submitting ? 'Saving…' : 'Update password'}
            </button>
          </form>
        </div>
        <p className="text-center text-sm">
          <Link href="/login" className="text-primary font-semibold">
            Back to sign in
          </Link>
        </p>
      </motion.div>
    </div>
  )
}
