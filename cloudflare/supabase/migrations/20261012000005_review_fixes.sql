-- Fixes from the independent review (additive only).

-- Sales invoices: a real unique constraint (ON CONFLICT cannot target the
-- partial index), and a review state so unconfirmed invoices do not count.
alter table public.invoices add constraint invoices_user_number_key unique (user_id, invoice_number);
alter table public.invoices
  add column if not exists review_state text not null default 'confirmed'
    check (review_state in ('confirmed', 'needs_review'));

-- Bank payments get their own link column, so a receipt's source id never
-- blocks matching it to the Wise payment.
alter table public.expenses add column if not exists bank_txn_id text;
create unique index if not exists idx_expenses_user_bank_txn
  on public.expenses(user_id, bank_txn_id) where bank_txn_id is not null;

-- B2B services to a business outside the EU are taxed in the customer's
-- country and are not reported in the Dutch VAT return.
insert into public.tax_parameters (year, key, value, description, source_url, verified) values
(2026, 'vat.not_reported_treatments', '["export_outside_eu_services"]',
  'Turnover left out of the Dutch VAT return: B2B services to non-EU businesses',
  'https://ondernemersplein.overheid.nl/internationaal-ondernemen/douane-en-belastingen/btw-bij-diensten-in-het-buitenland/', true)
on conflict (year, key) do nothing;
