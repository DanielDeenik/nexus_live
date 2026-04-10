/**
 * Scenario Simulation Engine
 * Simulates financial projections based on scenario parameters
 * Uses rate × hours × days model for revenue calculation
 */

import type { DutchTaxConfig } from './tax';
import { computeDutchTax } from './tax';

export interface ScenarioParams {
  name: string;
  description?: string;
  // Revenue parameters
  baseMonthlyRevenue: number;
  revenueChange: number; // Percentage change (-50 to +100)
  // Rate parameters
  baseHourlyRate: number;
  rateChange: number; // Percentage change
  // Hours parameters
  baseHoursPerMonth: number;
  hoursChange: number; // Percentage change
  // Expense parameters
  baseMonthlyExpenses: number;
  expenseIncrease: number; // Absolute amount or percentage
  // Time parameters
  startMonth: string; // YYYY-MM
  duration: number; // Number of months
  // One-time events
  oneTimeEvents?: Array<{
    month: number; // 1-indexed
    type: 'revenue' | 'expense';
    amount: number;
  }>;
}

export interface ScenarioResult {
  scenarioName: string;
  projections: MonthProjection[];
  summary: {
    totalRevenue: number;
    totalExpenses: number;
    totalTax: number;
    totalNetCashflow: number;
    averageMonthly: {
      revenue: number;
      expenses: number;
      tax: number;
      netCashflow: number;
    };
    impactPercentage: number;
  };
}

export interface MonthProjection {
  month: string;
  revenue: number;
  hours: number;
  hourlyRate: number;
  expenses: number;
  grossProfit: number;
  tax: number;
  netCashflow: number;
}

/**
 * Simulate a financial scenario for a specified duration
 * All rates and thresholds come from config, never hardcoded
 */
export function simulateScenario(
  params: ScenarioParams,
  taxConfig: DutchTaxConfig
): ScenarioResult {
  if (params.duration < 1 || params.duration > 120) {
    throw new Error(
      'Duration must be between 1 and 120 months'
    );
  }

  // Calculate adjusted parameters
  const adjustedHourlyRate =
    params.baseHourlyRate * (1 + params.rateChange / 100);
  const adjustedHoursPerMonth =
    params.baseHoursPerMonth * (1 + params.hoursChange / 100);
  const adjustedMonthlyExpenses =
    params.baseMonthlyExpenses *
    (1 + params.expenseIncrease / 100);

  // Calculate revenue: either from rate×hours or direct revenue
  const revenueMethod =
    params.baseHourlyRate > 0 ? 'rate_hours' : 'direct';

  const projections: MonthProjection[] = [];
  let cumulativeRevenue = 0;
  let cumulativeExpenses = 0;
  let cumulativeTax = 0;

  const startDate = new Date(params.startMonth + '-01');

  for (let i = 0; i < params.duration; i++) {
    const currentMonth = new Date(startDate);
    currentMonth.setMonth(currentMonth.getMonth() + i);
    const monthStr = currentMonth
      .toISOString()
      .split('T')[0]
      .slice(0, 7);

    // Calculate monthly revenue
    let monthlyRevenue = 0;
    let monthlyHours = 0;

    if (revenueMethod === 'rate_hours') {
      monthlyHours = adjustedHoursPerMonth;
      monthlyRevenue = adjustedHourlyRate * monthlyHours;
    } else {
      monthlyRevenue =
        params.baseMonthlyRevenue *
        (1 + params.revenueChange / 100);
    }

    // Apply one-time events
    const oneTimeEvent = params.oneTimeEvents?.find(
      e => e.month === i + 1
    );
    if (oneTimeEvent) {
      if (oneTimeEvent.type === 'revenue') {
        monthlyRevenue += oneTimeEvent.amount;
      }
    }

    // Calculate monthly expenses
    let monthlyExpenses = adjustedMonthlyExpenses;

    if (oneTimeEvent?.type === 'expense') {
      monthlyExpenses += oneTimeEvent.amount;
    }

    // Calculate gross profit
    const grossProfit = monthlyRevenue - monthlyExpenses;

    // Calculate tax (annually aggregated, but show monthly estimate)
    const annualizedRevenue = monthlyRevenue * 12;
    const annualizedExpenses = monthlyExpenses * 12;
    const taxResult = computeDutchTax(
      annualizedRevenue,
      taxConfig,
      annualizedExpenses
    );

    const monthlyTaxEstimate =
      taxResult.totalTaxAndContributions / 12;

    // Calculate net cashflow
    const netCashflow = grossProfit - monthlyTaxEstimate;

    // Accumulate
    cumulativeRevenue += monthlyRevenue;
    cumulativeExpenses += monthlyExpenses;
    cumulativeTax += monthlyTaxEstimate;

    projections.push({
      month: monthStr,
      revenue: Math.max(0, monthlyRevenue),
      hours: monthlyHours,
      hourlyRate: adjustedHourlyRate,
      expenses: Math.max(0, monthlyExpenses),
      grossProfit: Math.max(0, grossProfit),
      tax: Math.max(0, monthlyTaxEstimate),
      netCashflow: Math.max(0, netCashflow),
    });
  }

  // Calculate summary
  const totalNetCashflow =
    cumulativeRevenue - cumulativeExpenses - cumulativeTax;

  // Calculate base case for comparison
  const baseRevenue =
    revenueMethod === 'rate_hours'
      ? params.baseHourlyRate *
        params.baseHoursPerMonth *
        params.duration
      : params.baseMonthlyRevenue * params.duration;

  const impactPercentage = baseRevenue > 0
    ? ((cumulativeRevenue - baseRevenue) / baseRevenue) * 100
    : 0;

  return {
    scenarioName: params.name,
    projections,
    summary: {
      totalRevenue: Math.max(0, cumulativeRevenue),
      totalExpenses: Math.max(0, cumulativeExpenses),
      totalTax: Math.max(0, cumulativeTax),
      totalNetCashflow: Math.max(0, totalNetCashflow),
      averageMonthly: {
        revenue: Math.max(0, cumulativeRevenue / params.duration),
        expenses: Math.max(0, cumulativeExpenses / params.duration),
        tax: Math.max(0, cumulativeTax / params.duration),
        netCashflow: Math.max(0, totalNetCashflow / params.duration),
      },
      impactPercentage,
    },
  };
}

/**
 * Compare multiple scenarios
 */
export function compareScenarios(
  scenarios: ScenarioResult[]
): {
  byScenario: Array<{
    name: string;
    netCashflow: number;
    impactPercentage: number;
    rank: number;
  }>;
  best: ScenarioResult;
  worst: ScenarioResult;
} {
  const ranked = scenarios
    .map(s => ({
      name: s.scenarioName,
      netCashflow: s.summary.totalNetCashflow,
      impactPercentage: s.summary.impactPercentage,
    }))
    .sort((a, b) => b.netCashflow - a.netCashflow)
    .map((s, i) => ({
      ...s,
      rank: i + 1,
    }));

  const best = scenarios.reduce((a, b) =>
    a.summary.totalNetCashflow > b.summary.totalNetCashflow
      ? a
      : b
  );

  const worst = scenarios.reduce((a, b) =>
    a.summary.totalNetCashflow < b.summary.totalNetCashflow
      ? a
      : b
  );

  return {
    byScenario: ranked,
    best,
    worst,
  };
}

/**
 * Calculate break-even point for a scenario
 */
export function calculateBreakEven(
  params: ScenarioParams,
  taxConfig: DutchTaxConfig
): {
  breakEvenMonth: number | null;
  breakEvenDate: string | null;
  cumulativeThroughBreakEven: number;
} {
  const result = simulateScenario(params, taxConfig);

  let cumulativeNetCashflow = 0;
  let breakEvenMonth = null;
  let breakEvenDate = null;

  for (let i = 0; i < result.projections.length; i++) {
    const projection = result.projections[i];
    cumulativeNetCashflow += projection.netCashflow;

    if (cumulativeNetCashflow >= 0 && !breakEvenMonth) {
      breakEvenMonth = i + 1;
      breakEvenDate = projection.month;
      break;
    }
  }

  return {
    breakEvenMonth,
    breakEvenDate,
    cumulativeThroughBreakEven: cumulativeNetCashflow,
  };
}

/**
 * Sensitivity analysis: vary one parameter and see impact
 */
export function sensitivityAnalysis(
  params: ScenarioParams,
  taxConfig: DutchTaxConfig,
  parameterToVary:
    | 'rateChange'
    | 'hoursChange'
    | 'expenseIncrease'
    | 'revenueChange',
  variations: number[]
): Array<{
  parameterValue: number;
  totalNetCashflow: number;
  impactPercentage: number;
}> {
  return variations.map(value => {
    const adjustedParams = { ...params };
    (adjustedParams as unknown as Record<string, number>)[
      parameterToVary
    ] = value;

    const result = simulateScenario(adjustedParams, taxConfig);

    return {
      parameterValue: value,
      totalNetCashflow: result.summary.totalNetCashflow,
      impactPercentage: result.summary.impactPercentage,
    };
  });
}

/**
 * Monte Carlo simulation for probabilistic outcomes
 */
export function monteCarloSimulation(
  params: ScenarioParams,
  taxConfig: DutchTaxConfig,
  variations: {
    rateChange: { min: number; max: number };
    hoursChange: { min: number; max: number };
    expenseIncrease: { min: number; max: number };
  },
  iterations: number = 1000
): {
  meanNetCashflow: number;
  minNetCashflow: number;
  maxNetCashflow: number;
  stdDev: number;
  percentile95: number;
  percentile5: number;
} {
  const results: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const randomParams = { ...params };
    randomParams.rateChange =
      variations.rateChange.min +
      Math.random() *
        (variations.rateChange.max -
          variations.rateChange.min);
    randomParams.hoursChange =
      variations.hoursChange.min +
      Math.random() *
        (variations.hoursChange.max -
          variations.hoursChange.min);
    randomParams.expenseIncrease =
      variations.expenseIncrease.min +
      Math.random() *
        (variations.expenseIncrease.max -
          variations.expenseIncrease.min);

    const result = simulateScenario(randomParams, taxConfig);
    results.push(result.summary.totalNetCashflow);
  }

  results.sort((a, b) => a - b);

  const mean = results.reduce((a, b) => a + b) / results.length;
  const variance =
    results.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) /
    results.length;
  const stdDev = Math.sqrt(variance);

  return {
    meanNetCashflow: Math.max(0, mean),
    minNetCashflow: Math.max(0, results[0]),
    maxNetCashflow: Math.max(0, results[results.length - 1]),
    stdDev,
    percentile95: Math.max(
      0,
      results[Math.floor(results.length * 0.95)]
    ),
    percentile5: Math.max(
      0,
      results[Math.floor(results.length * 0.05)]
    ),
  };
}

/**
 * Calculate runway based on scenario projections
 * Runway = months until cash depletes if negative cashflow
 */
export function calculateRunway(
  result: ScenarioResult,
  initialCashPosition: number
): {
  runwayMonths: number;
  runwayDate: string | null;
  criticalMonth: number | null;
} {
  let cumulative = initialCashPosition;
  let runwayMonths = result.projections.length;
  let criticalMonth = null;

  for (let i = 0; i < result.projections.length; i++) {
    const projection = result.projections[i];
    cumulative += projection.netCashflow;

    if (cumulative < 0 && !criticalMonth) {
      criticalMonth = i + 1;
      runwayMonths = i;
      break;
    }
  }

  const runwayDate =
    runwayMonths > 0
      ? result.projections[runwayMonths - 1]?.month || null
      : null;

  return {
    runwayMonths,
    runwayDate,
    criticalMonth,
  };
}
