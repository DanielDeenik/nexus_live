import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { type TaxFiling, callNexus, eur, hrs, loadFilings } from '../lib/nexus'

const STATUS: Record<TaxFiling['status'], string> = {
  needs_review: 'text-warning-400', approved: 'text-sky-400', filed: 'text-success-400', superseded: 'text-slate-500',
}

function VatFigures({ f }: { f: Record<string, unknown> }) {
  const boxes = (f.boxes ?? {}) as Record<string, { base_eur: number; vat_eur: number; items: number }>
  return (
    <table className="w-full text-sm mt-2">
      <thead className="text-left text-slate-400"><tr><th className="py-1">Box</th><th className="text-right">Base</th><th className="text-right">VAT</th></tr></thead>
      <tbody className="text-slate-200">
        {Object.entries(boxes).sort().map(([k, b]) => <tr key={k}><td className="py-1 font-mono">{k}</td><td className="text-right tabular-nums">{eur(b.base_eur)}</td><td className="text-right tabular-nums">{eur(b.vat_eur)}</td></tr>)}
        <tr className="border-t border-slate-700/50"><td className="py-1 font-mono">5b</td><td /><td className="text-right tabular-nums">{eur(Number(f.input_vat_5b ?? 0))}</td></tr>
        <tr><td className="py-1 font-semibold">5g payable</td><td /><td className="text-right tabular-nums font-semibold">{eur(Number(f.payable_5g ?? 0))}</td></tr>
      </tbody>
    </table>
  )
}

function IncomeFigures({ f }: { f: Record<string, unknown> }) {
  const ytd = f.ytd as Record<string, number> | undefined
  const proj = (f.projection as { estimate: Record<string, number>; revenue_eur: number } | null) ?? null
  const ledger = f.ledger as { billed_hours: number; non_billable_hours: number; revenue_eur: number } | undefined
  const rows: [string, number | undefined, number | undefined][] = [
    ['Revenue', ledger?.revenue_eur, proj?.revenue_eur],
    ['Profit', ytd?.profit, proj?.estimate.profit],
    ['Zelfstandigenaftrek', ytd?.zelfstandigenaftrek, proj?.estimate.zelfstandigenaftrek],
    ['MKB-winstvrijstelling', ytd?.mkb_winstvrijstelling, proj?.estimate.mkb_winstvrijstelling],
    ['Taxable profit', ytd?.taxable_profit, proj?.estimate.taxable_profit],
    ['Income tax after credits', ytd?.income_tax, proj?.estimate.income_tax],
    ['Zvw', ytd?.zvw, proj?.estimate.zvw],
    ['Total due', ytd?.total_due, proj?.estimate.total_due],
  ]
  return (
    <>
      <table className="w-full text-sm mt-2">
        <thead className="text-left text-slate-400"><tr><th className="py-1" /><th className="text-right">Year to date</th><th className="text-right">Projected</th></tr></thead>
        <tbody className="text-slate-200">
          {rows.map(([l, a, b]) => <tr key={l}><td className="py-1">{l}</td><td className="text-right tabular-nums">{a != null ? eur(a) : '-'}</td><td className="text-right tabular-nums">{b != null ? eur(b) : '-'}</td></tr>)}
        </tbody>
      </table>
      <p className="text-xs text-slate-400 mt-2">
        {ledger ? `${hrs(ledger.billed_hours + ledger.non_billable_hours)} hours logged. ` : ''}
        Reserve target {eur(Number(f.reserve_target_eur ?? 0))}.
      </p>
    </>
  )
}

function MarkFiled({ f, onDone }: { f: TaxFiling; onDone: () => void }) {
  const [ref, setRef] = useState('')
  const [err, setErr] = useState('')
  const save = async () => {
    setErr('')
    try { await callNexus('review-decide', { action: 'mark_filed', filing_id: f.id, filed_reference: ref }); onDone() }
    catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 mt-3">
      <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Belastingdienst reference" className="rounded-lg bg-slate-900 border-slate-700 text-slate-100 text-sm" />
      <button onClick={save} className="rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm px-3 py-2">I filed this</button>
      {err && <span className="text-sm text-danger-400">{err}</span>}
    </div>
  )
}

export function TaxFilings() {
  const [filings, setFilings] = useState<TaxFiling[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const load = useCallback(async () => setFilings(await loadFilings()), [])
  useEffect(() => { load() }, [load])

  const refresh = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await callNexus<{ results: { metrics: Record<string, number> }[] }>('tax-agent', {})
      const m = r.results[0]?.metrics ?? {}
      setMsg(`${m.drafts_created ?? 0} new draft(s), ${m.drafts_unchanged ?? 0} unchanged${m.changed_after_approval ? `, ${m.changed_after_approval} changed after approval (see Review)` : ''}.`)
    } catch (e) { setMsg((e as Error).message) }
    setBusy(false); load()
  }

  if (!filings) return <div className="flex justify-center p-12"><LoadingSpinner /></div>
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">Tax filings</h1>
          <p className="text-sm text-slate-400">Drafts computed from your approved books. You approve, then file with the Belastingdienst yourself.</p>
        </div>
        <button disabled={busy} onClick={refresh} className="rounded-lg border border-slate-600 text-slate-200 text-sm px-3 py-2 flex items-center gap-2"><RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Recompute drafts</button>
      </div>
      {msg && <p className="text-sm text-slate-300">{msg}</p>}
      {filings.length === 0 && <Card><p className="text-sm text-slate-400">No drafts yet. Recompute to create this quarter's VAT and this year's income tax drafts.</p></Card>}
      <div className="grid gap-6 xl:grid-cols-2">
        {filings.map((f) => (
          <Card key={f.id}>
            <CardHeader
              title={`${f.period_label} ${f.kind === 'vat_quarter' ? 'VAT return' : 'Income tax'}`}
              subtitle={`${f.period_start} to ${f.period_end}`}
              action={<span className={`text-xs ${STATUS[f.status]}`}>{f.status.replace(/_/g, ' ')}{f.filed_reference ? ` (${f.filed_reference})` : ''}</span>}
            />
            {f.kind === 'vat_quarter' ? <VatFigures f={f.figures} /> : <IncomeFigures f={f.figures} />}
            {f.warnings.length > 0 && (
              <ul className="mt-3 space-y-1">
                {f.warnings.map((w, i) => <li key={i} className={`text-xs ${w.severity === 'block' ? 'text-danger-400' : w.severity === 'warn' ? 'text-warning-300' : 'text-slate-400'}`}>{w.message}</li>)}
              </ul>
            )}
            {f.status === 'approved' && <MarkFiled f={f} onDone={load} />}
          </Card>
        ))}
      </div>
    </div>
  )
}
