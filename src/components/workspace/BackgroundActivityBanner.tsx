'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { authorizedFetch } from '@/lib/api'
import { useWorkspace } from '@/components/providers/WorkspaceContext'

type Activity = {
  sync: { queued: number; running: number }
  documentation: { queued: number; running: number }
}

const POLL_MS_ACTIVE = 7000
const POLL_MS_IDLE = 22000

export default function BackgroundActivityBanner() {
  const { workspace } = useWorkspace()
  const [activity, setActivity] = useState<Activity | null>(null)
  const [hidden, setHidden] = useState(false)

  const load = useCallback(async () => {
    if (!workspace?.id) return
    try {
      const res = await authorizedFetch(`/api/workspace/background-activity?workspace_id=${workspace.id}`)
      if (!res.ok) return
      const j = (await res.json()) as Activity
      setActivity(j)
    } catch {
      /* ignore */
    }
  }, [workspace?.id])

  const busy =
    activity &&
    (activity.sync.queued + activity.sync.running + activity.documentation.queued + activity.documentation.running > 0)

  useEffect(() => {
    if (!workspace?.id) return
    void load()
  }, [workspace?.id, load])

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && workspace?.id) void load()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [workspace?.id, load])

  useEffect(() => {
    if (!workspace?.id) return
    const ms = busy ? POLL_MS_ACTIVE : POLL_MS_IDLE
    const id = window.setInterval(() => void load(), ms)
    return () => window.clearInterval(id)
  }, [workspace?.id, busy, load])

  useEffect(() => {
    if (busy) setHidden(false)
  }, [busy])

  if (!activity || !busy || hidden) return null

  const parts: string[] = []
  if (activity.sync.running > 0) {
    parts.push(`${activity.sync.running} repository sync${activity.sync.running > 1 ? 's' : ''} running`)
  }
  if (activity.sync.queued > 0) {
    parts.push(`${activity.sync.queued} sync${activity.sync.queued > 1 ? 's' : ''} queued`)
  }
  if (activity.documentation.running > 0) {
    parts.push(`${activity.documentation.running} documentation job${activity.documentation.running > 1 ? 's' : ''} running`)
  }
  if (activity.documentation.queued > 0) {
    parts.push(`${activity.documentation.queued} documentation job${activity.documentation.queued > 1 ? 's' : ''} queued`)
  }

  const summary = parts.length > 0 ? parts.join(' · ') : 'Background work in progress'

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-b border-sky-200/90 bg-gradient-to-r from-sky-50 via-white to-indigo-50/80 px-4 lg:px-8 py-2.5 flex flex-wrap items-center gap-3 gap-y-2 text-sm text-sky-950"
    >
      <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-60" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-sky-500" />
      </span>
      <p className="font-medium text-sky-950 flex-1 min-w-[12rem]">
        <span className="text-sky-800/90">Working in the background:</span> {summary}
      </p>
      <div
        className="h-1 flex-1 min-w-[4rem] max-w-xs rounded-full bg-sky-100 overflow-hidden hidden sm:block"
        aria-hidden
      >
        <div className="h-full w-full bg-sky-400/50 rounded-full animate-pulse" />
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Link
          href="/settings/sync"
          className="text-sm font-semibold text-primary hover:underline underline-offset-2"
        >
          View sync center
        </Link>
        <button
          type="button"
          onClick={() => setHidden(true)}
          className="text-xs font-medium text-sky-700 hover:text-sky-900 px-2 py-1 rounded-md hover:bg-sky-100/80"
        >
          Hide
        </button>
      </div>
    </div>
  )
}
