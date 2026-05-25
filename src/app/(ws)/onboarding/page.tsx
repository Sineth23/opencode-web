'use client'

import { useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircleIcon } from '@heroicons/react/24/solid'
import { useWorkspace } from '@/components/providers/WorkspaceContext'

const steps = [
  {
    title: 'Welcome',
    body: 'This workspace helps program managers and client-facing teams understand your platform without waiting on engineering for every question.',
  },
  {
    title: 'Connect knowledge sources',
    body: 'Under Integrations, connect systems that supply code and context. Bitbucket Cloud is available first for many teams. You authorize read access; credentials stay on the server.',
  },
  {
    title: 'Choose a repository',
    body: 'When using Bitbucket, pick the main product repo (or the one that best reflects customer-facing behavior). You can refine this later.',
  },
  {
    title: 'Run your first sync',
    body: 'Ingestion pulls from connected sources into secure storage and prepares documentation plus assistant context. Manual jobs now; schedules can follow.',
  },
  {
    title: 'What you get',
    body: 'Documentation organized by features, workflows, configuration, and workarounds, plus an assistant that answers in plain language and cites sources when it can.',
  },
]

export default function OnboardingPage() {
  const { workspace } = useWorkspace()
  const [i, setI] = useState(0)

  const step = steps[i]

  return (
    <div className="max-w-xl mx-auto">
      <div className="mb-8">
        <p className="text-sm font-medium text-primary mb-2">Setup</p>
        <h1 className="text-3xl font-bold text-[var(--color-text-primary)]">Get oriented</h1>
        <p className="text-sm text-[var(--color-text-tertiary)] mt-2">
          Step {i + 1} of {steps.length}
          {workspace ? ` · ${workspace.name}` : ''}
        </p>
      </div>

      <div className="pk-card p-8 min-h-[280px] flex flex-col">
        <AnimatePresence mode="wait">
          <motion.div
            key={step.title}
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.2 }}
            className="flex-1"
          >
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mb-3">{step.title}</h2>
            <p className="text-[var(--color-text-secondary)] leading-relaxed">{step.body}</p>
          </motion.div>
        </AnimatePresence>

        <div className="flex items-center justify-between mt-10 pt-6 border-t border-[var(--color-border)]">
          <button
            type="button"
            className="text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
            disabled={i === 0}
            onClick={() => setI((s) => Math.max(0, s - 1))}
          >
            Back
          </button>
          {i < steps.length - 1 ? (
            <button type="button" className="pk-btn-primary px-5" onClick={() => setI((s) => s + 1)}>
              Continue
            </button>
          ) : (
            <Link href="/settings/integrations" className="pk-btn-primary px-5 inline-flex items-center gap-2">
              <CheckCircleIcon className="h-5 w-5" />
              Open integrations
            </Link>
          )}
        </div>
      </div>

      <p className="text-center text-sm text-[var(--color-text-tertiary)] mt-8">
        <Link href="/dashboard" className="text-primary font-medium hover:underline">
          Skip to overview
        </Link>
      </p>
    </div>
  )
}
