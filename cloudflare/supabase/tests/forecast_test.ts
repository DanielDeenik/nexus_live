// Forecast, wage, tariefsaanpassing and BV tests on made-up numbers. The tax
// rules are the 2026 seed the migrations load (tax_parameters_2026.json).
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import rows from "./tax_parameters_2026.json" with { type: "json" };
import {
  type AssetRow, type ForecastData, type InvoiceRow, buildForecast, closedYearReserve, compareStructures,
  depreciationForYear, estimateIncomeTax, paramsFromRows, paymentLagDays,
} from "../functions/_shared/fiscal/index.ts";

const p = paramsFromRows(rows as never, 2026);
const base = { revenue_eur: 100000, deductible_costs_eur: 0, depreciation_eur: 0, kia_eur: 0, total_hours: 1502, starters_eligible: false };

Deno.test("tariefsaanpassing counts income before the deductions", () => {
  // Profit 85,000: taxable 73,157.40 sits below the top bracket, but 6,574 of
  // the 11,842.60 deductions would have been taxed at the top rate.
  const r = estimateIncomeTax({ ...base, revenue_eur: 85000 }, p);
  assertAlmostEquals(r.taxable_profit, 73157.4, 0.01);
  assertAlmostEquals(r.tariefsaanpassing, 784.94, 0.01);
});

Deno.test("wage: taxed with the profit, Zvw cap shrinks, withheld tax is paid", () => {
  const r = estimateIncomeTax({ ...base, wage_eur: 10000, wage_tax_withheld_eur: 3500 }, p);
  assertAlmostEquals(r.box1_income, 96252.4, 0.01);
  assertAlmostEquals(r.income_tax_before_credits, 39218.55, 0.02);
  assertAlmostEquals(r.arbeidskorting, 1492.04, 0.02);
  // 4.85% of 79,409 - 10,000
  assertAlmostEquals(r.zvw, 3366.34, 0.01);
  assertAlmostEquals(r.total_due, 41092.85, 0.05);
  assertAlmostEquals(r.to_pay, 37592.85, 0.05);
});

Deno.test("lijfrente: deducted at the top rate, outside the tariefsaanpassing", () => {
  const without = estimateIncomeTax(base, p);
  const r = estimateIncomeTax({ ...base, lijfrente_eur: 5000 }, p);
  assertAlmostEquals(without.income_tax_before_credits - r.income_tax_before_credits, 2475, 0.02);
  assertEquals(r.tariefsaanpassing, without.tariefsaanpassing);
  assertEquals(r.zvw, without.zvw);
});

Deno.test("full write-off: all in the purchase year", () => {
  const a: AssetRow = { id: "a", description: "computer", acquired_date: "2026-10-10", cost_excl_vat: 825.62, residual_value: 0, useful_life_years: 5, kia_eligible: true, status: "active", full_write_off: true };
  assertEquals(depreciationForYear(a, 2026), 825.62);
  assertEquals(depreciationForYear(a, 2027), 0);
});

// Ten months billed in EUR at 100 an hour; January to September paid 45 days
// after the invoice, October still open.
const months = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"];
const lastDay = (m: string) => new Date(Date.UTC(2026, Number(m), 0)).toISOString().slice(0, 10);
const plus = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const invoices: InvoiceRow[] = months.map((m) => ({
  id: `I${m}`, invoice_number: `T-${m}`, client: "Client", amount: 16000, currency: "EUR", amount_eur: 16000,
  status: m === "10" ? "pending" : "paid", issued_date: lastDay(m), period_start: `2026-${m}-01`, period_end: lastDay(m),
  hours: 160, unit_rate: 100, duplicate_of: null, voided_at: null, review_state: "confirmed",
  due_date: plus(lastDay(m), 45), paid_date: m === "10" ? null : plus(lastDay(m), 45),
}));

function data(over: Partial<ForecastData> = {}): ForecastData {
  return {
    today: "2026-11-24",
    invoices,
    time: [],
    books: new Map([[2026, { costs_eur: 5000, depreciation_eur: 0, kia_qualifying_eur: 0, awaiting_review: { count: 0, amount_eur: 0 }, write_off_without_starters: 0 }]]),
    inputs: new Map([[2026, { wage_eur: 0, wage_tax_withheld_eur: 0, lijfrente_eur: 0, prepaid_eur: 0, days_off: 0, starters_eligible: true }]]),
    params: new Map([[2026, p]]),
    holidays: [],
    settings: { hours_per_day: 8, monthly_spending_eur: 3000, invest_monthly_eur: 2000, dga_salary_eur: 75000, bv_annual_costs_eur: 3000, reserve_buffer_pct: 0.05, horizon_months: 12 },
    ...over,
  };
}

Deno.test("payment lag: median of paid invoices", () => {
  assertEquals(paymentLagDays(invoices), 45);
});

Deno.test("forecast: projects from the day after the last billed period, not from today", () => {
  const f = buildForecast(data());
  assertEquals(f.billed.through, "2026-10-31");
  assertEquals(f.remaining?.from, "2026-11-01");
  // 21 weekdays in November and 23 in December 2026, no holidays loaded
  assertEquals(f.remaining?.working_days, 44);
  assertEquals(f.remaining?.hours, 352);
  assertEquals(f.remaining?.revenue_eur, 35200);
  assertEquals(f.year_end.revenue_eur, 195200);
  // Without the October invoice, October's days are projected too.
  const g = buildForecast(data({ invoices: invoices.filter((i) => i.id !== "I10") }));
  assertEquals(g.remaining?.from, "2026-10-01");
});

Deno.test("forecast: reserve covers billed income plus the buffer", () => {
  const f = buildForecast(data());
  assertAlmostEquals(f.reserve_eur, f.to_date.to_pay * 1.05, 0.02);
  assertEquals(f.to_date.revenue_eur, 160000);
});

Deno.test("forecast: payments land 45 days after each invoice and carry their tax", () => {
  const f = buildForecast(data());
  const oct = f.months.find((m) => m.invoice_number === "T-10")!;
  assertEquals(oct.payment_date, "2026-12-15");
  assertEquals(oct.status, "invoiced");
  const nov = f.months.find((m) => m.month === "2026-11")!;
  assertEquals(nov.payment_date, "2027-01-14");
  assertEquals(nov.revenue_eur, 16800);
  // Deep in the top bracket each extra euro carries the marginal rate.
  assertAlmostEquals(nov.tax_eur / nov.revenue_eur, f.marginal.revenue, 0.002);
  const dec = f.cash.find((c) => c.month === "2026-12")!;
  assertEquals(dec.payments_eur, 16000);
  assertEquals(dec.living_eur, 3000);
  assertEquals(dec.invest_eur, 2000);
  assertAlmostEquals(dec.left_eur, 16000 - dec.tax_eur - 5000, 0.01);
  // This month only counts payments still to come; spending is already in the balances.
  assertEquals(f.cash[0].month, "2026-11");
  assertEquals(f.cash[0].living_eur, 0);
});

Deno.test("forecast: what-if hours and a purchase", () => {
  const baseF = buildForecast(data());
  const more = buildForecast(data(), { hours_per_day: 10 });
  assertEquals(more.remaining?.hours, 440);
  const bought = buildForecast(data(), { extra_investment_eur: 3000 });
  // KIA 28% plus a full write-off in a startersaftrek year
  assertAlmostEquals(bought.year_end.kia, 840, 0.01);
  assertEquals(bought.year_end.depreciation_eur, 3000);
  assertEquals(bought.year_end.total_due < baseF.year_end.total_due, true);
});

Deno.test("forecast: next year at the latest rules, eenmanszaak against BV", () => {
  const f = buildForecast(data());
  const ny = f.next_year!;
  assertEquals(ny.year, 2027);
  assertEquals(ny.indicative, true);
  // 261 weekdays in 2027 at 8 hours and 100 an hour
  assertEquals(ny.figures.revenue_eur, 208800);
  assertAlmostEquals(ny.figures.total_due, 84549.51, 0.05);
  const s = ny.structures!;
  const by = Object.fromEntries(s.results.map((r) => [r.label, r]));
  assertAlmostEquals(by.eenmanszaak.net_to_you_eur, 119250.49, 0.05);
  assertAlmostEquals(by.bv_retain.detail.vpb, 23032.75, 0.02);
  assertAlmostEquals(by.bv_retain.net_to_you_eur, 51523.33, 0.05);
  assertAlmostEquals(by.bv_retain.kept_in_bv_eur, 98192.25, 0.02);
  assertAlmostEquals(by.bv_payout.detail.box2, 25964.8, 0.02);
  assertAlmostEquals(by.bv_payout.net_to_you_eur, 123750.78, 0.05);
});

Deno.test("bv: salary below the legal minimum is raised", () => {
  const s = compareStructures({ revenue_eur: 100000, costs_eur: 0, depreciation_eur: 0, kia_eur: 0, hours: 1500, starters_eligible: false, salary_eur: 40000, bv_costs_eur: 0 }, p)!;
  assertEquals(s.salary_eur, 58000);
  assertEquals(s.salary_raised_to_minimum, true);
});

Deno.test("closed year: reserve is the full year's tax less what was paid", () => {
  const r = closedYearReserve(data({ inputs: new Map([[2026, { wage_eur: 0, wage_tax_withheld_eur: 0, lijfrente_eur: 0, prepaid_eur: 10000, days_off: 0, starters_eligible: true }]]) }), 2026)!;
  assertAlmostEquals(r.reserve_eur, (r.figures.total_due - 10000) * 1.05, 0.02);
});
