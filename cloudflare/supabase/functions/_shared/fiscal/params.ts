// Fiscal parameters for one tax year, loaded from public.tax_parameters.
// Nothing in the fiscal engine embeds a rate or threshold: every number comes
// from here, and a missing key fails loudly instead of defaulting silently.

export interface Bracket { up_to: number | null; rate: number }
export interface CreditBand { from: number; to: number | null; base: number; rate: number }
export interface KiaBand {
  from: number;
  to: number | null;
  type: "none" | "pct" | "fixed" | "fixed_minus_pct";
  rate?: number;
  amount?: number;
  above?: number;
}

/** Rules for comparing an eenmanszaak with a BV: corporate tax, box 2, the
 *  minimum DGA salary and the employer's Zvw levy on that salary. */
export interface BvParams {
  vpb: Bracket[];
  box2: Bracket[];
  minSalary: number;
  employerZvw: { rate: number; max_income: number };
}

/** Belastingrente on an income tax assessment for this year: it runs from
 *  interest_from (MM-DD) of the next year unless the return is filed before
 *  file_before (MM-DD) and the assessment follows it. */
export interface InterestRule { rate: number; file_before: string; interest_from: string }

export interface FiscalParams {
  year: number;
  brackets: Bracket[];
  zelfstandigenaftrek: number;
  startersaftrek: number;
  urencriteriumHours: number;
  mkbRate: number;
  /** Deductions in the top bracket give at most the second bracket rate. */
  tariefsaanpassingRate: number;
  belastingrente: InterestRule | null;
  bv: BvParams | null;
  ahk: { max: number; phase_out_start: number; phase_out_rate: number };
  arbeidskorting: CreditBand[];
  zvw: { rate: number; max_income: number };
  kia: KiaBand[];
  capitalisationThreshold: number;
  usefulLife: Record<string, number>;
  limitedDeductible: { method: "fixed_pct" | "threshold"; deductible_pct: number; threshold_alternative: number };
  mileageRate: number;
  vatRates: { standard: number; reduced: number; zero: number };
  rubriekMap: Record<string, string>;
  vatNotReported: string[];
  unverifiedKeys: string[];
}

export interface ParamRow { year: number; key: string; value: unknown; verified?: boolean }

const REQUIRED = [
  "ib.brackets", "ib.zelfstandigenaftrek", "ib.startersaftrek", "ib.urencriterium_hours",
  "ib.mkb_winstvrijstelling_rate", "ib.tariefsaanpassing_rate", "ib.algemene_heffingskorting", "ib.arbeidskorting",
  "zvw.self_employed", "kia.bands", "assets.capitalisation_threshold_excl_vat",
  "assets.default_useful_life_years", "costs.limited_deductible", "costs.mileage_rate_per_km",
  "vat.rates", "vat.rubriek_map",
] as const;

function parse(v: unknown): unknown {
  return typeof v === "string" ? JSON.parse(v) : v;
}

export function paramsFromRows(rows: ParamRow[], year: number): FiscalParams {
  const byKey = new Map<string, ParamRow>();
  for (const r of rows) if (r.year === year) byKey.set(r.key, r);
  const missing = REQUIRED.filter((k) => !byKey.has(k));
  if (missing.length) {
    throw new Error(`tax_parameters for ${year} missing: ${missing.join(", ")}`);
  }
  const g = <T>(k: string) => parse(byKey.get(k)!.value) as T;
  // The BV comparison needs all four of its keys; with any missing it is left out.
  const bvKeys = ["vpb.brackets", "box2.brackets", "dga.gebruikelijk_loon_min", "zvw.employer"];
  const bv: BvParams | null = bvKeys.every((k) => byKey.has(k))
    ? { vpb: g<Bracket[]>("vpb.brackets"), box2: g<Bracket[]>("box2.brackets"), minSalary: Number(g("dga.gebruikelijk_loon_min")), employerZvw: g("zvw.employer") }
    : null;
  return {
    year,
    brackets: g<Bracket[]>("ib.brackets"),
    zelfstandigenaftrek: Number(g("ib.zelfstandigenaftrek")),
    startersaftrek: Number(g("ib.startersaftrek")),
    urencriteriumHours: Number(g("ib.urencriterium_hours")),
    mkbRate: Number(g("ib.mkb_winstvrijstelling_rate")),
    tariefsaanpassingRate: Number(g("ib.tariefsaanpassing_rate")),
    belastingrente: byKey.has("ib.belastingrente") ? g<InterestRule>("ib.belastingrente") : null,
    bv,
    ahk: g("ib.algemene_heffingskorting"),
    arbeidskorting: g<CreditBand[]>("ib.arbeidskorting"),
    zvw: g("zvw.self_employed"),
    kia: g<KiaBand[]>("kia.bands"),
    capitalisationThreshold: Number(g("assets.capitalisation_threshold_excl_vat")),
    usefulLife: g("assets.default_useful_life_years"),
    limitedDeductible: g("costs.limited_deductible"),
    mileageRate: Number(g("costs.mileage_rate_per_km")),
    vatRates: g("vat.rates"),
    rubriekMap: g("vat.rubriek_map"),
    vatNotReported: byKey.has("vat.not_reported_treatments") ? g<string[]>("vat.not_reported_treatments") : [],
    unverifiedKeys: [...byKey.values()].filter((r) => r.verified === false).map((r) => r.key),
  };
}

/** The parameters for a year, or the latest earlier year's as an indicative
 *  stand-in while the year's own are not loaded yet. */
export function paramsForYear(all: Map<number, FiscalParams>, year: number): { params: FiscalParams; indicative: boolean } | null {
  const own = all.get(year);
  if (own) return { params: own, indicative: false };
  const earlier = [...all.keys()].filter((y) => y < year).sort((a, b) => b - a)[0];
  return earlier == null ? null : { params: all.get(earlier)!, indicative: true };
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
