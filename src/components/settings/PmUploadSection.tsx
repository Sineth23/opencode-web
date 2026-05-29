'use client'

import { useRef, useState } from 'react'
import { cdkPost } from '@/lib/cdk-api'
import {
  ArrowUpTrayIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  DocumentIcon,
} from '@heroicons/react/24/outline'

type UploadState =
  | { phase: 'idle' }
  | { phase: 'presigning' }
  | { phase: 'uploading'; filename: string; progress: number }
  | { phase: 'done'; filename: string; s3Uri: string }
  | { phase: 'error'; message: string }

const ACCEPTED = '.csv,.xlsx,.xls,.json,.txt,.pdf,.docx'

export default function PmUploadSection() {
  const [projectId, setProjectId] = useState('default')
  const [state, setState] = useState<UploadState>({ phase: 'idle' })
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const upload = async (file: File) => {
    setState({ phase: 'presigning' })
    try {
      // 1. Get presigned URL
      const pid = projectId.trim() || 'default'
      const contentType = file.type || 'application/octet-stream'

      const data = await cdkPost<{
        ok: boolean
        presignedUrl: string
        s3Uri: string
        contentType: string
        key: string
      }>(`/projects/${encodeURIComponent(pid)}/pm/uploads/presign`, {
        filename: file.name,
        contentType,
        projectId: pid,
      })

      if (!data.ok || !data.presignedUrl) {
        throw new Error('Failed to get upload URL')
      }

      // 2. PUT file directly to S3
      setState({ phase: 'uploading', filename: file.name, progress: 0 })

      const xhr = new XMLHttpRequest()
      await new Promise<void>((resolve, reject) => {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setState({
              phase: 'uploading',
              filename: file.name,
              progress: Math.round((e.loaded / e.total) * 100),
            })
          }
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve()
          else reject(new Error(`Upload failed: HTTP ${xhr.status}`))
        }
        xhr.onerror = () => reject(new Error('Network error during upload'))
        xhr.open('PUT', data.presignedUrl)
        xhr.setRequestHeader('Content-Type', data.contentType)
        xhr.send(file)
      })

      setState({ phase: 'done', filename: file.name, s3Uri: data.s3Uri })
    } catch (e: unknown) {
      setState({ phase: 'error', message: (e as Error)?.message ?? 'Upload failed.' })
    }
  }

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    void upload(files[0])
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    handleFiles(e.dataTransfer.files)
  }

  const busy = state.phase === 'presigning' || state.phase === 'uploading'

  return (
    <section className="pk-card p-6 sm:p-8 space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">PM File Upload</h2>
        <p className="text-sm text-[var(--color-text-secondary)] mt-1">
          Upload project management files — timesheets, issue exports, planning documents — directly
          into your workspace S3 bucket for SR&amp;ED analysis. Files land under{' '}
          <span className="font-mono text-xs text-[var(--color-text-primary)]">
            projects/&#123;projectId&#125;/pm/manual/uploads/
          </span>
          .
        </p>
      </div>

      {/* Project ID */}
      <div className="max-w-xs">
        <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
          Project ID <span className="text-[var(--color-text-tertiary)] font-normal">(optional)</span>
        </label>
        <input
          type="text"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          disabled={busy}
          placeholder="default"
          className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
        />
      </div>

      {/* Drop zone */}
      {(state.phase === 'idle' || state.phase === 'error') && (
        <>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-colors ${
              dragOver
                ? 'border-primary bg-primary/5'
                : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-primary/40 hover:bg-primary/3'
            }`}
          >
            <ArrowUpTrayIcon className="h-8 w-8 text-[var(--color-text-tertiary)]" aria-hidden />
            <div>
              <p className="text-sm font-medium text-[var(--color-text-primary)]">
                Drop a file here, or <span className="text-primary">browse</span>
              </p>
              <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
                CSV, Excel, JSON, TXT, PDF, DOCX · one file at a time
              </p>
            </div>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED}
            className="sr-only"
            onChange={(e) => handleFiles(e.target.files)}
          />

          {state.phase === 'error' && (
            <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
              <ExclamationTriangleIcon className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
              {state.message}
              <button
                type="button"
                className="ml-auto text-xs font-medium text-red-700 hover:underline shrink-0"
                onClick={() => setState({ phase: 'idle' })}
              >
                Dismiss
              </button>
            </div>
          )}
        </>
      )}

      {/* Presigning */}
      {state.phase === 'presigning' && (
        <StatusRow icon="spin" text="Getting secure upload URL…" />
      )}

      {/* Uploading */}
      {state.phase === 'uploading' && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <DocumentIcon className="h-5 w-5 text-[var(--color-text-tertiary)] shrink-0" aria-hidden />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">{state.filename}</p>
                <span className="text-xs text-[var(--color-text-tertiary)] shrink-0 ml-2">{state.progress}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${state.progress}%` }}
                />
              </div>
            </div>
          </div>
          <p className="text-xs text-[var(--color-text-tertiary)]">Uploading directly to S3 — never passes through AutoDoc servers.</p>
        </div>
      )}

      {/* Done */}
      {state.phase === 'done' && (
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-4 py-3">
            <CheckCircleIcon className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium text-emerald-900">Upload complete</p>
              <p className="text-xs text-emerald-800 mt-0.5 truncate">
                <span className="font-medium">{state.filename}</span> is now in your workspace.
              </p>
              <p className="mt-1 font-mono text-[11px] text-emerald-700 break-all">{state.s3Uri}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setState({ phase: 'idle' })}
            className="text-xs font-medium text-primary hover:underline"
          >
            Upload another file
          </button>
        </div>
      )}
    </section>
  )
}

function StatusRow({ icon, text }: { icon: 'spin'; text: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <svg className="animate-spin h-5 w-5 text-primary shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden>
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
      <p className="text-sm text-[var(--color-text-secondary)]">{text}</p>
    </div>
  )
}
