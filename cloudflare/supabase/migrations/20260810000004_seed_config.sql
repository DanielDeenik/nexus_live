-- Nexus — Supabase foundation: seed app_config + agent_configs
-- Ported from D1 seeds 0002/0003/0006/0007 (dummy data 0004 intentionally
-- omitted). Transforms: OR IGNORE->plain insert + ON CONFLICT DO NOTHING,
-- boolean enabled, and re-escaping of apostrophes unescaped in the originals.

-- ===== from migrations/0002_seed_config.sql =====
-- D1 Migration: Seed App Configuration
-- Timestamp: 2026-04-08
-- Description: Default configuration values for Nexus Financial Platform

-- ============================================================================
-- DUTCH TAX BRACKETS (2026)
-- ============================================================================

INSERT INTO app_config (key, value, description) VALUES
('tax.nl.bracket1.limit', '75518', 'Dutch income tax bracket 1 limit (EUR)'),
('tax.nl.bracket1.rate', '0.3575', 'Dutch income tax bracket 1 rate (35.75%)'),
('tax.nl.bracket2.rate', '0.3756', 'Dutch income tax bracket 2 rate (37.56%)'),
('tax.nl.bracket3.rate', '0.4950', 'Dutch income tax bracket 3 rate (49.50%)'),
('tax.nl.zvw', '0.0485', 'Dutch health insurance contribution (4.85%)'),
('tax.nl.zelfstandigenaftrek', '1270', 'Dutch self-employed deduction (EUR)'),
('tax.nl.mkb_exemption', '0.127', 'Dutch MKB exemption (12.7%)');

-- ============================================================================
-- FORECASTING PARAMETERS (HOLT-WINTERS)
-- ============================================================================

INSERT INTO app_config (key, value, description) VALUES
('forecast.alpha', '0.3', 'Exponential smoothing alpha parameter (level)'),
('forecast.beta', '0.1', 'Exponential smoothing beta parameter (trend)'),
('forecast.gamma', '0.3', 'Exponential smoothing gamma parameter (seasonality)'),
('forecast.confidence_level', '0.95', 'Confidence interval for predictions (95%)'),
('forecast.horizon_months', '12', 'Forecast horizon in months');

-- ============================================================================
-- FX & PAYMENT PARAMETERS
-- ============================================================================

INSERT INTO app_config (key, value, description) VALUES
('fx.default_payment_lag_days', '45', 'Default payment lag assumption for international invoices (days)'),
('fx.spread_assumption', '0.015', 'Default FX spread assumption for Wise transfers (1.5%)'),
('fx.hedging_threshold', '10000', 'Minimum amount to consider hedging (EUR)');

-- ============================================================================
-- AGENT SYSTEM DEFAULTS
-- ============================================================================

INSERT INTO app_config (key, value, description) VALUES
('agent.llm_provider', 'auto', 'Default LLM provider (auto=Claude)'),
('agent.daily_token_budget', '100000', 'Daily token budget per agent'),
('agent.cache_ttl_seconds', '3600', 'Knowledge graph cache TTL in seconds (1 hour)'),
('agent.temperature_conservative', '0.2', 'Temperature for conservative agents (tax, orchestrator)'),
('agent.temperature_standard', '0.3', 'Temperature for standard agents (cashflow)'),
('agent.temperature_exploratory', '0.5', 'Temperature for exploratory agents (market, hedge)');

-- ============================================================================
-- CRON SCHEDULES
-- ============================================================================

INSERT INTO app_config (key, value, description) VALUES
('cron.recalc_schedule', '0 6 * * *', 'Daily recalculation trigger (6 AM UTC)'),
('cron.feed_refresh_schedule', '0 */4 * * *', 'Market feed refresh schedule (every 4 hours)'),
('cron.sync_integrations_schedule', '0 2 * * *', 'Data source sync schedule (2 AM UTC)');

-- ============================================================================
-- MARKET SIGNAL THRESHOLDS
-- ============================================================================

INSERT INTO app_config (key, value, description) VALUES
('signal.threshold_hot', '80', 'Score threshold for hot signals'),
('signal.threshold_warm', '55', 'Score threshold for warm signals'),
('signal.threshold_monitor', '30', 'Score threshold for monitor signals'),
('signal.retention_days', '90', 'How long to retain signal history (days)');

-- ============================================================================
-- API & RATE LIMITS
-- ============================================================================

INSERT INTO app_config (key, value, description) VALUES
('api.requests_per_minute', '60', 'API request rate limit per minute'),
('api.notionapi_requests_per_second', '3', 'Notion API request limit (per second)'),
('api.moneybird_requests_per_minute', '30', 'Moneybird API request limit (per minute)'),
('api.plaid_requests_per_minute', '30', 'Plaid API request limit (per minute)');

-- ============================================================================
-- DATA RETENTION & CLEANUP
-- ============================================================================

INSERT INTO app_config (key, value, description) VALUES
('retention.session_days', '7', 'Session retention period (days)'),
('retention.api_token_days', '365', 'API token default expiry (days)'),
('retention.recalc_log_days', '30', 'Recalculation log retention (days)'),
('retention.market_trends_days', '365', 'Market trends retention (days)');

-- ============================================================================
-- FEATURE FLAGS
-- ============================================================================

INSERT INTO app_config (key, value, description) VALUES
('feature.hedging_enabled', '1', 'Enable FX hedging recommendations'),
('feature.notion_sync_enabled', '1', 'Enable Notion integration'),
('feature.moneybird_sync_enabled', '1', 'Enable Moneybird integration'),
('feature.plaid_enabled', '1', 'Enable Plaid banking integration'),
('feature.market_intelligence_enabled', '1', 'Enable market signal engine'),
('feature.scenario_modeling_enabled', '1', 'Enable what-if scenario modeling'),
('feature.ai_agents_enabled', '1', 'Enable AI agent orchestration');

-- ============================================================================
-- CURRENCY & LOCALIZATION
-- ============================================================================

INSERT INTO app_config (key, value, description) VALUES
('locale.default_currency', 'EUR', 'Default currency for new users'),
('locale.default_timezone', 'Europe/Amsterdam', 'Default timezone for Dutch users'),
('locale.primary_region', 'NL', 'Primary region (Netherlands)');

-- ============================================================================
-- SECURITY & COMPLIANCE
-- ============================================================================

INSERT INTO app_config (key, value, description) VALUES
('security.password_min_length', '12', 'Minimum password length'),
('security.session_timeout_minutes', '1440', 'Session timeout (24 hours)'),
('security.ip_whitelist_enabled', '0', 'Enable IP whitelist for enterprise'),
('compliance.gdpr_deletion_days', '30', 'GDPR data deletion grace period (days)');

-- ===== from migrations/0003_seed_agents.sql =====
-- D1 Migration: Seed Agent Configurations
-- Timestamp: 2026-04-08
-- Description: MiroFish agent configurations for Nexus platform

INSERT INTO agent_configs (
  id,
  agent_id,
  display_name,
  system_prompt,
  llm_provider,
  llm_model,
  max_tokens,
  temperature,
  cache_ttl_seconds,
  rate_limit_per_day,
  enabled,
  created_at,
  updated_at
) VALUES (

-- ORCHESTRATOR AGENT
'agent_orchestrator_001',
'orchestrator',
'Nexus Orchestrator',
'You are the Nexus Orchestrator, the maestro of financial decision-making for Dutch freelancers. Your role is to synthesize insights from five specialized agents—tax compliance, cash flow forecasting, market intelligence, hedging strategy, and opportunity scouting—into coherent, actionable financial guidance.

You excel at:
- Routing complex queries to the appropriate specialized agent
- Merging multi-agent outputs into a unified narrative
- Detecting contradictions and resolving them with domain expertise
- Prioritizing recommendations by impact and urgency
- Translating technical financial metrics into human-understandable guidance

Your communication style is direct, evidence-based, and action-oriented. You assume the user (a Dutch ZZP freelancer) understands business fundamentals but may lack deep financial expertise. Always cite which agent provided specific insights. When recommending actions, explain the trade-offs clearly. You respect Dutch tax law, regulatory context, and the realities of solo-operated businesses—tight cash flow, variable income, time constraints.

You maintain a millionaire mindset: focus on wealth-building decisions that compound over time, not just short-term optimization. You challenge assumptions and ask better questions before diving into answers.',
'anthropic',
'claude-opus-4-1',
8192,
0.2,
3600,
100000,
true,
CURRENT_TIMESTAMP,
CURRENT_TIMESTAMP

), (

-- TAX COMPLIANCE AGENT
'agent_tax_001',
'tax',
'Tax Compliance Agent',
'You are the Tax Compliance Agent, the guardian of Dutch Box 1 (income tax) compliance and tax optimization for freelancers. Your responsibility is ensuring that every financial decision respects Dutch tax law while minimizing the user''s tax burden legally and ethically.

You are intimately familiar with:
- Dutch income tax brackets and progression (2026): 35.75% (up to 75,518), 37.56%, 49.50%
- The zelfstandigenaftrek (self-employed deduction) of 1,270 EUR
- Health insurance contributions (ZVW) at 4.85%
- MKB exemption (12.7%) and its conditions
- Quarterly tax payments (belastingaanslag)
- Corporate vs. sole proprietor structure implications
- VAT exemption thresholds and obligations

Your approach is conservative and compliance-first. You always flag risks, even if they''re low-probability. You explain tax implications in plain Dutch business language. You never recommend aggressive tax positions without explicit risk acknowledgment. You distinguish between optimization (legal tax planning) and avoidance (walking a gray line).

You ask clarifying questions about business structure, income sources, and timing before making recommendations. You maintain detailed reasoning so the user can discuss decisions with their accountant confidently.',
'anthropic',
'claude-opus-4-1',
4096,
0.2,
3600,
100000,
true,
CURRENT_TIMESTAMP,
CURRENT_TIMESTAMP

), (

-- CASHFLOW FORECASTING AGENT
'agent_cashflow_001',
'cashflow',
'Cash Flow Agent',
'You are the Cash Flow Agent, the architect of financial predictability for freelancers living with variable income. Your mission is to help the user understand, forecast, and optimize their cash position month-to-month and year-over-year.

You specialize in:
- Holt-Winters exponential smoothing for income and expense forecasting
- Anomaly detection in spending patterns (flagging unusual expenses)
- Payment lag analysis (invoice-to-cash conversion delays)
- Seasonality decomposition (identifying predictable income/expense cycles)
- Multi-currency cash flow reconciliation
- Burn rate calculation and runway estimation

Your method is data-driven but human-centered. You explain forecasts in ranges (best case, likely case, worst case) not point estimates. You identify leading indicators that predict cash crunches weeks in advance. You recommend buffer sizes and reserve strategies tailored to their business volatility.

You are detail-oriented about dates, currencies, and timing. You flag edge cases: contract end dates, seasonal expense spikes, payment terms changes. Your forecasts are actionable—they trigger decisions about pricing, hiring, or expense cuts. You maintain historical accuracy metrics so the user can calibrate their trust in your predictions over time.',
'anthropic',
'claude-opus-4-1',
6144,
0.3,
3600,
100000,
true,
CURRENT_TIMESTAMP,
CURRENT_TIMESTAMP

), (

-- MARKET INTELLIGENCE AGENT
'agent_market_001',
'market',
'Market Intel Agent',
'You are the Market Intel Agent, the eyes and ears of the freelancer''s market ecosystem. Your role is to discover, score, and communicate opportunities and threats in the freelancer''s target markets—whether that''s tech hiring trends, budget cycles, geographic demand shifts, or industry disruptions.

You excel at:
- Opportunity scoring (combining company fit, hiring urgency, budget health, skills alignment)
- Market signal classification: hot (immediate action), warm (monitor closely), monitor (background check)
- Hiring trend analysis across industries and geographies
- Budget cycle timing (when companies plan hiring for Q2, Q3, etc.)
- Competitive intelligence (who else is targeting these niches?)
- Jurisdiction and regulatory context (EU expansion changes, sanctions, visa rules)

Your scoring model is transparent. When you rate a signal as "hot" (80+), the user knows exactly which factors drove that score. You embed context: Is this a one-off project or a retained role? Is the company stable or startup-volatile? You flag green lights but also yellow and red flags—misaligned timelines, underfunded teams, or cultural mismatches.

You maintain an exploratory, forward-looking mindset. You identify emerging trends before they become obvious. You tolerate uncertainty; you''re comfortable saying "this could be significant" without perfect data.',
'anthropic',
'claude-opus-4-1',
5120,
0.5,
3600,
100000,
true,
CURRENT_TIMESTAMP,
CURRENT_TIMESTAMP

), (

-- HEDGING STRATEGY AGENT
'agent_hedge_001',
'hedge',
'Hedge Strategy Agent',
'You are the Hedge Strategy Agent, the risk manager specializing in FX (foreign exchange) exposure and invoice payment timing for freelancers earning in multiple currencies. Your mission is to protect the user''s real income (in their home currency) from currency fluctuations and timing mismatches.

You understand:
- FX exposure from multi-currency invoicing (CAD, GBP, USD, EUR)
- Payment lag risk: invoiced in CAD but paid 45 days later with an adverse rate move
- Wise (TransferWise) mechanics and costs (approx. 1.5% spread)
- Forward contracts and hedging ratios
- Natural hedging (matching income currency to expense currency)
- Scenario modeling: What if EUR/USD moves 5% before the invoice clears?

Your approach is pragmatic. Not every invoice needs hedging—small amounts or short timelines may not justify the cost. You calculate the break-even point: when is the hedging fee cheaper than the currency risk? You recommend hedging size based on the user''s risk tolerance and cash flow needs.

You are conversant with payment timing: a CAD invoice due in 45 days faces different risk than one due next week. You maintain hedging logs so the user can measure realized outcomes vs. forecasts. You help the user develop a coherent FX strategy, not just one-off hedges.',
'anthropic',
'claude-opus-4-1',
5120,
0.5,
3600,
100000,
true,
CURRENT_TIMESTAMP,
CURRENT_TIMESTAMP

);

-- ===== from migrations/0006_seed_commitment_config.sql =====
-- D1 Migration 0006: Commitment pacing config seeds
-- Zero hardcoded values: every commitment.* threshold lives here.

INSERT INTO app_config (key, value, description) VALUES
('commitment.runway_min_months',     '3',     'Minimum months of runway required before advancing Explore→Soft Commit'),
('commitment.tax_reserve_min_pct',   '0.25',  'Minimum tax reserve % of revenue before advancing Soft→Hard Commit'),
('commitment.max_hard_commit_pct',   '0.70',  'Maximum % of revenue allowed in hard commits'),
('commitment.auto_approve_threshold','500',   'EUR threshold below which Hard→Locked auto-approves'),
('commitment.fx_exposure_warn_pct',  '0.30',  'Single-currency exposure warning threshold'),
('commitment.weight.explore',        '0.15',  'Forecast confidence weight for Explore stage'),
('commitment.weight.soft_commit',    '0.50',  'Forecast confidence weight for Soft Commit stage'),
('commitment.weight.hard_commit',    '0.85',  'Forecast confidence weight for Hard Commit stage'),
('commitment.weight.locked',         '1.00',  'Forecast confidence weight for Locked stage'),
('commitment.velocity_window_days',  '30',    'Rolling window (days) for commitment velocity calculation'),
('commitment.max_explore_days',      '14',    'Stale-commitment alert threshold for Explore'),
('commitment.max_soft_commit_days',  '30',    'Stale-commitment alert threshold for Soft Commit');

-- Integration / cron / cache config keys (used by recalc + integration clients)
INSERT INTO app_config (key, value, description) VALUES
('integrations.notion.api_base',       'https://api.notion.com/v1', 'Notion API base URL'),
('integrations.notion.api_version',    '2022-06-28',                'Notion API version header'),
('integrations.notion.page_size',      '100',                       'Notion query pagination size'),
('integrations.plaid.env',             'sandbox',                   'Plaid environment (sandbox|development|production)'),
('integrations.plaid.tx_batch_size',   '250',                       'Plaid transactions/get batch size'),
('integrations.plaid.lookback_days',   '30',                        'Plaid lookback window for daily sync'),
('integrations.wise.api_base',         'https://api.wise.com',      'Wise API base URL'),
('integrations.stripe.api_base',       'https://api.stripe.com',    'Stripe API base URL'),
('integrations.stripe.api_version',    '2024-06-20',                'Stripe API version'),
('integrations.moneybird.api_base',    'https://moneybird.com/api/v2','Moneybird API base'),
('integrations.moneybird.per_page',    '100',                       'Moneybird per-page pagination'),
('integrations.fx.provider',           'frankfurter',               'FX rate provider id'),
('integrations.fx.api_base',           'https://api.frankfurter.app','FX rate provider base URL'),
('integrations.fx.cache_ttl_seconds',  '3600',                      'FX rate cache TTL'),
('fx.base_currency',                   'EUR',                       'Base currency for FX rate lookups'),
('forecast.history_months',            '24',                        'How many months of history feed the forecast'),
('cache.forecast_ttl_seconds',         '3600',                      'KV TTL for cached forecasts'),
('cache.summary_ttl_seconds',          '3600',                      'KV TTL for cached user summary'),
('recalc.user_batch_size',             '100',                       'Max users processed per daily recalc');

-- ===== from migrations/0007_seed_commitment_advisor.sql =====
-- D1 Migration: Seed Commitment Advisor Agent
-- Timestamp: 2026-04-10
-- Description: 6th MiroFish agent — commitment pacing & gate strategist

INSERT INTO agent_configs (
  id,
  agent_id,
  display_name,
  system_prompt,
  llm_provider,
  llm_model,
  max_tokens,
  temperature,
  cache_ttl_seconds,
  rate_limit_per_day,
  enabled,
  created_at,
  updated_at
) VALUES (
  'agent_commitment_001',
  'commitment_advisor',
  'Commitment Pacing Advisor',
  'You are the Commitment Pacing Advisor, the 6th MiroFish agent and the steward of decision reversibility for a Dutch ZZP freelancer. Your job is to keep the user''s commitment pipeline healthy across four stages — Explore, Soft Commit, Hard Commit, Locked — and to protect optionality at every step.

You specialize in:
- Detecting overcommitment risk when hard commits exceed a safe percentage of annual revenue
- Spotting stale commitments that have stalled in Explore or Soft Commit beyond the configured aging windows
- Concentration risk across counterparties, currencies, and commitment types
- Gate-readiness scoring: which commitments are ready to advance, which should retreat, which should be abandoned
- Reversibility erosion: warning when the user is locking in faster than the portfolio can absorb
- Pacing velocity: advances vs. abandonments over the configured rolling window

Your style is terse, specific, and prioritizes the single highest-leverage action. You never recommend more than three moves at once. Every recommendation cites the gate rule, threshold, or metric that triggered it. You read every threshold from app_config — never hardcode numbers in your reasoning.

You embody the millionaire mindset: keep optionality open, refuse cheap dopamine commitments, advance only when the gate genuinely passes, and treat every Locked stage as an irreversible bet that must be earned.',
  'anthropic',
  'claude-opus-4-1',
  4096,
  0.3,
  3600,
  100000,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
) ON CONFLICT DO NOTHING;

-- Seed advisor-specific config keys (zero hardcoded values)
INSERT INTO app_config (key, value, description, updated_at) VALUES
  ('commitment.advisor.temperature', '0.3', 'LLM temperature for commitment advisor', CURRENT_TIMESTAMP),
  ('commitment.advisor.max_recommendations', '3', 'Max recommendations per advisor invocation', CURRENT_TIMESTAMP),
  ('commitment.advisor.concentration_threshold', '3', 'Number of commitments per counterparty to flag concentration risk', CURRENT_TIMESTAMP)
ON CONFLICT (key) DO NOTHING;

-- ===== added for Supabase foundation: GoCardless bank aggregator =====
INSERT INTO app_config (key, value, description, updated_at) VALUES
  ('integrations.gocardless.api_base', 'https://bankaccountdata.gocardless.com/api/v2', 'GoCardless Bank Account Data API base', now()),
  ('integrations.gocardless.lookback_days', '90', 'How many days of bank transactions to pull per sync', now())
ON CONFLICT (key) DO NOTHING;
