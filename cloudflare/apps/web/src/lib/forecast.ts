// Income and hours forecasting, ported from the old app (lib/forecast.js and
// lib/seasonalityEngine.js). Everything here is pure: no network, no React,
// no tunable numbers. Parameters arrive in a ForecastConfig parsed from
// app_config, so the same module runs in the browser and under deno test.

/** A calendar month as YYYY-MM. */
export type Month = string

export interface WorkCalendarConfig {
  /** ISO weekdays worked: 1 is Monday, 7 is Sunday. */
  weekdays: number[]
  /** Region the dates below belong to, for display only. */
  region?: string
  /** Days off on the client calendar (statutory holidays). */
  non_working_dates: { date: string; name?: string }[]
}

export interface ForecastConfig {
  alpha: number
  beta: number
  gamma: number
  confidenceLevel: number
  horizonMonths: number
  /** History window that feeds the model; full Holt-Winters only once it is filled. */
  historyMonths: number
  /** Below this many months of history the forecast is a flat run-rate. */
  minModelMonths: number
  anomalyZ: number
  /** How many peak and slow months the seasonality panel names. */
  peakSlowCount: number
  presets: Record<string, number[]>
  industry: string
  seasonalityWeight: number
  dailyHours: number
  workCalendar: WorkCalendarConfig
}

export const CONFIG_KEYS = {
  alpha: 'forecast.alpha',
  beta: 'forecast.beta',
  gamma: 'forecast.gamma',
  confidenceLevel: 'forecast.confidence_level',
  horizonMonths: 'forecast.horizon_months',
  historyMonths: 'forecast.history_months',
  minModelMonths: 'forecast.min_model_months',
  anomalyZ: 'forecast.anomaly_z_threshold',
  peakSlowCount: 'forecast.peak_slow_count',
  presets: 'forecast.seasonality_presets',
  industry: 'forecast.industry',
  seasonalityWeight: 'forecast.seasonality_weight',
  dailyHours: 'forecast.daily_hours',
  workCalendar: 'forecast.work_calendar',
} as const

/** app_config values are text holding JSON or a bare scalar. */
function parseValue(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return v }
}

/** Builds the config from app_config rows. A missing key fails loudly rather
 *  than falling back to a number written in code. */
export function configFromRows(rows: { key: string; value: unknown }[]): ForecastConfig {
  const byKey = new Map(rows.map((r) => [r.key, parseValue(r.value)]))
  const missing = Object.values(CONFIG_KEYS).filter((k) => !byKey.has(k))
  if (missing.length) throw new Error(`app_config is missing: ${missing.join(', ')}`)
  const n = (k: string) => {
    const v = Number(byKey.get(k))
    if (!Number.isFinite(v)) throw new Error(`app_config ${k} is not a number`)
    return v
  }
  const cal = byKey.get(CONFIG_KEYS.workCalendar) as WorkCalendarConfig
  const presets = byKey.get(CONFIG_KEYS.presets) as Record<string, number[]>
  if (!cal || !Array.isArray(cal.weekdays) || !Array.isArray(cal.non_working_dates)) throw new Error('app_config forecast.work_calendar needs weekdays and non_working_dates')
  if (!presets || typeof presets !== 'object' || !Object.values(presets).every((p) => Array.isArray(p) && p.length === MONTHS_PER_YEAR)) {
    throw new Error('app_config forecast.seasonality_presets needs twelve values per industry')
  }
  return {
    alpha: n(CONFIG_KEYS.alpha),
    beta: n(CONFIG_KEYS.beta),
    gamma: n(CONFIG_KEYS.gamma),
    confidenceLevel: n(CONFIG_KEYS.confidenceLevel),
    horizonMonths: n(CONFIG_KEYS.horizonMonths),
    historyMonths: n(CONFIG_KEYS.historyMonths),
    minModelMonths: n(CONFIG_KEYS.minModelMonths),
    anomalyZ: n(CONFIG_KEYS.anomalyZ),
    peakSlowCount: n(CONFIG_KEYS.peakSlowCount),
    presets,
    industry: String(byKey.get(CONFIG_KEYS.industry)),
    seasonalityWeight: n(CONFIG_KEYS.seasonalityWeight),
    dailyHours: n(CONFIG_KEYS.dailyHours),
    workCalendar: cal,
  }
}

// ---- statistics ------------------------------------------------------------

/** Calendar fact, not a tunable: a year has twelve months. */
export const MONTHS_PER_YEAR = 12

export const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)
export function std(a: number[]): number {
  if (a.length < 2) return 0
  const m = mean(a)
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1))
}

/** Inverse of the standard normal CDF (Acklam's rational approximation). */
export function probit(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`probit needs 0 < p < 1, got ${p}`)
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - lo) return -probit(1 - p)
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** Two-sided z for a confidence level, e.g. 0.95 gives about 1.96. */
export const zFor = (confidence: number) => probit((1 + confidence) / 2)

// ---- smoothing (ported from lib/forecast.js) -------------------------------

export interface Smoothed {
  fitted: number[]
  residuals: number[]
  forecast: number[]
  lower: number[]
  upper: number[]
  sigma: number
  type: 'holt-double' | 'holt-winters'
}

/** Holt's double exponential smoothing: level and trend, no season. The band
 *  widens with the square root of the step ahead. */
export function holtDouble(series: number[], o: { alpha: number; beta: number; h: number; z: number }): Smoothed {
  const n = series.length
  if (n === 0) return { fitted: [], residuals: [], forecast: [], lower: [], upper: [], sigma: 0, type: 'holt-double' }
  // Level starts at the first point and trend at the first step. Unlike the
  // old engine, the first point is not smoothed against a forecast of the
  // second, so a straight line is followed exactly and sigma is not inflated.
  let L = series[0]
  let T = n > 1 ? series[1] - series[0] : 0
  const fitted: number[] = [series[0]]
  const residuals: number[] = []
  for (let t = 1; t < n; t++) {
    const Lp = L, Tp = T
    L = o.alpha * series[t] + (1 - o.alpha) * (Lp + Tp)
    T = o.beta * (L - Lp) + (1 - o.beta) * Tp
    fitted.push(Lp + Tp)
    residuals.push(series[t] - (Lp + Tp))
  }
  const sigma = std(residuals)
  const forecast: number[] = [], lower: number[] = [], upper: number[] = []
  for (let k = 1; k <= o.h; k++) {
    const f = L + k * T
    forecast.push(f)
    lower.push(f - o.z * sigma * Math.sqrt(k))
    upper.push(f + o.z * sigma * Math.sqrt(k))
  }
  return { fitted, residuals, forecast, lower, upper, sigma, type: 'holt-double' }
}

/** Additive Holt-Winters: level, trend and a season of length m. Needs two
 *  full seasons; with less it falls back to holtDouble. */
export function holtWinters(series: number[], o: { alpha: number; beta: number; gamma: number; m: number; h: number; z: number }): Smoothed {
  const n = series.length
  const { m } = o
  if (n < 2 * m) return holtDouble(series, o)
  let L = mean(series.slice(0, m))
  let T = (mean(series.slice(m, 2 * m)) - L) / m
  const S = series.slice(0, m).map((y) => y - L)
  const fitted: number[] = []
  const residuals: number[] = []
  for (let t = 0; t < n; t++) {
    const Lp = L, Tp = T, si = t % m
    const f = Lp + Tp + S[si]
    L = o.alpha * (series[t] - S[si]) + (1 - o.alpha) * (Lp + Tp)
    T = o.beta * (L - Lp) + (1 - o.beta) * Tp
    S[si] = o.gamma * (series[t] - L) + (1 - o.gamma) * S[si]
    fitted.push(f)
    residuals.push(series[t] - f)
  }
  const sigma = std(residuals)
  const forecast: number[] = [], lower: number[] = [], upper: number[] = []
  for (let k = 1; k <= o.h; k++) {
    const f = L + k * T + S[(n + k - 1) % m]
    forecast.push(f)
    lower.push(f - o.z * sigma * Math.sqrt(k))
    upper.push(f + o.z * sigma * Math.sqrt(k))
  }
  return { fitted, residuals, forecast, lower, upper, sigma, type: 'holt-winters' }
}

/** Z-scores against the series mean; points beyond the threshold are anomalies. */
export function anomalyDetect(series: number[], threshold: number): { z: number[]; anomalies: { idx: number; z: number; value: number }[] } {
  if (series.length < 3) return { z: [], anomalies: [] }
  const mu = mean(series)
  const sd = std(series)
  if (sd === 0) return { z: series.map(() => 0), anomalies: [] }
  const z = series.map((v) => (v - mu) / sd)
  return { z, anomalies: z.map((zi, idx) => ({ idx, z: zi, value: series[idx] })).filter((a) => Math.abs(a.z) > threshold) }
}

// ---- seasonality (ported from lib/seasonalityEngine.js) --------------------

/** Demand index scaled to mean 1, pulled toward 1 by the weight (0 means no
 *  seasonality, 1 means the full market pattern). The weight is clamped to
 *  that range so a factor can never reach zero or flip sign. */
export function seasonalFactors(preset: number[], weight: number): number[] {
  const w = Math.min(1, Math.max(0, weight))
  const m = mean(preset)
  if (m <= 0) return preset.map(() => 1)
  // A zero month in a preset must not zero the factor (it is divided by later).
  return preset.map((v) => Math.max(1 + w * (v / m - 1), Number.EPSILON))
}

/** Month indices (0 is January) of the n highest or lowest values. */
export function topMonths(data: number[], n: number, highest: boolean): number[] {
  return data.map((v, i) => ({ v, i })).sort((a, b) => (highest ? b.v - a.v : a.v - b.v) || a.i - b.i).slice(0, n).map((x) => x.i)
}

export function presetFor(cfg: Pick<ForecastConfig, 'presets'>, industry: string): number[] {
  const p = cfg.presets[industry] ?? cfg.presets.default
  if (!p) throw new Error(`No seasonality preset for ${industry} and no default`)
  return p
}

// ---- months and days -------------------------------------------------------

export const monthOf = (isoDate: string): Month => isoDate.slice(0, 7)
export function addMonths(m: Month, k: number): Month {
  const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)) - 1 + k
  const yy = y + Math.floor(mo / MONTHS_PER_YEAR)
  const mm = ((mo % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR
  return `${yy}-${String(mm + 1).padStart(2, '0')}`
}
export const monthIndex = (m: Month) => Number(m.slice(5, 7)) - 1
export function monthsBetween(from: Month, to: Month): Month[] {
  const out: Month[] = []
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m)
  return out
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10)
export function addDaysIso(s: string, n: number): string {
  const d = new Date(`${s}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return isoDay(d)
}
/** ISO weekday: 1 is Monday, 7 is Sunday. */
export const isoWeekday = (s: string) => ((new Date(`${s}T00:00:00Z`).getUTCDay() + 6) % 7) + 1

/** Working days from `from` to `to`, both included, on the work calendar. */
export function workingDaysBetween(from: string, to: string, cal: WorkCalendarConfig): { days: number; holidays: { date: string; name?: string }[] } {
  const off = new Map(cal.non_working_dates.map((d) => [d.date, d]))
  const worked = new Set(cal.weekdays)
  let days = 0
  const holidays: { date: string; name?: string }[] = []
  for (let s = from; s <= to; s = addDaysIso(s, 1)) {
    if (!worked.has(isoWeekday(s))) continue
    const h = off.get(s)
    if (h) { holidays.push(h); continue }
    days++
  }
  return { days, holidays }
}

// ---- invoices --------------------------------------------------------------

export interface ForecastInvoice {
  id: string
  client: string
  amount_eur: number | null
  hours: number | null
  issued_date: string
  period_start: string | null
  period_end: string | null
  voided_at: string | null
  duplicate_of: string | null
}

const serviceDate = (i: ForecastInvoice) => i.period_start ?? i.issued_date
const live = (i: ForecastInvoice) => !i.voided_at && !i.duplicate_of

/** Income in EUR per service month (period start, else issue date), leaving
 *  out voided invoices and linked duplicates. Rows without an EUR amount are
 *  counted separately so the page can say the total is incomplete. */
export function monthlyIncome(invoices: ForecastInvoice[]): { byMonth: Map<Month, number>; pendingEur: number } {
  const byMonth = new Map<Month, number>()
  let pendingEur = 0
  for (const i of invoices.filter(live)) {
    if (i.amount_eur == null) { pendingEur++; continue }
    const m = monthOf(serviceDate(i))
    byMonth.set(m, (byMonth.get(m) ?? 0) + i.amount_eur)
  }
  return { byMonth, pendingEur }
}

/** Invoiced hours with the same rule as dt_billable_vs_invoiced: one row per
 *  client and period (the one with the most hours), voided and linked
 *  duplicates left out, service date inside [from, toExclusive). */
export function invoicedHours(invoices: ForecastInvoice[], from: string, toExclusive: string): { total: number; byMonth: Map<Month, number>; lastPeriodEnd: string | null } {
  const best = new Map<string, ForecastInvoice>()
  for (const i of invoices) {
    if (!live(i) || i.hours == null) continue
    const d = serviceDate(i)
    if (d < from || d >= toExclusive) continue
    const k = JSON.stringify([i.client, i.period_start, i.period_end])
    const cur = best.get(k)
    if (!cur || (i.hours ?? 0) > (cur.hours ?? 0)) best.set(k, i)
  }
  const byMonth = new Map<Month, number>()
  let total = 0
  let lastPeriodEnd: string | null = null
  for (const i of best.values()) {
    total += i.hours!
    const m = monthOf(serviceDate(i))
    byMonth.set(m, (byMonth.get(m) ?? 0) + i.hours!)
    const end = i.period_end ?? i.issued_date
    if (!lastPeriodEnd || end > lastPeriodEnd) lastPeriodEnd = end
  }
  return { total, byMonth, lastPeriodEnd }
}

/** EUR earned per invoiced hour on the most recent invoice that has both. */
export function latestEurPerHour(invoices: ForecastInvoice[]): number | null {
  const withRate = invoices.filter((i) => live(i) && i.amount_eur != null && i.hours && i.hours > 0)
    .sort((a, b) => serviceDate(b).localeCompare(serviceDate(a)) || b.issued_date.localeCompare(a.issued_date))
  const i = withRate[0]
  return i ? i.amount_eur! / i.hours! : null
}

// ---- the income forecast ---------------------------------------------------

export type ForecastMethod = 'none' | 'run-rate' | 'holt-seasonal' | 'holt-winters'

export interface ForecastPoint {
  month: Month
  actual: number | null
  forecast: number | null
  lower: number | null
  upper: number | null
  anomaly: { z: number } | null
}

export interface IncomeForecast {
  method: ForecastMethod
  historyUsed: number
  sigma: number
  z: number
  points: ForecastPoint[]
  anomalies: { month: Month; value: number; z: number; expected: number }[]
}

/**
 * Monthly income forecast.
 *  - The history runs from the first to the last month with income (gaps are
 *    zero months), capped to the latest cfg.historyMonths.
 *  - Fewer than cfg.minModelMonths: a flat run-rate (mean), no band.
 *  - A full window of cfg.historyMonths: additive Holt-Winters on the raw
 *    series, which learns its own season.
 *  - Otherwise: divide by the market seasonal factors, run Holt double
 *    smoothing, multiply the forecast and band back by the factors.
 * Income cannot be negative, so forecast and band are floored at zero.
 * Anomalies are months whose deseasonalised income sits more than
 * cfg.anomalyZ standard deviations from the mean.
 */
export function forecastIncome(byMonth: Map<Month, number>, factors: number[], cfg: ForecastConfig): IncomeForecast {
  const z = zFor(cfg.confidenceLevel)
  const months = [...byMonth.keys()].sort()
  if (!months.length) return { method: 'none', historyUsed: 0, sigma: 0, z, points: [], anomalies: [] }
  let hist = monthsBetween(months[0], months[months.length - 1])
  if (hist.length > cfg.historyMonths) hist = hist.slice(-cfg.historyMonths)
  const actual = hist.map((m) => byMonth.get(m) ?? 0)
  const f = (m: Month) => factors[monthIndex(m)]
  const deseason = actual.map((v, i) => v / f(hist[i]))
  const h = cfg.horizonMonths
  const future = Array.from({ length: h }, (_, k) => addMonths(hist[hist.length - 1], k + 1))

  let method: ForecastMethod
  let fc: number[], lo: number[], hi: number[], sigma = 0
  if (hist.length < cfg.minModelMonths) {
    method = 'run-rate'
    const rate = mean(deseason)
    fc = future.map((m) => rate * f(m)); lo = fc; hi = fc
  } else if (hist.length >= cfg.historyMonths && hist.length >= 2 * MONTHS_PER_YEAR) {
    method = 'holt-winters'
    const s = holtWinters(actual, { alpha: cfg.alpha, beta: cfg.beta, gamma: cfg.gamma, m: MONTHS_PER_YEAR, h, z })
    fc = s.forecast; lo = s.lower; hi = s.upper; sigma = s.sigma
  } else {
    method = 'holt-seasonal'
    const s = holtDouble(deseason, { alpha: cfg.alpha, beta: cfg.beta, h, z })
    fc = s.forecast.map((v, k) => v * f(future[k]))
    lo = s.lower.map((v, k) => v * f(future[k]))
    hi = s.upper.map((v, k) => v * f(future[k]))
    sigma = s.sigma
  }
  const floor = (v: number) => Math.max(0, v)

  const det = anomalyDetect(deseason, cfg.anomalyZ)
  const mu = mean(deseason)
  const flagged = new Map(det.anomalies.map((a) => [a.idx, a.z]))
  const points: ForecastPoint[] = [
    ...hist.map((m, i) => ({ month: m, actual: actual[i], forecast: null, lower: null, upper: null, anomaly: flagged.has(i) ? { z: flagged.get(i)! } : null })),
    ...future.map((m, k) => ({ month: m, actual: null, forecast: floor(fc[k]), lower: floor(lo[k]), upper: floor(hi[k]), anomaly: null })),
  ]
  const anomalies = det.anomalies.map((a) => ({ month: hist[a.idx], value: actual[a.idx], z: a.z, expected: mu * f(hist[a.idx]) }))
  return { method, historyUsed: hist.length, sigma, z, points, anomalies }
}

// ---- hours for the rest of the year ----------------------------------------

export interface HoursProjection {
  invoicedYtd: number
  /** Billable hours logged in DTrack after the last invoiced period. */
  loggedUnbilled: number
  capacityFrom: string
  remainingDays: number
  remainingHours: number
  holidays: { date: string; name?: string }[]
  projected: number
}

/**
 * Year-end hours: invoiced so far, plus billable time logged in DTrack after
 * the last invoiced period, plus working days left on the client calendar
 * times the daily hours. When DTrack has logged time for that stretch, the
 * calendar starts tomorrow so today is not counted twice; when it has none,
 * the calendar starts the day after the last invoiced period.
 */
export function projectHours(a: {
  today: string
  yearEnd: string
  invoicedYtd: number
  lastPeriodEnd: string | null
  yearStart: string
  loggedUnbilled: number
  cfg: Pick<ForecastConfig, 'dailyHours' | 'workCalendar'>
}): HoursProjection {
  const gapFrom = a.lastPeriodEnd ? addDaysIso(a.lastPeriodEnd, 1) : a.yearStart
  const tomorrow = addDaysIso(a.today, 1)
  const capacityFrom = gapFrom > a.today ? gapFrom : a.loggedUnbilled > 0 ? tomorrow : gapFrom
  const { days, holidays } = capacityFrom <= a.yearEnd ? workingDaysBetween(capacityFrom, a.yearEnd, a.cfg.workCalendar) : { days: 0, holidays: [] }
  const remainingHours = days * a.cfg.dailyHours
  return {
    invoicedYtd: a.invoicedYtd,
    loggedUnbilled: a.loggedUnbilled,
    capacityFrom,
    remainingDays: days,
    remainingHours,
    holidays,
    projected: a.invoicedYtd + a.loggedUnbilled + remainingHours,
  }
}
