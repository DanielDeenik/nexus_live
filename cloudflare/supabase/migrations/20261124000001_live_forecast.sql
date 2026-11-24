-- Live forecast: the tax rules for the tariefsaanpassing, belastingrente and
-- the BV comparison; per-year inputs the books cannot know; settings the
-- owner changes in the app; the stored forecast behind safe to spend; the
-- 2027 Ontario holidays; and a daily refresh.

-- 1. Tax rules 2026 (checked 24 Nov 2026).
insert into public.tax_parameters (year, key, value, description, source_url, verified) values
(2026, 'ib.tariefsaanpassing_rate', '0.1194'::jsonb,
 'Deductions in the top bracket (ondernemersaftrek, MKB-winstvrijstelling) give at most the second bracket rate of 37.56%',
 'https://www.belastingdienst.nl/wps/wcm/connect/nl/aftrek-en-kortingen/content/afbouw-tarief-aftrekposten-bij-hoog-inkomen', true),
(2026, 'ib.belastingrente', '{"rate": 0.05, "file_before": "05-01", "interest_from": "07-01"}'::jsonb,
 'Belastingrente on income tax: 5% from 1 July of the next year, unless the return is filed before 1 May and the assessment follows it',
 'https://www.sra.nl/nieuws/259001/2026/04/voorkom-belastingrente-met-tijdige-aangifte-of-voorlopige-aanslag', true),
(2026, 'vpb.brackets', '[{"up_to": 200000, "rate": 0.19}, {"up_to": null, "rate": 0.258}]'::jsonb,
 'Corporate tax (vennootschapsbelasting)',
 'https://www.rendement.nl/prinsjesdag/nieuws/nog-wat-meer-belastingcijfers-voor-2026.html', true),
(2026, 'box2.brackets', '[{"up_to": 68843, "rate": 0.245}, {"up_to": null, "rate": 0.31}]'::jsonb,
 'Box 2 (aanmerkelijk belang) for one taxpayer',
 'https://www.dezaak.nl/financien/belastingen/belastingwijzigingen-2026-dit-staat-ondernemers-te-wachten/', true),
(2026, 'dga.gebruikelijk_loon_min', '58000'::jsonb,
 'Normbedrag gebruikelijk loon: the DGA salary is the highest of this, the most comparable job and the best paid employee',
 'https://www.sra.nl/nieuws/004501/2025/12/gebruikelijk-loon-dga-in-2026-naar-58000', true),
(2026, 'zvw.employer', '{"rate": 0.061, "max_income": 79409}'::jsonb,
 'Werkgeversheffing Zvw that a BV pays on the DGA salary',
 'https://www.rendement.nl/sociale-verzekeringen/nieuws/definitieve-percentages-zvw-premie-2026-bekend.html', true)
on conflict (year, key) do update
  set value = excluded.value, description = excluded.description, source_url = excluded.source_url,
      verified = excluded.verified, updated_at = now();

-- 2. Assets written off in full in the purchase year (willekeurige
--    afschrijving for starters, allowed in a year with startersaftrek).
alter table public.fixed_assets add column if not exists full_write_off boolean not null default false;
comment on column public.fixed_assets.full_write_off is
  'Written off in full in the purchase year (willekeurige afschrijving for starters); only valid in a year with startersaftrek.';

-- 3. Per-year inputs the books cannot know.
create table if not exists public.nx_tax_year_inputs (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  year integer not null check (year between 2000 and 2100),
  wage_gross_eur numeric not null default 0 check (wage_gross_eur >= 0),
  wage_tax_withheld_eur numeric not null default 0 check (wage_tax_withheld_eur >= 0),
  lijfrente_eur numeric not null default 0 check (lijfrente_eur >= 0),
  prepaid_eur numeric not null default 0 check (prepaid_eur >= 0),
  days_off numeric not null default 0 check (days_off between 0 and 366),
  startersaftrek_eligible boolean,
  note text check (length(note) <= 500),
  updated_at timestamptz not null default now(),
  primary key (user_id, year)
);
comment on table public.nx_tax_year_inputs is
  'Wage and wage tax withheld, lijfrente, provisional assessment payments, planned days off and startersaftrek per tax year. Null startersaftrek_eligible means the profile setting.';
alter table public.nx_tax_year_inputs enable row level security;
drop policy if exists nx_tax_year_inputs_own on public.nx_tax_year_inputs;
create policy nx_tax_year_inputs_own on public.nx_tax_year_inputs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.nx_tax_year_inputs from anon;

-- 4. Settings the owner changes in the app (investing target, BV comparison, structure shown).
create table if not exists public.nx_user_settings (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key text not null check (key ~ '^[a-z_]+\.[a-z0-9_.]+$' and length(key) <= 80),
  value text not null check (length(value) <= 200),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.nx_user_settings enable row level security;
drop policy if exists nx_user_settings_own on public.nx_user_settings;
create policy nx_user_settings_own on public.nx_user_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.nx_user_settings from anon;

-- 5. The stored live forecast, written only by the forecast function.
create table if not exists public.nx_tax_forecast_live (
  user_id uuid not null references auth.users(id) on delete cascade,
  year integer not null,
  reserve_eur numeric not null,
  figures jsonb not null,
  computed_at timestamptz not null default now(),
  primary key (user_id, year)
);
comment on table public.nx_tax_forecast_live is
  'Live income tax forecast per year. reserve_eur is tax on income billed so far, less wage tax withheld and prepayments, plus the buffer; safe to spend subtracts it.';
alter table public.nx_tax_forecast_live enable row level security;
drop policy if exists nx_tax_forecast_live_select_own on public.nx_tax_forecast_live;
create policy nx_tax_forecast_live_select_own on public.nx_tax_forecast_live for select to authenticated
  using (user_id = auth.uid());
revoke all on public.nx_tax_forecast_live from anon;
revoke insert, update, delete, truncate on public.nx_tax_forecast_live from authenticated;

-- 6. Defaults and the refresh schedule.
insert into public.app_config (key, value, description) values
('bv.annual_costs_eur', '3000', 'Estimated yearly cost of running a BV (accountant, corporate tax return, filings) for the BV comparison; the owner can change it in the app'),
('cron.forecast_schedule', '47 5 * * *', 'Daily refresh of the live forecast and tax reserve (UTC)')
on conflict (key) do nothing;

-- 7. Ontario public holidays 2027 (Easter is 28 March 2027).
insert into public.public_holidays (region_code, holiday_date, name, source_url) values
('CA-ON','2027-01-01','New Year''s Day','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2027-02-15','Family Day','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2027-03-26','Good Friday','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2027-05-24','Victoria Day','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2027-07-01','Canada Day','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2027-09-06','Labour Day','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2027-10-11','Thanksgiving','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2027-12-27','Christmas Day (observed)','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays'),
('CA-ON','2027-12-28','Boxing Day (observed)','https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays')
on conflict do nothing;

-- The web forecaster's calendar had Good Friday 2027 a week late.
update public.app_config
   set value = replace(value, '{"date": "2027-04-02", "name": "Good Friday"}', '{"date": "2027-03-26", "name": "Good Friday"}'), updated_at = now()
 where key = 'forecast.work_calendar';

-- 8. Safe to spend subtracts the live reserve of every year still unpaid; an
--    approved income tax draft is the fallback until the forecast has run.
create or replace function public.nx_money_summary()
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_month date := date_trunc('month', current_date)::date;
  v_accounts jsonb; v_cash numeric; v_tax numeric; v_tax_label text; v_tax_years text; v_tax_at timestamptz; v_fixed_left numeric;
begin
  if v_user is null then raise exception 'not signed in'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
            'label', a.label, 'source', a.source, 'account', a.account, 'kind', a.kind,
            'balance', round(a.opening_balance + coalesce(t.total, 0), 2), 'last_booked', t.last_booked)
          order by a.label), '[]'::jsonb),
         coalesce(sum(a.opening_balance + coalesce(t.total, 0)) filter (where a.include_in_cash), 0)
    into v_accounts, v_cash
  from nx_accounts a
  left join lateral (
    select sum(x.amount) as total, max(x.booked_on) as last_booked
    from nx_transactions x
    where x.user_id = a.user_id and x.source = a.source and x.account = a.account and x.booked_on >= a.opening_date
  ) t on true
  where a.user_id = v_user;

  select coalesce(sum(greatest(l.reserve_eur, 0)), 0),
         string_agg(l.year::text, ' and ' order by l.year) filter (where l.reserve_eur > 0),
         max(l.computed_at)
    into v_tax, v_tax_years, v_tax_at
  from nx_tax_forecast_live l
  where l.user_id = v_user and l.year <= extract(year from current_date);

  if v_tax_at is null then
    select (f.figures -> 'ytd' ->> 'total_due')::numeric, 'Income tax and Zvw ' || f.period_label
      into v_tax, v_tax_label
    from tax_filings f
    where f.user_id = v_user and f.kind = 'income_tax_year' and f.status = 'approved'
      and f.period_label = extract(year from current_date)::text
    order by f.created_at desc
    limit 1;
    v_tax_label := coalesce(v_tax_label, 'No approved tax estimate yet');
  else
    v_tax_label := case when v_tax > 0 then 'Tax ' || v_tax_years || ' to set aside' else 'No tax to set aside' end;
  end if;

  with budgets as (
    select distinct on (b.category) b.category, b.monthly_amount
    from nx_budgets b
    where b.user_id = v_user and b.valid_from <= current_date
    order by b.category, b.valid_from desc
  ), classes as (
    select distinct on (r.category) r.category, r.class
    from nx_category_rules r
    where r.user_id = v_user and r.active
    order by r.category, r.priority
  ), spent as (
    select x.category, sum(-x.amount) as s
    from nx_transactions x
    where x.user_id = v_user and x.booked_on >= v_month and x.class = 'fixed'
    group by x.category
  )
  select coalesce(sum(greatest(b.monthly_amount - coalesce(s.s, 0), 0)), 0)
    into v_fixed_left
  from budgets b
  join classes c on c.category = b.category and c.class = 'fixed'
  left join spent s on s.category = b.category;

  return jsonb_build_object(
    'as_of', (select max(booked_on) from nx_transactions where user_id = v_user),
    'cash', round(v_cash, 2),
    'accounts', v_accounts,
    'tax_reserve', round(coalesce(v_tax, 0), 2),
    'tax_reserve_label', v_tax_label,
    'tax_computed_at', v_tax_at,
    'fixed_left', round(v_fixed_left, 2),
    'safe_to_spend', round(v_cash - coalesce(v_tax, 0) - v_fixed_left, 2));
end $function$;

-- 9. Daily refresh.
select public.schedule_from_config('nexus-forecast', 'cron.forecast_schedule',
  $$select public.invoke_edge('nexus/forecast')$$);
