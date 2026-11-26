import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { Card } from '../components/ui/Card'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { supabase } from '../lib/supabase'
import { type Look as LookData, type Ring, SLICE_TOPIC, dayShort, eur0, rings, topics } from '../lib/look'

// Look-through: the phone shows one number a screen; this page shows what is behind it.
// Three rings on top, and under them one table that every slice and every chip opens.

const SIZE = 168
const RADIUS = 64
const WIDTH = 16
const GAP = 2 // a surface gap between slices, so two neighbours never touch

function Donut({ ring, active, onHover, onPick }: { ring: Ring; active: string | null; onHover: (key: string | null) => void; onPick: (key: string) => void }) {
  const round = 2 * Math.PI * RADIUS
  const shown = ring.slices.filter((s) => s.amount > 0)
  const total = shown.reduce((sum, s) => sum + s.amount, 0)
  const hovered = shown.find((s) => s.key === active)
  let at = 0
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-40 h-40 shrink-0" role="img"
      aria-label={`${ring.title}: ${ring.slices.map((s) => `${s.label} ${eur0(s.amount)}`).join(', ')}`}>
      <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="#1e293b" strokeWidth={WIDTH} />
      {shown.map((s) => {
        const share = (s.amount / total) * round
        const length = Math.max(share - GAP, 0.5)
        const offset = -(at + GAP / 2)
        at += share
        return (
          <circle key={s.key} cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke={s.color}
            strokeWidth={active === s.key ? WIDTH + 4 : WIDTH} strokeDasharray={`${length} ${round - length}`} strokeDashoffset={offset}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`} className="cursor-pointer transition-all duration-150"
            onMouseEnter={() => onHover(s.key)} onMouseLeave={() => onHover(null)} onClick={() => onPick(s.key)}>
            <title>{`${s.label}: ${eur0(s.amount)}`}</title>
          </circle>
        )
      })}
      <text x={SIZE / 2} y={SIZE / 2 + 7} textAnchor="middle" fill="#f8fafc" fontSize="20" fontWeight="600" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {hovered ? eur0(hovered.amount) : ring.centre}
      </text>
    </svg>
  )
}

function RingCard({ ring, onPick, children }: { ring: Ring; onPick: (topic: string) => void; children?: React.ReactNode }) {
  const [active, setActive] = useState<string | null>(null)
  const pick = (key: string) => { const topic = SLICE_TOPIC[`${ring.key}:${key}`]; if (topic) onPick(topic) }
  const hovered = ring.slices.find((s) => s.key === active)
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-slate-50">{ring.title}</h3>
          <p className="text-sm text-slate-400 mt-1 truncate">{hovered ? hovered.label : ring.caption}</p>
        </div>
        {children}
      </div>
      <div className="flex flex-col items-center gap-4">
        <Donut ring={ring} active={active} onHover={setActive} onPick={pick} />
        <ul className="w-full space-y-1">
          {ring.slices.map((s) => (
            <li key={s.key}>
              <button type="button" onClick={() => pick(s.key)} onMouseEnter={() => setActive(s.key)} onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(s.key)} onBlur={() => setActive(null)}
                className={`w-full min-h-11 flex items-center gap-3 rounded-lg px-2 text-left text-sm transition-colors ${active === s.key ? 'bg-slate-700/50' : 'hover:bg-slate-700/30'}`}>
                <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: s.color }} aria-hidden="true" />
                <span className="flex-1 text-slate-300">{s.label}</span>
                <span className="text-slate-50 tabular-nums font-medium">{eur0(s.amount)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}

export function Look() {
  const [look, setLook] = useState<LookData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'now' | 'budget'>('now')
  const [params, setParams] = useSearchParams()

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error: failed } = await supabase.rpc('nx_look')
    if (failed) setError(failed.message)
    else { setLook(data as LookData); setError('') }
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  const tables = useMemo(() => (look ? topics(look) : []), [look])
  const charts = useMemo(() => (look ? rings(look, mode) : []), [look, mode])
  const table = tables.find((t) => t.key === params.get('topic')) ?? tables[0]
  const open = (key: string) => setParams({ topic: key }, { replace: true })

  if (loading && !look) return <div className="flex justify-center py-16"><LoadingSpinner /></div>
  if (!look) return <Card><p className="text-sm text-danger-400">The look-through could not load: {error}</p></Card>
  const { as_of, data_through } = look.facts

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-400">
          Figures of {dayShort(as_of, as_of)}{data_through ? `, bank lines to ${dayShort(data_through, as_of)}` : ''}. The phone shows the answer; this page shows what is behind it.
        </p>
        <button type="button" onClick={() => void load()} className="btn-secondary text-sm" disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {error && <p className="text-sm text-danger-400">{error}</p>}

      <div className="grid gap-6 xl:grid-cols-3 lg:grid-cols-2">
        {charts.map((ring) => (
          <RingCard key={ring.key} ring={ring} onPick={open}>
            {ring.key === 'month' && (
              <div className="flex rounded-lg bg-slate-900 p-1 shrink-0" role="group" aria-label="Living costs">
                {(['now', 'budget'] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
                    className={`min-h-9 px-3 rounded-md text-xs font-medium transition-colors ${mode === m ? 'bg-slate-700 text-slate-50' : 'text-slate-400 hover:text-slate-200'}`}>
                    {m === 'now' ? 'As now' : 'On budget'}
                  </button>
                ))}
              </div>
            )}
          </RingCard>
        ))}
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Table">
        {tables.map((t) => (
          <button key={t.key} type="button" onClick={() => open(t.key)} aria-pressed={table?.key === t.key}
            className={`min-h-11 px-4 rounded-full text-sm font-medium transition-colors ${table?.key === t.key ? 'bg-cyan-600 text-slate-950' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {table && (
        <Card>
          <h3 className="text-lg font-semibold text-slate-50">{table.title}</h3>
          <p className="text-sm text-slate-400 mt-1 mb-4">{table.note}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-400 border-b border-slate-700/50">
                <tr>
                  <th className="py-2 pr-4 font-medium">{table.cols[0]}</th>
                  <th className="pr-4 font-medium">{table.cols[1]}</th>
                  <th className="text-right font-medium whitespace-nowrap">{table.cols[2]}</th>
                </tr>
              </thead>
              <tbody className="text-slate-200">
                {table.rows.map((r, i) => (
                  <tr key={`${table.key}-${i}`} className="border-b border-slate-800/60 align-top">
                    <td className="py-2 pr-4 font-medium text-slate-100">{r[0]}</td>
                    <td className="py-2 pr-4 text-slate-400">{r[1]}</td>
                    <td className="py-2 text-right tabular-nums whitespace-nowrap">{r[2]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
