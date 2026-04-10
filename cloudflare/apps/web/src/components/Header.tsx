import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Search, Bell, Settings, ChevronDown, LogOut } from 'lucide-react'

const pageNames: Record<string, string> = {
  '/': 'Dashboard',
  '/forecast': 'Forecast',
  '/budget': 'Budget Management',
  '/scenarios': 'Scenario Planner',
  '/treasury': 'Treasury',
  '/invoices': 'Invoices',
  '/market': 'Market Intelligence',
  '/insights': 'AI Insights',
  '/settings': 'Settings',
}

interface HeaderProps {
  userName?: string
  onLogout?: () => void
  notificationCount?: number
}

export function Header({
  userName = 'User',
  onLogout,
  notificationCount = 0,
}: HeaderProps) {
  const location = useLocation()
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)
  const currentPage = pageNames[location.pathname] || 'Dashboard'

  return (
    <header className="h-16 border-b border-slate-700/50 glass-dark px-6 flex items-center justify-between sticky top-0 z-40">
      {/* Left: Page title and breadcrumb */}
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-slate-50">{currentPage}</h1>
      </div>

      {/* Right: Search, notifications, user menu */}
      <div className="flex items-center gap-4">
        {/* Search */}
        <div className="hidden md:flex items-center gap-2 bg-slate-800/50 border border-slate-700/50 rounded-lg px-3 py-1.5 w-64 transition-all focus-within:border-cyan-500/50">
          <Search size={16} className="text-slate-500" />
          <input
            type="text"
            placeholder="Search..."
            className="bg-transparent text-slate-50 placeholder-slate-500 focus:outline-none text-sm flex-1"
          />
        </div>

        {/* Notifications */}
        <button className="relative p-2 hover:bg-slate-700/50 rounded-lg transition-colors">
          <Bell size={18} className="text-slate-400 hover:text-slate-200" />
          {notificationCount > 0 && (
            <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full animate-pulse" />
          )}
        </button>

        {/* Settings */}
        <button className="p-2 hover:bg-slate-700/50 rounded-lg transition-colors">
          <Settings size={18} className="text-slate-400 hover:text-slate-200" />
        </button>

        {/* User Menu */}
        <div className="relative">
          <button
            onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
            className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-700/50 rounded-lg transition-colors"
          >
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-cyan-500 to-teal-600" />
            <span className="text-sm text-slate-300 hidden sm:inline">{userName}</span>
            <ChevronDown
              size={16}
              className={`text-slate-500 transition-transform duration-200 ${
                isUserMenuOpen ? 'rotate-180' : ''
              }`}
            />
          </button>

          {/* Dropdown Menu */}
          {isUserMenuOpen && (
            <div className="absolute right-0 mt-2 w-48 glass rounded-lg shadow-xl border border-slate-700/50 overflow-hidden animate-fade-in">
              <button className="w-full text-left px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-700/50 transition-colors flex items-center gap-2">
                <Settings size={16} />
                Account Settings
              </button>
              <button
                onClick={() => {
                  setIsUserMenuOpen(false)
                  onLogout?.()
                }}
                className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-slate-700/50 transition-colors flex items-center gap-2 border-t border-slate-700/50"
              >
                <LogOut size={16} />
                Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
