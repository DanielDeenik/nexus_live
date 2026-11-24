// forecast: the live money forecast behind the app's Plan and Money tabs. The
// numbers come from the fiscal engine; nothing here is a filing.
//
// POST {}                     signed-in user: compute, store and return the forecast
// POST { what_if: {...} }     signed-in user: the same, plus a what-if that is never stored
// POST {} with the service key  every user: refresh the stored forecast (daily cron)
//
// The stored row per year (nx_tax_forecast_live) is what nx_money_summary
// subtracts from cash as the tax reserve: tax on income billed so far, less
// wage tax withheld and prepayments, plus the buffer in app_config.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminClient, authorize } from "../_shared/client.ts";
import { type AppConfig, loadConfig } from "../_shared/config.ts";
import { json, preflight } from "../_shared/cors.ts";
import { backfillInvoiceFx, loadForecastData, loadParams, loadTaxData } from "../_shared/taxData.ts";
import { type FiscalParams, type WhatIf, buildForecast, closedYearReserve } from "../_shared/fiscal/index.ts";

/** Only finite numbers in a sane range get through to the engine. */
export function readWhatIf(raw: unknown): WhatIf | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (k: string, max: number) => {
    const v = r[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined;
  };
  const w: WhatIf = {
    hours_per_day: num("hours_per_day", 24),
    days_off: num("days_off", 366),
    extra_cost_eur: num("extra_cost_eur", 10_000_000),
    extra_investment_eur: num("extra_investment_eur", 10_000_000),
    lijfrente_eur: num("lijfrente_eur", 10_000_000),
  };
  return Object.values(w).some((v) => v !== undefined) ? w : null;
}

async function forUser(db: SupabaseClient, cfg: AppConfig, params: Map<number, FiscalParams>, userId: string, today: string, whatIf: WhatIf | null) {
  await backfillInvoiceFx(db, cfg, userId);
  const books = await loadTaxData(db, userId);
  const data = await loadForecastData(db, cfg, userId, today, books, params);
  const forecast = buildForecast(data);
  const year = forecast.year;
  const computedAt = new Date().toISOString();
  const rows = [{ user_id: userId, year, reserve_eur: forecast.reserve_eur, figures: forecast, computed_at: computedAt }];

  // Earlier years stay in the reserve until their tax is recorded as paid.
  const { data: stored } = await db.from("nx_tax_forecast_live").select("year").eq("user_id", userId).lt("year", year);
  const earlier = new Set<number>([year - 1, ...(stored ?? []).map((r) => r.year as number)]);
  const reserves = [{ year, reserve_eur: forecast.reserve_eur }];
  for (const y of [...earlier].sort()) {
    const closed = closedYearReserve(data, y);
    if (!closed) continue;
    rows.push({ user_id: userId, year: y, reserve_eur: closed.reserve_eur, figures: closed as never, computed_at: computedAt });
    reserves.push({ year: y, reserve_eur: closed.reserve_eur });
  }
  const { error } = await db.from("nx_tax_forecast_live").upsert(rows, { onConflict: "user_id,year" });
  if (error) throw new Error(`store forecast: ${error.message}`);
  return { forecast, reserves: reserves.sort((a, b) => a.year - b.year), what_if: whatIf ? buildForecast(data, whatIf) : null };
}

export async function handler(req: Request): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  const db = adminClient();
  try {
    const who = await authorize(req, db);
    if (!who) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    const cfg = await loadConfig(db);
    const params = await loadParams(db);
    const today = new Date().toISOString().slice(0, 10);
    if (who.kind === "user") return json(await forUser(db, cfg, params, who.id, today, readWhatIf(body.what_if)));
    const users = ((await db.from("profiles").select("id")).data ?? []).map((r) => r.id as string);
    let refreshed = 0;
    const failed: string[] = [];
    for (const u of users) {
      try {
        await forUser(db, cfg, params, u, today, null);
        refreshed++;
      } catch (e) {
        failed.push((e as Error).message);
      }
    }
    return json({ refreshed, failed });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);
