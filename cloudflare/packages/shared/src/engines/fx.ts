/**
 * FX and Hedging Engine
 * Handles currency conversion, hedging calculations, and payment lag computations
 */

export interface FXRates {
  [currencyPair: string]: number;
}

export interface Invoice {
  id: string;
  amount: number;
  currency: string;
  dueDate: string;
}

export interface HedgingContract {
  id: string;
  originalCurrency: string;
  targetCurrency: string;
  originalAmount: number;
  rate: number;
  premium: number;
  expiryDate: string;
}

export interface HedgedResult {
  invoiceAmount: number;
  invoiceCurrency: string;
  hedgedAmount: number;
  targetCurrency: string;
  hedgingCost: number;
  effectiveRate: number;
  unhedgedValue: number;
  protectionValue: number;
}

export interface ExchangeRateImpact {
  baseAmount: number;
  baseCurrency: string;
  bestCase: number;
  worstCase: number;
  expectedValue: number;
  volatility: number;
}

/**
 * Convert amount from one currency to another
 * Requires exchange rates to be passed as parameter
 */
export function convertCurrency(
  amount: number,
  from: string,
  to: string,
  rates: FXRates
): number {
  if (amount < 0) {
    throw new Error('Amount cannot be negative');
  }

  if (from === to) {
    return amount;
  }

  const rateKey = `${from}${to}`;
  const reverseKey = `${to}${from}`;

  let rate: number | undefined;

  // Check direct rate
  if (rateKey in rates) {
    rate = rates[rateKey];
  }
  // Check reverse rate
  else if (reverseKey in rates) {
    rate = 1 / rates[reverseKey];
  }
  // Try to infer through EUR
  else if (
    `EUR${from}` in rates &&
    `${to}EUR` in rates
  ) {
    rate = rates[`${to}EUR`] / rates[`EUR${from}`];
  }
  // Try to infer through USD
  else if (
    `USD${from}` in rates &&
    `${to}USD` in rates
  ) {
    rate = rates[`${to}USD`] / rates[`USD${from}`];
  }

  if (!rate) {
    throw new Error(
      `Exchange rate not found for ${from} to ${to}`
    );
  }

  return Math.max(0, amount * rate);
}

/**
 * Compute hedged value of an invoice
 * Takes into account hedging contracts and their costs
 */
export function computeHedgedValue(
  invoice: Invoice,
  hedges: HedgingContract[],
  rates: FXRates
): HedgedResult {
  // Find matching hedge for this invoice
  const applicableHedge = hedges.find(
    h =>
      h.originalCurrency === invoice.currency &&
      new Date(h.expiryDate) > new Date(invoice.dueDate)
  );

  if (!applicableHedge) {
    // No hedge available, convert at current rate
    const hedgedAmount = convertCurrency(
      invoice.amount,
      invoice.currency,
      'USD', // Default to USD if no target specified
      rates
    );

    return {
      invoiceAmount: invoice.amount,
      invoiceCurrency: invoice.currency,
      hedgedAmount,
      targetCurrency: 'USD',
      hedgingCost: 0,
      effectiveRate: hedgedAmount / invoice.amount,
      unhedgedValue: hedgedAmount,
      protectionValue: 0,
    };
  }

  // Calculate hedged amount using hedge contract rate
  const hedgedAmount = invoice.amount * applicableHedge.rate;
  const hedgingCost = hedgedAmount * applicableHedge.premium;
  const netHedgedAmount = hedgedAmount - hedgingCost;

  // Compare with unhedged value
  const unhedgedValue = convertCurrency(
    invoice.amount,
    invoice.currency,
    applicableHedge.targetCurrency,
    rates
  );

  const protectionValue = Math.max(
    0,
    unhedgedValue - netHedgedAmount
  );

  return {
    invoiceAmount: invoice.amount,
    invoiceCurrency: invoice.currency,
    hedgedAmount: netHedgedAmount,
    targetCurrency: applicableHedge.targetCurrency,
    hedgingCost,
    effectiveRate: hedgedAmount / invoice.amount,
    unhedgedValue,
    protectionValue,
  };
}

/**
 * Compute payment lag as days between due date and expected payment
 */
export function computePaymentLag(
  dueDate: string,
  lagDays: number
): string {
  const due = new Date(dueDate);
  const expectedPayment = new Date(
    due.getTime() + lagDays * 24 * 60 * 60 * 1000
  );

  return expectedPayment.toISOString().split('T')[0];
}

/**
 * Calculate the impact of FX volatility on a multi-currency portfolio
 */
export function calculateFXImpact(
  baseAmount: number,
  baseCurrency: string,
  _targetCurrency: string,
  currentRate: number,
  volatilityPercent: number
): ExchangeRateImpact {
  const volatilityDecimal = volatilityPercent / 100;

  // Best case: rate moves in our favor (currency strengthens)
  const bestRate = currentRate * (1 + volatilityDecimal);
  const bestCase = baseAmount * bestRate;

  // Worst case: rate moves against us (currency weakens)
  const worstRate = currentRate * (1 - volatilityDecimal);
  const worstCase = baseAmount * worstRate;

  // Expected value: assume normal distribution
  const expectedValue = baseAmount * currentRate;

  // Volatility in absolute terms
  const volatility = (bestCase - worstCase) / 2;

  return {
    baseAmount,
    baseCurrency,
    bestCase: Math.max(0, bestCase),
    worstCase: Math.max(0, worstCase),
    expectedValue,
    volatility,
  };
}

/**
 * Optimize hedging strategy for a portfolio of invoices
 * Returns hedge amounts to minimize downside while controlling costs
 */
export function optimizeHedgingStrategy(
  invoices: Invoice[],
  _rates: FXRates,
  config: {
    maxHedgingCost: number; // Maximum acceptable hedging cost
    targetProtectionPercent: number; // Desired protection level (0-1)
    riskTolerance: 'low' | 'medium' | 'high';
  }
): {
  recommendedHedges: Array<{
    invoiceId: string;
    hedgePercent: number;
    estimatedCost: number;
  }>;
  totalProtectionValue: number;
  totalHedgingCost: number;
} {
  const byInvoice = invoices.map(invoice => ({
    invoiceId: invoice.id,
    hedgePercent: 0,
    estimatedCost: 0,
  }));

  // Determine hedge percentages based on risk tolerance
  let targetPercent = config.targetProtectionPercent;

  if (config.riskTolerance === 'low') {
    targetPercent = 0.8; // Hedge 80%
  } else if (config.riskTolerance === 'high') {
    targetPercent = 0.3; // Hedge 30%
  }

  // Apply percentage to each invoice
  for (const invoice of byInvoice) {
    invoice.hedgePercent = targetPercent;
    // Estimate hedging cost as 1-2% of hedged amount
    const hedgedAmount = invoices.find(
      i => i.id === invoice.invoiceId
    )?.amount || 0;
    invoice.estimatedCost = hedgedAmount * hedgedAmount * 0.015;
  }

  // Check if total cost exceeds limit
  const totalCost = byInvoice.reduce((sum, h) => sum + h.estimatedCost, 0);

  if (totalCost > config.maxHedgingCost && totalCost > 0) {
    // Scale down hedge percentages proportionally
    const scaleFactor = config.maxHedgingCost / totalCost;
    for (const invoice of byInvoice) {
      invoice.hedgePercent *= scaleFactor;
      invoice.estimatedCost *= scaleFactor;
    }
  }

  // Calculate total protection value
  const totalProtectionValue = invoices.reduce(
    (sum, inv) => {
      const invoice = byInvoice.find(
        h => h.invoiceId === inv.id
      );
      if (invoice) {
        return (
          sum +
          inv.amount *
            invoice.hedgePercent *
            0.05 // Assuming 5% expected volatility
        );
      }
      return sum;
    },
    0
  );

  return {
    recommendedHedges: byInvoice,
    totalProtectionValue,
    totalHedgingCost: byInvoice.reduce((sum, h) => sum + h.estimatedCost, 0),
  };
}

/**
 * Calculate forward rate agreement value
 * FRA = Spot Rate * (1 + (r_domestic - r_foreign) * (days / 360))
 */
export function calculateForwardRate(
  spotRate: number,
  domesticRate: number,
  foreignRate: number,
  daysForward: number
): number {
  const interestRateDiff =
    domesticRate - foreignRate;
  const timeInYears = daysForward / 360;

  const forwardRate =
    spotRate * (1 + interestRateDiff * timeInYears);

  return Math.max(0, forwardRate);
}

/**
 * Analyze currency basket (multiple invoices in different currencies)
 */
export function analyzeCurrencyBasket(
  invoices: Invoice[],
  rates: FXRates,
  baseCurrency: string = 'EUR'
): {
  totalInBaseCurrency: number;
  byOriginalCurrency: Array<{
    currency: string;
    amount: number;
    valueInBase: number;
    percentage: number;
  }>;
  concentration: number;
  diversification: string;
} {
  const byOriginalCurrency: Array<{
    currency: string;
    amount: number;
    valueInBase: number;
    percentage: number;
  }> = [];

  let totalInBase = 0;

  // Group by currency and convert to base
  const groupedByCurrency = new Map<
    string,
    number
  >();

  for (const invoice of invoices) {
    const existing = groupedByCurrency.get(
      invoice.currency
    ) || 0;
    groupedByCurrency.set(
      invoice.currency,
      existing + invoice.amount
    );
  }

  // Convert each to base currency
  for (const [currency, amount] of groupedByCurrency) {
    const valueInBase = convertCurrency(
      amount,
      currency,
      baseCurrency,
      rates
    );
    totalInBase += valueInBase;

    byOriginalCurrency.push({
      currency,
      amount,
      valueInBase,
      percentage: 0,
    });
  }

  // Calculate percentages
  for (const entry of byOriginalCurrency) {
    entry.percentage =
      totalInBase > 0
        ? (entry.valueInBase / totalInBase) * 100
        : 0;
  }

  // Calculate concentration (Herfindahl index)
  const concentration = byOriginalCurrency.reduce(
    (sum, entry) => {
      const pct = entry.percentage / 100;
      return sum + pct * pct;
    },
    0
  );

  let diversification = 'high';
  if (concentration > 0.5) {
    diversification = 'low';
  } else if (concentration > 0.3) {
    diversification = 'medium';
  }

  return {
    totalInBaseCurrency: totalInBase,
    byOriginalCurrency,
    concentration,
    diversification,
  };
}
