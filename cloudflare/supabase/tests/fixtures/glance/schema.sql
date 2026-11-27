-- A cut of the live schema for the glance tests: only the tables and columns that
-- nx_money_summary and the glance functions read. No data. The test loads this
-- file, then nx_money_summary from its own migration, then the glance migration.
create role anon;
create role authenticated;
create role service_role;

create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table app_config (key text primary key, value text not null, description text, updated_at timestamptz not null default now());
create table profiles (id uuid primary key, email text, base_currency text default 'EUR');
create table nx_user_settings (user_id uuid, key text, value text, updated_at timestamptz default now(), primary key (user_id, key));
create table nx_accounts (id uuid default gen_random_uuid(), user_id uuid, source text, account text, label text, kind text,
  opening_date date, opening_balance numeric default 0, include_in_cash boolean default true);
create table nx_transactions (id uuid primary key default gen_random_uuid(), user_id uuid, source text, account text, booked_on date,
  amount numeric, currency text default 'EUR', merchant text, category text default 'Uncategorised', class text default 'unmatched',
  rail text, review_status text default 'auto', decision_id uuid, created_at timestamptz default now());
create table nx_txn_splits (id uuid default gen_random_uuid(), user_id uuid, txn_id uuid, category text, amount numeric);
create view nx_spend_lines as
  select t.id, t.user_id, t.booked_on, t.amount, t.currency, t.merchant, t.category, t.class, t.rail, t.review_status, t.decision_id,
         t.created_at, false as split
  from nx_transactions t
  where not exists (select 1 from nx_txn_splits s where s.txn_id = t.id)
  union all
  select s.id, t.user_id, t.booked_on, s.amount, t.currency, t.merchant, s.category, t.class, t.rail, t.review_status, t.decision_id,
         t.created_at, true as split
  from nx_txn_splits s join nx_transactions t on t.id = s.txn_id;
create table nx_tax_forecast_live (user_id uuid, year integer, reserve_eur numeric, figures jsonb, computed_at timestamptz default now());
create table tax_filings (id uuid default gen_random_uuid(), user_id uuid, kind text, period_label text, status text, figures jsonb,
  created_at timestamptz default now());
create table nx_budgets (id uuid default gen_random_uuid(), user_id uuid, category text, monthly_amount numeric, currency text,
  valid_from date default current_date);
create table nx_category_rules (id uuid default gen_random_uuid(), user_id uuid, priority integer, category text, class text,
  active boolean default true, valid_from date, valid_to date);
create table invoices (id uuid default gen_random_uuid(), user_id uuid, client text, amount numeric, currency text default 'EUR',
  status text default 'pending', issued_date date, due_date date, paid_date date, expected_cash_date date, invoice_number text,
  hours numeric, unit_rate numeric, period_start date, fx_rate_eur numeric, amount_eur numeric, duplicate_of uuid,
  voided_at timestamptz, review_state text default 'confirmed');
create table nx_positions (id uuid default gen_random_uuid(), user_id uuid, source text, external_id text, value numeric, currency text);
create table integration_connections (id uuid default gen_random_uuid(), user_id uuid, provider text, cursor jsonb, status text);
create table wise_accounts (id uuid default gen_random_uuid(), user_id uuid, currency text, balance numeric, is_jar boolean, label text);
create table kv_cache (key text primary key, value jsonb, expires_at timestamptz);
create table dt_time_entries (id uuid default gen_random_uuid(), user_id uuid, entry_date date, minutes integer, removed_at timestamptz);
create table nx_net_worth_snapshots (id uuid default gen_random_uuid(), user_id uuid, as_of date default current_date, cash numeric,
  investments numeric, liabilities numeric, total numeric, currency text);
create table nx_month_closes (id uuid default gen_random_uuid(), user_id uuid, month date, figures jsonb, closed_at timestamptz default now());
create table rec_roles (id uuid default gen_random_uuid(), user_id uuid, title text, tier text, status text default 'new');
create table rec_applications (id uuid default gen_random_uuid(), user_id uuid, status text default 'drafted');
create table nx_recurring (id uuid default gen_random_uuid(), user_id uuid, key text, label text, category text, cadence text,
  amount numeric, per_year numeric, last_charge date, next_due date, ends_on date, proposed_call text, call text);
create table contracts (id uuid primary key default gen_random_uuid(), user_id uuid not null, client text not null, rate numeric not null,
  currency text not null default 'EUR', rate_type text not null, start_date date not null, end_date date,
  status text not null default 'active', created_at timestamptz not null default now());
create table nx_decisions (id uuid default gen_random_uuid(), user_id uuid, kind text, area text, if_condition text, then_action text,
  active boolean default true, created_at timestamptz default now());
