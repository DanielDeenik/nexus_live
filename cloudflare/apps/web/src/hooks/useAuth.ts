import { useState, useCallback, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { User, AuthState, initialAuthState } from '../stores/auth'
import type { Session } from '@supabase/supabase-js'

// Maps a Supabase auth session (+ profile row) to the app User shape.
async function toUser(session: Session | null): Promise<User | null> {
  if (!session?.user) return null
  const { data: profile } = await supabase
    .from('profiles')
    .select('name, role, base_currency, monthly_burn')
    .eq('id', session.user.id)
    .maybeSingle()
  return {
    id: session.user.id,
    email: session.user.email ?? '',
    name: profile?.name ?? session.user.user_metadata?.name ?? '',
    role: (profile?.role as User['role']) ?? 'user',
    baseCurrency: profile?.base_currency ?? 'EUR',
    monthlyBurn: profile?.monthly_burn ?? undefined,
  }
}

export function useAuthProvider() {
  const [state, setState] = useState<AuthState>(initialAuthState)

  // Hydrate from any existing session and subscribe to auth changes.
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      const user = await toUser(data.session)
      setState({
        user,
        token: data.session?.access_token ?? null,
        isAuthenticated: !!user,
        isLoading: false,
        error: null,
      })
    })
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const user = await toUser(session)
      setState((prev) => ({
        ...prev,
        user,
        token: session?.access_token ?? null,
        isAuthenticated: !!user,
        isLoading: false,
      }))
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setState((prev) => ({ ...prev, isLoading: false, error: error.message }))
      throw error
    }
  }, [])

  const register = useCallback(async (email: string, password: string, name: string) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } },
    })
    if (error) {
      setState((prev) => ({ ...prev, isLoading: false, error: error.message }))
      throw error
    }
  }, [])

  const logout = useCallback(() => {
    supabase.auth.signOut()
    setState({ ...initialAuthState, isLoading: false })
  }, [])

  const getCurrentUser = useCallback(async () => {
    const { data } = await supabase.auth.getSession()
    const user = await toUser(data.session)
    setState((prev) => ({ ...prev, user, isLoading: false }))
    return user
  }, [])

  // Kept for interface compatibility; Supabase manages tokens internally.
  const setToken = useCallback((_token: string) => {}, [])

  return { ...state, login, logout, register, getCurrentUser, setToken }
}
