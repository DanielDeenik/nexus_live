// Claude Code access to the Nexus agents: the consent rules and the address
// to add. The pure functions run in the browser and under deno test; the
// calls below them go through supabase-js as the signed-in user.

/** The host a redirect goes to, or null when it is not a web address. */
export function redirectHost(uri: string): string | null {
  try {
    const u = new URL(uri)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null
  } catch {
    return null
  }
}

/** Whether the redirect goes where Claude Code or Claude send it: a local
 *  address (http only there) or a trusted host over https. Anything else gets
 *  a warning before approval. */
export function expectedRedirect(uri: string, trusted: string[]): boolean {
  const host = redirectHost(uri)
  if (!host || !trusted.includes(host)) return false
  // Plain http only back to this machine (loopback redirects, RFC 8252).
  const loopback = host === 'localhost' || host === '[::1]' || /^127\./.test(host)
  return loopback || new URL(uri).protocol === 'https:'
}

/** The scopes as a list; an empty request still signs in as you. */
export function scopeList(scope: string | undefined | null): string[] {
  return (scope ?? '').split(/\s+/).filter(Boolean)
}

/** The MCP address of this project. */
export function mcpAddress(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/mcp`
}

/** The command that adds the server to Claude Code. */
export function addCommand(name: string, address: string): string {
  return `claude mcp add --transport http ${name} ${address}`
}

// Sign-in drops the address the browser came in on, so a consent request that
// arrives before sign-in is kept for the moment after it.
const KEEP = 'nexus.oauth_consent'

export function keepConsentPath(path: string, search: string, store: Pick<Storage, 'setItem'>) {
  if (path === '/oauth/consent' && search.includes('authorization_id=')) store.setItem(KEEP, `${path}${search}`)
}

export function takeConsentPath(store: Pick<Storage, 'getItem' | 'removeItem'>): string | null {
  const v = store.getItem(KEEP)
  if (v) store.removeItem(KEEP)
  return v && v.startsWith('/oauth/consent?') ? v : null
}
