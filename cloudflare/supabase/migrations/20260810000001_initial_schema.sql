-- Nexus — Supabase foundation: initial schema (Postgres port of the D1 schema)
-- Conventions: uuid PKs (gen_random_uuid), numeric(14,2) money, timestamptz,
-- jsonb for *_json columns, boolean for former INTEGER flags. No hardcoded
-- business values — tunables live in app_config / agent_configs.

-- ============================================================================
-- IDENTITY: profiles (was `users`; identity itself lives in auth.users)
-- ============================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text not null default '',
  avatar_url text,
  role text not null default 'stakeholder' check (role in ('admin', 'stakeholder')),
  plan text default 'free' check (plan in ('free', 'starter', 'pro', 'enterprise')),
  base_currency text not null default 'EUR',
  monthly_burn numeric(14,2),
  invited_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  last_login timestamptz
);

-- ============================================================================
-- FINANCIAL CORE
-- ============================================================================

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  client text not null,
  amount numeric(14,2) not null,
  currency text not null default 'EUR',
  status text not null default 'pending' check (status in ('pending', 'paid', 'overdue')),
  issued_date date not null,
  due_date date not null,
  paid_date date,
  expected_cash_date date,
  payment_lag_days integer,
  source text not null default 'manual' check (source in ('manual', 'moneybird', 'notion', 'api')),
  external_id text,
  created_at timestamptz not null default now(),
  unique (user_id, source, external_id)
);
create index if not exists idx_invoices_user_id on public.invoices(user_id);
create index if not exists idx_invoices_status on public.invoices(status);
create index if not exists idx_invoices_due_date on public.invoices(due_date);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(14,2) not null,
  currency text not null default 'EUR',
  category text not null,
  description text,
  date date not null,
  source text,
  external_txn_id text,
  created_at timestamptz not null default now(),
  unique (user_id, external_txn_id)
);
create index if not exists idx_expenses_user_id on public.expenses(user_id);
create index if not exists idx_expenses_category on public.expenses(category);
create index if not exists idx_expenses_date on public.expenses(date);

create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  client text not null,
  rate numeric(14,2) not null,
  currency text not null default 'EUR',
  rate_type text not null check (rate_type in ('hourly', 'daily', 'monthly', 'fixed')),
  start_date date not null,
  end_date date,
  status text not null default 'active' check (status in ('active', 'completed', 'paused', 'terminated')),
  risk_score numeric(5,2),
  extracted_json jsonb,
  file_key text,
  created_at timestamptz not null default now()
);
create index if not exists idx_contracts_user_id on public.contracts(user_id);
create index if not exists idx_contracts_status on public.contracts(status);

-- ============================================================================
-- FORECASTING & ANALYTICS
-- ============================================================================

create table if not exists public.cashflow_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  month text not null,
  revenue numeric(14,2),
  costs numeric(14,2),
  profit numeric(14,2),
  currency text not null default 'EUR',
  source text,
  created_at timestamptz not null default now(),
  unique (user_id, month, currency)
);
create index if not exists idx_cashflow_user_id on public.cashflow_history(user_id);

create table if not exists public.burn_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  month text not null,
  amount numeric(14,2) not null,
  currency text not null default 'EUR',
  created_at timestamptz not null default now(),
  unique (user_id, month)
);
create index if not exists idx_burn_user_id on public.burn_history(user_id);

-- ============================================================================
-- BANKING & HEDGING
-- ============================================================================

create table if not exists public.wise_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  currency text not null,
  balance numeric(14,2),
  is_jar boolean not null default false,
  label text,
  external_id text,
  created_at timestamptz not null default now(),
  unique (user_id, external_id)
);
create index if not exists idx_wise_accounts_user_id on public.wise_accounts(user_id);

create table if not exists public.hedging_contracts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  pair text not null,
  locked_rate numeric(14,6) not null,
  amount numeric(14,2) not null,
  currency text not null,
  expiry_date date not null,
  status text not null default 'active' check (status in ('active', 'expired', 'completed')),
  created_at timestamptz not null default now()
);
create index if not exists idx_hedging_user_id on public.hedging_contracts(user_id);

-- ============================================================================
-- MARKET INTELLIGENCE (market_signals also backs the job/gig feed)
-- ============================================================================

create table if not exists public.market_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  company text,
  location text,
  score numeric(5,2) not null,
  tier text not null check (tier in ('hot', 'warm', 'monitor')),
  source text not null,
  source_url text,
  jurisdiction text,
  discovered_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (user_id, source, source_url)
);
create index if not exists idx_market_signals_user_id on public.market_signals(user_id);
create index if not exists idx_market_signals_tier on public.market_signals(tier);
create index if not exists idx_market_signals_score on public.market_signals(score);

create table if not exists public.market_trends (
  id uuid primary key default gen_random_uuid(),
  month text not null,
  hiring_trend text,
  budget_moment text,
  description text,
  industry text not null,
  created_at timestamptz not null default now(),
  unique (month, industry)
);
create index if not exists idx_market_trends_month on public.market_trends(month);

-- ============================================================================
-- OPPORTUNITIES & PROJECTS
-- ============================================================================

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  company text,
  role text,
  status text not null default 'active' check (status in ('active', 'contacted', 'converted', 'rejected')),
  linkedin_url text,
  scouted_at timestamptz not null default now()
);
create index if not exists idx_leads_user_id on public.leads(user_id);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  company text,
  description text,
  status text not null default 'active' check (status in ('active', 'completed', 'paused', 'archived')),
  source text,
  external_url text,
  created_at timestamptz not null default now()
);
create index if not exists idx_projects_user_id on public.projects(user_id);

-- ============================================================================
-- SCENARIOS & MODELING
-- ============================================================================

create table if not exists public.scenarios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  parameters_json jsonb,
  results_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_scenarios_user_id on public.scenarios(user_id);

-- ============================================================================
-- AGENT SYSTEM
-- ============================================================================

create table if not exists public.agent_configs (
  -- id kept as text (stable seed ids like 'agent_orchestrator_001'); no FK
  -- references it — agent_knowledge_graph joins on agent_id.
  id text primary key,
  agent_id text not null unique,
  display_name text not null,
  system_prompt text not null,
  llm_provider text not null default 'anthropic',
  llm_model text not null default 'claude-opus-4-1',
  max_tokens integer default 4096,
  temperature numeric(3,2) default 0.3,
  cache_ttl_seconds integer default 3600,
  rate_limit_per_day integer default 100000,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_agent_configs_agent_id on public.agent_configs(agent_id);

create table if not exists public.agent_knowledge_graph (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references public.agent_configs(agent_id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  entry_type text not null check (entry_type in ('observation', 'insight', 'rule', 'entity', 'relation')),
  context_json jsonb,
  output_json jsonb,
  confidence numeric(4,3) default 0.5,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  superseded_by uuid references public.agent_knowledge_graph(id) on delete set null
);
create index if not exists idx_kg_agent_id on public.agent_knowledge_graph(agent_id);
create index if not exists idx_kg_user_id on public.agent_knowledge_graph(user_id);

-- ============================================================================
-- DATA INTEGRATIONS
-- ============================================================================

create table if not exists public.data_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('notion', 'moneybird', 'plaid', 'wise', 'stripe', 'gocardless', 'zapier', 'custom_api')),
  config_json jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  sync_status text default 'idle' check (sync_status in ('idle', 'syncing', 'error', 'paused')),
  error_message text,
  created_at timestamptz not null default now(),
  unique (user_id, type)
);
create index if not exists idx_data_sources_user_id on public.data_sources(user_id);

-- ============================================================================
-- CONFIGURATION & AUDIT
-- ============================================================================

create table if not exists public.app_config (
  key text primary key,
  value text not null,
  description text,
  updated_at timestamptz not null default now()
);

create table if not exists public.recalc_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  trigger text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'error')),
  steps_json jsonb,
  error_message text
);
create index if not exists idx_recalc_log_user_id on public.recalc_log(user_id);

-- ============================================================================
-- COMMITMENT PACING (was 0005)
-- ============================================================================

create table if not exists public.commitment_stages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text,
  commitment_type text not null check (commitment_type in ('contract','expense','investment','project','hire','subscription')),
  current_stage text not null default 'explore' check (current_stage in ('explore','soft_commit','hard_commit','locked','abandoned')),
  amount numeric(14,2),
  currency text not null default 'EUR',
  monthly_impact numeric(14,2),
  counterparty text,
  related_contract_id uuid references public.contracts(id) on delete set null,
  related_invoice_id uuid references public.invoices(id) on delete set null,
  related_scenario_id uuid references public.scenarios(id) on delete set null,
  gate_rules_json jsonb,
  stage_history_json jsonb,
  risk_score numeric(5,2) default 0,
  reversibility_score numeric(4,3) default 1.0,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_commitment_stages_user_id on public.commitment_stages(user_id);
create index if not exists idx_commitment_stages_current_stage on public.commitment_stages(current_stage);

create table if not exists public.commitment_transitions (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null references public.commitment_stages(id) on delete cascade,
  from_stage text not null,
  to_stage text not null,
  gate_result_json jsonb,
  decision_notes text,
  decided_by text,
  financial_snapshot_json jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_commitment_transitions_commitment_id on public.commitment_transitions(commitment_id);
