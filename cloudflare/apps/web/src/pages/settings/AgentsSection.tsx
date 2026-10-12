import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Link2, AlertTriangle } from 'lucide-react'
import { Card, CardHeader } from '../../components/ui/Card'
import { LoadingSpinner } from '../../components/ui/LoadingSpinner'
import { supabase } from '../../lib/supabase'
import { type Profile, callNexus, loadProfile, loadRegions } from '../../lib/nexus'
import { ModelsCard } from './ModelsCard'

interface Connection { provider: 'google' | 'wise'; status: string; account_label: string | null; last_error: string | null; settings: Record<string, unknown>; connected_at: string }
const input = 'rounded-lg bg-slate-900 border-slate-700 text-slate-100 text-sm'

/** Agents section of Settings: work calendar, Google and Wise. */
export function AgentsSection() {
  const [params] = useSearchParams()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [regions, setRegions] = useState<string[]>([])
  const [conns, setConns] = useState<Connection[]>([])
  const [msg, setMsg] = useState(params.get('connected') ? `Connected ${params.get('connected')}.` : params.get('integration_error') ? `Connection failed: ${params.get('integration_error')}` : '')
  const [wiseToken, setWiseToken] = useState('')
  const [folder, setFolder] = useState('')
  const navigate = useNavigate()
  const finishing = useRef(false)

  // Google sends the browser back here with code and state; the exchange
  // happens in an authenticated call so the grant lands on this account.
  useEffect(() => {
    const code = params.get('google_code'), state = params.get('google_state')
    if (!code || !state || finishing.current) return
    finishing.current = true
    callNexus('integrations', { action: 'google_finish', code, state })
      .then(() => setMsg('Google connected.'))
      .catch((e) => setMsg((e as Error).message))
      .finally(() => { navigate('/settings', { replace: true }); load() })
  }, [params])

  const load = useCallback(async () => {
    const [p, r, c] = await Promise.all([loadProfile(), loadRegions(), supabase.from('integration_connections').select('provider, status, account_label, last_error, settings, connected_at')])
    setProfile(p); setRegions(r); setConns((c.data ?? []) as Connection[])
    const g = (c.data ?? []).find((x) => x.provider === 'google')
    setFolder((g?.settings?.drive_folder_id as string) ?? '')
  }, [])
  useEffect(() => { load() }, [load])

  const saveProfile = async () => {
    if (!profile) return
    const { error } = await supabase.from('profiles').update({
      work_calendar_region: profile.work_calendar_region || null,
      standard_hours_per_day: profile.standard_hours_per_day,
      startersaftrek_eligible: profile.startersaftrek_eligible,
    }).eq('id', profile.id)
    setMsg(error ? error.message : 'Saved.')
  }

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg('')
    try { await fn(); setMsg(ok); load() } catch (e) { setMsg((e as Error).message) }
  }

  if (!profile) return <div id="agents" className="flex justify-center p-12"><LoadingSpinner /></div>
  const google = conns.find((c) => c.provider === 'google' && c.status === 'active')
  const wise = conns.find((c) => c.provider === 'wise' && c.status === 'active')

  return (
    <section id="agents" className="space-y-6 scroll-mt-20">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Agents</h2>
        <p className="text-sm text-slate-400">Your calendar for capacity forecasts, and the sources the expense agent reads.</p>
      </div>
      {msg && <p className="text-sm text-slate-300">{msg}</p>}

      <Card>
        <CardHeader title="Work calendar" subtitle="Holidays follow your client's region" />
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-400">Region
            <select value={profile.work_calendar_region ?? ''} onChange={(e) => setProfile({ ...profile, work_calendar_region: e.target.value || null })} className={`${input} block mt-1`}>
              <option value="">From latest invoice</option>
              {regions.map((r) => <option key={r}>{r}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-400">Standard hours per day
            <input type="number" min="1" max="24" step="0.5" value={profile.standard_hours_per_day ?? ''} onChange={(e) => setProfile({ ...profile, standard_hours_per_day: e.target.value ? Number(e.target.value) : null })} className={`${input} block w-28 mt-1`} />
          </label>
          <label className="text-xs text-slate-300 flex items-center gap-2 pb-2">
            <input type="checkbox" checked={profile.startersaftrek_eligible} onChange={(e) => setProfile({ ...profile, startersaftrek_eligible: e.target.checked })} className="rounded bg-slate-900 border-slate-600" />
            Startersaftrek applies this year
          </label>
          <button onClick={saveProfile} className="rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm px-4 py-2">Save</button>
        </div>
      </Card>

      <ModelsCard />

      <Card>
        <CardHeader title="Google (Gmail and Drive)" subtitle="Read-only. Finds invoices and receipts in your inbox and one Drive folder." action={google ? <span className="text-xs text-success-400 flex items-center gap-1"><CheckCircle2 size={12} /> connected</span> : null} />
        {google?.last_error && <p className="text-sm text-warning-300 flex items-center gap-2 mb-3"><AlertTriangle size={14} /> Last run: {google.last_error}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => run(async () => { const r = await callNexus<{ url: string }>('integrations', { action: 'google_start' }); window.location.href = r.url }, '')} className="rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm px-4 py-2 flex items-center gap-2"><Link2 size={14} /> {google ? 'Reconnect' : 'Connect Google'}</button>
          {google && <button onClick={() => run(() => callNexus('integrations', { action: 'disconnect', provider: 'google' }), 'Google disconnected.')} className="text-sm text-slate-400 underline">Disconnect</button>}
        </div>
        {google && (
          <div className="flex flex-wrap items-end gap-2 mt-4">
            <label className="text-xs text-slate-400 flex-1">Drive receipts folder id (the part after /folders/ in its URL)
              <input value={folder} onChange={(e) => setFolder(e.target.value)} className={`${input} block w-full mt-1`} />
            </label>
            <button onClick={() => run(() => callNexus('integrations', { action: 'google_settings', drive_folder_id: folder }), 'Drive folder saved.')} className="rounded-lg border border-slate-600 text-slate-200 text-sm px-3 py-2">Save folder</button>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Wise" subtitle="Read-only token. Card payments are matched to receipts; unmatched ones ask for evidence." action={wise ? <span className="text-xs text-success-400 flex items-center gap-1"><CheckCircle2 size={12} /> {wise.account_label}</span> : null} />
        {wise?.last_error && <p className="text-sm text-warning-300 flex items-center gap-2 mb-3"><AlertTriangle size={14} /> Last run: {wise.last_error}</p>}
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-400 flex-1">Personal API token (read only)
            <input type="password" value={wiseToken} onChange={(e) => setWiseToken(e.target.value)} className={`${input} block w-full mt-1`} autoComplete="off" />
          </label>
          <button onClick={() => run(async () => { await callNexus('integrations', { action: 'wise_connect', token: wiseToken }); setWiseToken('') }, 'Wise connected.')} className="rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm px-4 py-2">{wise ? 'Replace token' : 'Connect Wise'}</button>
        </div>
        <p className="text-xs text-slate-500 mt-2">Tokens are stored encrypted in Supabase Vault and never returned to the browser.</p>
      </Card>
    </section>
  )
}
