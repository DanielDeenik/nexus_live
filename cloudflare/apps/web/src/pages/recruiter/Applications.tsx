import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, FileDown } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { ErrorNote, PageHeader, btnGhost } from '../../components/time/ui'
import { ApplicationChip, Prose } from '../../components/recruiter/bits'
import { type Application, cvUrl, day, listApplications } from '../../lib/recruiter'

function AppRow({ a }: { a: Application }) {
  const [open, setOpen] = useState<'' | 'letter' | 'cv'>('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const download = async () => {
    if (!a.cv_path) return
    setBusy(true); setErr('')
    try { window.open(await cvUrl(a.cv_path), '_blank', 'noopener') } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const toggle = (k: 'letter' | 'cv') => setOpen(open === k ? '' : k)
  const tab = (k: 'letter' | 'cv', label: string) => (
    <button onClick={() => toggle(k)} aria-expanded={open === k} className="inline-flex items-center gap-1 text-sm text-lemon-ink hover:text-ink">
      {open === k ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {label}
    </button>
  )

  return (
    <li className="py-4 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-ink font-medium break-words">{a.role_title ?? 'Untitled role'}{a.company ? <span className="text-muted font-normal">, {a.company}</span> : null}</p>
          <p className="text-xs text-muted break-all">{a.recipient_email ? `To ${a.recipient_email}. ` : ''}Made {day(a.created_at)}</p>
        </div>
        <div className="flex items-center gap-2">
          <ApplicationChip status={a.status} />
          {a.cv_path && <button onClick={download} disabled={busy} className={btnGhost}><FileDown size={14} /> CV</button>}
        </div>
      </div>
      <div className="flex flex-wrap gap-4">{tab('letter', 'Cover letter')}{tab('cv', 'CV text')}</div>
      {open === 'letter' && <Prose text={a.cover_letter} />}
      {open === 'cv' && <Prose text={a.cv_markdown} />}
      <ErrorNote message={err} />
    </li>
  )
}

export function Applications() {
  const [rows, setRows] = useState<Application[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { listApplications().then(setRows).catch((e) => setError((e as Error).message)) }, [])

  return (
    <div className="space-y-6">
      <PageHeader title="Applications" subtitle="Tailored CVs and cover letters. Drafts wait in your Gmail until you send them." />
      <Card className="p-4 sm:p-6">
        <ErrorNote message={error} />
        <ul className="divide-y divide-line">
          {rows?.map((a) => <AppRow key={a.id} a={a} />)}
          {rows && rows.length === 0 && <li className="py-2 text-sm text-muted">No applications yet.</li>}
          {!rows && !error && <li className="py-2 text-sm text-muted">Loading.</li>}
        </ul>
      </Card>
    </div>
  )
}
