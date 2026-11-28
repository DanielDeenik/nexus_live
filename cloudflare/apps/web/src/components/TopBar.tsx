import { useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { Menu, X } from 'lucide-react'
import { Brand } from './Brand'
import { NAV, sectionFor } from '../lib/nav'

interface TopBarProps {
  userName?: string
  onLogout?: () => void
}

/** The night band across the top of every Nexus live page, as on lensiq.company. */
export function TopBar({ userName, onLogout }: TopBarProps) {
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const section = sectionFor(pathname)
  const link = (active: boolean) =>
    `py-1 border-b-2 transition-colors ${active ? 'text-white border-lemon' : 'text-night-muted border-transparent hover:text-white'}`

  return (
    <header className="bg-night text-night-body sticky top-0 z-30 border-b border-night-line">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 min-h-16 flex items-center justify-between gap-6">
        <Link to="/look" aria-label="Nexus live, Look-through"><Brand tone="dark" /></Link>

        <nav aria-label="Nexus live" className="hidden lg:flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium">
          {NAV.map((n) => (
            <Link key={n.path} to={n.path} aria-current={section?.path === n.path ? 'page' : undefined} className={link(section?.path === n.path)}>
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3 text-sm">
          {userName && <span className="hidden sm:inline text-night-muted truncate max-w-[12rem]">{userName}</span>}
          <button type="button" onClick={onLogout} className="hidden sm:inline-flex rounded-lg border border-night-line px-3 py-1.5 text-night-body hover:text-white hover:border-night-muted transition-colors">
            Sign out
          </button>
          <button type="button" onClick={() => setOpen((v) => !v)} className="lg:hidden p-2 -mr-2 text-night-body hover:text-white" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open}>
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {open && (
        <nav aria-label="Nexus live menu" className="lg:hidden max-w-6xl mx-auto px-4 sm:px-6 py-3 grid gap-1 border-b border-night-line">
          {NAV.map((n) => (
            <Link key={n.path} to={n.path} onClick={() => setOpen(false)}
              className={`rounded-lg px-3 py-2 text-sm ${section?.path === n.path ? 'bg-night-2 text-white' : 'text-night-body hover:bg-night-2'}`}>
              {n.label}
            </Link>
          ))}
          <button type="button" onClick={() => { setOpen(false); onLogout?.() }} className="sm:hidden text-left rounded-lg px-3 py-2 text-sm text-night-body hover:bg-night-2">
            Sign out
          </button>
        </nav>
      )}

      {section?.sub && (
        <div className="bg-night-2">
          <nav aria-label={section.label} className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-wrap gap-x-4 gap-y-1 py-2 text-sm">
            {section.sub.map((s) => (
              <NavLink key={s.path} to={s.path} end className={({ isActive }) => link(isActive)}>{s.label}</NavLink>
            ))}
          </nav>
        </div>
      )}
    </header>
  )
}
