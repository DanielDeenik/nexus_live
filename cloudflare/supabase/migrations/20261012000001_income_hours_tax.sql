-- Nexus: income and hours ledger, expense agent, tax agent, human-in-the-loop.
--
-- Design rules
--   * Every fiscal number lives in public.tax_parameters (keyed by year, with a
--     source URL). Code reads parameters; it never embeds them.
--   * Every agent tunable lives in public.app_config.
--   * Agents never finalise anything a human must own. Expenses that fail a
--     guardrail, every fixed asset and every tax filing pass through
--     public.review_items. Only a human sets a filing to 'filed'.
--   * Every agent run is traced step by step in public.agent_runs.

-- ============================================================================
-- 1. FISCAL PARAMETERS (by year, sourced)
-- ============================================================================

create table if not exists public.tax_parameters (
  year integer not null,
  key text not null,
  value jsonb not null,
  description text,
  source_url text,
  verified boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (year, key)
);
alter table public.tax_parameters enable row level security;
create policy "tax_parameters_read" on public.tax_parameters
  for select to authenticated using (true);

insert into public.tax_parameters (year, key, value, description, source_url, verified) values
(2026, 'ib.brackets',
  '[{"up_to":38883,"rate":0.3575},{"up_to":78426,"rate":0.3756},{"up_to":null,"rate":0.495}]',
  'Box 1 brackets below AOW age', 'https://www.mkbservicedesk.nl/belastingen/inkomstenbelasting/belastingschijven-box-1', true),
(2026, 'ib.zelfstandigenaftrek', '1200', 'Self-employed deduction (requires urencriterium)',
  'https://www.rabobank.nl/bedrijven/eigen-bedrijf-starten/belasting/zelfstandigenaftrek-en-startersaftrek-zo-zit-dat', true),
(2026, 'ib.startersaftrek', '2123', 'Starters deduction (max 3 times in first 5 years)',
  'https://www.rabobank.nl/bedrijven/eigen-bedrijf-starten/belasting/zelfstandigenaftrek-en-startersaftrek-zo-zit-dat', true),
(2026, 'ib.urencriterium_hours', '1225', 'Minimum hours per year in the business',
  'https://www.bridgefund.nl/blog/fiscale-voordelen-voor-startende-ondernemers-in-2026-die-je-niet-wil-missen/', true),
(2026, 'ib.mkb_winstvrijstelling_rate', '0.127', 'MKB profit exemption, applied after ondernemersaftrek',
  'https://www.rabobank.nl/bedrijven/eigen-bedrijf-starten/belasting/mkb-winstvrijstelling-voor-startende-ondernemers-zo-zit-dat', true),
(2026, 'ib.algemene_heffingskorting',
  '{"max":3115,"phase_out_start":29736,"phase_out_rate":0.06398}',
  'General tax credit below AOW age', 'https://rekenmachinepro.nl/werk-zzp/algemene-heffingskorting/', true),
(2026, 'ib.arbeidskorting',
  '[{"from":0,"to":11965,"base":0,"rate":0.08324},{"from":11965,"to":25845,"base":996,"rate":0.31009},{"from":25845,"to":45592,"base":5300,"rate":0.0195},{"from":45592,"to":132920,"base":5685,"rate":-0.0651},{"from":132920,"to":null,"base":0,"rate":0}]',
  'Labour tax credit below AOW age (base + rate x income above band start)',
  'https://www.onderneming.nl/belasting/inkomstenbelasting/arbeidskorting/', true),
(2026, 'zvw.self_employed',
  '{"rate":0.0485,"max_income":79409}',
  'Income-related Zvw contribution for self-employed', 'https://www.taxence.nl/nieuws/maximum-bijdrageloon-zvw-2026-vastgesteld/', true),
(2026, 'kia.bands',
  '[{"from":0,"to":2900,"type":"none"},{"from":2901,"to":71683,"type":"pct","rate":0.28},{"from":71684,"to":132746,"type":"fixed","amount":20072},{"from":132747,"to":398236,"type":"fixed_minus_pct","amount":20072,"rate":0.0756,"above":132746},{"from":398237,"to":null,"type":"none"}]',
  'Small-scale investment deduction on total qualifying investments',
  'https://bieb.knab.nl/ondernemen/zo-werkt-de-kleine-investeringsaftrek-kia', true),
(2026, 'assets.capitalisation_threshold_excl_vat', '450',
  'Assets at or above this (excl VAT) are capitalised and depreciated; also the KIA per-item minimum',
  'https://bieb.knab.nl/ondernemen/laptop-aftrekbaar-zzp', true),
(2026, 'assets.default_useful_life_years', '{"computer":5,"furniture":5,"phone":3,"other":5}',
  'Default depreciation periods by asset class', 'https://www.mkbservicedesk.nl/belastingen/aftrekposten/is-een-laptop-aftrekbaar-voor-zzp', true),
(2026, 'costs.limited_deductible',
  '{"method":"fixed_pct","deductible_pct":0.8,"threshold_alternative":5700}',
  'Representation and similar costs: 80% rule (default) or threshold variant',
  'https://bieb.knab.nl/ondernemen/aftrekposten-zzp-reiskosten-en-verblijfkosten-buitenland-aftrekbaar', true),
(2026, 'costs.mileage_rate_per_km', '0.23', 'Private car used for business, per km all-in',
  'https://www.informer.nl/belastingen/aftrekbare-kosten/autokosten', true),
(2026, 'vat.rates', '{"standard":0.21,"reduced":0.09,"zero":0}', 'Dutch VAT rates',
  'https://www.belastingdienst.nl/wps/wcm/connect/nl/btw/btw', true),
(2026, 'vat.rubriek_map',
  '{"nl_standard":"1a","nl_reduced":"1b","eu_reverse_charge":"3b","export_outside_eu_services":"1e","purchases_services_outside_eu":"4a","purchases_eu":"4b"}',
  'Mapping of transaction treatments to VAT return boxes. Non-EU services mapping awaits confirmation.',
  'https://www.zzp-nederland.nl/kennisbank/btw-naar-buitenland', false)
on conflict (year, key) do update set value = excluded.value, source_url = excluded.source_url,
  verified = excluded.verified, description = excluded.description, updated_at = now();

-- Correct the stale foundation seed (2025 value seeded as 2026).
update public.app_config set value = '1200',
  description = 'Superseded by tax_parameters(2026, ib.zelfstandigenaftrek)', updated_at = now()
where key = 'tax.nl.zelfstandigenaftrek';

-- ============================================================================
-- 2. PUBLIC HOLIDAYS (work calendar for remaining-day forecasts)
-- ============================================================================

create table if not exists public.public_holidays (
  region_code text not null,          -- 'CA-ON', 'CA-BC', 'NL'
  holiday_date date not null,         -- the day work stops (observed date)
  name text not null,
  source_url text,
  primary key (region_code, holiday_date)
);
alter table public.public_holidays enable row level security;
create policy "public_holidays_read" on public.public_holidays
  for select to authenticated using (true);

insert into public.public_holidays (region_code, holiday_date, name, source_url) values
('CA-ON','2026-01-01','New Year''s Day','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2026-02-16','Family Day','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2026-04-03','Good Friday','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2026-05-18','Victoria Day','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2026-07-01','Canada Day','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2026-09-07','Labour Day','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2026-10-12','Thanksgiving','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2026-12-25','Christmas Day','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2026-12-28','Boxing Day (observed)','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-BC','2026-10-12','Thanksgiving','https://www2.gov.bc.ca/gov/content/employment-business/employment-standards-advice/employment-standards/statutory-holidays'),
('CA-BC','2026-11-11','Remembrance Day','https://www2.gov.bc.ca/gov/content/employment-business/employment-standards-advice/employment-standards/statutory-holidays'),
('CA-BC','2026-12-25','Christmas Day','https://www2.gov.bc.ca/gov/content/employment-business/employment-standards-advice/employment-standards/statutory-holidays')
on conflict do nothing;

alter table public.profiles
  add column if not exists work_calendar_region text,
  add column if not exists standard_hours_per_day numeric(5,2),
  add column if not exists fiscal_residence text;

-- ============================================================================
-- 3. INVOICES: hours, period, VAT treatment, FX, anomaly links
-- ============================================================================

alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check
  check (status in ('pending', 'paid', 'overdue', 'void'));
alter table public.invoices drop constraint if exists invoices_source_check;
alter table public.invoices add constraint invoices_source_check
  check (source in ('manual', 'moneybird', 'notion', 'api', 'upload'));

alter table public.invoices
  add column if not exists invoice_number text,
  add column if not exists description text,
  add column if not exists hours numeric(10,2),
  add column if not exists unit_rate numeric(14,2),
  add column if not exists period_start date,
  add column if not exists period_end date,
  add column if not exists client_country text,
  add column if not exists client_region text,
  add column if not exists vat_treatment text
    check (vat_treatment in ('nl_standard','nl_reduced','eu_reverse_charge','export_outside_eu_services','exempt')),
  add column if not exists vat_amount numeric(14,2) not null default 0,
  add column if not exists fx_rate_eur numeric(14,6),
  add column if not exists fx_rate_date date,
  add column if not exists amount_eur numeric(14,2),
  add column if not exists duplicate_of uuid references public.invoices(id) on delete set null,
  add column if not exists document_path text,
  add column if not exists notes text;
create unique index if not exists idx_invoices_user_number
  on public.invoices(user_id, invoice_number) where invoice_number is not null;

-- ============================================================================
-- 4. TIME ENTRIES (non-billable hours count toward the urencriterium)
-- ============================================================================

create table if not exists public.time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  entry_date date not null,
  hours numeric(6,2) not null check (hours > 0),
  category text not null check (category in ('admin','acquisition','product','training','travel','other')),
  description text,
  created_at timestamptz not null default now()
);
create index if not exists idx_time_entries_user_date on public.time_entries(user_id, entry_date);

-- ============================================================================
-- 5. EXPENSES: agent fields, VAT, treatment, evidence, review state
-- ============================================================================

alter table public.expenses
  add column if not exists status text not null default 'proposed'
    check (status in ('proposed','needs_review','approved','rejected','booked')),
  add column if not exists treatment text
    check (treatment in ('fully_deductible','limited_deductible','asset','private','unknown')),
  add column if not exists business_use_pct numeric(5,4) not null default 1
    check (business_use_pct >= 0 and business_use_pct <= 1),
  add column if not exists category_detail text,
  add column if not exists vendor text,
  add column if not exists vendor_country text,
  add column if not exists amount_excl_vat numeric(14,2),
  add column if not exists vat_amount numeric(14,2),
  add column if not exists vat_rate numeric(5,4),
  add column if not exists vat_reclaimable boolean,
  add column if not exists vat_reverse_charge boolean,
  add column if not exists fx_rate_eur numeric(14,6),
  add column if not exists amount_eur numeric(14,2),
  add column if not exists invoice_number text,
  add column if not exists evidence_path text,
  add column if not exists evidence_hash text,
  add column if not exists confidence numeric(4,3),
  add column if not exists rationale text,
  add column if not exists agent_run_id uuid,
  add column if not exists asset_id uuid,
  add column if not exists reviewed_by uuid references public.profiles(id),
  add column if not exists reviewed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
create unique index if not exists idx_expenses_user_evidence_hash
  on public.expenses(user_id, evidence_hash) where evidence_hash is not null;
create index if not exists idx_expenses_status on public.expenses(user_id, status);

-- ============================================================================
-- 6. FIXED ASSETS (capitalised purchases, depreciation, KIA)
-- ============================================================================

create table if not exists public.fixed_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  description text not null,
  asset_class text not null default 'other',
  acquired_date date not null,
  cost_excl_vat numeric(14,2) not null,
  residual_value numeric(14,2) not null default 0,
  useful_life_years numeric(4,1) not null,
  kia_eligible boolean not null default true,
  status text not null default 'needs_review' check (status in ('needs_review','active','disposed')),
  created_at timestamptz not null default now()
);
create index if not exists idx_fixed_assets_user on public.fixed_assets(user_id);
alter table public.expenses drop constraint if exists expenses_asset_fk;
alter table public.expenses add constraint expenses_asset_fk
  foreign key (asset_id) references public.fixed_assets(id) on delete set null;

-- ============================================================================
-- 7. AGENT RUNS (the harness trace)
-- ============================================================================

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  agent_id text not null references public.agent_configs(agent_id),
  trigger text not null check (trigger in ('cron','manual','upload','review_feedback')),
  status text not null default 'running' check (status in ('running','succeeded','partial','failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  input_json jsonb,
  steps jsonb not null default '[]'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  error_message text
);
create index if not exists idx_agent_runs_user on public.agent_runs(user_id, started_at desc);
alter table public.expenses drop constraint if exists expenses_agent_run_fk;
alter table public.expenses add constraint expenses_agent_run_fk
  foreign key (agent_run_id) references public.agent_runs(id) on delete set null;

-- ============================================================================
-- 8. TAX FILINGS (drafts the agent prepares; humans approve and file)
-- ============================================================================

create table if not exists public.tax_filings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('vat_quarter','income_tax_year')),
  period_label text not null,
  period_start date not null,
  period_end date not null,
  status text not null default 'needs_review'
    check (status in ('needs_review','approved','filed','superseded')),
  figures jsonb not null,
  warnings jsonb not null default '[]'::jsonb,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  filed_at timestamptz,
  filed_reference text,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_tax_filings_current
  on public.tax_filings(user_id, kind, period_label) where status <> 'superseded';

-- ============================================================================
-- 9. REVIEW ITEMS (the human-in-the-loop queue)
-- ============================================================================

create table if not exists public.review_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_type text not null check (item_type in ('expense','asset','filing','invoice_anomaly')),
  item_id uuid,
  reason_codes text[] not null default '{}',
  summary text not null,
  proposed jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','approved','edited','rejected')),
  decision jsonb,
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_review_items_open on public.review_items(user_id, status, created_at desc);
create unique index if not exists idx_review_items_one_open
  on public.review_items(user_id, item_type, item_id) where status = 'open' and item_id is not null;

-- ============================================================================
-- 10. INTEGRATIONS (OAuth tokens in Vault; table holds only metadata)
-- ============================================================================

create table if not exists public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('google','wise')),
  account_label text,
  scopes text[],
  vault_secret_id uuid,
  settings jsonb not null default '{}'::jsonb,   -- e.g. drive folder id, gmail query
  cursor jsonb not null default '{}'::jsonb,     -- incremental sync position
  status text not null default 'active' check (status in ('active','error','revoked')),
  last_error text,
  connected_at timestamptz not null default now(),
  unique (user_id, provider)
);

create or replace function public.store_integration_secret(p_user uuid, p_provider text, p_secret text)
returns uuid language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid; v_existing uuid;
begin
  select vault_secret_id into v_existing from public.integration_connections
    where user_id = p_user and provider = p_provider;
  if v_existing is not null then
    perform vault.update_secret(v_existing, p_secret);
    return v_existing;
  end if;
  v_id := vault.create_secret(p_secret, 'nexus_' || p_provider || '_' || p_user::text);
  return v_id;
end $$;

create or replace function public.read_integration_secret(p_secret_id uuid)
returns text language sql security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$$;

revoke all on function public.store_integration_secret(uuid, text, text) from public, anon, authenticated;
revoke all on function public.read_integration_secret(uuid) from public, anon, authenticated;
grant execute on function public.store_integration_secret(uuid, text, text) to service_role;
grant execute on function public.read_integration_secret(uuid) to service_role;

-- ============================================================================
-- 11. RLS for the new owner-scoped tables
-- ============================================================================

do $$
declare
  t text;
  owner_tables text[] := array['time_entries','fixed_assets','agent_runs','tax_filings','review_items','integration_connections'];
begin
  foreach t in array owner_tables loop
    execute format('alter table public.%1$s enable row level security', t);
    execute format($f$
      create policy "%1$s_select_own" on public.%1$s for select using (user_id = auth.uid());
    $f$, t);
  end loop;
  -- Humans edit their own hours and assets directly.
  foreach t in array array['time_entries','fixed_assets'] loop
    execute format($f$
      create policy "%1$s_insert_own" on public.%1$s for insert with check (user_id = auth.uid());
      create policy "%1$s_update_own" on public.%1$s for update using (user_id = auth.uid()) with check (user_id = auth.uid());
      create policy "%1$s_delete_own" on public.%1$s for delete using (user_id = auth.uid());
    $f$, t);
  end loop;
end $$;
-- agent_runs, tax_filings, review_items and integration_connections are written
-- only by Edge Functions (service role). Review decisions go through the
-- review-decide function so every decision is validated and traced.

-- ============================================================================
-- 12. RECEIPTS STORAGE (private, one folder per user)
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

create policy "receipts_read_own" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "receipts_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================================
-- 13. AGENT CONFIG
-- ============================================================================

insert into public.app_config (key, value, description) values
('expense_agent.auto_book_min_confidence', '0.90', 'Below this classification confidence an expense waits for review'),
('expense_agent.auto_book_max_amount_eur', '250', 'Single expenses above this always wait for review'),
('expense_agent.amount_tolerance_eur', '0.05', 'Allowed rounding gap between excl VAT + VAT and the total'),
('expense_agent.review_categories', '["representation","club_membership","clothing","travel_mixed","gifts","home_office","car"]', 'Categories that always need a human'),
('expense_agent.gmail_query', 'has:attachment (invoice OR receipt OR factuur OR bon OR rekening) newer_than:{days}d', 'Gmail search used by the collector; {days} is replaced with the lookback'),
('expense_agent.lookback_days', '35', 'How far back each collector looks on a run'),
('expense_agent.max_documents_per_run', '50', 'Upper bound of documents processed per run'),
('tax_agent.reserve_buffer_pct', '0.05', 'Extra buffer on top of the estimated tax for the reserve target'),
('integrations.google_auth_url', 'https://accounts.google.com/o/oauth2/v2/auth', 'Google OAuth authorize endpoint'),
('integrations.google_token_url', 'https://oauth2.googleapis.com/token', 'Google OAuth token endpoint'),
('integrations.google_scopes', 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly', 'Read-only scopes for receipt collection'),
('integrations.gmail_api_base', 'https://gmail.googleapis.com/gmail/v1', 'Gmail API base'),
('integrations.drive_api_base', 'https://www.googleapis.com/drive/v3', 'Drive API base'),
('integrations.wise_api_base', 'https://api.wise.com', 'Wise API base'),
('integrations.fx_api_base', 'https://api.frankfurter.app', 'ECB reference rates API used to convert to EUR')
on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = now();

insert into public.agent_configs (id, agent_id, display_name, system_prompt, llm_provider, llm_model, max_tokens, temperature, cache_ttl_seconds, rate_limit_per_day, enabled)
values
('agent_expense_001', 'expense', 'Expense Agent',
'You extract and classify business expenses for a Dutch IB-ondernemer (eenmanszaak). You receive one document (email, PDF text, or bank transaction) plus the fiscal parameters and the vendor rules the owner has confirmed before. Return only JSON matching the schema in the user message. Never invent numbers: if a figure is not on the document, return null and lower your confidence. Treat these as needing a human, never as fully deductible: club or society memberships, meals and drinks, gifts, clothing, travel with a private element, anything for the home. Purchases at or above the capitalisation threshold in the parameters are assets. Explain your classification in one sentence of plain language in the rationale field.',
'anthropic', 'claude-sonnet-5-5', 2048, 0.0, 0, 2000, true),
('agent_taxdraft_001', 'tax_drafter', 'Tax Filing Drafter',
'You review a deterministic tax computation for a Dutch IB-ondernemer and write plain-language warnings for the owner. You never change numbers. Flag: missing evidence, unverified parameters, invoice anomalies, assets awaiting review, expenses awaiting review, and anything that would change the result materially. Return JSON {"warnings":[{"code":string,"severity":"info"|"warn"|"block","message":string}]}.',
'anthropic', 'claude-opus-5-5', 2048, 0.0, 0, 200, true)
on conflict (agent_id) do update set system_prompt = excluded.system_prompt, llm_model = excluded.llm_model,
  max_tokens = excluded.max_tokens, temperature = excluded.temperature, updated_at = now();
