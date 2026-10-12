-- Invoices feed DTrack.
--
-- A confirmed sales invoice with hours and a service period writes billable
-- time entries for that period, so an uploaded invoice shows up in Time. Days
-- that already carry billable time for the project (from Relay or typed in)
-- keep it; the invoice tops up only the hours not yet logged, spread over the
-- remaining working days. Re-running is safe: entries are keyed per invoice and
-- day, and a voided invoice takes its entries out again (soft removal).

-- ---------------------------------------------------------------------------
-- 1. Configuration
-- ---------------------------------------------------------------------------
insert into public.app_config (key, value, description) values
('dtrack.invoice_backfill', '{
  "source": "invoice",
  "category": "execution",
  "area": "Consulting",
  "weekdays": [1, 2, 3, 4, 5],
  "rounding_minutes": 15,
  "description": "Invoiced time, {invoice}",
  "company_suffixes": ["inc", "incorporated", "ltd", "limited", "llc", "bv", "nv", "gmbh", "corp", "corporation", "co", "plc"]
}', 'How a confirmed invoice becomes DTrack time: entry source, category, area for a new client project, worked weekdays (ISO), rounding, entry text and the company suffixes ignored when matching a client to a project'),
('storage.documents_bucket', 'receipts', 'Private bucket holding uploaded receipts, invoices and imports'),
('expense_agent.extract_attempts', '2', 'Times the expense agent retries reading a receipt before sending it to review'),
('expense_agent.sales_invoice_prompt',
  'You read an invoice the owner issued. Return exactly what is printed; null when absent. Never infer hours or periods that are not on the document.',
  'System prompt for reading the owner''s own sales invoices')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Matching a client name to a project
-- ---------------------------------------------------------------------------
create or replace function public.dt_client_key(p_name text)
returns text language sql stable set search_path = public as $$
  with cfg as (
    select coalesce((select value::jsonb -> 'company_suffixes' from public.app_config where key = 'dtrack.invoice_backfill'), '[]'::jsonb) s
  ), words as (
    select w, ord from regexp_split_to_table(lower(coalesce(p_name, '')), '[^a-z0-9]+') with ordinality as t(w, ord)
    where w <> ''
  )
  select string_agg(w, ' ' order by ord) from words, cfg
  where not (cfg.s ? w)
$$;

-- ---------------------------------------------------------------------------
-- 3. Invoice to time entries
-- ---------------------------------------------------------------------------
create or replace function public.dt_backfill_invoice(p_invoice uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  inv record;
  cfg jsonb;
  proj uuid;
  area uuid;
  r int;
  logged int;
  remaining int;
  days date[];
  n int;
  units int;
  extra int;
  per int;
  plus int;
  i int;
  m int;
  written int := 0;
begin
  select value::jsonb into cfg from public.app_config where key = 'dtrack.invoice_backfill';
  if cfg is null then raise exception 'app_config dtrack.invoice_backfill is missing'; end if;
  r := greatest((cfg->>'rounding_minutes')::int, 1);

  select * into inv from public.invoices where id = p_invoice;
  if not found or inv.voided_at is not null or inv.duplicate_of is not null
     or inv.review_state is distinct from 'confirmed'
     or inv.hours is null or inv.hours <= 0 or inv.period_start is null or inv.period_end is null
     or inv.period_end < inv.period_start then
    return 0;
  end if;

  -- One invoice per client and period counts, the same rule dt_billable_vs_invoiced uses
  -- (most hours wins; ties go to the lowest invoice number).
  if exists (
    select 1 from public.invoices o
    where o.user_id = inv.user_id and o.id <> inv.id and o.client = inv.client
      and o.period_start = inv.period_start and o.period_end = inv.period_end
      and o.voided_at is null and o.duplicate_of is null and o.hours is not null
      and (o.hours > inv.hours or (o.hours = inv.hours and coalesce(o.invoice_number, '') < coalesce(inv.invoice_number, '')))
  ) then
    return 0;
  end if;

  -- This invoice counts for the period, so any other invoice's time for the
  -- same client and period comes out first (no double counting).
  perform public.dt_unlink_invoice(o.id, inv.user_id)
     from public.invoices o
    where o.user_id = inv.user_id and o.id <> inv.id and o.client = inv.client
      and o.period_start = inv.period_start and o.period_end = inv.period_end;

  -- Already written and still active: nothing to do.
  if exists (
    select 1 from public.dt_time_entries
    where user_id = inv.user_id and source = cfg->>'source'
      and external_id like 'invoice:' || inv.id || ':%' and removed_at is null
  ) then
    return 0;
  end if;

  -- The billable project for this client, created when there is none yet.
  select p.id into proj from public.dt_projects p
  where p.user_id = inv.user_id and p.billable and p.archived_at is null
    and public.dt_client_key(p.client) = public.dt_client_key(inv.client)
  order by p.created_at limit 1;
  if proj is null then
    insert into public.dt_areas_of_work (user_id, name) values (inv.user_id, cfg->>'area') on conflict do nothing;
    select id into area from public.dt_areas_of_work where user_id = inv.user_id and name = cfg->>'area';
    insert into public.dt_projects (user_id, aow_id, name, client, billable)
    values (inv.user_id, area, inv.client, inv.client, true)
    on conflict (user_id, name) do nothing;
    select id into proj from public.dt_projects
     where user_id = inv.user_id and name = inv.client and billable and archived_at is null;
    if proj is null then
      raise exception 'project "%" exists but is archived or not billable; make it billable or set its client to match invoice %',
        inv.client, inv.invoice_number;
    end if;
  end if;

  -- Hours already logged for this project in the period from anything other than invoices.
  select coalesce(sum(minutes), 0) into logged from public.dt_time_entries
  where user_id = inv.user_id and project_id = proj and removed_at is null
    and source <> cfg->>'source' and entry_date between inv.period_start and inv.period_end;
  remaining := round(inv.hours * 60)::int - logged;
  if remaining <= 0 then return 0; end if;

  -- Working days in the period without logged time for the project.
  select array_agg(d::date order by d) into days
  from generate_series(inv.period_start, inv.period_end, interval '1 day') d
  where (cfg->'weekdays') @> to_jsonb(extract(isodow from d)::int)
    and not exists (
      select 1 from public.dt_time_entries e
      where e.user_id = inv.user_id and e.project_id = proj and e.removed_at is null
        and e.source <> cfg->>'source' and e.entry_date = d::date);
  n := coalesce(array_length(days, 1), 0);
  if n = 0 then return 0; end if;

  units := remaining / r;
  extra := remaining % r;
  per := units / n;
  plus := units % n;
  for i in 1..n loop
    m := (per + case when i <= plus then 1 else 0 end) * r + case when i = n then extra else 0 end;
    if m > 24 * 60 then
      raise exception 'invoice % needs % minutes on %, more than a day; check its hours and period', inv.invoice_number, m, days[i];
    end if;
    if m > 0 then
      insert into public.dt_time_entries (user_id, project_id, entry_date, minutes, description, category, source, external_id)
      values (inv.user_id, proj, days[i], m,
              replace(cfg->>'description', '{invoice}', coalesce(inv.invoice_number, '')),
              cfg->>'category', cfg->>'source', 'invoice:' || inv.id || ':' || days[i])
      on conflict (user_id, external_id) do update
        set minutes = excluded.minutes, removed_at = null, updated_at = now();
      written := written + 1;
    end if;
  end loop;
  return written;
end $$;

-- A voided (or outranked) invoice takes its time out again. Scoped to the
-- invoice's owner, so one user can never touch another user's time.
create or replace function public.dt_unlink_invoice(p_invoice uuid, p_user uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.dt_time_entries set removed_at = now(), updated_at = now()
  where user_id = p_user and external_id like 'invoice:' || p_invoice || ':%' and removed_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- Every confirmed invoice of one user (the agents' "fill from invoices" run).
create or replace function public.dt_backfill_invoices(p_user uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare i record; total int := 0;
begin
  for i in select id from public.invoices where user_id = p_user and review_state = 'confirmed'
             and voided_at is null and duplicate_of is null order by period_start nulls last, invoice_number loop
    total := total + public.dt_backfill_invoice(i.id);
  end loop;
  return total;
end $$;

revoke all on function public.dt_backfill_invoice(uuid), public.dt_unlink_invoice(uuid, uuid), public.dt_backfill_invoices(uuid)
  from public, anon, authenticated;
grant execute on function public.dt_backfill_invoice(uuid), public.dt_unlink_invoice(uuid, uuid), public.dt_backfill_invoices(uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Logged against invoiced compares tracked time only
-- ---------------------------------------------------------------------------
-- Time written from invoices would always equal the invoiced hours, so the
-- comparison leaves it out and shows what Relay and manual logging captured.
create or replace function public.dt_billable_vs_invoiced(p_from date, p_to date)
returns table (month date, logged_hours numeric, invoiced_hours numeric)
language sql stable security invoker set search_path = public as $$
  with months as (
    select generate_series(date_trunc('month', p_from), date_trunc('month', p_to - 1), interval '1 month')::date as m
  ),
  logged as (
    select date_trunc('month', e.entry_date)::date as m, sum(e.minutes) / 60.0 as h
      from public.dt_time_entries e join public.dt_projects p on p.id = e.project_id
     where e.user_id = auth.uid() and p.billable and e.removed_at is null
       and e.source <> coalesce((select value::jsonb ->> 'source' from public.app_config where key = 'dtrack.invoice_backfill'), '')
       and e.entry_date >= p_from and e.entry_date < p_to
     group by 1
  ),
  periods as (
    select distinct on (i.client, i.period_start, i.period_end)
           date_trunc('month', coalesce(i.period_start, i.issued_date))::date as m, i.hours
      from public.invoices i
     where i.user_id = auth.uid() and i.voided_at is null and i.duplicate_of is null
       and i.hours is not null
       and coalesce(i.period_start, i.issued_date) >= p_from and coalesce(i.period_start, i.issued_date) < p_to
     order by i.client, i.period_start, i.period_end, i.hours desc
  ),
  invoiced as (select m, sum(hours) as h from periods group by 1)
  select months.m, round(coalesce(logged.h, 0), 2), round(coalesce(invoiced.h, 0), 2)
    from months left join logged using (m) left join invoiced using (m)
   order by 1;
$$;
revoke all on function public.dt_billable_vs_invoiced(date, date) from public, anon;
grant execute on function public.dt_billable_vs_invoiced(date, date) to authenticated;
