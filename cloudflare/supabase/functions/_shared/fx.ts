// ECB reference rates (via the API in app_config integrations.fx_api_base).
// Returns EUR per 1 unit of `currency` on `date` (or the last business day
// before it, which is how the ECB series works on weekends and holidays).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheGet, cacheSet } from "./cache.ts";

export async function eurRate(db: SupabaseClient, apiBase: string, currency: string, date: string): Promise<{ rate: number; date: string } | null> {
  if (currency === "EUR") return { rate: 1, date };
  const key = `fx:${currency}:${date}`;
  const hit = await cacheGet<{ rate: number; date: string }>(db, key);
  if (hit && typeof hit.rate === "number") return hit;
  const res = await fetch(`${apiBase}/${date}?from=${encodeURIComponent(currency)}&to=EUR`);
  if (!res.ok) return null;
  const j = await res.json();
  const rate = j?.rates?.EUR;
  if (typeof rate !== "number") return null;
  const out = { rate, date: j.date as string };
  await cacheSet(db, key, out, 60 * 60 * 24 * 365);
  return out;
}
