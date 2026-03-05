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
  const raw = { ...defaultScenario(), ...scenario };

  // ── Derive monthlyBurn from fixed + variable splits (fall back to legacy field) ──
  if (!raw.monthlyBurn || raw.monthlyBurn === 0) {
    raw.monthlyBurn = round2((raw.fixedCostsEur || 0) + (raw.variableCostsEur || 0));
  }

  const s   = applyScenarioType(raw);  // transform based on Scenario Type

  // ── Seasonal burn resolver: uses ML baseline for that calendar month ───────
  // Fixed costs are always honoured as the floor (rent/subscriptions don't
  // vary seasonally). The seasonal value overrides the variable portion only
  // when it exceeds fixedCostsEur; otherwise we use the flat monthlyBurn.
  const _getBurnForMonth = (date) => {
    const calMonth = date.getMonth() + 1; // 1–12
    if (s.seasonalBurnMap && s.seasonalBurnMap[calMonth] != null) {
      const seasonal = s.seasonalBurnMap[calMonth];
      // Never go below fixed costs (rent still due even in a low-spend month)
      return round2(Math.max(s.fixedCostsEur || 0, seasonal));
    }
    return s.monthlyBurn;
  };

  // Normalise dates
  const today       = new Date();
  const startDate   = s.startDate ? new Date(s.startDate) : today;
  const endDate     = s.endDate   ? new Date(s.endDate)   : addMonths(startDate, s.likelyMonths);

  // How many full months until contract starts (gap)
  const gapMonths   = monthsBetween(today, startDate);
  const activeMonths = Math.max(1, monthsBetween(startDate, endDate));

  // ── Revenue atoms (with FX drag for Remote Work) ───────────────────────────
  const { gross: rawGross, netOfAgency: rawNet } = monthlyGross(s);
  const fxDrag    = s._fxDragFactor ?? 1;               // 1 = no drag
  const gross     = round2(rawGross * fxDrag);
  const netOfAgency = round2(rawNet * fxDrag);

  // ── Sabbatical phase map (populated only for Sabbatical type) ─────────────
  const phaseMap = s._isSabbatical
    ? buildSabbaticalPhaseMap(s, activeMonths)
    : null;

  const months = [];

  // ── Gap period (pre-contract) ──────────────────────────────────────────────
  for (let i = 0; i < Math.max(0, gapMonths); i++) {
    const dt   = addMonths(today, i);
    const burn = _getBurnForMonth(dt);
    months.push({
      monthIdx:       i,
      label:          monthLabel(dt),
      date:           dtStr(dt),
      phase:          'gap',
      grossRevenue:   0,
      agencyMargin:   0,
      netRevenue:     0,
      monthlyBurn:    burn,
      netCashflow:    -burn,
    });
  }

  // ── Active contract period ─────────────────────────────────────────────────
  for (let i = 0; i < activeMonths; i++) {
    const dt   = addMonths(startDate, i);
    const burn = _getBurnForMonth(dt);
    if (phaseMap && phaseMap[i]) {
      // Sabbatical override: break or ramp phase (phaseMap already computed burn)
      months.push({
        monthIdx: gapMonths + i,
        label:    monthLabel(dt),
        date:     dtStr(dt),
        ...phaseMap[i],
      });
    } else {
      months.push({
        monthIdx:       gapMonths + i,
        label:          monthLabel(dt),
        date:           dtStr(dt),
        phase:          'active',
        grossRevenue:   round2(gross),
        agencyMargin:   round2(gross - netOfAgency),
        netRevenue:     round2(netOfAgency),
        monthlyBurn:    burn,
        netCashflow:    round2(netOfAgency - burn),
      });
    }
  }

  // ── Pad to 18 months total ─────────────────────────────────────────────────
  const totalMonths = 18;
  while (months.length < totalMonths) {
    const dt   = addMonths(today, months.length);
    const burn = _getBurnForMonth(dt);
    months.push({
      monthIdx:       months.length,
      label:          monthLabel(dt),
      date:           dtStr(dt),
      phase:          'post',
      grossRevenue:   0,
      agencyMargin:   0,
      netRevenue:     0,
      monthlyBurn:    burn,
      netCashflow:    -burn,
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

// ── Scenario type pre-processor ───────────────────────────────────────────────

/**
 * Transform scenario params based on Scenario Type before running project().
 *
 * Supported types:
 *   Baseline        — standard contract engagement (no transform)
 *   Extension       — same as Baseline
 *   New Contract    — same as Baseline
 *   Gap Period      — zero income, burn only
 *   Holiday         — zero income, optional travel uplift to burn, limited duration
 *   Scale Business  — revenue multiplier + subcontractor cost + overhead additions
 *   BV Structure    — transition event: one-time formation cost, new effective tax rate
 *   Sabbatical      — three-phase: normal billing → break (zero income, travel burn) → ramp back
 *   Remote Work     — normal billing with digital nomad extra costs + FX conversion drag
 *   Custom          — no transform
 */
function applyScenarioType(s) {
  const type = s.scenarioType || s.type || 'Baseline';

  if (type === 'Holiday') {
    return {
      ...s,
      dayRate:          0,
      hourlyRate:       0,
      agencyMarginPct:  0,
      workDaysPerMonth: 0,
      monthlyBurn:      (s.monthlyBurn || 0) + (s.holidayExtraBurnEur || 0),
    };
  }

  if (type === 'Scale Business') {
    const multiplier = s.revenueMultiplier || 1;
    return {
      ...s,
      dayRate:      round2((s.dayRate || 0) * multiplier),
      hourlyRate:   round2((s.hourlyRate || 0) * multiplier),
      monthlyBurn:  round2(
        (s.monthlyBurn || 0)
        + (s.subcontractorCostEur || 0)
        + (s.overheadEur || 0)
      ),
    };
  }

  if (type === 'BV Structure') {
    const formationCost = s.bvFormationCostEur || 2000;
    return {
      ...s,
      currentBalance: (s.currentBalance || 0) - formationCost,
    };
  }

  if (type === 'Sabbatical') {
    // Flags consumed by buildSabbaticalPhaseMap inside project()
    // The base scenario keeps normal billing until the break starts
    return {
      ...s,
      _isSabbatical:           true,
      _sabbaticalStartMonth:   Math.max(0, (s.sabbaticalStartMonth   || 3) - 1), // 0-idx
      _sabbaticalDurationMonths: Math.max(1, s.sabbaticalDurationMonths || 3),
      _returnRampMonths:         Math.max(1, s.returnRampMonths         || 2),
      _breakMonthlyBurnEur:      s.breakMonthlyBurnEur || round2((s.monthlyBurn || 3000) * 1.6),
      _returnDayRate:            s.returnDayRate        || s.dayRate || 0,
    };
  }

  if (type === 'Remote Work') {
    // Digital nomad: accommodation + health insurance + visa amortised + internet
    const accommodation  = s.nomadAccommodationEur      || 800;
    const health         = s.nomadHealthInsuranceEur     || 100;
    const visaMonthly    = s.nomadVisaCostEur && s.nomadVisaDurationMonths
                           ? round2(s.nomadVisaCostEur / s.nomadVisaDurationMonths)
                           : 50;
    const internet       = s.nomadInternetEur            || 50;
    const extraBurn      = accommodation + health + visaMonthly + internet;

    // FX drag: % of income earned in foreign currency × conversion cost
    const fxExposure     = (s.fxExposurePct       || 0) / 100;
    const fxCost         = (s.fxConversionCostPct || 3) / 100;
    const fxDragFactor   = 1 - fxExposure * fxCost;  // e.g. 0.976 for 80% CHF @ 3%

    return {
      ...s,
      monthlyBurn:    round2((s.monthlyBurn || 0) + extraBurn),
      _fxDragFactor:  fxDragFactor,
    };
  }

  // Baseline, Extension, New Contract, Gap Period, Custom — no transform needed
  return s;
}

// ── Sabbatical phase map builder ───────────────────────────────────────────────

/**
 * Builds a per-month override map for Sabbatical scenarios.
 * Returns { [monthIdxWithinActive]: { phase, grossRevenue, ... } }
 */
function buildSabbaticalPhaseMap(s, activeMonths) {
  const map          = {};
  const breakStart   = s._sabbaticalStartMonth;          // 0-indexed
  const breakDur     = s._sabbaticalDurationMonths;
  const rampDur      = s._returnRampMonths;
  const breakBurn    = s._breakMonthlyBurnEur;
  const returnRate   = s._returnDayRate;

  // Return phase gross (with agency margin applied)
  const returnGross  = returnRate * (s.workDaysPerMonth || 20);
  const returnNet    = round2(returnGross * (1 - (s.agencyMarginPct || 0) / 100));

  for (let i = 0; i < activeMonths; i++) {
    if (i >= breakStart && i < breakStart + breakDur) {
      // ── Break: zero income, travel-level burn ─────────────────────────────
      map[i] = {
        phase:        'sabbatical',
        grossRevenue:  0,
        agencyMargin:  0,
        netRevenue:    0,
        monthlyBurn:   breakBurn,
        netCashflow:   -breakBurn,
      };
    } else if (i >= breakStart + breakDur && i < breakStart + breakDur + rampDur) {
      // ── Ramp up: gradual return to billing ────────────────────────────────
      const rampIdx  = i - (breakStart + breakDur);
      const fraction = (rampIdx + 1) / rampDur;
      const rGross   = round2(returnGross  * fraction);
      const rNet     = round2(returnNet    * fraction);
      map[i] = {
        phase:        'ramp',
        grossRevenue:  rGross,
        agencyMargin:  round2(rGross - rNet),
        netRevenue:    rNet,
        monthlyBurn:   s.monthlyBurn,
        netCashflow:   round2(rNet - s.monthlyBurn),
      };
    }
    // else: i < breakStart or i >= breakStart+breakDur+rampDur → normal billing
  }
  return map;
}

// ── Default scenario template ─────────────────────────────────────────────────

function defaultScenario() {
  return {
    name:             'Scenario',
    type:             'Baseline',
    hourlyRate:       0,
    dayRate:          0,
    hoursPerDay:      8,
    workDaysPerMonth: 20,
    agencyMarginPct:  0,    // % taken by agency (e.g. 10 = 10%)
    fixedCostsEur:    4000,  // rent, subscriptions, insurance — same every month
    variableCostsEur: 3000,  // food, transport, leisure — fluctuates month to month
    monthlyBurn:      0,     // derived at runtime = fixedCostsEur + variableCostsEur
    currentBalance:   0,
    startDate:        null, // ISO date string; null = today
    endDate:          null, // ISO date string; null = derived from likelyMonths
    likelyMonths:     6,
    minMonths:        4,
    maxMonths:        9,
    payLagDays:       30,
    renewalProbability: 0.5,

    // ── MC / variance params ──────────────────────────────────────────────
    rateVariancePct:     10,  // ±% on day/hourly rate
    burnVariancePct:     15,  // ±% on monthly burn
    payLagVarianceDays:   7,  // ±days on payment timing
    mcRuns:             500,  // Monte Carlo iterations

    // ── Holiday-specific ──────────────────────────────────────────────────
    holidayExtraBurnEur:  0,  // additional monthly travel spend

    // ── Scale Business-specific ───────────────────────────────────────────
    revenueMultiplier:    1,  // 1.5 = 50% more revenue (e.g. 2 clients)
    subcontractorCostEur: 0,  // monthly subcontractor cost
    overheadEur:          0,  // extra monthly overhead

    // ── BV Structure-specific ─────────────────────────────────────────────
    bvFormationCostEur:  2000, // one-time formation cost
    bvFormationMonth:       1, // month index when BV is formed
    dgaAnnualSalaryEur: 56000, // minimum DGA salary for 2026

    // ── Sabbatical-specific ───────────────────────────────────────────────
    sabbaticalStartMonth:     3, // month index billing stops (1-based); before = normal work
    sabbaticalDurationMonths: 3, // months of zero income (break/travel)
    breakMonthlyBurnEur:      0, // travel burn during break (0 = auto 1.6× base burn)
    returnRampMonths:         2, // months to ramp back to full billing after break
    returnDayRate:            0, // day rate on return (0 = same as pre-sabbatical)

    // ── Remote Work / Digital Nomad-specific ──────────────────────────────
    nomadAccommodationEur:    800, // monthly accommodation (40-50% of nomad budget)
    nomadHealthInsuranceEur:  100, // international health insurance (SafetyWing ~$56-162)
    nomadVisaCostEur:         300, // total visa cost per cycle
    nomadVisaDurationMonths:    6, // months a visa lasts (amortised monthly)
    nomadInternetEur:          50, // eSIM + coworking internet
    fxExposurePct:              0, // % of income in foreign currency (e.g. 80 = 80% CHF)
    fxConversionCostPct:        3, // typical FX conversion cost % (CHF→EUR ~3-5%)

    // ── Abundant Spending Engine — seasonal burn map ───────────────────────
    // Object keyed by calendar month 1–12 (e.g. { 1:5200, 2:2400, 11:11048 })
    // When set, each month's burn is read from this map instead of flat monthlyBurn.
    // Fixed costs (fixedCostsEur) are always honoured as the floor.
    // Set by the frontend after fetching /api/spending/seasonal.
    seasonalBurnMap:          null, // null = disabled, use flat monthlyBurn
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
  applyScenarioType,
  NL_TAX,
};
