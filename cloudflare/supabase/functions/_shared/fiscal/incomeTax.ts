// Box 1 income tax estimate for an IB-ondernemer with no other income.
// Order of operations: profit, ondernemersaftrek (zelfstandigen + starters,
// both conditional on the urencriterium), MKB-winstvrijstelling, brackets,
// credits (capped at the tax; arbeidskorting on arbeidsinkomen), then the
// separate Zvw contribution on taxable profit, capped.
import { type CreditBand, type FiscalParams, round2 } from "./params.ts";

export interface IncomeTaxInput {
  revenue_eur: number;
  deductible_costs_eur: number;
  depreciation_eur: number;
  kia_eur: number;
  total_hours: number;
  starters_eligible: boolean;
}

export interface IncomeTaxResult {
  profit: number;
  urencriterium_met: boolean;
  zelfstandigenaftrek: number;
  startersaftrek: number;
  kia: number;
  mkb_winstvrijstelling: number;
  taxable_profit: number;
  bracket_tax: { rate: number; base: number; tax: number }[];
  income_tax_before_credits: number;
  algemene_heffingskorting: number;
  arbeidskorting: number;
  income_tax: number;
  zvw: number;
  total_due: number;
  effective_rate: number;
}

function bandCredit(income: number, bands: CreditBand[]): number {
  const b = bands.find((x) => income >= x.from && (x.to == null || income < x.to)) ?? bands[bands.length - 1];
  return Math.max(0, b.base + b.rate * (income - b.from));
}

export function estimateIncomeTax(i: IncomeTaxInput, p: FiscalParams): IncomeTaxResult {
  const profit = round2(i.revenue_eur - i.deductible_costs_eur - i.depreciation_eur);
  const met = i.total_hours >= p.urencriteriumHours;
  // KIA is an investment deduction from profit, before ondernemersaftrek; it
  // may create or increase a loss.
  const kia = Math.max(0, i.kia_eur);
  const afterKia = profit - kia;
  // Ondernemersaftrek cannot create a loss in the year; the unused part
  // carries forward, which this estimate does not model.
  const za = met ? Math.min(p.zelfstandigenaftrek, Math.max(0, afterKia)) : 0;
  const sa = met && i.starters_eligible ? Math.min(p.startersaftrek, Math.max(0, afterKia - za)) : 0;
  const afterOa = afterKia - za - sa;
  const mkb = round2(afterOa * p.mkbRate); // negative on a loss: it shrinks the loss too
  const taxable = round2(afterOa - mkb);

  const bracket_tax: IncomeTaxResult["bracket_tax"] = [];
  let lower = 0;
  let tax = 0;
  for (const b of p.brackets) {
    const upper = b.up_to ?? Infinity;
    const base = Math.max(0, Math.min(taxable, upper) - lower);
    if (base > 0) {
      const t = base * b.rate;
      bracket_tax.push({ rate: b.rate, base: round2(base), tax: round2(t) });
      tax += t;
    }
    lower = upper;
  }
  tax = round2(tax);

  const ahkRaw = taxable <= p.ahk.phase_out_start
    ? p.ahk.max
    : Math.max(0, p.ahk.max - (taxable - p.ahk.phase_out_start) * p.ahk.phase_out_rate);
  // Arbeidsinkomen of an ondernemer is profit before ondernemersaftrek and
  // MKB-winstvrijstelling (mkbservicedesk.nl, arbeidskorting voor ondernemers).
  const akRaw = bandCredit(Math.max(0, afterKia), p.arbeidskorting);
  const ahk = round2(Math.min(ahkRaw, tax));
  const ak = round2(Math.min(akRaw, Math.max(0, tax - ahk)));
  const incomeTax = round2(Math.max(0, tax - ahk - ak));
  const zvw = round2(Math.max(0, Math.min(taxable, p.zvw.max_income)) * p.zvw.rate);
  const total = round2(incomeTax + zvw);

  return {
    profit,
    urencriterium_met: met,
    zelfstandigenaftrek: round2(za),
    startersaftrek: round2(sa),
    kia: round2(kia),
    mkb_winstvrijstelling: mkb,
    taxable_profit: taxable,
    bracket_tax,
    income_tax_before_credits: tax,
    algemene_heffingskorting: ahk,
    arbeidskorting: ak,
    income_tax: incomeTax,
    zvw,
    total_due: total,
    effective_rate: profit > 0 ? round2((total / profit) * 10000) / 10000 : 0,
  };
}
