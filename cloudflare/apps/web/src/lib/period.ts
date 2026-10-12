// Date periods for the time dashboard, ported from DTrack. Dates are ISO
// strings (YYYY-MM-DD) in local time and a period is half open: from is
// included, to is not.

export type Grain = 'week' | 'month' | 'quarter' | 'year'
export interface Period {
  grain: Grain
  from: string
  to: string
  label: string
}

export const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const today = () => iso(new Date())

export const parseIso = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export const addDays = (s: string, n: number) => {
  const d = parseIso(s)
  return iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n))
}

export function periodOf(grain: Grain, anchor: Date): Period {
  const y = anchor.getFullYear()
  const m = anchor.getMonth()
  let start: Date
  let end: Date
  let label: string
  if (grain === 'week') {
    const dow = (anchor.getDay() + 6) % 7 // Monday = 0
    start = new Date(y, m, anchor.getDate() - dow)
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1)
    const f = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    label = `${f(start)} to ${f(last)} ${last.getFullYear()}`
  } else if (grain === 'month') {
    start = new Date(y, m, 1)
    end = new Date(y, m + 1, 1)
    label = start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  } else if (grain === 'quarter') {
    const q = Math.floor(m / 3)
    start = new Date(y, q * 3, 1)
    end = new Date(y, q * 3 + 3, 1)
    label = `Q${q + 1} ${y}`
  } else {
    start = new Date(y, 0, 1)
    end = new Date(y + 1, 0, 1)
    label = String(y)
  }
  return { grain, from: iso(start), to: iso(end), label }
}

export function shift(p: Period, steps: number): Period {
  const a = parseIso(p.from)
  const months = { week: 0, month: 1, quarter: 3, year: 12 }[p.grain]
  const next = p.grain === 'week'
    ? new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7 * steps)
    : new Date(a.getFullYear(), a.getMonth() + months * steps, 1)
  return periodOf(p.grain, next)
}

export const isWorkingDay = (s: string, holidays: Set<string>) => {
  const dow = parseIso(s).getDay()
  return dow !== 0 && dow !== 6 && !holidays.has(s)
}

/** Working days from `from` up to and including `until` (capped at the period end). */
export function workingDays(from: string, toExclusive: string, until: string, holidays: Set<string>): number {
  let n = 0
  for (let s = from; s < toExclusive && s <= until; s = addDays(s, 1)) {
    if (isWorkingDay(s, holidays)) n++
  }
  return n
}
