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
  Receipt,
  ClipboardCheck,
  Scale,
  Bot,
  Clock,
  ListChecks,
  FolderKanban,
  Waves,
  Smartphone,
  Briefcase,
  Gauge,
  Send,
  Radar,
} from 'lucide-react'

interface SidebarItem {
  label: string
  path: string
  icon: React.ReactNode
  /** Starts a labelled group in the menu. */
  group?: string
  /** Draws a rule above the item to close the group before it. */
  divider?: boolean
}

const sidebarItems: SidebarItem[] = [
  { label: 'Income & Tax', path: '/', icon: <LayoutDashboard size={20} /> },
  { label: 'Time', path: '/time', icon: <Clock size={20} />, group: 'Time' },
  { label: 'Time entries', path: '/time/entries', icon: <ListChecks size={20} /> },
  { label: 'Projects', path: '/time/projects', icon: <FolderKanban size={20} /> },
  { label: 'Flow blocks', path: '/time/flow', icon: <Waves size={20} /> },
  { label: 'Devices', path: '/time/devices', icon: <Smartphone size={20} /> },
  { label: 'Recruiter', path: '/recruiter', icon: <Briefcase size={20} />, group: 'Recruiter' },
  { label: 'Fit reports', path: '/recruiter/fit', icon: <Gauge size={20} /> },
  { label: 'Applications', path: '/recruiter/applications', icon: <Send size={20} /> },
  { label: 'Roles', path: '/recruiter/roles', icon: <Radar size={20} /> },
  { label: 'Review', path: '/review', icon: <ClipboardCheck size={20} />, divider: true },
  { label: 'Expenses', path: '/expenses', icon: <Receipt size={20} /> },
  { label: 'Tax filings', path: '/tax', icon: <Scale size={20} /> },
  { label: 'Agent settings', path: '/agent-settings', icon: <Bot size={20} /> },
  { label: 'Overview (legacy)', path: '/overview', icon: <LayoutDashboard size={20} /> },
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
  /** Phone widths: the menu slides in over the page. */
  mobileOpen?: boolean
  onNavigate?: () => void
  userName?: string
  userRole?: string
}

export function Sidebar({
  isCollapsed = false,
  onToggleCollapse,
  userName = 'User',
  userRole = 'Founder',
  mobileOpen = false,
  onNavigate,
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
      className={`glass-dark flex flex-col h-screen border-r border-slate-700/50 transition-all duration-300 fixed inset-y-0 left-0 z-50 w-64 bg-slate-900 md:bg-slate-900/50 md:static md:z-auto md:translate-x-0 ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      } ${collapsed ? 'md:w-20' : 'md:w-64'}`}
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
          className="hidden md:block p-1 hover:bg-slate-700/50 rounded-lg transition-colors"
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
            <React.Fragment key={item.path}>
            {item.divider && <div className="my-2 border-t border-slate-700/50" />}
            {item.group && !collapsed && (
              <p className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{item.group}</p>
            )}
            <Link
              to={item.path}
              onClick={onNavigate}
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
            </React.Fragment>
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
