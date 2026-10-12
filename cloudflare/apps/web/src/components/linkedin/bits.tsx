import { useRef, useState } from 'react'
import { CheckCircle2, Upload, XCircle } from 'lucide-react'
import { Card, CardHeader } from '../ui/Card'
import { Chip, btnPrimary, input } from '../time/ui'
import { ACCEPT, type Counted, type ImportHint, type ImportResult, countsText, importFile, int } from '../../lib/linkedin'

// Display pieces shared by the LinkedIn pages.

const STATUS_TONE: Record<string, 'muted' | 'warn' | 'info' | 'good' | 'bad'> = {
  running: 'info', succeeded: 'good', partial: 'warn', failed: 'bad',
}
export const ImportChip = ({ status }: { status: string }) => <Chip tone={STATUS_TONE[status] ?? 'muted'}>{status}</Chip>

/** Horizontal bars for a share (0 to 1) or a count; the label keeps its own line on phones. */
export function BarList({ items, empty = 'Nothing yet.' }: { items: { label: string; value: number | null; text: string }[]; empty?: string }) {
  if (!items.length) return <p className="text-sm text-slate-500">{empty}</p>
  const max = Math.max(...items.map((i) => i.value ?? 0), 0)
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.label} className="text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-slate-200" title={i.label}>{i.label}</span>
            <span className="shrink-0 tabular-nums text-slate-400">{i.text}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div className="h-full rounded-full bg-sky-600" style={{ width: `${max > 0 && i.value != null ? Math.max(2, (i.value / max) * 100) : 0}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export const countedBars = (list: Counted[] | undefined) =>
  (list ?? []).map((c) => ({ label: c.label, value: c.count, text: c.count == null ? 'shown' : int(c.count) }))

const HINTS: { id: '' | ImportHint; label: string }[] = [
  { id: '', label: 'Detect from file' },
  { id: 'content', label: 'Content analytics (.xlsx)' },
  { id: 'archive', label: 'Data archive (.zip)' },
  { id: 'profile_views', label: 'Screenshot: who viewed your profile' },
  { id: 'search_appearances', label: 'Screenshot: search appearances' },
]

interface FileResult { name: string; ok: boolean; text: string; status?: string }

/** Upload one or more LinkedIn files and import them one by one, showing
 *  the outcome per file. */
export function ImportCard({ onDone }: { onDone?: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [hint, setHint] = useState<'' | ImportHint>('')
  const [busy, setBusy] = useState('')
  const [results, setResults] = useState<FileResult[]>([])

  const run = async (files: FileList | null) => {
    if (!files?.length) return
    setResults([])
    for (const f of Array.from(files)) {
      setBusy(f.name)
      try {
        const r: ImportResult = await importFile(f, hint || undefined)
        const failed = r.status === 'failed'
        const parts = [r.kind, countsText(r.counts), ...(r.warnings ?? [])].filter(Boolean)
        setResults((x) => [...x, { name: f.name, ok: !failed, status: r.status, text: failed ? r.error ?? 'failed' : parts.join('. ') }])
      } catch (e) {
        setResults((x) => [...x, { name: f.name, ok: false, text: (e as Error).message }])
      }
    }
    setBusy('')
    if (ref.current) ref.current.value = ''
    onDone?.()
  }

  return (
    <Card className="p-4 sm:p-6">
      <CardHeader title="Import" subtitle="Content analytics export, data archive, or profile analytics screenshots" />
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs text-slate-400">
          Kind
          <select className={`mt-1 block ${input}`} value={hint} onChange={(e) => setHint(e.target.value as '' | ImportHint)} disabled={!!busy}>
            {HINTS.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
          </select>
        </label>
        <input ref={ref} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => run(e.target.files)} />
        <button className={btnPrimary} disabled={!!busy} onClick={() => ref.current?.click()}>
          <Upload size={14} className={busy ? 'animate-pulse' : ''} /> {busy ? `Importing ${busy}` : 'Choose files'}
        </button>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Files go to your private folder. From the archive only connections and inbound message details are kept (no email addresses, at most a short snippet per message). Importing the same file again updates what is there.
      </p>
      {results.length > 0 && (
        <ul className="mt-4 space-y-2">
          {results.map((r, i) => (
            <li key={`${r.name}-${i}`} className={`flex gap-2 rounded-lg border p-3 text-sm ${r.ok ? 'border-success-500/40 bg-success-500/10 text-success-200' : 'border-danger-500/40 bg-danger-500/10 text-danger-200'}`}>
              {r.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
              <div className="min-w-0 break-words">
                <span className="font-medium">{r.name}</span>{r.status && r.status !== 'succeeded' && r.ok ? ` (${r.status})` : ''}: {r.text}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
