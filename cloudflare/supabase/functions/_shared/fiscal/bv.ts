// Eenmanszaak against BV for one year's business result. The BV pays the DGA
// a salary (at least the legal minimum), the employer's Zvw levy on that
// salary and its own running costs; corporate tax falls on what is left. That
// profit is either paid out as dividend (box 2) or kept in the BV to invest.
import { type FiscalParams, round2 } from "./params.ts";
import { bracketTax, estimateIncomeTax } from "./incomeTax.ts";

export interface StructureInput {
  revenue_eur: number;
  costs_eur: number;
  depreciation_eur: number;
  kia_eur: number;
  hours: number;
  starters_eligible: boolean;
  /** The salary you would pay yourself; raised to the legal minimum when lower. */
  salary_eur: number;
  /** Extra yearly cost of running a BV (accountant, corporate tax return, filings). */
  bv_costs_eur: number;
}

export type StructureLabel = "eenmanszaak" | "bv_payout" | "bv_retain";

export interface StructureResult {
  label: StructureLabel;
  /** Every tax and levy paid in this structure for the year. */
  tax_eur: number;
  /** After-tax money that reaches you personally. */
  net_to_you_eur: number;
  /** Profit after corporate tax left in the BV (to invest there). */
  kept_in_bv_eur: number;
  detail: Record<string, number>;
}

export interface StructureComparison {
  salary_eur: number;
  salary_raised_to_minimum: boolean;
  minimum_salary_eur: number;
  results: StructureResult[];
}

export function compareStructures(i: StructureInput, p: FiscalParams): StructureComparison | null {
  const bv = p.bv;
  if (!bv) return null;

  const ib = estimateIncomeTax({
    revenue_eur: i.revenue_eur, deductible_costs_eur: i.costs_eur, depreciation_eur: i.depreciation_eur,
    kia_eur: i.kia_eur, total_hours: i.hours, starters_eligible: i.starters_eligible,
  }, p);
  const ownBusiness: StructureResult = {
    label: "eenmanszaak",
    tax_eur: ib.total_due,
    net_to_you_eur: round2(ib.profit - ib.total_due),
    kept_in_bv_eur: 0,
    detail: { profit: ib.profit, income_tax: ib.income_tax, zvw: ib.zvw, tariefsaanpassing: ib.tariefsaanpassing },
  };

  const salary = Math.max(i.salary_eur, bv.minSalary);
  const employerZvw = round2(Math.min(salary, bv.employerZvw.max_income) * bv.employerZvw.rate);
  const profitBeforeSalary = round2(i.revenue_eur - i.costs_eur - i.depreciation_eur - i.bv_costs_eur);
  const profitAfterSalary = round2(profitBeforeSalary - salary - employerZvw);
  // KIA lowers the taxable profit but is not money leaving the BV.
  const vpb = bracketTax(Math.max(0, profitAfterSalary - i.kia_eur), bv.vpb).total;
  const afterVpb = round2(profitAfterSalary - vpb);
  // The salary is taxed in box 1 as wage; the BV already paid the Zvw levy on it.
  const wage = estimateIncomeTax({
    revenue_eur: 0, deductible_costs_eur: 0, depreciation_eur: 0, kia_eur: 0, total_hours: 0,
    starters_eligible: false, wage_eur: salary,
  }, p);
  const netSalary = round2(salary - wage.income_tax);
  const dividend = Math.max(0, afterVpb);
  const box2 = bracketTax(dividend, bv.box2).total;
  const common = {
    profit_before_salary: profitBeforeSalary, salary, salary_tax: wage.income_tax, employer_zvw: employerZvw,
    bv_costs: round2(i.bv_costs_eur), vpb, profit_after_vpb: afterVpb,
  };
  const payout: StructureResult = {
    label: "bv_payout",
    tax_eur: round2(vpb + wage.income_tax + employerZvw + box2),
    net_to_you_eur: round2(netSalary + dividend - box2),
    kept_in_bv_eur: round2(afterVpb - dividend),
    detail: { ...common, dividend, box2 },
  };
  const retain: StructureResult = {
    label: "bv_retain",
    tax_eur: round2(vpb + wage.income_tax + employerZvw),
    net_to_you_eur: netSalary,
    kept_in_bv_eur: afterVpb,
    detail: { ...common, dividend: 0, box2: 0 },
  };
  return {
    salary_eur: salary,
    salary_raised_to_minimum: salary > i.salary_eur,
    minimum_salary_eur: bv.minSalary,
    results: [ownBusiness, payout, retain],
  };
}
