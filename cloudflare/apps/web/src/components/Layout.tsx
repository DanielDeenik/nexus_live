import React, { useState } from 'react'
import { Sidebar } from './Sidebar'
import { Header } from './Header'

interface LayoutProps {
  children: React.ReactNode
  userName?: string
  userRole?: string
  notificationCount?: number
  onLogout?: () => void
}

export function Layout({
  children,
  userName = 'User',
  userRole = 'Founder',
  notificationCount = 0,
  onLogout,
}: LayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileMenu, setMobileMenu] = useState(false)

  return (
    <div className="flex h-screen bg-slate-950 overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        isCollapsed={sidebarCollapsed}
        onToggleCollapse={setSidebarCollapsed}
        userName={userName}
        userRole={userRole}
        mobileOpen={mobileMenu}
        onNavigate={() => setMobileMenu(false)}
      />
      {mobileMenu && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setMobileMenu(false)} aria-hidden="true" />
      )}

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Header */}
        <Header
          userName={userName}
          onLogout={onLogout}
          notificationCount={notificationCount}
          onMenu={() => setMobileMenu(true)}
        />

        {/* Content */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6">
          <div className="animate-fade-in">{children}</div>
        </main>
      </div>
    </div>
  )
}
