import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })

export const metadata: Metadata = {
  title: {
    default: 'AutoDoc',
    template: '%s · AutoDoc',
  },
  description:
    'Connect knowledge sources, generate plain-language product documentation, and get grounded answers about how your software works.',
  icons: {
    icon: '/icon/favicon.png',
    shortcut: '/icon/favicon.png',
    apple: '/icon/favicon.png',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.className}>
      <body className="min-h-screen">{children}</body>
    </html>
  )
}
