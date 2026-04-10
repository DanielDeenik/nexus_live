# Nexus Shared Package - Complete Exports Reference

## API Types

### Finance & Summary
- `FinanceSummaryRequest`
- `FinanceSummaryResponse`

### Forecast
- `ForecastRequest`
- `ForecastResponse`
- `MonthlyForecast`
- `AnomalyAlert`

### Budget
- `BudgetRequest`
- `BudgetResponse`
- `BudgetBreakdown`
- `ActualBreakdown`
- `VarianceAnalysis`
- `VarianceCategory`

### Invoices
- `InvoiceRequest`
- `InvoiceResponse`
- `InvoiceSummary`

### Expenses
- `ExpenseRequest`
- `ExpenseResponse`
- `ExpenseSummary`
- `CategoryBreakdown`

### Contracts
- `ContractRequest`
- `ContractResponse`
- `ContractSummary`

### Scenarios
- `ScenarioRequest`
- `ScenarioInput`
- `ScenarioResponse`
- `ScenarioProjection`

### Wise Accounts
- `WiseAccountsRequest`
- `WiseAccountsResponse`
- `WiseAccountSummary`

### Hedging
- `HedgingRequest`
- `HedgingResponse`

### Leads
- `LeadsRequest`
- `LeadsResponse`
- `LeadSummary`
- `PipelineStage`

### Projects
- `ProjectsRequest`
- `ProjectsResponse`
- `ProjectSummary`

### Signals
- `SignalsRequest`
- `SignalsResponse`
- `ScoredSignal`
- `SignalSummary`

### Trends
- `TrendsRequest`
- `TrendsResponse`
- `TrendLine`
- `TrendDataPoint`
- `TrendForecast`

### Agent Insights
- `AgentInsightsRequest`
- `AgentInsightsResponse`
- `AgentInsight`

### Config, Tokens, Stakeholders, Recalc
- `ConfigRequest`
- `ConfigResponse`
- `TokenRequest`
- `TokenResponse`
- `StakeholdersRequest`
- `StakeholdersResponse`
- `Stakeholder`
- `RecalcStatusRequest`
- `RecalcStatusResponse`

### Utilities
- `ErrorResponse`
- `PaginatedRequest`
- `PaginatedResponse<T>`

## Database Model Types

### User Management
- `User`
- `ApiToken`
- `Session`

### Financial Documents
- `Invoice`
- `LineItem`
- `Expense`
- `Contract`

### Historical Data
- `CashflowHistory`
- `BurnHistory`

### External Integrations
- `WiseAccount`
- `HedgingContract`
- `DataSource`

### Market & Signals
- `MarketSignal`
- `MarketTrend`
- `TrendPoint`

### Business Entities
- `Lead`
- `Project`
- `Milestone`
- `Scenario`
- `ScenarioProjection`
- `ScenarioSummary`

### AI & Configuration
- `AgentKnowledgeEntry`
- `AgentConfig`
- `AppConfig`
- `RecalcLog`

## Agent Types

### Agent Definitions
- `AgentId` (type)
- `AgentRole` (type)
- `AgentInput`
- `AgentOutput`
- `AgentCapability`
- `AgentPerformance`
- `AgentMemory`

### Knowledge Management
- `KnowledgeGraphEntry`
- `InsightCategory` (type)
- `AgentInsight`

### Orchestration
- `OrchestratorRequest`
- `OrchestratorResponse`
- `SynthesizedInsight`

### Agent-Specific Types
- `AnalystRequest` / `AnalystResponse`
- `ForecasterRequest` / `ForecasterResponse`
- `TaxAdvisorRequest` / `TaxAdvisorResponse`
- `CashflowManagerRequest` / `CashflowManagerResponse`
- `SignalScorerRequest` / `SignalScorerResponse`
- `OpportunityFinderRequest` / `OpportunityFinderResponse`
- `RiskAssessorRequest` / `RiskAssessorResponse`
- `TrendAnalyzerRequest` / `TrendAnalyzerResponse`

## Environment Types

### Cloudflare Bindings
- `CloudflareEnv` - Complete environment interface
- `D1Database` - Database interface
- `D1PreparedStatement`
- `D1Result<T>`
- `D1ExecResult`
- `KVNamespace` - Key-value cache
- `KVGetOptions`
- `KVPutOptions`
- `KVListOptions`
- `KVListResult`
- `R2Bucket` - Object storage
- `R2ObjectMetadata`
- `R2ObjectBody`
- `R2HTTPMetadata`
- `R2Range`
- `R2GetOptions`
- `R2PutOptions`
- `R2ListOptions`
- `R2ListResult`

### Request Context
- `RequestContext`
- `ExecutionContext`
- `Fetcher` - AI Gateway interface

## Forecast Engine

### Types
- `MonthlyDataPoint`
- `ForecastConfig`
- `ForecastResult`
- `AnomalyResult`
- `TrendResult`

### Functions
- `computeForecast(data, config)` -> ForecastResult
- `detectAnomalies(data, threshold?)` -> AnomalyResult[]
- `linearRegression(data)` -> TrendResult
- `movingAverage(data, windowSize)` -> number[]
- `exponentialMovingAverage(data, alpha)` -> number[]

## Tax Engine

### Types
- `DutchTaxConfig`
- `TaxResult`

### Functions
- `computeDutchTax(income, config, deductions?)` -> TaxResult
- `calculateQuarterlyTaxInstallments(income, config, deductions?)` -> {quarterlyAmount, estimatedAnnualTax, breakdown}
- `projectMonthlyTax(monthlyIncome, config, deductions?)` -> TaxResult
- `optimizeDeductions(income, potential, config)` -> {optimalDeductions, taxSaved, riskLevel}
- `calculateBracketedTax(income, brackets)` -> number (internal)
- `calculateArbeidskorting(income, config)` -> number (internal)

## FX Engine

### Types
- `FXRates`
- `Invoice`
- `HedgingContract`
- `HedgedResult`
- `ExchangeRateImpact`

### Functions
- `convertCurrency(amount, from, to, rates)` -> number
- `computeHedgedValue(invoice, hedges, rates)` -> HedgedResult
- `computePaymentLag(dueDate, lagDays)` -> string
- `calculateFXImpact(baseAmount, from, to, rate, volatility)` -> ExchangeRateImpact
- `optimizeHedgingStrategy(invoices, rates, config)` -> {recommendedHedges, totalProtectionValue, totalHedgingCost}
- `calculateForwardRate(spotRate, domestic, foreign, daysForward)` -> number
- `analyzeCurrencyBasket(invoices, rates, baseCurrency?)` -> {totalInBaseCurrency, byOriginalCurrency, concentration, diversification}

## Scoring Engine

### Types
- `RawSignal`
- `UserProfile`
- `ScoringConfig`
- `ScoredSignal`

### Functions
- `scoreSignal(signal, profile, config)` -> ScoredSignal
- `batchScoreSignals(signals, profile, config)` -> ScoredSignal[]
- `summarizeSignals(signals)` -> {total, byTier, averageScore, topSignals, actionItems}
- `scoreSignal()` (internal helpers):
  - `calculateBaseScore()`
  - `scoreCurrencySignal()`
  - `scoreMarketSignal()`
  - `scoreIndustrySignal()`
  - `scoreLeadSignal()`
  - `scoreOperationalSignal()`
  - `calculateProfileAdjustment()`
  - `getSignalAge()`
  - `generateAction()`
  - `generateRationale()`

## Simulator Engine

### Types
- `ScenarioParams`
- `ScenarioResult`
- `MonthProjection`

### Functions
- `simulateScenario(params, taxConfig)` -> ScenarioResult
- `compareScenarios(scenarios)` -> {byScenario, best, worst}
- `calculateBreakEven(params, taxConfig)` -> {breakEvenMonth, breakEvenDate, cumulativeThroughBreakEven}
- `sensitivityAnalysis(params, taxConfig, parameter, variations)` -> Array<{parameterValue, totalNetCashflow, impactPercentage}>
- `monteCarloSimulation(params, taxConfig, variations, iterations?)` -> {meanNetCashflow, minNetCashflow, maxNetCashflow, stdDev, percentile95, percentile5}
- `calculateRunway(result, initialCashPosition)` -> {runwayMonths, runwayDate, criticalMonth}

## Configuration System

### Types
- `AppConfiguration`
- `AppSettings`

### Functions
- `loadConfig(db)` -> Promise<AppConfiguration>
- `getConfigValue(db, key)` -> Promise<string | null>
- `setConfigValue(db, key, value)` -> Promise<void>
- `seedDefaultConfig(db)` -> Promise<void>

### Constants
- `DEFAULT_CONFIG` - Production default values for seeding

## Package Meta

### Exports
- `VERSION` = "1.0.0"
- `PACKAGE_NAME` = "@nexus-live/shared"

---

Total Exports: 200+

Type-safe, production-grade interfaces for the entire Nexus Financial Platform.
