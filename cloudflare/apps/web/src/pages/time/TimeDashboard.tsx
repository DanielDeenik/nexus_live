import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react'
import { Card, CardHeader } from '../../components/ui/Card'
import { SunburstZoomChart, type TreeNode } from '../../components/time/SunburstChart/SunburstZoomChart'
import { MonthCalendar } from '../../components/time/MonthCalendar'
import { PageHeader, Tile, btnIcon, input, th, td } from '../../components/time/ui'
import { type Grain, type Period, periodOf, shift, today, workingDays } from '../../lib/period'
import {
  AXES, type Axis, MAX_AXES, type Project, type ReconRow, type SummaryRow, type WorkCalendar,
  billableVsInvoiced, hoursLabel, listProjects, loadWorkCalendar, summary,
} from '../../lib/time'

const GRAINS: { id: Grain; label: string }[] = [
  { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }, { id: 'quarter', label: 'Quarter' }, { id: 'year', label: 'Year' },
]
const axisLabel = (a: Axis) => AXES.find((x) => x.value === a)?.label ?? a

// dt_summary returns one row per path; the sunburst wants a tree.
function toTree(rows: SummaryRow[]): TreeNode {
  const root: TreeNode = { name: 'Time', children: [] }
  for (const r of rows) {
    let node = root
    r.path.forEach((name, i) => {
      node.children ??= []
      let next = node.children.find((c) => c.name === name)
      if (!next) {
        next = i === r.path.length - 1 ? { name, value: r.hours } : { name, children: [] }
        node.children.push(next)
      } else if (i === r.path.length - 1) {
        next.value = (next.value ?? 0) + r.hours
      }
      node = next
    })
  }
  return root
}

const sum = (rows: SummaryRow[], pred: (r: SummaryRow) => boolean = () => true) => rows.filter(pred).reduce((t, r) => t + r.hours, 0)

function csvCell(v: string | number) {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(name: string, header: string[], rows: (string | number)[][]) {
  const text = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export function TimeDashboard() {
  const [period, setPeriod] = useState<Period>(() => periodOf('month', new Date()))
  const [axes, setAxes] = useState<Axis[]>(['area', 'project', 'activity'])
  const [rows, setRows] = useState<SummaryRow[] | null>(null)
  const [split, setSplit] = useState<SummaryRow[]>([])
  const [recon, setRecon] = useState<ReconRow[]>([])
  const [cal, setCal] = useState<WorkCalendar | null>(null)
  const [unmapped, setUnmapped] = useState<Project[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    loadWorkCalendar().then(setCal).catch((e) => setError((e as Error).message))
    listProjects({ needsMapping: true }).then(setUnmapped).catch((e) => setError((e as Error).message))
  }, [])

  useEffect(() => {
    setError('')
    Promise.all([summary(axes, period.from, period.to), summary(['billable', 'category'], period.from, period.to)])
      .then(([r, s]) => { setRows(r); setSplit(s) })
      .catch((e) => setError((e as Error).message))
  }, [period, axes])

  const year = period.from.slice(0, 4)
  useEffect(() => {
    billableVsInvoiced(`${year}-01-01`, `${Number(year) + 1}-01-01`).then(setRecon).catch((e) => setError((e as Error).message))
  }, [year])

  const total = sum(split)
  const billable = sum(split, (r) => r.path[0] === 'Billable')
  const flow = sum(split, (r) => r.path[1] === 'flow')
  const target = useMemo(() => {
    if (!cal?.hoursPerDay) return null
    const days = workingDays(period.from, period.to, today(), cal.holidays)
    return { days, hours: days * cal.hoursPerDay }
  }, [cal, period])
  const pct = (part: number) => (total > 0 ? `${Math.round((part / total) * 100)}%` : '-')
  const tree = useMemo(() => (rows && rows.length ? toTree(rows) : null), [rows])

  const exportRows = () => downloadCsv(
    `time-${period.from}-to-${period.to}.csv`,
    [...axes.map(axisLabel), 'Hours'],
    (rows ?? []).map((r) => [...axes.map((_, i) => r.path[i] ?? ''), r.hours]),
  )

  const reconRows = recon.filter((r) => r.logged_hours > 0 || r.invoiced_hours > 0)
  const remaining = AXES.filter((a) => !axes.includes(a.value))

  return (
    <div className="space-y-6">
      <PageHeader title="Time" subtitle="Where your hours went, from Relay and what you log here." />

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-slate-700 overflow-hidden" role="group" aria-label="Period length">
          {GRAINS.map((g) => (
            <button
              key={g.id}
              onClick={() => setPeriod(periodOf(g.id, new Date()))}
              className={`px-3 py-1.5 text-sm ${period.grain === g.id ? 'bg-slate-700 text-cyan-300' : 'text-slate-300 hover:bg-slate-800'}`}
            >{g.label}</button>
          ))}
        </div>
        <div className="flex items-center">
          <button className={btnIcon} onClick={() => setPeriod(shift(period, -1))} aria-label="Previous period"><ChevronLeft size={18} /></button>
          <span className="min-w-[10rem] text-center text-sm text-slate-200">{period.label}</span>
          <button className={btnIcon} onClick={() => setPeriod(shift(period, 1))} aria-label="Next period"><ChevronRight size={18} /></button>
        </div>
      </div>

      {error && <Card><p className="text-sm text-danger-400 break-words">{error}</p></Card>}

      {unmapped.length > 0 && (
        <div className="rounded-xl border border-warning-500/40 bg-warning-500/10 p-4 text-sm text-warning-200 flex gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p className="min-w-0">
            Relay sent time for {unmapped.length === 1 ? 'a project' : 'projects'} Nexus does not know yet: {unmapped.map((p) => p.name).join(', ')}.{' '}
            <Link to="/time/projects?needs_mapping=1" className="underline">Give each an area of work</Link> so its hours count in the right place.
          </p>
        </div>
      )}

      <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
        <Tile
          label="Logged"
          value={hoursLabel(total)}
          hint={target
            ? `Target to date ${hoursLabel(target.hours)} (${target.days} working days)`
            : <Link to="/agent-settings" className="underline">Set hours per day for a target</Link>}
        />
        <Tile label="Billable" value={hoursLabel(billable)} hint={`${pct(billable)} of logged`} />
        <Tile label="Flow" value={hoursLabel(flow)} hint={`${pct(flow)} of logged`} />
        <Tile label="Pace" value={target && target.hours > 0 ? `${Math.round((total / target.hours) * 100)}%` : '-'} hint="Logged against target to date" />
      </div>

      <div className="grid gap-6 xl:grid-cols-12">
        <Card className="xl:col-span-7 min-w-0 p-4 sm:p-6">
          <CardHeader title="Where the hours went" subtitle="Group by, inner ring first. Click a ring to zoom." />
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {axes.map((a, i) => (
              <span key={a} className="inline-flex items-center gap-1 rounded-full border border-slate-600 bg-slate-800 pl-2.5 pr-1 py-0.5 text-xs text-slate-200">
                <span className="text-slate-500">{i + 1}</span> {axisLabel(a)}
                <button onClick={() => setAxes(axes.filter((x) => x !== a))} className="p-0.5 rounded-full hover:bg-slate-700" aria-label={`Remove ${axisLabel(a)}`}><X size={12} /></button>
              </span>
            ))}
            {axes.length < MAX_AXES && remaining.length > 0 && (
              <label className="inline-flex items-center gap-1 text-xs text-slate-400">
                <Plus size={12} />
                <select value="" onChange={(e) => e.target.value && setAxes([...axes, e.target.value as Axis])} className={`${input} py-1 text-xs`} aria-label="Add a ring">
                  <option value="">Add a ring</option>
                  {remaining.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </label>
            )}
          </div>
          {!axes.length ? (
            <p className="text-sm text-slate-400">Pick at least one grouping.</p>
          ) : rows === null ? (
            <p className="text-sm text-slate-400">Loading.</p>
          ) : tree ? (
            <SunburstZoomChart data={tree} onDownload={exportRows} />
          ) : (
            <p className="text-sm text-slate-400">No time logged in this period yet.</p>
          )}
        </Card>

        <div className="xl:col-span-5 space-y-6 min-w-0">
          <Card className="p-4 sm:p-6">
            <CardHeader title={`Billable logged vs invoiced, ${year}`} />
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-slate-400 border-b border-slate-700/50">
                  <tr><th className={th}>Month</th><th className={`${th} text-right`}>Logged</th><th className={`${th} text-right`}>Invoiced</th><th className={`${th} text-right`}>Gap</th></tr>
                </thead>
                <tbody className="text-slate-200">
                  {reconRows.map((r) => (
                    <tr key={r.month} className="border-b border-slate-800/60">
                      <td className={`${td} whitespace-nowrap`}>{new Date(`${r.month.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</td>
                      <td className={`${td} text-right tabular-nums`}>{hoursLabel(r.logged_hours)}</td>
                      <td className={`${td} text-right tabular-nums`}>{hoursLabel(r.invoiced_hours)}</td>
                      <td className={`${td} text-right tabular-nums ${r.logged_hours - r.invoiced_hours < 0 ? 'text-warning-300' : 'text-slate-400'}`}>{hoursLabel(r.logged_hours - r.invoiced_hours)}</td>
                    </tr>
                  ))}
                  {reconRows.length === 0 && <tr><td className={`${td} text-slate-400`} colSpan={4}>Nothing logged or invoiced in {year}.</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-slate-400">Invoiced hours count each client period once. Logged hours start when Relay or Nexus started recording.</p>
          </Card>

          <Card className="p-4 sm:p-6">
            <CardHeader title="Days" subtitle={cal?.hoursPerDay ? `Target ${hoursLabel(cal.hoursPerDay)} per working day` : undefined} />
            <MonthCalendar targetHours={cal?.hoursPerDay ?? null} holidays={cal?.holidays ?? new Set()} initialMonth={`${period.from.slice(0, 7)}-01`} />
          </Card>
        </div>
      </div>
    </div>
  )
}
