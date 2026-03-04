'use strict';
/**
 * lib/forecast.js — Layered ML forecasting engine
 *
 * Layer 1 — Linear trend regression
 *   Fits y = a + b·x on historical cashflow series via ordinary least squares.
 *   Gives direction, slope, and R² goodness-of-fit.
 *
 * Layer 2 — Holt-Winters double / triple exponential smoothing
 *   Double (trend only):  when < 12 data points available.
 *   Triple (trend+season): when ≥ 12 months; detects quarterly / annual patterns.
 *   Returns h-step-ahead forecasts with upper/lower confidence bands (1.96·σ).
 *
 * Layer 3 — Anomaly detection
 *   Z-score on residuals (actual − Holt-Winters fitted) flags unusual months.
 *   Threshold: |z| > 2 = anomaly.
 *
 * Contract assessment
 *   Combines historical cashflow trajectory with a proposed new contract's
 *   monthly revenue injection. Returns:
 *     - Baseline forecast (no contract)
 *     - With-contract forecast
 *     - Assessment score (0–100)
 *     - Rate reasonableness (z-score vs historical)
 *     - Seasonality alignment from Signals DB
 *     - Named signals and warnings
 */

// ══════════════════════════════════════════════════════════════
//  LAYER 1 — LINEAR REGRESSION
// ══════════════════════════════════════════════════════════════

/**
 * Ordinary least squares on (x, y) pairs.
 * @param {number[]} ys — dependent variable (time series values)
 * @returns {{ slope, intercept, r2, predict(x) }}
 */
function linearRegression(ys) {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0, predict: () => ys[0] ?? 0 };

  const xs = ys.map((_, i) => i);
  const xMean = mean(xs);
  const yMean = mean(ys);

  let ssXY = 0, ssXX = 0, ssYY = 0;
  for (let i = 0; i < n; i++) {
    ssXY += (xs[i] - xMean) * (ys[i] - yMean);
    ssXX += (xs[i] - xMean) ** 2;
    ssYY += (ys[i] - yMean) ** 2;
  }

  const slope     = ssXX === 0 ? 0 : ssXY / ssXX;
  const intercept = yMean - slope * xMean;
  const r2        = ssYY === 0 ? 1 : Math.min(1, Math.max(0, (ssXY ** 2) / (ssXX * ssYY)));

  return {
    slope:     round2(slope),
    intercept: round2(intercept),
    r2:        round4(r2),
    predict:   x => round2(intercept + slope * x),
  };
}

// ══════════════════════════════════════════════════════════════
//  LAYER 2 — HOLT-WINTERS EXPONENTIAL SMOOTHING
// ══════════════════════════════════════════════════════════════

/**
 * Double exponential smoothing (Holt's method — trend, no seasonality).
 * Suitable when < 12 data points.
 *
 * @param {number[]} series
 * @param {object}   opts   — { alpha, beta, h } (h = forecast horizon months)
 * @returns {{ fitted, forecast, sigma, lower, upper }}
 */
function holtDouble(series, { alpha = 0.3, beta = 0.1, h = 18 } = {}) {
  const n = series.length;
  if (n === 0) return emptyForecast(h);

  // Initialise
  let L = series[0];
  let T = n > 1 ? series[1] - series[0] : 0;

  const fitted = [];
  const residuals = [];

  for (let t = 0; t < n; t++) {
    const y = series[t];
    const Lprev = L, Tprev = T;

    L = alpha * y + (1 - alpha) * (Lprev + Tprev);
    T = beta  * (L - Lprev) + (1 - beta) * Tprev;

    fitted.push(round2(Lprev + Tprev));
    residuals.push(y - fitted[t]);
  }

  const sigma = std(residuals);
  const z95   = 1.96;

  const forecast = [], lower = [], upper = [];
  for (let k = 1; k <= h; k++) {
    const f = round2(L + k * T);
    forecast.push(f);
    lower.push(round2(f - z95 * sigma * Math.sqrt(k)));
    upper.push(round2(f + z95 * sigma * Math.sqrt(k)));
  }

  return { fitted, forecast, lower, upper, sigma: round2(sigma), L, T, type: 'holt-double' };
}

/**
 * Triple exponential smoothing (Holt-Winters additive — trend + seasonality).
 * Suitable when ≥ 2 complete seasonal cycles.
 *
 * @param {number[]} series
 * @param {object}   opts   — { alpha, beta, gamma, m, h }
 *   m = seasonal period (12 = annual, 3 = quarterly)
 *   h = forecast horizon
 */
function holtWinters(series, { alpha = 0.3, beta = 0.1, gamma = 0.2, m = 12, h = 18 } = {}) {
  const n = series.length;

  // Fallback to double if not enough seasons
  if (n < 2 * m) return holtDouble(series, { alpha, beta, h });

  // ── Initialise level, trend, seasonal indices ──────────────────────────────
  // Level: average of first season
  let L = mean(series.slice(0, m));
  // Trend: slope between first and second season averages
  const season2Mean = mean(series.slice(m, 2 * m));
  let T = (season2Mean - L) / m;
  // Seasonal: deviations in first season
  const S = [];
  for (let i = 0; i < m; i++) {
    S.push(L !== 0 ? series[i] - L : 0);
  }

  const fitted    = [];
  const residuals = [];

  for (let t = 0; t < n; t++) {
    const y = series[t];
    const Lprev = L, Tprev = T;
    const si    = t % m;

    L     = alpha * (y - S[si]) + (1 - alpha) * (Lprev + Tprev);
    T     = beta  * (L - Lprev) + (1 - beta)  * Tprev;
    S[si] = gamma * (y - L)     + (1 - gamma) * S[si];

    fitted.push(round2(Lprev + Tprev + S[si]));
    residuals.push(y - fitted[t]);
  }

  const sigma = std(residuals);
  const z95   = 1.96;

  const forecast = [], lower = [], upper = [];
  for (let k = 1; k <= h; k++) {
    const f = round2(L + k * T + S[(n + k - 1) % m]);
    forecast.push(f);
    lower.push(round2(f - z95 * sigma * Math.sqrt(k)));
    upper.push(round2(f + z95 * sigma * Math.sqrt(k)));
  }

  return { fitted, forecast, lower, upper, sigma: round2(sigma), L, T, S: [...S], type: 'holt-winters' };
}

/**
 * Auto-select double vs triple Holt-Winters based on series length.
 */
function autoSmooth(series, h = 18) {
  const m = series.length >= 24 ? 12 : series.length >= 6 ? 3 : null;
  if (!m) return holtDouble(series, { h });
  return holtWinters(series, { m, h });
}

// ══════════════════════════════════════════════════════════════
//  LAYER 3 — ANOMALY DETECTION
// ══════════════════════════════════════════════════════════════

/**
 * Z-score based anomaly detection on a time series.
 * Returns per-point z-scores and a list of anomalous indices.
 *
 * @param {number[]} series
 * @param {number}   threshold — default 2.0
 */
function anomalyDetect(series, threshold = 2.0) {
  if (series.length < 3) return { zScores: [], anomalies: [] };

  const μ = mean(series);
  const σ = std(series);
  if (σ === 0) return { zScores: series.map(() => 0), anomalies: [] };

  const zScores  = series.map(v => round4((v - μ) / σ));
  const anomalies = zScores
    .map((z, i) => ({ idx: i, z, value: series[i] }))
    .filter(a => Math.abs(a.z) > threshold);

  return { zScores, anomalies, mean: round2(μ), std: round2(σ) };
}

// ══════════════════════════════════════════════════════════════
//  CONTRACT ASSESSMENT
// ══════════════════════════════════════════════════════════════

/**
 * Full ML assessment of a proposed contract against historical cashflow.
 *
 * @param {object} params
 *   cashflowHistory  — array of cashflow rows from Notion (sorted oldest first)
 *   contract         — { hourlyRate, dayRate, workDaysPerMonth, agencyMarginPct,
 *                        startDate, endDate, likelyMonths, monthlyBurn,
 *                        clientSector, payLagDays }
 *   historicalContracts — array of history rows (for rate comparison)
 *   signals           — array of signal rows (for seasonality)
 *   config            — user config { hourlyRate, burn, mkbPct, zvwPct, ... }
 *   forecastMonths    — how many months to forecast (default 18)
 */
function assessContract(params) {
  const {
    cashflowHistory   = [],
    contract          = {},
    historicalContracts = [],
    signals           = [],
    config            = {},
    forecastMonths    = 18,
  } = params;

  // ── Extract closing balance time series (oldest → newest) ─────────────────
  const sorted  = [...cashflowHistory].sort((a, b) =>
    (a.date || '').localeCompare(b.date || ''));
  const balances = sorted.map(r => r.closingBalance ?? 0).filter(v => v !== null);
  const revenues = sorted.map(r => r.grossRevenue   ?? 0).filter(v => v !== null);

  // ── Layer 1: linear trend on balance ──────────────────────────────────────
  const trend = linearRegression(balances);

  // ── Layer 2: Holt-Winters on balance ──────────────────────────────────────
  const smoothing = autoSmooth(balances, forecastMonths);

  // ── Layer 3: anomaly detection on revenue ─────────────────────────────────
  const revenueAnomalies = anomalyDetect(revenues);

  // ── Build baseline forecast labels ────────────────────────────────────────
  const today     = new Date();
  const labels    = [];
  for (let i = 0; i < forecastMonths; i++) {
    const d = new Date(today);
    d.setMonth(d.getMonth() + i);
    labels.push(d.toISOString().slice(0, 7));
  }

  const baselineForecast = smoothing.forecast.slice(0, forecastMonths);
  const baselineLower    = (smoothing.lower || baselineForecast).slice(0, forecastMonths);
  const baselineUpper    = (smoothing.upper || baselineForecast).slice(0, forecastMonths);

  // ── Monthly contract revenue ───────────────────────────────────────────────
  const dailyRate    = contract.dayRate   > 0
    ? contract.dayRate
    : (contract.hourlyRate || 0) * 8;
  const grossMonthly = dailyRate * (contract.workDaysPerMonth || 20);
  const netMonthly   = grossMonthly * (1 - (contract.agencyMarginPct || 0) / 100);
  const burn         = contract.monthlyBurn || config.burn || 0;
  const netCashflow  = netMonthly - burn;

  // ── Determine which forecast months are covered by the contract ───────────
  const contractStart = contract.startDate ? new Date(contract.startDate) : today;
  const contractEnd   = contract.endDate
    ? new Date(contract.endDate)
    : addMonths(contractStart, contract.likelyMonths || 6);

  // ── With-contract forecast ────────────────────────────────────────────────
  const withContractForecast = baselineForecast.map((baseVal, i) => {
    const monthDate = new Date(labels[i]);
    const active    = monthDate >= contractStart && monthDate <= contractEnd;
    return round2(baseVal + (active ? netCashflow : 0));
  });

  const withContractLower = baselineLower.map((baseVal, i) => {
    const monthDate = new Date(labels[i]);
    const active    = monthDate >= contractStart && monthDate <= contractEnd;
    return round2(baseVal + (active ? netCashflow : 0));
  });

  const withContractUpper = baselineUpper.map((baseVal, i) => {
    const monthDate = new Date(labels[i]);
    const active    = monthDate >= contractStart && monthDate <= contractEnd;
    return round2(baseVal + (active ? netCashflow : 0));
  });

  // ── Rate reasonableness analysis ──────────────────────────────────────────
  const historicalRates = historicalContracts
    .map(h => h.ratePerHour || (h.ratePerDay ? h.ratePerDay / 8 : null))
    .filter(r => r != null && r > 0);

  let rateAnalysis = { verdict: 'No historical data', zScore: null };
  if (historicalRates.length >= 2) {
    const rateMean = mean(historicalRates);
    const rateStd  = std(historicalRates);
    const proposedHourly = contract.hourlyRate || (contract.dayRate ? contract.dayRate / 8 : 0);
    const z = rateStd > 0 ? (proposedHourly - rateMean) / rateStd : 0;

    rateAnalysis = {
      proposedHourly:  round2(proposedHourly),
      historicalMean:  round2(rateMean),
      historicalStd:   round2(rateStd),
      historicalMin:   round2(Math.min(...historicalRates)),
      historicalMax:   round2(Math.max(...historicalRates)),
      zScore:          round4(z),
      verdict: Math.abs(z) < 1 ? 'Within normal range' :
               z > 1.5         ? 'Above historical average — strong rate' :
               z > 1           ? 'Slightly above historical average' :
               z < -1.5        ? 'Below historical average — negotiate up' :
                                 'Slightly below historical average',
      percentile: round1(normalCDF(z) * 100),
    };
  }

  // ── Seasonality alignment (from Signals DB) ───────────────────────────────
  const startMonth   = contractStart.toLocaleString('en-US', { month: 'long' });
  const signalForMonth = signals.find(s => s.month === startMonth);
  let seasonality = { aligned: null, hiringIndex: null, note: 'No signal data for start month.' };
  if (signalForMonth) {
    const hi = signalForMonth.hiringIndex ?? 50;
    seasonality = {
      aligned:     hi >= 55,
      hiringIndex: hi,
      month:       startMonth,
      note: hi >= 70 ? 'Peak hiring season — strong timing.'
          : hi >= 55 ? 'Above-average hiring activity — good timing.'
          : hi >= 40 ? 'Average activity — acceptable timing.'
                     : 'Below-average hiring — consider delaying or negotiating sooner.',
    };
  }

  // ── Runway analysis ───────────────────────────────────────────────────────
  const currentBalance   = config.wiseBalance ?? (balances.length > 0 ? balances[balances.length - 1] : 0);
  const baselineRunway   = burn > 0 ? Math.floor(currentBalance / burn) : 99;
  const contractRevenue  = netCashflow > 0 ? netCashflow : 0;
  const extendedRunway   = burn > contractRevenue
    ? Math.floor(currentBalance / (burn - contractRevenue))
    : 99; // Contract covers burn — infinite effective runway

  // ── Scoring engine ────────────────────────────────────────────────────────
  const scores = {
    // Trend health (is baseline trajectory positive?)
    trend:       trend.slope >= 0 ? 25 : Math.max(0, 25 + trend.slope / 500 * 25),
    // Rate quality
    rate:        rateAnalysis.zScore == null ? 15
                 : rateAnalysis.zScore >= 0  ? Math.min(25, 15 + rateAnalysis.zScore * 5)
                 : Math.max(5,  15 + rateAnalysis.zScore * 5),
    // Seasonality
    season:      seasonality.aligned === null ? 10
                 : seasonality.aligned        ? 20 : 5,
    // Runway extension
    runway:      extendedRunway >= 12 ? 20
                 : extendedRunway >= 6  ? 12
                 : extendedRunway >= 3  ? 6 : 0,
    // Model confidence (R²)
    confidence:  Math.round(trend.r2 * 10),
  };

  const totalScore = Math.min(100, Object.values(scores).reduce((s, v) => s + v, 0));
  const grade      = totalScore >= 80 ? 'STRONG'
                   : totalScore >= 60 ? 'GOOD'
                   : totalScore >= 40 ? 'ACCEPTABLE'
                   : 'REVIEW';

  // ── Named signals and warnings ─────────────────────────────────────────────
  const signals_out = [];
  const warnings    = [];

  if (trend.slope > 0) {
    signals_out.push(`Balance trend is positive (+€${Math.round(trend.slope)}/mo). Contract reinforces upward trajectory.`);
  } else {
    warnings.push(`Balance trend is negative (${Math.round(trend.slope)}/mo). This contract helps but monitor closely.`);
  }

  if (rateAnalysis.zScore != null) {
    if (rateAnalysis.zScore > 1)  signals_out.push(`Rate is above historical average (${rateAnalysis.percentile}th percentile). Strong negotiating position.`);
    if (rateAnalysis.zScore < -1) warnings.push(`Rate is below your historical average. Consider negotiating to ≥€${Math.ceil(rateAnalysis.historicalMean)}/hr.`);
  }

  if (seasonality.aligned === true)  signals_out.push(`${seasonality.note} (Hiring Index: ${seasonality.hiringIndex})`);
  if (seasonality.aligned === false) warnings.push(seasonality.note);

  if (extendedRunway >= 12) signals_out.push(`Contract extends effective runway to ${extendedRunway}+ months.`);
  if (baselineRunway < 6)   warnings.push(`Without this contract, current runway is only ${baselineRunway} months.`);

  if (revenueAnomalies.anomalies.length > 0) {
    warnings.push(`${revenueAnomalies.anomalies.length} anomalous revenue month(s) detected in history — may affect forecast accuracy.`);
  }

  if (trend.r2 < 0.5) warnings.push(`Low trend R² (${(trend.r2 * 100).toFixed(0)}%) — cashflow history is irregular. Forecast bands are wide.`);

  // Agency margin impact
  if ((contract.agencyMarginPct || 0) > 12) {
    warnings.push(`Agency margin of ${contract.agencyMarginPct}% is high. Net impact: -€${round2(grossMonthly - netMonthly)}/mo vs direct billing.`);
  }

  // ── Recommendation text ───────────────────────────────────────────────────
  const monthsActive = Math.max(1, Math.round((contractEnd - contractStart) / (1000 * 60 * 60 * 24 * 30)));
  const totalNet18   = withContractForecast.reduce((s, v, i) => s + (v - baselineForecast[i]), 0);

  const recommendation = grade === 'STRONG'
    ? `This contract is a strong fit. It adds ~€${round2(netMonthly)}/mo net and aligns well with your trajectory.`
    : grade === 'GOOD'
    ? `Good contract. Net cashflow impact is +€${round2(netMonthly)}/mo. A few points to watch: ${warnings[0] || 'none critical'}.`
    : grade === 'ACCEPTABLE'
    ? `Acceptable but verify the rate. Net +€${round2(netMonthly)}/mo over ${monthsActive} months.`
    : `Needs review before committing. Key concern: ${warnings[0] || 'see warnings above'}.`;

  return {
    assessment: {
      score: totalScore,
      grade,
      scores,
      signals: signals_out,
      warnings,
      recommendation,
    },
    trend: {
      slope:         trend.slope,
      intercept:     trend.intercept,
      r2:            trend.r2,
      direction:     trend.slope >= 0 ? 'upward' : 'downward',
    },
    smoothing: {
      type: smoothing.type,
      sigma: smoothing.sigma,
    },
    forecast: {
      labels,
      baseline:          baselineForecast,
      baselineLower,
      baselineUpper,
      withContract:      withContractForecast,
      withContractLower,
      withContractUpper,
    },
    rateAnalysis,
    seasonality,
    runway: {
      current:  baselineRunway,
      extended: extendedRunway,
      delta:    extendedRunway === 99 ? 'Infinite (contract covers burn)' : `+${extendedRunway - baselineRunway} months`,
    },
    contract: {
      dailyRate:     round2(dailyRate),
      grossMonthly:  round2(grossMonthly),
      netMonthly:    round2(netMonthly),
      netCashflow:   round2(netCashflow),
      monthsActive,
      agencyMarginEur: round2(grossMonthly - netMonthly),
    },
    anomalies: revenueAnomalies,
  };
}

// ══════════════════════════════════════════════════════════════
//  STATISTICAL HELPERS
// ══════════════════════════════════════════════════════════════

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function variance(arr) {
  if (arr.length < 2) return 0;
  const μ = mean(arr);
  return arr.reduce((s, v) => s + (v - μ) ** 2, 0) / (arr.length - 1);
}

function std(arr) { return Math.sqrt(variance(arr)); }

/** Standard normal CDF approximation (Abramowitz & Stegun) */
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return z > 0 ? 1 - p : p;
}

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

function emptyForecast(h) {
  return { fitted: [], forecast: Array(h).fill(0), lower: Array(h).fill(0), upper: Array(h).fill(0), sigma: 0, type: 'none' };
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }
function round4(n) { return Math.round((n || 0) * 10000) / 10000; }
function round1(n) { return Math.round((n || 0) * 10) / 10; }

// ══════════════════════════════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════════════════════════════

module.exports = {
  linearRegression,
  holtDouble,
  holtWinters,
  autoSmooth,
  anomalyDetect,
  assessContract,
  // stats helpers (useful for tests)
  mean, std, variance, normalCDF,
};
