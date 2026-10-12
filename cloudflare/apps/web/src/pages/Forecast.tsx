import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Area, Bar, BarChart, Cell, ComposedChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, CheckCircle2, Clock, Info } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { ErrorNote, PageHeader, Tile, input } from '../components/time/ui'
import { eur, hrs } from '../lib/nexus'
import {
  type ForecastConfig, type ForecastInvoice, type ForecastMethod,
  addDaysIso, forecastIncome, invoicedHours, latestEurPerHour, monthIndex, monthlyIncome,
  presetFor, projectHours, seasonalFactors, topMonths,
} from '../lib/forecast'
import { loadForecastConfig, loadForecastInvoices, loadUrencriterium, loggedBillableHours } from '../lib/forecastData'
import { iso } from '../lib/period'

// Colours validated with the dataviz checker on the #0f172a surface: sky for
// actuals and peak months, amber for the forecast and slow months, slate for
// the rest.
const SKY = '#0284c7'
const AMBER = '#d97706'
const NEUTRAL = '#475569'
const AXIS = { fill: '#94a3b8', fontSize: 12 }
const TIP = { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#e2e8f0' }

const monthName = (i: number, style: 'short' | 'long' = 'short') => new Date(2000, i, 1).toLocaleDateString(undefined, { month: style })
const monthTick = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
const dayLabel = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
/** Months in calendar order, joined for a sentence. */
const monthList = (idx: number[]) => [...idx].sort((a, b) => a - b).map((i) => monthName(i, 'long')).join(', ')

const METHOD_TEXT: Record<ForecastMethod, string> = {
  none: 'No invoices yet, so there is nothing to project.',
  'run-rate': 'Too little history for a trend, so the forecast is your average month, shaped by the market season.',
  'holt-seasonal': 'Trend from Holt smoothing on income with the market season taken out, then the season put back.',
  'holt-winters': 'Holt-Winters on your own history: trend and your own season, learned from the full window.',
}

interface Loaded {
  cfg: ForecastConfig
  invoices: ForecastInvoice[]
  threshold: { hours: number | null; note: string }
  loggedUnbilled: number
}

export function Forecast() {
  const today = iso(new Date())
  const year = Number(today.slice(0, 4))
  const yearStart = `${year}-01-01`
  const yearEnd = `${year}-12-31`
  const nextYearStart = `${year + 1}-01-01`

  const [data, setData] = useState<Loaded | null>(null)
  const [industry, setIndustry] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      try {
        const [cfg, invoices, threshold] = await Promise.all([loadForecastConfig(), loadForecastInvoices(), loadUrencriterium(year)])
        const { lastPeriodEnd } = invoicedHours(invoices, yearStart, nextYearStart)
        const gapFrom = lastPeriodEnd ? addDaysIso(lastPeriodEnd, 1) : yearStart
        const loggedUnbilled = await loggedBillableHours(gapFrom, addDaysIso(today, 1))
        setIndustry(cfg.industry)
        setData({ cfg, invoices, threshold, loggedUnbilled })
      } catch (e) {
        setError((e as Error).message)
      }
    })()
  }, [today, year, yearStart, nextYearStart])

  const view = useMemo(() => {
    if (!data || !industry) return null
    const { cfg, invoices } = data
    const preset = presetFor(cfg, industry)
    const factors = seasonalFactors(preset, cfg.seasonalityWeight)
    const income = monthlyIncome(invoices)
    const fc = forecastIncome(income.byMonth, factors, cfg)
    const incomeYtd = [...income.byMonth].filter(([m]) => m.startsWith(String(year))).reduce((s, [, v]) => s + v, 0)
    const inv = invoicedHours(invoices, yearStart, nextYearStart)
    const hours = projectHours({ today, yearEnd, yearStart, invoicedYtd: inv.total, lastPeriodEnd: inv.lastPeriodEnd, loggedUnbilled: data.loggedUnbilled, cfg })
    const rate = latestEurPerHour(invoices)
    const modelRest = fc.points.filter((p) => p.forecast != null && p.month.startsWith(String(year))).reduce((s, p) => s + (p.forecast ?? 0), 0)
    const unbilledHours = hours.loggedUnbilled + hours.remainingHours
    const projectedIncome = rate != null ? incomeYtd + unbilledHours * rate : incomeYtd + modelRest
    const peak = topMonths(preset, cfg.peakSlowCount, true)
    const slow = topMonths(preset, cfg.peakSlowCount, false)
    const chart = fc.points.map((p) => ({
      month: p.month, actual: p.actual, forecast: p.forecast,
      band: p.lower != null && p.upper != null ? [p.lower, p.upper] : null,
      anomaly: p.anomaly,
    }))
    // Join the forecast line to the last actual so the two read as one series.
    const lastActual = [...chart].reverse().find((c) => c.actual != null)
    if (lastActual && chart.some((c) => c.forecast != null)) lastActual.forecast = lastActual.actual
    return { preset, fc, incomeYtd, pendingEur: income.pendingEur, hours, rate, modelRest, projectedIncome, peak, slow, chart }
  }, [data, industry, today, year, yearStart, yearEnd, nextYearStart])

  if (error) return <Card><ErrorNote message={error} /></Card>
  if (!data || !view) return <div className="flex justify-center p-12"><LoadingSpinner /></div>

  const { cfg, threshold } = data
  const { fc, hours } = view
  const req = threshold.hours
  const metYtd = req != null && hours.invoicedYtd >= req
  const onTrack = req != null && hours.projected >= req
  const industries = Object.keys(cfg.presets).filter((k) => k !== 'default').sort()
  const pct = Math.round(cfg.confidenceLevel * 100)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Forecast"
        subtitle="Income and hours for the rest of the year and the next twelve months, from your invoices, DTrack and the market season."
      />

      <div className="grid gap-4 grid-cols-2 xl:grid-cols-5">
        <Tile label="Income year to date" value={eur(view.incomeYtd)} hint={view.pendingEur ? `${view.pendingEur} invoice(s) without an EUR amount not counted` : 'Invoices in EUR, void and duplicates left out'} />
        <Tile label="Hours year to date" value={`${hrs(hours.invoicedYtd)} h`} hint="Invoiced, one per client and period" />
        <Tile
          label="Projected income"
          value={eur(view.projectedIncome)}
          hint={view.rate != null
            ? `At ${eur(view.rate)}/h for ${hrs(hours.loggedUnbilled + hours.remainingHours)} unbilled hours. Trend model: ${eur(view.incomeYtd + view.modelRest)}`
            : 'Trend model; no invoice with hours and EUR yet for a rate'}
        />
        <Tile label="Projected hours" value={`${hrs(hours.projected)} h`} hint={`${hours.remainingDays} working days left at ${hrs(cfg.dailyHours)} h`} />
        <div className="glass p-4 sm:p-5 min-w-0 col-span-2 xl:col-span-1">
          <p className="text-xs uppercase tracking-wide text-slate-400">Urencriterium</p>
          {req == null ? (
            <p className="mt-2 text-sm text-warning-300 flex items-start gap-1"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> {threshold.note || 'Threshold not loaded.'}</p>
          ) : (
            <>
              <p className="mt-2 text-2xl font-semibold text-slate-50 tabular-nums">{hrs(hours.invoicedYtd)}<span className="text-base text-slate-400"> / {hrs(req)}</span></p>
              <div className="mt-3 h-2 rounded-full bg-slate-800 overflow-hidden" role="progressbar" aria-valuenow={hours.invoicedYtd} aria-valuemax={req}>
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, (hours.invoicedYtd / req) * 100)}%`, background: SKY }} />
              </div>
              <p className={`mt-2 text-xs flex items-center gap-1 ${metYtd || onTrack ? 'text-success-400' : 'text-warning-400'}`}>
                {metYtd ? <><CheckCircle2 size={12} /> Met on invoiced hours</>
                  : onTrack ? <><Clock size={12} /> On track: {hrs(hours.projected)} h by year end</>
                  : <><AlertTriangle size={12} /> Short by {hrs(req - hours.projected)} h at this pace</>}
              </p>
            </>
          )}
        </div>
      </div>

      <Card>
        <CardHeader
          title="Monthly income"
          subtitle={fc.method === 'none' ? 'No income yet' : `Actuals by service month and ${cfg.horizonMonths} months ahead, ${pct}% band`}
        />
        {fc.method === 'none' ? <p className="text-sm text-slate-500">{METHOD_TEXT.none}</p> : (
          <>
            <div className="h-72" aria-label="Monthly income, actual and forecast">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={view.chart} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#1e293b" />
                  <XAxis dataKey="month" tickFormatter={monthTick} tick={AXIS} axisLine={false} tickLine={false} minTickGap={16} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v: number) => eur(v)} width={84} />
                  <Tooltip
                    cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                    contentStyle={TIP}
                    labelFormatter={(l) => monthTick(String(l))}
                    formatter={(v: number | number[], name: string, item: { payload?: { anomaly?: { z: number } | null } }) => {
                      if (Array.isArray(v)) return [`${eur(v[0])} to ${eur(v[1])}`, `${pct}% band`]
                      const flag = name === 'Actual' && item.payload?.anomaly ? ' (unusual month)' : ''
                      return [`${eur(v)}${flag}`, name]
                    }}
                  />
                  <Area dataKey="band" name="Band" stroke="none" fill={AMBER} fillOpacity={0.15} isAnimationActive={false} connectNulls={false} />
                  <Bar dataKey="actual" name="Actual" fill={SKY} radius={[4, 4, 0, 0]} maxBarSize={24} />
                  <Line dataKey="forecast" name="Forecast" stroke={AMBER} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
              <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: SKY }} /> Actual</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: AMBER }} /> Forecast</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: AMBER, opacity: 0.3 }} /> {pct}% band</span>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              {METHOD_TEXT[fc.method]} {fc.historyUsed} month{fc.historyUsed === 1 ? '' : 's'} of history used (window {cfg.historyMonths}); market season from {industry} at weight {cfg.seasonalityWeight}.
            </p>
          </>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Hours for the rest of the year" subtitle={`To ${dayLabel(yearEnd)}, on the ${cfg.workCalendar.region ?? 'client'} calendar`} />
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-slate-400">Invoiced so far</dt><dd className="tabular-nums text-slate-100">{hrs(hours.invoicedYtd)} h</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-slate-400">Logged in DTrack, not yet invoiced</dt><dd className="tabular-nums text-slate-100">{hrs(hours.loggedUnbilled)} h</dd></div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-400">{hours.remainingDays} working days from {dayLabel(hours.capacityFrom)} at {hrs(cfg.dailyHours)} h</dt>
              <dd className="tabular-nums text-slate-100">{hrs(hours.remainingHours)} h</dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-slate-700/50 pt-2"><dt className="text-slate-300 font-medium">Projected for {year}</dt><dd className="tabular-nums text-slate-50 font-semibold">{hrs(hours.projected)} h</dd></div>
          </dl>
          {hours.holidays.length > 0 && (
            <p className="mt-3 text-xs text-slate-400">Days off left out: {hours.holidays.map((h) => `${h.name ?? 'Holiday'} (${dayLabel(h.date)})`).join(', ')}.</p>
          )}
          <p className="mt-2 text-xs text-slate-500">Daily hours and the client calendar come from app config. <Link to="/time" className="underline">Logged time</Link>.</p>
        </Card>

        <Card>
          <CardHeader
            title="Market season"
            subtitle="Consulting demand by month, 0 to 100"
            action={
              <select aria-label="Industry" value={industry} onChange={(e) => setIndustry(e.target.value)} className={`${input} max-w-[12rem]`}>
                {industries.map((k) => <option key={k} value={k}>{k}{k === cfg.industry ? ' (default)' : ''}</option>)}
              </select>
            }
          />
          <div className="h-48" aria-label={`Demand index for ${industry}`}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={view.preset.map((v, i) => ({ m: monthName(i), v, i }))} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#1e293b" />
                <XAxis dataKey="m" tick={AXIS} axisLine={false} tickLine={false} interval={0} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgba(148,163,184,0.08)' }} contentStyle={TIP}
                  formatter={(v: number, _n, item: { payload?: { i: number } }) => {
                    const i = item.payload?.i ?? -1
                    return [`${v}${view.peak.includes(i) ? ', peak' : view.slow.includes(i) ? ', slow' : ''}`, 'Demand']
                  }} />
                <Bar dataKey="v" name="Demand" radius={[4, 4, 0, 0]} maxBarSize={24}>
                  {view.preset.map((_, i) => <Cell key={i} fill={view.peak.includes(i) ? SKY : view.slow.includes(i) ? AMBER : NEUTRAL} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: SKY }} /> Peak</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: AMBER }} /> Slow</span>
          </div>
          <p className="mt-3 text-sm text-slate-300">
            Demand peaks in {monthList(view.peak)}. It is slowest in {monthList(view.slow)}, so line up your next contract before then; roles that open in the peak months are the ones to land.
          </p>
          {industry !== cfg.industry && <p className="mt-1 text-xs text-slate-500">Showing {industry} for comparison; the forecast above uses it too until you switch back.</p>}
        </Card>
      </div>

      <Card>
        <CardHeader title="Unusual months" subtitle={`Income more than ${cfg.anomalyZ} standard deviations from your average, after the market season`} />
        {fc.historyUsed < cfg.minModelMonths ? <p className="text-sm text-slate-500">Needs at least {cfg.minModelMonths} months of income.</p>
          : fc.anomalies.length === 0 ? <p className="text-sm text-success-400 flex items-center gap-2"><CheckCircle2 size={14} /> No unusual months.</p> : (
            <ul className="space-y-2">
              {fc.anomalies.map((a) => (
                <li key={a.month} className="text-sm text-slate-300 flex gap-2">
                  <AlertTriangle size={14} className="text-warning-400 mt-0.5 shrink-0" />
                  <span>
                    {monthName(monthIndex(a.month), 'long')} {a.month.slice(0, 4)}: {eur(a.value)}, {a.value > a.expected ? 'above' : 'below'} the usual {eur(a.expected)} for that month (z {a.z.toFixed(1)}).
                  </span>
                </li>
              ))}
            </ul>
          )}
      </Card>

      <Card>
        <div className="flex gap-2 text-sm text-slate-300">
          <Info size={16} className="mt-0.5 shrink-0 text-sky-400" />
          <p>
            Projected income uses your latest invoiced EUR per hour for hours not yet invoiced; the trend model figure is shown for comparison. Income counts every invoice with an EUR amount except voided ones and linked duplicates, by service month (period start, else issue date).
            Smoothing, band, history window, seasonality and calendar settings are in app config.
          </p>
        </div>
      </Card>
    </div>
  )
}
