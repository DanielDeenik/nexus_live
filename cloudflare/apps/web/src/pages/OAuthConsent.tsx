import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { expectedRedirect, redirectHost, scopeList } from '../lib/claudeAccess'
import { Brand } from '../components/Brand'

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
    <div className="min-h-screen bg-paper flex items-center justify-center p-4">
      <div className="glass p-8 w-full max-w-md space-y-5">
        <Brand />
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
        {!details && !error && <p className="text-sm text-muted">Reading the request</p>}
        {details && (
          <>
            <h1 className="text-base font-semibold text-ink">{details.client.name || 'An app'} wants to use your Nexus live agents</h1>
            <div className="text-sm text-body space-y-2">
              <p>If you allow it, it signs in as you and can:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>read your agents, their runs and your open review items</li>
                <li>run your agents now, the same runs the schedule does</li>
              </ul>
              <p>It cannot approve, edit or reject anything. You decide review items here in Nexus live.</p>
            </div>
            <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted">Sends you back to</dt>
              <dd className="text-ink break-all">{host ?? details.redirect_uri}</dd>
              {scopes.length > 0 && (<><dt className="text-muted">Asks for</dt><dd className="text-ink">{scopes.join(', ')}</dd></>)}
            </dl>
            {!expected && (
              <p role="alert" className="flex gap-2 text-sm text-lemon-ink">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                Claude Code returns to this computer (localhost) and Claude to claude.ai. This request returns to {host ?? 'another address'}. Deny it unless you started it yourself.
              </p>
            )}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => decide(true)}
                className="flex-1 rounded-lg bg-ink hover:bg-night-2 text-white text-sm font-medium py-2.5 disabled:opacity-60">Allow</button>
              <button type="button" disabled={busy} onClick={() => decide(false)}
                className="flex-1 rounded-lg border border-line hover:bg-chip text-ink text-sm font-medium py-2.5 disabled:opacity-60">Deny</button>
            </div>
            <p className="text-xs text-muted">You can take the access back in Settings, Claude Code.</p>
          </>
        )}
      </div>
    </div>
  )
}
