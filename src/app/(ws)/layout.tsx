import AuthGate from '@/components/providers/AuthGate'

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <AuthGate>{children}</AuthGate>
}
