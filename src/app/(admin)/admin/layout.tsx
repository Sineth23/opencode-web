import type { Metadata } from 'next'
import AdminAuthGate from '@/components/admin/AdminAuthGate'

export const metadata: Metadata = {
  title: 'Platform admin',
}

export default function AdminSectionLayout({ children }: { children: React.ReactNode }) {
  return <AdminAuthGate>{children}</AdminAuthGate>
}
