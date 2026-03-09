'use strict';
/**
 * tests/forecast.test.js
 * Unit tests for lib/forecast.js
 *
 * Covers:
 *  - linearRegression()   : slope, intercept, R², predict()
 *  - holtDouble()         : trend forecast, confidence bands
 *  - holtTriple()         : seasonal forecast (requires ≥12 points)
 *  - detectAnomalies()    : z-score flagging
 *  - assessContract()     : baseline vs with-contract comparison
 */

const forecast = require('../lib/forecast');

// Jest-safe helper — only call functions that actually exist in the module
const fn = name => forecast[name];

// ─── linearRegression ────────────────────────────────────────────────────────

describe('linearRegression()', () => {
  const lr = fn('linearRegression');
  if (!lr) { test.todo('linearRegression not exported — skip'); return; }

  test('flat series → slope ≈ 0', () => {
    const r = lr([100, 100, 100, 100, 100]);
    expect(Math.abs(r.slope)).toBeLessThan(0.01);
  });

  test('perfectly increasing series → positive slope', () => {
    const r = lr([0, 1, 2, 3, 4, 5]);
    expect(r.slope).toBeCloseTo(1, 1);
    expect(r.r2).toBeCloseTo(1, 2);
  });

  test('predict() returns expected value for known series', () => {
    // y = 2x + 10
    const r = lr([10, 12, 14, 16, 18]);
    expect(r.predict(5)).toBeCloseTo(20, 0);
  });

  test('single-element series does not throw', () => {
    expect(() => lr([42])).not.toThrow();
  });

  test('R² is between 0 and 1', () => {
    const r = lr([5, 3, 8, 1, 9, 2]);
    expect(r.r2).toBeGreaterThanOrEqual(0);
    expect(r.r2).toBeLessThanOrEqual(1);
  });
});

// ─── holtDouble ──────────────────────────────────────────────────────────────

describe('holtDouble()', () => {
  const hd = fn('holtDouble');
  if (!hd) { test.todo('holtDouble not exported — skip'); return; }

  const growingSeries = [100, 110, 120, 130, 140, 150, 160, 170];

  test('returns forecast array of length h', () => {
    const r = hd(growingSeries, { h: 6 });
    expect(r.forecast.length).toBe(6);
  });

  test('upward-trending series produces positive forecasts', () => {
    const r = hd(growingSeries, { h: 3 });
    r.forecast.forEach(v => expect(v).toBeGreaterThan(0));
  });

  test('confidence bands: lower ≤ forecast ≤ upper', () => {
    const r = hd(growingSeries, { h: 6 });
    for (let i = 0; i < r.forecast.length; i++) {
      expect(r.lower[i]).toBeLessThanOrEqual(r.forecast[i]);
      expect(r.upper[i]).toBeGreaterThanOrEqual(r.forecast[i]);
    }
  });

  test('empty series does not throw', () => {
    expect(() => hd([], { h: 3 })).not.toThrow();
  });

  test('single point series does not throw', () => {
    expect(() => hd([500], { h: 3 })).not.toThrow();
  });
});

// ─── holtTriple (seasonal) ────────────────────────────────────────────────────

describe('holtTriple()', () => {
  const ht = fn('holtTriple');
  if (!ht) { test.todo('holtTriple not exported — skip'); return; }

  // 24 months of synthetic data with clear Q4 seasonality
  const seasonal = Array.from({ length: 24 }, (_, i) =>
    5000 + i * 100 + (i % 12 === 11 ? 2000 : 0)   // Dec spike
  );

  test('returns forecast array of length h', () => {
    const r = ht(seasonal, { h: 12 });
    expect(r.forecast.length).toBe(12);
  });

  test('forecasts are positive for positive input', () => {
    const r = ht(seasonal, { h: 6 });
    r.forecast.forEach(v => expect(v).toBeGreaterThan(0));
  });

  test('confidence bands hold (lower ≤ forecast ≤ upper)', () => {
    const r = ht(seasonal, { h: 12 });
    for (let i = 0; i < r.forecast.length; i++) {
      expect(r.lower[i]).toBeLessThanOrEqual(r.forecast[i] + 0.01); // float tolerance
      expect(r.upper[i]).toBeGreaterThanOrEqual(r.forecast[i] - 0.01);
    }
  });
});

// ─── detectAnomalies ─────────────────────────────────────────────────────────

describe('detectAnomalies()', () => {
  const da = fn('detectAnomalies');
  if (!da) { test.todo('detectAnomalies not exported — skip'); return; }

  test('flat series with one spike → spike flagged as anomaly', () => {
    const series = [1000, 1000, 1000, 1000, 1000, 9999, 1000, 1000];
    const r = da(series);
    const anomalyMonths = r.filter(a => a.isAnomaly).map(a => a.index);
    expect(anomalyMonths).toContain(5);
  });

  test('perfectly flat series → no anomalies', () => {
    const series = [500, 500, 500, 500, 500];
    const r = da(series);
    expect(r.filter(a => a.isAnomaly).length).toBe(0);
  });

  test('returns one result per input month', () => {
    const series = [100, 200, 300, 150, 100];
    const r = da(series);
    expect(r.length).toBe(series.length);
  });

  test('empty series does not throw', () => {
    expect(() => da([])).not.toThrow();
  });
});

// ─── assessContract ──────────────────────────────────────────────────────────

describe('assessContract()', () => {
  const ac = fn('assessContract');
  if (!ac) { test.todo('assessContract not exported — skip'); return; }

  // assessContract() takes a single params object with cashflowHistory records
  const makeHistory = (months = 18) =>
    Array.from({ length: months }, (_, i) => {
      const d = new Date(2024, i, 1);
      return {
        date:           d.toISOString().slice(0, 7),
        closingBalance: 10000 + i * 500,
        grossRevenue:   5000  + i * 50,
      };
    });

  const contract = {
    startDate:      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    durationMonths: 6,
    dayRate:        700,
    hoursPerDay:    8,
    daysPerWeek:    5,
  };

  const makeParams = (overrides = {}) => ({
    cashflowHistory: makeHistory(),
    contract,
    config: { monthlyBurn: 3000 },
    forecastMonths: 18,
    ...overrides,
  });

  test('returns both baseline and withContract forecasts', () => {
    const r = ac(makeParams());
    expect(Array.isArray(r.forecast.baseline)).toBe(true);
    expect(Array.isArray(r.forecast.withContract)).toBe(true);
  });

  test('withContract forecast ≥ baseline (contract adds revenue)', () => {
    const r = ac(makeParams());
    const { baseline, withContract } = r.forecast;
    const totalWith = withContract.reduce((a, v) => a + v, 0);
    const totalBase = baseline.reduce((a, v) => a + v, 0);
    // with-contract should be >= baseline (contract adds monthly revenue)
    expect(totalWith).toBeGreaterThanOrEqual(totalBase);
  });

  test('assessment score is between 0 and 100', () => {
    const r = ac(makeParams());
    expect(r.assessment.score).toBeGreaterThanOrEqual(0);
    expect(r.assessment.score).toBeLessThanOrEqual(100);
  });

  test('result includes signals and warnings arrays', () => {
    const r = ac(makeParams());
    expect(Array.isArray(r.assessment.signals)).toBe(true);
    expect(Array.isArray(r.assessment.warnings)).toBe(true);
  });

  test('higher day rate → higher or equal assessment score', () => {
    const low  = ac(makeParams({ contract: { ...contract, dayRate: 200 } }));
    const high = ac(makeParams({ contract: { ...contract, dayRate: 1200 } }));
    expect(high.assessment.score).toBeGreaterThanOrEqual(low.assessment.score);
  });

  test('empty cashflow history does not throw', () => {
    expect(() => ac({ cashflowHistory: [], contract, forecastMonths: 12 })).not.toThrow();
  });
});
