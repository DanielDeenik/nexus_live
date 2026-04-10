# Nexus Shared Package

Core business logic, types, and configuration for the Nexus Financial Platform.

## Structure

```
src/
├── types/                    # Type definitions
│   ├── api.ts              # API request/response types
│   ├── models.ts           # Database model types
│   ├── agents.ts           # MiroFish agent orchestration types
│   ├── env.ts              # Cloudflare Workers environment types
│   └── index.ts            # Type exports
├── engines/                  # Core business logic
│   ├── forecast.ts         # Holt-Winters forecasting
│   ├── tax.ts              # Dutch ZZP tax calculations
│   ├── fx.ts               # Currency conversion & hedging
│   ├── scoring.ts          # Signal scoring (HOT/WARM/MONITOR/COLD)
│   ├── simulator.ts        # Scenario simulation
│   └── index.ts            # Engine exports
├── config/                   # Configuration management
│   └── index.ts            # Config loader from D1
└── index.ts                # Package entry point
```

## Key Features

### 1. Type Safety

All types are production-grade with full TypeScript support:
- API contracts for 15+ endpoints
- Database models matching D1 schema
- Agent orchestration and knowledge graph types
- Cloudflare environment bindings

### 2. Business Logic Engines

#### Forecast Engine (`engines/forecast.ts`)
- **Holt-Winters exponential smoothing** with configurable parameters (alpha, beta, gamma)
- **Linear regression** for trend analysis with R² calculation
- **Anomaly detection** using Z-score method
- Confidence intervals and RMSE calculation

```typescript
import { computeForecast, ForecastConfig } from '@nexus/shared';

const config: ForecastConfig = {
  alpha: 0.3,           // From database config
  beta: 0.1,
  gamma: 0.1,
  seasonLength: 12,
  horizonMonths: 12,
  confidenceWidth: 0.8,
};

const result = computeForecast(historicalData, config);
```

#### Tax Engine (`engines/tax.ts`)
Dutch ZZP tax calculations with all deductions:
- **Box 1 income tax** with progressive brackets
- **ZVW** (health insurance contribution)
- **Zelfstandigenaftrek** (self-employed deduction)
- **MKB-winstvrijstelling** (SME profit exemption)
- **AOW & UVW** contributions
- **Arbeidskorting** (wage tax credit)
- Quarterly installment planning
- Tax optimization strategy

All rates and brackets passed via `DutchTaxConfig` - no hardcoding.

```typescript
import { computeDutchTax } from '@nexus/shared';

const taxResult = computeDutchTax(
  income,
  config.taxConfig,  // All rates from database
  deductions
);

console.log(taxResult.netIncome);
console.log(taxResult.breakdown);
```

#### FX Engine (`engines/fx.ts`)
Currency conversion and hedging:
- **Multi-currency conversion** with configurable rates
- **Hedging contract management** with cost analysis
- **Payment lag computation** for cash flow planning
- **FX impact analysis** with volatility modeling
- **Portfolio optimization** for multi-currency invoices
- Forward rate agreements (FRA)

```typescript
import { computeHedgedValue } from '@nexus/shared';

const hedged = computeHedgedValue(invoice, hedges, rates);
console.log(hedged.netHedgedAmount);
console.log(hedged.protectionValue);
```

#### Scoring Engine (`engines/scoring.ts`)
Signal scoring with configurable tiers:
- **HOT** (>= hotThreshold) - immediate action
- **WARM** (>= warmThreshold) - evaluate
- **MONITOR** (>= monitorThreshold) - watch
- **COLD** (< monitorThreshold) - archive

Scores: currency, market, industry, lead, operational signals
Adjusts for: user profile, risk tolerance, time decay

```typescript
import { scoreSignal, ScoringConfig } from '@nexus/shared';

const signal = scoreSignal(rawSignal, userProfile, config.scoringConfig);
// Returns: { score, tier, probability, action, confidence }
```

#### Simulator Engine (`engines/simulator.ts`)
Scenario financial projections:
- **Rate × Hours × Days model** for revenue
- **Monthly projections** with tax integration
- **Sensitivity analysis** for parameter variations
- **Monte Carlo simulation** for probabilistic outcomes
- **Break-even calculation** and runway analysis
- **Multi-scenario comparison**

```typescript
import { simulateScenario, compareScenarios } from '@nexus/shared';

const scenario = simulateScenario(params, config.taxConfig);
// Returns: 12-month projections with tax implications

const comparison = compareScenarios([baseCase, optimistic, pessimistic]);
```

### 3. Configuration Management

All parameters loaded from D1 at runtime - no hardcoding:

```typescript
import { loadConfig, getConfigValue, setConfigValue } from '@nexus/shared';

// Load entire configuration
const config = await loadConfig(db);

// Get specific value
const taxRate = await getConfigValue(db, 'tax_zvw_rate');

// Update configuration
await setConfigValue(db, 'tax_zvw_rate', '0.015');
```

**Configuration Categories:**
- Tax: brackets, rates, deductions, credits
- Forecast: smoothing parameters, horizon, confidence
- Scoring: thresholds, weights, time decay
- App: request size, timeout, caching, logging
- Features: boolean flags for A/B testing

### 4. Agent Types

Full MiroFish orchestration support:
- Agent capabilities and roles
- Knowledge graph entries
- Agent memory and performance tracking
- Synthesized insights across agents

## Database Integration

Configuration stored in `app_config` table:

```sql
CREATE TABLE app_config (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE,
  value TEXT,
  type TEXT,  -- 'string' | 'number' | 'boolean' | 'json'
  created_at TEXT,
  updated_at TEXT
);
```

Seed database with defaults:

```typescript
import { seedDefaultConfig } from '@nexus/shared';

await seedDefaultConfig(db);
```

## Production Quality

✅ Full TypeScript type safety
✅ No hardcoded values (all configurable)
✅ Real mathematical implementations
✅ Error handling and validation
✅ Comprehensive documentation
✅ Batch processing support
✅ Performance optimized (RMSE, R², efficiency)
✅ Tested algorithms (Holt-Winters, tax brackets, regression)

## Default Configuration

See `DEFAULT_CONFIG` in `config/index.ts`:
- Dutch tax 2024 brackets and rates
- Holt-Winters smoothing (α=0.3, β=0.1, γ=0.1)
- Signal scoring (HOT≥75, WARM≥50, MONITOR≥25)
- 12-month forecast horizon with 80% confidence

**All defaults are for seeding only - runtime values come from database.**

## Exports

```typescript
// Types
export {
  // API types
  FinanceSummaryRequest,
  FinanceSummaryResponse,
  ForecastRequest,
  ForecastResponse,
  // ... all 15+ endpoints

  // Database models
  User,
  Invoice,
  Expense,
  Contract,
  // ... all model types

  // Agent types
  AgentInput,
  AgentOutput,
  ScoredSignal,
  // ... all agent types

  // Environment
  CloudflareEnv,
  D1Database,
  KVNamespace,
  R2Bucket,
};

// Engines
export {
  // Forecast
  computeForecast,
  detectAnomalies,
  linearRegression,
  exponentialMovingAverage,

  // Tax
  computeDutchTax,
  calculateQuarterlyTaxInstallments,
  projectMonthlyTax,
  optimizeDeductions,

  // FX
  convertCurrency,
  computeHedgedValue,
  computePaymentLag,
  calculateFXImpact,
  analyzeCurrencyBasket,

  // Scoring
  scoreSignal,
  batchScoreSignals,
  summarizeSignals,

  // Simulator
  simulateScenario,
  compareScenarios,
  calculateBreakEven,
  sensitivityAnalysis,
  monteCarloSimulation,
};

// Configuration
export {
  loadConfig,
  getConfigValue,
  setConfigValue,
  seedDefaultConfig,
  DEFAULT_CONFIG,
  type AppConfiguration,
};
```

## Example Usage

```typescript
import {
  computeForecast,
  computeDutchTax,
  scoreSignal,
  simulateScenario,
  loadConfig,
} from '@nexus/shared';

// Load runtime configuration from database
const config = await loadConfig(db);

// 1. Forecast revenue
const forecast = computeForecast(
  historicalData,
  config.forecastConfig
);

// 2. Calculate taxes
const taxes = computeDutchTax(
  projectedIncome,
  config.taxConfig,
  deductions
);

// 3. Score leads
const scoredLead = scoreSignal(
  leadSignal,
  userProfile,
  config.scoringConfig
);

// 4. Simulate growth scenario
const scenario = simulateScenario(
  {
    name: '50% Growth',
    baseMonthlyRevenue: 5000,
    revenueChange: 50,
    // ... other params
  },
  config.taxConfig
);
```

## Performance Characteristics

- **Forecast**: O(n) for Holt-Winters, O(n log n) for anomalies (sorting)
- **Tax**: O(m) where m = number of tax brackets (typically 5-10)
- **Scoring**: O(n) batch processing
- **Simulator**: O(n×m) where n = months, m = events
- **FX**: O(n) currency basket analysis

Memory efficient with minimal allocations.

## Testing

Engines designed for unit testing:
- Pure functions with no side effects
- Deterministic results from inputs
- Configurable thresholds and parameters
- Mock-friendly interfaces

## Future Extensions

- Agent-specific engines
- Multi-country tax support
- Advanced hedging strategies
- Real-time market data integration
- Custom forecast models
