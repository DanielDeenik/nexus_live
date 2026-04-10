import { useState } from 'react'
import { Plus, ChevronRight, AlertTriangle, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { Card, CardHeader, CardContent } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { useQuery, useMutation } from '../hooks/useApi'
import { formatCurrency } from '../lib/format'

type Stage = 'explore' | 'soft_commit' | 'hard_commit' | 'locked' | 'abandoned'

interface Commitment {
  id: string
  title: string
  commitmentType: string
  currentStage: Stage
  amount: number
  currency: string
  monthlyImpact?: number
  counterparty?: string
  updatedAt: string
}

interface PacingMetrics {
  totalCommitments: number
  byStage: Record<Stage, { count: number; total: number }>
  weightedRevenue: number
  hardCommitPctOfRevenue: number
  velocity: { advancements: number; abandonments: number; windowDays: number }
  staleAlerts: { commitmentId: string; stage: Stage; daysInStage: number }[]
}

interface GateRule {
  rule: string
  passed: boolean
  required: boolean
  message: string
}

interface GateResult {
  fromStage: Stage
  toStage: Stage
  passed: boolean
  rules: GateRule[]
  blockingFailures: GateRule[]
}

const STAGE_LABELS: Record<Stage, string> = {
  explore: 'Explore',
  soft_commit: 'Soft Commit',
  hard_commit: 'Hard Commit',
  locked: 'Locked',
  abandoned: 'Abandoned',
}

const STAGE_COLORS: Record<Stage, string> = {
  explore: 'bg-slate-700/50 border-slate-500/50 text-slate-200',
  soft_commit: 'bg-cyan-900/30 border-cyan-500/50 text-cyan-200',
  hard_commit: 'bg-amber-900/30 border-amber-500/50 text-amber-200',
  locked: 'bg-emerald-900/30 border-emerald-500/50 text-emerald-200',
  abandoned: 'bg-rose-900/30 border-rose-500/50 text-rose-200',
}

const NEXT_STAGE: Record<Stage, Stage | null> = {
  explore: 'soft_commit',
  soft_commit: 'hard_commit',
  hard_commit: 'locked',
  locked: null,
  abandoned: null,
}

const PIPELINE: Stage[] = ['explore', 'soft_commit', 'hard_commit', 'locked']

export function Commitments() {
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [selected, setSelected] = useState<Commitment | null>(null)
  const [gatePreview, setGatePreview] = useState<GateResult | null>(null)
  const [form, setForm] = useState({
    title: '',
    commitmentType: 'contract',
    amount: '',
    currency: 'EUR',
    monthlyImpact: '',
    counterparty: '',
  })

  const { data: list, isLoading: loadingList, refetch: refetchList } = useQuery<{ items: Commitment[] }>(
    '/v1/commitments',
    { refetchInterval: 60000 }
  )

  const { data: metricsResp, refetch: refetchMetrics } = useQuery<{ metrics: PacingMetrics }>(
    '/v1/commitments/pacing/metrics',
    { refetchInterval: 60000 }
  )

  const { mutate: create, isLoading: creating } = useMutation<{ commitment: Commitment }, any>(
    '/v1/commitments',
    'POST'
  )

  const evaluateGate = async (commitmentId: string, targetStage: Stage) => {
    const res = await fetch(`/api/v1/commitments/${commitmentId}/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}` },
      body: JSON.stringify({ targetStage }),
    })
    const data = (await res.json()) as { gate: GateResult }
    setGatePreview(data.gate)
  }

  const advanceStage = async (commitmentId: string, targetStage: Stage) => {
    await fetch(`/api/v1/commitments/${commitmentId}/advance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}` },
      body: JSON.stringify({ targetStage }),
    })
    setGatePreview(null)
    setSelected(null)
    refetchList()
    refetchMetrics()
  }

  const handleCreate = async () => {
    await create({
      title: form.title,
      commitmentType: form.commitmentType,
      amount: parseFloat(form.amount || '0'),
      currency: form.currency,
      monthlyImpact: form.monthlyImpact ? parseFloat(form.monthlyImpact) : undefined,
      counterparty: form.counterparty || undefined,
    })
    setIsCreateOpen(false)
    setForm({ title: '', commitmentType: 'contract', amount: '', currency: 'EUR', monthlyImpact: '', counterparty: '' })
    refetchList()
    refetchMetrics()
  }

  const items = list?.items ?? []
  const metrics = metricsResp?.metrics

  if (loadingList) return <div className="flex h-96 items-center justify-center"><LoadingSpinner /></div>

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">Commitment Pipeline</h1>
          <p className="text-sm text-slate-400">Stage every financial decision through reversibility gates</p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)}>
          <Plus size={16} className="mr-1" /> New Commitment
        </Button>
      </div>

      {metrics && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Card>
            <CardHeader>Total</CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-slate-50">{metrics.totalCommitments}</div>
              <div className="text-xs text-slate-400">commitments tracked</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>Weighted Revenue</CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-cyan-400">{formatCurrency(metrics.weightedRevenue, 'EUR')}</div>
              <div className="text-xs text-slate-400">stage-confidence weighted</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>Hard Commit Ratio</CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${metrics.hardCommitPctOfRevenue > 0.7 ? 'text-amber-400' : 'text-emerald-400'}`}>
                {(metrics.hardCommitPctOfRevenue * 100).toFixed(0)}%
              </div>
              <div className="text-xs text-slate-400">of annual revenue</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>Velocity ({metrics.velocity.windowDays}d)</CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-slate-50">
                <span className="text-emerald-400">{metrics.velocity.advancements}</span>
                <span className="mx-1 text-slate-500">/</span>
                <span className="text-rose-400">{metrics.velocity.abandonments}</span>
              </div>
              <div className="text-xs text-slate-400">advances / abandons</div>
            </CardContent>
          </Card>
        </div>
      )}

      {metrics && metrics.staleAlerts.length > 0 && (
        <Card>
          <CardHeader>
            <span className="flex items-center gap-2 text-amber-400">
              <AlertTriangle size={16} /> Stale Commitments
            </span>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm text-slate-300">
              {metrics.staleAlerts.map(a => (
                <li key={a.commitmentId} className="flex items-center justify-between">
                  <span>{items.find(i => i.id === a.commitmentId)?.title || a.commitmentId}</span>
                  <span className="text-amber-400">{a.daysInStage}d in {STAGE_LABELS[a.stage]}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {PIPELINE.map(stage => {
          const stageItems = items.filter(i => i.currentStage === stage)
          return (
            <div key={stage} className="space-y-3">
              <div className={`rounded-lg border px-3 py-2 text-sm font-semibold ${STAGE_COLORS[stage]}`}>
                {STAGE_LABELS[stage]} ({stageItems.length})
              </div>
              {stageItems.map(it => (
                <button
                  key={it.id}
                  onClick={() => { setSelected(it); setGatePreview(null) }}
                  className="w-full rounded-lg border border-slate-700/50 bg-slate-800/50 p-3 text-left transition hover:border-cyan-500/50"
                >
                  <div className="text-sm font-semibold text-slate-100">{it.title}</div>
                  <div className="mt-1 text-xs text-slate-400">{it.commitmentType}</div>
                  <div className="mt-2 text-sm text-cyan-400">{formatCurrency(it.amount, it.currency)}</div>
                  {it.counterparty && <div className="mt-1 text-xs text-slate-500">{it.counterparty}</div>}
                </button>
              ))}
              {stageItems.length === 0 && (
                <div className="rounded-lg border border-dashed border-slate-700/50 p-4 text-center text-xs text-slate-500">
                  No commitments
                </div>
              )}
            </div>
          )
        })}
      </div>

      {selected && (
        <Modal isOpen={true} onClose={() => { setSelected(null); setGatePreview(null) }} title={selected.title}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><span className="text-slate-500">Type:</span> <span className="text-slate-200">{selected.commitmentType}</span></div>
              <div><span className="text-slate-500">Stage:</span> <span className="text-slate-200">{STAGE_LABELS[selected.currentStage]}</span></div>
              <div><span className="text-slate-500">Amount:</span> <span className="text-slate-200">{formatCurrency(selected.amount, selected.currency)}</span></div>
              {selected.monthlyImpact != null && (
                <div><span className="text-slate-500">Monthly:</span> <span className="text-slate-200">{formatCurrency(selected.monthlyImpact, selected.currency)}</span></div>
              )}
              {selected.counterparty && (
                <div className="col-span-2"><span className="text-slate-500">Counterparty:</span> <span className="text-slate-200">{selected.counterparty}</span></div>
              )}
            </div>

            {NEXT_STAGE[selected.currentStage] && (
              <div className="space-y-3">
                <Button onClick={() => evaluateGate(selected.id, NEXT_STAGE[selected.currentStage]!)}>
                  Evaluate Gate → {STAGE_LABELS[NEXT_STAGE[selected.currentStage]!]}
                </Button>

                {gatePreview && (
                  <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-3">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                      {gatePreview.passed ? (
                        <><CheckCircle2 size={16} className="text-emerald-400" /> <span className="text-emerald-400">Gate ready</span></>
                      ) : (
                        <><XCircle size={16} className="text-rose-400" /> <span className="text-rose-400">Blocked</span></>
                      )}
                    </div>
                    <ul className="space-y-1 text-xs">
                      {gatePreview.rules.map(r => (
                        <li key={r.rule} className="flex items-start gap-2">
                          {r.passed ? (
                            <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0 text-emerald-400" />
                          ) : r.required ? (
                            <XCircle size={14} className="mt-0.5 flex-shrink-0 text-rose-400" />
                          ) : (
                            <Clock size={14} className="mt-0.5 flex-shrink-0 text-amber-400" />
                          )}
                          <span className="text-slate-300">{r.message}</span>
                        </li>
                      ))}
                    </ul>
                    {gatePreview.passed && (
                      <Button
                        className="mt-3 w-full"
                        onClick={() => advanceStage(selected.id, NEXT_STAGE[selected.currentStage]!)}
                      >
                        <ChevronRight size={14} className="mr-1" /> Advance to {STAGE_LABELS[NEXT_STAGE[selected.currentStage]!]}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {isCreateOpen && (
        <Modal isOpen={true} onClose={() => setIsCreateOpen(false)} title="New Commitment">
          <div className="space-y-3">
            <input
              className="w-full rounded-lg border border-slate-700/50 bg-slate-800/50 px-3 py-2 text-sm text-slate-100"
              placeholder="Title (e.g. Q3 contract with ACME)"
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            />
            <select
              className="w-full rounded-lg border border-slate-700/50 bg-slate-800/50 px-3 py-2 text-sm text-slate-100"
              value={form.commitmentType}
              onChange={e => setForm(f => ({ ...f, commitmentType: e.target.value }))}
            >
              {['contract', 'expense', 'investment', 'project', 'hire', 'subscription'].map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-3">
              <input
                className="rounded-lg border border-slate-700/50 bg-slate-800/50 px-3 py-2 text-sm text-slate-100"
                placeholder="Amount"
                type="number"
                value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              />
              <input
                className="rounded-lg border border-slate-700/50 bg-slate-800/50 px-3 py-2 text-sm text-slate-100"
                placeholder="Currency"
                value={form.currency}
                onChange={e => setForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))}
              />
            </div>
            <input
              className="w-full rounded-lg border border-slate-700/50 bg-slate-800/50 px-3 py-2 text-sm text-slate-100"
              placeholder="Monthly impact (optional)"
              type="number"
              value={form.monthlyImpact}
              onChange={e => setForm(f => ({ ...f, monthlyImpact: e.target.value }))}
            />
            <input
              className="w-full rounded-lg border border-slate-700/50 bg-slate-800/50 px-3 py-2 text-sm text-slate-100"
              placeholder="Counterparty (optional)"
              value={form.counterparty}
              onChange={e => setForm(f => ({ ...f, counterparty: e.target.value }))}
            />
            <Button onClick={handleCreate} disabled={creating || !form.title || !form.amount}>
              {creating ? 'Creating…' : 'Create in Explore'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
