import { createClient } from '@supabase/supabase-js'

// Browser Supabase client. URL + anon key come from Vite env — never hardcoded.
// RLS scopes every query to the signed-in user, so the SPA can read/write tables
// directly instead of going through a custom API.
const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  // Surfaced early in dev so a missing .env is obvious.
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY')
}

export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

// Invoke a Supabase Edge Function (sync-*, run-agents, recalc) as the signed-in
// user. The function reads the bearer token to scope work to that user.
export async function callFunction<T = unknown>(
  name: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body })
  if (error) throw error
  return data as T
}
