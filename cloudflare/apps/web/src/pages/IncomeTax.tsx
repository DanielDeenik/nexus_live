import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, CheckCircle2, Clock, Info } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { supabase } from '../lib/supabase'
import { type YearView, buildYearView, eur, hrs, loadOpenReviews, money } from '../lib/nexus'

// Validated single-series hue on the dark surface (dataviz validator: lightness
// band and contrast pass on #0f172a).
const SERIES = '#0284c7'

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: 'good' | 'warn' }) {
  return (
    <div className="glass p-5">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-50 tabular-nums">{value}</p>
      {sub && (
        <p className={`mt-1 text-xs flex items-center gap-1 ${tone === 'good' ? 'text-success-400' : tone === 'warn' ? 'text-warning-400' : 'text-slate-400'}`}>
          {tone === 'good' && <CheckCircle2 size={12} />}{tone === 'warn' && <AlertTriangle size={12} />}{sub}
        </p>
      )}
    </div>
  )
}

function Progress({ value, max }: { value: number; max: number }) {
  const pct = Math.min(100, (value / max) * 100)
  return (
    <div className="h-2 rounded-full bg-slate-800 overflow-hidden" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: SERIES }} />
    </div>
  )
}

function TimeEntryForm({ onSaved }: { onSaved: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [hours, setHours] = useState('')
  const [category, setCategory] = useState('admin')
  const [description, setDescription] = useState('')
  const [err, setErr] = useState('')
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    const { data: u } = await supabase.auth.getUser()
    const { error } = await supabase.from('time_entries').insert({ user_id: u.user!.id, entry_date: date, hours: Number(hours), category, description: description || null })
    if (error) { setErr(error.message); return }
    setHours(''); setDescription(''); onSaved()
  }
  const input = 'rounded-lg bg-slate-900 border-slate-700 text-slate-100 text-sm'
  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-2">
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} required />
      <input type="number" step="0.25" min="0.25" placeholder="Hours" value={hours} onChange={(e) => setHours(e.target.value)} className={`${input} w-24`} required />
      <select value={category} onChange={(e) => setCategory(e.target.value)} className={input}>
        {['admin', 'acquisition', 'product', 'training', 'travel', 'other'].map((c) => <option key={c}>{c}</option>)}
      </select>
      <input placeholder="What did you do" value={description} onChange={(e) => setDescription(e.target.value)} className={`${input} flex-1 min-w-40`} />
      <button className="rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm px-4 py-2">Log hours</button>
      {err && <p className="w-full text-sm text-danger-400">{err}</p>}
    </form>
  )
}

export function IncomeTax() {
  const today = new Date().toISOString().slice(0, 10)
  const [year, setYear] = useState(Number(today.slice(0, 4)))
  const [view, setView] = useState<Awaited<ReturnType<typeof buildYearView>> | null>(null)
  const [openReviews, setOpenReviews] = useState(0)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setError('')
      const [v, r] = await Promise.all([buildYearView(year, today), loadOpenReviews()])
      setView(v)
      setOpenReviews(r.length)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [year, today])
  useEffect(() => { load() }, [load])

  const counted = useMemo(() => new Set(view?.ledger.counted_invoice_ids ?? []), [view])
  if (error) return <Card><p className="text-danger-400 text-sm">{error}</p></Card>
  if (!view) return <div className="flex justify-center p-12"><LoadingSpinner /></div>

  const v: YearView = view
  const p = v.params
  const required = p?.urencriteriumHours ?? null
  const currencies = Object.entries(v.ledger.revenue_by_currency)
  const chartData = v.ledger.months.map((m) => ({ month: m.month.slice(5), hours: m.hours, eur: m.revenue_eur }))
  const yearInvoices = view.invoices.filter((i) => (i.period_start ?? i.issued_date).startsWith(String(year)))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">Income, hours and tax</h1>
          <p className="text-sm text-slate-400">Live from your invoices, logged hours and approved expenses.</p>
        </div>
        <div className="flex items-center gap-2">
          {openReviews > 0 && (
            <Link to="/review" className="rounded-lg border border-warning-500/40 text-warning-300 text-sm px-3 py-2 flex items-center gap-2">
              <AlertTriangle size={14} /> {openReviews} waiting for your review
            </Link>
          )}
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="rounded-lg bg-slate-900 border-slate-700 text-slate-100 text-sm">
            {[year - 1, year, year + 1].map((y) => <option key={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {!p && (
        <Card><p className="text-sm text-warning-300 flex items-center gap-2"><Info size={14} /> No fiscal parameters loaded for {year}. Tax figures are hidden until they are.</p></Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Billed hours" value={hrs(v.ledger.billed_hours)} sub={`${hrs(v.ledger.non_billable_hours)} non-billable logged`} />
        <Stat
          label="Revenue"
          value={eur(v.ledger.revenue_eur)}
          sub={currencies.map(([c, a]) => money(a, c)).join(' + ') + (v.ledger.revenue_eur_complete ? '' : ' (EUR incomplete)')}
          tone={v.ledger.revenue_eur_complete ? undefined : 'warn'}
        />
        <div className="glass p-5">
          <p className="text-xs uppercase tracking-wide text-slate-400">Urencriterium</p>
          <p className="mt-2 text-2xl font-semibold text-slate-50 tabular-nums">{hrs(v.totalHours)}{required ? <span className="text-base text-slate-400"> / {hrs(required)}</span> : null}</p>
          {required && <div className="mt-3"><Progress value={v.totalHours} max={required} /></div>}
          {required && (
            <p className={`mt-2 text-xs flex items-center gap-1 ${v.totalHours >= required ? 'text-success-400' : 'text-warning-400'}`}>
              {v.totalHours >= required ? <><CheckCircle2 size={12} /> Met: zelfstandigenaftrek applies</> : <><Clock size={12} /> {hrs(required - v.totalHours)} hours to go</>}
            </p>
          )}
        </div>
        <Stat
          label="Working days left"
          value={v.capacity ? String(v.capacity.working_days) : 'Set calendar'}
          sub={v.capacity
            ? `${hrs(v.capacity.hours)} h on ${v.region} calendar${v.capacity.holidays_on_weekdays.length ? `, excl. ${v.capacity.holidays_on_weekdays.map((h) => h.name).join(', ')}` : ''}`
            : <Link to="/agent-settings" className="underline">Add region and hours per day</Link>}
        />
      </div>

      {p && v.ytd && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Profit year to date" value={eur(v.ytd.profit)} sub={`${eur(v.costsEur)} costs, ${eur(v.depreciationEur)} depreciation`} />
          <Stat label="Estimated tax year to date" value={eur(v.ytd.total_due)} sub={`${(v.ytd.effective_rate * 100).toFixed(1)}% of profit, incl. Zvw`} />
          <Stat label="Projected revenue" value={v.projection ? eur(v.projection.revenue_eur) : 'n/a'} sub={v.projection ? `at ${eur(v.projection.eur_per_hour)}/h for remaining capacity` : 'needs calendar and a recent rate'} />
          <Stat label="Projected tax for the year" value={v.projection ? eur(v.projection.estimate.total_due) : 'n/a'} sub="estimate, not a filing" />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Billed hours by month" subtitle="By service period; duplicates counted once" />
          <div className="h-64" aria-label="Billed hours by month">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#1e293b" strokeWidth={1} />
                <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                  contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#e2e8f0' }}
                  formatter={(val: number, _n, item) => [`${hrs(val)} h  (${eur(item.payload.eur)})`, 'Billed']}
                />
                <Bar dataKey="hours" fill={SERIES} radius={[4, 4, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardHeader title="Checks" subtitle="What the ledger found" />
          {v.ledger.anomalies.length === 0 ? (
            <p className="text-sm text-success-400 flex items-center gap-2"><CheckCircle2 size={14} /> No anomalies in {year}.</p>
          ) : (
            <ul className="space-y-3">
              {v.ledger.anomalies.map((a, i) => (
                <li key={i} className="text-sm text-slate-300 flex gap-2">
                  <AlertTriangle size={14} className="text-warning-400 mt-0.5 shrink-0" />
                  <span>{a.message}</span>
                </li>
              ))}
            </ul>
          )}
          {p && p.unverifiedKeys.length > 0 && (
            <p className="mt-4 text-xs text-slate-400">Unverified parameters: {p.unverifiedKeys.join(', ')}. VAT drafts stay blocked until you confirm them.</p>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Invoices" subtitle={`${yearInvoices.length} in ${year}`} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-400 border-b border-slate-700/50">
              <tr><th className="py-2 pr-4">Number</th><th className="pr-4">Client</th><th className="pr-4">Period</th><th className="pr-4 text-right">Hours</th><th className="pr-4 text-right">Amount</th><th className="pr-4 text-right">EUR</th><th>Counted</th></tr>
            </thead>
            <tbody className="text-slate-200">
              {yearInvoices.map((i) => (
                <tr key={i.id} className="border-b border-slate-800/60">
                  <td className="py-2 pr-4 font-mono">{i.invoice_number ?? '-'}</td>
                  <td className="pr-4">{i.client}</td>
                  <td className="pr-4 text-slate-400">{i.period_start ? `${i.period_start} to ${i.period_end}` : i.issued_date}</td>
                  <td className="pr-4 text-right tabular-nums">{i.hours != null ? hrs(i.hours) : '-'}</td>
                  <td className="pr-4 text-right tabular-nums">{money(i.amount, i.currency)}</td>
                  <td className="pr-4 text-right tabular-nums">{i.amount_eur != null ? eur(i.amount_eur) : <span className="text-warning-400">pending</span>}</td>
                  <td>{i.voided_at ? <span className="text-slate-500">void</span> : counted.has(i.id) ? <span className="text-success-400">yes</span> : <span className="text-warning-400">duplicate</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-400">Add invoices by uploading the PDF on the Expenses page (choose "my sales invoice").</p>
      </Card>

      <Card>
        <CardHeader title="Log non-billable hours" subtitle="Admin, acquisition and product work count toward the urencriterium" />
        <TimeEntryForm onSaved={load} />
      </Card>
    </div>
  )
}
