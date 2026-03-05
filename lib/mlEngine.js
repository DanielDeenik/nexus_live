'use strict';
/**
 * lib/mlEngine.js — Statistical learning + Monte Carlo simulation engine
 *
 * No external ML dependencies. Uses:
 *   Box-Muller transform   → sample from Normal(μ, σ) distributions
 *   Online Welford         → compute mean + variance in one pass from Notion history
 *   Monte Carlo (N=500)    → run N perturbed simulations → P10/P25/P50/P75/P90 bands
 *
 * The key insight: the biggest source of forecast error for a freelancer isn't
 * the model — it's uncertainty in 3 variables:
 *   1. Rate variance       (client negotiation, day mix, utilisation)
 *   2. Burn variance       (lifestyle fluctuation, one-off costs)
 *   3. Payment lag spread  (invoice disputes, slow accounts payable)
 *
 * We learn these distributions from historical Notion data when available,
 * and fall back to conservative priors when not.
 */

const { queryAll } = require('./notion');
const { project }  = require('./simulator');

// ── Maths primitives ──────────────────────────────────────────────────────────

/**
 * Box-Muller: sample from N(mean, std).
 * Clamped to mean ± 3σ to avoid extreme tail explosions.
 */
function sampleNormal(mean, std) {
  if (!std || std <= 0) return mean;
  const u1 = Math.random() || 1e-15;
  const u2 = Math.random();
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(mean - 3 * std, Math.min(mean + 3 * std, mean + z * std));
}

/**
 * Welford online mean + variance (numerically stable, single pass).
 */
function welford(values) {
  let n = 0, mean = 0, M2 = 0;
  for (const x of values) {
    n++;
    const delta  = x - mean;
    mean += delta / n;
    const delta2 = x - mean;
    M2 += delta * delta2;
  }
  const variance = n > 1 ? M2 / (n - 1) : 0;
  return { mean, std: Math.sqrt(variance), n };
}

/**
 * Compute percentiles from an array of numbers.
 */
function percentiles(values) {
  if (!values || values.length === 0) return { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = p => s[Math.floor((p / 100) * (s.length - 1))];
  return { p10: r2(at(10)), p25: r2(at(25)), p50: r2(at(50)), p75: r2(at(75)), p90: r2(at(90)) };
}

function r2(n) { return Math.round((n || 0) * 100) / 100; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Learn from Notion history ─────────────────────────────────────────────────

/**
 * Pull historical cashflow + expense data from Notion and fit distributions.
 *
 * Returns:
 *   burnRate   { mean, std, n }  — monthly expense distribution
 *   revenueVar { mean, std, n }  — monthly income distribution
 *   payLag     { mean, std, n }  — payment timing variance (priors only unless we have data)
 *   dataPoints — total rows used
 *   source     — 'notion_history' | 'defaults'
 */
async function learnFromHistory(client, ws) {
  const result = {
    burnRate:   { mean: 4500, std: 600, n: 0 },
    revenueVar: { mean: 0,    std: 0,   n: 0 },
    payLag:     { mean: 30,   std: 8,   n: 0 },
    dataPoints:  0,
    source:      'defaults',
  };

  try {
    // ── Expense history → burn rate distribution ───────────────────────────
    if (ws.dbs.expenses) {
      const pages = await queryAll(client, ws.dbs.expenses, null);
      const byMonth = {};
      for (const p of pages) {
        const props  = p.properties;
        const dateV  = props['Date']?.date?.start
                    || props['Expense Date']?.date?.start
                    || props['Invoice Date']?.date?.start;
        const amount = props['Amount']?.number
                    || props['Amount EUR']?.number
                    || props['Total']?.number
                    || 0;
        if (dateV && amount > 0) {
          const ym = dateV.slice(0, 7);
          byMonth[ym] = (byMonth[ym] || 0) + amount;
        }
      }
      const totals = Object.values(byMonth);
      if (totals.length >= 3) {
        const w = welford(totals);
        result.burnRate   = { mean: r2(w.mean), std: r2(w.std), n: w.n };
        result.dataPoints += w.n;
        result.source      = 'notion_history';
      }
    }

    // ── Cashflow income → revenue variance ────────────────────────────────
    if (ws.dbs.cashflow) {
      const pages = await queryAll(client, ws.dbs.cashflow, {
        property: 'Type',
        select: { equals: 'Income' },
      });
      const revenues = pages
        .map(p => p.properties['Amount']?.number
               || p.properties['Amount EUR']?.number
               || p.properties['Revenue EUR']?.number
               || 0)
        .filter(v => v > 0);

      if (revenues.length >= 3) {
        const w = welford(revenues);
        result.revenueVar  = { mean: r2(w.mean), std: r2(w.std), n: w.n };
        result.dataPoints += w.n;
        result.source      = 'notion_history';
      }
    }
  } catch (e) {
    console.warn('[mlEngine] learnFromHistory error (using defaults):', e.message);
  }

  return result;
}

// ── Monte Carlo engine ─────────────────────────────────────────────────────────

/**
 * Run N Monte Carlo simulations of a scenario and return percentile bands.
 *
 * Each run perturbs:
 *   - dayRate       ± rateVariancePct  (learned or user-specified)
 *   - monthlyBurn   ± burnVariancePct  (learned or user-specified)
 *   - payLagDays    ± payLagVarianceDays
 *
 * @param {object} scenario      — full scenario object (all params)
 * @param {object} learnedParams — from learnFromHistory()
 * @param {object} taxOverrides  — NL tax overrides
 * @param {number} runs          — MC iterations (default 500)
 * @returns {object} { months: [{label, date, p10, p25, p50, p75, p90, ...}], summary, tax, mcRuns }
 */
function projectMC(scenario, learnedParams = {}, taxOverrides = {}, runs = 500) {
  const s = scenario;

  // ── Determine variance parameters ─────────────────────────────────────
  const rateVarPct        = (s.rateVariancePct ?? 10) / 100;      // ±10% default
  const burnVarPct        = (s.burnVariancePct ?? 15) / 100;      // ±15% default
  const payLagVarDays     = s.payLagVarianceDays ?? 7;             // ±7 days default

  const baseRate = s.dayRate || (s.hourlyRateEur * (s.hoursPerDay || 8)) || 0;
  const baseBurn = s.monthlyBurn || s.monthlyBurnEur || 0;
  const baseLag  = s.payLagDays  || s.paymentTermsDays || 30;

  // Use learned std if available and scenario hasn't overridden
  const rateStd = baseRate * rateVarPct;
  const burnStd = (learnedParams.burnRate?.std > 0 && learnedParams.burnRate?.n >= 3)
    ? learnedParams.burnRate.std
    : baseBurn * burnVarPct;
  const lagStd  = (learnedParams.payLag?.std > 0)
    ? learnedParams.payLag.std
    : payLagVarDays;

  // ── Run N simulations ──────────────────────────────────────────────────
  const allCumulatives = []; // [monthIdx][runIdx] → cumulativeNet

  for (let r = 0; r < runs; r++) {
    const sampledScenario = {
      ...s,
      // Perturb rate (clamp to 50%–200% of base)
      dayRate:      clamp(sampleNormal(baseRate, rateStd), baseRate * 0.5, baseRate * 2),
      hourlyRate:   s.hourlyRateEur > 0
        ? clamp(sampleNormal(s.hourlyRateEur, s.hourlyRateEur * rateVarPct), s.hourlyRateEur * 0.5, s.hourlyRateEur * 2)
        : 0,
      // Perturb burn (clamp to 50%–250% of base)
      monthlyBurn:  clamp(sampleNormal(baseBurn, burnStd), baseBurn * 0.5, baseBurn * 2.5),
      monthlyBurnEur: clamp(sampleNormal(baseBurn, burnStd), baseBurn * 0.5, baseBurn * 2.5),
      // Perturb payment lag (clamp to 0–90 days)
      payLagDays:   clamp(Math.round(sampleNormal(baseLag, lagStd)), 0, 90),
      paymentTermsDays: clamp(Math.round(sampleNormal(baseLag, lagStd)), 0, 90),
    };

    try {
      const { months } = project(sampledScenario, taxOverrides);
      months.forEach((m, i) => {
        if (!allCumulatives[i]) allCumulatives[i] = [];
        allCumulatives[i].push(m.cumulativeNet);
      });
    } catch (_) {
      // skip failed runs (shouldn't happen with clamped inputs)
    }
  }

  // ── Base projection (P50 representative) ──────────────────────────────
  const { months: baseMonths, summary, tax } = project(s, taxOverrides);

  // ── Attach percentile bands to each month ─────────────────────────────
  const mcMonths = baseMonths.map((m, i) => {
    const runVals = allCumulatives[i] || [m.cumulativeNet];
    const pcts    = percentiles(runVals);
    return {
      ...m,
      p10: pcts.p10,
      p25: pcts.p25,
      p50: pcts.p50,
      p75: pcts.p75,
      p90: pcts.p90,
    };
  });

  // ── MC summary stats ───────────────────────────────────────────────────
  const lastMonthVals = allCumulatives[17] || allCumulatives[allCumulatives.length - 1] || [0];
  const endPcts       = percentiles(lastMonthVals);

  return {
    months:      mcMonths,
    summary,
    tax,
    mcRuns:      runs,
    mcEnd:       endPcts,       // P10/P50/P90 of 18m cumulative net
    learnedFrom: learnedParams.source || 'defaults',
    variance: {
      rateStd:   r2(rateStd),
      burnStd:   r2(burnStd),
      lagStd:    r2(lagStd),
    },
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  learnFromHistory,
  sampleNormal,
  percentiles,
  welford,
  projectMC,
};
