import { useState } from 'react'
import type { Provider } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { type Note, afterSend, cleanCode, codeProblem } from '../lib/signIn'
import { Brand } from '../components/Brand'

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

// Sign-in: OAuth providers first, a one-time email code as the fallback. The code is
// typed on this page, so it signs in the browser that asked for it; the link in the
// same email works too. Account creation stays limited to the allow-list
// (auth.allowed_emails) for both.
export function SignIn() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [busy, setBusy] = useState<'send' | 'verify' | 'oauth' | null>(null)
  const [note, setNote] = useState<Note | null>(null)

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setBusy('send')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      // The link in the email returns to wherever the app is served, including a sub-path.
      // Existing accounts only: the email never creates one.
      options: { emailRedirectTo: returnTo(), shouldCreateUser: false },
    })
    const next = afterSend(error, email)
    if (next.toCode) setStep('code')
    if (!error) setCode('')
    setNote(next.note)
    setBusy(null)
  }

  const verify = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy('verify')
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' })
    // Without an error there is a session: App hears of it and replaces this page.
    if (error) {
      setNote(codeProblem(error))
      setBusy(null)
    }
  }

  const oauth = async (provider: Provider) => {
    setBusy('oauth')
    const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: returnTo() } })
    if (error) {
      setNote({ text: error.message, bad: true })
      setBusy(null)
    }
  }

  const back = () => {
    setStep('email')
    setCode('')
    setNote(null)
  }

  const line = note && (
    <p role={note.bad ? 'alert' : 'status'} className={`text-sm ${note.bad ? 'text-bad' : 'text-muted'}`}>
      {note.text}
    </p>
  )

  return (
    <div className="min-h-screen bg-paper flex items-center justify-center p-4">
      <form onSubmit={step === 'code' ? verify : send} className="glass p-8 w-full max-w-sm space-y-5">
        <Brand />
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Sign in</h1>
          <div className="lemon-rule" aria-hidden="true" />
        </div>
        {step === 'code' ? (
          <>
            <p className="text-sm text-body">
              Type the code from the email here. Or use the link in that email. Either one works once.
            </p>
            <label className="block">
              <span className="text-sm text-muted">Sign-in code</span>
              <input
                type="text" inputMode="numeric" autoComplete="one-time-code" required autoFocus
                value={code} onChange={(e) => setCode(cleanCode(e.target.value))}
                className="mt-1 w-full rounded-lg bg-card border-line text-ink tracking-widest"
              />
            </label>
            <button
              type="submit" disabled={busy !== null}
              className="w-full rounded-lg bg-ink hover:bg-night-2 text-white text-sm font-medium py-2.5 disabled:opacity-60"
            >
              {busy === 'verify' ? 'Signing in' : 'Sign in'}
            </button>
            {line}
            <div className="flex items-center justify-between text-sm">
              <button
                type="button" disabled={busy !== null} onClick={() => send()}
                className="text-lemon-ink hover:text-ink disabled:opacity-60"
              >
                {busy === 'send' ? 'Sending code' : 'Send a new code'}
              </button>
              <button
                type="button" disabled={busy !== null} onClick={back}
                className="text-muted hover:text-ink disabled:opacity-60"
              >
                Use another address
              </button>
            </div>
          </>
        ) : (
          <>
            {providers.map((p) => (
              <button
                key={p} type="button" disabled={busy !== null} onClick={() => oauth(p)}
                className="w-full rounded-lg bg-card border border-line hover:bg-chip text-ink text-sm font-medium py-2.5 disabled:opacity-60"
              >
                Continue with {label(p)}
              </button>
            ))}
            {providers.length > 0 && (
              <div className="flex items-center gap-3 text-xs text-muted">
                <span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" />
              </div>
            )}
            <label className="block">
              <span className="text-sm text-muted">Email</span>
              <input
                type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-lg bg-card border-line text-ink"
                autoComplete="email"
              />
            </label>
            <button
              type="submit" disabled={busy !== null}
              className="w-full rounded-lg bg-ink hover:bg-night-2 text-white text-sm font-medium py-2.5 disabled:opacity-60"
            >
              {busy === 'send' ? 'Sending code' : 'Email me a sign-in code'}
            </button>
            {line}
          </>
        )}
      </form>
    </div>
  )
}
