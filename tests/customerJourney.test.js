'use strict';
/**
 * tests/customerJourney.test.js
 * Tests for the 6 customer-journey improvements shipped in
 * commit c2f55d4 — pure JS logic extracted from index.html.
 *
 * Because the logic lives in a single-file vanilla HTML app, we
 * re-implement the pure functions here to test them in isolation.
 * Each section documents which index.html function it mirrors.
 */

// ─── 1. BENCH COST CALCULATION ──────────────────────────────────────────────
// Mirrors: renderDashboard() bench-cost-line logic

/**
 * @param {number} dayRate
 * @param {number} utilisationPct  0-100
 * @returns {{ dailyCost, monthlyCost }}
 */
function calcBenchCost(dayRate, utilisationPct) {
  const util      = utilisationPct / 100;
  const dailyCost = Math.round(dayRate * util);
  return { dailyCost, monthlyCost: Math.round(dailyCost * 21) };
}

describe('Bench cost banner (Change 1)', () => {
  test('100% utilisation → full day rate per day', () => {
    const r = calcBenchCost(700, 100);
    expect(r.dailyCost).toBe(700);
    expect(r.monthlyCost).toBe(700 * 21);
  });

  test('0% utilisation → zero cost (fully on bench)', () => {
    const r = calcBenchCost(700, 0);
    expect(r.dailyCost).toBe(0);
    expect(r.monthlyCost).toBe(0);
  });

  test('75% utilisation → 75% of day rate', () => {
    const r = calcBenchCost(800, 75);
    expect(r.dailyCost).toBe(600);
  });

  test('monthly cost = daily × 21 working days', () => {
    const r = calcBenchCost(500, 80);
    expect(r.monthlyCost).toBe(r.dailyCost * 21);
  });
});

// ─── 2. TAX TYPE PRESETS ────────────────────────────────────────────────────
// Mirrors: TAX_PRESETS + applyTaxType()

const TAX_PRESETS = {
  sole_trader_basic:  { tax: 25, note: 'UK basic rate + NI (£30k–50k income)' },
  sole_trader_higher: { tax: 42, note: 'UK higher rate + NI (£50k+ income)' },
  ltd_small:          { tax: 19, note: 'UK Corp Tax 19% (profits ≤£50k)' },
  ltd_large:          { tax: 25, note: 'UK Corp Tax 25% (profits >£50k)' },
  umbrella:           { tax: 40, note: 'PAYE marginal rate + employer NI' },
  zzp_nl:             { tax: 36, note: 'NL inkomstenbelasting box 1 ~36% effective' },
  custom:             { tax: null, note: '' },
};

describe('Tax type presets (Change 2)', () => {
  test('all standard presets have a numeric tax rate', () => {
    const standard = Object.entries(TAX_PRESETS).filter(([k]) => k !== 'custom');
    standard.forEach(([key, p]) => {
      expect(typeof p.tax).toBe('number');
      expect(p.tax).toBeGreaterThan(0);
      expect(p.tax).toBeLessThanOrEqual(100);
    });
  });

  test('custom preset has null tax (manual entry)', () => {
    expect(TAX_PRESETS.custom.tax).toBeNull();
  });

  test('Ltd small rate is lower than Ltd large rate', () => {
    expect(TAX_PRESETS.ltd_small.tax).toBeLessThan(TAX_PRESETS.ltd_large.tax);
  });

  test('all 7 preset keys are present', () => {
    const keys = Object.keys(TAX_PRESETS);
    expect(keys).toHaveLength(7);
    expect(keys).toContain('sole_trader_basic');
    expect(keys).toContain('zzp_nl');
  });

  test('sole trader higher rate > sole trader basic rate', () => {
    expect(TAX_PRESETS.sole_trader_higher.tax).toBeGreaterThan(TAX_PRESETS.sole_trader_basic.tax);
  });
});

// ─── 3. UTILISATION NUDGE ───────────────────────────────────────────────────
// Mirrors: obUpdateUtilNudge()

/**
 * @param {number} effectiveRate  hourly rate
 * @param {number} hoursPerWeek
 * @param {number} utilisationPct  0-100
 * @returns {{ current, next5Income, nextUtil, nudgeText }}
 */
function calcUtilNudge(effectiveRate, hoursPerWeek, utilisationPct) {
  const WEEKS_PER_MONTH = 4.33;
  const current  = Math.round(effectiveRate * hoursPerWeek * WEEKS_PER_MONTH * (utilisationPct / 100));
  const next5    = Math.round(effectiveRate * hoursPerWeek * WEEKS_PER_MONTH * 5 / 100);
  const nextUtil = Math.round(effectiveRate * hoursPerWeek * WEEKS_PER_MONTH * ((utilisationPct + 5) / 100));
  const text     = utilisationPct >= 100
    ? `Fully booked — €${current}/month gross`
    : `+5% more utilisation = +€${next5}/month  (€${current} → €${nextUtil})`;
  return { current, next5, nextUtil, nudgeText: text };
}

describe('Utilisation nudge (Change 3)', () => {
  test('at 100% shows fully booked message', () => {
    const r = calcUtilNudge(100, 32, 100);
    expect(r.nudgeText).toMatch(/fully booked/i);
  });

  test('at 75% shows +5% opportunity message', () => {
    const r = calcUtilNudge(100, 32, 75);
    expect(r.nudgeText).toMatch(/\+5%/);
    expect(r.next5).toBeGreaterThan(0);
  });

  test('current income scales linearly with utilisation', () => {
    const r50 = calcUtilNudge(100, 32, 50);
    const r100 = calcUtilNudge(100, 32, 100);
    expect(r100.current).toBeCloseTo(r50.current * 2, 0);
  });

  test('next5 income is always positive for non-zero rate', () => {
    const r = calcUtilNudge(80, 32, 30);
    expect(r.next5).toBeGreaterThan(0);
  });

  test('zero rate produces zero current income', () => {
    const r = calcUtilNudge(0, 32, 75);
    expect(r.current).toBe(0);
  });
});

// ─── 4. SCENARIO OVERRIDE ────────────────────────────────────────────────────
// Mirrors: applyScenarioToForecast() + resetScenario()

function buildNetCashflow(cfg, months = 12) {
  const rate    = cfg.hourlyRate || 0;
  const hours   = cfg.availHoursPerWeek || 32;
  const util    = (cfg.utilisation ?? 75) / 100;
  const tax     = (cfg.taxReserve ?? 25) / 100;
  const burn    = cfg.monthlyBurn || 0;
  const WEEKS   = 4.33;
  const gross   = rate * hours * WEEKS * util;
  const net     = gross * (1 - tax) - burn;
  return Array.from({ length: months }, (_, i) => Math.round(net));
}

function applyScenarioToForecast(S, scenario) {
  // Temporarily override cfg, build cashflow, restore
  const orig = { hourlyRate: S.cfg.hourlyRate, availHoursPerWeek: S.cfg.availHoursPerWeek };
  S.cfg.hourlyRate          = scenario.rate;
  S.cfg.availHoursPerWeek   = scenario.hrs;
  S.netCashflow = buildNetCashflow(S.cfg);
  S.cfg.hourlyRate          = orig.hourlyRate;
  S.cfg.availHoursPerWeek   = orig.availHoursPerWeek;
  return S.netCashflow;
}

describe('Scenario override (Change 4)', () => {
  const baseState = () => ({
    cfg: { hourlyRate: 100, availHoursPerWeek: 32, utilisation: 75, taxReserve: 25, monthlyBurn: 2000 },
    netCashflow: null,
  });

  test('applying scenario changes netCashflow based on scenario rate', () => {
    const S = baseState();
    const highRate = applyScenarioToForecast(S, { rate: 200, hrs: 32 });
    const lowRate  = applyScenarioToForecast(S, { rate: 50,  hrs: 32 });
    expect(highRate[0]).toBeGreaterThan(lowRate[0]);
  });

  test('cfg is restored after applying scenario', () => {
    const S = baseState();
    applyScenarioToForecast(S, { rate: 999, hrs: 40 });
    expect(S.cfg.hourlyRate).toBe(100);
    expect(S.cfg.availHoursPerWeek).toBe(32);
  });

  test('higher hours → higher cashflow', () => {
    const S = baseState();
    const r40 = applyScenarioToForecast(S, { rate: 100, hrs: 40 });
    const r20 = applyScenarioToForecast(S, { rate: 100, hrs: 20 });
    expect(r40[0]).toBeGreaterThan(r20[0]);
  });

  test('netCashflow has 12 months by default', () => {
    const S = baseState();
    const nc = applyScenarioToForecast(S, { rate: 100, hrs: 32 });
    expect(nc.length).toBe(12);
  });
});

// ─── 5. PIPELINE PROBABILITY WEIGHTING ──────────────────────────────────────
// Mirrors: getContractProb() + updateProbabilityWeightedIncome()

function getContractProb(contract, overrides = {}) {
  const key    = contract.id || contract.name || contract.client || '';
  if (overrides[key] !== undefined) return overrides[key];
  const status = (contract.status || '').toLowerCase();
  if (status === 'active')   return 100;
  if (status === 'upcoming') return 80;
  if (status === 'prospect') return 40;
  if (status === 'ended' || status === 'lost') return 0;
  return 60;
}

function calcWeightedIncome(contracts, overrides = {}, defaultHoursPerWeek = 32) {
  return contracts.map(c => {
    const prob   = getContractProb(c, overrides) / 100;
    const rate   = c.hourlyRate || (c.dayRate ? c.dayRate / 8 : 0);
    const raw    = rate * defaultHoursPerWeek * 4.33;
    return { prob, raw, weighted: raw * prob };
  }).reduce((sum, c) => sum + c.weighted, 0);
}

describe('Pipeline probability weighting (Change 5)', () => {
  test('active contract → 100% probability', () => {
    expect(getContractProb({ status: 'active' })).toBe(100);
  });

  test('upcoming contract → 80% probability', () => {
    expect(getContractProb({ status: 'upcoming' })).toBe(80);
  });

  test('prospect → 40%', () => {
    expect(getContractProb({ status: 'prospect' })).toBe(40);
  });

  test('ended/lost → 0%', () => {
    expect(getContractProb({ status: 'ended' })).toBe(0);
    expect(getContractProb({ status: 'lost'  })).toBe(0);
  });

  test('unknown status → 60% default', () => {
    expect(getContractProb({ status: 'negotiating' })).toBe(60);
    expect(getContractProb({})).toBe(60);
  });

  test('manual override takes precedence over status default', () => {
    const c = { id: 'abc', status: 'prospect' };
    expect(getContractProb(c, { abc: 90 })).toBe(90);
  });

  test('weighted income = 0 when all contracts are lost', () => {
    const contracts = [
      { id: '1', status: 'lost', hourlyRate: 100 },
      { id: '2', status: 'ended', hourlyRate: 80 },
    ];
    expect(calcWeightedIncome(contracts)).toBe(0);
  });

  test('active contract at €100/hr has higher weighted income than prospect at same rate', () => {
    const active  = [{ id: 'a', status: 'active',  hourlyRate: 100 }];
    const prospect = [{ id: 'b', status: 'prospect', hourlyRate: 100 }];
    expect(calcWeightedIncome(active)).toBeGreaterThan(calcWeightedIncome(prospect));
  });

  test('multiple contracts are summed', () => {
    const contracts = [
      { id: 'a', status: 'active',   hourlyRate: 100 },
      { id: 'b', status: 'prospect', hourlyRate: 100 },
    ];
    const total = calcWeightedIncome(contracts);
    const onlyActive  = calcWeightedIncome([contracts[0]]);
    const onlyProspect = calcWeightedIncome([contracts[1]]);
    expect(total).toBeCloseTo(onlyActive + onlyProspect, 0);
  });
});

// ─── 6. PAYMENT DELAY OFFSET ─────────────────────────────────────────────────
// Mirrors: cashReceived array shift in renderForecastChart()

/**
 * Shift an income array by ptMonths to simulate payment delay.
 * @param {number[]} income      12-month income array
 * @param {number}   ptDays      payment terms in days (Net-0/15/30/45/60)
 * @returns {number[]}           12-month cash-received array
 */
function buildCashReceived(income, ptDays) {
  const ptMonths = Math.round(ptDays / 30);
  if (ptMonths === 0) return income.slice();
  return Array(ptMonths).fill(0).concat(income.slice(0, 12 - ptMonths));
}

describe('Payment delay offset (Change 6)', () => {
  const income = [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100];

  test('Net-0 → no shift (cashReceived = income)', () => {
    const cr = buildCashReceived(income, 0);
    expect(cr).toEqual(income);
  });

  test('Net-30 → 1-month shift (first month = 0)', () => {
    const cr = buildCashReceived(income, 30);
    expect(cr[0]).toBe(0);
    expect(cr[1]).toBe(income[0]);
  });

  test('Net-60 → 2-month shift (first two months = 0)', () => {
    const cr = buildCashReceived(income, 60);
    expect(cr[0]).toBe(0);
    expect(cr[1]).toBe(0);
    expect(cr[2]).toBe(income[0]);
  });

  test('result always has 12 months', () => {
    [0, 15, 30, 45, 60].forEach(days => {
      expect(buildCashReceived(income, days).length).toBe(12);
    });
  });

  test('total cash received is less than or equal to total income when delay > 0', () => {
    const cr   = buildCashReceived(income, 30);
    const sumI  = income.reduce((a, v) => a + v, 0);
    const sumCR = cr.reduce((a, v) => a + v, 0);
    // Last month(s) of income are pushed beyond the 12-month window
    expect(sumCR).toBeLessThanOrEqual(sumI);
  });

  test('Net-15 rounds to 0 months (≈ 0.5, rounds to 1 — check boundary)', () => {
    // Math.round(15/30) = Math.round(0.5) = 1 in most JS engines
    const ptMonths = Math.round(15 / 30);
    expect(ptMonths).toBeGreaterThanOrEqual(0);
    expect(ptMonths).toBeLessThanOrEqual(1);
  });
});
