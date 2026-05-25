'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  ArrowLeftIcon,
  BuildingOffice2Icon,
  ShieldCheckIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline'

const nav = [
  { href: '/admin', label: 'Organizations', icon: BuildingOffice2Icon, end: true },
  { href: '/admin/platform-admins', label: 'Platform admins', icon: ShieldCheckIcon },
]

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="min-h-screen flex bg-[var(--color-bg-secondary)]">
      <aside className="hidden lg:flex w-64 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="h-16 flex items-center px-5 border-b border-[var(--color-border)]">
          <Link href="/admin" className="flex items-center gap-2">
            <Image src="/images/logos/logo.svg" alt="AutoDoc" width={120} height={32} className="h-7 w-auto" priority />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded">
              Platform
            </span>
          </Link>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {nav.map((item) => {
            const active = item.end ? pathname === item.href : pathname === item.href || pathname?.startsWith(`${item.href}/`)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-amber-50 text-amber-900'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="p-3 border-t border-[var(--color-border)]">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2.5 text-sm font-medium text-primary hover:bg-[var(--color-accent-light)]"
          >
            <ArrowLeftIcon className="h-5 w-5" />
            Back to app
          </Link>
          <p className="mt-3 px-3 text-xs text-[var(--color-text-tertiary)] leading-relaxed">
            SaaS control plane: tenants map to <strong className="font-medium">workspaces</strong>. Same deployment serves every client org.
          </p>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 lg:h-16 border-b border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-between px-4 lg:px-8">
          <div className="flex items-center gap-3 lg:hidden">
            <Image src="/images/logos/logo.svg" alt="AutoDoc" width={100} height={28} className="h-6 w-auto" />
            <span className="text-[10px] font-semibold text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded">Platform</span>
          </div>
          <Link
            href="/dashboard"
            className="lg:hidden inline-flex items-center gap-1 text-sm font-medium text-primary"
          >
            <Squares2X2Icon className="h-5 w-5" />
            App
          </Link>
        </header>
        <main className="flex-1 p-4 lg:p-8 max-w-6xl w-full mx-auto">{children}</main>
      </div>
    </div>
  )
}
