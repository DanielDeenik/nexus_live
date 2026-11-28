import React from 'react'
import { TopBar } from './TopBar'

interface LayoutProps {
  children: React.ReactNode
  userName?: string
  onLogout?: () => void
}

/** Every signed-in page of Nexus live: the night band, then the page on the paper ground. */
export function Layout({ children, userName, onLogout }: LayoutProps) {
  return (
    <div className="min-h-screen bg-paper">
      <TopBar userName={userName} onLogout={onLogout} />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 pt-8 pb-16">
        <div className="animate-fade-in">{children}</div>
      </main>
    </div>
  )
}
