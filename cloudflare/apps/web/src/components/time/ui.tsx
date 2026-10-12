import React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// Small shared pieces for the time pages, in the Nexus dark slate style.

export const input = 'rounded-lg bg-slate-900 border-slate-700 text-slate-100 text-sm'
export const btnPrimary = 'rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-sm px-4 py-2 inline-flex items-center gap-2'
export const btnGhost = 'rounded-lg border border-slate-600 hover:bg-slate-700/40 text-slate-200 text-sm px-3 py-2 inline-flex items-center gap-2 disabled:opacity-50'
export const btnIcon = 'p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-700/50 disabled:opacity-40'

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-slate-50">{title}</h1>
        {subtitle && <p className="text-sm text-slate-400">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  )
}

export function Tile({ label, value, hint }: { label: string; value: string; hint?: React.ReactNode }) {
  return (
    <div className="glass p-4 sm:p-5 min-w-0">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-50 tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  )
}

export function Chip({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'warn' | 'info' | 'good' | 'bad'; title?: string }) {
  const tones = {
    muted: 'border-slate-600 text-slate-300',
    warn: 'border-warning-500/50 text-warning-300 bg-warning-500/10',
    info: 'border-sky-500/40 text-sky-300 bg-sky-500/10',
    good: 'border-success-500/40 text-success-300 bg-success-500/10',
    bad: 'border-danger-500/40 text-danger-300 bg-danger-500/10',
  }
  return <span title={title} className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${tones[tone]}`}>{children}</span>
}

export function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block text-xs text-slate-400 ${className}`}>
      {label}
      <div className="mt-1">{children}</div>
    </label>
  )
}

export function ErrorNote({ message }: { message: string }) {
  if (!message) return null
  return <p className="text-sm text-danger-400 break-words">{message}</p>
}

export function Pager({ page, perPage, total, onPage }: { page: number; perPage: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / perPage))
  const first = total === 0 ? 0 : (page - 1) * perPage + 1
  const last = Math.min(total, page * perPage)
  return (
    <div className="mt-3 flex items-center justify-between gap-2 text-sm text-slate-400">
      <span className="tabular-nums">{first} to {last} of {total}</span>
      <div className="flex items-center gap-1">
        <button className={btnIcon} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft size={18} /></button>
        <span className="tabular-nums px-1">{page} / {pages}</span>
        <button className={btnIcon} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight size={18} /></button>
      </div>
    </div>
  )
}

/** Table header cell and body cell classes shared by the time tables. */
export const th = 'py-2 pr-4 font-medium whitespace-nowrap'
export const td = 'py-2 pr-4 align-top'
