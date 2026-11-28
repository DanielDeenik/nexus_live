import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Upload } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { type ExpenseRecord, callNexus, eur, loadExpenses, loadParams, money, uploadDocument } from '../lib/nexus'
import { deductibleEur, reclaimableVatEur, type FiscalParams } from '@fiscal'

const STATUS: Record<string, string> = {
  booked: 'text-good', approved: 'text-good', needs_review: 'text-lemon-ink', rejected: 'text-muted', proposed: 'text-muted',
}

export function Expenses() {
  const [rows, setRows] = useState<ExpenseRecord[] | null>(null)
  const [params, setParams] = useState<Map<number, FiscalParams>>(new Map())
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [year, setYear] = useState(new Date().getFullYear())

  const load = useCallback(async () => {
    const [e, p] = await Promise.all([loadExpenses(), loadParams()])
    setRows(e); setParams(p)
  }, [])
  useEffect(() => { load() }, [load])

  const say = (m: string) => setLog((l) => [...l, m])

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true); setLog([])
    for (const f of Array.from(files)) {
      try {
        say(`Uploading ${f.name}`)
        const path = await uploadDocument(f)
        const r = await callNexus<{ status: string; metrics: Record<string, number> }>('expense-agent', { mode: 'upload', path, kind: 'receipt' })
        const m = r.metrics
        say(`${f.name}: ${m.route_book ? 'booked automatically' : m.route_review || m.needs_review ? 'waiting for your review' : m.invoices_ingested ? 'added to income' : m.duplicates ? 'already in the ledger' : r.status}`)
      } catch (e) { say(`${f.name}: ${(e as Error).message}`) }
    }
    setBusy(false); load()
  }

  const collect = async () => {
    setBusy(true); setLog(['Collecting from connected sources'])
    try {
      const r = await callNexus<{ results: { metrics: Record<string, number> }[] }>('expense-agent', { mode: 'collect' })
      const m = r.results[0]?.metrics ?? {}
      say(`${m.documents ?? 0} documents: ${m.route_book ?? 0} booked, ${(m.route_review ?? 0) + (m.needs_review ?? 0)} for review, ${m.duplicates ?? 0} already known, ${m.bank_matched ?? 0} bank payments matched`)
    } catch (e) { say((e as Error).message) }
    setBusy(false); load()
  }

  const yearRows = useMemo(() => (rows ?? []).filter((r) => r.date.startsWith(String(year))), [rows, year])
  const p = params.get(year)
  const totals = useMemo(() => p ? {
    deductible: yearRows.reduce((s, e) => s + deductibleEur(e, p), 0),
    vat: yearRows.reduce((s, e) => s + reclaimableVatEur(e), 0),
    pending: yearRows.filter((e) => e.status === 'needs_review').length,
  } : null, [yearRows, p])

  if (!rows) return <div className="flex justify-center p-12"><LoadingSpinner /></div>
  const input = 'rounded-lg bg-card border-line text-ink text-sm'

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Expenses</h1>
          <div className="lemon-rule" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted">The expense agent reads each document, classifies it and books it or asks you.</p>
        </div>
        <div className="flex gap-2">
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={input}>{[year - 1, year, year + 1].map((y) => <option key={y}>{y}</option>)}</select>
          <button disabled={busy} onClick={collect} className="rounded-lg border border-line text-ink text-sm px-3 py-2 flex items-center gap-2"><RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Collect now</button>
        </div>
      </div>

      <Card>
        <CardHeader title="Add receipts" subtitle="PDF or photo of receipts and supplier invoices. Invoices you sent are uploaded on Income & Tax or Time." />
        <div className="flex flex-wrap items-center gap-3">
          <label className={`rounded-lg bg-ink hover:bg-night-2 text-white text-sm px-4 py-2 flex items-center gap-2 cursor-pointer ${busy ? 'opacity-60 pointer-events-none' : ''}`}>
            <Upload size={14} /> Choose files
            <input type="file" multiple accept="application/pdf,image/*" className="hidden" onChange={(e) => onFiles(e.target.files)} />
          </label>
        </div>
        {log.length > 0 && <ul className="mt-4 space-y-1 text-sm text-body">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      </Card>

      {totals && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="glass p-5"><p className="text-xs uppercase tracking-wide text-muted">Deductible costs {year}</p><p className="mt-2 text-2xl font-semibold text-ink tabular-nums">{eur(totals.deductible)}</p><p className="text-xs text-muted mt-1">approved and booked only; assets via depreciation</p></div>
          <div className="glass p-5"><p className="text-xs uppercase tracking-wide text-muted">Reclaimable VAT {year}</p><p className="mt-2 text-2xl font-semibold text-ink tabular-nums">{eur(totals.vat)}</p></div>
          <div className="glass p-5"><p className="text-xs uppercase tracking-wide text-muted">Waiting for review</p><p className="mt-2 text-2xl font-semibold text-ink tabular-nums">{totals.pending}</p></div>
        </div>
      )}

      <Card>
        <CardHeader title="Ledger" subtitle={`${yearRows.length} expenses in ${year}`} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted border-b border-line">
              <tr><th className="py-2 pr-4">Date</th><th className="pr-4">Vendor</th><th className="pr-4">What</th><th className="pr-4">Treatment</th><th className="pr-4 text-right">Amount</th><th className="pr-4 text-right">Deductible</th><th>Status</th></tr>
            </thead>
            <tbody className="text-ink">
              {yearRows.map((e) => (
                <tr key={e.id} className="border-b border-line" title={e.rationale ?? ''}>
                  <td className="py-2 pr-4 tabular-nums">{e.date}</td>
                  <td className="pr-4">{e.vendor ?? '-'}</td>
                  <td className="pr-4 text-muted">{e.description ?? e.category}</td>
                  <td className="pr-4">{(e.treatment ?? 'unknown').replace(/_/g, ' ')}{e.business_use_pct < 1 ? ` (${Math.round(e.business_use_pct * 100)}%)` : ''}</td>
                  <td className="pr-4 text-right tabular-nums">{money(e.amount, e.currency)}</td>
                  <td className="pr-4 text-right tabular-nums">{p ? eur(deductibleEur(e, p)) : '-'}</td>
                  <td className={STATUS[e.status] ?? ''}>{e.status.replace(/_/g, ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
