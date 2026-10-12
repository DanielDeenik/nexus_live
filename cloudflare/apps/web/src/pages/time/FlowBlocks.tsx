import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { ErrorNote, Field, PageHeader, Pager, input, td, th } from '../../components/time/ui'
import { type FlowBlock, type Project, listFlowBlocks, listProjects } from '../../lib/time'

const PER_PAGE = 50

const when = (s: string) => new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

function triggersText(t: unknown): string {
  if (Array.isArray(t)) return t.map(String).join(', ')
  if (t && typeof t === 'object') return Object.entries(t).filter(([, v]) => v).map(([k]) => k).join(', ')
  return t ? String(t) : ''
}

// Flow blocks come from Relay: the goal, how long it ran against the plan,
// and your own read of the block when you closed it. Read only.
export function FlowBlocks() {
  const [params, setParams] = useSearchParams()
  const from = params.get('from') ?? ''
  const before = params.get('before') ?? ''
  const page = Math.max(1, Number(params.get('page') ?? 1))
  const [data, setData] = useState<{ rows: FlowBlock[]; total: number } | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState('')

  useEffect(() => { listProjects().then(setProjects).catch((e) => setError((e as Error).message)) }, [])
  useEffect(() => {
    setError('')
    listFlowBlocks({ from: from || undefined, before: before || undefined }, page, PER_PAGE).then(setData).catch((e) => setError((e as Error).message))
  }, [from, before, page])

  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v); else next.delete(k)
    if (k !== 'page') next.delete('page')
    setParams(next)
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Flow blocks" subtitle="Sent by Relay when you close a block. Read only." />
      <Card className="p-4 sm:p-6">
        <div className="grid gap-3 grid-cols-2 sm:flex sm:flex-wrap mb-4">
          <Field label="From"><input type="date" value={from} onChange={(e) => setParam('from', e.target.value)} className={`${input} w-full`} /></Field>
          <Field label="Before"><input type="date" value={before} onChange={(e) => setParam('before', e.target.value)} className={`${input} w-full`} /></Field>
        </div>
        <ErrorNote message={error} />
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-400 border-b border-slate-700/50">
              <tr>
                <th className={th}>Started</th><th className={th}>Project</th><th className={th}>Goal</th>
                <th className={`${th} text-right`}>Minutes</th><th className={`${th} text-right`}>Planned</th>
                <th className={`${th} text-right`}>Depth</th><th className={th}>Interrupted</th><th className={`${th} text-right`}>Recovery</th>
                <th className={th}>Challenge</th><th className={th}>Triggers</th><th className={th}>Note</th>
              </tr>
            </thead>
            <tbody className="text-slate-200">
              {data?.rows.map((b) => (
                <tr key={b.id} className="border-b border-slate-800/60">
                  <td className={`${td} whitespace-nowrap tabular-nums`}>{when(b.started_at)}</td>
                  <td className={`${td} whitespace-nowrap`}>{b.project_id ? projectName.get(b.project_id) ?? '-' : '-'}</td>
                  <td className={`${td} min-w-[12rem]`}>{b.goal ?? ''}</td>
                  <td className={`${td} text-right tabular-nums`}>{b.minutes}</td>
                  <td className={`${td} text-right tabular-nums text-slate-400`}>{b.planned_min ?? '-'}</td>
                  <td className={`${td} text-right tabular-nums`}>{b.depth != null ? `${b.depth} / 5` : '-'}</td>
                  <td className={td}>{b.interrupted ? <span className="text-warning-300">Yes</span> : b.interrupted === false ? <span className="text-slate-500">No</span> : '-'}</td>
                  <td className={`${td} text-right tabular-nums text-slate-400`}>{b.recovery_min ?? '-'}</td>
                  <td className={`${td} min-w-[8rem] text-slate-300`}>{b.challenge ?? ''}</td>
                  <td className={`${td} min-w-[8rem] text-slate-300`}>{triggersText(b.triggers)}</td>
                  <td className={`${td} min-w-[12rem] text-slate-300`}>{b.note ?? ''}</td>
                </tr>
              ))}
              {data && data.rows.length === 0 && <tr><td className={`${td} text-slate-400`} colSpan={11}>No flow blocks{from || before ? ' in this range' : ' yet'}.</td></tr>}
              {!data && !error && <tr><td className={`${td} text-slate-400`} colSpan={11}>Loading.</td></tr>}
            </tbody>
          </table>
        </div>
        {data && <Pager page={page} perPage={PER_PAGE} total={data.total} onPage={(p) => setParam('page', String(p))} />}
      </Card>
    </div>
  )
}
