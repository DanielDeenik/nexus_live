import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { expectedRedirect, redirectHost, scopeList } from '../lib/claudeAccess'

type Details = {
  authorization_id: string
  redirect_uri: string
  client: { id: string; name: string; uri: string }
  scope: string
}

// Supabase Auth sends Claude Code (or any MCP client) here to ask for access to
// the Nexus agents. Approving signs that client in as you: it reads your agent
// runs and review queue and runs your agents, as the app does. It cannot decide
// a review item: approvals stay in Nexus.
export function OAuthConsent() {
  const [params] = useSearchParams()
  const id = params.get('authorization_id') ?? ''
  const [details, setDetails] = useState<Details | null>(null)
  const [trusted, setTrusted] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!id) { setError('This page needs an authorization request. Start again from Claude Code.'); return }
    ;(async () => {
      const [d, cfg] = await Promise.all([
        supabase.auth.oauth.getAuthorizationDetails(id),
        supabase.from('app_config').select('value').eq('key', 'mcp.consent_trusted_hosts').maybeSingle(),
      ])
      if (d.error) { setError(d.error.message); return }
      if (cfg.error) { setError(cfg.error.message); return }
      if (!cfg.data) { setError('The setting mcp.consent_trusted_hosts is missing.'); return }
      setTrusted(JSON.parse(cfg.data.value as string) as string[])
      // Approved before for these scopes: straight back to the client.
      if (!('authorization_id' in d.data)) { window.location.href = d.data.redirect_url; return }
      setDetails(d.data as Details)
    })().catch((e) => setError((e as Error).message))
  }, [id])

  const decide = async (approve: boolean) => {
    setBusy(true); setError('')
    const r = approve ? await supabase.auth.oauth.approveAuthorization(id) : await supabase.auth.oauth.denyAuthorization(id)
    // Without an error the browser is on its way back to the client.
    if (r.error) { setError(r.error.message); setBusy(false) }
  }

  const host = details ? redirectHost(details.redirect_uri) : null
  const expected = details && trusted ? expectedRedirect(details.redirect_uri, trusted) : true
  const scopes = scopeList(details?.scope)

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="glass p-8 w-full max-w-md space-y-5">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-cyan-600 flex items-center justify-center">
            <span className="text-white font-bold text-sm">N</span>
          </div>
          <span className="text-lg font-bold text-slate-50">Nexus</span>
        </div>
        {error && <p role="alert" className="text-sm text-danger-400">{error}</p>}
        {!details && !error && <p className="text-sm text-slate-400">Reading the request</p>}
        {details && (
          <>
            <h1 className="text-base font-semibold text-slate-50">{details.client.name || 'An app'} wants to use your Nexus agents</h1>
            <div className="text-sm text-slate-300 space-y-2">
              <p>If you allow it, it signs in as you and can:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>read your agents, their runs and your open review items</li>
                <li>run your agents now, the same runs the schedule does</li>
              </ul>
              <p>It cannot approve, edit or reject anything. You decide review items here in Nexus.</p>
            </div>
            <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-slate-400">Sends you back to</dt>
              <dd className="text-slate-200 break-all">{host ?? details.redirect_uri}</dd>
              {scopes.length > 0 && (<><dt className="text-slate-400">Asks for</dt><dd className="text-slate-200">{scopes.join(', ')}</dd></>)}
            </dl>
            {!expected && (
              <p role="alert" className="flex gap-2 text-sm text-warning-400">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                Claude Code returns to this computer (localhost) and Claude to claude.ai. This request returns to {host ?? 'another address'}. Deny it unless you started it yourself.
              </p>
            )}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => decide(true)}
                className="flex-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium py-2.5 disabled:opacity-60">Allow</button>
              <button type="button" disabled={busy} onClick={() => decide(false)}
                className="flex-1 rounded-lg border border-slate-600 hover:bg-slate-700/40 text-slate-200 text-sm font-medium py-2.5 disabled:opacity-60">Deny</button>
            </div>
            <p className="text-xs text-slate-500">You can take the access back in Settings, Claude Code.</p>
          </>
        )}
      </div>
    </div>
  )
}
