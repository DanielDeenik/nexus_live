import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, FileText, XCircle } from 'lucide-react'
import { Card } from '../components/ui/Card'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { supabase } from '../lib/supabase'
import { REASON_TEXT, type ReasonCode } from '@fiscal'
import { type ReviewItem, callNexus, evidenceUrl } from '../lib/nexus'
import { eur2 } from '../lib/look'

const TREATMENTS = [
  ['fully_deductible', 'Fully deductible'],
  ['limited_deductible', 'Limited (80% rule)'],
  ['asset', 'Asset (depreciate)'],
  ['private', 'Private, not deductible'],
] as const

const reasonText = (c: string) => REASON_TEXT[c as ReasonCode] ?? c.replace(/_/g, ' ')
const input = 'rounded-lg bg-card border-line text-ink text-sm'

function Evidence({ expenseId }: { expenseId?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!expenseId) return
    supabase.from('expenses').select('evidence_path').eq('id', expenseId).single().then(async ({ data }) => {
      if (data?.evidence_path) setUrl(await evidenceUrl(data.evidence_path))
    })
  }, [expenseId])
  return url ? <a href={url} target="_blank" rel="noreferrer" className="text-xs text-lemon-ink flex items-center gap-1"><FileText size={12} /> View receipt</a> : null
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
      {p.rationale && <p className="text-sm text-body">Agent: {p.rationale}</p>}
      <Evidence expenseId={isAsset ? p.expense_id : item.item_id ?? undefined} />
      <div className="flex flex-wrap items-end gap-3">
        {isAsset ? (
          <label className="text-xs text-muted">Useful life (years)
            <input type="number" min="1" step="0.5" value={life} onChange={(e) => setLife(e.target.value)} className={`${input} block w-28 mt-1`} />
          </label>
        ) : (
          <>
            <label className="text-xs text-muted">Treatment
              <select value={treatment} onChange={(e) => setTreatment(e.target.value)} className={`${input} block mt-1`}>
                {TREATMENTS.filter(([k]) => k !== 'asset').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="text-xs text-muted">Business use %
              <input type="number" min="0" max="100" value={use} onChange={(e) => setUse(Number(e.target.value))} className={`${input} block w-24 mt-1`} />
            </label>
            <label className="text-xs text-body flex items-center gap-2 pb-2">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="rounded bg-card border-line" />
              Remember for this vendor
            </label>
          </>
        )}
      </div>
      {isAsset && (
        <label className="text-xs text-muted block">If this is not an asset, expense it as
          <select value={treatment} onChange={(e) => setTreatment(e.target.value)} className={`${input} block mt-1`}>
            {TREATMENTS.filter(([k]) => k !== 'asset').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      )}
      <div className="flex gap-2">
        <button disabled={busy} onClick={() => decide('approve')} className="rounded-lg bg-ink hover:bg-night-2 text-white text-sm px-4 py-2 flex items-center gap-2"><CheckCircle2 size={14} /> {isAsset ? 'Confirm asset' : 'Approve'}</button>
        <button disabled={busy} onClick={() => decide('reject')} className="rounded-lg border border-line text-body text-sm px-4 py-2 flex items-center gap-2"><XCircle size={14} /> {isAsset ? 'Not an asset' : 'Reject'}</button>
      </div>
      {err && <p className="text-sm text-bad">{err}</p>}
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
  const change = (item.proposed as { change?: boolean }).change === true
  const blocks = change ? [] : warnings.filter((w) => w.severity === 'block')
  const decide = async (action: 'approve' | 'reject') => {
    setBusy(true); setErr('')
    try { await callNexus('review-decide', { review_item_id: item.id, action, acknowledge_blocking: ack }); onDone() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-3">
      <ul className="space-y-1">
        {warnings.map((w, i) => (
          <li key={i} className={`text-sm ${w.severity === 'block' ? 'text-bad' : w.severity === 'warn' ? 'text-lemon-ink' : 'text-muted'}`}>
            {w.severity === 'block' ? 'Blocking: ' : w.severity === 'warn' ? 'Warning: ' : ''}{w.message}
          </li>
        ))}
      </ul>
      {blocks.length > 0 && (
        <label className="text-xs text-body flex items-center gap-2">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="rounded bg-card border-line" />
          I have checked the {blocks.length} blocking item(s) and accept the draft anyway
        </label>
      )}
      <p className="text-xs text-muted">
        {change
          ? 'Your approved or filed draft stays untouched. Accepting creates a new draft (or a correction draft for a filed period) for you to review.'
          : 'Approving records your sign-off. Filing with the Belastingdienst stays with you; mark it filed on the Tax page afterwards.'}
      </p>
      <div className="flex gap-2">
        <button disabled={busy} onClick={() => decide('approve')} className="rounded-lg bg-ink hover:bg-night-2 text-white text-sm px-4 py-2">{change ? 'Create updated draft' : 'Approve draft'}</button>
        <button disabled={busy} onClick={() => decide('reject')} className="rounded-lg border border-line text-body text-sm px-4 py-2">{change ? 'Keep as is' : 'Discard draft'}</button>
      </div>
      {err && <p className="text-sm text-bad">{err}</p>}
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
      <button disabled={busy} onClick={() => decide(false)} className="rounded-lg bg-ink hover:bg-night-2 text-white text-sm px-4 py-2">Figures are correct</button>
      <button disabled={busy} onClick={() => decide(true)} className="rounded-lg border border-line text-body text-sm px-4 py-2">Void this invoice</button>
      {err && <p className="text-sm text-bad">{err}</p>}
    </div>
  )
}

interface TagChoice { key: string; label: string; values: { value: string; label: string }[] }
interface TagLine { id: string; booked_on: string; amount: number; currency: string; merchant: string | null; payee: string | null; category: string; nx_line_tags: { dimension: string; value: string }[] }

const shopOf = (l: TagLine) => l.merchant ?? l.payee ?? 'Unknown shop'

/** Spending of this month in the planned classes that has no tag yet in one dimension: pick the
 *  lines, pick a value, tag them in one go. "Always for these shops" puts it on each shop's rule. */
function LineTags() {
  const [choices, setChoices] = useState<TagChoice[]>([])
  const [lines, setLines] = useState<TagLine[] | null>(null)
  const [dimension, setDimension] = useState('')
  const [value, setValue] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [always, setAlways] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const { data: c, error: ce } = await supabase.rpc('nx_tag_choices')
      if (ce) throw ce
      const { data: cfg, error: fe } = await supabase.from('app_config').select('value').eq('key', 'budget.planned_classes').single()
      if (fe) throw fe
      const now = new Date()
      const since = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)).toISOString().slice(0, 10)
      const { data, error } = await supabase.from('nx_transactions')
        .select('id,booked_on,amount,currency,merchant,payee,category,nx_line_tags(dimension,value)')
        .lt('amount', 0).gte('booked_on', since).in('class', JSON.parse(cfg.value) as string[])
        .order('booked_on', { ascending: false })
      if (error) throw error
      setChoices(c as TagChoice[])
      setDimension((d) => d || (c as TagChoice[])[0]?.key || '')
      setLines(data as TagLine[])
      setPicked(new Set())
    } catch (e) { setErr((e as Error).message) }
  }, [])
  useEffect(() => { load() }, [load])

  if (err && !lines) return <Card><p className="text-sm text-bad">{err}</p></Card>
  if (!lines || choices.length === 0) return null
  const choice = choices.find((c) => c.key === dimension)
  const open = lines.filter((l) => !l.nx_line_tags.some((t) => t.dimension === dimension))
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const save = async () => {
    setBusy(true); setErr('')
    try {
      const chosen = open.filter((l) => picked.has(l.id))
      const byShop = new Map<string, string[]>()
      for (const l of chosen) byShop.set(shopOf(l), [...(byShop.get(shopOf(l)) ?? []), l.id])
      // One call per shop with Always, since the rule belongs to a shop; one call for all without.
      const groups = always ? [...byShop.values()] : [chosen.map((l) => l.id)]
      for (const ids of groups) {
        const { error } = await supabase.rpc('nx_set_line_tags', { p_txns: ids, p_dimension: dimension, p_value: value, p_always: always })
        if (error) throw error
      }
      setValue('')
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Bank lines</p>
          <p className="text-base font-medium text-ink">{open.length} {open.length === 1 ? 'line' : 'lines'} this month without {choice?.label ?? 'a tag'}</p>
        </div>
        <label className="text-xs text-muted">Tag
          <select value={dimension} onChange={(e) => { setDimension(e.target.value); setValue(''); setPicked(new Set()) }} className={`${input} block mt-1`}>
            {choices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
      </div>
      {open.length > 0 && (
        <>
          <ul className="divide-y divide-line mb-3">
            {open.map((l) => (
              <li key={l.id} className="flex items-center gap-3 py-2 text-sm">
                <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} className="rounded bg-card border-line" />
                <span className="flex-1 text-ink">{shopOf(l)} <span className="text-muted">· {l.booked_on} · {l.category}</span></span>
                <span className="tabular-nums text-ink">{eur2(-l.amount)}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-muted">{choice?.label}
              <select value={value} onChange={(e) => setValue(e.target.value)} className={`${input} block mt-1`}>
                <option value="">Pick one</option>
                {choice?.values.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
            </label>
            <label className="text-xs text-body flex items-center gap-2 pb-2">
              <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} className="rounded bg-card border-line" />
              Always for these shops
            </label>
            <button disabled={busy || !value || picked.size === 0} onClick={save} className="rounded-lg bg-ink hover:bg-night-2 disabled:opacity-50 text-white text-sm px-4 py-2">
              Tag {picked.size} {picked.size === 1 ? 'line' : 'lines'}
            </button>
          </div>
        </>
      )}
      {err && <p className="text-sm text-bad mt-2">{err}</p>}
    </Card>
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

  if (error) return <Card><p className="text-sm text-bad">{error}</p></Card>
  if (!items) return <div className="flex justify-center p-12"><LoadingSpinner /></div>

  const label = { expense: 'Expense', asset: 'Asset', filing: 'Tax draft', invoice_anomaly: 'Invoice' }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">Review</h1>
        <div className="lemon-rule" aria-hidden="true" />
        <p className="mt-3 text-sm text-muted">The agents stop here. Nothing below counts toward a filing until you decide.</p>
      </div>
      <LineTags />
      {items.length === 0 && <Card><p className="text-sm text-good flex items-center gap-2"><CheckCircle2 size={14} /> Nothing waiting.</p></Card>}
      {items.map((item) => (
        <Card key={item.id}>
          <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">{label[item.item_type]}</p>
              <p className="text-base font-medium text-ink">{item.summary}</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {item.reason_codes.map((c) => <span key={c} className="text-xs rounded-full border border-lemon text-lemon-ink px-2 py-0.5">{reasonText(c)}</span>)}
            </div>
          </div>
          {(item.item_type === 'expense' || item.item_type === 'asset') && <ExpenseDecision item={item} onDone={load} />}
          {item.item_type === 'filing' && <FilingDecision item={item} onDone={load} />}
          {item.item_type === 'invoice_anomaly' && <InvoiceDecision item={item} onDone={load} />}
        </Card>
      ))}
      <p className="text-xs text-muted">Amounts in EUR use the ECB reference rate on the document date.</p>
    </div>
  )
}
