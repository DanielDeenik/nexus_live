/**
 * API Request/Response types for all Nexus Financial Platform endpoints
 */

// Finance Summary Endpoint
export interface FinanceSummaryRequest {
  userId: string;
  startDate?: string;
  endDate?: string;
}

export interface FinanceSummaryResponse {
  totalIncome: number;
  totalExpenses: number;
  totalTax: number;
  netCashflow: number;
  activeLead: number;
  activeProject: number;
  pendingInvoice: number;
  overdueInvoice: number;
  burnRate: number;
  runway: number;
  lastUpdated: string;
}

// Forecast Endpoint
export interface ForecastRequest {
  userId: string;
  months?: number;
  method?: 'exponential' | 'linear' | 'ensemble';
  includeAnomalies?: boolean;
}

export interface ForecastResponse {
  forecast: MonthlyForecast[];
  anomalies: AnomalyAlert[];
  confidence: number;
  method: string;
  generatedAt: string;
}

export interface MonthlyForecast {
  month: string;
  projected: number;
  lower: number;
  upper: number;
  trend: 'up' | 'down' | 'stable';
}

export interface AnomalyAlert {
  date: string;
  value: number;
  zscore: number;
  severity: 'low' | 'medium' | 'high';
  description: string;
}

// Budget Endpoint
export interface BudgetRequest {
  userId: string;
  period: 'monthly' | 'quarterly' | 'annual';
  scenarios?: string[];
}

export interface BudgetResponse {
  budgets: BudgetBreakdown[];
  actuals: ActualBreakdown[];
  variance: VarianceAnalysis;
  recommendations: string[];
}

export interface BudgetBreakdown {
  category: string;
  allocated: number;
  committed: number;
  flexible: number;
}

export interface ActualBreakdown {
  category: string;
  spent: number;
  percentage: number;
}

export interface VarianceAnalysis {
  totalVariance: number;
  percentVariance: number;
  categories: VarianceCategory[];
}

export interface VarianceCategory {
  name: string;
  budgeted: number;
  actual: number;
  variance: number;
}

// Invoice Endpoint
export interface InvoiceRequest {
  userId: string;
  status?: 'draft' | 'sent' | 'paid' | 'overdue';
  limit?: number;
  offset?: number;
}

export interface InvoiceResponse {
  invoices: InvoiceSummary[];
  totalCount: number;
  totalOutstanding: number;
  averageDaysOverdue: number;
}

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  clientName: string;
  amount: number;
  currency: string;
  dueDate: string;
  status: string;
  daysOverdue: number;
}

// Expense Endpoint
export interface ExpenseRequest {
  userId: string;
  startDate: string;
  endDate: string;
  category?: string;
}

export interface ExpenseResponse {
  expenses: ExpenseSummary[];
  byCategory: CategoryBreakdown[];
  total: number;
  averageDaily: number;
}

export interface ExpenseSummary {
  id: string;
  date: string;
  category: string;
  amount: number;
  currency: string;
  description: string;
}

export interface CategoryBreakdown {
  category: string;
  amount: number;
  count: number;
  percentage: number;
}

// Contract Endpoint
export interface ContractRequest {
  userId: string;
  status?: 'active' | 'ended' | 'upcoming';
  limit?: number;
}

export interface ContractResponse {
  contracts: ContractSummary[];
  totalMonthlyValue: number;
  activeCount: number;
  expiringIn30Days: number;
}

export interface ContractSummary {
  id: string;
  clientName: string;
  hourlyRate: number;
  hoursPerWeek: number;
  startDate: string;
  endDate: string;
  status: string;
  monthlyValue: number;
}

// Scenario Endpoint
export interface ScenarioRequest {
  userId: string;
  scenario: ScenarioInput;
}

export interface ScenarioInput {
  name: string;
  description?: string;
  revenueChange: number;
  rateChange: number;
  hoursChange: number;
  expenseIncrease: number;
  startMonth: string;
  duration: number;
}

export interface ScenarioResponse {
  scenarioId: string;
  projections: ScenarioProjection[];
  summary: {
    totalRevenue: number;
    totalTax: number;
    netCashflow: number;
    impactPercentage: number;
  };
}

export interface ScenarioProjection {
  month: string;
  revenue: number;
  expenses: number;
  tax: number;
  netCashflow: number;
}

// Wise Accounts Endpoint
export interface WiseAccountsRequest {
  userId: string;
}

export interface WiseAccountsResponse {
  accounts: WiseAccountSummary[];
  totalBalance: number;
  lastSyncedAt: string;
}

export interface WiseAccountSummary {
  id: string;
  currency: string;
  balance: number;
  type: string;
}

// Hedging Endpoint
export interface HedgingRequest {
  userId: string;
  invoiceId?: string;
  currency: string;
  amount: number;
}

export interface HedgingResponse {
  hedgeId: string;
  originalAmount: number;
  originalCurrency: string;
  hedgedAmount: number;
  hedgedCurrency: string;
  rate: number;
  expiryDate: string;
  status: string;
}

// Leads Endpoint
export interface LeadsRequest {
  userId: string;
  status?: 'new' | 'contacted' | 'proposal' | 'won' | 'lost';
  limit?: number;
}

export interface LeadsResponse {
  leads: LeadSummary[];
  pipeline: PipelineStage[];
  conversionRate: number;
}

export interface LeadSummary {
  id: string;
  companyName: string;
  budget: number;
  status: string;
  score: 'HOT' | 'WARM' | 'MONITOR' | 'COLD';
  probability: number;
  lastContact: string;
}

export interface PipelineStage {
  stage: string;
  count: number;
  value: number;
}

// Projects Endpoint
export interface ProjectsRequest {
  userId: string;
  status?: 'active' | 'completed' | 'on-hold';
  limit?: number;
}

export interface ProjectsResponse {
  projects: ProjectSummary[];
  activeCount: number;
  totalValue: number;
  completionRate: number;
}

export interface ProjectSummary {
  id: string;
  clientName: string;
  scope: string;
  budget: number;
  spent: number;
  status: string;
  completionPercentage: number;
}

// Signals Endpoint
export interface SignalsRequest {
  userId: string;
  days?: number;
}

export interface SignalsResponse {
  signals: ScoredSignal[];
  summary: SignalSummary;
}

export interface ScoredSignal {
  id: string;
  type: string;
  score: number;
  tier: 'HOT' | 'WARM' | 'MONITOR' | 'COLD';
  description: string;
  action: string;
  confidence: number;
}

export interface SignalSummary {
  totalSignals: number;
  hotCount: number;
  warmCount: number;
  actionItems: number;
}

// Trends Endpoint
export interface TrendsRequest {
  userId: string;
  metric: 'revenue' | 'expenses' | 'burn' | 'cashflow';
  period?: 'weekly' | 'monthly' | 'quarterly';
}

export interface TrendsResponse {
  trend: TrendLine;
  dataPoints: TrendDataPoint[];
  forecast: TrendForecast;
}

export interface TrendLine {
  slope: number;
  intercept: number;
  rSquared: number;
  direction: 'increasing' | 'decreasing' | 'stable';
}

export interface TrendDataPoint {
  date: string;
  value: number;
  trend: number;
}

export interface TrendForecast {
  month: string;
  projected: number;
  confidence: number;
}

// Agent Insights Endpoint
export interface AgentInsightsRequest {
  userId: string;
  categories?: string[];
}

export interface AgentInsightsResponse {
  insights: AgentInsight[];
  recommendations: string[];
  confidence: number;
  generatedAt: string;
}

export interface AgentInsight {
  id: string;
  category: string;
  title: string;
  summary: string;
  dataPoints: Record<string, number | string>;
  actionable: boolean;
  priority: 'high' | 'medium' | 'low';
}

// Config Endpoint
export interface ConfigRequest {
  key?: string;
}

export interface ConfigResponse {
  config: Record<string, string | number | boolean>;
}

// Tokens Endpoint
export interface TokenRequest {
  name: string;
  expiresIn?: number;
}

export interface TokenResponse {
  token: string;
  expiresAt: string;
  createdAt: string;
}

// Stakeholders Endpoint
export interface StakeholdersRequest {
  userId: string;
}

export interface StakeholdersResponse {
  stakeholders: Stakeholder[];
}

export interface Stakeholder {
  id: string;
  name: string;
  email: string;
  role: string;
  permissions: string[];
}

// Recalc Status Endpoint
export interface RecalcStatusRequest {
  userId: string;
}

export interface RecalcStatusResponse {
  status: 'idle' | 'running' | 'pending';
  lastRun: string;
  nextScheduled: string;
  progress: number;
  message: string;
}

// Generic Error Response
export interface ErrorResponse {
  error: string;
  code: string;
  details?: Record<string, string>;
  timestamp: string;
}

// Pagination
export interface PaginatedRequest {
  limit?: number;
  offset?: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}
