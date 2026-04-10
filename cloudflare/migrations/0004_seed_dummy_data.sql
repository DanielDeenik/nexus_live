-- D1 Migration: Seed Dummy Data for Development
-- Timestamp: 2026-04-08
-- Description: Realistic development and demo data for Dutch freelancer

-- ============================================================================
-- USERS
-- ============================================================================

-- Admin user: Dan (founder)
INSERT INTO users (id, email, name, password_hash, role, plan, base_currency, monthly_burn, created_at, last_login)
VALUES (
  'user_dan_001',
  'deenikdaniel@gmail.com',
  'Daniel de Eenig',
  'placeholder_hash_not_for_production_use_only_dev',
  'admin',
  'pro',
  'EUR',
  5500.00,
  '2025-06-15T10:30:00Z',
  '2026-04-08T09:00:00Z'
);

-- Stakeholder user: Sarah (investor)
INSERT INTO users (id, email, name, password_hash, role, plan, base_currency, monthly_burn, invited_by, created_at, last_login)
VALUES (
  'user_sarah_001',
  'sarah@nexusventures.com',
  'Sarah Investor',
  'placeholder_hash_not_for_production_use_only_dev',
  'stakeholder',
  'pro',
  'EUR',
  NULL,
  'user_dan_001',
  '2025-09-20T14:15:00Z',
  '2026-04-07T16:45:00Z'
);

-- ============================================================================
-- INVOICES (6 months, realistic freelance rates)
-- ============================================================================

INSERT INTO invoices (id, user_id, client, amount, currency, status, issued_date, due_date, paid_date, expected_cash_date, payment_lag_days, source, created_at)
VALUES
('inv_001_2025_10', 'user_dan_001', 'TechCorp Amsterdam', 8500.00, 'EUR', 'paid', '2025-10-15', '2025-11-15', '2025-11-18', '2025-11-18', 3, 'manual', '2025-10-15T09:30:00Z'),
('inv_002_2025_11', 'user_dan_001', 'FinTech Startup', 12000.00, 'CAD', 'paid', '2025-11-08', '2025-12-08', '2025-12-20', '2025-12-21', 42, 'notion', '2025-11-08T10:15:00Z'),
('inv_003_2025_12', 'user_dan_001', 'Acme Consulting', 6500.00, 'EUR', 'paid', '2025-12-01', '2026-01-01', '2026-01-10', '2026-01-10', 9, 'manual', '2025-12-01T08:45:00Z'),
('inv_004_2026_01', 'user_dan_001', 'Global Media Co', 9200.00, 'USD', 'paid', '2026-01-12', '2026-02-12', '2026-02-25', '2026-02-26', 44, 'api', '2026-01-12T11:20:00Z'),
('inv_005_2026_02', 'user_dan_001', 'TechCorp Amsterdam', 8500.00, 'EUR', 'pending', '2026-02-10', '2026-03-12', NULL, '2026-03-20', 38, 'manual', '2026-02-10T09:50:00Z'),
('inv_006_2026_03', 'user_dan_001', 'FinTech Startup', 14000.00, 'CAD', 'pending', '2026-03-15', '2026-04-15', NULL, '2026-05-05', 51, 'notion', '2026-03-15T10:30:00Z');

-- ============================================================================
-- EXPENSES (12 months, realistic Dutch ZZP costs)
-- ============================================================================

INSERT INTO expenses (id, user_id, amount, currency, category, description, date, source, created_at)
VALUES
-- October 2025
('exp_2025_10_001', 'user_dan_001', 350.00, 'EUR', 'coworking', 'WeWork Amsterdam monthly membership', '2025-10-01', 'manual', '2025-10-01T08:00:00Z'),
('exp_2025_10_002', 'user_dan_001', 99.99, 'EUR', 'software', 'Adobe Creative Cloud annual renewal', '2025-10-05', 'manual', '2025-10-05T10:15:00Z'),
('exp_2025_10_003', 'user_dan_001', 45.00, 'EUR', 'travel', 'Train ticket to Rotterdam client meeting', '2025-10-12', 'manual', '2025-10-12T07:30:00Z'),
('exp_2025_10_004', 'user_dan_001', 850.00, 'EUR', 'insurance', 'Professional liability insurance monthly', '2025-10-15', 'manual', '2025-10-15T09:00:00Z'),
-- November 2025
('exp_2025_11_001', 'user_dan_001', 350.00, 'EUR', 'coworking', 'WeWork Amsterdam monthly membership', '2025-11-01', 'manual', '2025-11-01T08:00:00Z'),
('exp_2025_11_002', 'user_dan_001', 125.00, 'EUR', 'software', 'Slack Pro tier monthly', '2025-11-05', 'manual', '2025-11-05T10:00:00Z'),
('exp_2025_11_003', 'user_dan_001', 350.00, 'EUR', 'accounting', 'Accountant quarterly consultation', '2025-11-10', 'manual', '2025-11-10T14:00:00Z'),
('exp_2025_11_004', 'user_dan_001', 850.00, 'EUR', 'insurance', 'Professional liability insurance monthly', '2025-11-15', 'manual', '2025-11-15T09:00:00Z'),
('exp_2025_11_005', 'user_dan_001', 2100.00, 'EUR', 'travel', 'Flight to London + accommodation (client meeting)', '2025-11-18', 'manual', '2025-11-18T06:00:00Z'),
-- December 2025
('exp_2025_12_001', 'user_dan_001', 350.00, 'EUR', 'coworking', 'WeWork Amsterdam monthly membership', '2025-12-01', 'manual', '2025-12-01T08:00:00Z'),
('exp_2025_12_002', 'user_dan_001', 125.00, 'EUR', 'software', 'Slack Pro tier monthly', '2025-12-05', 'manual', '2025-12-05T10:00:00Z'),
('exp_2025_12_003', 'user_dan_001', 850.00, 'EUR', 'insurance', 'Professional liability insurance monthly', '2025-12-15', 'manual', '2025-12-15T09:00:00Z'),
('exp_2025_12_004', 'user_dan_001', 450.00, 'EUR', 'professional_development', 'SaaS growth course', '2025-12-20', 'manual', '2025-12-20T11:00:00Z'),
-- January 2026
('exp_2026_01_001', 'user_dan_001', 350.00, 'EUR', 'coworking', 'WeWork Amsterdam monthly membership', '2026-01-01', 'manual', '2026-01-01T08:00:00Z'),
('exp_2026_01_002', 'user_dan_001', 125.00, 'EUR', 'software', 'Slack Pro tier monthly', '2026-01-05', 'manual', '2026-01-05T10:00:00Z'),
('exp_2026_01_003', 'user_dan_001', 850.00, 'EUR', 'insurance', 'Professional liability insurance monthly', '2026-01-15', 'manual', '2026-01-15T09:00:00Z'),
('exp_2026_01_004', 'user_dan_001', 350.00, 'EUR', 'accounting', 'Accountant quarterly consultation', '2026-01-20', 'manual', '2026-01-20T14:00:00Z'),
-- February 2026
('exp_2026_02_001', 'user_dan_001', 350.00, 'EUR', 'coworking', 'WeWork Amsterdam monthly membership', '2026-02-01', 'manual', '2026-02-01T08:00:00Z'),
('exp_2026_02_002', 'user_dan_001', 125.00, 'EUR', 'software', 'Slack Pro tier monthly', '2026-02-05', 'manual', '2026-02-05T10:00:00Z'),
('exp_2026_02_003', 'user_dan_001', 850.00, 'EUR', 'insurance', 'Professional liability insurance monthly', '2026-02-15', 'manual', '2026-02-15T09:00:00Z'),
-- March 2026
('exp_2026_03_001', 'user_dan_001', 350.00, 'EUR', 'coworking', 'WeWork Amsterdam monthly membership', '2026-03-01', 'manual', '2026-03-01T08:00:00Z'),
('exp_2026_03_002', 'user_dan_001', 125.00, 'EUR', 'software', 'Slack Pro tier monthly', '2026-03-05', 'manual', '2026-03-05T10:00:00Z'),
('exp_2026_03_003', 'user_dan_001', 350.00, 'EUR', 'accounting', 'Accountant quarterly consultation (year-end prep)', '2026-03-10', 'manual', '2026-03-10T14:00:00Z'),
('exp_2026_03_004', 'user_dan_001', 850.00, 'EUR', 'insurance', 'Professional liability insurance monthly', '2026-03-15', 'manual', '2026-03-15T09:00:00Z'),
('exp_2026_03_005', 'user_dan_001', 1800.00, 'EUR', 'travel', 'Flight to Berlin conference + accommodation', '2026-03-22', 'manual', '2026-03-22T05:30:00Z');

-- ============================================================================
-- CONTRACTS
-- ============================================================================

INSERT INTO contracts (id, user_id, client, rate, currency, rate_type, start_date, end_date, status, risk_score, created_at)
VALUES
('contract_001', 'user_dan_001', 'TechCorp Amsterdam', 150.00, 'EUR', 'hourly', '2025-03-01', '2026-06-30', 'active', 0.2, '2025-03-01T09:00:00Z'),
('contract_002', 'user_dan_001', 'FinTech Startup', 8000.00, 'CAD', 'monthly', '2025-06-01', '2025-12-31', 'completed', 0.4, '2025-06-01T10:30:00Z');

-- ============================================================================
-- CASHFLOW HISTORY (12 months)
-- ============================================================================

INSERT INTO cashflow_history (id, user_id, month, revenue, costs, profit, currency, source, created_at)
VALUES
('cf_2025_10', 'user_dan_001', '2025-10', 8500.00, 1745.00, 6755.00, 'EUR', 'manual', '2025-11-01T06:00:00Z'),
('cf_2025_11', 'user_dan_001', '2025-11', 12500.00, 3725.00, 8775.00, 'EUR', 'manual', '2025-12-01T06:00:00Z'),
('cf_2025_12', 'user_dan_001', '2025-12', 6500.00, 2675.00, 3825.00, 'EUR', 'manual', '2026-01-01T06:00:00Z'),
('cf_2026_01', 'user_dan_001', '2026-01', 11200.00, 2125.00, 9075.00, 'EUR', 'manual', '2026-02-01T06:00:00Z'),
('cf_2026_02', 'user_dan_001', '2026-02', 9800.00, 1950.00, 7850.00, 'EUR', 'manual', '2026-03-01T06:00:00Z'),
('cf_2026_03', 'user_dan_001', '2026-03', 8500.00, 3325.00, 5175.00, 'EUR', 'manual', '2026-04-01T06:00:00Z'),
('cf_2025_10_cad', 'user_dan_001', '2025-10', 0.00, 0.00, 0.00, 'CAD', 'manual', '2025-11-01T06:00:00Z'),
('cf_2025_11_cad', 'user_dan_001', '2025-11', 8100.00, 0.00, 8100.00, 'CAD', 'manual', '2025-12-01T06:00:00Z'),
('cf_2025_12_cad', 'user_dan_001', '2025-12', 8200.00, 0.00, 8200.00, 'CAD', 'manual', '2026-01-01T06:00:00Z'),
('cf_2026_01_cad', 'user_dan_001', '2026-01', 0.00, 0.00, 0.00, 'CAD', 'manual', '2026-02-01T06:00:00Z'),
('cf_2026_02_cad', 'user_dan_001', '2026-02', 0.00, 0.00, 0.00, 'CAD', 'manual', '2026-03-01T06:00:00Z'),
('cf_2026_03_cad', 'user_dan_001', '2026-03', 14000.00, 0.00, 14000.00, 'CAD', 'manual', '2026-04-01T06:00:00Z');

-- ============================================================================
-- BURN HISTORY (12 months, tracking monthly expenses)
-- ============================================================================

INSERT INTO burn_history (id, user_id, month, amount, currency, created_at)
VALUES
('burn_2025_10', 'user_dan_001', '2025-10', 1745.00, 'EUR', '2025-11-01T06:00:00Z'),
('burn_2025_11', 'user_dan_001', '2025-11', 3725.00, 'EUR', '2025-12-01T06:00:00Z'),
('burn_2025_12', 'user_dan_001', '2025-12', 2675.00, 'EUR', '2026-01-01T06:00:00Z'),
('burn_2026_01', 'user_dan_001', '2026-01', 2125.00, 'EUR', '2026-02-01T06:00:00Z'),
('burn_2026_02', 'user_dan_001', '2026-02', 1950.00, 'EUR', '2026-03-01T06:00:00Z'),
('burn_2026_03', 'user_dan_001', '2026-03', 3325.00, 'EUR', '2026-04-01T06:00:00Z');

-- ============================================================================
-- WISE ACCOUNTS (Multi-currency banking)
-- ============================================================================

INSERT INTO wise_accounts (id, user_id, currency, balance, is_jar, label, created_at)
VALUES
('wise_001_eur_op', 'user_dan_001', 'EUR', 22450.00, 0, 'Operating Account (EUR)', '2025-06-15T09:00:00Z'),
('wise_002_eur_tax', 'user_dan_001', 'EUR', 8650.00, 1, 'Tax Reserve Jar (EUR)', '2025-06-15T09:15:00Z'),
('wise_003_cad_business', 'user_dan_001', 'CAD', 15200.00, 0, 'CAD Business Account', '2025-11-08T10:00:00Z');

-- ============================================================================
-- HEDGING CONTRACTS (FX risk management)
-- ============================================================================

INSERT INTO hedging_contracts (id, user_id, pair, locked_rate, amount, currency, expiry_date, status, created_at)
VALUES
('hedge_001', 'user_dan_001', 'EUR/CAD', 1.4850, 8000.00, 'CAD', '2026-05-15', 'active', '2026-02-20T11:30:00Z'),
('hedge_002', 'user_dan_001', 'EUR/USD', 1.0950, 9200.00, 'USD', '2026-06-30', 'active', '2026-01-15T09:45:00Z');

-- ============================================================================
-- MARKET SIGNALS (Opportunity pipeline)
-- ============================================================================

INSERT INTO market_signals (id, user_id, title, company, location, score, tier, source, source_url, jurisdiction, discovered_at, expires_at)
VALUES
('signal_001', 'user_dan_001', 'Hiring: Senior Growth Engineer', 'Stripe', 'Amsterdam', 92.0, 'hot', 'linkedin', 'https://linkedin.com/jobs/...', 'NL', '2026-04-05T08:30:00Z', '2026-05-20T23:59:59Z'),
('signal_002', 'user_dan_001', 'Project: FinTech Platform MVP', 'Revolut', 'Berlin', 85.0, 'hot', 'crunchbase', 'https://crunchbase.com/...', 'DE', '2026-04-03T14:15:00Z', '2026-05-15T23:59:59Z'),
('signal_003', 'user_dan_001', 'Contract: B2B SaaS Advisory', 'Slack', 'San Francisco', 72.0, 'warm', 'newsletter', 'https://example.com/...', 'US', '2026-04-02T10:00:00Z', '2026-06-01T23:59:59Z'),
('signal_004', 'user_dan_001', 'Role: Technical Advisor', 'Y Combinator Startup', 'London', 68.0, 'warm', 'twitter', 'https://twitter.com/...', 'UK', '2026-04-01T16:45:00Z', '2026-05-30T23:59:59Z'),
('signal_005', 'user_dan_001', 'Budget Cycle: Tech Hiring Q2', 'Microsoft', 'Amsterdam', 61.0, 'warm', 'internal_research', NULL, 'NL', '2026-03-28T09:00:00Z', '2026-06-15T23:59:59Z'),
('signal_006', 'user_dan_001', 'RFP: Cloud Infrastructure Consulting', 'ABN AMRO', 'Amsterdam', 58.0, 'warm', 'rfp_board', 'https://rfp.example.com/...', 'NL', '2026-03-25T11:30:00Z', '2026-05-25T23:59:59Z'),
('signal_007', 'user_dan_001', 'Expansion: European SaaS in NL', 'Notion', 'Amsterdam', 45.0, 'monitor', 'crunchbase', NULL, 'NL', '2026-03-20T13:00:00Z', '2026-06-30T23:59:59Z'),
('signal_008', 'user_dan_001', 'Hiring Wave: AI/ML Specialists', 'Google', 'Amsterdam', 38.0, 'monitor', 'linkedin', NULL, 'NL', '2026-03-18T10:15:00Z', '2026-06-20T23:59:59Z'),
('signal_009', 'user_dan_001', 'Marketplace: Fractional Exec Roles', 'Braintrust', 'Global', 32.0, 'monitor', 'newsletter', 'https://braintrust.com/', 'GLOBAL', '2026-03-15T09:00:00Z', '2026-07-01T23:59:59Z'),
('signal_010', 'user_dan_001', 'Shift: Enterprise to Mid-Market Focus', 'Salesforce', 'Amsterdam', 28.0, 'monitor', 'internal_research', NULL, 'NL', '2026-03-10T15:30:00Z', '2026-07-10T23:59:59Z');

-- ============================================================================
-- MARKET TRENDS (Industry & hiring cycles)
-- ============================================================================

INSERT INTO market_trends (id, month, hiring_trend, budget_moment, description, industry, created_at)
VALUES
('trend_2025_10', '2025-10', 'accelerating', 'budget_approved', 'Q4 hiring push as companies finalize annual budgets', 'tech', '2025-10-15T06:00:00Z'),
('trend_2025_11', '2025-11', 'accelerating', 'budget_approved', 'Black Friday tech spending; SaaS evaluations peak', 'tech', '2025-11-15T06:00:00Z'),
('trend_2025_12', '2025-12', 'slowing', 'budget_pending', 'Holiday slowdown; planning for 2026 begins', 'tech', '2025-12-15T06:00:00Z'),
('trend_2026_01', '2026-01', 'slowing', 'budget_approved', 'New Year hiring freeze; Q1 budget allocation underway', 'tech', '2026-01-15T06:00:00Z'),
('trend_2026_02', '2026-02', 'accelerating', 'budget_approved', 'Q1 hiring phase; tax season advisory demand peaks', 'finance', '2026-02-15T06:00:00Z'),
('trend_2026_03', '2026-03', 'accelerating', 'budget_approved', 'Spring hiring wave; European expansion activity increases', 'tech', '2026-03-15T06:00:00Z'),
('trend_2025_10_finance', '2025-10', 'accelerating', 'budget_approved', 'Year-end tax planning; compliance advisory spike', 'finance', '2025-10-15T06:00:00Z'),
('trend_2025_11_finance', '2025-11', 'accelerating', 'budget_approved', 'Tax strategy optimization; wealth management focus', 'finance', '2025-11-15T06:00:00Z'),
('trend_2025_12_finance', '2025-12', 'peak', 'budget_approved', 'Year-end tax filing rush; advisory demand highest', 'finance', '2025-12-15T06:00:00Z'),
('trend_2026_01_finance', '2026-01', 'accelerating', 'budget_approved', 'Corporate tax filing; Q1 tax planning advisory', 'finance', '2026-01-15T06:00:00Z'),
('trend_2026_02_design', '2026-02', 'stable', 'budget_approved', 'Brand refresh season; design contract demand steady', 'design', '2026-02-15T06:00:00Z'),
('trend_2026_03_ecommerce', '2026-03', 'accelerating', 'budget_approved', 'Q2 ecommerce platform builds; Spring sales push', 'ecommerce', '2026-03-15T06:00:00Z');

-- ============================================================================
-- LEADS (Prospect pipeline)
-- ============================================================================

INSERT INTO leads (id, user_id, company, role, status, linkedin_url, scouted_at)
VALUES
('lead_001', 'user_dan_001', 'GitLab', 'VP Growth', 'active', 'https://linkedin.com/in/example1', '2026-03-28T10:30:00Z'),
('lead_002', 'user_dan_001', 'Notion', 'Chief Business Officer', 'contacted', 'https://linkedin.com/in/example2', '2026-03-15T09:15:00Z'),
('lead_003', 'user_dan_001', 'Canva', 'Head of Operations', 'active', 'https://linkedin.com/in/example3', '2026-04-01T14:00:00Z');

-- ============================================================================
-- PROJECTS (Active engagements)
-- ============================================================================

INSERT INTO projects (id, user_id, title, company, description, status, source, external_url, created_at)
VALUES
('project_001', 'user_dan_001', 'Financial OS MVP - Nexus Live', NULL, 'Building real-time financial dashboard for freelancers; multi-currency, tax-aware, hedging-integrated', 'active', 'internal', 'https://github.com/nexus-live/core', '2025-06-01T08:00:00Z'),
('project_002', 'user_dan_001', 'TechCorp Platform Redesign', 'TechCorp Amsterdam', 'Full-stack product redesign; user research, design system, React 19 implementation', 'active', 'contract', NULL, '2025-03-10T10:15:00Z');

-- ============================================================================
-- SCENARIOS (What-if modeling)
-- ============================================================================

INSERT INTO scenarios (id, user_id, name, parameters_json, results_json, created_at, updated_at)
VALUES
('scenario_001', 'user_dan_001', 'Conservative Growth: 20% revenue increase', '{"revenue_growth": 0.2, "expense_growth": 0.05, "new_contract_rate": 160}', '{"projected_profit_12m": 156800, "tax_burden": 48620, "cash_buffer_required": 15000}', '2026-03-25T11:00:00Z', '2026-03-25T11:00:00Z'),
('scenario_002', 'user_dan_001', 'Aggressive Growth: +50% revenue, higher burn', '{"revenue_growth": 0.5, "expense_growth": 0.3, "new_contract_rate": 180}', '{"projected_profit_12m": 285600, "tax_burden": 96420, "cash_buffer_required": 35000}', '2026-04-02T13:30:00Z', '2026-04-02T13:30:00Z');
