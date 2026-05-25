'use client'

import Link from 'next/link'
import Image from 'next/image'
import { motion } from 'framer-motion'
import {
  ArrowRightIcon,
  ChatBubbleLeftRightIcon,
  CloudArrowUpIcon,
  DocumentTextIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline'

const fadeUp = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)] flex flex-col">
      <header className="border-b border-[var(--color-border)] bg-white/80 backdrop-blur-md sticky top-0 z-20">
        <div className="pk-container h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center min-w-0 py-1" aria-label="AutoDoc home">
            <Image
              src="/images/logos/logo.svg"
              alt="AutoDoc"
              width={128}
              height={36}
              className="h-8 w-auto max-w-[min(100%,11rem)] object-contain object-left"
              priority
            />
          </Link>
          <div className="flex items-center gap-3">
            <a
              href="#how-it-works"
              className="hidden sm:inline text-sm font-medium text-[var(--color-text-secondary)] hover:text-primary transition-colors"
            >
              How it works
            </a>
            <Link href="/login" className="pk-btn-primary text-sm">
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <section className="relative overflow-hidden">
          <div
            className="absolute inset-0 opacity-[0.4] pointer-events-none"
            style={{ backgroundImage: 'url(/images/grid.svg)', backgroundSize: 'cover' }}
          />
          <div
            className="absolute -top-24 right-0 w-[min(100%,520px)] h-[520px] rounded-full opacity-[0.12] pointer-events-none blur-3xl"
            style={{
              background: 'radial-gradient(circle at center, var(--color-primary, #1e3a5f) 0%, transparent 70%)',
            }}
          />

          <div className="relative pk-container py-16 md:py-24 lg:py-28">
            <div className="grid lg:grid-cols-[1fr_minmax(280px,400px)] gap-12 lg:gap-16 items-center max-w-6xl mx-auto">
              <motion.div
                initial={fadeUp.initial}
                animate={fadeUp.animate}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-white/90 px-3 py-1 text-xs font-medium text-[var(--color-text-secondary)] shadow-sm mb-6">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                  Plain-language docs from real code
                </div>
                <h1 className="text-4xl sm:text-5xl lg:text-[3.25rem] font-bold text-[var(--color-text-primary)] tracking-tight text-balance leading-[1.1] mb-6">
                  Turn your repository into documentation your whole team can use.
                </h1>
                <p className="text-lg sm:text-xl text-[var(--color-text-secondary)] leading-relaxed mb-8 max-w-xl">
                  Give your team accurate, up-to-date guides that reflect how your product really works: without the wiki rot.
                  Ask questions in plain language and get answers grounded in your code and generated docs, not guesswork.
                </p>
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-10">
                  <Link
                    href="/login"
                    className="pk-btn-primary justify-center px-7 py-3.5 text-base shadow-md hover:shadow-lg transition-shadow group"
                  >
                    Open the app
                    <ArrowRightIcon className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                  <a
                    href="https://www.autodocai.io"
                    className="pk-btn-secondary justify-center px-7 py-3.5 text-base"
                    target="_blank"
                    rel="noreferrer"
                  >
                    About AutoDoc
                  </a>
                </div>
                <ul className="flex flex-wrap gap-x-8 gap-y-3 text-sm text-[var(--color-text-tertiary)]">
                  <li className="flex items-center gap-2">
                    <ShieldCheckIcon className="h-5 w-5 text-primary/80 shrink-0" aria-hidden />
                    Workspace access controls
                  </li>
                  <li className="flex items-center gap-2">
                    <CloudArrowUpIcon className="h-5 w-5 text-primary/80 shrink-0" aria-hidden />
                    Background sync jobs
                  </li>
                </ul>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
                className="relative"
                aria-hidden
              >
                <div className="rounded-2xl border border-[var(--color-border)] bg-white shadow-xl shadow-primary/5 overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-400/90" />
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-400/90" />
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/90" />
                    <span className="ml-2 text-xs text-[var(--color-text-tertiary)] font-medium">AutoDoc · Preview</span>
                  </div>
                  <div className="p-5 space-y-4 text-left">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-primary mb-1">Documentation</p>
                      <p className="text-sm font-semibold text-[var(--color-text-primary)]">Batch eligibility workflow</p>
                      <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                        When a program moves states, outbound messages follow the rules in config/messaging…
                      </p>
                    </div>
                    <div className="rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-3">
                      <p className="text-xs font-medium text-[var(--color-text-tertiary)] mb-2">Assistant</p>
                      <p className="text-sm text-[var(--color-text-primary)]">
                        Can we pause mailings for a cohort without changing live status?
                      </p>
                      <p className="text-xs text-[var(--color-text-secondary)] mt-2 pl-2 border-l-2 border-primary/40">
                        Yes, if your repo defines a batch mute flag… [Source: lib/comms/batch.ts]
                      </p>
                    </div>
                  </div>
                </div>
                <p className="mt-4 text-center text-xs text-[var(--color-text-tertiary)] lg:text-left">
                  Illustrative UI. Your workspace shows your real sources and sections.
                </p>
              </motion.div>
            </div>
          </div>
        </section>

        <section
          id="how-it-works"
          className="border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-16 md:py-24 scroll-mt-20"
        >
          <div className="pk-container max-w-5xl">
            <div className="max-w-2xl mb-12 md:mb-14">
              <p className="text-sm font-semibold text-primary tracking-wide mb-2">How it works</p>
              <h2 className="text-2xl md:text-3xl font-bold text-[var(--color-text-primary)] tracking-tight text-balance">
                From connection to confident answers in three steps
              </h2>
              <p className="mt-3 text-[var(--color-text-secondary)] leading-relaxed">
                Built for program managers, client teams, and leaders who need clarity without pulling engineers into every
                question.
              </p>
            </div>
            <div className="grid md:grid-cols-3 gap-6 md:gap-8">
              {[
                {
                  step: '01',
                  title: 'Connect sources',
                  body: 'Link Bitbucket and choose repos and branches. Sync runs in the background so the app stays responsive.',
                  icon: CloudArrowUpIcon,
                },
                {
                  step: '02',
                  title: 'Readable documentation',
                  body: 'Generate sections for features, workflows, configuration, and edge cases, written for operators, not only developers.',
                  icon: DocumentTextIcon,
                },
                {
                  step: '03',
                  title: 'Grounded assistant',
                  body: 'Ask how something works or what is possible. Answers cite paths and docs so you can verify or share with stakeholders.',
                  icon: ChatBubbleLeftRightIcon,
                },
              ].map((c, i) => (
                <motion.div
                  key={c.step}
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-40px' }}
                  transition={{ delay: i * 0.07, duration: 0.4 }}
                  className="pk-card p-6 md:p-7 hover:shadow-md hover:border-primary/20 transition-all duration-300 group"
                >
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <span className="text-3xl font-bold text-[var(--color-bg-tertiary)] group-hover:text-primary/25 transition-colors tabular-nums">
                      {c.step}
                    </span>
                    <span className="rounded-xl bg-primary/10 p-2.5 text-primary">
                      <c.icon className="h-6 w-6" aria-hidden />
                    </span>
                  </div>
                  <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">{c.title}</h3>
                  <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">{c.body}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-[var(--color-border)] bg-white py-14 md:py-20">
          <div className="pk-container max-w-3xl text-center">
            <h2 className="text-xl md:text-2xl font-bold text-[var(--color-text-primary)] text-balance mb-4">
              Ready to shorten the distance between code and clarity?
            </h2>
            <p className="text-[var(--color-text-secondary)] mb-8 max-w-xl mx-auto leading-relaxed">
              Sign in to your workspace, connect a repository, and run your first sync. Your team gets documentation and answers
              that stay tied to what you actually shipped.
            </p>
            <Link href="/login" className="pk-btn-primary inline-flex px-8 py-3.5 text-base shadow-md hover:shadow-lg transition-shadow">
              Get started
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--color-border)] py-10 bg-[var(--color-bg-secondary)]">
        <div className="pk-container flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 text-sm text-[var(--color-text-tertiary)]">
          <p>Part of the AutoDoc ecosystem. Enterprise-oriented security and access practices.</p>
          <div className="flex flex-wrap gap-4">
            <a href="https://www.autodocai.io" className="font-medium text-[var(--color-text-secondary)] hover:text-primary" target="_blank" rel="noreferrer">
              autodocai.io
            </a>
            <Link href="/login" className="font-medium text-[var(--color-text-secondary)] hover:text-primary">
              Sign in
            </Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
