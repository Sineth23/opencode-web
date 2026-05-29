'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, Transition } from '@headlessui/react'
import { Fragment } from 'react'
import {
  ArrowPathIcon,
  ArrowRightOnRectangleIcon,
  BookOpenIcon,
  BuildingOffice2Icon,
  ChatBubbleLeftRightIcon,
  HomeIcon,
  PuzzlePieceIcon,
  UsersIcon,
} from '@heroicons/react/24/outline'
import { ChevronDownIcon } from '@heroicons/react/20/solid'
import { isSupabaseInitialized, supabase } from '@/lib/supabase'
import { isCognitoConfigured, cognitoSignOut } from '@/lib/cognito'
import type { User } from '@supabase/supabase-js'
import { useWorkspace } from '@/components/providers/WorkspaceContext'
import PlatformAdminNavLink from '@/components/admin/PlatformAdminNavLink'
import BackgroundActivityBanner from '@/components/workspace/BackgroundActivityBanner'
import SuperAdminSwitcher from '@/components/layout/SuperAdminSwitcher'
import { useSuperAdmin } from '@/lib/use-super-admin'

const allNavItems = [
  { href: '/dashboard', label: 'Overview', icon: HomeIcon, adminOnly: false, superadminOnly: false },
  { href: '/docs', label: 'Documentation', icon: BookOpenIcon, adminOnly: false, superadminOnly: false },
  { href: '/workspace', label: 'AI Workspace', icon: ChatBubbleLeftRightIcon, adminOnly: false, superadminOnly: false },
  { href: '/assistant', label: 'Assistant', icon: ChatBubbleLeftRightIcon, adminOnly: false, superadminOnly: false },
  { href: '/settings/sync', label: 'Sync center', icon: ArrowPathIcon, adminOnly: true, superadminOnly: false },
  { href: '/settings/integrations', label: 'Integrations', icon: PuzzlePieceIcon, adminOnly: true, superadminOnly: false },
  { href: '/settings/team', label: 'Team', icon: UsersIcon, adminOnly: true, superadminOnly: false },
  { href: '/settings/admin', label: 'Tenant Management', icon: BuildingOffice2Icon, adminOnly: false, superadminOnly: true },
]

export default function ProductShell({
  children,
  user,
}: {
  children: React.ReactNode
  user: User | null
}) {
  const pathname = usePathname()
  const { workspace, loading: wsLoading } = useWorkspace()
  const { isSuperAdmin } = useSuperAdmin()

  const isAdmin = isSuperAdmin || workspace?.membership_role === 'owner' || workspace?.membership_role === 'admin'
  const nav = allNavItems.filter(
    (item) => (!item.adminOnly || isAdmin) && (!item.superadminOnly || isSuperAdmin)
  )

  const display = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Account'

  return (
    <div className="min-h-screen flex bg-[var(--color-bg-secondary)]">
      <aside className="hidden lg:flex w-64 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="h-16 flex items-center px-4 border-b border-[var(--color-border)] min-w-0">
          <Link href="/dashboard" className="flex items-center min-w-0 py-1" aria-label="AutoDoc home">
            <Image
              src="/images/logos/logo.svg"
              alt="AutoDoc"
              width={120}
              height={32}
              className="h-7 w-auto max-w-[min(100%,9.5rem)] object-contain object-left"
              priority
            />
          </Link>
        </div>
        <nav className="flex-1 p-3 space-y-0.5" aria-label="Primary">
          {nav.map((item) => {
            const active =
              pathname === item.href ||
              (!item.href.startsWith('/settings/') && Boolean(pathname?.startsWith(`${item.href}/`)))
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`group relative flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-sm font-medium transition-[color,background-color,box-shadow] duration-150 ease-out ${
                  active
                    ? 'bg-[var(--color-accent-light)] text-primary shadow-sm ring-1 ring-primary/[0.1]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {active ? (
                  <span
                    className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-primary"
                    aria-hidden
                  />
                ) : null}
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border transition-colors duration-150 ${
                    active
                      ? 'border-primary/20 bg-white/80 text-primary'
                      : 'border-transparent bg-[var(--color-bg-tertiary)]/60 text-[var(--color-text-secondary)] group-hover:border-[var(--color-border)] group-hover:bg-[var(--color-surface)]'
                  }`}
                >
                  <item.icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="truncate">{item.label}</span>
              </Link>
            )
          })}
          <div className="pt-3 mt-3 border-t border-[var(--color-border)]">
            <PlatformAdminNavLink />
          </div>
        </nav>
        <div className="p-4 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40">
          {wsLoading ? (
            <p className="text-xs text-[var(--color-text-tertiary)]">Loading workspace…</p>
          ) : workspace ? (
            <div className="space-y-1.5 min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">Workspace</p>
              <p className="text-sm font-semibold text-[var(--color-text-primary)] leading-snug truncate">{workspace.name}</p>
              <p className="inline-flex max-w-full rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-medium capitalize text-[var(--color-text-secondary)] ring-1 ring-[var(--color-border)]">
                {(workspace.membership_role ?? 'member').replace(/_/g, ' ')}
              </p>
            </div>
          ) : (
            <p className="text-xs text-[var(--color-text-tertiary)]">No workspace</p>
          )}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-between gap-3 px-4 lg:px-8 min-w-0">
          <div className="lg:hidden flex items-center min-w-0 flex-1">
            <Link href="/dashboard" className="min-w-0 py-1" aria-label="AutoDoc home">
              <Image
                src="/images/logos/logo.svg"
                alt="AutoDoc"
                width={120}
                height={32}
                className="h-6 sm:h-7 w-auto max-w-[min(100%,10rem)] object-contain object-left"
              />
            </Link>
          </div>
          <div className="hidden lg:block" />
          <div className="flex items-center gap-3">
            <SuperAdminSwitcher />
          <Menu as="div" className="relative">
            <Menu.Button className="flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 hover:bg-[var(--color-bg-tertiary)]">
              <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-white text-sm font-semibold">
                {display.charAt(0).toUpperCase()}
              </div>
              <span className="hidden sm:block text-sm font-medium text-[var(--color-text-primary)] max-w-[160px] truncate">
                {display}
              </span>
              <ChevronDownIcon className="h-4 w-4 text-[var(--color-text-tertiary)]" />
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
              <Menu.Items className="absolute right-0 mt-2 w-52 origin-top-right rounded-[var(--radius-lg)] bg-white shadow-lg ring-1 ring-black/5 py-1 z-50">
                {isAdmin && (
                  <Menu.Item>
                    {({ active }) => (
                      <Link
                        href="/onboarding"
                        className={`${active ? 'bg-gray-50' : ''} block px-4 py-2 text-sm text-gray-700`}
                      >
                        Setup guide
                      </Link>
                    )}
                  </Menu.Item>
                )}
                <Menu.Item>
                  {({ active }) => (
                    <button
                      type="button"
                      className={`${
                        active ? 'bg-gray-50' : ''
                      } flex w-full items-center gap-2 px-4 py-2 text-sm text-gray-700`}
                      onClick={() => {
                        if (isCognitoConfigured()) { cognitoSignOut(); window.location.href = '/login' }
                        else if (isSupabaseInitialized()) void supabase.auth.signOut().then(() => (window.location.href = '/login'))
                        else window.location.href = '/login'
                      }}
                    >
                      <ArrowRightOnRectangleIcon className="h-4 w-4" />
                      Sign out
                    </button>
                  )}
                </Menu.Item>
              </Menu.Items>
            </Transition>
          </Menu>
          </div>
        </header>
        <BackgroundActivityBanner />
        <main className="relative w-full flex-1 min-h-0 flex flex-col pk-container py-8">{children}</main>
      </div>
    </div>
  )
}
