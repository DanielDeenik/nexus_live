// Loads app_config into a typed map. Replaces the old loadConfig(db) helper.
// Every tunable (API base URLs, pagination, thresholds) is read from here, so
// no integration value is hardcoded in the functions themselves.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type AppConfig = Record<string, string>;

export async function loadConfig(supabase: SupabaseClient): Promise<AppConfig> {
  const { data, error } = await supabase.from("app_config").select("key, value");
  if (error) throw new Error(`loadConfig failed: ${error.message}`);
  const out: AppConfig = {};
  for (const row of data ?? []) out[row.key as string] = row.value as string;
  return out;
}

export function num(cfg: AppConfig, key: string, fallback: number): number {
  const v = cfg[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function str(cfg: AppConfig, key: string, fallback: string): string {
  return cfg[key] ?? fallback;
}
