-- Tags on bank lines, built into what Nexus already has (28 Nov 2026).
--
-- One rule engine: nx_category_rules can now also set tags ("Always for this shop" in the
-- Sunday review makes one rule for category and tags). One list of dimensions in app_config,
-- whose values come from where they already live: Serves from review.purpose_tags (the same
-- list the Buy check and the purchase review use), Project from dt_projects, Worth it from its
-- own short list. Business share is not a tag: it stays in expenses.business_use_pct, under the
-- business test. One new table, nx_line_tags. Spend and slippage per tag join the Slipping rows
-- of nx_glance, the effect of a correction joins its "better" rows, and the web look-through
-- gets the same figures under facts.tags. No new screen, push, streak or budget table.

-- 1. Rules can set tags. A tag-only rule leaves category and class empty; nx_classify skips it.
alter table public.nx_category_rules add column if not exists tags jsonb;
comment on column public.nx_category_rules.tags is 'Tags this rule sets on a line, one value per dimension of tags.dimensions: {"serves": "life", "project": "nexus"}. A rule with tags and no category sets only tags.';
alter table public.nx_category_rules alter column category drop not null;
alter table public.nx_category_rules alter column class drop not null;
alter table public.nx_category_rules drop constraint if exists nx_category_rules_sets_something;
alter table public.nx_category_rules add constraint nx_category_rules_sets_something check (
  (category is not null and class is not null)
  or (category is null and class is null and tags is not null and jsonb_typeof(tags) = 'object'));

create or replace function public.nx_classify(p_user uuid, p_fields jsonb)
returns table(rule_id uuid, category text, class text)
language sql
stable security definer
set search_path to 'public'
as $function$
  select r.id, r.category, r.class
  from nx_category_rules r
  where r.user_id = p_user and r.active and r.category is not null
    and (r.valid_from is null or nullif(p_fields ->> 'date', '') is null or (p_fields ->> 'date')::date >= r.valid_from)
    and (r.valid_to is null or nullif(p_fields ->> 'date', '') is null or (p_fields ->> 'date')::date <= r.valid_to)
    and not exists (
      select 1 from jsonb_each_text(r.match) as m(field, pattern)
      where not (coalesce(p_fields ->> m.field, '') ~* m.pattern
                 or regexp_replace(coalesce(p_fields ->> m.field, ''), '\s+', '', 'g') ~* m.pattern))
  order by r.priority
  limit 1
$function$;

-- 2. The dimensions, and the values each one takes, from where they already live.
insert into public.app_config (key, value, description) values
  ('tags.dimensions',
   '[{"key": "serves", "label": "Serves", "values_from": "review.purpose_tags", "buy_check_field": "purpose", "from_recurring": true},
     {"key": "project", "label": "Project", "values_from": "dt_projects"},
     {"key": "worth", "label": "Worth it", "values": ["need", "want", "regret"]}]',
   'Tag dimensions on bank lines. values_from: an app_config list (labels, stored as their slug) or dt_projects (project names, as their slug); values: a fixed list. buy_check_field: the nx_decisions column a Buy check fills it from. from_recurring: a line of a recurring charge takes the charge''s tag. Business share is not a tag: expenses.business_use_pct.'),
  ('tags.slip_tolerance_pct', '10', 'A tag value is slipping when its month lands this percent above its own average of budget.average_months months'),
  ('tags.slip_min_eur', '50', 'and at least this many euros above it, so small values do not fill the Slipping screen'),
  ('tags.extra_classes', '["business"]', 'Classes counted per tag beside budget.spend_classes, so Project shows business costs too'),
  ('tags.correction_then', 'I log a Buy check and wait {wait_hours} hours first', 'The then part of a proposed correction; {wait_hours} is purchase.considered_wait_hours')
on conflict (key) do nothing;

create or replace function public.nx_slug(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select trim(both '_' from regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '_', 'g')) $$;

create or replace function public.nx_tag_values(p_user uuid, p_dimension text)
returns table(value text, label text)
language sql
stable
set search_path = ''
as $$
  with d as (
    select x from jsonb_array_elements((select value::jsonb from public.app_config where key = 'tags.dimensions')) x
    where x ->> 'key' = p_dimension
  )
  select public.nx_slug(l), l from d, jsonb_array_elements_text(
      (select c.value::jsonb from public.app_config c where c.key = d.x ->> 'values_from')) l
  where d.x ->> 'values_from' like '%.%'
  union all
  select public.nx_slug(p.name), p.name from d, public.dt_projects p
  where d.x ->> 'values_from' = 'dt_projects' and p.user_id = p_user and p.archived_at is null
  union all
  select v, initcap(v) from d, jsonb_array_elements_text(d.x -> 'values') v
$$;

create or replace function public.nx_category_rules_validate()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare v_field text; v_pattern text; v_dim text; v_val text;
begin
  for v_field, v_pattern in select key, value from jsonb_each_text(new.match) loop
    if new.category is not null and v_field not in ('name', 'details', 'type', 'own') then
      raise exception 'rule field % is not one of name, details, type, own', v_field;
    end if;
    if new.category is null and v_field not in ('name', 'details', 'type', 'own', 'category', 'class', 'source', 'account', 'rail') then
      raise exception 'tag rule field % is not one of name, details, type, own, category, class, source, account, rail', v_field;
    end if;
    perform '' ~* v_pattern;
  end loop;
  if new.tags is not null then
    for v_dim, v_val in select key, value from jsonb_each_text(new.tags) loop
      if not exists (select 1 from public.nx_tag_values(new.user_id, v_dim) t where t.value = v_val) then
        raise exception 'tag %=% is not a value of tags.dimensions', v_dim, v_val;
      end if;
    end loop;
  end if;
  return new;
end $function$;

-- 3. Tags on a line. One value per dimension; hand beats a Buy check, a recurring charge and a rule.
create table if not exists public.nx_line_tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  txn_id uuid not null references public.nx_transactions(id) on delete cascade,
  dimension text not null,
  value text not null,
  source text not null check (source in ('hand', 'buy_check', 'recurring', 'rule')),
  rule_id uuid references public.nx_category_rules(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (txn_id, dimension)
);
create index if not exists nx_line_tags_user_dim on public.nx_line_tags (user_id, dimension, value);
comment on table public.nx_line_tags is 'Tags on a bank line, one value per dimension of tags.dimensions. source: hand (you), buy_check (the Buy check behind the line), recurring (the purchase review tag of its charge), rule (a nx_category_rules row with tags).';
alter table public.nx_line_tags enable row level security;
drop policy if exists own_rows on public.nx_line_tags;
create policy own_rows on public.nx_line_tags for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.nx_line_tags from anon;
grant select, insert, update, delete on public.nx_line_tags to authenticated;

-- 4. Tag one line from the Buy check, the recurring charge and the rules; hand tags stay.
create or replace function public.nx_tag_line(p_txn uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.nx_transactions;
  p record;
  v_fields jsonb;
  d jsonb;
  v_dim text; v_val text; v_src text; v_rule uuid;
  v_n integer := 0;
begin
  select * into t from public.nx_transactions where id = p_txn;
  if t.id is null then return 0; end if;
  if auth.uid() is not null and auth.uid() <> t.user_id then return 0; end if;
  select * into p from public.nx_parse_bank_line(t.source, t.description, t.payee, t.counterparty_iban);
  v_fields := jsonb_build_object('name', coalesce(t.merchant, ''), 'details', coalesce(p.details, ''), 'type', coalesce(p.tx_type, ''),
    'own', case when t.is_own_transfer then '1' else '0' end, 'category', coalesce(t.category, ''), 'class', coalesce(t.class, ''),
    'source', coalesce(t.source, ''), 'account', coalesce(t.account, ''), 'rail', coalesce(t.rail, ''), 'date', t.booked_on::text);

  delete from public.nx_line_tags where txn_id = p_txn and source <> 'hand';

  for d in select x from jsonb_array_elements((select value::jsonb from public.app_config where key = 'tags.dimensions')) x loop
    v_dim := d ->> 'key'; v_val := null; v_src := null; v_rule := null;
    continue when exists (select 1 from public.nx_line_tags h where h.txn_id = p_txn and h.dimension = v_dim);
    -- the Buy check behind the line
    if d ? 'buy_check_field' and t.decision_id is not null then
      execute format('select public.nx_slug(%I) from public.nx_decisions where id = $1', d ->> 'buy_check_field')
        into v_val using t.decision_id;
      if v_val = '' then v_val := null; end if;
      if v_val is not null then v_src := 'buy_check'; end if;
    end if;
    -- the purchase review tag of the recurring charge this line belongs to
    if v_val is null and (d ->> 'from_recurring')::boolean is true then
      select r.tag into v_val from public.nx_recurring r
      where r.user_id = t.user_id and r.tag is not null and r.tag <> 'cut'
        and split_part(r.key, '|', 1) = regexp_replace(lower(coalesce(t.merchant, '')), '[^a-z0-9]+', '', 'g')
      order by r.updated_at desc nulls last limit 1;
      if v_val is not null then v_src := 'recurring'; end if;
    end if;
    -- the first tag rule by priority that sets this dimension
    if v_val is null then
      select r.tags ->> v_dim, r.id into v_val, v_rule
      from public.nx_category_rules r
      where r.user_id = t.user_id and r.active and r.tags ? v_dim
        and (r.valid_from is null or t.booked_on >= r.valid_from)
        and (r.valid_to is null or t.booked_on <= r.valid_to)
        and not exists (
          select 1 from jsonb_each_text(r.match) as m(field, pattern)
          where not (coalesce(v_fields ->> m.field, '') ~* m.pattern
                     or regexp_replace(coalesce(v_fields ->> m.field, ''), '\s+', '', 'g') ~* m.pattern))
      order by r.priority, r.created_at limit 1;
      if v_val is not null then v_src := 'rule'; end if;
    end if;
    if v_val is not null then
      insert into public.nx_line_tags (user_id, txn_id, dimension, value, source, rule_id)
      values (t.user_id, p_txn, v_dim, v_val, v_src, v_rule);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

create or replace function public.nx_transactions_tag()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.nx_tag_line(new.id);
  return new;
end $$;

drop trigger if exists nx_transactions_tag on public.nx_transactions;
create trigger nx_transactions_tag after insert or update of category, class, merchant, decision_id on public.nx_transactions
  for each row execute function public.nx_transactions_tag();

-- A tag rule or a purchase review tag changed: re-tag your lines.
create or replace function public.nx_retag()
returns integer
language plpgsql
set search_path = ''
as $$
declare v_user uuid := auth.uid(); v_n integer := 0; t record;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  for t in select id from public.nx_transactions where user_id = v_user loop
    perform public.nx_tag_line(t.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- 5. Tag lines by hand (the line form on the phone, the review page on the web). A null value
--    hands the dimension back to the Buy check, the charge and the rules. p_always puts the tag
--    on the shop's own review rule (the one "Always for this shop" made for its category), or
--    makes a tag-only rule at review.rule_priority for a shop without one, and re-tags the shop's lines.
create or replace function public.nx_set_line_tags(p_txns uuid[], p_dimension text, p_value text, p_always boolean default false)
returns integer
language plpgsql
set search_path = ''
as $$
declare v_user uuid := auth.uid(); v_n integer; v_shop text; v_prio integer; v_rule uuid;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  if p_value is not null and not exists (select 1 from public.nx_tag_values(v_user, p_dimension) v where v.value = p_value) then
    raise exception 'tag %=% is not a value of tags.dimensions', p_dimension, p_value;
  end if;
  delete from public.nx_line_tags where user_id = v_user and txn_id = any(p_txns) and dimension = p_dimension;
  if p_value is null then
    perform public.nx_tag_line(x) from unnest(p_txns) x;
    return 0;
  end if;
  insert into public.nx_line_tags (user_id, txn_id, dimension, value, source)
  select v_user, t.id, p_dimension, p_value, 'hand' from public.nx_transactions t where t.user_id = v_user and t.id = any(p_txns);
  get diagnostics v_n = row_count;
  if p_always then
    -- Always for this shop: the tag joins the shop's own review rule, the one the Sunday review's
    -- "Always for this shop" made for its category; a shop without one gets a tag-only rule.
    select coalesce(merchant, payee) into v_shop from public.nx_transactions where user_id = v_user and id = p_txns[1];
    select value::integer into v_prio from public.app_config where key = 'review.rule_priority';
    if v_shop is not null and v_prio is not null then
      select r.id into v_rule from public.nx_category_rules r
      where r.user_id = v_user and r.active and r.origin = 'review'
        and (select count(*) from jsonb_object_keys(r.match)) = 1 and r.match ? 'name' and v_shop ~* (r.match ->> 'name')
      order by (r.category is not null) desc, r.created_at desc limit 1;
      if v_rule is not null then
        update public.nx_category_rules set tags = coalesce(tags, '{}'::jsonb) || jsonb_build_object(p_dimension, p_value) where id = v_rule;
      else
        insert into public.nx_category_rules (user_id, priority, match, category, class, tags, origin)
        values (v_user, v_prio, jsonb_build_object('name', '^' || regexp_replace(lower(v_shop), '([.^$*+?()\[\]{}|\\])', '\\\1', 'g')),
                null, null, jsonb_build_object(p_dimension, p_value), 'review');
      end if;
      perform public.nx_tag_line(t.id) from public.nx_transactions t
       where t.user_id = v_user and coalesce(t.merchant, t.payee) = v_shop and not (t.id = any(p_txns));
    end if;
  end if;
  return v_n;
end $$;

-- What the line form and the review page offer: each dimension with its values.
create or replace function public.nx_tag_choices()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', d.x ->> 'key', 'label', d.x ->> 'label',
           'values', (select coalesce(jsonb_agg(jsonb_build_object('value', v.value, 'label', v.label)), '[]'::jsonb)
                        from public.nx_tag_values(auth.uid(), d.x ->> 'key') v)) order by d.n), '[]'::jsonb)
  from jsonb_array_elements((select value::jsonb from public.app_config where key = 'tags.dimensions')) with ordinality as d(x, n)
$$;

-- 6. A correction is an ordinary if/then rule that knows the tag it corrects and its cue.
alter table public.nx_decisions
  add column if not exists tag_dimension text,
  add column if not exists tag_value text,
  add column if not exists cue text;
comment on column public.nx_decisions.tag_dimension is 'Rule: the tag dimension it corrects (tags.dimensions), so its effect shows on the Slipping screen';
comment on column public.nx_decisions.tag_value is 'Rule: the tag value it corrects';
comment on column public.nx_decisions.cue is 'Rule: the context that sets it off (shop, weekday, feeling), the if of an implementation intention';

-- 7. Spend and slippage per tag value, the proposal for each slipping value and the effect of
--    the corrections you took. Same window as nx_glance_facts (budget.average_months full months)
--    and, like living costs there, after refunds.
create or replace function public.nx_tag_facts()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
  v_month date := date_trunc('month', (now() at time zone 'Europe/Amsterdam'))::date;
  v_days_in numeric := extract(day from (date_trunc('month', (now() at time zone 'Europe/Amsterdam')) + interval '1 month - 1 day'));
  v_left numeric;
  v_avg_months integer; v_tol numeric; v_min numeric; v_wait text; v_then text; v_goal text;
  v_classes text[]; v_planned text[];
  v_dims jsonb; v_effects jsonb;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  v_left := v_days_in - extract(day from v_today);
  select value::integer into v_avg_months from public.app_config where key = 'budget.average_months';
  select value::numeric into v_tol from public.app_config where key = 'tags.slip_tolerance_pct';
  select value::numeric into v_min from public.app_config where key = 'tags.slip_min_eur';
  select value into v_wait from public.app_config where key = 'purchase.considered_wait_hours';
  select replace(value, '{wait_hours}', coalesce(v_wait, '')) into v_then from public.app_config where key = 'tags.correction_then';
  select value into v_goal from public.app_config where key = 'purchase.goal_name';
  select array(select jsonb_array_elements_text(value::jsonb)) into v_classes from public.app_config where key = 'budget.spend_classes';
  v_classes := v_classes || array(select jsonb_array_elements_text(coalesce((select value::jsonb from public.app_config where key = 'tags.extra_classes'), '[]'::jsonb)));
  select array(select jsonb_array_elements_text(value::jsonb)) into v_planned from public.app_config where key = 'budget.planned_classes';

  with dims as (
    select x ->> 'key' as key, x ->> 'label' as label, n as ord
    from jsonb_array_elements((select value::jsonb from public.app_config where key = 'tags.dimensions')) with ordinality as a(x, n)
  ),
  lines as (
    select t.id, t.booked_on, t.merchant, -t.amount as eur, t.class, t.decision_id
    from public.nx_transactions t
    where t.user_id = v_user and t.currency = 'EUR' and t.class = any(v_classes)
      and t.booked_on >= (v_month - make_interval(months => v_avg_months))::date
  ),
  tagged as (
    select d.key as dim, coalesce(lt.value, '') as value, l.*
    from dims d cross join lines l
    left join public.nx_line_tags lt on lt.txn_id = l.id and lt.dimension = d.key
  ),
  per as (
    select dim, value,
           round(coalesce(sum(eur) filter (where booked_on >= v_month), 0), 2) as mtd,
           round(coalesce(sum(eur) filter (where booked_on < v_month), 0) / nullif(v_avg_months, 0), 2) as avg,
           count(*) filter (where booked_on >= v_month and eur > 0) as lines
    from tagged group by 1, 2
  ),
  scored as (
    select per.*, round(mtd + coalesce(avg, 0) * v_left / v_days_in, 2) as landing,
           (value <> '' and avg > 0 and mtd + avg * v_left / v_days_in > avg * (1 + v_tol / 100)
             and mtd + avg * v_left / v_days_in - avg >= v_min) as slipping
    from per
  ),
  cue as (
    select s.dim, s.value,
           (select jsonb_build_object('merchant', m.merchant, 'weekday', m.wd, 'eur', m.eur)
              from (select tg.merchant, round(sum(tg.eur), 2) as eur, mode() within group (order by trim(to_char(tg.booked_on, 'FMDay'))) as wd
                    from tagged tg where tg.dim = s.dim and tg.value = s.value and tg.booked_on >= v_month and tg.class = any(v_planned)
                    group by tg.merchant order by 2 desc limit 1) m) as top,
           (select mode() within group (order by dd.urge)
              from tagged tg join public.nx_decisions dd on dd.id = tg.decision_id
             where tg.dim = s.dim and tg.value = s.value and dd.urge is not null and dd.urge <> 'planned') as urge
    from scored s where s.slipping
  )
  select coalesce(jsonb_agg(jsonb_build_object('key', d.key, 'label', d.label,
           'rows', (select coalesce(jsonb_agg(jsonb_build_object(
                      'value', nullif(s.value, ''),
                      'label', coalesce((select v.label from public.nx_tag_values(v_user, d.key) v where v.value = s.value), nullif(s.value, '')),
                      'mtd', s.mtd, 'avg', s.avg, 'landing', s.landing, 'slip', round(s.landing - coalesce(s.avg, 0), 2),
                      'slipping', s.slipping, 'lines', s.lines,
                      'proposal', case when s.slipping then jsonb_build_object(
                         'if', 'I am about to spend on ' || coalesce((select v.label from public.nx_tag_values(v_user, d.key) v where v.value = s.value), s.value)
                               || coalesce(' at ' || (c.top ->> 'merchant'), '') || coalesce(' on a ' || (c.top ->> 'weekday'), '')
                               || coalesce(' feeling ' || c.urge, ''),
                         'then', v_then,
                         'cue', concat_ws(', ', c.top ->> 'merchant', c.top ->> 'weekday', c.urge),
                         'eur_month', round(s.landing - s.avg, 2), 'goal', v_goal) end)
                    order by (s.value = ''), s.landing desc), '[]'::jsonb)
                    from scored s left join cue c on c.dim = s.dim and c.value = s.value
                    where s.dim = d.key)) order by d.ord), '[]'::jsonb)
    into v_dims
  from dims d;

  -- Corrections you took: a month in that tag before the rule, against a month at the pace since.
  select coalesce(jsonb_agg(e order by e.since desc), '[]'::jsonb) into v_effects from (
    select x.id, x.tag_dimension as dimension, x.tag_value as value, x.if_condition, x.then_action, x.cue, x.created_at::date as since,
      (select round(coalesce(sum(-t.amount), 0) / nullif(v_avg_months, 0), 2)
         from public.nx_line_tags lt join public.nx_transactions t on t.id = lt.txn_id
        where lt.user_id = v_user and lt.dimension = x.tag_dimension and lt.value = x.tag_value and t.class = any(v_classes)
          and t.booked_on >= (date_trunc('month', x.created_at)::date - make_interval(months => v_avg_months))::date
          and t.booked_on < date_trunc('month', x.created_at)::date) as before_month,
      (select round(coalesce(sum(-t.amount), 0) / greatest(v_today - x.created_at::date + 1, 1) * v_days_in, 2)
         from public.nx_line_tags lt join public.nx_transactions t on t.id = lt.txn_id
        where lt.user_id = v_user and lt.dimension = x.tag_dimension and lt.value = x.tag_value and t.class = any(v_classes)
          and t.booked_on >= x.created_at::date) as since_month
    from public.nx_decisions x
    where x.user_id = v_user and x.kind = 'rule' and x.active and x.tag_dimension is not null) e;

  return jsonb_build_object('average_months', v_avg_months, 'tolerance_pct', v_tol, 'dimensions', v_dims,
    'without_tag', (select coalesce(jsonb_object_agg(d.x ->> 'key', (select count(*) from public.nx_transactions t
                   where t.user_id = v_user and t.amount < 0 and t.class = any(v_planned) and t.booked_on >= v_month
                     and not exists (select 1 from public.nx_line_tags lt where lt.txn_id = t.id and lt.dimension = d.x ->> 'key'))), '{}'::jsonb)
                 from jsonb_array_elements((select value::jsonb from public.app_config where key = 'tags.dimensions')) as d(x)),
    'effects', v_effects);
end $$;

-- 8. One seam: nx_glance and nx_look add the tag rows to Slipping and the effects to "better",
--    in the same row shape the phone and the web already show.
create or replace function public.nx_glance_tags(g jsonb, t jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare v_items jsonb := coalesce(g #> '{slipping,items}', '[]'::jsonb); v_better jsonb := coalesce(g #> '{slipping,better}', '[]'::jsonb);
  d jsonb; r jsonb; e jsonb;
begin
  for d in select x from jsonb_array_elements(coalesce(t -> 'dimensions', '[]'::jsonb)) x loop
    for r in select y from jsonb_array_elements(d -> 'rows') y where (y ->> 'slipping')::boolean loop
      v_items := v_items || jsonb_build_object(
        'key', 'tag:' || (d ->> 'key') || ':' || (r ->> 'value'),
        'title', (d ->> 'label') || ': ' || (r ->> 'label'),
        'now', public.nx_fmt_eur((r ->> 'landing')::numeric) || ' by month end',
        'short', 'Your average is ' || public.nx_fmt_eur((r ->> 'avg')::numeric) || ' a month.',
        'detail', public.nx_fmt_eur((r ->> 'mtd')::numeric) || ' so far, ' || (r ->> 'lines') || ' lines. Your average of '
                  || (t ->> 'average_months') || ' months is ' || public.nx_fmt_eur((r ->> 'avg')::numeric) || '.',
        'action', 'Make it a rule', 'link', 'rule', 'rule', r -> 'proposal');
    end loop;
  end loop;
  for e in select x from jsonb_array_elements(coalesce(t -> 'effects', '[]'::jsonb)) x
           where (x ->> 'since_month')::numeric < (x ->> 'before_month')::numeric loop
    v_better := v_better || jsonb_build_object('key', 'rule:' || (e ->> 'id'), 'title', e ->> 'if_condition',
      'detail', public.nx_fmt_eur((e ->> 'since_month')::numeric) || ' a month since ' || to_char((e ->> 'since')::date, 'FMDD Mon')
                || ', ' || public.nx_fmt_eur((e ->> 'before_month')::numeric) || ' before.');
  end loop;
  g := jsonb_set(g, '{slipping,items}', v_items);
  g := jsonb_set(g, '{slipping,better}', v_better);
  if g #> '{today,slipping_count}' is not null then
    g := jsonb_set(g, '{today,slipping_count}', to_jsonb(jsonb_array_length(v_items)));
  end if;
  return g;
end $$;

create or replace function public.nx_glance()
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  select public.nx_glance_tags(public.nx_glance_view(public.nx_glance_facts()), public.nx_tag_facts())
$function$;

create or replace function public.nx_look()
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  f jsonb := public.nx_glance_facts();
  t jsonb := public.nx_tag_facts();
begin
  return jsonb_build_object('version', 1, 'glance', public.nx_glance_tags(public.nx_glance_view(f), t), 'facts', f || jsonb_build_object('tags', t));
end $function$;

-- New functions run for you and the server only: not for everyone, not signed out.
revoke all on function public.nx_tag_line(uuid) from public, anon;
revoke all on function public.nx_set_line_tags(uuid[], text, text, boolean) from public, anon;
revoke all on function public.nx_retag() from public, anon;
revoke all on function public.nx_tag_facts() from public, anon;
revoke all on function public.nx_glance_tags(jsonb, jsonb) from public, anon;
revoke all on function public.nx_tag_choices() from public, anon;
revoke all on function public.nx_tag_values(uuid, text) from public, anon;
grant execute on function public.nx_tag_line(uuid) to authenticated, service_role;
grant execute on function public.nx_set_line_tags(uuid[], text, text, boolean) to authenticated, service_role;
grant execute on function public.nx_retag() to authenticated, service_role;
grant execute on function public.nx_tag_facts() to authenticated, service_role;
grant execute on function public.nx_glance_tags(jsonb, jsonb) to authenticated, service_role;
grant execute on function public.nx_tag_choices() to authenticated, service_role;
grant execute on function public.nx_tag_values(uuid, text) to authenticated, service_role;
