import { useEffect, useState } from 'react'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import { Card, CardHeader } from '../../components/ui/Card'
import { supabase } from '../../lib/supabase'
import { callNexus } from '../../lib/nexus'

interface AgentRow { agent_id: string; display_name: string; llm_provider: string; llm_model: string; enabled: boolean }
interface Check { ok: boolean; ms?: number; error?: string; note?: string; usage?: { input_tokens: number; output_tokens: number }; answer?: Record<string, unknown> }

/** Which model each agent uses, with a check that sends one short test
 *  question through the agent's own model path. Nothing is saved. */
export function ModelsCard() {
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [checks, setChecks] = useState<Record<string, Check | 'busy'>>({})

  useEffect(() => {
    supabase.from('agent_configs').select('agent_id, display_name, llm_provider, llm_model, enabled').order('agent_id')
      .then(({ data }) => setAgents(((data ?? []) as AgentRow[]).filter((a) => a.llm_model !== 'none')))
  }, [])

  const check = async (id: string) => {
    setChecks((c) => ({ ...c, [id]: 'busy' }))
    try {
      const r = await callNexus<Check>('models', { agent_id: id })
      setChecks((c) => ({ ...c, [id]: r }))
    } catch (e) {
      setChecks((c) => ({ ...c, [id]: { ok: false, error: (e as Error).message } }))
    }
  }

  return (
    <Card>
      <CardHeader title="Models" subtitle="The model behind each agent. Test sends one short job advert through it; nothing is saved." />
      <div className="space-y-3">
        {agents.map((a) => {
          const c = checks[a.agent_id]
          return (
            <div key={a.agent_id} className="rounded-lg border border-slate-700/60 p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-100">{a.display_name}{!a.enabled && <span className="ml-2 text-xs text-slate-500">disabled</span>}</p>
                  <p className="text-xs text-slate-400 font-mono">{a.llm_provider} / {a.llm_model}</p>
                </div>
                <button onClick={() => check(a.agent_id)} disabled={c === 'busy'} className="rounded-lg border border-slate-600 text-slate-200 text-sm px-3 py-1.5 disabled:opacity-60">
                  {c === 'busy' ? 'Testing' : 'Test'}
                </button>
              </div>
              {c && c !== 'busy' && (
                <div className="mt-2 text-xs">
                  {c.ok ? (
                    <p className="text-success-400 flex items-center gap-1"><CheckCircle2 size={12} /> Answered in {((c.ms ?? 0) / 1000).toFixed(1)} s{c.usage ? `, ${c.usage.input_tokens} in and ${c.usage.output_tokens} out tokens` : ''}{c.note ? `. ${c.note}` : ''}</p>
                  ) : (
                    <p className="text-warning-300 flex items-center gap-1 break-words"><AlertTriangle size={12} /> {c.error}</p>
                  )}
                  {c.answer && <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-900 p-2 text-slate-300 whitespace-pre-wrap">{JSON.stringify(c.answer, null, 2)}</pre>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
