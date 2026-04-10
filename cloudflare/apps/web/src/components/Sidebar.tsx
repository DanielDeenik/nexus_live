import React, { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  TrendingUp,
  PieChart,
  Zap,
  Landmark,
  FileText,
  TrendingDown,
  Lightbulb,
  GitBranch,
  Settings,
  ChevronLeft,
  User,
} from 'lucide-react'

interface SidebarItem {
  label: string
  path: string
  icon: React.ReactNode
}

const sidebarItems: SidebarItem[] = [
  { label: 'Dashboard', path: '/', icon: <LayoutDashboard size={20} /> },
  { label: 'Forecast', path: '/forecast', icon: <TrendingUp size={20} /> },
  { label: 'Budget', path: '/budget', icon: <PieChart size={20} /> },
  { label: 'Scenarios', path: '/scenarios', icon: <Zap size={20} /> },
  { label: 'Treasury', path: '/treasury', icon: <Landmark size={20} /> },
  { label: 'Invoices', path: '/invoices', icon: <FileText size={20} /> },
  { label: 'Market', path: '/market', icon: <TrendingDown size={20} /> },
  { label: 'Commitments', path: '/commitments', icon: <GitBranch size={20} /> },
  { label: 'Insights', path: '/insights', icon: <Lightbulb size={20} /> },
  { label: 'Settings', path: '/settings', icon: <Settings size={20} /> },
]

interface SidebarProps {
  isCollapsed?: boolean
  onToggleCollapse?: (collapsed: boolean) => void
  userName?: string
  userRole?: string
}

export function Sidebar({
  isCollapsed = false,
  onToggleCollapse,
  userName = 'User',
  userRole = 'Founder',
}: SidebarProps) {
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(isCollapsed)

  const toggleCollapse = () => {
    const newState = !collapsed
    setCollapsed(newState)
    onToggleCollapse?.(newState)
  }

  return (
    <div
      className={`glass-dark flex flex-col h-screen border-r border-slate-700/50 transition-all duration-300 ${
        collapsed ? 'w-20' : 'w-64'
      }`}
    >
      {/* Branding */}
      <div className="flex items-center justify-between p-4 border-b border-slate-700/50">
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-cyan-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm">N</span>
            </div>
            <span className="text-lg font-bold text-slate-50">Nexus</span>
          </div>
        )}
        <button
          onClick={toggleCollapse}
          className="p-1 hover:bg-slate-700/50 rounded-lg transition-colors"
        >
          <ChevronLeft
            size={18}
            className={`text-slate-500 transition-transform duration-300 ${collapsed ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-4 space-y-2">
        {sidebarItems.map((item) => {
          const isActive = location.pathname === item.path
          return (
            <Link
              key={item.path}
              to={item.path}
              title={collapsed ? item.label : undefined}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 ${
                isActive
                  ? 'bg-slate-700/50 text-cyan-400 border-l-2 border-cyan-500'
                  : 'text-slate-400 hover:bg-slate-700/30 hover:text-slate-300'
              }`}
            >
              <span className="flex-shrink-0">{item.icon}</span>
              {!collapsed && <span className="text-sm font-medium">{item.label}</span>}
            </Link>
          )
        })}
      </nav>

      {/* User Profile */}
      <div className="p-4 border-t border-slate-700/50">
        <div
          className={`flex items-center gap-3 px-2 py-2 rounded-lg ${collapsed ? 'justify-center' : ''}`}
        >
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500 to-teal-600 flex items-center justify-center flex-shrink-0">
            <User size={16} className="text-white" />
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-slate-50 truncate">
                {userName}
              </p>
              <p className="text-xs text-slate-400 truncate">{userRole}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
