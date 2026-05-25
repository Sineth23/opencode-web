'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { ArrowTopRightOnSquareIcon, KeyIcon, StopIcon, PlayIcon, ClipboardDocumentIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/24/outline'
import { cognitoGetIdToken } from '@/lib/cognito'

const SESSION_KEY = 'autodoc_workspace_session_id'
const PASSWORD_KEY = 'autodoc_workspace_session_password'
const ALB_URL = process.env.NEXT_PUBLIC_ALB_URL || ''
const API_URL = process.env.NEXT_PUBLIC_CDK_API_URL || 'https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com'

type Phase = 'idle' | 'starting' | 'running' | 'stopping' | 'error'

async function apiFetch(path: string, method: string, body?: object) {
  const token = cognitoGetIdToken() || localStorage.getItem('cognito_id_token')
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return res.json()
}

export default function WorkspacePage() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [password, setPassword] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [copied, setCopied] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== undefined) {
      clearInterval(pollTimer.current)
      pollTimer.current = undefined
    }
  }, [])

  const handleSessionEnded = useCallback(() => {
    stopPolling()
    setSessionId(null)
    setPassword(null)
    localStorage.removeItem(SESSION_KEY)
    sessionStorage.removeItem(PASSWORD_KEY)
    setPhase('idle')
  }, [stopPolling])

  const pollStatus = useCallback(async (sid: string) => {
    try {
      const data = await apiFetch(`/opencode/sessions/${sid}`, 'GET')
      if (data.status === 'RUNNING') {
        stopPolling()
        setPhase('running')
      } else if (['STOPPED', 'SUCCEEDED', 'FAILED'].includes(data.status) || !data.ok) {
        handleSessionEnded()
      }
    } catch {
      // transient — keep polling
    }
  }, [stopPolling, handleSessionEnded])

  const startPolling = useCallback((sid: string) => {
    stopPolling()
    pollTimer.current = setInterval(() => void pollStatus(sid), 5000)
  }, [stopPolling, pollStatus])

  useEffect(() => {
    const savedId = localStorage.getItem(SESSION_KEY)
    const savedPw = sessionStorage.getItem(PASSWORD_KEY)
    if (!savedId) return

    setSessionId(savedId)
    if (savedPw) setPassword(savedPw)
    setPhase('starting')

    void (async () => {
      try {
        const data = await apiFetch(`/opencode/sessions/${savedId}`, 'GET')
        if (data.status === 'RUNNING') {
          setPhase('running')
        } else if (['STOPPED', 'SUCCEEDED', 'FAILED'].includes(data.status) || !data.ok) {
          handleSessionEnded()
        } else {
          startPolling(savedId)
        }
      } catch {
        handleSessionEnded()
      }
    })()

    return stopPolling
  }, [handleSessionEnded, startPolling, stopPolling])

  const handleLaunch = async () => {
    setPhase('starting')
    setErrorMsg('')
    try {
      const data = await apiFetch('/opencode/sessions', 'POST', {})
      if (!data.ok) {
        setPhase('error')
        setErrorMsg(data.error ?? 'Failed to start session')
        return
      }
      const sid: string = data.sessionId
      const pw: string = data.password ?? ''
      setSessionId(sid)
      setPassword(pw)
      localStorage.setItem(SESSION_KEY, sid)
      if (pw) sessionStorage.setItem(PASSWORD_KEY, pw)
      startPolling(sid)
    } catch (e: unknown) {
      setPhase('error')
      setErrorMsg((e as Error)?.message ?? 'Network error')
    }
  }

  const handleStop = async () => {
    const sid = sessionId
    setPhase('stopping')
    stopPolling()
    if (sid) {
      try {
        await apiFetch(`/opencode/sessions/${sid}`, 'DELETE')
      } catch {
        // best-effort
      }
    }
    handleSessionEnded()
  }

  const handleCopyPassword = () => {
    if (!password) return
    void navigator.clipboard.writeText(password).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">AI Workspace</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          Launch an AI-powered coding environment directly in your browser.
        </p>
      </div>

      {/* Status card */}
      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-6 space-y-5">
        {/* Status indicator */}
        <div className="flex items-center gap-3">
          {phase === 'idle' && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] text-sm">
              <span className="h-2 w-2 rounded-full bg-gray-400" />
              No active workspace
            </div>
          )}
          {phase === 'starting' && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 text-sm">
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Starting workspace… (~30s)
            </div>
          )}
          {phase === 'running' && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-50 text-green-700 text-sm">
              <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
              Workspace is ready
            </div>
          )}
          {phase === 'stopping' && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 text-amber-700 text-sm">
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Stopping…
            </div>
          )}
          {phase === 'error' && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-50 text-red-700 text-sm">
              <span className="h-2 w-2 rounded-full bg-red-500" />
              {errorMsg || 'Error starting workspace'}
            </div>
          )}
        </div>

        {/* Password display when running */}
        {phase === 'running' && password && (
          <div className="flex items-center gap-2 bg-[var(--color-bg-secondary)] rounded-lg px-4 py-3">
            <KeyIcon className="h-4 w-4 text-[var(--color-text-tertiary)] shrink-0" />
            <code className="flex-1 text-xs font-mono text-[var(--color-text-secondary)] truncate">{password}</code>
            <button
              onClick={handleCopyPassword}
              className="shrink-0 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
              title="Copy password"
            >
              {copied
                ? <ClipboardDocumentCheckIcon className="h-4 w-4 text-green-500" />
                : <ClipboardDocumentIcon className="h-4 w-4" />
              }
            </button>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-col gap-2">
          {(phase === 'idle' || phase === 'error') && (
            <button
              onClick={() => void handleLaunch()}
              className="flex items-center justify-center gap-2 w-full bg-primary text-white py-2.5 px-4 rounded-lg font-medium hover:bg-primary-dark transition-colors"
            >
              <PlayIcon className="h-4 w-4" />
              Launch Workspace
            </button>
          )}

          {phase === 'running' && (
            <>
              <a
                href={`${ALB_URL}/connect?session=${sessionId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full bg-green-600 text-white py-2.5 px-4 rounded-lg font-medium hover:bg-green-700 transition-colors"
              >
                Open Workspace
                <ArrowTopRightOnSquareIcon className="h-4 w-4" />
              </a>
              {password && (
                <button
                  onClick={handleCopyPassword}
                  className="flex items-center justify-center gap-2 w-full border border-[var(--color-border)] text-[var(--color-text-primary)] py-2.5 px-4 rounded-lg font-medium hover:bg-[var(--color-bg-tertiary)] transition-colors"
                >
                  {copied ? <ClipboardDocumentCheckIcon className="h-4 w-4 text-green-500" /> : <ClipboardDocumentIcon className="h-4 w-4" />}
                  {copied ? 'Copied!' : 'Copy Password'}
                </button>
              )}
              <button
                onClick={() => void handleStop()}
                className="flex items-center justify-center gap-2 w-full border border-red-200 text-red-600 py-2.5 px-4 rounded-lg font-medium hover:bg-red-50 transition-colors"
              >
                <StopIcon className="h-4 w-4" />
                Stop Session
              </button>
            </>
          )}

          {phase === 'starting' && (
            <button
              onClick={() => void handleStop()}
              className="flex items-center justify-center gap-2 w-full border border-[var(--color-border)] text-[var(--color-text-primary)] py-2.5 px-4 rounded-lg font-medium hover:bg-[var(--color-bg-tertiary)] transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Info card */}
      <div className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-border)] p-5 space-y-2">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">How it works</h3>
        <ul className="text-sm text-[var(--color-text-secondary)] space-y-1.5">
          <li className="flex gap-2"><span className="text-primary font-medium">1.</span> Click <strong>Launch Workspace</strong> to provision your AI coding environment.</li>
          <li className="flex gap-2"><span className="text-primary font-medium">2.</span> Wait ~30 seconds for the workspace to start.</li>
          <li className="flex gap-2"><span className="text-primary font-medium">3.</span> Click <strong>Open Workspace</strong> and enter the displayed password when prompted.</li>
          <li className="flex gap-2"><span className="text-primary font-medium">4.</span> Stop the session when done to free up resources.</li>
        </ul>
      </div>
    </div>
  )
}
