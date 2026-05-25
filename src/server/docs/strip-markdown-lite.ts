/**
 * Best-effort markdown → plain text for PDF export (no full parser).
 */
export function stripMarkdownLite(md: string): string {
  let s = md
  s = s.replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, '\n').replace(/```/g, ''))
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/^#{1,6}\s+/gm, '')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/_([^_]+)_/g, '$1')
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  s = s.replace(/^>\s?/gm, '')
  s = s.replace(/^[-*+]\s+/gm, '• ')
  s = s.replace(/^\d+\.\s+/gm, '')
  s = s.replace(/\|/g, ' ')
  s = s.replace(/-{3,}/g, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}
