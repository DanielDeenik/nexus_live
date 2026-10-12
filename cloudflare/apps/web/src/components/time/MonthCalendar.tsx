import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { addDays, isWorkingDay, iso, parseIso, today } from '../../lib/period'
import { hoursLabel, summary } from '../../lib/time'
import { hrs } from '../../lib/nexus'
import { btnIcon } from './ui'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

interface Props {
  /** Hours a working day should hold (from the profile). */
  targetHours: number | null
  holidays: Set<string>
  /** Month shown first, as YYYY-MM-01. */
  initialMonth?: string
}

// Month grid of daily totals. Past working days below target are highlighted;
// clicking a day opens its entries.
export function MonthCalendar({ targetHours, holidays, initialMonth }: Props) {
  const navigate = useNavigate()
  const [month, setMonth] = useState(() => initialMonth ?? `${today().slice(0, 7)}-01`)
  const [byDay, setByDay] = useState<Map<string, number>>(new Map())
  const [error, setError] = useState('')

  useEffect(() => { if (initialMonth) setMonth(initialMonth) }, [initialMonth])

  const next = useMemo(() => { const d = parseIso(month); return iso(new Date(d.getFullYear(), d.getMonth() + 1, 1)) }, [month])
  const prev = useMemo(() => { const d = parseIso(month); return iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)) }, [month])

  useEffect(() => {
    setError('')
    summary(['day'], month, next)
      .then((rows) => setByDay(new Map(rows.map((r) => [r.path[0], r.hours]))))
      .catch((e) => setError((e as Error).message))
  }, [month, next])

  const cells = useMemo(() => {
    const lead = (parseIso(month).getDay() + 6) % 7
    const out: (string | null)[] = Array.from({ length: lead }, () => null)
    for (let d = month; d < next; d = addDays(d, 1)) out.push(d)
    while (out.length % 7) out.push(null)
    return out
  }, [month, next])

  const now = today()
  const label = parseIso(month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button className={btnIcon} onClick={() => setMonth(prev)} aria-label="Previous month"><ChevronLeft size={18} /></button>
        <span className="text-sm font-medium text-slate-200">{label}</span>
        <button className={btnIcon} onClick={() => setMonth(next)} aria-label="Next month"><ChevronRight size={18} /></button>
      </div>
      {error && <p className="text-sm text-danger-400 mb-2">{error}</p>}
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((w) => <div key={w} className="text-[11px] uppercase text-slate-500 pb-1">{w}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={i} />
          const h = byDay.get(d)
          const working = isWorkingDay(d, holidays)
          const past = d < now
          const short = working && past && targetHours != null && (h ?? 0) < targetHours
          const tone = short
            ? 'border-warning-500/50 bg-warning-500/10 text-warning-200'
            : h
              ? 'border-sky-500/40 bg-sky-500/10 text-slate-100'
              : working ? 'border-slate-700/60 text-slate-400' : 'border-transparent text-slate-600'
          return (
            <button
              key={d}
              onClick={() => navigate(`/time/entries?from=${d}&to=${d}`)}
              title={`${d}: ${hoursLabel(h ?? 0)}${short ? ', below target' : ''}`}
              className={`min-w-0 rounded-md border px-0.5 py-1 sm:py-1.5 hover:border-slate-400 transition-colors ${tone} ${d === now ? 'ring-1 ring-cyan-500' : ''}`}
            >
              <div className="text-[11px] leading-none text-slate-400">{Number(d.slice(8))}</div>
              <div className="mt-1 text-xs sm:text-sm font-medium tabular-nums leading-none truncate">{h ? hrs(h) : working && past ? '0' : '\u00a0'}</div>
            </button>
          )
        })}
      </div>
      <p className="mt-3 text-xs text-slate-400 flex flex-wrap gap-x-4 gap-y-1">
        <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-warning-500/40 border border-warning-500/60" /> Working day below target</span>
        <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-sky-500/30 border border-sky-500/50" /> Hours logged</span>
      </p>
    </div>
  )
}
