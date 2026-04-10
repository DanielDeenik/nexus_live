/**
 * Dutch ZZP Tax Engine
 * Computes tax for Box 1 (self-employment) with all deductions and contributions
 * Supports: tax brackets, ZVW, zelfstandigenaftrek, MKB-winstvrijstelling
 */

export interface DutchTaxConfig {
  // Tax brackets: array of [threshold, rate] tuples
  taxBrackets: Array<[number, number]>;
  // ZVW (Ziektekosten Verzekering) percentage
  zvwRate: number;
  // Zelfstandigenaftrek annual amount
  zelfstandigenaftrek: number;
  // MKB (Midden- en Kleinbedrijf) winstvrijstelling annual amount
  mkbWinstvrijstelling: number;
  // AOW (state pension contribution) percentage
  aowRate: number;
  // UVW (disability contribution) percentage (varies by income)
  uvwBaseRate: number;
  // Wages tax credit (arbeidskorting)
  arbeidskorting: {
    threshold: number;
    maxCredit: number;
    reductionRate: number;
  };
  // Optional: general tax credit (algemene heffingskorting)
  generalTaxCredit: number;
  // Optional: earned income allowance (inkomensafhankelijke combinatiekorting)
  earningAllowance: number;
}

export interface TaxResult {
  grossIncome: number;
  deductibleExpenses: number;
  zelfstandigenaftrek: number;
  mkbWinstvrijstelling: number;
  taxableIncome: number;
  incomeTax: number;
  zvw: number;
  aowContribution: number;
  uvwContribution: number;
  arbeidskorting: number;
  generalTaxCredit: number;
  earningAllowance: number;
  totalTaxAndContributions: number;
  netIncome: number;
  effectiveTaxRate: number;
  breakdown: Record<string, number>;
}

/**
 * Calculate Dutch tax for Box 1 (self-employment)
 * All thresholds and rates must be passed via config, never hardcoded
 */
export function computeDutchTax(
  income: number,
  config: DutchTaxConfig,
  deductions: number = 0
): TaxResult {
  if (income < 0) {
    throw new Error('Income cannot be negative');
  }

  if (deductions < 0) {
    throw new Error('Deductions cannot be negative');
  }

  // Step 1: Calculate gross income after expenses
  const deductibleExpenses = Math.min(deductions, income);
  const grossIncome = income - deductibleExpenses;

  // Step 2: Apply zelfstandigenaftrek (reduces taxable income)
  const zelfstandigenaftrekAmount = Math.min(
    config.zelfstandigenaftrek,
    grossIncome
  );

  // Step 3: Apply MKB winstvrijstelling if applicable
  let mkbWinstvrijstellingAmount = 0;
  const incomAfterZelfstandigenaftrek =
    grossIncome - zelfstandigenaftrekAmount;

  if (incomAfterZelfstandigenaftrek > 0) {
    mkbWinstvrijstellingAmount = Math.min(
      config.mkbWinstvrijstelling,
      incomAfterZelfstandigenaftrek
    );
  }

  // Step 4: Calculate taxable income
  const taxableIncome = Math.max(
    0,
    grossIncome -
      zelfstandigenaftrekAmount -
      mkbWinstvrijstellingAmount
  );

  // Step 5: Calculate income tax using brackets
  const incomeTax = calculateBracketedTax(
    taxableIncome,
    config.taxBrackets
  );

  // Step 6: Calculate ZVW (health insurance contribution for self-employed)
  const zvw = Math.min(
    grossIncome * config.zvwRate,
    taxableIncome * config.zvwRate
  );

  // Step 7: Calculate AOW contribution
  const aowContribution = grossIncome * config.aowRate;

  // Step 8: Calculate UVW contribution (based on income)
  const uvwContribution = grossIncome * config.uvwBaseRate;

  // Step 9: Calculate arbeidskorting (wage tax credit)
  const arbeidskorting = calculateArbeidskorting(
    taxableIncome,
    config.arbeidskorting
  );

  // Step 10: Apply other credits
  const generalTaxCredit = Math.min(
    config.generalTaxCredit,
    incomeTax
  );

  const earningAllowance = Math.min(
    config.earningAllowance,
    Math.max(0, incomeTax - arbeidskorting - generalTaxCredit)
  );

  // Step 11: Calculate total tax
  const totalTaxBeforeCredits =
    incomeTax + zvw + aowContribution + uvwContribution;

  const totalCredits =
    arbeidskorting + generalTaxCredit + earningAllowance;

  const totalTaxAndContributions = Math.max(
    0,
    totalTaxBeforeCredits - totalCredits
  );

  const netIncome = grossIncome - totalTaxAndContributions;

  const effectiveTaxRate =
    income > 0
      ? (totalTaxAndContributions / income) * 100
      : 0;

  return {
    grossIncome,
    deductibleExpenses,
    zelfstandigenaftrek: zelfstandigenaftrekAmount,
    mkbWinstvrijstelling: mkbWinstvrijstellingAmount,
    taxableIncome,
    incomeTax,
    zvw,
    aowContribution,
    uvwContribution,
    arbeidskorting,
    generalTaxCredit,
    earningAllowance,
    totalTaxAndContributions,
    netIncome: Math.max(0, netIncome),
    effectiveTaxRate,
    breakdown: {
      incomeTax,
      zvw,
      aow: aowContribution,
      uvw: uvwContribution,
      totalTaxBeforeCredits,
      arbeidskorting,
      generalTaxCredit,
      earningAllowance,
      totalCredits,
      finalTax: totalTaxAndContributions,
    },
  };
}

/**
 * Calculate tax using progressive brackets
 * Brackets format: [[threshold, rate], [threshold, rate], ...]
 */
function calculateBracketedTax(
  income: number,
  brackets: Array<[number, number]>
): number {
  if (income <= 0) return 0;

  let tax = 0;
  let previousThreshold = 0;

  // Sort brackets by threshold
  const sortedBrackets = [...brackets].sort((a, b) => a[0] - b[0]);

  for (const [threshold, rate] of sortedBrackets) {
    if (income > threshold) {
      const taxableInThisBracket = Math.min(income, threshold) - previousThreshold;
      tax += taxableInThisBracket * rate;
      previousThreshold = threshold;
    } else {
      break;
    }
  }

  // Handle income above the highest bracket
  if (income > previousThreshold) {
    const lastRate = sortedBrackets[sortedBrackets.length - 1]?.[1] || 0;
    tax += (income - previousThreshold) * lastRate;
  }

  return tax;
}

/**
 * Calculate arbeidskorting (wage tax credit for employees and self-employed)
 * Reduces the amount of tax owed
 */
function calculateArbeidskorting(
  income: number,
  config: {
    threshold: number;
    maxCredit: number;
    reductionRate: number;
  }
): number {
  if (income <= 0) return 0;

  // Full credit up to threshold
  if (income <= config.threshold) {
    return config.maxCredit;
  }

  // Linear reduction above threshold
  const excessIncome = income - config.threshold;
  const reduction = excessIncome * config.reductionRate;
  const credit = Math.max(0, config.maxCredit - reduction);

  return credit;
}

/**
 * Calculate quarterly tax installments for ZZP
 * Based on estimated annual income
 */
export function calculateQuarterlyTaxInstallments(
  estimatedAnnualIncome: number,
  config: DutchTaxConfig,
  estimatedDeductions: number = 0
): {
  quarterlyAmount: number;
  estimatedAnnualTax: number;
  breakdown: Record<string, number>;
} {
  const annualTax = computeDutchTax(
    estimatedAnnualIncome,
    config,
    estimatedDeductions
  );

  return {
    quarterlyAmount: annualTax.totalTaxAndContributions / 4,
    estimatedAnnualTax: annualTax.totalTaxAndContributions,
    breakdown: annualTax.breakdown,
  };
}

/**
 * Apply tax scaling to monthly income projection
 * Useful for scenario planning
 */
export function projectMonthlyTax(
  monthlyIncome: number,
  config: DutchTaxConfig,
  monthlyDeductions: number = 0
): TaxResult {
  const annualIncome = monthlyIncome * 12;
  const annualDeductions = monthlyDeductions * 12;

  return computeDutchTax(annualIncome, config, annualDeductions);
}

/**
 * Calculate optimal deduction strategy to minimize tax
 * Subject to tax audit considerations
 */
export function optimizeDeductions(
  income: number,
  potentialDeductions: number,
  config: DutchTaxConfig
): {
  optimalDeductions: number;
  taxSaved: number;
  riskLevel: 'low' | 'medium' | 'high';
} {
  // Conservative approach: use realistic deductions
  const conservativeDeductions = Math.min(
    potentialDeductions * 0.8,
    income * 0.3
  );

  const taxWithoutDeductions = computeDutchTax(income, config, 0);
  const taxWithDeductions = computeDutchTax(
    income,
    config,
    conservativeDeductions
  );

  const taxSaved =
    taxWithoutDeductions.totalTaxAndContributions -
    taxWithDeductions.totalTaxAndContributions;

  let riskLevel: 'low' | 'medium' | 'high' = 'low';
  const deductionRatio = conservativeDeductions / income;

  if (deductionRatio > 0.35) {
    riskLevel = 'medium';
  }
  if (deductionRatio > 0.45) {
    riskLevel = 'high';
  }

  return {
    optimalDeductions: conservativeDeductions,
    taxSaved,
    riskLevel,
  };
}
