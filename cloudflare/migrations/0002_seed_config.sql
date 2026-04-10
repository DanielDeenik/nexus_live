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
