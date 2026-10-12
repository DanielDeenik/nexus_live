import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Info, Play, Radar } from 'lucide-react'
import { Card, CardHeader } from '../../components/ui/Card'
import { ErrorNote, PageHeader, Tile, btnGhost, btnPrimary, td, th } from '../../components/time/ui'
import { SubmissionChip } from '../../components/recruiter/bits'
import {
  type AgentRun, type Application, type Role, type Submission,
  countSubmissionsSince, latestRun, listApplications, listRoles, listSubmissions, metricsText, runIntake, scanRoles, when,
} from '../../lib/recruiter'

const OPEN = new Set(['new', 'shortlisted'])
const failed = (r: AgentRun | null) => !!r && /fail|error/i.test(r.status)

export function RecruiterOverview() {
  const [subs, setSubs] = useState<Submission[] | null>(null)
  const [roles, setRoles] = useState<Role[]>([])
  const [apps, setApps] = useState<Application[]>([])
  const [monthCount, setMonthCount] = useState(0)
  const [run, setRun] = useState<AgentRun | null>(null)
  const [scan, setScan] = useState<AgentRun | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'' | 'intake' | 'roles'>('')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(() => {
    setError('')
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    Promise.all([listSubmissions(), listRoles(), listApplications(), countSubmissionsSince(monthStart), latestRun('recruiter'), latestRun('role_monitor')])
      .then(([s, r, a, c, lr, ls]) => { setSubs(s); setRoles(r); setApps(a); setMonthCount(c); setRun(lr); setScan(ls) })
      .catch((e) => setError((e as Error).message))
  }, [])
  useEffect(() => { load() }, [load])

  const act = async (which: 'intake' | 'roles') => {
    setBusy(which); setResult(null)
    try {
      const r = which === 'intake' ? await runIntake() : await scanRoles()
      const m = (r.results ?? []).map((x) => metricsText(x.metrics)).filter(Boolean).join('; ')
      setResult({ ok: true, text: `${which === 'intake' ? 'Intake' : 'Role scan'} finished${m ? `: ${m}` : '.'}` })
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message })
    } finally { setBusy(''); load() }
  }

  const open = roles.filter((r) => OPEN.has(r.status))
  const hot = open.filter((r) => r.tier === 'HOT').length
  const warm = open.filter((r) => r.tier === 'WARM').length
  const waiting = apps.filter((a) => a.status === 'drafted').length

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recruiter"
        subtitle="Specs, questions and call requests from recruiters, and roles found for you."
        action={<>
          <button onClick={() => act('intake')} disabled={!!busy} className={btnPrimary}><Play size={14} className={busy === 'intake' ? 'animate-pulse' : ''} /> {busy === 'intake' ? 'Running' : 'Run intake now'}</button>
          <button onClick={() => act('roles')} disabled={!!busy} className={btnGhost}><Radar size={14} className={busy === 'roles' ? 'animate-pulse' : ''} /> {busy === 'roles' ? 'Scanning' : 'Scan roles now'}</button>
        </>}
      />

      {result && (
        <p className={`text-sm break-words rounded-lg border p-3 ${result.ok ? 'border-success-500/40 bg-success-500/10 text-success-300' : 'border-danger-500/40 bg-danger-500/10 text-danger-300'}`}>{result.text}</p>
      )}
      <ErrorNote message={error} />

      {failed(run) && (
        <div className="rounded-xl border border-danger-500/40 bg-danger-500/10 p-4 text-sm text-danger-200 flex gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p className="min-w-0 break-words">
            The last intake run failed ({when(run!.started_at)}): {run!.error_message ?? 'no message'}.{' '}
            <Link to="/agent-settings" className="underline">Check agent settings</Link>.
          </p>
        </div>
      )}

      <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
        <Tile label="Open roles" value={`${hot} hot`} hint={`${warm} warm, ${open.length} open in total`} />
        <Tile label="Submissions this month" value={String(monthCount)} hint={`${(subs ?? []).filter((s) => s.status === 'new').length} not handled yet`} />
        <Tile label="CV drafts waiting" value={String(waiting)} hint={<Link to="/recruiter/applications" className="underline">Applications</Link>} />
        <Tile
          label="Last run"
          value={run ? run.status : 'Never'}
          hint={<>{run ? `Intake ${when(run.finished_at ?? run.started_at)}` : 'Intake has not run'}{scan ? `. Roles ${scan.status} ${when(scan.finished_at ?? scan.started_at)}` : ''}</>}
        />
      </div>

      <Card className="p-4 sm:p-6">
        <div className="flex gap-2 text-sm text-slate-300">
          <Info size={16} className="mt-0.5 shrink-0 text-sky-400" />
          <p>Nothing is sent for you. Replies and CVs are saved as drafts in your Gmail; you read and send them yourself. Calls are invitations in Google Calendar that you accept or decline there.</p>
        </div>
      </Card>

      <Card className="p-4 sm:p-6">
        <CardHeader title="Submissions" subtitle="Newest first" />
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-400 border-b border-slate-700/50">
              <tr>
                <th className={th}>Received</th><th className={th}>Status</th><th className={th}>Who</th><th className={th}>Kind</th>
                <th className={th}>Role</th><th className={th}>Drafted</th><th className={th}>Call</th>
              </tr>
            </thead>
            <tbody className="text-slate-200">
              {subs?.map((s) => {
                const drafts = s.outcome?.drafts ?? []
                return (
                  <tr key={s.id} className="border-b border-slate-800/60">
                    <td className={`${td} whitespace-nowrap tabular-nums`}>{when(s.received_at)}</td>
                    <td className={`${td} min-w-[9rem]`}>
                      <SubmissionChip status={s.status} />
                      {s.outcome?.score != null && <div className="mt-1 text-xs text-slate-400 tabular-nums">Score {Math.round(s.outcome.score)}</div>}
                      {s.error && <div className="mt-1 text-xs text-danger-300 max-w-[14rem] break-words">{s.error}</div>}
                    </td>
                    <td className={`${td} min-w-[10rem]`}>
                      <div>{s.name ?? '-'}</div>
                      <div className="text-xs text-slate-400 break-all">{[s.company, s.email].filter(Boolean).join(', ')}</div>
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{s.kind}</td>
                    <td className={`${td} min-w-[8rem]`}>{s.role ?? (s.kind === 'question' ? <span className="text-slate-400">{s.question?.slice(0, 80) ?? '-'}</span> : '-')}</td>
                    <td className={`${td} min-w-[11rem] text-slate-300 break-words`}>
                      {drafts.length ? drafts.map((d) => <div key={d.id}><span className="text-slate-400">To {d.to}:</span> {d.subject}</div>) : '-'}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{s.outcome?.call_at ? when(s.outcome.call_at) : '-'}</td>
                  </tr>
                )
              })}
              {subs && subs.length === 0 && <tr><td className={`${td} text-slate-400`} colSpan={7}>No submissions yet.</td></tr>}
              {!subs && !error && <tr><td className={`${td} text-slate-400`} colSpan={7}>Loading.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
