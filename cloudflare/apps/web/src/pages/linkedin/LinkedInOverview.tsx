import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Info } from 'lucide-react'
import { Card, CardHeader } from '../../components/ui/Card'
import { ErrorNote, PageHeader, Tile, td, th } from '../../components/time/ui'
import { TierChip } from '../../components/recruiter/bits'
import { BarList, ImportCard, ImportChip, countedBars } from '../../components/linkedin/bits'
import { DIMENSION_LABELS, type ImportRow, type LinkedInSummary, type Snapshot, countsText, int, listImports, loadSummary, pct, shortDay } from '../../lib/linkedin'
import { addDays, iso, today } from '../../lib/period'
import { type RoleTier, when } from '../../lib/recruiter'

// Series colours match the rest of Nexus: sky for the primary measure,
// teal for the secondary one.
const SKY = '#0284c7'
const TEAL = '#14b8a6'
const AXIS = { fill: '#94a3b8', fontSize: 12 }
const TIP = { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#e2e8f0' }

type RangeId = 'all' | '90' | '365' | 'ytd'
const RANGES: { id: RangeId; label: string }[] = [
  { id: '90', label: '90 days' },
  { id: '365', label: '12 months' },
  { id: 'ytd', label: 'This year' },
  { id: 'all', label: 'All' },
]
function rangeOf(id: RangeId): { from: string | null; to: string | null } {
  const t = today()
  if (id === '90') return { from: addDays(t, -89), to: t }
  if (id === '365') return { from: addDays(t, -364), to: t }
  if (id === 'ytd') return { from: iso(new Date(new Date().getFullYear(), 0, 1)), to: t }
  return { from: null, to: null }
}

const dayTick = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const monthTick = (s: string) => new Date(`${s}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })

function SnapshotCard({ title, snap, lists, empty }: { title: string; snap: Snapshot | null; lists: { label: string; key: keyof Snapshot['details'] }[]; empty: string }) {
  return (
    <Card className="p-4 sm:p-6">
      <CardHeader title={title} subtitle={snap ? `${snap.period_label ?? 'Period not shown'}, captured ${shortDay(snap.captured_at)}` : undefined} />
      {!snap ? <p className="text-sm text-slate-500">{empty}</p> : (
        <div className="space-y-5">
          <p className="text-3xl font-semibold text-slate-50 tabular-nums">
            {int(snap.total)}
            {snap.details.change_pct != null && (
              <span className={`ml-2 text-sm ${snap.details.change_pct >= 0 ? 'text-success-300' : 'text-danger-300'}`}>
                {snap.details.change_pct >= 0 ? '+' : ''}{snap.details.change_pct}%
              </span>
            )}
          </p>
          <div className="grid gap-5 sm:grid-cols-2">
            {lists.map((l) => {
              const items = countedBars(snap.details[l.key] as never)
              return items.length ? (
                <div key={String(l.key)}>
                  <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">{l.label}</p>
                  <BarList items={items} />
                </div>
              ) : null
            })}
          </div>
        </div>
      )}
    </Card>
  )
}

export function LinkedInOverview() {
  const [range, setRange] = useState<RangeId>('365')
  const [data, setData] = useState<LinkedInSummary | null>(null)
  const [imports, setImports] = useState<ImportRow[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setError('')
    const r = rangeOf(range)
    loadSummary(r.from, r.to).then(setData).catch((e) => setError((e as Error).message))
    listImports().then(setImports).catch((e) => setError((e as Error).message))
  }, [range])
  useEffect(() => { load() }, [load])
  // The old imports address lands here with #import-history.
  const { hash } = useLocation()
  useEffect(() => {
    if (hash && imports) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [hash, imports])

  const followerSeries = useMemo(() => {
    let run = 0
    return (data?.series ?? []).map((d) => ({ day: d.day, cumulative: (run += d.new_followers ?? 0) }))
  }, [data])

  const c = data?.content
  const dims = Object.entries(data?.audience.dimensions ?? {})
  const hasContent = (data?.series.length ?? 0) > 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="LinkedIn"
        subtitle="Reach, audience and network, from the exports and screenshots you import."
        action={
          <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
            {RANGES.map((r) => (
              <button key={r.id} onClick={() => setRange(r.id)}
                className={`px-3 py-1.5 text-sm ${range === r.id ? 'bg-slate-700 text-cyan-300' : 'text-slate-300 hover:bg-slate-800'}`}>{r.label}</button>
            ))}
          </div>
        }
      />
      <ErrorNote message={error} />

      <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
        <Tile label="Impressions" value={int(c?.impressions)} hint={c?.days ? `${c.days} days with data` : 'No content data in this range'} />
        <Tile label="Engagement rate" value={pct(c?.engagement_rate, 2)} hint={`${int(c?.engagements)} engagements`} />
        <Tile label="Followers" value={int(data?.followers.total)} hint={`${data?.followers.growth ? `+${int(data.followers.growth)}` : 'No'} new in range${data?.followers.as_of ? `, total as of ${shortDay(data.followers.as_of)}` : ''}`} />
        <Tile label="Recruiters in network" value={int(data?.network.recruiters)} hint={`${int(data?.network.connections)} connections, ${int(data?.messages.inbound_recruiter)} recruiter messages in range`} />
      </div>

      <ImportCard onDone={load} />

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="p-4 sm:p-6 xl:col-span-2">
          <CardHeader title="Impressions and engagements" subtitle="Per day" />
          {!hasContent ? <p className="text-sm text-slate-500">Import a Content analytics export to see this.</p> : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data!.series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#1e293b" />
                  <XAxis dataKey="day" tickFormatter={dayTick} tick={AXIS} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis yAxisId="i" tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="e" orientation="right" tick={AXIS} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={TIP} labelFormatter={(l) => shortDay(String(l))} />
                  <Legend wrapperStyle={{ color: '#cbd5e1', fontSize: 12 }} />
                  <Line yAxisId="i" type="monotone" dataKey="impressions" name="Impressions" stroke={SKY} strokeWidth={2} dot={false} />
                  <Line yAxisId="e" type="monotone" dataKey="engagements" name="Engagements" stroke={TEAL} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
        <Card className="p-4 sm:p-6">
          <CardHeader title="Follower growth" subtitle="New followers, added up over the range" />
          {!hasContent ? <p className="text-sm text-slate-500">No follower data in this range.</p> : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={followerSeries} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#1e293b" />
                  <XAxis dataKey="day" tickFormatter={dayTick} tick={AXIS} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={TIP} labelFormatter={(l) => shortDay(String(l))} />
                  <Line type="monotone" dataKey="cumulative" name="New followers" stroke={SKY} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <Card className="p-4 sm:p-6">
        <CardHeader title="Top posts" subtitle="By engagements, published in the range" />
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-400 border-b border-slate-700/50">
              <tr><th className={th}>Published</th><th className={th}>Post</th><th className={`${th} text-right`}>Impressions</th><th className={`${th} text-right`}>Engagements</th><th className={`${th} text-right`}>Rate</th></tr>
            </thead>
            <tbody className="text-slate-200">
              {data?.top_posts.map((p) => (
                <tr key={p.url} className="border-b border-slate-800/60">
                  <td className={`${td} whitespace-nowrap tabular-nums`}>{shortDay(p.published_on)}</td>
                  <td className={`${td} max-w-[22rem]`}><a href={p.url} target="_blank" rel="noreferrer" className="block truncate text-sky-300 hover:underline" title={p.url}>{p.url.replace(/^https?:\/\/(www\.)?/, '')}</a></td>
                  <td className={`${td} text-right tabular-nums`}>{int(p.impressions)}</td>
                  <td className={`${td} text-right tabular-nums`}>{int(p.engagements)}</td>
                  <td className={`${td} text-right tabular-nums`}>{pct(p.rate, 2)}</td>
                </tr>
              ))}
              {data && data.top_posts.length === 0 && <tr><td className={`${td} text-slate-400`} colSpan={5}>No posts in this range.</td></tr>}
              {!data && !error && <tr><td className={`${td} text-slate-400`} colSpan={5}>Loading.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4 sm:p-6">
        <CardHeader title="Audience" subtitle={data?.audience.as_of ? `Who saw your content, as of ${shortDay(data.audience.as_of)}` : 'Who saw your content'} />
        {dims.length === 0 ? <p className="text-sm text-slate-500">No demographics imported yet.</p> : (
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {dims.map(([dim, items]) => (
              <div key={dim}>
                <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">{DIMENSION_LABELS[dim] ?? dim.replace(/_/g, ' ')}</p>
                <BarList items={items.map((i) => ({ label: i.value, value: i.pct, text: i.pct != null ? pct(i.pct) : i.pct_label ?? '-' }))} />
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="p-4 sm:p-6">
          <CardHeader title="Recruiters in your network" subtitle="Connections whose position reads as recruiting, by company" />
          <BarList empty="Import your data archive to see this."
            items={(data?.network.top_recruiter_companies ?? []).map((r) => ({ label: r.company, value: r.recruiters, text: int(r.recruiters) }))} />
        </Card>
        <Card className="p-4 sm:p-6">
          <CardHeader title="Inbound recruiter messages" subtitle={`Per month; ${int(data?.messages.inbound)} inbound messages in range`} />
          {!(data?.messages.recruiter_by_month.length) ? <p className="text-sm text-slate-500">No recruiter messages in this range.</p> : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.messages.recruiter_by_month} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#1e293b" />
                  <XAxis dataKey="month" tickFormatter={monthTick} tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip cursor={{ fill: 'rgba(148,163,184,0.08)' }} contentStyle={TIP} labelFormatter={(l) => monthTick(String(l))} />
                  <Bar dataKey="count" name="Messages" fill={SKY} radius={[4, 4, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <SnapshotCard title="Profile views" snap={data?.profile.views ?? null} empty="Import a screenshot of Who viewed your profile."
          lists={[{ label: 'Titles', key: 'titles' }, { label: 'Companies', key: 'companies' }, { label: 'Locations', key: 'locations' }]} />
        <SnapshotCard title="Search appearances" snap={data?.profile.search ?? null} empty="Import a screenshot of Search appearances."
          lists={[{ label: 'Where you appeared', key: 'appeared_where' }, { label: 'Keywords', key: 'keywords' }, { label: 'Searcher companies', key: 'companies' }, { label: 'Searcher titles', key: 'titles' }]} />
      </div>

      <Card className="p-4 sm:p-6">
        <CardHeader title="Warm companies" subtitle="Recruiters you know at companies with open roles in the recruiter section" />
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-400 border-b border-slate-700/50">
              <tr><th className={th}>Company</th><th className={`${th} text-right`}>Recruiters</th><th className={th}>Roles</th></tr>
            </thead>
            <tbody className="text-slate-200">
              {data?.warm_companies.map((w) => (
                <tr key={w.company} className="border-b border-slate-800/60">
                  <td className={`${td} min-w-[10rem]`}>{w.company}</td>
                  <td className={`${td} text-right tabular-nums`}>{int(w.recruiters)}</td>
                  <td className={`${td} min-w-[14rem]`}>
                    <ul className="space-y-1">
                      {w.role_list.map((r, i) => (
                        <li key={`${r.title}-${i}`} className="flex flex-wrap items-center gap-2"><TierChip tier={r.tier as RoleTier} /><span>{r.title}</span><span className="text-xs text-slate-400 tabular-nums">score {r.score}</span></li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
              {data && data.warm_companies.length === 0 && (
                <tr><td className={`${td} text-slate-400`} colSpan={3}>No overlap yet between recruiter connections and <Link to="/recruiter/roles" className="underline">open roles</Link>.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4 sm:p-6">
        <div className="flex gap-2 text-sm text-slate-300">
          <Info size={16} className="mt-0.5 shrink-0 text-sky-400" />
          <p>Recruiters are found by keywords in a position, subject or message (set in app config). Profile views and search appearances are read from your screenshots and show only what was visible. <a href="#import-history" className="underline">Import history</a>.</p>
        </div>
      </Card>

      <Card className="p-4 sm:p-6">
        <div id="import-history" className="scroll-mt-20" />
        <CardHeader title="Import history" subtitle="Every file imported, newest first; a file imported again updates its row" />
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-400 border-b border-slate-700/50">
              <tr><th className={th}>Imported</th><th className={th}>Kind</th><th className={th}>Status</th><th className={th}>Covers</th><th className={th}>File</th><th className={th}>Result</th></tr>
            </thead>
            <tbody className="text-slate-200">
              {imports?.map((r) => (
                <tr key={r.id} className="border-b border-slate-800/60">
                  <td className={`${td} whitespace-nowrap tabular-nums`}>{when(r.imported_at)}</td>
                  <td className={`${td} whitespace-nowrap`}>{r.kind}</td>
                  <td className={td}><ImportChip status={r.status} /></td>
                  <td className={`${td} whitespace-nowrap tabular-nums`}>{r.period_from || r.period_to ? `${shortDay(r.period_from)} to ${shortDay(r.period_to)}` : '-'}</td>
                  <td className={`${td} max-w-[14rem] truncate`} title={r.path}>{r.path.split('/').pop()?.replace(/^\d+_/, '')}</td>
                  <td className={`${td} min-w-[16rem] break-words text-slate-300`}>
                    {r.error ? <span className="text-danger-300">{r.error}</span> : countsText(r.counts)}
                    {(r.warnings ?? []).map((w) => <div key={w} className="text-xs text-warning-300">{w}</div>)}
                  </td>
                </tr>
              ))}
              {imports && imports.length === 0 && <tr><td className={`${td} text-slate-400`} colSpan={6}>Nothing imported yet.</td></tr>}
              {!imports && !error && <tr><td className={`${td} text-slate-400`} colSpan={6}>Loading.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
