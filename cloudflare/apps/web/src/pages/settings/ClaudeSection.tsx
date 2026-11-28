import { useCallback, useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Card, CardHeader } from '../../components/ui/Card'
import { ErrorNote, btnGhost, td, th } from '../../components/time/ui'
import { supabase } from '../../lib/supabase'
import { addCommand, mcpAddress } from '../../lib/claudeAccess'

type Grant = { client: { id: string; name: string }; scopes: string[]; granted_at: string }

const when = (s: string) => new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

// Claude Code reaches the Nexus agents through the mcp function. It signs in
// with your Nexus account on the consent page; each app you allowed is listed
// here and can be cut off.
export function ClaudeSection() {
  const [name, setName] = useState<string | null>(null)
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const address = mcpAddress(import.meta.env.VITE_SUPABASE_URL ?? '')

  const load = useCallback(() => {
    supabase.auth.oauth.listGrants().then(({ data, error }) => {
      if (error) setError(error.message)
      else setGrants((data ?? []) as Grant[])
    })
  }, [])
  useEffect(() => {
    load()
    supabase.from('app_config').select('value').eq('key', 'mcp.server_name').maybeSingle().then(({ data, error }) => {
      if (error) setError(error.message)
      else if (!data) setError('The setting mcp.server_name is missing.')
      else setName(String(data.value))
    })
  }, [load])

  const command = name ? addCommand(name, address) : ''
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { setCopied(false) }
  }

  const revoke = async (g: Grant) => {
    if (!window.confirm(`Take access back from ${g.client.name}? It is signed out and has to ask again.`)) return
    setError('')
    const { error } = await supabase.auth.oauth.revokeGrant({ clientId: g.client.id })
    if (error) setError(error.message)
    else load()
  }

  return (
    <section id="claude" className="space-y-6 scroll-mt-20">
      <div>
        <h2 className="text-lg font-semibold text-ink">Claude Code</h2>
        <p className="text-sm text-muted">Read and run your agents from Claude Code. Approvals stay here.</p>
      </div>

      <Card className="p-4 sm:p-6">
        <CardHeader title="Connect Claude Code" />
        <p className="text-sm text-body mb-4">
          Run this once in a terminal. The first time Claude Code uses it, your browser opens this app to sign in and allow it.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-lg bg-card border border-line px-3 py-2 text-xs text-ink break-all">{command || 'Loading'}</code>
          <button type="button" onClick={copy} disabled={!command} className={`${btnGhost} shrink-0`} aria-label="Copy the command">
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </Card>

      <Card className="p-4 sm:p-6">
        <CardHeader title="Apps with access" />
        {error && <ErrorNote message={error} />}
        {grants && grants.length === 0 && <p className="text-sm text-muted">No app has access.</p>}
        {grants && grants.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-muted"><tr><th className={th}>App</th><th className={th}>Allowed</th><th className={th}>Scopes</th><th className={th} /></tr></thead>
            <tbody className="text-ink">
              {grants.map((g) => (
                <tr key={g.client.id} className="border-t border-line">
                  <td className={td}>{g.client.name}</td>
                  <td className={td}>{when(g.granted_at)}</td>
                  <td className={td}>{g.scopes.join(', ') || '-'}</td>
                  <td className={`${td} text-right`}><button type="button" onClick={() => revoke(g)} className={btnGhost}>Take back</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  )
}
