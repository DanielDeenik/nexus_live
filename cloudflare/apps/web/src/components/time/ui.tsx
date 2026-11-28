import React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// Small shared pieces for the Nexus live pages, in the LensIQ look (tokens in lib/theme.ts).

export const input = 'rounded-lg bg-card border-line text-ink text-sm focus:border-ink focus:ring-lemon'
export const btnPrimary = 'rounded-lg bg-ink hover:bg-night-2 disabled:opacity-50 text-white text-sm px-4 py-2 inline-flex items-center gap-2'
export const btnGhost = 'rounded-lg border border-line bg-card hover:bg-chip text-ink text-sm px-3 py-2 inline-flex items-center gap-2 disabled:opacity-50'
export const btnIcon = 'p-1.5 rounded-lg text-muted hover:text-ink hover:bg-chip disabled:opacity-40'

/** Page title in the LensIQ style: optional mono eyebrow, Manrope heading, the double lemon rule. */
export function PageHeader({ title, subtitle, action, eyebrow }: { title: string; subtitle?: string; action?: React.ReactNode; eyebrow?: string }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
        <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
        <div className="lemon-rule" aria-hidden="true" />
        {subtitle && <p className="mt-3 text-sm text-muted">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  )
}

export function Tile({ label, value, hint }: { label: string; value: string; hint?: React.ReactNode }) {
  return (
    <div className="tile p-4 sm:p-5 min-w-0">
      <p className="eyebrow">{label}</p>
      <p className="mt-2 font-display text-2xl font-bold text-ink tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  )
}

export function Chip({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'warn' | 'info' | 'good' | 'bad'; title?: string }) {
  const tones = {
    muted: 'border-line text-body',
    warn: 'border-lemon text-lemon-ink bg-lemon-soft',
    info: 'border-line text-ink bg-chip',
    good: 'border-good/30 text-good bg-good-soft',
    bad: 'border-bad/30 text-bad bg-bad-soft',
  }
  return <span title={title} className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${tones[tone]}`}>{children}</span>
}

export function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block text-xs text-muted ${className}`}>
      {label}
      <div className="mt-1">{children}</div>
    </label>
  )
}

export function ErrorNote({ message }: { message: string }) {
  if (!message) return null
  return <p className="text-sm text-bad break-words">{message}</p>
}

export function Pager({ page, perPage, total, onPage }: { page: number; perPage: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / perPage))
  const first = total === 0 ? 0 : (page - 1) * perPage + 1
  const last = Math.min(total, page * perPage)
  return (
    <div className="mt-3 flex items-center justify-between gap-2 text-sm text-muted">
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
