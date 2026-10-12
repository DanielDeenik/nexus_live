import { useState } from 'react'
import type { Provider } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

// Where Supabase sends the browser back to after sign-in, including a sub-path.
const returnTo = () => new URL(import.meta.env.BASE_URL, window.location.origin).toString()

// OAuth providers come from the build config (VITE_AUTH_PROVIDERS, comma separated),
// so a provider is added or removed without touching this page. Each one must also
// be enabled under Supabase Authentication, Sign In / Providers.
const providers = (import.meta.env.VITE_AUTH_PROVIDERS ?? '')
  .split(',')
  .map((p: string) => p.trim().toLowerCase())
  .filter(Boolean) as Provider[]

const label = (p: string) => p.charAt(0).toUpperCase() + p.slice(1)

// Sign-in: OAuth providers first, a one-time email link as the fallback.
// Account creation stays limited to the allow-list (auth.allowed_emails) for both.
export function SignIn() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [message, setMessage] = useState('')

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    setState('sending')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      // Return to wherever the app is served, including a sub-path.
      options: { emailRedirectTo: returnTo() },
    })
    if (error) {
      setState('error')
      setMessage(error.message)
    } else {
      setState('sent')
    }
  }

  const oauth = async (provider: Provider) => {
    setState('sending')
    const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: returnTo() } })
    if (error) {
      setState('error')
      setMessage(error.message)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <form onSubmit={send} className="glass p-8 w-full max-w-sm space-y-5">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-cyan-600 flex items-center justify-center">
            <span className="text-white font-bold text-sm">N</span>
          </div>
          <span className="text-lg font-bold text-slate-50">Nexus</span>
        </div>
        {state === 'sent' ? (
          <p className="text-sm text-slate-300">Check {email} for a sign-in link. You can close this tab.</p>
        ) : (
          <>
            {providers.map((p) => (
              <button
                key={p} type="button" disabled={state === 'sending'} onClick={() => oauth(p)}
                className="w-full rounded-lg bg-slate-100 hover:bg-white text-slate-900 text-sm font-medium py-2.5 disabled:opacity-60"
              >
                Continue with {label(p)}
              </button>
            ))}
            {providers.length > 0 && (
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span className="h-px flex-1 bg-slate-800" />or<span className="h-px flex-1 bg-slate-800" />
              </div>
            )}
            <label className="block">
              <span className="text-sm text-slate-400">Email</span>
              <input
                type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-lg bg-slate-900 border-slate-700 text-slate-100"
                autoComplete="email"
              />
            </label>
            <button
              type="submit" disabled={state === 'sending'}
              className="w-full rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium py-2.5 disabled:opacity-60"
            >
              {state === 'sending' ? 'Sending link' : 'Email me a sign-in link'}
            </button>
            {state === 'error' && <p className="text-sm text-danger-400">{message}</p>}
          </>
        )}
      </form>
    </div>
  )
}
