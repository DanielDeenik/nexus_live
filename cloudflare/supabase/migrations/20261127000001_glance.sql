-- Glance (27 Nov 2026): one read-only source behind the phone's Today, Slipping,
-- A month and Assignment screens and the web look-through.
--   * nx_glance_facts() gathers every figure once: what you hold and owe, an
--     average month of next year from the live forecast, living costs against the
--     plan, investing, hours, the review rhythm, recurring charges and the days
--     until the next client payment.
--   * nx_glance() words those figures for the phone. nx_look() returns the same
--     wording plus the facts for the web tables. Both read the same facts in the
--     same call, so the phone and the web cannot disagree.
--   * nx_set_assignment_end() is the only write: the end date you enter yourself.
--   * Every threshold and list is a row in app_config; none is in code.

-- 1. Settings.
insert into public.app_config (key, value, description) values
  ('glance.phone_items', '3', 'Slipping on the phone: rows shown before the rest is left to the web app'),
  ('glance.snapshot_max_age_days', '7', 'Slipping: a net worth snapshot older than this many days counts as missing (the Sunday review saves one)'),
  ('glance.spendable_kinds', '["current", "pot"]', 'Look-through, until the next payment: account kinds that day to day charges leave from'),
  ('web.base_url', 'https://app.lensiq.company', 'Address of the Nexus web app; the phone links to its look-through and time entries')
on conflict (key) do nothing;

-- 2. Wording helpers.
create or replace function public.nx_fmt_eur(p numeric, p_decimals integer default 0)
returns text
language sql
immutable
as $function$
  select case when p is null then null else
    (case when round(p, p_decimals) < 0 then '−' else '' end) || '€' ||
    to_char(abs(round(p, p_decimals)),
            case when p_decimals > 0 then 'FM999,999,999,990.' || repeat('0', p_decimals) else 'FM999,999,999,990' end)
  end
$function$;

create or replace function public.nx_fmt_num(p numeric)
returns text
language sql
immutable
as $function$
  select case when p is null then null else rtrim(rtrim(to_char(round(p, 2), 'FM999,999,999,990.00'), '0'), '.') end
$function$;

create or replace function public.nx_fmt_day(p date)
returns text
language sql
stable
as $function$
  select case when p is null then null else
    to_char(p, 'Dy FMDD Mon') || case when extract(year from p) <> extract(year from current_date) then to_char(p, ' YYYY') else '' end
  end
$function$;

-- Euros per unit of a currency: the newest ECB rate the functions have cached.
create or replace function public.nx_fx_latest(p_currency text, out rate numeric, out rate_date date)
language sql
stable security definer
set search_path = public
as $function$
  select case when upper(p_currency) = 'EUR' then 1::numeric else (
           select (c.value ->> 'rate')::numeric from kv_cache c
           where c.key like 'fx:' || upper(p_currency) || ':%' order by c.key desc limit 1) end,
         case when upper(p_currency) = 'EUR' then current_date else (
           select (c.value ->> 'date')::date from kv_cache c
           where c.key like 'fx:' || upper(p_currency) || ':%' order by c.key desc limit 1) end
$function$;

-- 3. The facts.
create or replace function public.nx_glance_facts()
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $function$
declare
  v_user uuid := auth.uid();
  v_today date := current_date;
  v_month date := date_trunc('month', current_date)::date;
  v_prev_month date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_year integer := extract(year from current_date)::integer;
  r record;
  -- settings
  v_avg_months integer;
  v_spend_classes text[];
  v_planned_classes text[];
  v_spendable text[];
  v_snapshot_days integer;
  v_phone_items integer;
  v_weekly jsonb;
  v_web_url text;
  v_target numeric;
  v_income_target numeric;
  v_income_date date;
  v_structure text;
  v_base text;
  -- hold
  v_money jsonb;
  v_cash numeric; v_tax numeric; v_fixed_left numeric; v_safe numeric; v_through date;
  v_recv numeric; v_recv_rows jsonb;
  v_inv numeric := 0; v_inv_rows jsonb := '[]'::jsonb; v_inv_missing jsonb := '[]'::jsonb;
  v_fx_rate numeric; v_fx_date date;
  v_hold numeric; v_yours numeric;
  -- forecast
  v_fc jsonb; v_fc_year integer; v_fc_at timestamptz; v_ny jsonb; v_nyf jsonb;
  v_rate numeric; v_rate_cur text; v_fx numeric; v_eur_hour numeric; v_keep numeric; v_hours_day numeric;
  v_billed_m numeric; v_tax_m numeric; v_costs_m numeric; v_net_m numeric; v_hours_m numeric;
  v_per_unit numeric; v_rate_budget numeric; v_rate_now numeric; v_rate_since date;
  v_bv_m numeric; v_cur_month jsonb;
  v_pot numeric; v_year_end date;
  -- spend
  v_win_from date;
  v_classes jsonb; v_categories jsonb;
  v_living_avg numeric; v_living_budget numeric; v_disc_avg numeric; v_disc_budget numeric; v_mtd numeric;
  v_left_now numeric; v_left_budget numeric; v_short_now numeric; v_short_budget numeric;
  v_rules_since date; v_prev_from date; v_prev_to date; v_day_since numeric; v_day_before numeric;
  v_rule_safe text;
  -- invest, hours, review, alternatives
  v_invest_month numeric; v_invest_year numeric;
  v_hours_last date; v_minutes_month numeric;
  v_snap_date date; v_snap_total numeric; v_review_next date;
  v_close_last date; v_prev_closed boolean;
  v_roles integer; v_roles_hot integer; v_apps_sent integer; v_apps_drafted integer;
  -- recurring, contract, invoices, calendar
  v_recurring jsonb; v_recurring_year numeric; v_recurring_count integer;
  v_contract jsonb;
  v_invoices jsonb; v_eur_hour_min numeric; v_eur_hour_max numeric;
  v_horizon date; v_start numeric; v_calendar jsonb; v_first_negative date; v_low numeric; v_low_date date;
begin
  if v_user is null then raise exception 'not signed in'; end if;

  -- Settings: your own value where you set one, the default in app_config otherwise.
  select value::integer into v_avg_months from app_config where key = 'budget.average_months';
  if v_avg_months is null or v_avg_months < 1 then raise exception 'app_config budget.average_months is missing'; end if;
  select array(select jsonb_array_elements_text(value::jsonb)) into v_spend_classes from app_config where key = 'budget.spend_classes';
  if v_spend_classes is null then raise exception 'app_config budget.spend_classes is missing'; end if;
  select array(select jsonb_array_elements_text(value::jsonb)) into v_planned_classes from app_config where key = 'budget.planned_classes';
  select array(select jsonb_array_elements_text(value::jsonb)) into v_spendable from app_config where key = 'glance.spendable_kinds';
  select value::integer into v_snapshot_days from app_config where key = 'glance.snapshot_max_age_days';
  select value::integer into v_phone_items from app_config where key = 'glance.phone_items';
  if v_snapshot_days is null or v_phone_items is null then raise exception 'app_config glance.* is missing'; end if;
  select value::jsonb into v_weekly from app_config where key = 'review.weekly';
  select value into v_web_url from app_config where key = 'web.base_url';
  select coalesce((select s.value from nx_user_settings s where s.user_id = v_user and s.key = 'invest.monthly_target_eur'),
                  (select c.value from app_config c where c.key = 'invest.monthly_target_eur'))::numeric into v_target;
  select coalesce((select s.value from nx_user_settings s where s.user_id = v_user and s.key = 'target.monthly_income_eur'),
                  (select c.value from app_config c where c.key = 'target.monthly_income_eur'))::numeric into v_income_target;
  select coalesce((select s.value from nx_user_settings s where s.user_id = v_user and s.key = 'target.date'),
                  (select c.value from app_config c where c.key = 'target.date'))::date into v_income_date;
  select coalesce((select s.value from nx_user_settings s where s.user_id = v_user and s.key = 'plan.structure'),
                  (select c.value from app_config c where c.key = 'plan.structure')) into v_structure;
  select p.base_currency into v_base from profiles p where p.id = v_user;
  v_win_from := (v_month - make_interval(months => v_avg_months))::date;

  -- Hold and owe: the same money summary the app shows, so safe to spend is one number everywhere.
  v_money := nx_money_summary();
  v_cash := (v_money ->> 'cash')::numeric;
  v_tax := (v_money ->> 'tax_reserve')::numeric;
  v_fixed_left := (v_money ->> 'fixed_left')::numeric;
  v_safe := (v_money ->> 'safe_to_spend')::numeric;
  v_through := (v_money ->> 'as_of')::date;

  select coalesce(sum(x.eur), 0),
         coalesce(jsonb_agg(jsonb_build_object('number', x.invoice_number, 'period', x.period, 'hours', x.hours, 'amount', x.amount,
                  'currency', x.currency, 'amount_eur', round(x.eur, 2), 'due', x.due) order by x.due nulls last, x.invoice_number), '[]'::jsonb)
    into v_recv, v_recv_rows
  from (
    select i.invoice_number, coalesce(i.period_start, i.issued_date) as period, i.hours, i.amount, i.currency,
           coalesce(i.amount_eur, i.amount * i.fx_rate_eur, case when i.currency = 'EUR' then i.amount end) as eur,
           coalesce(i.expected_cash_date, i.due_date) as due
    from invoices i
    where i.user_id = v_user and i.voided_at is null and i.duplicate_of is null and i.status <> 'paid'
      and coalesce(i.review_state, 'confirmed') = 'confirmed'
  ) x;

  -- Broker and wallets, converted at the newest cached ECB rate. Without a rate they are named, not counted.
  for r in
    select 'eToro'::text as label, 'USD'::text as currency,
           coalesce((c.cursor ->> 'credit_usd')::numeric, 0)
             + coalesce((select sum(p.value) from nx_positions p where p.user_id = v_user and p.source = 'etoro'), 0) as amount,
           (c.cursor ->> 'as_of')::timestamptz as as_of,
           (select count(*) from nx_positions p where p.user_id = v_user and p.source = 'etoro')::integer as positions
    from integration_connections c
    where c.user_id = v_user and c.provider = 'etoro' and c.status <> 'revoked'
    union all
    select coalesce(w.label, 'Wise ' || w.currency), w.currency, w.balance, null::timestamptz, null::integer
    from wise_accounts w
    where w.user_id = v_user
  loop
    select f.rate, f.rate_date into v_fx_rate, v_fx_date from nx_fx_latest(r.currency) f;
    if v_fx_rate is null then
      v_inv_missing := v_inv_missing || to_jsonb(r.label);
    else
      v_inv := v_inv + r.amount * v_fx_rate;
    end if;
    v_inv_rows := v_inv_rows || jsonb_build_object('label', r.label, 'currency', r.currency, 'amount', round(r.amount, 2),
      'amount_eur', round(r.amount * v_fx_rate, 2), 'rate', v_fx_rate, 'rate_date', v_fx_date, 'as_of', r.as_of, 'positions', r.positions);
  end loop;

  v_hold := v_cash + v_recv + v_inv;
  v_yours := v_hold - v_tax;

  -- Spending: the average of the last full months against the plan, and this month so far.
  select coalesce(jsonb_object_agg(c.class, round(c.total / v_avg_months, 2)), '{}'::jsonb), coalesce(sum(c.total), 0) / v_avg_months
    into v_classes, v_living_avg
  from (
    select l.class, -sum(l.amount) as total
    from nx_spend_lines l
    where l.user_id = v_user and l.class = any(v_spend_classes) and l.booked_on >= v_win_from and l.booked_on < v_month
    group by l.class
  ) c;
  v_disc_avg := coalesce((v_classes ->> 'discretionary')::numeric, 0);

  with budgets as (
    select distinct on (b.category) b.category, b.monthly_amount
    from nx_budgets b
    where b.user_id = v_user and b.valid_from <= v_today
    order by b.category, b.valid_from desc
  ), rule_class as (
    select distinct on (q.category) q.category, q.class
    from nx_category_rules q
    where q.user_id = v_user and q.active
      and (q.valid_from is null or q.valid_from <= v_today) and (q.valid_to is null or q.valid_to >= v_today)
    order by q.category, q.priority
  ), win as (
    select l.category, min(l.class) as class, -sum(l.amount) as total
    from nx_spend_lines l
    where l.user_id = v_user and l.class = any(v_spend_classes) and l.booked_on >= v_win_from and l.booked_on < v_month
    group by l.category
  ), mtd as (
    select l.category, min(l.class) as class, -sum(l.amount) as total
    from nx_spend_lines l
    where l.user_id = v_user and l.class = any(v_spend_classes) and l.booked_on >= v_month
    group by l.category
  ), names as (
    select category from win union select category from mtd union select category from budgets
  ), cats as (
    select n.category, coalesce(w.class, m.class, rc.class) as class, b.monthly_amount as budget,
           coalesce(w.total, 0) / v_avg_months as avg, coalesce(m.total, 0) as mtd
    from names n
    left join win w on w.category = n.category
    left join mtd m on m.category = n.category
    left join budgets b on b.category = n.category
    left join rule_class rc on rc.category = n.category
    where w.category is not null or m.category is not null or rc.class is null or rc.class = any(v_spend_classes)
  )
  select coalesce(jsonb_agg(jsonb_build_object('category', c.category, 'class', c.class, 'budget', c.budget,
           'avg', round(c.avg, 2), 'mtd', round(c.mtd, 2)) order by c.avg desc, c.category), '[]'::jsonb),
         coalesce(sum(c.budget), 0), coalesce(sum(c.budget) filter (where c.class = 'discretionary'), 0), coalesce(sum(c.mtd), 0)
    into v_categories, v_living_budget, v_disc_budget, v_mtd
  from cats c;

  -- Purchases a day since your rules started, against the last full month before them.
  select min(d.created_at)::date into v_rules_since from nx_decisions d where d.user_id = v_user and d.kind = 'rule' and d.active;
  if v_rules_since is not null and v_planned_classes is not null and v_through is not null and v_through >= v_rules_since then
    v_prev_to := date_trunc('month', v_rules_since)::date;
    v_prev_from := (v_prev_to - interval '1 month')::date;
    select coalesce(-sum(l.amount) filter (where l.booked_on >= v_rules_since), 0) / greatest(v_through - v_rules_since + 1, 1),
           coalesce(-sum(l.amount) filter (where l.booked_on >= v_prev_from and l.booked_on < v_prev_to), 0) / greatest(v_prev_to - v_prev_from, 1)
      into v_day_since, v_day_before
    from nx_spend_lines l
    where l.user_id = v_user and l.class = any(v_planned_classes) and l.amount < 0 and l.booked_on >= v_prev_from;
  end if;
  select d.then_action into v_rule_safe
  from nx_decisions d
  where d.user_id = v_user and d.kind = 'rule' and d.active
    and regexp_replace(lower(d.if_condition), '[^a-z]', '', 'g') like '%safetospendbelowzero%'
  order by d.created_at
  limit 1;

  -- Investing: what left for the broker this month and this year.
  select coalesce(-sum(t.amount) filter (where t.booked_on >= v_month), 0), coalesce(-sum(t.amount), 0)
    into v_invest_month, v_invest_year
  from nx_transactions t
  where t.user_id = v_user and t.class = 'investing' and t.booked_on >= make_date(v_year, 1, 1);

  -- The live forecast: rate, marginal tax and next year in full.
  select l.figures, l.year, l.computed_at into v_fc, v_fc_year, v_fc_at
  from nx_tax_forecast_live l
  where l.user_id = v_user and l.year <= v_year
  order by l.year desc
  limit 1;
  if v_fc is not null then
    v_ny := v_fc -> 'next_year';
    v_nyf := v_ny -> 'figures';
    v_rate := (v_fc -> 'rate' ->> 'unit_rate')::numeric;
    v_rate_cur := v_fc -> 'rate' ->> 'currency';
    v_fx := (v_fc -> 'rate' ->> 'fx_eur')::numeric;
    v_eur_hour := (v_fc -> 'rate' ->> 'eur_per_hour')::numeric;
    v_keep := 1 - (v_fc -> 'marginal' ->> 'revenue')::numeric;
    v_hours_day := (v_fc ->> 'hours_per_day')::numeric;
    v_year_end := make_date(v_fc_year, 12, 31);
    select e into v_cur_month
    from jsonb_array_elements(coalesce(v_fc -> 'months', '[]'::jsonb)) e
    where e ->> 'month' = to_char(v_today, 'YYYY-MM') and e ->> 'status' = 'projected'
    limit 1;
    if v_nyf is not null then
      v_billed_m := (v_nyf ->> 'revenue_eur')::numeric / 12;
      v_tax_m := (v_nyf ->> 'to_pay')::numeric / 12;
      v_costs_m := coalesce((v_nyf ->> 'costs_eur')::numeric, 0) / 12;
      v_net_m := v_billed_m - v_tax_m - v_costs_m;
      v_hours_m := (v_nyf ->> 'hours')::numeric / 12;
      v_left_now := v_net_m - v_living_avg;
      v_left_budget := v_net_m - v_living_budget;
      if v_target is not null then
        v_short_now := greatest(v_target - v_left_now, 0);
        v_short_budget := greatest(v_target - v_left_budget, 0);
      end if;
      -- What one more unit of the invoice currency an hour leaves a month, after tax at the marginal rate.
      v_per_unit := v_hours_m * v_keep * v_fx;
      if v_per_unit > 0 and v_rate is not null and v_target is not null then
        v_rate_budget := v_rate + v_short_budget / v_per_unit;
        v_rate_now := v_rate + v_short_now / v_per_unit;
      end if;
      if coalesce(v_structure, 'eenmanszaak') = 'eenmanszaak' then
        select ((select (e ->> 'net_to_you_eur')::numeric from jsonb_array_elements(v_ny -> 'structures' -> 'results') e where e ->> 'label' = 'bv_payout')
              - (select (e ->> 'net_to_you_eur')::numeric from jsonb_array_elements(v_ny -> 'structures' -> 'results') e where e ->> 'label' = 'eenmanszaak')) / 12
          into v_bv_m;
      end if;
    end if;
    select min(coalesce(i.period_start, i.issued_date)) into v_rate_since
    from invoices i
    where i.user_id = v_user and i.voided_at is null and i.duplicate_of is null and i.unit_rate = v_rate and i.currency = v_rate_cur
      and not exists (
        select 1 from invoices j
        where j.user_id = v_user and j.voided_at is null and j.duplicate_of is null and j.unit_rate is distinct from v_rate
          and coalesce(j.period_start, j.issued_date) > coalesce(i.period_start, i.issued_date));
    -- If the work stopped at the end of the forecast year: what is left after that year's tax.
    v_pot := v_hold + coalesce((v_fc -> 'remaining' ->> 'revenue_eur')::numeric, 0)
             - coalesce((v_fc -> 'year_end' ->> 'to_pay')::numeric, v_tax);
  end if;

  -- Hours, the review rhythm and the alternatives.
  select max(e.entry_date), coalesce(sum(e.minutes) filter (where e.entry_date >= v_month), 0)
    into v_hours_last, v_minutes_month
  from dt_time_entries e
  where e.user_id = v_user and e.removed_at is null;

  select s.as_of, s.total into v_snap_date, v_snap_total
  from nx_net_worth_snapshots s
  where s.user_id = v_user
  order by s.as_of desc
  limit 1;
  if v_weekly ? 'weekday' then
    -- review.weekly counts weekdays from 1 for Sunday, as iOS does.
    v_review_next := v_today + ((((v_weekly ->> 'weekday')::integer - 1) - extract(dow from v_today)::integer + 7) % 7);
  end if;

  select max(c.month) into v_close_last from nx_month_closes c where c.user_id = v_user;
  v_prev_closed := exists (select 1 from nx_month_closes c where c.user_id = v_user and c.month = v_prev_month);

  select count(*), count(*) filter (where q.tier = 'HOT') into v_roles, v_roles_hot from rec_roles q where q.user_id = v_user;
  select count(*) filter (where q.status = 'sent'), count(*) filter (where q.status = 'drafted')
    into v_apps_sent, v_apps_drafted
  from rec_applications q
  where q.user_id = v_user;

  -- Recurring charges still running.
  select coalesce(jsonb_agg(jsonb_build_object('key', q.key, 'label', q.label, 'category', q.category, 'cadence', q.cadence,
           'amount', q.amount, 'per_year', q.per_year, 'next_due', q.next_due, 'last_charge', q.last_charge,
           'call', q.call, 'proposed_call', q.proposed_call, 'overdue', coalesce(q.next_due < v_today, false))
           order by q.amount desc nulls last, q.label), '[]'::jsonb),
         coalesce(sum(q.per_year), 0), count(*)
    into v_recurring, v_recurring_year, v_recurring_count
  from nx_recurring q
  where q.user_id = v_user and (q.ends_on is null or q.ends_on >= v_today);

  select jsonb_build_object('id', c.id, 'client', c.client, 'start_date', c.start_date, 'end_date', c.end_date)
    into v_contract
  from contracts c
  where c.user_id = v_user and c.status = 'active'
  order by c.created_at desc
  limit 1;

  -- This year's invoices, oldest first.
  select coalesce(jsonb_agg(jsonb_build_object('number', i.invoice_number, 'period', coalesce(i.period_start, i.issued_date),
           'issued', i.issued_date, 'paid', i.paid_date, 'due', coalesce(i.expected_cash_date, i.due_date), 'hours', i.hours,
           'amount', i.amount, 'currency', i.currency, 'amount_eur', i.amount_eur, 'status', i.status,
           'lag_days', i.paid_date - i.issued_date, 'late_days', i.paid_date - i.due_date)
           order by coalesce(i.period_start, i.issued_date), i.invoice_number), '[]'::jsonb),
         min(i.amount_eur / nullif(i.hours, 0)), max(i.amount_eur / nullif(i.hours, 0))
    into v_invoices, v_eur_hour_min, v_eur_hour_max
  from invoices i
  where i.user_id = v_user and i.voided_at is null and i.duplicate_of is null
    and coalesce(i.review_state, 'confirmed') = 'confirmed'
    and coalesce(i.period_start, i.issued_date) >= make_date(v_year, 1, 1);

  -- Until the next client payment: what leaves the day to day accounts, day by day.
  select min(coalesce(i.expected_cash_date, i.due_date)) into v_horizon
  from invoices i
  where i.user_id = v_user and i.voided_at is null and i.duplicate_of is null and i.status <> 'paid'
    and coalesce(i.review_state, 'confirmed') = 'confirmed'
    and coalesce(i.expected_cash_date, i.due_date) >= v_today;
  if v_horizon is null and v_fc is not null then
    select min((e ->> 'payment_date')::date) into v_horizon
    from jsonb_array_elements(coalesce(v_fc -> 'months', '[]'::jsonb)) e
    where (e ->> 'payment_date')::date >= v_today;
  end if;
  if v_horizon is not null and v_spendable is not null then
    select coalesce(sum((e ->> 'balance')::numeric), 0) into v_start
    from jsonb_array_elements(v_money -> 'accounts') e
    where e ->> 'kind' = any(v_spendable);

    with ev as (
      select g::date as day, q.label, q.amount, q.call, q.proposed_call
      from nx_recurring q
      cross join lateral generate_series(q.next_due::timestamp, v_horizon::timestamp,
        case q.cadence when 'weekly' then interval '7 days' when 'monthly' then interval '1 month'
                       when 'quarterly' then interval '3 months' else interval '1 year' end) g
      where q.user_id = v_user and q.amount is not null and q.next_due is not null
        and q.next_due >= v_today and q.next_due <= v_horizon
        and q.cadence in ('weekly', 'monthly', 'quarterly', 'yearly')
        and (q.ends_on is null or q.ends_on >= g::date)
    ), land as (
      select coalesce(i.expected_cash_date, i.due_date) as day, i.invoice_number as label,
             coalesce(i.amount_eur, i.amount * i.fx_rate_eur, case when i.currency = 'EUR' then i.amount end) as amount
      from invoices i
      where i.user_id = v_user and i.voided_at is null and i.duplicate_of is null and i.status <> 'paid'
        and coalesce(i.review_state, 'confirmed') = 'confirmed'
        and coalesce(i.expected_cash_date, i.due_date) between v_today and v_horizon
    ), lines as (
      select e.day, -e.amount as amount, jsonb_build_object('label', e.label, 'amount', -e.amount, 'call', e.call, 'proposed_call', e.proposed_call) as item from ev e
      union all
      select l.day, l.amount, jsonb_build_object('label', l.label, 'amount', l.amount, 'payment', true) from land l where l.amount is not null
    ), days as (
      select x.day, sum(x.amount) as net, jsonb_agg(x.item order by x.amount) as items
      from lines x
      group by x.day
    ), run as (
      select d.day, d.items, v_start + sum(d.net) over (order by d.day) as balance
      from days d
    )
    select coalesce(jsonb_agg(jsonb_build_object('date', q.day, 'items', q.items, 'balance', round(q.balance, 2)) order by q.day), '[]'::jsonb),
           min(q.day) filter (where q.balance < 0),
           min(q.balance)
      into v_calendar, v_first_negative, v_low
    from run q;
    if v_low is not null then
      select (e ->> 'date')::date into v_low_date
      from jsonb_array_elements(v_calendar) e
      where (e ->> 'balance')::numeric = round(v_low, 2)
      order by (e ->> 'date')::date
      limit 1;
    end if;
  end if;

  return jsonb_build_object(
    'as_of', v_today,
    'data_through', v_through,
    'currency', v_base,
    'settings', jsonb_build_object(
      'phone_items', v_phone_items, 'snapshot_max_age_days', v_snapshot_days, 'average_months', v_avg_months,
      'window_from', v_win_from, 'window_to', (v_month - 1), 'web_url', v_web_url, 'weekly', v_weekly),
    'hold', jsonb_build_object(
      'cash', round(v_cash, 2), 'receivable', round(v_recv, 2), 'investments', round(v_inv, 2),
      'hold', round(v_hold, 2), 'tax', round(v_tax, 2), 'yours', round(v_yours, 2),
      'safe_to_spend', round(v_safe, 2), 'fixed_left', round(v_fixed_left, 2),
      'tax_label', v_money ->> 'tax_reserve_label', 'tax_computed_at', v_money -> 'tax_computed_at',
      'accounts', v_money -> 'accounts', 'receivables', v_recv_rows,
      'investment_rows', v_inv_rows, 'investments_missing', v_inv_missing,
      'invest_year', round(v_invest_year, 2)),
    'month', case when v_net_m is null then null else jsonb_build_object(
      'year', (v_ny ->> 'year')::integer, 'indicative', coalesce((v_ny ->> 'indicative')::boolean, true),
      'billed', round(v_billed_m, 2), 'tax', round(v_tax_m, 2), 'business', round(v_costs_m, 2), 'net', round(v_net_m, 2),
      'hours', round(v_hours_m, 2), 'target', v_target,
      'living_now', round(v_living_avg, 2), 'living_budget', round(v_living_budget, 2),
      'left_now', round(v_left_now, 2), 'left_budget', round(v_left_budget, 2),
      'short_now', round(v_short_now, 2), 'short_budget', round(v_short_budget, 2)) end,
    'spend', jsonb_build_object(
      'living_avg', round(v_living_avg, 2), 'living_budget', round(v_living_budget, 2),
      'discretionary_avg', round(v_disc_avg, 2), 'discretionary_budget', round(v_disc_budget, 2),
      'month_to_date', round(v_mtd, 2), 'month_landing', round(v_mtd + v_fixed_left, 2),
      'classes', v_classes, 'categories', v_categories,
      'rules_since', v_rules_since, 'day_since', round(v_day_since, 2), 'day_before', round(v_day_before, 2),
      'day_before_month', v_prev_from, 'rule_safe', v_rule_safe),
    'invest', jsonb_build_object('target', v_target, 'month', round(v_invest_month, 2), 'year', round(v_invest_year, 2)),
    'assignment', case when v_fc is null then null else jsonb_build_object(
      'forecast_year', v_fc_year, 'computed_at', v_fc_at, 'year_end', v_year_end,
      'rate', v_rate, 'currency', v_rate_cur, 'fx', v_fx, 'eur_per_hour', v_eur_hour, 'rate_since', v_rate_since,
      'eur_per_hour_min', round(v_eur_hour_min, 2), 'eur_per_hour_max', round(v_eur_hour_max, 2),
      'keep', v_keep, 'hours_per_day', v_hours_day, 'per_unit', round(v_per_unit, 2),
      'rate_budget', round(v_rate_budget, 2), 'rate_now', round(v_rate_now, 2),
      'lever_spend', round(greatest(v_living_avg - v_living_budget, 0), 2),
      'lever_day', round(v_hours_day * v_eur_hour * v_keep, 2), 'lever_bv', round(v_bv_m, 2),
      'pot', round(v_pot, 2),
      'runway_now', round(v_pot / nullif(v_living_avg, 0), 1), 'runway_budget', round(v_pot / nullif(v_living_budget, 0), 1),
      'contract', v_contract, 'current_month', v_cur_month,
      'income_target', v_income_target, 'income_date', v_income_date,
      'roles', v_roles, 'roles_hot', v_roles_hot, 'applications_sent', v_apps_sent, 'applications_drafted', v_apps_drafted,
      'invoices', v_invoices) end,
    'tax', case when v_fc is null then null else jsonb_build_object(
      'year', v_fc_year, 'computed_at', v_fc_at, 'reserve', round(v_tax, 2),
      'to_date', v_fc -> 'to_date', 'year_end', v_fc -> 'year_end', 'billed', (v_fc -> 'billed') - 'invoices',
      'remaining', v_fc -> 'remaining', 'timeline', v_fc -> 'timeline',
      'invoice_count', case jsonb_typeof(v_fc -> 'billed' -> 'invoices')
                         when 'array' then jsonb_array_length(v_fc -> 'billed' -> 'invoices')
                         when 'number' then (v_fc -> 'billed' ->> 'invoices')::integer end,
      'next_year', v_nyf, 'next_year_structures', v_ny -> 'structures' -> 'results',
      'next_year_number', (v_ny ->> 'year')::integer) end,
    'hours', jsonb_build_object('last', v_hours_last, 'minutes_month', v_minutes_month),
    'review', jsonb_build_object(
      'snapshot_date', v_snap_date, 'snapshot_total', v_snap_total, 'next', v_review_next,
      'close_last', v_close_last, 'previous_month', v_prev_month, 'previous_closed', v_prev_closed),
    'recurring', jsonb_build_object('rows', v_recurring, 'per_year', round(v_recurring_year, 2), 'count', v_recurring_count),
    'calendar', case when v_calendar is null then null else jsonb_build_object(
      'start', round(v_start, 2), 'until', v_horizon, 'days', v_calendar,
      'first_negative', v_first_negative, 'low', round(v_low, 2), 'low_date', v_low_date) end);
end $function$;

-- 4. The wording for the phone: one number, one answer, one action a screen.
create or replace function public.nx_glance_view(f jsonb)
returns jsonb
language plpgsql
stable
set search_path = public
as $function$
declare
  v_today date := (f ->> 'as_of')::date;
  v_month date := date_trunc('month', (f ->> 'as_of')::date)::date;
  h jsonb := f -> 'hold';
  m jsonb := nullif(f -> 'month', 'null'::jsonb);
  s jsonb := f -> 'spend';
  a jsonb := nullif(f -> 'assignment', 'null'::jsonb);
  rv jsonb := f -> 'review';
  st jsonb := f -> 'settings';
  v_items jsonb := '[]'::jsonb;
  v_better jsonb := '[]'::jsonb;
  v_next jsonb;
  e jsonb;
  v_safe numeric := (h ->> 'safe_to_spend')::numeric;
  v_yours numeric := (h ->> 'yours')::numeric;
  v_hold numeric := (h ->> 'hold')::numeric;
  v_tax numeric := (h ->> 'tax')::numeric;
  v_rule text := rtrim(s ->> 'rule_safe', '. ');
  v_living numeric := (s ->> 'living_avg')::numeric;
  v_budget numeric := (s ->> 'living_budget')::numeric;
  v_disc numeric := (s ->> 'discretionary_avg')::numeric;
  v_disc_budget numeric := (s ->> 'discretionary_budget')::numeric;
  v_mtd numeric := (s ->> 'month_to_date')::numeric;
  v_landing numeric := (s ->> 'month_landing')::numeric;
  v_target numeric := (f -> 'invest' ->> 'target')::numeric;
  v_invested numeric := (f -> 'invest' ->> 'month')::numeric;
  v_window text;
  v_cur jsonb := nullif(f -> 'assignment' -> 'current_month', 'null'::jsonb);
  v_snap date := (rv ->> 'snapshot_date')::date;
  v_prev date := (rv ->> 'previous_month')::date;
  v_short_now numeric := (m ->> 'short_now')::numeric;
  v_short_budget numeric := (m ->> 'short_budget')::numeric;
  v_left_now numeric := (m ->> 'left_now')::numeric;
  v_left_budget numeric := (m ->> 'left_budget')::numeric;
  v_end date := (a -> 'contract' ->> 'end_date')::date;
  v_tiles jsonb := '[]'::jsonb;
  v_answer text; v_reason text;
  v_month_view jsonb; v_assignment jsonb;
begin
  v_window := to_char((st ->> 'window_from')::date, 'FMMonth')
    || case when (st ->> 'average_months')::integer > 1 then ' to ' || to_char((st ->> 'window_to')::date, 'FMMonth') else '' end;

  -- Slipping, in a fixed order; a row is only here while it is off your own plan or rule.
  if v_safe < 0 then
    v_items := v_items || jsonb_build_object('key', 'safe_to_spend', 'title', 'Safe to spend', 'now', nx_fmt_eur(v_safe),
      'short', case when v_rule is not null then 'Your rule: ' || v_rule || '.' else 'Cash less tax and the fixed costs still due.' end,
      'detail', 'Cash ' || nx_fmt_eur((h ->> 'cash')::numeric) || ', tax ' || nx_fmt_eur(v_tax) || ', fixed costs still due '
        || nx_fmt_eur((h ->> 'fixed_left')::numeric) || '.' || case when v_rule is not null then ' Your rule: ' || v_rule || '.' else '' end);
  end if;
  if v_disc_budget > 0 and v_disc > v_disc_budget then
    v_items := v_items || jsonb_build_object('key', 'discretionary', 'title', 'Discretionary spending',
      'now', round(v_disc / v_disc_budget * 100) || '% of budget',
      'short', nx_fmt_eur(v_disc) || ' a month against ' || nx_fmt_eur(v_disc_budget) || '.',
      'detail', nx_fmt_eur(v_disc) || ' a month against ' || nx_fmt_eur(v_disc_budget) || ', average of ' || v_window || '.');
  end if;
  if v_target > 0 and v_invested < v_target then
    v_items := v_items || jsonb_build_object('key', 'investing', 'title', 'Investing',
      'now', round(v_invested / v_target * 100) || '% of target',
      'short', nx_fmt_eur(v_invested) || ' of ' || nx_fmt_eur(v_target) || ' in ' || to_char(v_month, 'FMMonth') || '.',
      'detail', nx_fmt_eur(v_invested) || ' moved in ' || to_char(v_month, 'FMMonth') || ' against a ' || nx_fmt_eur(v_target) || ' target.');
  end if;
  if v_budget > 0 and v_living > v_budget then
    v_items := v_items || jsonb_build_object('key', 'living', 'title', 'Living costs',
      'now', round(v_living / v_budget * 100) || '% of budget',
      'short', nx_fmt_eur(v_living) || ' a month against ' || nx_fmt_eur(v_budget) || '.',
      'detail', nx_fmt_eur(v_living) || ' a month against ' || nx_fmt_eur(v_budget) || ', average of ' || v_window || '.');
  end if;
  if v_budget > 0 and v_landing > v_budget then
    v_items := v_items || jsonb_build_object('key', 'month', 'title', to_char(v_month, 'FMMonth'),
      'now', round(v_landing / v_budget * 100) || '% of budget by month end',
      'short', nx_fmt_eur(v_mtd) || ' spent, ' || nx_fmt_eur((h ->> 'fixed_left')::numeric) || ' of fixed costs still to leave.',
      'detail', nx_fmt_eur(v_mtd) || ' spent so far. Fixed costs of ' || nx_fmt_eur((h ->> 'fixed_left')::numeric)
        || ' still leave this month, against a budget of ' || nx_fmt_eur(v_budget) || '.');
  end if;
  if v_cur is not null and (v_cur ->> 'hours')::numeric > 0 and (f -> 'hours' ->> 'minutes_month')::numeric = 0 then
    v_items := v_items || jsonb_build_object('key', 'hours', 'title', 'Hours', 'now', '0 logged',
      'short', 'Invoice planned ' || nx_fmt_day((v_cur ->> 'invoice_date')::date) || ', ' || nx_fmt_num((v_cur ->> 'hours')::numeric) || ' hours.',
      'detail', case when f -> 'hours' ->> 'last' is null then 'Nothing logged yet.'
                     else 'Nothing logged since ' || to_char((f -> 'hours' ->> 'last')::date, 'FMDD Mon') || '.' end
        || ' Invoice planned ' || nx_fmt_day((v_cur ->> 'invoice_date')::date) || ', ' || nx_fmt_num((v_cur ->> 'hours')::numeric) || ' hours.',
      'action', 'Log ' || to_char(v_month, 'FMMonth') || '''s hours', 'link', 'time', 'due', v_cur ->> 'invoice_date');
  end if;
  if jsonb_array_length(h -> 'investments_missing') > 0 then
    v_items := v_items || jsonb_build_object('key', 'not_counted', 'title', 'Not counted',
      'now', jsonb_array_length(h -> 'investments_missing') || case when jsonb_array_length(h -> 'investments_missing') = 1 then ' account' else ' accounts' end,
      'short', 'No exchange rate yet.',
      'detail', 'No exchange rate yet for ' || (select string_agg(x, ', ') from jsonb_array_elements_text(h -> 'investments_missing') x) || '.');
  end if;
  if v_snap is null or v_today - v_snap > (st ->> 'snapshot_max_age_days')::integer then
    v_items := v_items || jsonb_build_object('key', 'snapshot', 'title', 'Net worth snapshot',
      'now', case when v_snap is null then 'none yet' else 'last ' || to_char(v_snap, 'FMDD Mon') end,
      'short', 'The Sunday review saves one.',
      'detail', 'The Sunday review saves one, so you can see what moved.',
      'action', 'Do the Sunday review', 'link', 'review', 'due', rv ->> 'next');
  end if;
  if not (rv ->> 'previous_closed')::boolean then
    v_items := v_items || jsonb_build_object('key', 'month_close', 'title', 'Month close',
      'now', to_char(v_prev, 'FMMonth') || ' open',
      'short', case when rv ->> 'close_last' is null then 'No month closed yet.'
                    else 'Last closed: ' || to_char((rv ->> 'close_last')::date, 'FMMonth') || '.' end,
      'detail', case when rv ->> 'close_last' is null then 'No month closed yet.'
                     else 'Last closed: ' || to_char((rv ->> 'close_last')::date, 'FMMonth') || '.' end,
      'action', 'Close ' || to_char(v_prev, 'FMMonth'), 'link', 'close');
  end if;
  if a is not null and (a ->> 'applications_sent')::integer = 0 then
    v_items := v_items || jsonb_build_object('key', 'alternatives', 'title', 'Next assignment', 'now', '0 applications sent',
      'short', (a ->> 'roles') || ' roles tracked, ' || (a ->> 'roles_hot') || ' hot.',
      'detail', (a ->> 'roles') || ' roles tracked, ' || (a ->> 'roles_hot') || ' hot, ' || (a ->> 'applications_drafted') || ' applications drafted, none sent.');
  end if;
  for e in select x from jsonb_array_elements(f -> 'recurring' -> 'rows') x
           where x ->> 'call' = 'cancel' and (x ->> 'next_due')::date >= v_today
           order by (x ->> 'next_due')::date
  loop
    v_items := v_items || jsonb_build_object('key', 'cancel:' || (e ->> 'key'), 'title', e ->> 'label',
      'now', nx_fmt_eur((e ->> 'amount')::numeric, 2),
      'short', 'Your call was cancel. Renews ' || nx_fmt_day((e ->> 'next_due')::date) || '.',
      'detail', 'Your call was cancel. Renews ' || nx_fmt_day((e ->> 'next_due')::date) || '.',
      'action', 'Cancel ' || (e ->> 'label'), 'link', 'purchases', 'due', e ->> 'next_due');
  end loop;

  if (s ->> 'day_since')::numeric < (s ->> 'day_before')::numeric then
    v_better := v_better || jsonb_build_object('key', 'purchases', 'title', 'Purchases',
      'detail', nx_fmt_eur((s ->> 'day_since')::numeric) || ' a day since ' || to_char((s ->> 'rules_since')::date, 'FMDD Mon') || '. '
        || to_char((s ->> 'day_before_month')::date, 'FMMonth') || ' was ' || nx_fmt_eur((s ->> 'day_before')::numeric) || ' a day.');
  end if;

  -- The next action: the open row with the nearest date, then the first without one.
  select x into v_next
  from jsonb_array_elements(v_items) with ordinality as t(x, n)
  where x ? 'action'
  order by (x ->> 'due')::date nulls last, n
  limit 1;

  if m is not null then
    v_month_view := jsonb_build_object(
      'title', 'An average month in ' || (m ->> 'year'),
      'billed', m -> 'billed', 'tax', m -> 'tax', 'business', m -> 'business', 'target', m -> 'target',
      'now', jsonb_build_object('living', m -> 'living_now', 'left', m -> 'left_now', 'short', m -> 'short_now',
        'line', case when v_target is null then null
                     when v_left_now < 0 then nx_fmt_eur(-v_left_now) || ' short of your living costs alone.'
                     when v_short_now > 0 then nx_fmt_eur(v_short_now) || ' short of your ' || nx_fmt_eur(v_target) || ' target.'
                     else 'Covers your ' || nx_fmt_eur(v_target) || ' target.' end),
      'budget', jsonb_build_object('living', m -> 'living_budget', 'left', m -> 'left_budget', 'short', m -> 'short_budget',
        'line', case when v_target is null then null
                     when v_left_budget < 0 then nx_fmt_eur(-v_left_budget) || ' short of your living costs alone.'
                     when v_short_budget > 0 then nx_fmt_eur(v_short_budget) || ' short of your ' || nx_fmt_eur(v_target) || ' target.'
                     else 'Covers your ' || nx_fmt_eur(v_target) || ' target.' end));
  end if;

  if a is not null and m is not null and v_target is not null then
    if v_short_budget > 0 then
      v_answer := 'Yes';
      v_reason := 'On these terms your plan is short ' || nx_fmt_eur(v_short_budget) || ' a month, even on budget.';
    elsif v_short_now > 0 then
      v_answer := 'No';
      v_reason := 'On budget the plan closes at this rate. Spending is the gap: ' || nx_fmt_eur(v_short_now) || ' a month.';
    else
      v_answer := 'No';
      v_reason := 'The plan closes at this rate.';
    end if;
    v_tiles := v_tiles || jsonb_build_object('value', (a ->> 'currency') || ' ' || nx_fmt_num((a ->> 'rate')::numeric),
      'label', 'now' || coalesce(', since ' || to_char((a ->> 'rate_since')::date, 'FMMonth')
        || case when extract(year from (a ->> 'rate_since')::date) <> extract(year from v_today) then to_char((a ->> 'rate_since')::date, ' YYYY') else '' end, ''));
    if v_short_budget > 0 and a ->> 'rate_budget' is not null then
      v_tiles := v_tiles || jsonb_build_object('value', (a ->> 'currency') || ' ' || nx_fmt_num(ceil((a ->> 'rate_budget')::numeric)),
        'label', 'closes the plan on budget');
    else
      v_tiles := v_tiles || jsonb_build_object('value', nx_fmt_eur(v_left_budget - v_target), 'label', 'a month above target on budget');
    end if;
    if a ->> 'runway_now' is not null then
      v_tiles := v_tiles || jsonb_build_object('value', to_char((a ->> 'runway_now')::numeric, 'FM9990.0') || ' mo',
        'label', 'runway if it ended ' || to_char((a ->> 'year_end')::date, 'FMDD Mon'));
    end if;
    v_assignment := jsonb_build_object(
      'question', 'Renegotiate for ' || (m ->> 'year') || '?', 'answer', v_answer, 'reason', v_reason, 'tiles', v_tiles,
      'end_date', v_end,
      'end_line', case when v_end is null then null
                       when v_end >= v_today then 'Ends ' || nx_fmt_day(v_end) || ', in ' || (v_end - v_today) || ' days.'
                       else 'Ended ' || nx_fmt_day(v_end) || '.' end);
  end if;

  return jsonb_build_object(
    'version', 1,
    'as_of', f -> 'as_of',
    'data_through', f -> 'data_through',
    'currency', f -> 'currency',
    'web_url', st -> 'web_url',
    'today', jsonb_build_object(
      'hold', h -> 'hold', 'tax', h -> 'tax', 'yours', h -> 'yours',
      'caption', case when jsonb_array_length(h -> 'investments_missing') > 0 then 'yours, not all counted' else 'yours, after tax' end,
      'slices', jsonb_build_array(
        jsonb_build_object('key', 'tax', 'label', coalesce(h ->> 'tax_label', 'Tax to set aside'), 'amount', least(v_tax, greatest(v_hold, 0))),
        jsonb_build_object('key', 'yours', 'label', 'Yours', 'amount', greatest(v_yours, 0))),
      'next', v_next,
      'slipping_count', jsonb_array_length(v_items)),
    'slipping', jsonb_build_object('items', v_items, 'shown', st -> 'phone_items', 'better', v_better),
    'month', v_month_view,
    'assignment', v_assignment,
    'review', jsonb_build_object(
      'weekly', st -> 'weekly', 'next', rv -> 'next', 'snapshot_date', rv -> 'snapshot_date',
      'moved', case when rv ->> 'snapshot_total' is null then null else round(v_yours - (rv ->> 'snapshot_total')::numeric, 2) end,
      'snapshot', jsonb_build_object(
        'cash', round((h ->> 'cash')::numeric + (h ->> 'receivable')::numeric, 2),
        'investments', h -> 'investments', 'liabilities', h -> 'tax', 'total', h -> 'yours', 'currency', f -> 'currency')));
end $function$;

create or replace function public.nx_glance()
returns jsonb
language sql
stable security definer
set search_path = public
as $function$
  select public.nx_glance_view(public.nx_glance_facts())
$function$;

create or replace function public.nx_look()
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $function$
declare
  f jsonb := public.nx_glance_facts();
begin
  return jsonb_build_object('version', 1, 'glance', public.nx_glance_view(f), 'facts', f);
end $function$;

-- 5. The one write: the end date of the running assignment, entered by you.
create or replace function public.nx_set_assignment_end(p_end date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_client text; v_rate numeric; v_currency text;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  select c.id into v_id from contracts c where c.user_id = v_user and c.status = 'active' order by c.created_at desc limit 1;
  if v_id is not null then
    update contracts set end_date = p_end where id = v_id;
    return jsonb_build_object('id', v_id, 'end_date', p_end);
  end if;
  if p_end is null then return jsonb_build_object('id', null, 'end_date', null); end if;
  -- No contract on file yet: the newest invoice names the client and the rate.
  select i.client, i.unit_rate, i.currency into v_client, v_rate, v_currency
  from invoices i
  where i.user_id = v_user and i.voided_at is null and i.duplicate_of is null and i.unit_rate is not null
  order by coalesce(i.period_start, i.issued_date) desc
  limit 1;
  if v_client is null then raise exception 'no invoice to read the client and the rate from'; end if;
  insert into contracts (user_id, client, rate, currency, rate_type, start_date, end_date, status)
  values (v_user, v_client, v_rate, v_currency, 'hourly',
          (select min(coalesce(j.period_start, j.issued_date)) from invoices j
           where j.user_id = v_user and j.voided_at is null and j.duplicate_of is null and j.client = v_client),
          p_end, 'active')
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'end_date', p_end);
end $function$;

-- 6. Who may call what: the app calls nx_glance, nx_look and nx_set_assignment_end; the rest is internal.
revoke all on function public.nx_fx_latest(text) from public, anon, authenticated;
revoke all on function public.nx_glance_facts() from public, anon, authenticated;
revoke all on function public.nx_glance_view(jsonb) from public, anon, authenticated;
revoke all on function public.nx_glance() from public, anon;
revoke all on function public.nx_look() from public, anon;
revoke all on function public.nx_set_assignment_end(date) from public, anon;
grant execute on function public.nx_glance() to authenticated;
grant execute on function public.nx_look() to authenticated;
grant execute on function public.nx_set_assignment_end(date) to authenticated;

notify pgrst, 'reload schema';
