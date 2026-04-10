-- D1 Migration: Initial Schema for Nexus Financial Platform
-- Timestamp: 2026-04-08
-- Description: Complete schema for multi-tenant financial OS for freelancers

-- ============================================================================
-- USERS AND AUTHENTICATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  linkedin_id TEXT UNIQUE,
  google_id TEXT UNIQUE,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'stakeholder' CHECK (role IN ('admin', 'stakeholder')),
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro', 'enterprise')),
  base_currency TEXT NOT NULL DEFAULT 'EUR',
  monthly_burn REAL,
  invited_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_linkedin_id ON users(linkedin_id);
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);

-- ============================================================================
-- API & SESSIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'write', 'admin')),
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_expires_at ON api_tokens(expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- ============================================================================
-- FINANCIAL CORE
-- ============================================================================

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue')),
  issued_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  paid_date TEXT,
  expected_cash_date TEXT,
  payment_lag_days INTEGER,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'moneybird', 'notion', 'api')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_issued_date ON invoices(issued_date);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_currency ON invoices(currency);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  category TEXT NOT NULL,
  description TEXT,
  date TEXT NOT NULL,
  source TEXT,
  plaid_transaction_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_expenses_user_id ON expenses(user_id);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_expenses_currency ON expenses(currency);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client TEXT NOT NULL,
  rate REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  rate_type TEXT NOT NULL CHECK (rate_type IN ('hourly', 'daily', 'monthly', 'fixed')),
  start_date TEXT NOT NULL,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused', 'terminated')),
  risk_score REAL,
  extracted_json TEXT,
  file_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contracts_user_id ON contracts(user_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_start_date ON contracts(start_date);

-- ============================================================================
-- FORECASTING & ANALYTICS
-- ============================================================================

CREATE TABLE IF NOT EXISTS cashflow_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  revenue REAL,
  costs REAL,
  profit REAL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  source TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, month, currency)
);

CREATE INDEX IF NOT EXISTS idx_cashflow_user_id ON cashflow_history(user_id);
CREATE INDEX IF NOT EXISTS idx_cashflow_month ON cashflow_history(month);

CREATE TABLE IF NOT EXISTS burn_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_burn_user_id ON burn_history(user_id);
CREATE INDEX IF NOT EXISTS idx_burn_month ON burn_history(month);

-- ============================================================================
-- BANKING & HEDGING
-- ============================================================================

CREATE TABLE IF NOT EXISTS wise_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency TEXT NOT NULL,
  balance REAL,
  is_jar INTEGER DEFAULT 0,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wise_accounts_user_id ON wise_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_wise_accounts_currency ON wise_accounts(currency);

CREATE TABLE IF NOT EXISTS hedging_contracts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pair TEXT NOT NULL,
  locked_rate REAL NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'completed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hedging_contracts_user_id ON hedging_contracts(user_id);
CREATE INDEX IF NOT EXISTS idx_hedging_contracts_pair ON hedging_contracts(pair);
CREATE INDEX IF NOT EXISTS idx_hedging_contracts_expiry ON hedging_contracts(expiry_date);

-- ============================================================================
-- MARKET INTELLIGENCE
-- ============================================================================

CREATE TABLE IF NOT EXISTS market_signals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  score REAL NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('hot', 'warm', 'monitor')),
  source TEXT NOT NULL,
  source_url TEXT,
  jurisdiction TEXT,
  discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_market_signals_user_id ON market_signals(user_id);
CREATE INDEX IF NOT EXISTS idx_market_signals_tier ON market_signals(tier);
CREATE INDEX IF NOT EXISTS idx_market_signals_score ON market_signals(score);
CREATE INDEX IF NOT EXISTS idx_market_signals_discovered_at ON market_signals(discovered_at);

CREATE TABLE IF NOT EXISTS market_trends (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  hiring_trend TEXT,
  budget_moment TEXT,
  description TEXT,
  industry TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (month, industry)
);

CREATE INDEX IF NOT EXISTS idx_market_trends_month ON market_trends(month);
CREATE INDEX IF NOT EXISTS idx_market_trends_industry ON market_trends(industry);

-- ============================================================================
-- OPPORTUNITIES & PROJECTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company TEXT,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'contacted', 'converted', 'rejected')),
  linkedin_url TEXT,
  scouted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  company TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused', 'archived')),
  source TEXT,
  external_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- ============================================================================
-- SCENARIOS & MODELING
-- ============================================================================

CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parameters_json TEXT,
  results_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scenarios_user_id ON scenarios(user_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_created_at ON scenarios(created_at);

-- ============================================================================
-- AGENT SYSTEM
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_configs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  llm_provider TEXT NOT NULL DEFAULT 'anthropic',
  llm_model TEXT NOT NULL DEFAULT 'claude-opus-4-1',
  max_tokens INTEGER DEFAULT 4096,
  temperature REAL DEFAULT 0.3,
  cache_ttl_seconds INTEGER DEFAULT 3600,
  rate_limit_per_day INTEGER DEFAULT 100000,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_configs_agent_id ON agent_configs(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_configs_enabled ON agent_configs(enabled);

CREATE TABLE IF NOT EXISTS agent_knowledge_graph (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent_configs(agent_id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('observation', 'insight', 'rule', 'entity', 'relation')),
  context_json TEXT,
  output_json TEXT,
  confidence REAL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  superseded_by TEXT REFERENCES agent_knowledge_graph(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_kg_agent_id ON agent_knowledge_graph(agent_id);
CREATE INDEX IF NOT EXISTS idx_kg_user_id ON agent_knowledge_graph(user_id);
CREATE INDEX IF NOT EXISTS idx_kg_entry_type ON agent_knowledge_graph(entry_type);
CREATE INDEX IF NOT EXISTS idx_kg_confidence ON agent_knowledge_graph(confidence);
CREATE INDEX IF NOT EXISTS idx_kg_created_at ON agent_knowledge_graph(created_at);
CREATE INDEX IF NOT EXISTS idx_kg_superseded_by ON agent_knowledge_graph(superseded_by);

-- ============================================================================
-- DATA INTEGRATIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS data_sources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('notion', 'moneybird', 'plaid', 'wise', 'stripe', 'zapier', 'custom_api')),
  config_json TEXT NOT NULL,
  last_sync_at TEXT,
  sync_status TEXT DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'error', 'paused')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_data_sources_user_id ON data_sources(user_id);
CREATE INDEX IF NOT EXISTS idx_data_sources_type ON data_sources(type);

-- ============================================================================
-- CONFIGURATION & AUDIT
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_app_config_updated_at ON app_config(updated_at);

CREATE TABLE IF NOT EXISTS recalc_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'error')),
  steps_json TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_recalc_log_user_id ON recalc_log(user_id);
CREATE INDEX IF NOT EXISTS idx_recalc_log_started_at ON recalc_log(started_at);
CREATE INDEX IF NOT EXISTS idx_recalc_log_status ON recalc_log(status);
