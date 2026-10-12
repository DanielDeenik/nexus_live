import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Gauge } from 'lucide-react'
import { Card, CardHeader } from '../../components/ui/Card'
import { Chip, ErrorNote, Field, PageHeader, btnPrimary, input, td, th } from '../../components/time/ui'
import { Prose, ScoreBar } from '../../components/recruiter/bits'
import { type FitReport, type Requirement, assessSpec, day, listFitReports } from '../../lib/recruiter'

function RequirementTable({ rows, empty }: { rows: Requirement[]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-slate-400">{empty}</p>
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-slate-400 border-b border-slate-700/50">
          <tr><th className={th}>Requirement</th><th className={th}>Must or nice</th><th className={th}>Area</th><th className={th}>Tier</th><th className={`${th} text-right`}>Weight</th></tr>
        </thead>
        <tbody className="text-slate-200">
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-800/60">
              <td className={`${td} min-w-[14rem]`}>{r.text}</td>
              <td className={td}>{r.must_have ? <Chip tone="warn">must</Chip> : <Chip>nice</Chip>}</td>
              <td className={`${td} whitespace-nowrap text-slate-300`}>{r.area_label ?? r.area_id ?? '-'}</td>
              <td className={`${td} whitespace-nowrap text-slate-300`}>{r.tier ?? '-'}</td>
              <td className={`${td} text-right tabular-nums`}>{r.tier_weight ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReportRow({ r }: { r: FitReport }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="py-4">
      <button onClick={() => setOpen(!open)} className="w-full text-left" aria-expanded={open}>
        <div className="flex items-start gap-2">
          {open ? <ChevronDown size={16} className="mt-1 shrink-0 text-slate-400" /> : <ChevronRight size={16} className="mt-1 shrink-0 text-slate-400" />}
          <div className="min-w-0 flex-1 grid gap-2 md:grid-cols-[1fr_12rem] md:items-center">
            <div className="min-w-0">
              <p className="text-slate-100 font-medium break-words">{r.role_title ?? 'Untitled role'}{r.company ? <span className="text-slate-400 font-normal">, {r.company}</span> : null}</p>
              <p className="text-xs text-slate-400">{day(r.created_at)}{r.verdict ? `. ${r.verdict}` : ''}</p>
              {r.centre_of_gravity && <p className="mt-1 text-sm text-slate-300 break-words">Centre of gravity: {r.centre_of_gravity}</p>}
            </div>
            <div className="flex items-center gap-2">
              <ScoreBar score={r.score} match={r.is_match} />
              {r.is_match ? <Chip tone="good">match</Chip> : <Chip>no match</Chip>}
            </div>
          </div>
        </div>
      </button>
      {open && (
        <div className="mt-4 space-y-4 pl-6">
          <div><h4 className="text-sm font-semibold text-slate-200 mb-2">Requirements</h4><RequirementTable rows={r.requirements ?? []} empty="No requirements parsed." /></div>
          <div><h4 className="text-sm font-semibold text-slate-200 mb-2">Gaps</h4><RequirementTable rows={r.gaps ?? []} empty="No gaps found." /></div>
          {r.report && <div><h4 className="text-sm font-semibold text-slate-200 mb-2">Report</h4><Prose text={r.report} /></div>}
        </div>
      )}
    </li>
  )
}

export function FitReports() {
  const [rows, setRows] = useState<FitReport[] | null>(null)
  const [error, setError] = useState('')
  const [spec, setSpec] = useState('')
  const [role, setRole] = useState('')
  const [company, setCompany] = useState('')
  const [busy, setBusy] = useState(false)
  const [formErr, setFormErr] = useState('')
  const [result, setResult] = useState<{ score: number; is_match: boolean; verdict: string; report: string } | null>(null)

  const load = useCallback(() => { listFitReports().then(setRows).catch((e) => setError((e as Error).message)) }, [])
  useEffect(() => { load() }, [load])

  const assess = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setFormErr(''); setResult(null)
    try { setResult(await assessSpec(spec.trim(), role.trim() || undefined, company.trim() || undefined)); load() } catch (x) { setFormErr((x as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Fit reports" subtitle="How well a role spec matches your experience." />

      <Card className="p-4 sm:p-6">
        <CardHeader title="Assess a spec" />
        <form onSubmit={assess} className="space-y-3">
          <Field label="Role spec"><textarea required rows={7} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="Paste the job spec" className={`${input} w-full`} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Role (optional)"><input value={role} onChange={(e) => setRole(e.target.value)} className={`${input} w-full`} /></Field>
            <Field label="Company (optional)"><input value={company} onChange={(e) => setCompany(e.target.value)} className={`${input} w-full`} /></Field>
          </div>
          <ErrorNote message={formErr} />
          <button disabled={busy || !spec.trim()} className={btnPrimary}><Gauge size={14} /> {busy ? 'Assessing' : 'Assess'}</button>
        </form>
        {result && (
          <div className="mt-5 space-y-3 border-t border-slate-700/50 pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="w-48"><ScoreBar score={result.score} match={result.is_match} /></div>
              {result.is_match ? <Chip tone="good">match</Chip> : <Chip>no match</Chip>}
              <span className="text-sm text-slate-300">{result.verdict}</span>
            </div>
            <Prose text={result.report} />
          </div>
        )}
      </Card>

      <Card className="p-4 sm:p-6">
        <CardHeader title="Reports" subtitle="Newest first. Open one for requirements and gaps." />
        <ErrorNote message={error} />
        <ul className="divide-y divide-slate-800/60">
          {rows?.map((r) => <ReportRow key={r.id} r={r} />)}
          {rows && rows.length === 0 && <li className="py-2 text-sm text-slate-400">No fit reports yet.</li>}
          {!rows && !error && <li className="py-2 text-sm text-slate-400">Loading.</li>}
        </ul>
      </Card>
    </div>
  )
}
