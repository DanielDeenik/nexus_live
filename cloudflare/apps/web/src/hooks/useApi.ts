import { useState, useEffect, useCallback, useRef } from 'react'
import { apiClient } from '../lib/api'

export interface UseQueryOptions {
  enabled?: boolean
  refetchInterval?: number
  staleTime?: number
}

export interface UseQueryResult<T> {
  data: T | null
  isLoading: boolean
  error: Error | null
  refetch: () => Promise<void>
}

export function useQuery<T>(
  path: string,
  options: UseQueryOptions = {}
): UseQueryResult<T> {
  const { enabled = true, refetchInterval, staleTime = 0 } = options
  const [data, setData] = useState<T | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const lastFetchTime = useRef<number>(0)
  const refetchTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)

  const fetchData = useCallback(async () => {
    if (!enabled) {
      setIsLoading(false)
      return
    }

    // Check stale time
    const now = Date.now()
    if (now - lastFetchTime.current < staleTime) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const result = await apiClient.get<T>(path)
      setData(result)
      lastFetchTime.current = now
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'))
    } finally {
      setIsLoading(false)
    }
  }, [path, enabled, staleTime])

  useEffect(() => {
    fetchData()

    if (refetchInterval) {
      refetchTimeoutRef.current = setInterval(fetchData, refetchInterval)
    }

    return () => {
      if (refetchTimeoutRef.current) {
        clearInterval(refetchTimeoutRef.current)
      }
    }
  }, [fetchData, refetchInterval])

  return {
    data,
    isLoading,
    error,
    refetch: fetchData,
  }
}

export interface UseMutationOptions {
  onSuccess?: (data: unknown) => void
  onError?: (error: Error) => void
}

export interface UseMutationResult<T, V> {
  mutate: (data?: V) => Promise<T>
  isLoading: boolean
  error: Error | null
  data: T | null
  reset: () => void
}

export function useMutation<T, V = unknown>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST',
  options: UseMutationOptions = {}
): UseMutationResult<T, V> {
  const { onSuccess, onError } = options
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [data, setData] = useState<T | null>(null)

  const mutate = useCallback(
    async (payload?: V): Promise<T> => {
      setIsLoading(true)
      setError(null)

      try {
        let result: T

        if (method === 'POST') {
          result = await apiClient.post<T>(path, payload)
        } else if (method === 'PUT') {
          result = await apiClient.put<T>(path, payload)
        } else if (method === 'PATCH') {
          result = await apiClient.patch<T>(path, payload)
        } else if (method === 'DELETE') {
          result = await apiClient.delete<T>(path)
        } else {
          throw new Error(`Unsupported method: ${method}`)
        }

        setData(result)
        onSuccess?.(result)
        return result
      } catch (err) {
        const error = err instanceof Error ? err : new Error('Unknown error')
        setError(error)
        onError?.(error)
        throw error
      } finally {
        setIsLoading(false)
      }
    },
    [path, method, onSuccess, onError]
  )

  const reset = useCallback(() => {
    setError(null)
    setData(null)
    setIsLoading(false)
  }, [])

  return {
    mutate,
    isLoading,
    error,
    data,
    reset,
  }
}

export interface UseInfiniteQueryOptions extends UseQueryOptions {
  pageSize?: number
}

export interface UseInfiniteQueryResult<T> extends UseQueryResult<T[]> {
  hasMore: boolean
  loadMore: () => Promise<void>
  page: number
}

export function useInfiniteQuery<T>(
  pathTemplate: (page: number) => string,
  options: UseInfiniteQueryOptions = {}
): UseInfiniteQueryResult<T> {
  const { pageSize: _pageSize = 20 } = options
  const [page, setPage] = useState(1)
  const [data, setData] = useState<T[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const path = pathTemplate(page)

  const fetchData = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await apiClient.get<{ data: T[]; hasMore: boolean }>(path)
      setData((prev) => [...prev, ...result.data])
      setHasMore(result.hasMore)
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'))
    } finally {
      setIsLoading(false)
    }
  }, [path])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const loadMore = useCallback(async () => {
    if (!hasMore || isLoading) return
    setPage((p) => p + 1)
  }, [hasMore, isLoading])

  return {
    data,
    isLoading,
    error,
    hasMore,
    loadMore,
    page,
    refetch: fetchData,
  }
}
