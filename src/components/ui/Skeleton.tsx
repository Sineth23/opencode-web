import type React from 'react'

/**
 * Skeleton shimmer placeholders for loading states.
 * Uses the .pk-skeleton CSS class (shimmer animation in globals.css).
 */

type SkeletonProps = {
  className?: string
  width?: string | number
  height?: string | number
  style?: React.CSSProperties
}

/** Single shimmer block. Pass className with h-* and w-* to size it. */
export function Skeleton({ className = '', width, height, style }: SkeletonProps) {
  return (
    <div
      className={`pk-skeleton ${className}`}
      style={{ width, height, ...style }}
      aria-hidden="true"
    />
  )
}

/** Stack of text-line skeletons that mimics a paragraph. */
export function SkeletonText({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  const widths = ['100%', '92%', '78%', '95%', '85%', '70%']
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-3" style={{ width: widths[i % widths.length] }} />
      ))}
    </div>
  )
}

/** A card-shaped skeleton (rounded border, fixed height). */
export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div
      className={`rounded-[var(--radius-lg)] border border-[var(--color-border)] overflow-hidden ${className}`}
      aria-hidden="true"
    >
      <div className="pk-skeleton w-full h-full" />
    </div>
  )
}
