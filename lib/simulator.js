'use strict';
/**
 * lib/simulator.js — Role & project forecasting engine
 *
 * Atom-of-thought decomposition:
 *   Revenue atom  — gross billing: rate × hours × days
 *   Margin atom   — agency cut deducted from gross
 *   Tax atom      — NL ZZP 2026 brackets (Box 1 + MKB + ZVW + zelfstandigenaftrek)
 *   Time atom     — start/end, gap period before first invoice, payment lag
 *   Cost atom     — monthly burn rate during active and gap periods
 *   Risk atom     — probability weight, renewal chance, scenario bands
 *
 * Everything is stateless / pure — no I/O, no Notion calls.
 * The /api/simulate route calls these functions with client-supplied params.
 */

// ── NL Tax Constants 2026 ──────────────────────────────────────────────────────
const NL_TAX = {
  bracket1Rate:  0.3575,   // Box 1, up to €38,441
  bracket1Limit: 38441,
  bracket2Rate:  0.3756,   // Box 1, €38,441 – €76,817
  bracket2Limit: 76817,
  bracket3Rate:  0.4950,   // Box 1, above €76,817
  mkbPct:        0.127,    // MKB-winstvrijstelling (self-employed profit exemption)
  zvwRate:       0.0485,   // Zorgverzekeringswet (healthcare contribution)
  zvwCap:        71628,    // ZVW premium cap
  zelfstandigenAftrek: 2470, // Self-employed deduction (ZA)
  startersAftrek: 0,       // Only for first 3 years; assume 0 by default
};

/**
 * Compute annual NL ZZP tax on a given gross annual profit.
 * Returns { taxableProfit, mkbDeduction, zvw, incomeTax, totalTax, effectiveRate, netProfit }
 *
 * @param {number} grossAnnualProfit  — turnover minus deductible business costs
 * @param {object} [overrides]        — optional { mkbPct, zvwRate, zelfstandigenAftrek }
 */
function calcNLTax(grossAnnualProfit, overrides = {}) {
  const mkbPct  = overrides.mkbPct  ?? NL_TAX.mkbPct;
  const zvwRate = overrides.zvwRate ?? NL_TAX.zvwRate;
  const za      = overrides.zelfstandigenAftrek ?? NL_TAX.zelfstandigenAftrek;

  // Step 1 — Apply ZA (zelfstandigenaftrek)
  const afterZA = Math.max(0, grossAnnualProfit - za);

  // Step 2 — MKB-winstvrijstelling (applied after ZA)
  const mkbDeduction = afterZA * mkbPct;
  const taxableIncome = Math.max(0, afterZA - mkbDeduction);

  // Step 3 — Box 1 income tax (progressive)
  let incomeTax = 0;
  if (taxableIncome <= NL_TAX.bracket1Limit) {
    incomeTax = taxableIncome * NL_TAX.bracket1Rate;
  } else if (taxableIncome <= NL_TAX.bracket2Limit) {
    incomeTax = NL_TAX.bracket1Limit * NL_TAX.bracket1Rate
              + (taxableIncome - NL_TAX.bracket1Limit) * NL_TAX.bracket2Rate;
  } else {
    incomeTax = NL_TAX.bracket1Limit  * NL_TAX.bracket1Rate
              + (NL_TAX.bracket2Limit - NL_TAX.bracket1Limit) * NL_TAX.bracket2Rate
              + (taxableIncome - NL_TAX.bracket2Limit) * NL_TAX.bracket3Rate;
  }

  // Step 4 — ZVW (healthcare; levied on profit, capped)
  const zvwBase = Math.min(grossAnnualProfit, NL_TAX.zvwCap);
  const zvw     = zvwBase * zvwRate;

  const totalTax    = incomeTax + zvw;
  const netProfit   = grossAnnualProfit - totalTax;
  const effectiveRate = grossAnnualProfit > 0 ? totalTax / grossAnnualProfit : 0;

  return {
    grossAnnualProfit: round2(grossAnnualProfit),
    mkbDeduction:      round2(mkbDeduction),
    taxableIncome:     round2(taxableIncome),
    incomeTax:         round2(incomeTax),
    zvw:               round2(zvw),
    totalTax:          round2(totalTax),
    netProfit:         round2(netProfit),
    effectiveRate:     round4(effectiveRate),
  };
}

// ── Monthly revenue atom ───────────────────────────────────────────────────────

/**
 * Gross monthly billing from a single scenario.
 * @param {object} s — scenario params (see buildScenario)
 * @param {number} monthIdx — 0-indexed month within the active period
 */
function monthlyGross(s) {
  const dailyRate  = s.hourlyRate > 0 ? s.hourlyRate * s.hoursPerDay : s.dayRate;
  const gross      = dailyRate * s.workDaysPerMonth;
  const net        = gross * (1 - (s.agencyMarginPct ?? 0) / 100);
  return { gross: round2(gross), netOfAgency: round2(net) };
}

// ── Core: build a monthly cashflow projection for ONE scenario ─────────────────

/**
 * Project 18 months of cashflow for a scenario.
 *
 * @param {object} scenario — see defaultScenario()
 * @param {object} [taxOverrides] — optional NL tax overrides from user config
 * @returns {object} { months: [...], summary: {...}, tax: {...} }
 */
function project(scenario, taxOverrides = {}) {
  const s = { ...defaultScenario(), ...scenario };

  // Normalise dates
  const today       = new Date();
  const startDate   = s.startDate ? new Date(s.startDate) : today;
  const endDate     = s.endDate   ? new Date(s.endDate)   : addMonths(startDate, s.likelyMonths);

  // How many full months until contract starts (gap)
  const gapMonths   = monthsBetween(today, startDate);
  const activeMonths = Math.max(1, monthsBetween(startDate, endDate));

  const { gross, netOfAgency } = monthlyGross(s);

  const months = [];

  // ── Gap period (pre-contract) ──────────────────────────────────────────────
  for (let i = 0; i < Math.max(0, gapMonths); i++) {
    const dt = addMonths(today, i);
    months.push({
      monthIdx:       i,
      label:          monthLabel(dt),
      date:           dtStr(dt),
      phase:          'gap',
      grossRevenue:   0,
      agencyMargin:   0,
      netRevenue:     0,
      monthlyBurn:    s.monthlyBurn,
      netCashflow:    -s.monthlyBurn,
    });
  }

  // ── Active contract period ─────────────────────────────────────────────────
  for (let i = 0; i < activeMonths; i++) {
    const dt = addMonths(startDate, i);
    const payLagAdj = i === 0 ? -s.payLagDays / 30 : 0; // first invoice arrives late
    months.push({
      monthIdx:       gapMonths + i,
      label:          monthLabel(dt),
      date:           dtStr(dt),
      phase:          'active',
      grossRevenue:   round2(gross),
      agencyMargin:   round2(gross - netOfAgency),
      netRevenue:     round2(netOfAgency),
      monthlyBurn:    s.monthlyBurn,
      netCashflow:    round2(netOfAgency - s.monthlyBurn),
    });
  }

  // ── Pad to 18 months total ─────────────────────────────────────────────────
  const totalMonths = 18;
  while (months.length < totalMonths) {
    const dt = addMonths(today, months.length);
    months.push({
      monthIdx:       months.length,
      label:          monthLabel(dt),
      date:           dtStr(dt),
      phase:          'post',
      grossRevenue:   0,
      agencyMargin:   0,
      netRevenue:     0,
      monthlyBurn:    s.monthlyBurn,
      netCashflow:    -s.monthlyBurn,
    });
  }

  // ── Running cumulative balance ─────────────────────────────────────────────
  let runningBalance = s.currentBalance ?? 0;
  for (const m of months) {
    runningBalance += m.netCashflow;
    m.cumulativeNet = round2(runningBalance);
  }

  // ── Annual tax estimate ────────────────────────────────────────────────────
  const annualNetRevenue = months
    .filter(m => m.phase === 'active')
    .slice(0, 12)
    .reduce((sum, m) => sum + m.netRevenue, 0);

  const annualBurn = s.monthlyBurn * 12;
  const annualProfit = Math.max(0, annualNetRevenue - annualBurn);

  const tax = calcNLTax(annualProfit, {
    mkbPct:  taxOverrides.mkbPct  != null ? taxOverrides.mkbPct / 100  : undefined,
    zvwRate: taxOverrides.zvwPct  != null ? taxOverrides.zvwPct / 100  : undefined,
    zelfstandigenAftrek: taxOverrides.za ?? undefined,
  });

  // ── Monthly tax reserve ────────────────────────────────────────────────────
  const monthlyTaxReserve = activeMonths > 0 ? tax.totalTax / 12 : 0;
  for (const m of months) {
    m.taxReserve   = m.phase === 'active' ? round2(monthlyTaxReserve) : 0;
    m.netAfterTax  = round2(m.netCashflow - m.taxReserve);
  }

  // ── Summary metrics ───────────────────────────────────────────────────────
  const activeSlice = months.filter(m => m.phase === 'active');
  const totalGross  = sum(activeSlice, 'grossRevenue');
  const totalNet    = sum(activeSlice, 'netRevenue');
  const totalBurn   = sum(months, 'monthlyBurn');
  const totalTaxRes = sum(activeSlice, 'taxReserve');

  const summary = {
    scenarioName:     s.name,
    gapMonths:        round1(gapMonths),
    activeMonths,
    totalGrossRevenue:round2(totalGross),
    totalAgencyMargin:round2(totalGross - totalNet),
    totalNetRevenue:  round2(totalNet),
    totalBurn:        round2(totalBurn),
    totalTaxReserve:  round2(totalTaxRes),
    netTakeHome18m:   round2(totalNet - totalBurn - totalTaxRes),
    dailyRate:        round2(s.dayRate || s.hourlyRate * s.hoursPerDay),
    effectiveTaxRate: tax.effectiveRate,
    annualNetProfit:  tax.netProfit,
  };

  return { months, summary, tax };
}

// ── Scenario band generator (min / likely / max durations) ────────────────────

/**
 * Generate three projections — pessimistic, likely, optimistic — for duration.
 * Produces month-by-month upper/lower bands suitable for Chart.js fill.
 */
function projectWithBands(scenario, taxOverrides = {}) {
  const s = { ...defaultScenario(), ...scenario };

  const minS  = { ...s, endDate: null, likelyMonths: s.minMonths    ?? Math.max(1, (s.likelyMonths ?? 6) - 2) };
  const likeS = { ...s, endDate: null, likelyMonths: s.likelyMonths ?? 6 };
  const maxS  = { ...s, endDate: null, likelyMonths: s.maxMonths    ?? (s.likelyMonths ?? 6) + 3 };

  const pMin   = project(minS,  taxOverrides);
  const pLike  = project(likeS, taxOverrides);
  const pMax   = project(maxS,  taxOverrides);

  // Align all to 18 months (already padded by project())
  return {
    likely:  pLike,
    min:     pMin,
    max:     pMax,
  };
}

// ── Comparison: baseline vs scenario ─────────────────────────────────────────

/**
 * Compare two scenarios side by side with crossover detection.
 *
 * @param {object} baseline  — current contract scenario
 * @param {object} candidate — new role / opportunity scenario
 * @param {object} taxOverrides
 * @returns {object}
 */
function compare(baseline, candidate, taxOverrides = {}) {
  const b = project(baseline, taxOverrides);
  const c = projectWithBands(candidate, taxOverrides);

  const months = b.months.map((bm, i) => {
    const cm = c.likely.months[i] || { cumulativeNet: null, netAfterTax: null, phase: 'post' };
    return {
      label:             bm.label,
      date:              bm.date,
      baseline:          bm.cumulativeNet,
      scenario:          cm.cumulativeNet,
      scenarioBandMin:   (c.min.months[i]  || {}).cumulativeNet ?? null,
      scenarioBandMax:   (c.max.months[i]  || {}).cumulativeNet ?? null,
      baselinePhase:     bm.phase,
      scenarioPhase:     cm.phase,
    };
  });

  // Crossover: first month where candidate cumulative exceeds baseline
  let crossoverMonth = null;
  for (const m of months) {
    if (m.scenario != null && m.baseline != null && m.scenario > m.baseline) {
      crossoverMonth = m.label;
      break;
    }
  }

  // Delta metrics at 6 / 12 / 18 months
  const delta = [6, 12, 18].map(n => {
    const bv = months[n - 1]?.baseline ?? null;
    const cv = months[n - 1]?.scenario ?? null;
    return {
      months: n,
      baselineCumulative:  bv,
      scenarioCumulative:  cv,
      delta:               bv != null && cv != null ? round2(cv - bv) : null,
    };
  });

  const breakEvenGapCost = b.summary.gapMonths > 0
    ? round2(baseline.monthlyBurn * b.summary.gapMonths)
    : 0;

  return {
    months,
    baseline:       b.summary,
    scenario:       c.likely.summary,
    scenarioBands:  { min: c.min.summary, max: c.max.summary },
    baselineTax:    b.tax,
    scenarioTax:    c.likely.tax,
    crossoverMonth,
    delta,
    breakEvenGapCost,
    recommendation: recommend(b.summary, c.likely.summary, crossoverMonth, delta),
  };
}

// ── Rule-based recommendation ──────────────────────────────────────────────────

function recommend(baseline, scenario, crossoverMonth, delta) {
  const d12 = delta.find(d => d.months === 12);
  if (!d12 || d12.delta === null) return null;

  const signals = [];

  if (d12.delta > 0) {
    signals.push(`Scenario leads baseline by €${d12.delta.toLocaleString()} at 12 months.`);
  } else {
    signals.push(`Baseline leads scenario by €${Math.abs(d12.delta).toLocaleString()} at 12 months.`);
  }

  if (crossoverMonth) {
    signals.push(`Crossover (scenario catches up) at ${crossoverMonth}.`);
  } else if (d12.delta < 0) {
    signals.push('Scenario never catches up within 18 months — weigh non-financial factors.');
  }

  if (scenario.gapMonths > 1) {
    signals.push(`Gap period: ${Math.round(scenario.gapMonths)} months with €${scenario.gapMonths * scenario.monthlyBurn | 0} burn.`);
  }

  if (scenario.effectiveTaxRate < baseline.effectiveTaxRate) {
    signals.push(`Lower effective tax rate (${(scenario.effectiveTaxRate*100).toFixed(1)}% vs ${(baseline.effectiveTaxRate*100).toFixed(1)}%).`);
  }

  return signals;
}

// ── Default scenario template ─────────────────────────────────────────────────

function defaultScenario() {
  return {
    name:             'Scenario',
    hourlyRate:       0,
    dayRate:          0,
    hoursPerDay:      8,
    workDaysPerMonth: 20,
    agencyMarginPct:  0,    // % taken by agency (e.g. 10 = 10%)
    monthlyBurn:      0,
    currentBalance:   0,
    startDate:        null, // ISO date string; null = today
    endDate:          null, // ISO date string; null = derived from likelyMonths
    likelyMonths:     6,
    minMonths:        4,
    maxMonths:        9,
    payLagDays:       30,
    renewalProbability: 0.5,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function round2(n) { return Math.round((n || 0) * 100) / 100; }
function round4(n) { return Math.round((n || 0) * 10000) / 10000; }
function round1(n) { return Math.round((n || 0) * 10) / 10; }
function sum(arr, key) { return arr.reduce((s, x) => s + (x[key] || 0), 0); }

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

function monthsBetween(a, b) {
  const d1 = new Date(a);
  const d2 = new Date(b);
  return Math.max(0, (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth()));
}

function monthLabel(d) {
  return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}

function dtStr(d) {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  project,
  projectWithBands,
  compare,
  calcNLTax,
  defaultScenario,
  NL_TAX,
};
