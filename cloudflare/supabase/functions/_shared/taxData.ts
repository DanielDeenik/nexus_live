// Loads the books one user's tax work needs, for the tax agent and the live
// forecast alike: invoices, expenses, assets, time, profile, the yearly inputs
// the books cannot know, settings, budgets and the client's public holidays.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type AppConfig, need } from "./config.ts";
import { eurRate } from "./fx.ts";
import {
  type AssetRow, type ExpenseRow, type FiscalParams, type ForecastData, type Holiday, type InvoiceRow, type ParamRow,
  type VatExpense, type YearBooks, type YearInputs, COUNTABLE, deductibleEur, depreciationForYear, paramsFromRows,
  round2, toEur,
} from "./fiscal/index.ts";

const INVOICE_COLS = "id, invoice_number, client, amount, currency, amount_eur, status, issued_date, due_date, paid_date, period_start, period_end, hours, unit_rate, duplicate_of, voided_at, review_state, vat_amount, vat_treatment, fx_rate_eur, source, client_country, client_region";
const EXPENSE_COLS = "id, date, status, treatment, amount, currency, amount_excl_vat, vat_amount, vat_reclaimable, vat_reverse_charge, business_use_pct, fx_rate_eur, category, vendor_country, evidence_path";
const ASSET_COLS = "id, description, acquired_date, cost_excl_vat, residual_value, useful_life_years, kia_eligible, status, full_write_off";

/** Fills the EUR amount of foreign-currency invoices from the rate on their issue date. */
export async function backfillInvoiceFx(db: SupabaseClient, cfg: AppConfig, userId: string): Promise<number> {
  const { data } = await db.from("invoices").select("id, amount, currency, issued_date").eq("user_id", userId).is("amount_eur", null);
  let filled = 0;
  for (const inv of data ?? []) {
    const r = await eurRate(db, cfg["integrations.fx_api_base"], inv.currency, inv.issued_date);
    if (!r) continue;
    await db.from("invoices").update({ fx_rate_eur: r.rate, fx_rate_date: r.date, amount_eur: round2(Number(inv.amount) * r.rate) }).eq("id", inv.id);
    filled++;
  }
  return filled;
}

export async function loadTaxData(db: SupabaseClient, userId: string) {
  const [inv, exp, assets, time, profile, openReviews] = await Promise.all([
    db.from("invoices").select(INVOICE_COLS).eq("user_id", userId),
    db.from("expenses").select(EXPENSE_COLS).eq("user_id", userId),
    db.from("fixed_assets").select(ASSET_COLS).eq("user_id", userId),
    db.from("time_entries").select("entry_date, hours, category").eq("user_id", userId),
    db.from("profiles").select("work_calendar_region, standard_hours_per_day, startersaftrek_eligible").eq("id", userId).single(),
    db.from("review_items").select("item_type", { count: "exact" }).eq("user_id", userId).eq("status", "open"),
  ]);
  for (const r of [inv, exp, assets, time]) if (r.error) throw new Error(r.error.message);
  const n = (x: unknown) => (x == null ? null : Number(x));
  return {
    // Legacy Moneybird rows carry VAT-inclusive totals and no periods; the
    // ledger only uses invoices ingested by the new pipeline or entered by hand.
    invoices: (inv.data ?? []).filter((r) => r.source !== "moneybird").map((r) => ({ ...r, amount: Number(r.amount), amount_eur: n(r.amount_eur), hours: n(r.hours), unit_rate: n(r.unit_rate), vat_amount: Number(r.vat_amount), fx_rate_eur: n(r.fx_rate_eur) })),
    expenses: (exp.data ?? []).map((r) => ({ ...r, amount: Number(r.amount), amount_excl_vat: n(r.amount_excl_vat), vat_amount: n(r.vat_amount), business_use_pct: Number(r.business_use_pct), fx_rate_eur: n(r.fx_rate_eur) })) as (VatExpense & { evidence_path: string | null })[],
    assets: (assets.data ?? []).map((r) => ({ ...r, cost_excl_vat: Number(r.cost_excl_vat), residual_value: Number(r.residual_value), useful_life_years: Number(r.useful_life_years), full_write_off: r.full_write_off === true })) as AssetRow[],
    time: (time.data ?? []).map((r) => ({ ...r, hours: Number(r.hours) })),
    profile: profile.data as { work_calendar_region: string | null; standard_hours_per_day: number | null; startersaftrek_eligible: boolean } | null,
    openReviews: openReviews.data ?? [],
  };
}

export type TaxData = Awaited<ReturnType<typeof loadTaxData>>;

export async function loadParams(db: SupabaseClient): Promise<Map<number, FiscalParams>> {
  const { data: rows, error } = await db.from("tax_parameters").select("year, key, value, verified");
  if (error) throw new Error(`tax_parameters: ${error.message}`);
  const params = new Map<number, FiscalParams>();
  for (const y of new Set((rows ?? []).map((r) => r.year as number))) params.set(y, paramsFromRows(rows as ParamRow[], y));
  return params;
}

/** The owner's setting, else the client's region on the most recent invoice. */
export function calendarRegion(data: TaxData): string | null {
  const last = [...data.invoices]
    .filter((i) => !i.voided_at && (i as { client_country?: string }).client_country && (i as { client_region?: string }).client_region)
    .sort((a, b) => b.issued_date.localeCompare(a.issued_date))[0] as { client_country?: string; client_region?: string } | undefined;
  return data.profile?.work_calendar_region ?? (last ? `${last.client_country}-${last.client_region}` : null);
}

function yearBooks(data: TaxData, year: number, p: FiscalParams | undefined): YearBooks {
  const inYear = (d: string) => d.startsWith(String(year));
  const costs = p ? round2(data.expenses.filter((e) => inYear(e.date)).reduce((s, e) => s + deductibleEur(e as ExpenseRow, p), 0)) : 0;
  const depreciation = round2(data.assets.reduce((s, a) => s + depreciationForYear(a, year), 0));
  const qualifying = p
    ? round2(data.assets.filter((a) => a.status === "active" && a.kia_eligible && inYear(a.acquired_date) && a.cost_excl_vat >= p.capitalisationThreshold).reduce((s, a) => s + a.cost_excl_vat, 0))
    : 0;
  const waiting = data.expenses.filter((e) => inYear(e.date) && !COUNTABLE.has(e.status) && e.status !== "rejected");
  return {
    costs_eur: costs,
    depreciation_eur: depreciation,
    kia_qualifying_eur: qualifying,
    awaiting_review: { count: waiting.length, amount_eur: round2(waiting.reduce((s, e) => s + (toEur(e.amount, e.currency, e.fx_rate_eur) ?? 0), 0)) },
    write_off_without_starters: data.assets.filter((a) => a.full_write_off && a.status === "active" && inYear(a.acquired_date)).length,
  };
}

/** Everything the forecast engine needs for one user, today. */
export async function loadForecastData(db: SupabaseClient, cfg: AppConfig, userId: string, today: string, data: TaxData, params: Map<number, FiscalParams>): Promise<ForecastData> {
  const year = Number(today.slice(0, 4));
  const region = calendarRegion(data);
  const [inputs, settings, budgets, holidays] = await Promise.all([
    db.from("nx_tax_year_inputs").select("year, wage_gross_eur, wage_tax_withheld_eur, lijfrente_eur, prepaid_eur, days_off, startersaftrek_eligible").eq("user_id", userId),
    db.from("nx_user_settings").select("key, value").eq("user_id", userId),
    db.from("nx_budgets").select("category, monthly_amount, valid_from").eq("user_id", userId).lte("valid_from", today).order("valid_from", { ascending: false }),
    region
      ? db.from("public_holidays").select("holiday_date, name").eq("region_code", region).gte("holiday_date", `${year - 1}-01-01`).lte("holiday_date", `${year + 1}-12-31`)
      : Promise.resolve({ data: [] as Holiday[], error: null }),
  ]);
  for (const r of [inputs, settings, budgets]) if (r.error) throw new Error(r.error.message);

  const own = new Map((settings.data ?? []).map((s) => [s.key as string, s.value as string]));
  const setting = (key: string): number | null => {
    const v = own.get(key) ?? cfg[key];
    const x = v == null || v === "" ? NaN : Number(v);
    return Number.isFinite(x) ? x : null;
  };
  // Planned living costs: the newest budget per category.
  const seen = new Set<string>();
  let spending = 0;
  for (const b of budgets.data ?? []) {
    if (seen.has(b.category)) continue;
    seen.add(b.category);
    spending += Number(b.monthly_amount);
  }

  const inputMap = new Map<number, YearInputs>();
  for (const r of inputs.data ?? []) {
    inputMap.set(r.year, {
      wage_eur: Number(r.wage_gross_eur), wage_tax_withheld_eur: Number(r.wage_tax_withheld_eur), lijfrente_eur: Number(r.lijfrente_eur),
      prepaid_eur: Number(r.prepaid_eur), days_off: Number(r.days_off),
      starters_eligible: r.startersaftrek_eligible ?? (r.year === year && data.profile?.startersaftrek_eligible === true),
    });
  }
  if (!inputMap.has(year)) {
    inputMap.set(year, { wage_eur: 0, wage_tax_withheld_eur: 0, lijfrente_eur: 0, prepaid_eur: 0, days_off: 0, starters_eligible: data.profile?.startersaftrek_eligible === true });
  }

  const books = new Map<number, YearBooks>();
  for (const y of [year - 1, year, year + 1]) books.set(y, yearBooks(data, y, params.get(y) ?? params.get(year)));

  return {
    today,
    invoices: data.invoices as InvoiceRow[],
    time: data.time,
    books,
    inputs: inputMap,
    params,
    holidays: (holidays.data ?? []) as Holiday[],
    settings: {
      // The app's Plan setting wins over the profile's standard day.
      hours_per_day: setting("plan.hours_per_day") ?? (data.profile?.standard_hours_per_day != null ? Number(data.profile.standard_hours_per_day) : null),
      monthly_spending_eur: seen.size ? round2(spending) : null,
      invest_monthly_eur: setting("invest.monthly_target_eur"),
      dga_salary_eur: setting("bv.dga_salary_eur"),
      bv_annual_costs_eur: setting("bv.annual_costs_eur"),
      reserve_buffer_pct: need(cfg, "tax_agent.reserve_buffer_pct"),
      horizon_months: need(cfg, "forecast.horizon_months"),
    },
  };
}
