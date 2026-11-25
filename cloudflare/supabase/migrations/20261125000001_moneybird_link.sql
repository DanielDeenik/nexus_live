-- Moneybird link (build item 9).
--   * Moneybird connects in Accounts with a personal API token, kept in Vault.
--   * nx_moneybird_documents mirrors receipts, purchase invoices and sales invoices;
--     the moneybird function writes it and marks the cost line each receipt proves.
--   * The nightly job that called the never-deployed sync-moneybird function now
--     calls nexus/moneybird.
--   * Start date, match window and the foreign-currency band live in app_config.

-- 1. Provider.
alter table public.integration_connections drop constraint if exists integration_connections_provider_check;
alter table public.integration_connections add constraint integration_connections_provider_check
  check (provider in ('google', 'wise', 'etoro', 'enable_banking', 'moneybird'));

-- 2. The documents in the books, written by the moneybird function only.
create table if not exists public.nx_moneybird_documents (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('receipt', 'purchase_invoice', 'sales_invoice')),
  id text not null,
  administration_id text not null,
  version bigint not null,
  doc_date date,
  reference text,
  contact text,
  currency text,
  total_incl numeric,
  total_incl_eur numeric,
  total_excl_eur numeric,
  state text,
  paid_at timestamptz,
  attachments integer not null default 0,
  expense_id uuid references public.expenses(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  synced_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);
comment on table public.nx_moneybird_documents is
  'Moneybird receipts, purchase invoices and sales invoices. expense_id: the cost line the document proves; invoice_id: the Nexus invoice a sales invoice pairs with. Written only by the moneybird edge function.';
alter table public.nx_moneybird_documents enable row level security;
drop policy if exists nx_moneybird_documents_select_own on public.nx_moneybird_documents;
create policy nx_moneybird_documents_select_own on public.nx_moneybird_documents for select to authenticated
  using (user_id = auth.uid());

-- 3. Settings.
insert into public.app_config (key, value, description) values
('moneybird.sync_from', '2025-07-01', 'Cost lines from this date on are checked for a Moneybird receipt (the month the business was registered)'),
('moneybird.match_window_days', '10', 'Days between a receipt date and its payment that still count as the same cost'),
('moneybird.fx_tolerance_pct', '5', 'A foreign-currency receipt proves a euro card line within this percent, when the shop names agree (card fees and rates differ)')
on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = now();

-- 4. Moneybird on the Accounts screen.
update public.app_config
set value = jsonb_pretty(value::jsonb || jsonb_build_array(jsonb_build_object(
      'id', 'moneybird', 'name', 'Moneybird', 'kind', 'books', 'via', 'moneybird_token',
      'open_url', 'https://moneybird.com',
      'help_url', 'https://moneybird.com/user/applications/new',
      'help', 'Moneybird, Applications, new personal API token with the scopes documents, sales_invoices and bank. Copy it once; Nexus keeps it in the vault.'))),
    updated_at = now()
where key = 'integrations.catalog'
  and not value::jsonb @> '[{"id": "moneybird"}]'::jsonb;

-- 5. The nightly job.
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'nexus-sync-moneybird'),
  command := $$select public.invoke_edge('nexus/moneybird', '{"mode": "sync"}'::jsonb)$$
);
