# Nexus Shared Package - Quick Start Guide

## Installation

```bash
npm install @nexus-live/shared
```

## Basic Usage

### 1. Load Configuration

All configuration comes from the D1 database at runtime:

```typescript
import { loadConfig } from '@nexus-live/shared';

const config = await loadConfig(env.DB);
```

### 2. Calculate Forecast

```typescript
import { computeForecast } from '@nexus-live/shared';

const historicalData = [
  { date: '2024-01', value: 5000 },
  { date: '2024-02', value: 5500 },
  { date: '2024-03', value: 6100 },
];

const forecast = computeForecast(historicalData, config.forecastConfig);

console.log(forecast.forecast); // 12 months of projections with confidence intervals
console.log(forecast.rmse);     // Model accuracy metric
```

### 3. Calculate Dutch Taxes

```typescript
import { computeDutchTax } from '@nexus-live/shared';

const result = computeDutchTax(
  50000,  // annual income
  config.taxConfig,
  10000   // deductible expenses
);

console.log(result.netIncome);                  // 50000 - 10000 - taxes
console.log(result.totalTaxAndContributions);  // Total obligation
console.log(result.breakdown);                 // Detail of each tax component
```

### 4. Score a Lead or Signal

```typescript
import { scoreSignal } from '@nexus-live/shared';

const signal = {
  id: 'lead-123',
  type: 'lead' as const,
  subtype: 'inbound_form',
  data: {
    budget: 150000,
    buyingTimeline: 'immediate',
    decisionMaker: true,
    fit: 'strong',
  },
  timestamp: new Date().toISOString(),
};

const profile = {
  riskTolerance: 'medium' as const,
  industry: 'software',
  goals: ['growth', 'cash_stability'],
  constraints: [],
};

const scored = scoreSignal(signal, profile, config.scoringConfig);

console.log(scored.score);       // 0-100
console.log(scored.tier);        // HOT | WARM | MONITOR | COLD
console.log(scored.action);      // What to do next
console.log(scored.confidence);  // 0-1 confidence in the score
```

### 5. Simulate a Scenario

```typescript
import { simulateScenario } from '@nexus-live/shared';

const scenario = {
  name: 'Hire Developer (+50% Revenue)',
  baseMonthlyRevenue: 5000,
  revenueChange: 50,
  baseHourlyRate: 100,
  rateChange: 0,
  baseHoursPerMonth: 160,
  hoursChange: 0,
  baseMonthlyExpenses: 2000,
  expenseIncrease: 1500, // Salary
  startMonth: '2024-04',
  duration: 12,
};

const result = simulateScenario(scenario, config.taxConfig);

console.log(result.summary.totalNetCashflow);    // 12-month total
console.log(result.summary.impactPercentage);   // vs baseline
console.log(result.projections);                 // Monthly breakdown
```

## Common Patterns

### Pattern: Calculate Quarterly Taxes

```typescript
import { calculateQuarterlyTaxInstallments } from '@nexus-live/shared';

const quarterly = calculateQuarterlyTaxInstallments(
  60000,  // Estimated annual revenue
  config.taxConfig,
  12000   // Estimated annual expenses
);

console.log(quarterly.quarterlyAmount);     // How much to set aside per quarter
console.log(quarterly.estimatedAnnualTax);  // Total annual tax
```

### Pattern: Analyze Multi-Currency Portfolio

```typescript
import { analyzeCurrencyBasket } from '@nexus-live/shared';

const invoices = [
  { id: '1', amount: 5000, currency: 'EUR' },
  { id: '2', amount: 10000, currency: 'USD' },
  { id: '3', amount: 2000, currency: 'GBP' },
];

const rates = {
  'EURUSD': 1.08,
  'GBPEUR': 1.17,
};

const analysis = analyzeCurrencyBasket(invoices, rates, 'EUR');

console.log(analysis.totalInBaseCurrency); // All converted to EUR
console.log(analysis.diversification);    // low | medium | high
console.log(analysis.byOriginalCurrency); // Breakdown by currency
```

### Pattern: Batch Score Multiple Leads

```typescript
import { batchScoreSignals, summarizeSignals } from '@nexus-live/shared';

const signals = [/* array of 50 leads */];

const scored = batchScoreSignals(signals, userProfile, config.scoringConfig);
const summary = summarizeSignals(scored);

console.log(summary.byTier);      // { HOT: 5, WARM: 12, MONITOR: 20, COLD: 13 }
console.log(summary.topSignals);  // Top 5 scoring leads
console.log(summary.actionItems); // HOT + WARM count
```

### Pattern: Sensitivity Analysis

```typescript
import { sensitivityAnalysis } from '@nexus-live/shared';

const baseScenario = {
  // ... scenario params
};

const results = sensitivityAnalysis(
  baseScenario,
  config.taxConfig,
  'rateChange',
  [-20, -10, 0, 10, 20]  // Vary rate by -20% to +20%
);

// See how each rate change impacts outcome
results.forEach(r => {
  console.log(`Rate ${r.parameterValue}%: ${r.totalNetCashflow}`);
});
```

### Pattern: Monte Carlo for Risk Analysis

```typescript
import { monteCarloSimulation } from '@nexus-live/shared';

const probabilistic = monteCarloSimulation(
  baseScenario,
  config.taxConfig,
  {
    rateChange: { min: -10, max: 20 },
    hoursChange: { min: -5, max: 30 },
    expenseIncrease: { min: 0, max: 5000 },
  },
  1000  // 1000 iterations
);

console.log(probabilistic.meanNetCashflow);   // Expected value
console.log(probabilistic.percentile5);       // Pessimistic scenario
console.log(probabilistic.percentile95);      // Optimistic scenario
```

## Configuration Keys

All these values are loaded from D1, not hardcoded:

### Tax Configuration
- `tax_brackets` - Progressive tax bracket array
- `tax_zvw_rate` - Health insurance rate
- `tax_zelfstandigenaftrek` - Self-employed deduction
- `tax_mkb_winstvrijstelling` - SME profit exemption
- `tax_aow_rate` - State pension rate
- `tax_uvw_rate` - Disability/unemployment rate
- `tax_arbeidskorting` - Wage tax credit settings
- `tax_general_credit` - General tax credit

### Forecast Configuration
- `forecast_alpha` - Level smoothing parameter
- `forecast_beta` - Trend smoothing parameter
- `forecast_gamma` - Seasonality smoothing parameter
- `forecast_season_length` - Seasonality period (months)
- `forecast_horizon_months` - Forecast length
- `forecast_confidence_width` - Confidence interval width

### Scoring Configuration
- `score_hot_threshold` - HOT tier cutoff (0-100)
- `score_warm_threshold` - WARM tier cutoff
- `score_monitor_threshold` - MONITOR tier cutoff
- `score_weights` - Type weights (JSON)
- `score_time_decay` - Signal aging factor
- `score_confidence_risk` - Risk tolerance adjustments (JSON)

### Application Settings
- `max_request_size` - Max payload size (bytes)
- `request_timeout_ms` - Request timeout (ms)
- `cache_enabled` - Enable KV caching
- `cache_ttl_seconds` - Cache duration
- `log_level` - Logging level
- `agent_caching_enabled` - Agent memory caching
- `max_concurrent_requests` - Rate limiting

### Feature Flags
- `feature_agent_enabled` - MiroFish integration
- `feature_advanced_forecasting` - Advanced models
- `feature_hedging_enabled` - FX hedging
- `feature_scenario_simulation` - Scenario engine
- `feature_signal_scoring` - Lead scoring
- `feature_multi_currency` - Multi-currency support
- `feature_wise_integration` - Wise API

## Updating Configuration

```typescript
import { setConfigValue, loadConfig } from '@nexus-live/shared';

// Change a single value
await setConfigValue(env.DB, 'forecast_alpha', '0.4');

// Reload configuration
const updatedConfig = await loadConfig(env.DB);
```

## Error Handling

All engines validate inputs and throw descriptive errors:

```typescript
import { computeDutchTax } from '@nexus-live/shared';

try {
  const result = computeDutchTax(-1000, config, 0);
} catch (error) {
  console.error(error.message); // "Income cannot be negative"
}
```

## Performance Tips

1. **Load config once at startup**, not per request
2. **Use batch operations** for multiple scores/forecasts
3. **Cache results** in KV when appropriate
4. **Use Monte Carlo sparingly** (CPU intensive)
5. **Pre-compile configuration** before business hours

## TypeScript Support

Full type support - all functions and interfaces are fully typed:

```typescript
import type {
  Invoice,
  ScoredSignal,
  ScenarioResult,
  DutchTaxConfig,
} from '@nexus-live/shared';
```

## Database Integration

Initialize database with config:

```typescript
import { seedDefaultConfig } from '@nexus-live/shared';

// On first run
await seedDefaultConfig(env.DB);

// Then load config
const config = await loadConfig(env.DB);
```

## Support & Troubleshooting

### Config not loading
- Check `app_config` table exists in D1
- Run `seedDefaultConfig()` if empty
- Verify `env.DB` is properly bound

### Score seems wrong
- Check signal data is complete
- Verify user profile settings
- Review scoring thresholds in config

### Forecast looks off
- Ensure at least 2 data points
- Check historical data quality
- Verify alpha/beta/gamma parameters

### Tax calculation unexpected
- Confirm income and expenses are positive
- Check Dutch 2024 tax brackets in config
- Verify tax year is current

## See Also

- [Full Documentation](./README.md)
- [Type Definitions](./src/types/)
- [Engine Implementations](./src/engines/)
- [Configuration System](./src/config/)
