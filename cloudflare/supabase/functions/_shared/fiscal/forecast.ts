// Live money forecast. For the tax year: what is due on income billed so far
// (the reserve), what the year costs at the planned hours, and what one more
// euro of revenue or cost does. For the months ahead: the days to bill, when
// each payment lands, and how much of it is tax, living costs and investing.
// For the next year: the same at the latest known rules, as an eenmanszaak
// and as a BV. Pure: callers load the data and pass today's date.
import { type FiscalParams, paramsForYear, round2 } from "./params.ts";
import { type InvoiceRow, summarizeIncome, type TimeEntryRow } from "./ledger.ts";
import { workingCapacity } from "./calendar.ts";
import { estimateIncomeTax, type IncomeTaxResult } from "./incomeTax.ts";
import { kiaFor } from "./costs.ts";
import { compareStructures, type StructureComparison } from "./bv.ts";

export interface Holiday { holiday_date: string; name: string }

/** What the books say about one year's costs. */
export interface YearBooks {
  costs_eur: number;
  depreciation_eur: number;
  kia_qualifying_eur: number;
  awaiting_review: { count: number; amount_eur: number };
  /** Assets marked for full write-off while the year has no startersaftrek. */
  write_off_without_starters: number;
}

/** What the books cannot know: wage, withheld tax, lijfrente, prepayments, days off. */
export interface YearInputs {
  wage_eur: number;
  wage_tax_withheld_eur: number;
  lijfrente_eur: number;
  prepaid_eur: number;
  days_off: number;
  starters_eligible: boolean;
}

export interface PlanSettings {
  hours_per_day: number | null;
  monthly_spending_eur: number | null;
  invest_monthly_eur: number | null;
  dga_salary_eur: number | null;
  bv_annual_costs_eur: number | null;
  reserve_buffer_pct: number;
  horizon_months: number;
}

export interface ForecastData {
  today: string;
  invoices: InvoiceRow[];
  time: TimeEntryRow[];
  books: Map<number, YearBooks>;
  inputs: Map<number, YearInputs>;
  params: Map<number, FiscalParams>;
  holidays: Holiday[];
  settings: PlanSettings;
}

export interface WhatIf {
  hours_per_day?: number;
  days_off?: number;
  extra_cost_eur?: number;
  extra_investment_eur?: number;
  lijfrente_eur?: number;
}

export interface Warning { code: string; severity: "info" | "warn" | "block"; message: string }

export interface YearFigures extends IncomeTaxResult {
  revenue_eur: number;
  costs_eur: number;
  depreciation_eur: number;
  hours: number;
}

export interface WorkMonth {
  month: string;
  working_days: number;
  days_off: number;
  hours: number;
  revenue_eur: number;
  invoice_date: string;
  payment_date: string;
  invoice_number: string | null;
  status: "projected" | "invoiced";
  /** What this invoice adds to its year's tax bill. */
  tax_eur: number;
}

export interface CashMonth {
  month: string;
  payments_eur: number;
  tax_eur: number;
  living_eur: number;
  invest_eur: number;
  left_eur: number;
}

export interface NextYear {
  year: number;
  params_year: number;
  indicative: boolean;
  working_days: number;
  days_off: number;
  figures: YearFigures;
  monthly_set_aside_eur: number;
  structures: StructureComparison | null;
}

export interface Forecast {
  year: number;
  today: string;
  params_year: number;
  params_indicative: boolean;
  rate: { eur_per_hour: number; unit_rate: number; currency: string; fx_eur: number; invoice_number: string | null } | null;
  hours_per_day: number | null;
  payment_lag_days: number | null;
  billed: { through: string | null; hours: number; revenue_eur: number; invoices: number };
  to_date: YearFigures;
  year_end: YearFigures;
  remaining: { from: string; to: string; working_days: number; days_off: number; hours: number; revenue_eur: number } | null;
  reserve_eur: number;
  /** Share of each payment still to come for this year that is tax. */
  set_aside_rate: number;
  marginal: { revenue: number; cost: number };
  timeline: { file_before: string; interest_from: string; interest_rate: number } | null;
  months: WorkMonth[];
  cash: CashMonth[];
  next_year: NextYear | null;
  warnings: Warning[];
}

const DAY_MS = 86_400_000;
const parseDay = (s: string) => new Date(`${s}T00:00:00Z`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  const d = parseDay(day);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

export function monthEnd(day: string): string {
  const d = parseDay(`${day.slice(0, 7)}-01`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return isoDay(d);
}

export function addMonths(month: string, n: number): string {
  const d = parseDay(`${month}-01`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return isoDay(d).slice(0, 7);
}

const daysBetween = (a: string, b: string) => Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / DAY_MS);
const yearOf = (day: string) => Number(day.slice(0, 4));

/** Invoices that are real income: not void, not a linked duplicate, not waiting for review. */
function live(invoices: InvoiceRow[]): InvoiceRow[] {
  return invoices.filter((i) => !i.voided_at && !i.duplicate_of && i.review_state !== "needs_review");
}

const serviceEnd = (i: InvoiceRow) => i.period_end ?? monthEnd(i.period_start ?? i.issued_date);

/** The rate on the most recent invoice, in EUR per hour at that invoice's exchange rate. */
export function latestRate(invoices: InvoiceRow[]): Forecast["rate"] {
  const inv = live(invoices)
    .filter((i) => i.unit_rate && i.amount && (i.currency === "EUR" || i.amount_eur != null))
    .sort((a, b) => serviceEnd(b).localeCompare(serviceEnd(a)))[0];
  if (!inv) return null;
  const fx = inv.currency === "EUR" ? 1 : Number(inv.amount_eur) / Number(inv.amount);
  return {
    eur_per_hour: round2(fx * Number(inv.unit_rate)),
    unit_rate: Number(inv.unit_rate),
    currency: inv.currency,
    fx_eur: Math.round(fx * 1e6) / 1e6,
    invoice_number: inv.invoice_number,
  };
}

/** Days from invoice to payment: the median over paid invoices, else the
 *  latest invoice's own payment term. */
export function paymentLagDays(invoices: InvoiceRow[]): number | null {
  const lags = live(invoices).filter((i) => i.paid_date).map((i) => daysBetween(i.issued_date, i.paid_date!)).sort((a, b) => a - b);
  if (lags.length) {
    const mid = Math.floor(lags.length / 2);
    return lags.length % 2 ? lags[mid] : Math.round((lags[mid - 1] + lags[mid]) / 2);
  }
  const latest = live(invoices).filter((i) => i.due_date).sort((a, b) => b.issued_date.localeCompare(a.issued_date))[0];
  return latest ? daysBetween(latest.issued_date, latest.due_date!) : null;
}

const NO_INPUTS: YearInputs = { wage_eur: 0, wage_tax_withheld_eur: 0, lijfrente_eur: 0, prepaid_eur: 0, days_off: 0, starters_eligible: false };
const NO_BOOKS: YearBooks = { costs_eur: 0, depreciation_eur: 0, kia_qualifying_eur: 0, awaiting_review: { count: 0, amount_eur: 0 }, write_off_without_starters: 0 };

interface YearCase {
  revenue: number;
  costs: number;
  depreciation: number;
  kia: number;
  hours: number;
  inputs: YearInputs;
}

function figures(c: YearCase, p: FiscalParams): YearFigures {
  const r = estimateIncomeTax({
    revenue_eur: c.revenue, deductible_costs_eur: c.costs, depreciation_eur: c.depreciation, kia_eur: c.kia,
    total_hours: c.hours, starters_eligible: c.inputs.starters_eligible, wage_eur: c.inputs.wage_eur,
    wage_tax_withheld_eur: c.inputs.wage_tax_withheld_eur, lijfrente_eur: c.inputs.lijfrente_eur, prepaid_eur: c.inputs.prepaid_eur,
  }, p);
  return { ...r, revenue_eur: round2(c.revenue), costs_eur: round2(c.costs), depreciation_eur: round2(c.depreciation), hours: round2(c.hours) };
}

/** Working days per projected month, with the year's days off spread over
 *  those months in proportion to their working days. */
function workMonths(from: string, to: string, daysOff: number, holidays: Holiday[]): { month: string; start: string; end: string; working_days: number; days_off: number }[] {
  const out: { month: string; start: string; end: string; working_days: number; days_off: number }[] = [];
  let month = from.slice(0, 7);
  while (`${month}-01` <= to) {
    const start = `${month}-01` < from ? from : `${month}-01`;
    const end = monthEnd(`${month}-01`) > to ? to : monthEnd(`${month}-01`);
    out.push({ month, start, end, working_days: workingCapacity(start, end, holidays, 1).working_days, days_off: 0 });
    month = addMonths(month, 1);
  }
  const total = out.reduce((s, m) => s + m.working_days, 0);
  const off = Math.min(Math.max(0, daysOff), total);
  for (const m of out) m.days_off = total > 0 ? round2((off * m.working_days) / total) : 0;
  return out;
}

/** Tax each invoice adds to its year, in billing order: the difference in the
 *  year's total due before and after it. */
function taxIncrements(revenues: number[], base: YearCase, p: FiscalParams): number[] {
  const out: number[] = [];
  let cumulative = 0;
  let before = figures({ ...base, revenue: 0 }, p).total_due;
  for (const r of revenues) {
    cumulative += r;
    const after = figures({ ...base, revenue: cumulative }, p).total_due;
    out.push(round2(after - before));
    before = after;
  }
  return out;
}

export function buildForecast(data: ForecastData, whatIf: WhatIf = {}): Forecast {
  const warnings: Warning[] = [];
  const today = data.today;
  const year = yearOf(today);
  const chosen = paramsForYear(data.params, year);
  if (!chosen) throw new Error(`no tax parameters for ${year} or any earlier year`);
  const p = chosen.params;
  if (chosen.indicative) warnings.push({ code: "indicative_parameters", severity: "warn", message: `Tax rules for ${year} are not loaded yet; this uses ${p.year} rules.` });
  for (const k of p.unverifiedKeys) warnings.push({ code: "unverified_parameter", severity: "warn", message: `Tax rule ${k} is not checked against a primary source yet.` });

  const books = data.books.get(year) ?? NO_BOOKS;
  const baseInputs = data.inputs.get(year) ?? { ...NO_INPUTS };
  const inputs: YearInputs = {
    ...baseInputs,
    days_off: whatIf.days_off ?? baseInputs.days_off,
    lijfrente_eur: whatIf.lijfrente_eur ?? baseInputs.lijfrente_eur,
  };
  const hoursPerDay = whatIf.hours_per_day ?? data.settings.hours_per_day;

  // Costs, with a what-if purchase: an investment above the capitalisation
  // threshold earns KIA and is written off in full in a startersaftrek year,
  // otherwise depreciated straight-line from this month; below it, a cost.
  let costs = books.costs_eur + Math.max(0, whatIf.extra_cost_eur ?? 0);
  let depreciation = books.depreciation_eur;
  let qualifying = books.kia_qualifying_eur;
  const invest = Math.max(0, whatIf.extra_investment_eur ?? 0);
  if (invest > 0 && invest < p.capitalisationThreshold) costs += invest;
  else if (invest > 0) {
    qualifying += invest;
    if (inputs.starters_eligible) depreciation += invest;
    else {
      const life = p.usefulLife.other ?? Math.max(...Object.values(p.usefulLife));
      const monthsLeft = 12 - Number(today.slice(5, 7)) + 1;
      depreciation += (invest / (life * 12)) * monthsLeft;
    }
  }
  const kia = kiaFor(qualifying, p.kia);

  // What is billed, and through which day.
  const ledger = summarizeIncome(data.invoices, data.time, year);
  const counted = new Set(ledger.counted_invoice_ids);
  const yearInvoices = data.invoices.filter((i) => counted.has(i.id)).sort((a, b) => serviceEnd(a).localeCompare(serviceEnd(b)));
  const billedThrough = yearInvoices.length ? serviceEnd(yearInvoices[yearInvoices.length - 1]) : null;
  for (const a of ledger.anomalies) {
    warnings.push({ code: a.code, severity: a.code === "duplicate_period" || a.code === "missing_fx" ? "block" : "warn", message: a.message });
  }

  const rate = latestRate(data.invoices);
  const lag = paymentLagDays(data.invoices);
  if (!rate) warnings.push({ code: "no_rate", severity: "warn", message: "No invoice with an hourly rate yet, so nothing is projected." });
  if (hoursPerDay == null) warnings.push({ code: "no_hours", severity: "warn", message: "Set your hours per day to see the rest of the year." });
  if (lag == null) warnings.push({ code: "no_payment_term", severity: "info", message: "No paid invoice or due date yet, so payment dates are not projected." });
  const calendarYears = new Set(data.holidays.map((h) => yearOf(h.holiday_date)));
  for (const y of [year, year + 1]) {
    if (!calendarYears.has(y)) warnings.push({ code: "no_holidays", severity: "info", message: `No public holidays loaded for ${y}; working days count weekdays only.` });
  }

  // The rest of this year at the planned hours.
  const yearEndDay = `${year}-12-31`;
  const from = billedThrough ? addDays(billedThrough, 1) : `${year}-01-01`;
  const canProject = rate != null && hoursPerDay != null && from <= yearEndDay;
  const thisYearMonths = canProject ? workMonths(from, yearEndDay, inputs.days_off, data.holidays) : [];
  const projected = thisYearMonths.map((m) => {
    const hours = round2(Math.max(0, m.working_days - m.days_off) * hoursPerDay!);
    return { ...m, hours, revenue: round2(hours * rate!.eur_per_hour) };
  });
  const remaining = canProject ? {
    from, to: yearEndDay,
    working_days: projected.reduce((s, m) => s + m.working_days, 0),
    days_off: round2(projected.reduce((s, m) => s + m.days_off, 0)),
    hours: round2(projected.reduce((s, m) => s + m.hours, 0)),
    revenue_eur: round2(projected.reduce((s, m) => s + m.revenue, 0)),
  } : null;

  const workedHours = ledger.billed_hours + ledger.non_billable_hours;
  const yearHours = workedHours + (remaining?.hours ?? 0);
  const caseToDate: YearCase = { revenue: ledger.revenue_eur, costs, depreciation, kia, hours: workedHours, inputs };
  const caseYearEnd: YearCase = { ...caseToDate, revenue: ledger.revenue_eur + (remaining?.revenue_eur ?? 0), hours: yearHours };
  const toDate = figures(caseToDate, p);
  const yearEnd = figures(caseYearEnd, p);
  if (!yearEnd.urencriterium_met) {
    warnings.push({ code: "urencriterium", severity: "warn", message: `${round2(yearHours)} of ${p.urencriteriumHours} hours this year; without them there is no zelfstandigenaftrek.` });
  }
  if (books.awaiting_review.count) {
    warnings.push({ code: "expenses_awaiting_review", severity: "info", message: `${books.awaiting_review.count} business cost(s), ${books.awaiting_review.amount_eur.toFixed(2)} EUR, wait for your review and are not counted yet.` });
  }
  if (books.write_off_without_starters && !inputs.starters_eligible) {
    warnings.push({ code: "write_off_needs_startersaftrek", severity: "warn", message: "An asset is marked for full write-off, which is only allowed in a year with startersaftrek." });
  }

  // The reserve: tax due on income billed so far, less what is already paid, plus the buffer.
  const reserve = round2(Math.max(0, toDate.to_pay) * (1 + data.settings.reserve_buffer_pct));

  // Marginal rates at the year-end position.
  const step = 100;
  const plusRevenue = figures({ ...caseYearEnd, revenue: caseYearEnd.revenue + step }, p).total_due;
  const plusCost = figures({ ...caseYearEnd, costs: caseYearEnd.costs + step }, p).total_due;
  const marginal = { revenue: round2((plusRevenue - yearEnd.total_due) / step * 10000) / 10000, cost: round2((yearEnd.total_due - plusCost) / step * 10000) / 10000 };

  // Tax per invoice, issued and projected, in billing order.
  const billedRevenues = yearInvoices.map((i) => (i.currency === "EUR" ? i.amount : i.amount_eur ?? 0));
  const increments = taxIncrements([...billedRevenues, ...projected.map((m) => m.revenue)], { ...caseYearEnd, revenue: 0 }, p);
  const billedTax = increments.slice(0, billedRevenues.length);
  const projectedTax = increments.slice(billedRevenues.length);
  const projectedRevenue = projected.reduce((s, m) => s + m.revenue, 0);
  const setAsideRate = projectedRevenue > 0 ? round2(projectedTax.reduce((s, t) => s + t, 0) / projectedRevenue * 10000) / 10000 : marginal.revenue;

  const months: WorkMonth[] = [];
  // Issued invoices that are not paid yet.
  yearInvoices.forEach((inv, k) => {
    if (inv.paid_date) return;
    const expected = inv.due_date ?? (lag != null ? addDays(inv.issued_date, lag) : null);
    if (!expected) return;
    if (expected < today) warnings.push({ code: "overdue", severity: "warn", message: `${inv.invoice_number ?? inv.id} was due ${expected} and is not marked paid.` });
    months.push({
      month: (inv.period_start ?? inv.issued_date).slice(0, 7), working_days: 0, days_off: 0, hours: inv.hours ?? 0,
      revenue_eur: round2(billedRevenues[k]), invoice_date: inv.issued_date, payment_date: expected < today ? today : expected,
      invoice_number: inv.invoice_number, status: "invoiced", tax_eur: billedTax[k],
    });
  });
  if (lag != null) {
    projected.forEach((m, k) => months.push({
      month: m.month, working_days: m.working_days, days_off: m.days_off, hours: m.hours, revenue_eur: m.revenue,
      invoice_date: monthEnd(`${m.month}-01`), payment_date: addDays(monthEnd(`${m.month}-01`), lag),
      invoice_number: null, status: "projected", tax_eur: projectedTax[k],
    }));
  }

  // Next year at the latest known rules.
  let nextYear: NextYear | null = null;
  const nextChosen = paramsForYear(data.params, year + 1);
  if (nextChosen && rate && hoursPerDay != null) {
    const ny = year + 1;
    const nyInputs = data.inputs.get(ny) ?? { ...NO_INPUTS };
    const nyMonths = workMonths(`${ny}-01-01`, `${ny}-12-31`, nyInputs.days_off, data.holidays);
    const nyRevenues = nyMonths.map((m) => round2(Math.max(0, m.working_days - m.days_off) * hoursPerDay * rate.eur_per_hour));
    const nyHours = nyMonths.reduce((s, m) => s + Math.max(0, m.working_days - m.days_off) * hoursPerDay, 0);
    // Business costs run at this year's level; nothing is depreciated or invested yet.
    const nyCase: YearCase = { revenue: nyRevenues.reduce((s, r) => s + r, 0), costs: books.costs_eur, depreciation: 0, kia: 0, hours: nyHours, inputs: nyInputs };
    const np = nextChosen.params;
    const nyFigures = figures(nyCase, np);
    // Next year is a plan, not a ledger: every month carries the year's average
    // rate, so early months are not under-reserved by the bracket order.
    const nyRate = nyCase.revenue > 0 ? Math.max(0, nyFigures.total_due) / nyCase.revenue : 0;
    const nyTax = nyRevenues.map((r) => round2(r * nyRate));
    if (lag != null) {
      nyMonths.forEach((m, k) => months.push({
        month: m.month, working_days: m.working_days, days_off: m.days_off,
        hours: round2(Math.max(0, m.working_days - m.days_off) * hoursPerDay), revenue_eur: nyRevenues[k],
        invoice_date: monthEnd(`${m.month}-01`), payment_date: addDays(monthEnd(`${m.month}-01`), lag),
        invoice_number: null, status: "projected", tax_eur: nyTax[k],
      }));
    }
    const salary = data.settings.dga_salary_eur;
    const bvCosts = data.settings.bv_annual_costs_eur;
    const structures = salary != null && bvCosts != null
      ? compareStructures({
        revenue_eur: nyCase.revenue, costs_eur: nyCase.costs, depreciation_eur: 0, kia_eur: 0, hours: nyHours,
        starters_eligible: nyInputs.starters_eligible, salary_eur: salary, bv_costs_eur: bvCosts,
      }, np)
      : null;
    if (np.bv && (salary == null || bvCosts == null)) warnings.push({ code: "bv_settings", severity: "info", message: "Set a DGA salary and BV running costs to compare with a BV." });
    if (structures?.salary_raised_to_minimum) warnings.push({ code: "bv_salary_minimum", severity: "info", message: `The BV salary is raised to the legal minimum of ${structures.minimum_salary_eur} EUR.` });
    nextYear = {
      year: ny, params_year: np.year, indicative: nextChosen.indicative,
      working_days: nyMonths.reduce((s, m) => s + m.working_days, 0),
      days_off: round2(nyMonths.reduce((s, m) => s + m.days_off, 0)),
      figures: nyFigures, monthly_set_aside_eur: round2(Math.max(0, nyFigures.to_pay) / 12), structures,
    };
  }

  // Cash by month from this month: payments in, the tax share, living costs
  // and investing. This month's spending so far is already in your balances
  // and this month's investing is shown on its own, so the current month
  // only counts the payments still to land.
  const cash: CashMonth[] = [];
  const living = data.settings.monthly_spending_eur ?? 0;
  const investing = data.settings.invest_monthly_eur ?? 0;
  for (let k = 0; k < data.settings.horizon_months; k++) {
    const month = addMonths(today.slice(0, 7), k);
    const landing = months.filter((m) => m.payment_date.slice(0, 7) === month && m.payment_date >= today);
    const payments = round2(landing.reduce((s, m) => s + m.revenue_eur, 0));
    const tax = round2(landing.reduce((s, m) => s + m.tax_eur, 0));
    const spend = k === 0 ? 0 : living;
    const put = k === 0 ? 0 : investing;
    cash.push({ month, payments_eur: payments, tax_eur: tax, living_eur: spend, invest_eur: put, left_eur: round2(payments - tax - spend - put) });
  }
  const horizonEnd = monthEnd(`${addMonths(today.slice(0, 7), data.settings.horizon_months - 1)}-01`);

  const interest = p.belastingrente;
  return {
    year,
    today,
    params_year: p.year,
    params_indicative: chosen.indicative,
    rate,
    hours_per_day: hoursPerDay,
    payment_lag_days: lag,
    billed: { through: billedThrough, hours: ledger.billed_hours, revenue_eur: ledger.revenue_eur, invoices: yearInvoices.length },
    to_date: toDate,
    year_end: yearEnd,
    remaining,
    reserve_eur: reserve,
    set_aside_rate: setAsideRate,
    marginal,
    timeline: interest ? { file_before: `${year + 1}-${interest.file_before}`, interest_from: `${year + 1}-${interest.interest_from}`, interest_rate: interest.rate } : null,
    months: months.filter((m) => m.payment_date >= today && m.payment_date <= horizonEnd).sort((a, b) => a.payment_date.localeCompare(b.payment_date)),
    cash,
    next_year: nextYear,
    warnings,
  };
}

/** The reserve for a past year that may still be unpaid: its full income is
 *  billed, so the reserve is that year's tax less what was already paid. */
export function closedYearReserve(data: ForecastData, year: number): { reserve_eur: number; figures: YearFigures; params_year: number; indicative: boolean } | null {
  const chosen = paramsForYear(data.params, year);
  if (!chosen) return null;
  const books = data.books.get(year) ?? NO_BOOKS;
  const inputs = data.inputs.get(year) ?? { ...NO_INPUTS };
  const ledger = summarizeIncome(data.invoices, data.time, year);
  const f = figures({
    revenue: ledger.revenue_eur, costs: books.costs_eur, depreciation: books.depreciation_eur,
    kia: kiaFor(books.kia_qualifying_eur, chosen.params.kia), hours: ledger.billed_hours + ledger.non_billable_hours, inputs,
  }, chosen.params);
  return {
    reserve_eur: round2(Math.max(0, f.to_pay) * (1 + data.settings.reserve_buffer_pct)),
    figures: f, params_year: chosen.params.year, indicative: chosen.indicative,
  };
}
