/**
 * MiroFish Agent types for orchestration and knowledge management
 */

export type AgentId =
  | 'analyst'
  | 'forecaster'
  | 'tax_advisor'
  | 'cashflow_manager'
  | 'signal_scorer'
  | 'opportunity_finder'
  | 'risk_assessor'
  | 'trend_analyzer';

export type AgentRole =
  | 'analyzer'
  | 'predictor'
  | 'advisor'
  | 'optimizer'
  | 'monitor'
  | 'discoverer';

export interface AgentInput {
  agentId: AgentId;
  userId: string;
  data: Record<string, unknown>;
  context?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface AgentOutput {
  agentId: AgentId;
  status: 'success' | 'error' | 'partial';
  result: Record<string, unknown>;
  insights?: AgentInsight[];
  metadata: {
    executedAt: string;
    duration: number;
    confidence: number;
    version: string;
  };
}

export interface AgentInsight {
  id: string;
  category: InsightCategory;
  title: string;
  summary: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  actionable: boolean;
  dataPoints: Record<string, number | string | boolean>;
  recommendation?: string;
  priority: number;
}

export type InsightCategory =
  | 'revenue'
  | 'expense'
  | 'cashflow'
  | 'tax'
  | 'opportunity'
  | 'risk'
  | 'trend'
  | 'anomaly'
  | 'forecast'
  | 'signal'
  | 'lead_quality'
  | 'project_health'
  | 'contract_renewal';

export interface KnowledgeGraphEntry {
  id: string;
  agentId: AgentId;
  category: string;
  key: string;
  value: unknown;
  confidence: number;
  source: 'inference' | 'user_input' | 'data_source' | 'calculation';
  linkedEntries?: string[];
  expiresAt?: string;
  metadata: Record<string, unknown>;
}

export interface OrchestratorRequest {
  requestId: string;
  userId: string;
  objective: string;
  agents: AgentId[];
  data: Record<string, unknown>;
  priority: 'low' | 'medium' | 'high';
  timeout?: number;
}

export interface OrchestratorResponse {
  requestId: string;
  status: 'completed' | 'partial' | 'failed';
  results: AgentOutput[];
  synthesizedInsights: SynthesizedInsight[];
  executionTime: number;
}

export interface SynthesizedInsight {
  title: string;
  summary: string;
  sources: AgentId[];
  confidence: number;
  action: string;
  priority: 'high' | 'medium' | 'low';
}

export interface AgentMemory {
  agentId: AgentId;
  entries: KnowledgeGraphEntry[];
  lastUpdated: string;
}

export interface AgentCapability {
  agentId: AgentId;
  role: AgentRole;
  capabilities: string[];
  inputTypes: string[];
  outputTypes: string[];
  baseConfidence: number;
}

export interface AgentPerformance {
  agentId: AgentId;
  totalRuns: number;
  successRate: number;
  averageDuration: number;
  averageConfidence: number;
  lastRun: string;
}

// Agent-specific request/response types

export interface AnalystRequest {
  invoices: number[];
  expenses: number[];
  contracts: number[];
  timePeriod: string;
}

export interface AnalystResponse {
  summary: Record<string, number>;
  anomalies: Array<{
    type: string;
    value: number;
    severity: string;
  }>;
  patterns: string[];
}

export interface ForecasterRequest {
  historicalData: Array<{
    date: string;
    value: number;
  }>;
  horizon: number;
  method?: 'exponential' | 'linear' | 'ensemble';
}

export interface ForecasterResponse {
  forecast: Array<{
    date: string;
    point: number;
    lower: number;
    upper: number;
  }>;
  confidence: number;
  anomalies: Array<{
    date: string;
    zscore: number;
  }>;
}

export interface TaxAdvisorRequest {
  income: number;
  expenses: number;
  country: string;
  businessType: string;
  optionalDeductions?: Record<string, number>;
}

export interface TaxAdvisorResponse {
  estimatedTax: number;
  breakdown: Record<string, number>;
  deductions: Record<string, number>;
  recommendations: string[];
}

export interface CashflowManagerRequest {
  invoices: Array<{
    dueDate: string;
    amount: number;
  }>;
  expenses: Array<{
    date: string;
    amount: number;
  }>;
  reserves: number;
}

export interface CashflowManagerResponse {
  projectedCashflow: number;
  runway: number;
  alerts: Array<{
    date: string;
    message: string;
    severity: string;
  }>;
  recommendations: string[];
}

export interface SignalScorerRequest {
  signal: {
    type: string;
    data: Record<string, unknown>;
  };
  userProfile: {
    riskTolerance: string;
    goals: string[];
    constraints: string[];
  };
}

export interface SignalScorerResponse {
  score: number;
  tier: 'HOT' | 'WARM' | 'MONITOR' | 'COLD';
  probability: number;
  action: string;
}

export interface OpportunityFinderRequest {
  leads: Array<{
    id: string;
    budget: number;
    status: string;
  }>;
  projects: Array<{
    id: string;
    status: string;
    value: number;
  }>;
  contracts: Array<{
    id: string;
    value: number;
    daysUntilRenewal: number;
  }>;
}

export interface OpportunityFinderResponse {
  opportunities: Array<{
    id: string;
    type: string;
    value: number;
    probability: number;
    action: string;
    priority: number;
  }>;
  topOpportunities: string[];
}

export interface RiskAssessorRequest {
  portfolio: {
    invoices: number;
    contracts: number;
    cashPosition: number;
  };
  metrics: Record<string, number>;
}

export interface RiskAssessorResponse {
  riskScore: number;
  exposures: Array<{
    type: string;
    severity: string;
    mitigation: string;
  }>;
  healthScore: number;
}

export interface TrendAnalyzerRequest {
  metric: string;
  timePeriod: string;
  dataPoints: Array<{
    date: string;
    value: number;
  }>;
}

export interface TrendAnalyzerResponse {
  trend: 'increasing' | 'decreasing' | 'stable' | 'cyclical';
  slope: number;
  rSquared: number;
  predictions: Array<{
    date: string;
    value: number;
  }>;
}
