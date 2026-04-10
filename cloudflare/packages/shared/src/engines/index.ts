/**
 * Nexus Financial Platform - Shared Engines
 * Core business logic for forecasting, tax, FX, scoring, and simulation
 */

export * from './forecast';
export * from './tax';

// Export from fx, excluding types that are already in types/models
export type {
  FXRates,
  HedgedResult,
  ExchangeRateImpact,
} from './fx';

export {
  convertCurrency,
  computeHedgedValue,
  computePaymentLag,
  calculateFXImpact,
  optimizeHedgingStrategy,
  calculateForwardRate,
  analyzeCurrencyBasket,
} from './fx';

// Export from scoring, excluding ScoredSignal which is in types/models
export type {
  RawSignal,
  UserProfile,
  ScoringConfig,
} from './scoring';

export {
  scoreSignal,
  batchScoreSignals,
  summarizeSignals,
} from './scoring';

export * from './simulator';
export * from './commitment';
