import { useState, useCallback } from 'react'
import { apiClient } from '../lib/api'
import { User, AuthState, initialAuthState } from '../stores/auth'

export function useAuthProvider() {
  const [state, setState] = useState<AuthState>(initialAuthState)

  const setToken = useCallback((token: string) => {
    apiClient.setToken(token)
    setState((prev) => ({
      ...prev,
      token,
      isAuthenticated: true,
    }))
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      setState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
      }))

      try {
        const response = await apiClient.post<{ token: string; user: User }>(
          '/v1/auth/login',
          { email, password }
        )

        setToken(response.token)
        setState((prev) => ({
          ...prev,
          user: response.user,
          isLoading: false,
        }))
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Login failed'
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
        }))
        throw error
      }
    },
    [setToken]
  )

  const register = useCallback(
    async (email: string, password: string, name: string) => {
      setState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
      }))

      try {
        const response = await apiClient.post<{ token: string; user: User }>(
          '/v1/auth/register',
          { email, password, name }
        )

        setToken(response.token)
        setState((prev) => ({
          ...prev,
          user: response.user,
          isLoading: false,
        }))
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Registration failed'
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
        }))
        throw error
      }
    },
    [setToken]
  )

  const logout = useCallback(() => {
    apiClient.clearToken()
    setState(initialAuthState)
  }, [])

  const getCurrentUser = useCallback(async () => {
    if (!state.token) {
      return null
    }

    try {
      const user = await apiClient.get<User>('/v1/auth/me')
      setState((prev) => ({
        ...prev,
        user,
        isLoading: false,
      }))
      return user
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error:
          error instanceof Error ? error.message : 'Failed to get current user',
      }))
      return null
    }
  }, [state.token])

  return {
    ...state,
    login,
    logout,
    register,
    getCurrentUser,
    setToken,
  }
}
