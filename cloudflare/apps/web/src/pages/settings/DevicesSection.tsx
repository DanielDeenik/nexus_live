import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, KeyRound } from 'lucide-react'
import { Card, CardHeader } from '../../components/ui/Card'
import { ErrorNote, Field, btnGhost, btnPrimary, input, td, th } from '../../components/time/ui'
import { type DeviceToken, createDeviceToken, ingestUrl, listDeviceTokens, revokeDeviceToken } from '../../lib/time'

const when = (s: string | null) => (s ? new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-')

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) } catch { setDone(false) }
  }
  return (
    <button type="button" onClick={copy} className={`${btnGhost} shrink-0`} aria-label={label}>
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? 'Copied' : 'Copy'}
    </button>
  )
}

// Relay pushes confirmed time with a device token. The token is shown once;
// only its hash is stored.
export function DevicesSection() {
  const [rows, setRows] = useState<DeviceToken[] | null>(null)
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const address = ingestUrl()

  const load = useCallback(() => {
    listDeviceTokens().then(setRows).catch((e) => setError((e as Error).message))
  }, [])
  useEffect(() => { load() }, [load])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try { setFresh(await createDeviceToken(name)); setName(''); load() } catch (x) { setError((x as Error).message) } finally { setBusy(false) }
  }

  const revoke = async (t: DeviceToken) => {
    if (!window.confirm(`Revoke ${t.name}? That device can no longer push.`)) return
    setError('')
    try { await revokeDeviceToken(t.id); load() } catch (x) { setError((x as Error).message) }
  }

  return (
    <section id="devices" className="space-y-6 scroll-mt-20">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Devices</h2>
        <p className="text-sm text-slate-400">Connect Relay so confirmed time lands here.</p>
      </div>

      <Card className="p-4 sm:p-6">
        <CardHeader title="Connect Relay" />
        <p className="text-sm text-slate-300 mb-4">
          Make a token for the Mac that runs Relay, then paste the token and the address below into Relay, Settings, DTrack. Relay only sends time you confirmed there.
        </p>
        <form onSubmit={create} className="flex flex-wrap items-end gap-2 mb-4">
          <Field label="Device name" className="flex-1 min-w-[10rem]">
            <input required value={name} onChange={(e) => setName(e.target.value)} className={`${input} w-full`} />
          </Field>
          <button disabled={busy || !name.trim()} className={btnPrimary}><KeyRound size={14} /> Make token</button>
        </form>

        {fresh && (
          <div className="mb-4 rounded-lg border border-warning-500/40 bg-warning-500/10 p-3">
            <p className="text-sm text-warning-200 mb-2">Copy this token now. It will not be shown again.</p>
            <div className="flex items-start gap-2">
              <code className="flex-1 min-w-0 break-all rounded bg-slate-950/60 px-2 py-1.5 text-xs text-slate-100">{fresh}</code>
              <CopyButton text={fresh} label="Copy token" />
            </div>
          </div>
        )}

        <p className="text-xs text-slate-400 mb-1">Address</p>
        <div className="flex items-start gap-2">
          <code className="flex-1 min-w-0 break-all rounded bg-slate-950/60 px-2 py-1.5 text-xs text-slate-200">{address}</code>
          <CopyButton text={address} label="Copy address" />
        </div>
        <div className="mt-3"><ErrorNote message={error} /></div>
      </Card>

      <Card className="p-4 sm:p-6">
        <CardHeader title="Tokens" />
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-400 border-b border-slate-700/50">
              <tr><th className={th}>Device</th><th className={th}>Made</th><th className={th}>Last push</th><th className={th}><span className="sr-only">Status</span></th></tr>
            </thead>
            <tbody className="text-slate-200">
              {rows?.map((t) => (
                <tr key={t.id} className="border-b border-slate-800/60">
                  <td className={`${td} whitespace-nowrap`}>{t.name}</td>
                  <td className={`${td} whitespace-nowrap text-slate-300`}>{when(t.created_at)}</td>
                  <td className={`${td} whitespace-nowrap text-slate-300`}>{when(t.last_used_at)}</td>
                  <td className={`${td} whitespace-nowrap text-right`}>
                    {t.revoked_at
                      ? <span className="text-xs text-slate-500">Revoked {when(t.revoked_at)}</span>
                      : <button onClick={() => revoke(t)} className="rounded-lg border border-danger-500/40 text-danger-300 hover:bg-danger-500/10 text-xs px-2.5 py-1">Revoke</button>}
                  </td>
                </tr>
              ))}
              {rows && rows.length === 0 && <tr><td className={`${td} text-slate-400`} colSpan={4}>No devices yet.</td></tr>}
              {!rows && !error && <tr><td className={`${td} text-slate-400`} colSpan={4}>Loading.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  )
}
