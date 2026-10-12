// Postgres-backed cache + rate limiter, replacing the old Workers KV usage in
// base-agent and fx-rates. Backed by the cache_get/cache_set/rate_limit_check
// SQL functions from migration 20260810000003_infra_tables.sql.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function cacheGet<T = unknown>(
  supabase: SupabaseClient,
  key: string,
): Promise<T | null> {
  const { data, error } = await supabase.rpc("cache_get", { p_key: key });
  if (error) return null;
  return (data as T) ?? null;
}

export async function cacheSet(
  supabase: SupabaseClient,
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  await supabase.rpc("cache_set", {
    p_key: key,
    p_value: value,
    p_ttl_seconds: ttlSeconds,
  });
}

// Returns true if the caller is still within the per-agent, per-user daily limit.
export async function rateLimitCheck(
  supabase: SupabaseClient,
  agentId: string,
  userId: string,
  limit: number,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("rate_limit_check", {
    p_agent_id: agentId,
    p_user_id: userId,
    p_limit: limit,
  });
  if (error) return true; // fail open, matching prior behaviour
  return data === true;
}
