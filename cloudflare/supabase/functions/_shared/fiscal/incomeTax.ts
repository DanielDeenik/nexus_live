// Box 1 income tax estimate for an IB-ondernemer, with any wage from an
// employer in the same year. Order of operations: profit, ondernemersaftrek
// (zelfstandigen + starters, both conditional on the urencriterium),
// MKB-winstvrijstelling, box 1 income (profit plus wage, less lijfrente),
// brackets, tariefsaanpassing on the deductions that fall in the top bracket,
// credits (capped at the tax; arbeidskorting on all labour income), then the
// separate Zvw contribution on taxable profit, capped at the maximum less the
// wage on which the employer already paid the Zvw levy.
import { type Bracket, type CreditBand, type FiscalParams, round2 } from "./params.ts";

export interface IncomeTaxInput {
  revenue_eur: number;
  deductible_costs_eur: number;
  depreciation_eur: number;
  kia_eur: number;
  total_hours: number;
  starters_eligible: boolean;
  /** Wage from an employer in the same year, taxed in box 1 with the profit. */
  wage_eur?: number;
  /** Loonheffing withheld on that wage: already paid toward this year's tax. */
  wage_tax_withheld_eur?: number;
  /** Lijfrente premiums paid in the year: deducted in full, outside the tariefsaanpassing. */
  lijfrente_eur?: number;
  /** Payments on a provisional assessment (voorlopige aanslag) for the year. */
  prepaid_eur?: number;
}

export interface IncomeTaxResult {
  profit: number;
  urencriterium_met: boolean;
  zelfstandigenaftrek: number;
  startersaftrek: number;
  kia: number;
  mkb_winstvrijstelling: number;
  taxable_profit: number;
  wage: number;
  lijfrente: number;
  box1_income: number;
  bracket_tax: { rate: number; base: number; tax: number }[];
  tariefsaanpassing: number;
  income_tax_before_credits: number;
  algemene_heffingskorting: number;
  arbeidskorting: number;
  income_tax: number;
  zvw: number;
  total_due: number;
  withheld: number;
  prepaid: number;
  /** Still to pay for the year after withheld wage tax and prepayments; negative is a refund. */
  to_pay: number;
  effective_rate: number;
}

function bandCredit(income: number, bands: CreditBand[]): number {
  const b = bands.find((x) => income >= x.from && (x.to == null || income < x.to)) ?? bands[bands.length - 1];
  return Math.max(0, b.base + b.rate * (income - b.from));
}

/** Progressive tax over brackets (box 1, box 2, Vpb all use this shape). */
export function bracketTax(amount: number, brackets: Bracket[]): { lines: { rate: number; base: number; tax: number }[]; total: number } {
  const lines: { rate: number; base: number; tax: number }[] = [];
  let lower = 0;
  let total = 0;
  for (const b of brackets) {
    const upper = b.up_to ?? Infinity;
    const base = Math.max(0, Math.min(amount, upper) - lower);
    if (base > 0) {
      const t = base * b.rate;
      lines.push({ rate: b.rate, base: round2(base), tax: round2(t) });
      total += t;
    }
    lower = upper;
  }
  return { lines, total: round2(total) };
}

/** Where the top bracket starts: the upper bound of the bracket before it. */
function topBracketStart(brackets: Bracket[]): number {
  return brackets.length > 1 ? brackets[brackets.length - 2].up_to ?? Infinity : Infinity;
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

  const wage = Math.max(0, i.wage_eur ?? 0);
  const lijfrente = Math.max(0, i.lijfrente_eur ?? 0);
  const box1 = round2(taxable + wage - lijfrente);
  const brackets = bracketTax(Math.max(0, box1), p.brackets);

  // Tariefsaanpassing (art. 2.10a Wet IB 2001): the ondernemersaftrek and the
  // MKB-winstvrijstelling save at most the second bracket rate. It applies to
  // the lower of those deductions and the part of box 1 income before them
  // that lies in the top bracket. Lijfrente is not one of them.
  const deductions = Math.max(0, za + sa + mkb);
  const tsBase = Math.min(deductions, Math.max(0, box1 + deductions - topBracketStart(p.brackets)));
  const tariefsaanpassing = round2(tsBase * p.tariefsaanpassingRate);
  const tax = round2(brackets.total + tariefsaanpassing);

  const ahkRaw = box1 <= p.ahk.phase_out_start
    ? p.ahk.max
    : Math.max(0, p.ahk.max - (box1 - p.ahk.phase_out_start) * p.ahk.phase_out_rate);
  // Arbeidsinkomen of an ondernemer is profit before ondernemersaftrek and
  // MKB-winstvrijstelling (mkbservicedesk.nl, arbeidskorting voor ondernemers);
  // wage from an employer is labour income too.
  const akRaw = bandCredit(Math.max(0, afterKia) + wage, p.arbeidskorting);
  const ahk = round2(Math.min(ahkRaw, tax));
  const ak = round2(Math.min(akRaw, Math.max(0, tax - ahk)));
  const incomeTax = round2(Math.max(0, tax - ahk - ak));
  // The employer already paid the Zvw levy on the wage, which uses up that
  // part of the maximum contribution income.
  const zvwBase = Math.max(0, Math.min(taxable, p.zvw.max_income - wage));
  const zvw = round2(zvwBase * p.zvw.rate);
  const total = round2(incomeTax + zvw);
  const withheld = round2(Math.max(0, i.wage_tax_withheld_eur ?? 0));
  const prepaid = round2(Math.max(0, i.prepaid_eur ?? 0));
  const earned = profit + wage;

  return {
    profit,
    urencriterium_met: met,
    zelfstandigenaftrek: round2(za),
    startersaftrek: round2(sa),
    kia: round2(kia),
    mkb_winstvrijstelling: mkb,
    taxable_profit: taxable,
    wage: round2(wage),
    lijfrente: round2(lijfrente),
    box1_income: box1,
    bracket_tax: brackets.lines,
    tariefsaanpassing,
    income_tax_before_credits: tax,
    algemene_heffingskorting: ahk,
    arbeidskorting: ak,
    income_tax: incomeTax,
    zvw,
    total_due: total,
    withheld,
    prepaid,
    to_pay: round2(total - withheld - prepaid),
    effective_rate: earned > 0 ? round2((total / earned) * 10000) / 10000 : 0,
  };
}
