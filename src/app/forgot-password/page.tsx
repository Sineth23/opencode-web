'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowLeftIcon, EnvelopeIcon } from '@heroicons/react/24/outline'
import { isSupabaseInitialized, supabase } from '@/lib/supabase'
import { withSupportContact } from '@/lib/support-copy'

function ForgotPasswordForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!email.trim()) {
      setError('Email is required')
      return
    }
    if (!/\S+@\S+\.\S+/.test(email)) {
      setError('Please enter a valid email address')
      return
    }
    if (!isSupabaseInitialized()) {
      setError(withSupportContact('Supabase is not configured. Add keys to .env.local.'))
      return
    }
    setIsSubmitting(true)
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (resetError) {
        setError(withSupportContact(resetError.message))
        setIsSubmitting(false)
        return
      }
      setIsSuccess(true)
    } catch (err: unknown) {
      setError(withSupportContact(err instanceof Error ? err.message : 'Something went wrong.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  if (isSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-secondary)] py-12 px-4">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm p-10 text-center"
        >
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-success-bg)] mb-4">
            <EnvelopeIcon className="h-8 w-8 text-[var(--color-success)]" />
          </div>
          <h2 className="text-2xl font-bold text-[var(--color-text-primary)] mb-2">Check your email</h2>
          <p className="text-[var(--color-text-secondary)] mb-2">
            We sent a reset link to <strong className="text-[var(--color-text-primary)]">{email}</strong>
          </p>
          <p className="text-sm text-[var(--color-text-tertiary)] mb-8">The link expires after a short time.</p>
          <button
            type="button"
            onClick={() => router.push('/login')}
            className="w-full bg-primary text-white py-3 rounded-xl font-semibold hover:bg-primary-dark transition-colors"
          >
            Back to sign in
          </button>
        </motion.div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-secondary)] py-12 px-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full space-y-8"
      >
        <Link href="/login" className="inline-flex items-center gap-2 text-sm font-medium text-[var(--color-text-secondary)] hover:text-primary">
          <ArrowLeftIcon className="h-4 w-4" />
          Back to sign in
        </Link>
        <div className="text-center">
          <Link href="/" className="inline-block mb-6">
            <Image src="/images/logos/logo.svg" alt="AutoDoc" width={120} height={32} className="h-8 w-auto mx-auto" />
          </Link>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mb-2">Reset password</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">We&apos;ll email you a link to choose a new password.</p>
        </div>
        <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm p-8">
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
            {error && (
              <div className="p-3 rounded-lg bg-[var(--color-error-bg)] border border-[var(--color-error)]/20 text-sm text-[var(--color-error)]">
                {error}
              </div>
            )}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-[var(--color-text-primary)] mb-1">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] focus:ring-2 focus:ring-[var(--color-border-focus)] focus:border-transparent outline-none"
                placeholder="you@company.com"
              />
            </div>
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full bg-primary text-white py-3 rounded-xl font-semibold hover:bg-primary-dark disabled:opacity-60 transition-colors"
            >
              {isSubmitting ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        </div>
      </motion.div>
    </div>
  )
}

export default function ForgotPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="h-10 w-10 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      }
    >
      <ForgotPasswordForm />
    </Suspense>
  )
}
