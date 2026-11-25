-- Nexuslive v2 (25 Nov 2026): every purchase in view, food staples and luxury,
-- the purchase review with stop lists, the Sunday review and monthly
-- close, and the settings the compact screens and sliders read.
--   * Receipts (order emails, Apple receipts, receipt photos), Wallet taps,
--     splits of one bank line over two categories, recurring charges with their
--     review call, cancel routes, alerts and month closes.
--   * Category rules can carry a date range, so a new rule (Food luxury from
--     25 Nov) leaves older lines in the category they had (Groceries).
--   * Every threshold, list and target is a row in app_config; none is in code.
--   * Cron: the five jobs that call deleted functions stop; the bank sync runs
--     four times a day (PSD2 allows four unattended pulls per account a day);
--     the spend function runs after each sync.

-- 1. Providers: the v2 mailbox has its own connection, so the expense agent,
--    which reads invoices from a "google" connection, stays off (business
--    invoices go to Moneybird).
alter table public.integration_connections drop constraint if exists integration_connections_provider_check;
alter table public.integration_connections add constraint integration_connections_provider_check
  check (provider in ('google', 'gmail', 'wise', 'etoro', 'enable_banking', 'moneybird'));

-- 2. Rules with a date range.
alter table public.nx_category_rules add column if not exists valid_from date;
alter table public.nx_category_rules add column if not exists valid_to date;
comment on column public.nx_category_rules.valid_from is 'The rule applies to lines booked on or after this date (null: no start)';
comment on column public.nx_category_rules.valid_to is 'The rule applies to lines booked on or before this date (null: no end)';

create or replace function public.nx_classify(p_user uuid, p_fields jsonb)
returns table(rule_id uuid, category text, class text)
language sql stable security definer set search_path to 'public'
as $$
  select r.id, r.category, r.class
  from nx_category_rules r
  where r.user_id = p_user and r.active
    and (r.valid_from is null or nullif(p_fields ->> 'date', '') is null or (p_fields ->> 'date')::date >= r.valid_from)
    and (r.valid_to is null or nullif(p_fields ->> 'date', '') is null or (p_fields ->> 'date')::date <= r.valid_to)
    and not exists (
      select 1 from jsonb_each_text(r.match) as m(field, pattern)
      where not (coalesce(p_fields ->> m.field, '') ~* m.pattern
                 or regexp_replace(coalesce(p_fields ->> m.field, ''), '\s+', '', 'g') ~* m.pattern))
  order by r.priority
  limit 1
$$;

create or replace function public.nx_reclassify()
returns integer
language plpgsql security definer set search_path to 'public'
as $$
declare v_user uuid := auth.uid(); v_count integer;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  with fresh as (
    select t.id, c.rule_id, c.category, c.class
    from nx_transactions t
    cross join lateral nx_parse_bank_line(t.source, t.description, t.payee, t.counterparty_iban) p
    left join lateral nx_classify(v_user, jsonb_build_object(
      'name', coalesce(t.merchant, ''), 'details', coalesce(p.details, ''),
      'type', coalesce(p.tx_type, ''), 'own', case when t.is_own_transfer then '1' else '0' end,
      'date', t.booked_on::text)) c on true
    where t.user_id = v_user and t.review_status <> 'confirmed'
  )
  update nx_transactions t
     set rule_id = fresh.rule_id,
         category = coalesce(fresh.category, 'Uncategorised'),
         class = coalesce(fresh.class, 'unmatched'),
         review_status = case when fresh.rule_id is null then 'needs_review' else 'auto' end
    from fresh
   where t.id = fresh.id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- The same, for one user, called by the spend function after it names the
-- shop behind a Klarna or PayPal line.
create or replace function public.nx_reclassify_line(p_txn uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare t record; p record; c record;
begin
  select * into t from nx_transactions where id = p_txn;
  if t is null or t.review_status = 'confirmed' then return; end if;
  select * into p from nx_parse_bank_line(t.source, t.description, t.payee, t.counterparty_iban);
  select * into c from nx_classify(t.user_id, jsonb_build_object(
    'name', coalesce(t.merchant, ''), 'details', coalesce(p.details, ''),
    'type', coalesce(p.tx_type, ''), 'own', case when t.is_own_transfer then '1' else '0' end,
    'date', t.booked_on::text));
  update nx_transactions
     set rule_id = c.rule_id, category = coalesce(c.category, 'Uncategorised'), class = coalesce(c.class, 'unmatched'),
         review_status = case when c.rule_id is null then 'needs_review' else 'auto' end
   where id = p_txn;
end $$;
revoke all on function public.nx_reclassify_line(uuid) from public, anon, authenticated;

-- nx_ingest_transactions passes the booking date to nx_classify.
do $do$
declare v_def text;
begin
  select pg_get_functiondef('public.nx_ingest_transactions(uuid, jsonb)'::regprocedure) into v_def;
  if position('''date'', r.booked_on::text' in v_def) = 0 then
    v_def := replace(v_def,
      '''own'', case when v_own then ''1'' else ''0'' end));',
      '''own'', case when v_own then ''1'' else ''0'' end, ''date'', r.booked_on::text));');
    if position('''date'', r.booked_on::text' in v_def) = 0 then
      raise exception 'nx_ingest_transactions did not take the date: its text changed';
    end if;
    execute v_def;
  end if;
end $do$;

-- 3. Buy checks: purpose, urge and where the check was opened.
alter table public.nx_decisions add column if not exists purpose text;
alter table public.nx_decisions add column if not exists urge text;
alter table public.nx_decisions add column if not exists entry text;
alter table public.nx_decisions add column if not exists app_name text;
comment on column public.nx_decisions.purpose is 'Buy check: what the money serves (review.purpose_tags)';
comment on column public.nx_decisions.urge is 'Buy check: the feeling behind the urge (review.urge_tags)';
comment on column public.nx_decisions.entry is 'Buy check: where it was opened (app, shortcut, shopping_app, wallet, share, widget)';
comment on column public.nx_decisions.app_name is 'Buy check: the shopping app that opened it';

-- 4. Receipts and the lines they explain.
create table if not exists public.nx_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source text not null check (source in ('gmail', 'photo')),
  external_id text not null,
  received_at timestamptz not null,
  kind text not null check (kind in ('order', 'apple', 'grocery', 'other')),
  merchant text,
  total numeric,
  currency text,
  order_date date,
  items jsonb not null default '[]'::jsonb,
  txn_id uuid references public.nx_transactions(id) on delete set null,
  match_status text not null default 'unmatched' check (match_status in ('unmatched', 'matched', 'ignored')),
  note text,
  created_at timestamptz not null default now(),
  unique (user_id, source, external_id)
);
comment on table public.nx_receipts is 'Order emails, Apple receipts and receipt photos read by the spend function; txn_id is the bank line the receipt explains. items: [{name, amount, staple}].';
create index if not exists nx_receipts_txn on public.nx_receipts (txn_id);

create table if not exists public.nx_txn_splits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  txn_id uuid not null references public.nx_transactions(id) on delete cascade,
  category text not null,
  amount numeric not null,
  origin text not null check (origin in ('receipt', 'tap')),
  receipt_id uuid references public.nx_receipts(id) on delete set null,
  created_at timestamptz not null default now()
);
comment on table public.nx_txn_splits is 'One bank line spread over categories (a supermarket receipt split into Food staples and Food luxury). Amounts carry the sign of the line and add up to it.';
create index if not exists nx_txn_splits_txn on public.nx_txn_splits (txn_id);

create table if not exists public.nx_wallet_taps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tapped_at timestamptz not null default now(),
  merchant text not null,
  amount numeric,
  currency text not null default 'EUR',
  card text,
  planned boolean,
  food text check (food in ('staples', 'luxury')),
  txn_id uuid references public.nx_transactions(id) on delete set null,
  created_at timestamptz not null default now()
);
comment on table public.nx_wallet_taps is 'Apple Pay taps logged by the iOS Shortcuts Wallet automation, with the planned or impulse answer and, at a supermarket, staples only or luxury too.';

-- 5. Recurring charges, their review call, and where to cancel.
create table if not exists public.nx_cancel_routes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  priority integer not null default 100,
  pattern text not null,
  label text not null,
  route text not null check (route in ('apple', 'web', 'bank', 'notice')),
  url text,
  steps text,
  trap text,
  notice_to text,
  created_at timestamptz not null default now()
);
comment on table public.nx_cancel_routes is 'Where each recurring charge is cancelled; the first route by priority whose pattern matches the charge is used. Edited in the app (Settings, Cancel routes).';

create table if not exists public.nx_recurring (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key text not null,
  label text not null,
  category text,
  source text not null default 'bank' check (source in ('bank', 'apple')),
  cadence text not null check (cadence in ('weekly', 'monthly', 'quarterly', 'yearly', 'irregular')),
  amount numeric,
  per_year numeric,
  charges integer not null default 0,
  paid_this_year numeric not null default 0,
  last_charge date,
  next_due date,
  ends_on date,
  proposed_call text check (proposed_call in ('keep', 'cancel', 'move_business')),
  call text check (call in ('keep', 'cancel', 'move_business')),
  tag text check (tag in ('social_arb', 'net_worth', 'life', 'cut')),
  cancel_by date,
  status text check (status in ('to_cancel', 'requested', 'confirmed', 'charged_after_cancel')),
  note text,
  decided_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);
comment on table public.nx_recurring is 'Recurring charges found in the bank lines and Apple receipts. proposed_call is the review suggestion; call, tag, cancel_by and status are yours.';

-- 6. Alerts (stop list, charge after cancel, renewals) and month closes.
create table if not exists public.nx_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null,
  title text not null,
  detail text,
  txn_id uuid references public.nx_transactions(id) on delete set null,
  ref text not null,
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  unique (user_id, kind, ref)
);
comment on table public.nx_alerts is 'Same-day alerts: charges on a stop list (kind is the list name), Apple charges outside the allowed list from stop.apple_from, charges after a cancel. A breach counts on the Sunday review.';

create table if not exists public.nx_month_closes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  month date not null,
  figures jsonb not null,
  archive jsonb,
  closed_at timestamptz not null default now(),
  unique (user_id, month)
);
comment on table public.nx_month_closes is 'Monthly close: receipt coverage, unmatched lines and the VAT draft at the moment you approved, and the Drive archive.';

do $do$
declare t text;
begin
  foreach t in array array['nx_receipts', 'nx_txn_splits', 'nx_wallet_taps', 'nx_cancel_routes', 'nx_recurring', 'nx_alerts', 'nx_month_closes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $do$;

-- 7. What budgets count: a split line counts by its parts.
create or replace view public.nx_spend_lines with (security_invoker = true) as
select t.id, t.user_id, t.booked_on, t.amount, t.currency, t.merchant, t.category, t.class, t.rail,
       t.review_status, t.decision_id, t.created_at, false as split
from public.nx_transactions t
where not exists (select 1 from public.nx_txn_splits s where s.txn_id = t.id)
union all
select s.id, t.user_id, t.booked_on, s.amount, t.currency, t.merchant, s.category, t.class, t.rail,
       t.review_status, t.decision_id, t.created_at, true as split
from public.nx_txn_splits s join public.nx_transactions t on t.id = s.txn_id;
comment on view public.nx_spend_lines is 'Bank lines for budgets: a line with splits appears once per split, with the split category and amount.';
grant select on public.nx_spend_lines to authenticated;

-- 8. Two of the seven measures that need the books.
create or replace function public.nx_measures()
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  v_days integer;
  v_with numeric; v_all numeric; v_untagged integer;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  select value::integer into v_days from app_config where key = 'measures.untagged_days';
  if v_days is null then raise exception 'app_config measures.untagged_days is missing'; end if;
  select coalesce(sum(coalesce(e.amount_eur, e.amount) * coalesce(e.business_use_pct, 1)) filter (where e.evidence_path is not null), 0),
         coalesce(sum(coalesce(e.amount_eur, e.amount) * coalesce(e.business_use_pct, 1)), 0)
    into v_with, v_all
  from expenses e
  where e.user_id = v_user and e.status <> 'rejected'
    and e.treatment in ('fully_deductible', 'limited_deductible', 'asset')
    and e.date >= date_trunc('year', current_date)::date;
  select count(*) into v_untagged
  from nx_transactions t
  where t.user_id = v_user and t.booked_on < current_date - v_days
    and (t.review_status = 'needs_review' or t.category in ('Uncategorised', 'To check (business or private?)'));
  return jsonb_build_object(
    'invoice_value_with', round(v_with, 2), 'invoice_value_all', round(v_all, 2),
    'invoice_coverage_pct', case when v_all > 0 then round(v_with / v_all * 100, 1) end,
    'untagged_older', v_untagged, 'untagged_days', v_days);
end $$;
revoke all on function public.nx_measures() from public, anon;
grant execute on function public.nx_measures() to authenticated;

-- 9. Settings the engine reads. Every number below can be changed in
--    app_config; none sits in code.
insert into public.app_config (key, value, description) values
('plan.business_growth_range', '{"min": 0, "max": 6, "step": 0.1}', 'Business growth slider range, percent a month'),
('plan.return_real_pct', '7.0', 'Return after inflation, slider start: long-run equities and housing (Jorda et al. 2019, QJE)'),
('plan.return_range', '{"min": 0, "max": 10, "step": 0.5}', 'Return after inflation slider range, percent a year'),
('plan.return_band_pct', '2', 'The net worth band is this many points below and above the return slider'),
('plan.withdrawal_rate_pct', '2.3', 'Withdrawal rate, slider start: a 65-year-old couple at a 5% chance of running out (Anarkulova, Cederburg, O''Doherty and Sias 2025)'),
('plan.withdrawal_range', '{"min": 2, "max": 4, "step": 0.1}', 'Withdrawal rate slider range, percent a year'),
('plan.invest_step_eur', '50', 'Monthly invest slider step'),
('plan.forecast_years', '10', 'Years in the net worth forecast and the ten-year value on a Buy check'),
('plan.chart_months', '12', 'Months in the spend against cap and recurring charges charts'),
('spend.mail_query', '(category:purchases OR from:no_reply@email.apple.com) newer_than:{days}d', 'Gmail search for order emails and Apple receipts; {days} is the look-back'),
('spend.mail_lookback_days', '45', 'Days the first mailbox read looks back; later reads start at the last message read'),
('spend.mail_max_per_run', '40', 'Messages read per run, so one run stays inside the function time limit'),
('spend.apple_sender_pattern', 'no_reply@email\.apple\.com', 'Sender of Apple receipts'),
('spend.google_scopes', 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file', 'Google scopes for the v2 mailbox: read mail, and write only the files Nexus creates in Drive (the monthly archive)'),
('spend.match_window_days', '5', 'Days between a receipt and its bank line that still count as the same purchase'),
('spend.match_tolerance_eur', '0.05', 'Euros a receipt total may differ from its bank line'),
('spend.unmask_rails', '["klarna", "paypal"]', 'Payment rails whose bank line hides the shop; a matched order email names it'),
('food.staples_category', 'Food staples', 'Budget line for staples'),
('food.luxury_category', 'Food luxury', 'Budget line for everything else from a supermarket'),
('food.receipt_days', '2', 'A supermarket line with no receipt after this many days counts in full as luxury'),
('food.supermarket_pattern', 'albert heijn|^ah |jumbo|lidl|aldi|dirk|ekoplaza|marqt|vomar|picnic|crisp|spar|mercadona', 'Shops where a Wallet tap asks staples only or luxury too'),
('stop.apple_line_pattern', 'apple\.com/bill|apple\.com', 'Bank and card lines billed by Apple'),
('review.urge_tags', '["planned", "bored", "tired", "celebrating", "stressed"]', 'The feeling behind the urge, asked in one tap on each Buy check'),
('review.weekly', '{"weekday": 1, "hour": 10, "minute": 0}', 'Sunday review reminder (weekday 1 is Sunday)'),
('review.renewal_reminder_days', '3', 'Days before a renewal that Nexus reminds you'),
('review.rule_priority', '245', 'Priority of a rule made from a review answer ("always tag this shop as that"); lower runs first'),
('recurring.lookback_months', '13', 'Months of bank lines read to find recurring charges'),
('recurring.min_charges', '2', 'Charges needed before a shop counts as recurring'),
('recurring.cadence_days', '{"weekly": [6, 8], "monthly": [26, 35], "quarterly": [85, 97], "yearly": [350, 380]}', 'Days between charges for each cadence'),
('recurring.amount_tolerance_pct', '20', 'Charges within this percent of each other count as the same subscription'),
('recurring.classes', '["fixed", "variable", "discretionary", "check", "opaque", "business"]', 'Line classes searched for recurring charges'),
('measures.untagged_days', '7', 'A line still untagged after this many days counts on the seven-number card'),
('measures.targets', '{"invoice_coverage_pct": 95, "untagged_older": 0, "buy_check_pct": 100, "hidden_eur_month": 0, "minutes_week": 20}', 'Targets on the seven-number card'),
('notifications.max_per_day', '1', 'At most this many reminders a day, plus payday (Karlan et al. 2016: extra late reminders added nothing)'),
('close.drive_root_name', 'Nexus receipts archive', 'Drive folder Nexus creates for the monthly archive (it can only write in folders it created; move it anywhere, Nexus keeps its id)'),
('close.drive_subpath', '{year}/{month}', 'Folders inside the archive folder, one per month'),
('integrations.drive_upload_base', 'https://www.googleapis.com/upload/drive/v3', 'Drive upload endpoint'),
('close.vat_kind', 'vat_quarter', 'tax_filings kind shown as the VAT draft in the monthly close')
on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = now();

-- Owner settings are set per owner (in the app, or by a private seed) and are
-- not in this public file: the target (target.monthly_income_eur, target.date),
-- the growth slider start (plan.business_growth_pct), the stop lists (each a
-- pair stop.<name>_pattern and stop.<name>_from; its alerts carry the name)
-- and the Apple stop date (stop.apple_from). Until they are set, the screens
-- and checks that need them stay off. The lists below start empty.
insert into public.app_config (key, value, description) values
('food.staples', '[]', 'Food staples; everything else from a supermarket is luxury'),
('stop.apple_allowed', '[]', 'Apple subscriptions allowed after stop.apple_from'),
('review.purpose_tags', '["work", "net worth", "life"]', 'What a Buy check serves'),
('review.standing_calls', '[]', 'Standing calls on recurring charges: [{pattern, call, tag, note}]; a call already on a charge is never changed'),
('review.proposals', '[]', 'Suggested calls on recurring charges: [{pattern, call, note}]; they fill the proposal only')
on conflict (key) do nothing;

-- The model that reads order emails, Apple receipts and receipt photos.
insert into public.agent_configs (id, runner, enabled, agent_id, llm_model, max_tokens, temperature, display_name, llm_provider, system_prompt, cache_ttl_seconds, rate_limit_per_day)
select 'agent_spend_reader_001', 'dedicated', true, 'spend_reader', a.llm_model, 2048, 0.00, 'Receipt Reader', a.llm_provider,
       'You read one order confirmation email, Apple receipt or shop receipt photo for the owner''s personal budget. Record only what the document shows: the shop that sold the goods (not the payment service such as Klarna or PayPal), the order or receipt total, its currency and date, and every item line with its price. Never guess a number: use null when it is not shown. For each item set staple to true only when it is one of the staples you are given (any language or brand counts); everything else is false. Set kind to apple for an Apple receipt, grocery for a supermarket receipt, order for any other shop, and other when the document is not a purchase. Never use em dashes or arrow characters.',
       0, 500
from public.agent_configs a where a.agent_id = 'expense'
on conflict (id) do nothing;

-- 10. Accounts screen: Gmail moves to Settings (its own mailbox connection);
--     bunq is optional.
update public.app_config
set value = jsonb_pretty((select coalesce(jsonb_agg(case when e ->> 'id' = 'bunq' then e || '{"optional": true}'::jsonb else e end order by n), '[]'::jsonb)
                          from jsonb_array_elements(value::jsonb) with ordinality as x(e, n) where e ->> 'id' <> 'gmail')),
    updated_at = now()
where key = 'integrations.catalog';

-- 11. Owner data is not in this public file either: the food category rules
--     (a rule can now carry valid_from and valid_to, so a new rule leaves older
--     lines where they were), the budgets and the cancel routes are set per
--     owner in the app or by a private seed.

-- 12. Cron: stop the jobs that call deleted functions; four bank syncs a day;
--     the spend function after each.
do $do$
declare j text;
begin
  foreach j in array array['nexus-recalc', 'nexus-run-agents', 'nexus-sync-stripe', 'nexus-sync-wise', 'nexus-sync-bank'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $do$;
select cron.schedule('nexus-accounts-sync', '13 5,11,16,21 * * *', $$select public.invoke_edge('nexus/accounts')$$);
select cron.schedule('nexus-spend', '33 5,11,16,21 * * *', $$select public.invoke_edge('spend', '{"mode": "daily"}'::jsonb)$$);
