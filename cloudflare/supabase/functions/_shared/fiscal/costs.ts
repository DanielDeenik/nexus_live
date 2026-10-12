// Cost side of the profit computation: expenses, depreciation and KIA.
import { type FiscalParams, type KiaBand, round2 } from "./params.ts";

export type Treatment = "fully_deductible" | "limited_deductible" | "asset" | "private" | "unknown";

export interface ExpenseRow {
  id: string;
  date: string;
  status: string;
  treatment: Treatment | null;
  amount: number;             // gross as on the document
  currency: string;
  amount_excl_vat: number | null;
  vat_amount: number | null;
  vat_reclaimable: boolean | null;
  vat_reverse_charge: boolean | null;
  business_use_pct: number;
  fx_rate_eur: number | null; // EUR per 1 unit of currency
  category: string;
}

export interface AssetRow {
  id: string;
  description: string;
  acquired_date: string;
  cost_excl_vat: number;
  residual_value: number;
  useful_life_years: number;
  kia_eligible: boolean;
  status: string;
}

/** Only human-approved or auto-booked expenses count toward a filing. */
export const COUNTABLE = new Set(["approved", "booked"]);

export function toEur(amount: number, currency: string, fx: number | null): number | null {
  if (currency === "EUR") return amount;
  return fx == null ? null : round2(amount * fx);
}

/** The cost base for income tax: excl VAT when the VAT is reclaimed,
 *  otherwise the VAT is part of the cost. */
export function costBaseEur(e: ExpenseRow): number | null {
  const reclaim = e.vat_reclaimable === true && e.vat_amount != null && e.amount_excl_vat != null;
  const base = reclaim ? e.amount_excl_vat! + (1 - e.business_use_pct) * e.vat_amount! : e.amount;
  return toEur(base, e.currency, e.fx_rate_eur);
}

export function deductibleEur(e: ExpenseRow, p: FiscalParams): number {
  if (!COUNTABLE.has(e.status)) return 0;
  const base = costBaseEur(e);
  if (base == null) return 0;
  switch (e.treatment) {
    case "fully_deductible":
      return round2(base * e.business_use_pct);
    case "limited_deductible":
      // Threshold variant needs the full-year total; the per-item 80% rule is
      // the default and what the parameters say unless the owner switches.
      return p.limitedDeductible.method === "fixed_pct"
        ? round2(base * e.business_use_pct * p.limitedDeductible.deductible_pct)
        : round2(base * e.business_use_pct);
    default:
      return 0; // assets via depreciation; private and unknown never count
  }
}

/** Input VAT the owner may reclaim in the VAT return. */
export function reclaimableVatEur(e: ExpenseRow): number {
  if (!COUNTABLE.has(e.status) || e.treatment === "private" || e.vat_reclaimable !== true) return 0;
  const v = toEur(e.vat_amount ?? 0, e.currency, e.fx_rate_eur);
  return v == null ? 0 : round2(v * e.business_use_pct);
}

/** Straight-line, pro rata by month from the acquisition month. */
export function depreciationForYear(a: AssetRow, year: number): number {
  if (a.status !== "active") return 0;
  const start = new Date(`${a.acquired_date}T00:00:00Z`);
  const totalMonths = Math.round(a.useful_life_years * 12);
  const monthly = (a.cost_excl_vat - a.residual_value) / totalMonths;
  const startIdx = start.getUTCFullYear() * 12 + start.getUTCMonth();
  const endIdx = startIdx + totalMonths - 1;
  const yStart = year * 12, yEnd = year * 12 + 11;
  const months = Math.max(0, Math.min(endIdx, yEnd) - Math.max(startIdx, yStart) + 1);
  return round2(monthly * months);
}

export function kiaFor(totalQualifying: number, bands: KiaBand[]): number {
  const t = round2(totalQualifying);
  const band = bands.find((b) => t >= b.from && (b.to == null || t <= b.to));
  if (!band) return 0;
  switch (band.type) {
    case "pct": return round2(t * (band.rate ?? 0));
    case "fixed": return band.amount ?? 0;
    case "fixed_minus_pct": return round2((band.amount ?? 0) - (t - (band.above ?? 0)) * (band.rate ?? 0));
    default: return 0;
  }
}

export function kiaForYear(assets: AssetRow[], year: number, p: FiscalParams): { qualifying: number; kia: number } {
  const qualifying = assets
    .filter((a) => a.status === "active" && a.kia_eligible && Number(a.acquired_date.slice(0, 4)) === year &&
      a.cost_excl_vat >= p.capitalisationThreshold)
    .reduce((s, a) => s + a.cost_excl_vat, 0);
  return { qualifying: round2(qualifying), kia: kiaFor(qualifying, p.kia) };
}
