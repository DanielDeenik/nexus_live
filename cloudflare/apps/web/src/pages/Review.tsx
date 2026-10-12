import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, FileText, XCircle } from 'lucide-react'
import { Card } from '../components/ui/Card'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { supabase } from '../lib/supabase'
import { REASON_TEXT, type ReasonCode } from '@fiscal'
import { type ReviewItem, callNexus, evidenceUrl } from '../lib/nexus'

const TREATMENTS = [
  ['fully_deductible', 'Fully deductible'],
  ['limited_deductible', 'Limited (80% rule)'],
  ['asset', 'Asset (depreciate)'],
  ['private', 'Private, not deductible'],
] as const

const reasonText = (c: string) => REASON_TEXT[c as ReasonCode] ?? c.replace(/_/g, ' ')
const input = 'rounded-lg bg-slate-900 border-slate-700 text-slate-100 text-sm'

function Evidence({ expenseId }: { expenseId?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!expenseId) return
    supabase.from('expenses').select('evidence_path').eq('id', expenseId).single().then(async ({ data }) => {
      if (data?.evidence_path) setUrl(await evidenceUrl(data.evidence_path))
    })
  }, [expenseId])
  return url ? <a href={url} target="_blank" rel="noreferrer" className="text-xs text-sky-400 flex items-center gap-1"><FileText size={12} /> View receipt</a> : null
}

function ExpenseDecision({ item, onDone }: { item: ReviewItem; onDone: () => void }) {
  const p = item.proposed as { treatment?: string; business_use_pct?: number; useful_life_years?: number | null; rationale?: string; expense_id?: string }
  const isAsset = item.item_type === 'asset'
  const [treatment, setTreatment] = useState(p.treatment === 'unknown' ? 'fully_deductible' : p.treatment ?? 'fully_deductible')
  const [use, setUse] = useState(Math.round((p.business_use_pct ?? 1) * 100))
  const [life, setLife] = useState(p.useful_life_years ?? '')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const decide = async (action: 'approve' | 'edit' | 'reject') => {
    setBusy(true); setErr('')
    try {
      const edits = isAsset
        ? action === 'reject' ? { treatment } : { useful_life_years: Number(life) }
        : { treatment, business_use_pct: use / 100 }
      const changed = isAsset ? Number(life) !== p.useful_life_years : treatment !== p.treatment || use / 100 !== (p.business_use_pct ?? 1)
      await callNexus('review-decide', { review_item_id: item.id, action: action === 'approve' && changed ? 'edit' : action, edits, remember })
      onDone()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      {p.rationale && <p className="text-sm text-slate-300">Agent: {p.rationale}</p>}
      <Evidence expenseId={isAsset ? p.expense_id : item.item_id ?? undefined} />
      <div className="flex flex-wrap items-end gap-3">
        {isAsset ? (
          <label className="text-xs text-slate-400">Useful life (years)
            <input type="number" min="1" step="0.5" value={life} onChange={(e) => setLife(e.target.value)} className={`${input} block w-28 mt-1`} />
          </label>
        ) : (
          <>
            <label className="text-xs text-slate-400">Treatment
              <select value={treatment} onChange={(e) => setTreatment(e.target.value)} className={`${input} block mt-1`}>
                {TREATMENTS.filter(([k]) => k !== 'asset').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="text-xs text-slate-400">Business use %
              <input type="number" min="0" max="100" value={use} onChange={(e) => setUse(Number(e.target.value))} className={`${input} block w-24 mt-1`} />
            </label>
            <label className="text-xs text-slate-300 flex items-center gap-2 pb-2">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="rounded bg-slate-900 border-slate-600" />
              Remember for this vendor
            </label>
          </>
        )}
      </div>
      {isAsset && (
        <label className="text-xs text-slate-400 block">If this is not an asset, expense it as
          <select value={treatment} onChange={(e) => setTreatment(e.target.value)} className={`${input} block mt-1`}>
            {TREATMENTS.filter(([k]) => k !== 'asset').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      )}
      <div className="flex gap-2">
        <button disabled={busy} onClick={() => decide('approve')} className="rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm px-4 py-2 flex items-center gap-2"><CheckCircle2 size={14} /> {isAsset ? 'Confirm asset' : 'Approve'}</button>
        <button disabled={busy} onClick={() => decide('reject')} className="rounded-lg border border-slate-600 text-slate-300 text-sm px-4 py-2 flex items-center gap-2"><XCircle size={14} /> {isAsset ? 'Not an asset' : 'Reject'}</button>
      </div>
      {err && <p className="text-sm text-danger-400">{err}</p>}
    </div>
  )
}

function FilingDecision({ item, onDone }: { item: ReviewItem; onDone: () => void }) {
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [warnings, setWarnings] = useState<{ severity: string; message: string }[]>([])
  useEffect(() => {
    if (item.item_id) supabase.from('tax_filings').select('warnings').eq('id', item.item_id).single().then(({ data }) => setWarnings(data?.warnings ?? []))
  }, [item.item_id])
  const blocks = warnings.filter((w) => w.severity === 'block')
  const decide = async (action: 'approve' | 'reject') => {
    setBusy(true); setErr('')
    try { await callNexus('review-decide', { review_item_id: item.id, action, acknowledge_blocking: ack }); onDone() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-3">
      <ul className="space-y-1">
        {warnings.map((w, i) => (
          <li key={i} className={`text-sm ${w.severity === 'block' ? 'text-danger-400' : w.severity === 'warn' ? 'text-warning-300' : 'text-slate-400'}`}>
            {w.severity === 'block' ? 'Blocking: ' : w.severity === 'warn' ? 'Warning: ' : ''}{w.message}
          </li>
        ))}
      </ul>
      {blocks.length > 0 && (
        <label className="text-xs text-slate-300 flex items-center gap-2">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="rounded bg-slate-900 border-slate-600" />
          I have checked the {blocks.length} blocking item(s) and accept the draft anyway
        </label>
      )}
      <p className="text-xs text-slate-400">Approving records your sign-off. Filing with the Belastingdienst stays with you; mark it filed on the Tax page afterwards.</p>
      <div className="flex gap-2">
        <button disabled={busy} onClick={() => decide('approve')} className="rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm px-4 py-2">Approve draft</button>
        <button disabled={busy} onClick={() => decide('reject')} className="rounded-lg border border-slate-600 text-slate-300 text-sm px-4 py-2">Discard draft</button>
      </div>
      {err && <p className="text-sm text-danger-400">{err}</p>}
    </div>
  )
}

function InvoiceDecision({ item, onDone }: { item: ReviewItem; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const decide = async (voidThis: boolean) => {
    setBusy(true); setErr('')
    try {
      await callNexus('review-decide', { review_item_id: item.id, action: voidThis ? 'edit' : 'approve', edits: voidThis ? { void_invoice_ids: [item.item_id], void_reason: 'duplicate' } : {} })
      onDone()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="flex gap-2">
      <button disabled={busy} onClick={() => decide(false)} className="rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm px-4 py-2">Figures are correct</button>
      <button disabled={busy} onClick={() => decide(true)} className="rounded-lg border border-slate-600 text-slate-300 text-sm px-4 py-2">Void this invoice</button>
      {err && <p className="text-sm text-danger-400">{err}</p>}
    </div>
  )
}

export function Review() {
  const [items, setItems] = useState<ReviewItem[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.from('review_items').select('*').eq('status', 'open').order('created_at')
      if (error) throw error
      setItems(data as ReviewItem[])
    } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { load() }, [load])

  if (error) return <Card><p className="text-sm text-danger-400">{error}</p></Card>
  if (!items) return <div className="flex justify-center p-12"><LoadingSpinner /></div>

  const label = { expense: 'Expense', asset: 'Asset', filing: 'Tax draft', invoice_anomaly: 'Invoice' }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-50">Review</h1>
        <p className="text-sm text-slate-400">The agents stop here. Nothing below counts toward a filing until you decide.</p>
      </div>
      {items.length === 0 && <Card><p className="text-sm text-success-400 flex items-center gap-2"><CheckCircle2 size={14} /> Nothing waiting.</p></Card>}
      {items.map((item) => (
        <Card key={item.id}>
          <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">{label[item.item_type]}</p>
              <p className="text-base font-medium text-slate-50">{item.summary}</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {item.reason_codes.map((c) => <span key={c} className="text-xs rounded-full border border-warning-500/40 text-warning-300 px-2 py-0.5">{reasonText(c)}</span>)}
            </div>
          </div>
          {(item.item_type === 'expense' || item.item_type === 'asset') && <ExpenseDecision item={item} onDone={load} />}
          {item.item_type === 'filing' && <FilingDecision item={item} onDone={load} />}
          {item.item_type === 'invoice_anomaly' && <InvoiceDecision item={item} onDone={load} />}
        </Card>
      ))}
      <p className="text-xs text-slate-500">Amounts in EUR use the ECB reference rate on the document date.</p>
    </div>
  )
}
