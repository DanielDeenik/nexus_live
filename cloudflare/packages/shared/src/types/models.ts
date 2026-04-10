/**
 * Database model types matching D1 schema
 */

export interface User {
  id: string;
  email: string;
  name: string;
  timezone: string;
  currency: string;
  country: string;
  businessType: string;
  vatNumber?: string;
  createdAt: string;
  updatedAt: string;
  lastLogin?: string;
}

export interface Invoice {
  id: string;
  userId: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  issueDate: string;
  dueDate: string;
  amount: number;
  currency: string;
  tax: number;
  status: 'draft' | 'sent' | 'viewed' | 'paid' | 'overdue' | 'cancelled';
  description: string;
  lineItems: LineItem[];
  paidDate?: string;
  paidAmount?: number;
  paymentMethod?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LineItem {
  id: string;
  invoiceId: string;
  description: string;
  quantity: number;
  rate: number;
  amount: number;
  taxRate: number;
}

export interface Expense {
  id: string;
  userId: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  tax: number;
  taxRate: number;
  taxable: boolean;
  receipt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Contract {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  title: string;
  hourlyRate: number;
  hoursPerWeek: number;
  startDate: string;
  endDate?: string;
  currency: string;
  status: 'active' | 'paused' | 'ended' | 'upcoming';
  renewalDate?: string;
  terms?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CashflowHistory {
  id: string;
  userId: string;
  date: string;
  income: number;
  expenses: number;
  tax: number;
  netCashflow: number;
  projectedCashflow?: number;
  confidence?: number;
  notes?: string;
  createdAt: string;
}

export interface BurnHistory {
  id: string;
  userId: string;
  date: string;
  dailyBurn: number;
  cumulativeBurn: number;
  runway: number;
  runwayDays: number;
  notes?: string;
  createdAt: string;
}

export interface WiseAccount {
  id: string;
  userId: string;
  accountId: string;
  currency: string;
  balance: number;
  balanceUSD: number;
  type: string;
  status: 'active' | 'inactive';
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface HedgingContract {
  id: string;
  userId: string;
  invoiceId?: string;
  originalAmount: number;
  originalCurrency: string;
  hedgedAmount: number;
  hedgedCurrency: string;
  rate: number;
  premium: number;
  expiryDate: string;
  status: 'active' | 'expired' | 'settled' | 'cancelled';
  provider: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarketSignal {
  id: string;
  userId: string;
  type: 'currency' | 'market' | 'industry' | 'lead' | 'operational';
  subtype: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  score: number;
  tier: 'HOT' | 'WARM' | 'MONITOR' | 'COLD';
  description: string;
  action: string;
  dataPoints: Record<string, number | string>;
  acknowledged: boolean;
  acknowledgedAt?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface MarketTrend {
  id: string;
  userId: string;
  metric: 'revenue' | 'expenses' | 'burn' | 'cashflow' | 'hours';
  period: 'weekly' | 'monthly' | 'quarterly';
  slope: number;
  intercept: number;
  rSquared: number;
  direction: 'increasing' | 'decreasing' | 'stable';
  startDate: string;
  endDate: string;
  dataPoints: TrendPoint[];
  createdAt: string;
}

export interface TrendPoint {
  date: string;
  value: number;
  trend: number;
}

export interface Lead {
  id: string;
  userId: string;
  companyName: string;
  contactName: string;
  email: string;
  phone?: string;
  budget: number;
  currency: string;
  industry: string;
  status: 'new' | 'contacted' | 'proposal' | 'negotiation' | 'won' | 'lost';
  score: 'HOT' | 'WARM' | 'MONITOR' | 'COLD';
  probability: number;
  source: string;
  notes: string;
  lastContact?: string;
  expectedClosingDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  name: string;
  description: string;
  scope: string;
  budget: number;
  currency: string;
  spent: number;
  status: 'active' | 'completed' | 'on-hold' | 'cancelled';
  completionPercentage: number;
  startDate: string;
  dueDate: string;
  endDate?: string;
  milestones?: Milestone[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  dueDate: string;
  completedDate?: string;
  status: 'pending' | 'completed' | 'overdue';
}

export interface Scenario {
  id: string;
  userId: string;
  name: string;
  description: string;
  type: 'revenue' | 'expense' | 'growth' | 'contraction' | 'custom';
  revenueChange: number;
  rateChange: number;
  hoursChange: number;
  expenseIncrease: number;
  startMonth: string;
  duration: number;
  projections: ScenarioProjection[];
  summary: ScenarioSummary;
  createdAt: string;
  updatedAt: string;
}

export interface ScenarioProjection {
  month: string;
  revenue: number;
  expenses: number;
  tax: number;
  netCashflow: number;
}

export interface ScenarioSummary {
  totalRevenue: number;
  totalTax: number;
  totalNetCashflow: number;
  impactPercentage: number;
}

export interface AgentKnowledgeEntry {
  id: string;
  userId: string;
  agentId: string;
  category: string;
  key: string;
  value: string | number | Record<string, unknown>;
  confidence: number;
  source: string;
  updatedAt: string;
}

export interface AgentConfig {
  id: string;
  userId: string;
  agentId: string;
  config: Record<string, unknown>;
  enabled: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface DataSource {
  id: string;
  userId: string;
  name: string;
  type: 'wise' | 'stripe' | 'manual' | 'email' | 'api';
  isActive: boolean;
  credentials?: Record<string, string>;
  lastSyncedAt?: string;
  nextSyncAt?: string;
  syncStatus: 'idle' | 'syncing' | 'error';
  createdAt: string;
  updatedAt: string;
}

export interface AppConfig {
  id: string;
  userId: string;
  key: string;
  value: string | number | boolean | Record<string, unknown>;
  type: 'string' | 'number' | 'boolean' | 'json';
  createdAt: string;
  updatedAt: string;
}

export interface RecalcLog {
  id: string;
  userId: string;
  type: 'forecast' | 'tax' | 'cashflow' | 'signals' | 'all';
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  duration?: number;
  error?: string;
  affectedRecords: number;
}

export interface ApiToken {
  id: string;
  userId: string;
  name: string;
  token: string;
  hashedToken: string;
  expiresAt: string;
  lastUsedAt?: string;
  scope: string[];
  isActive: boolean;
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
  userAgent?: string;
  ipAddress?: string;
  lastActivityAt: string;
  createdAt: string;
}
