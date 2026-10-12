import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { Card, CardHeader } from './ui/Card'
import { type UploadOutcome, uploadSalesInvoices } from '../lib/nexus'

// Drop in the invoices you sent. The agent reads each one, adds it to income
// and, once its figures are confirmed, writes its hours into Time.
export function InvoiceUpload({ onDone }: { onDone?: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<UploadOutcome[]>([])

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true); setResults([])
    setResults(await uploadSalesInvoices(Array.from(files)))
    setBusy(false)
    if (input.current) input.current.value = ''
    onDone?.()
  }

  return (
    <Card>
      <CardHeader title="Upload invoices" subtitle="PDF or photo of invoices you sent. Each adds to income and its hours go into Time." />
      <label className={`flex items-center justify-center gap-2 rounded-lg border border-dashed border-slate-600 px-4 py-6 text-sm text-slate-300 ${busy ? 'opacity-60' : 'cursor-pointer hover:border-sky-500 hover:text-slate-100'}`}>
        <Upload size={16} />
        {busy ? 'Reading invoices' : 'Choose invoice files'}
        <input ref={input} type="file" multiple accept="application/pdf,image/*" className="hidden" disabled={busy} onChange={(e) => onFiles(e.target.files)} />
      </label>
      {results.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {results.map((r) => (
            <li key={r.file} className={r.ok ? 'text-slate-300' : 'text-warning-400'}>
              <span className="font-medium">{r.file}</span>: {r.text}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
