import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { ErrorNote, Field, PageHeader, input } from '../../components/time/ui'
import { RoleStatusChip, ScoreBar, TierChip } from '../../components/recruiter/bits'
import { ROLE_STATUSES, type Role, type RoleStatus, TIERS, day, listRoles, setRoleStatus } from '../../lib/recruiter'

const ACTIONS: { status: RoleStatus; label: string }[] = [
  { status: 'shortlisted', label: 'Shortlist' },
  { status: 'dismissed', label: 'Dismiss' },
  { status: 'applied', label: 'Applied' },
]

export function Roles() {
  const [params, setParams] = useSearchParams()
  const tier = params.get('tier') ?? ''
  const status = params.get('status') ?? ''
  const min = params.get('min') ?? ''
  const [rows, setRows] = useState<Role[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    setError('')
    listRoles({ tier: tier || undefined, status: status || undefined, minScore: min ? Number(min) : undefined }).then(setRows).catch((e) => setError((e as Error).message))
  }, [tier, status, min])
  useEffect(() => { load() }, [load])

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v); else next.delete(k)
    setParams(next)
  }

  const mark = async (r: Role, s: RoleStatus) => {
    setBusy(r.id); setError('')
    try { await setRoleStatus(r.id, s); load() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Roles" subtitle="Contract roles found on job sources, scored against your profile." />
      <Card className="p-4 sm:p-6">
        <div className="grid gap-3 grid-cols-2 sm:flex sm:flex-wrap mb-4">
          <Field label="Tier">
            <select value={tier} onChange={(e) => setParam('tier', e.target.value)} className={`${input} w-full`}>
              <option value="">All</option>
              {TIERS.map((t) => <option key={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setParam('status', e.target.value)} className={`${input} w-full`}>
              <option value="">All</option>
              {ROLE_STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Min score">
            <input type="number" min="0" max="100" step="5" value={min} onChange={(e) => setParam('min', e.target.value)} className={`${input} w-full sm:w-28`} />
          </Field>
        </div>
        <ErrorNote message={error} />
        <ul className="divide-y divide-slate-800/60">
          {rows?.map((r) => (
            <li key={r.id} className="py-4 space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <div className="min-w-0 sm:flex-1">
                  {r.link
                    ? <a href={r.link} target="_blank" rel="noopener noreferrer" className="font-medium text-slate-100 hover:text-cyan-300 break-words">{r.title}<ExternalLink size={13} className="inline ml-1 -mt-0.5" /></a>
                    : <span className="font-medium text-slate-100 break-words">{r.title}</span>}
                  <p className="text-xs text-slate-400 break-words">
                    {[r.company, r.posted_at ? `posted ${day(r.posted_at)}` : `seen ${day(r.first_seen_at)}`, r.source_ids?.length ? `via ${r.source_ids.join(', ')}` : null].filter(Boolean).join('. ')}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <TierChip tier={r.tier} />
                  <RoleStatusChip status={r.status} />
                  <div className="w-36"><ScoreBar score={r.score} /></div>
                </div>
              </div>
              {r.snippet && <p className="text-sm text-slate-300 break-words">{r.snippet}</p>}
              {!!r.matched?.length && (
                <div className="flex flex-wrap gap-1">
                  {r.matched.map((m, i) => <span key={i} className="rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-xs text-slate-300">{m.keyword} <span className="text-slate-500">+{m.pts}</span></span>)}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {ACTIONS.map((a) => (
                  <button
                    key={a.status}
                    disabled={busy === r.id || r.status === a.status}
                    onClick={() => mark(r, a.status)}
                    className={`rounded-lg border px-2.5 py-1 text-xs disabled:opacity-40 ${a.status === 'dismissed' ? 'border-slate-600 text-slate-300 hover:bg-slate-700/40' : 'border-sky-500/40 text-sky-300 hover:bg-sky-500/10'}`}
                  >{a.label}</button>
                ))}
              </div>
            </li>
          ))}
          {rows && rows.length === 0 && <li className="py-2 text-sm text-slate-400">No roles{tier || status || min ? ' match these filters' : ' yet'}.</li>}
          {!rows && !error && <li className="py-2 text-sm text-slate-400">Loading.</li>}
        </ul>
      </Card>
    </div>
  )
}
