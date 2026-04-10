-- D1 Migration 0006: Commitment pacing config seeds
-- Zero hardcoded values: every commitment.* threshold lives here.

INSERT OR IGNORE INTO app_config (key, value, description) VALUES
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
INSERT OR IGNORE INTO app_config (key, value, description) VALUES
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
