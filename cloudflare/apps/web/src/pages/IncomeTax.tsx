import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, CheckCircle2, Clock, Info } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { InvoiceUpload } from '../components/InvoiceUpload'
import { supabase } from '../lib/supabase'
import { type YearView, buildYearView, eur, hrs, loadOpenReviews, money } from '../lib/nexus'
import { chart } from '../lib/theme'

// The single series hue from lib/theme, validated on the white card.
const SERIES = chart.actual

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: 'good' | 'warn' }) {
  return (
    <div className="glass p-5">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-ink tabular-nums">{value}</p>
      {sub && (
        <p className={`mt-1 text-xs flex items-center gap-1 ${tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-lemon-ink' : 'text-muted'}`}>
          {tone === 'good' && <CheckCircle2 size={12} />}{tone === 'warn' && <AlertTriangle size={12} />}{sub}
        </p>
      )}
    </div>
  )
}

function Progress({ value, max }: { value: number; max: number }) {
  const pct = Math.min(100, (value / max) * 100)
  return (
    <div className="h-2 rounded-full bg-chip overflow-hidden" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
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
  const input = 'rounded-lg bg-card border-line text-ink text-sm'
  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-2">
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} required />
      <input type="number" step="0.25" min="0.25" placeholder="Hours" value={hours} onChange={(e) => setHours(e.target.value)} className={`${input} w-24`} required />
      <select value={category} onChange={(e) => setCategory(e.target.value)} className={input}>
        {['admin', 'acquisition', 'product', 'training', 'travel', 'other'].map((c) => <option key={c}>{c}</option>)}
      </select>
      <input placeholder="What did you do" value={description} onChange={(e) => setDescription(e.target.value)} className={`${input} flex-1 min-w-40`} />
      <button className="rounded-lg bg-ink hover:bg-night-2 text-white text-sm px-4 py-2">Log hours</button>
      {err && <p className="w-full text-sm text-bad">{err}</p>}
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
  if (error) return <Card><p className="text-bad text-sm">{error}</p></Card>
  if (!view) return <div className="flex justify-center p-12"><LoadingSpinner /></div>

  const v: YearView = view
  const p = v.params
  const required = p?.urencriteriumHours ?? null
  const currencies = Object.entries(v.ledger.revenue_by_currency)
  const chartData = v.ledger.months.map((m) => ({ month: m.month.slice(5), hours: m.hours, eur: m.revenue_eur }))
  const yearInvoices = view.invoices.filter((i) => (i.period_start ?? i.issued_date).startsWith(String(year)))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Income, hours and tax</h1>
          <div className="lemon-rule" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted">Live from your invoices, logged hours and approved expenses.</p>
        </div>
        <div className="flex items-center gap-2">
          {openReviews > 0 && (
            <Link to="/review" className="rounded-lg border border-lemon text-lemon-ink text-sm px-3 py-2 flex items-center gap-2">
              <AlertTriangle size={14} /> {openReviews} waiting for your review
            </Link>
          )}
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="rounded-lg bg-card border-line text-ink text-sm">
            {[year - 1, year, year + 1].map((y) => <option key={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {!p && (
        <Card><p className="text-sm text-lemon-ink flex items-center gap-2"><Info size={14} /> No fiscal parameters loaded for {year}. Tax figures are hidden until they are.</p></Card>
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
          <p className="text-xs uppercase tracking-wide text-muted">Urencriterium</p>
          <p className="mt-2 text-2xl font-semibold text-ink tabular-nums">{hrs(v.totalHours)}{required ? <span className="text-base text-muted"> / {hrs(required)}</span> : null}</p>
          {required && <div className="mt-3"><Progress value={v.totalHours} max={required} /></div>}
          {required && (
            <p className={`mt-2 text-xs flex items-center gap-1 ${v.totalHours >= required ? 'text-good' : 'text-lemon-ink'}`}>
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
                <CartesianGrid vertical={false} stroke={chart.grid} strokeWidth={1} />
                <XAxis dataKey="month" tick={chart.axis} axisLine={false} tickLine={false} />
                <YAxis tick={chart.axis} axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: chart.cursor }}
                  contentStyle={chart.tooltip}
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
            <p className="text-sm text-good flex items-center gap-2"><CheckCircle2 size={14} /> No anomalies in {year}.</p>
          ) : (
            <ul className="space-y-3">
              {v.ledger.anomalies.map((a, i) => (
                <li key={i} className="text-sm text-body flex gap-2">
                  <AlertTriangle size={14} className="text-lemon-ink mt-0.5 shrink-0" />
                  <span>{a.message}</span>
                </li>
              ))}
            </ul>
          )}
          {p && p.unverifiedKeys.length > 0 && (
            <p className="mt-4 text-xs text-muted">Unverified parameters: {p.unverifiedKeys.join(', ')}. VAT drafts stay blocked until you confirm them.</p>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Invoices" subtitle={`${yearInvoices.length} in ${year}`} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted border-b border-line">
              <tr><th className="py-2 pr-4">Number</th><th className="pr-4">Client</th><th className="pr-4">Period</th><th className="pr-4 text-right">Hours</th><th className="pr-4 text-right">Amount</th><th className="pr-4 text-right">EUR</th><th>Counted</th></tr>
            </thead>
            <tbody className="text-ink">
              {yearInvoices.map((i) => (
                <tr key={i.id} className="border-b border-line">
                  <td className="py-2 pr-4 font-mono">{i.invoice_number ?? '-'}</td>
                  <td className="pr-4">{i.client}</td>
                  <td className="pr-4 text-muted">{i.period_start ? `${i.period_start} to ${i.period_end}` : i.issued_date}</td>
                  <td className="pr-4 text-right tabular-nums">{i.hours != null ? hrs(i.hours) : '-'}</td>
                  <td className="pr-4 text-right tabular-nums">{money(i.amount, i.currency)}</td>
                  <td className="pr-4 text-right tabular-nums">{i.amount_eur != null ? eur(i.amount_eur) : <span className="text-lemon-ink">pending</span>}</td>
                  <td>{i.voided_at ? <span className="text-muted">void</span> : i.review_state === 'needs_review' ? <Link to="/review" className="text-lemon-ink underline">needs review</Link> : counted.has(i.id) ? <span className="text-good">yes</span> : <span className="text-lemon-ink">duplicate</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <InvoiceUpload onDone={load} />

      <Card>
        <CardHeader title="Log non-billable hours" subtitle="Admin, acquisition and product work count toward the urencriterium" />
        <TimeEntryForm onSaved={load} />
      </Card>
    </div>
  )
}
