-- DTrack, repurposed: Dan's time across all work (consulting and ventures).
-- Ported from DTrack's model (areas of work, projects, activities, time
-- trackings) onto Supabase, single owner per row, with Relay as the capture
-- layer. Relay pushes only time Dan already confirmed there; rows that came
-- from Relay are changed in Relay, never edited here.

-- ---------------------------------------------------------------------------
-- 1. Configuration (read by dt_bootstrap and dt_ingest; nothing hardcoded)
-- ---------------------------------------------------------------------------
insert into public.app_config (key, value, description) values
('dtrack.defaults', '{
  "areas": ["Consulting", "Ventures", "Inbox"],
  "projects": [
    {"name": "Nicola Wealth SimCorp FO", "area": "Consulting", "client": "Alpha FM Consulting Canada Inc", "billable": true},
    {"name": "Nexus", "area": "Ventures"},
    {"name": "LensIQ", "area": "Ventures"},
    {"name": "Social Arb", "area": "Ventures"},
    {"name": "Relay", "area": "Ventures"}
  ],
  "activities": ["Deep work", "Meetings and calls", "Support and tickets", "Building", "Admin", "Learning"]
}', 'Areas, projects and activities created on first sign-in to DTrack'),
('dtrack.unmapped_area', 'Inbox', 'Area that new Relay projects land in until Dan maps them'),
('dtrack.relay_source_activity', '{"flow": "Deep work", "call": "Meetings and calls", "calendar": "Meetings and calls", "git": "Building"}',
  'Activity given to a Relay entry by its source; unlisted sources stay unassigned'),
('dtrack.relay_categories', '["", "execution", "junk", "off", "flow"]',
  'Relay time category number (index) to DTrack category; index 0 means not set'),
('dtrack.ingest_max_items', '5000', 'Most entries plus flow blocks accepted in one Relay push')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.dt_areas_of_work (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  description text,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.dt_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  aow_id uuid not null references public.dt_areas_of_work(id) on delete restrict,
  name text not null check (length(trim(name)) > 0),
  client text,
  billable boolean not null default false,
  relay_key text,
  needs_mapping boolean not null default false,
  start_date date,
  end_date date,
  description text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, name),
  unique (user_id, relay_key),
  check (end_date is null or start_date is null or end_date >= start_date)
);

create table if not exists public.dt_activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  description text,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.dt_time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  project_id uuid not null references public.dt_projects(id) on delete restrict,
  activity_id uuid references public.dt_activities(id) on delete set null,
  entry_date date not null,
  started_at timestamptz,
  ended_at timestamptz,
  minutes integer not null check (minutes > 0 and minutes <= 24 * 60),
  description text,
  category text check (category in ('execution', 'junk', 'off', 'flow')),
  source text not null default 'dtrack' check (source ~ '^[a-z_]+$'),
  external_id text,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, external_id),
  check ((started_at is null) = (ended_at is null)),
  check (ended_at is null or ended_at > started_at)
);
create index if not exists idx_dt_time_entries_user_date on public.dt_time_entries (user_id, entry_date);
create index if not exists idx_dt_time_entries_project on public.dt_time_entries (project_id);

create table if not exists public.dt_flow_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid references public.dt_projects(id) on delete set null,
  external_id text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  minutes integer not null check (minutes >= 0),
  planned_min integer,
  goal text,
  depth smallint check (depth between 0 and 5),
  challenge text,
  triggers jsonb not null default '[]'::jsonb,
  interrupted boolean not null default false,
  recovery_min integer,
  note text,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, external_id)
);
create index if not exists idx_dt_flow_blocks_user_start on public.dt_flow_blocks (user_id, started_at);

-- Device tokens let Relay push without a browser session. Only the SHA-256
-- of the token is stored; the token itself is shown once.
create table if not exists public.dt_device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- ---------------------------------------------------------------------------
-- 3. Row level security: every row belongs to its owner
-- ---------------------------------------------------------------------------
alter table public.dt_areas_of_work enable row level security;
alter table public.dt_projects      enable row level security;
alter table public.dt_activities    enable row level security;
alter table public.dt_time_entries  enable row level security;
alter table public.dt_flow_blocks   enable row level security;
alter table public.dt_device_tokens enable row level security;

create policy "dt_aow_own" on public.dt_areas_of_work for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "dt_projects_own" on public.dt_projects for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "dt_activities_own" on public.dt_activities for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "dt_entries_own" on public.dt_time_entries for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "dt_flow_read_own" on public.dt_flow_blocks for select to authenticated
  using (user_id = auth.uid());
create policy "dt_tokens_read_own" on public.dt_device_tokens for select to authenticated
  using (user_id = auth.uid());

-- Relay is the source of truth for what it sent: no browser edits, inserts
-- that pretend to come from Relay, or deletes of those rows.
create policy "dt_entries_relay_no_insert" on public.dt_time_entries as restrictive
  for insert to authenticated with check (external_id is null and source = 'dtrack');
create policy "dt_entries_relay_no_update" on public.dt_time_entries as restrictive
  for update to authenticated using (external_id is null) with check (external_id is null and source = 'dtrack');
create policy "dt_entries_relay_no_delete" on public.dt_time_entries as restrictive
  for delete to authenticated using (external_id is null);
-- Rows Relay withdrew stay for the audit trail but are invisible here.
create policy "dt_entries_hide_removed" on public.dt_time_entries as restrictive
  for select to authenticated using (removed_at is null);
create policy "dt_flow_hide_removed" on public.dt_flow_blocks as restrictive
  for select to authenticated using (removed_at is null);

-- A project's entries must belong to the same owner as the project.
create or replace function public.dt_check_entry_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.dt_projects p where p.id = new.project_id and p.user_id = new.user_id) then
    raise exception 'project does not belong to this user' using errcode = '42501';
  end if;
  if new.activity_id is not null and not exists (
    select 1 from public.dt_activities a where a.id = new.activity_id and a.user_id = new.user_id) then
    raise exception 'activity does not belong to this user' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.dt_check_entry_owner() from public, anon, authenticated;
create or replace trigger dt_check_entry_owner
  before insert or update on public.dt_time_entries
  for each row execute function public.dt_check_entry_owner();

create or replace function public.dt_check_project_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.dt_areas_of_work a where a.id = new.aow_id and a.user_id = new.user_id) then
    raise exception 'area of work does not belong to this user' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.dt_check_project_owner() from public, anon, authenticated;
create or replace trigger dt_check_project_owner
  before insert or update on public.dt_projects
  for each row execute function public.dt_check_project_owner();

revoke all on public.dt_areas_of_work, public.dt_projects, public.dt_activities,
  public.dt_time_entries, public.dt_flow_blocks, public.dt_device_tokens from anon, authenticated;
grant select, insert, update, delete on public.dt_areas_of_work, public.dt_projects,
  public.dt_activities, public.dt_time_entries to authenticated;
grant select on public.dt_flow_blocks, public.dt_device_tokens to authenticated;
grant all on public.dt_areas_of_work, public.dt_projects, public.dt_activities,
  public.dt_time_entries, public.dt_flow_blocks, public.dt_device_tokens to service_role;

-- ---------------------------------------------------------------------------
-- 4. First sign-in: create the configured areas, projects and activities
-- ---------------------------------------------------------------------------
create or replace function public.dt_bootstrap()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  cfg jsonb;
  a text;
  p jsonb;
  created int := 0;
  n int;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if exists (select 1 from public.dt_areas_of_work where user_id = uid) then
    return jsonb_build_object('created', 0);
  end if;
  select value::jsonb into cfg from public.app_config where key = 'dtrack.defaults';
  if cfg is null then raise exception 'app_config dtrack.defaults is missing'; end if;
  for a in select jsonb_array_elements_text(cfg->'areas') loop
    insert into public.dt_areas_of_work (user_id, name) values (uid, a) on conflict do nothing;
    get diagnostics n = row_count; created := created + n;
  end loop;
  for p in select jsonb_array_elements(cfg->'projects') loop
    insert into public.dt_projects (user_id, aow_id, name, client, billable)
    select uid, w.id, p->>'name', p->>'client', coalesce((p->>'billable')::boolean, false)
      from public.dt_areas_of_work w where w.user_id = uid and w.name = p->>'area'
    on conflict do nothing;
    get diagnostics n = row_count; created := created + n;
  end loop;
  for a in select jsonb_array_elements_text(cfg->'activities') loop
    insert into public.dt_activities (user_id, name) values (uid, a) on conflict do nothing;
    get diagnostics n = row_count; created := created + n;
  end loop;
  return jsonb_build_object('created', created);
end $$;
revoke all on function public.dt_bootstrap() from public, anon;
grant execute on function public.dt_bootstrap() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Device tokens for Relay
-- ---------------------------------------------------------------------------
create or replace function public.dt_create_device_token(p_name text)
returns text language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  tok text;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'name the device'; end if;
  tok := 'dtk_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.dt_device_tokens (user_id, name, token_hash)
  values (uid, trim(p_name), encode(sha256(convert_to(tok, 'UTF8')), 'hex'));
  return tok;
end $$;
revoke all on function public.dt_create_device_token(text) from public, anon;
grant execute on function public.dt_create_device_token(text) to authenticated;

create or replace function public.dt_revoke_device_token(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.dt_device_tokens set revoked_at = now()
   where id = p_id and user_id = auth.uid() and revoked_at is null;
  if not found then raise exception 'no active token with that id' using errcode = 'P0002'; end if;
end $$;
revoke all on function public.dt_revoke_device_token(uuid) from public, anon;
grant execute on function public.dt_revoke_device_token(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Relay push. Called by the nexus edge function with the token's hash.
--    Mirrors one window: upserts what Relay sent and removes Relay rows in
--    that window that Relay no longer has (Dan deleted them there).
--    payload: { tz, window: {from, to}, entries: [...], flows: [...] }
-- ---------------------------------------------------------------------------
create or replace function public.dt_ingest(p_token_hash text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid;
  tz text := coalesce(nullif(p_payload->>'tz', ''), 'UTC');
  max_items int;
  src_map jsonb;
  cats jsonb;
  inbox uuid;
  e jsonb;
  f jsonb;
  rkey text;
  pid uuid;
  aid uuid;
  st timestamp;
  en timestamp;
  ext text;
  seen text[] := '{}';
  seen_flows text[] := '{}';
  upserted int := 0;
  flows int := 0;
  removed int := 0;
  n int;
  w_from date := nullif(p_payload#>>'{window,from}', '')::date;
  w_to date := nullif(p_payload#>>'{window,to}', '')::date;
begin
  select t.user_id into uid from public.dt_device_tokens t
   where t.token_hash = p_token_hash and t.revoked_at is null;
  if uid is null then raise exception 'unknown or revoked device token' using errcode = '42501'; end if;
  update public.dt_device_tokens set last_used_at = now() where token_hash = p_token_hash;

  perform now() at time zone tz;  -- rejects an unknown time zone early

  select value::int into max_items from public.app_config where key = 'dtrack.ingest_max_items';
  select value::jsonb into src_map from public.app_config where key = 'dtrack.relay_source_activity';
  select value::jsonb into cats from public.app_config where key = 'dtrack.relay_categories';
  if max_items is null or src_map is null or cats is null then
    raise exception 'dtrack ingest configuration is incomplete';
  end if;
  if jsonb_array_length(coalesce(p_payload->'entries', '[]')) + jsonb_array_length(coalesce(p_payload->'flows', '[]')) > max_items then
    raise exception 'too many items in one push (limit %)', max_items;
  end if;
  if (w_from is null) <> (w_to is null) or w_to < w_from then
    raise exception 'window needs both from and to, with to on or after from';
  end if;

  select a.id into inbox from public.dt_areas_of_work a
   where a.user_id = uid and a.name = (select value from public.app_config where key = 'dtrack.unmapped_area');
  if inbox is null then
    raise exception 'open DTrack once to create your areas of work, then push again';
  end if;

  -- Projects: match by Relay key, then by name; otherwise create one to map.
  for rkey in
    select distinct x from (
      select jsonb_array_elements(coalesce(p_payload->'entries', '[]'))->>'project' as x
      union
      select jsonb_array_elements(coalesce(p_payload->'flows', '[]'))->>'project'
    ) s where coalesce(x, '') <> ''
  loop
    if not exists (select 1 from public.dt_projects where user_id = uid and relay_key = rkey) then
      update public.dt_projects set relay_key = rkey
       where user_id = uid and relay_key is null and lower(name) = lower(rkey);
      if not found then
        insert into public.dt_projects (user_id, aow_id, name, relay_key, needs_mapping)
        values (uid, inbox, rkey, rkey, true)
        on conflict (user_id, name) do update set relay_key = excluded.relay_key, needs_mapping = true;
      end if;
    end if;
  end loop;

  for e in select jsonb_array_elements(coalesce(p_payload->'entries', '[]')) loop
    if coalesce(e->>'id', '') = '' or coalesce(e->>'project', '') = '' then
      raise exception 'each entry needs an id and a project';
    end if;
    st := (e->>'start')::timestamp;
    en := (e->>'end')::timestamp;
    if en <= st then raise exception 'entry % ends before it starts', e->>'id'; end if;
    select id into pid from public.dt_projects where user_id = uid and relay_key = e->>'project';
    select a.id into aid from public.dt_activities a where a.user_id = uid and a.name = src_map->>(e->>'source');
    ext := 'relay:' || (e->>'id');
    seen := seen || ext;
    insert into public.dt_time_entries
      (user_id, project_id, activity_id, entry_date, started_at, ended_at, minutes, description, category, source, external_id)
    values
      (uid, pid, aid, st::date, st at time zone tz, en at time zone tz,
       greatest(1, round(extract(epoch from (en - st)) / 60)::int),
       nullif(trim(coalesce(e->>'label', '')), ''),
       nullif(cats->>coalesce((e->>'cat')::int, 0), ''),
       coalesce(nullif(regexp_replace(lower(coalesce(e->>'source', '')), '[^a-z_]', '', 'g'), ''), 'relay'),
       ext)
    on conflict (user_id, external_id) do update set
      project_id = excluded.project_id, activity_id = excluded.activity_id,
      entry_date = excluded.entry_date, started_at = excluded.started_at, ended_at = excluded.ended_at,
      minutes = excluded.minutes, description = excluded.description,
      category = excluded.category, source = excluded.source, removed_at = null;
    upserted := upserted + 1;
  end loop;

  for f in select jsonb_array_elements(coalesce(p_payload->'flows', '[]')) loop
    st := (f->>'start')::timestamp;
    en := (f->>'end')::timestamp;
    ext := 'flow:' || (f->>'start');
    seen_flows := seen_flows || ext;
    select id into pid from public.dt_projects where user_id = uid and relay_key = f->>'project';
    insert into public.dt_flow_blocks
      (user_id, project_id, external_id, started_at, ended_at, minutes, planned_min, goal, depth,
       challenge, triggers, interrupted, recovery_min, note)
    values
      (uid, pid, ext, st at time zone tz, en at time zone tz, coalesce((f->>'minutes')::int, 0),
       (f->>'planned_min')::int, f->>'goal', least(5, greatest(0, coalesce((f->>'depth')::int, 0))),
       nullif(f->>'challenge', ''), coalesce(f->'triggers', '[]'::jsonb),
       coalesce((f->>'interrupted')::boolean, false), (f->>'recovery_min')::int, nullif(f->>'note', ''))
    on conflict (user_id, external_id) do update set
      project_id = excluded.project_id, ended_at = excluded.ended_at, minutes = excluded.minutes,
      planned_min = excluded.planned_min, goal = excluded.goal, depth = excluded.depth,
      challenge = excluded.challenge, triggers = excluded.triggers, interrupted = excluded.interrupted,
      recovery_min = excluded.recovery_min, note = excluded.note, removed_at = null;
    flows := flows + 1;
  end loop;

  -- Relay no longer has these: mark them removed (kept for the audit trail,
  -- hidden from every read by the removed_at policies).
  if w_from is not null then
    update public.dt_time_entries set removed_at = now()
     where user_id = uid and external_id like 'relay:%' and removed_at is null
       and entry_date >= w_from and entry_date <= w_to
       and not (external_id = any (seen));
    get diagnostics n = row_count; removed := removed + n;
    update public.dt_flow_blocks set removed_at = now()
     where user_id = uid and removed_at is null
       and (started_at at time zone tz)::date >= w_from and (started_at at time zone tz)::date <= w_to
       and not (external_id = any (seen_flows));
    get diagnostics n = row_count; removed := removed + n;
  end if;

  return jsonb_build_object(
    'entries', upserted, 'flows', flows, 'removed', removed,
    'unmapped_projects', coalesce((select jsonb_agg(name order by name) from public.dt_projects
                                     where user_id = uid and needs_mapping), '[]'::jsonb));
end $$;
revoke all on function public.dt_ingest(text, jsonb) from public, anon, authenticated;
grant execute on function public.dt_ingest(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Dashboard: hours grouped along chosen axes (DTrack's sunburst), and
--    billable time logged against hours invoiced
-- ---------------------------------------------------------------------------
create or replace function public.dt_summary(p_axes text[], p_from date, p_to date)
returns table (path text[], hours numeric)
language plpgsql stable security invoker set search_path = public as $$
declare
  exprs text[] := '{}';
  ax text;
  sel text;
begin
  if p_axes is null or cardinality(p_axes) = 0 or cardinality(p_axes) > 5 then
    raise exception 'choose between one and five axes';
  end if;
  foreach ax in array p_axes loop
    exprs := exprs || case ax
      when 'area'     then 'a.name'
      when 'project'  then 'p.name'
      when 'activity' then 'coalesce(ac.name, ''No activity'')'
      when 'category' then 'coalesce(e.category, ''Not set'')'
      when 'source'   then 'e.source'
      when 'billable' then 'case when p.billable then ''Billable'' else ''Non-billable'' end'
      when 'month'    then 'to_char(e.entry_date, ''YYYY-MM'')'
      when 'week'     then 'to_char(e.entry_date, ''IYYY-"W"IW'')'
      when 'day'      then 'to_char(e.entry_date, ''YYYY-MM-DD'')'
      else null end;
    if exprs[cardinality(exprs)] is null then raise exception 'unknown axis %', ax; end if;
  end loop;
  sel := array_to_string(exprs, ', ');
  return query execute format(
    'select array[%s]::text[], round(sum(e.minutes) / 60.0, 2)
       from public.dt_time_entries e
       join public.dt_projects p on p.id = e.project_id
       join public.dt_areas_of_work a on a.id = p.aow_id
       left join public.dt_activities ac on ac.id = e.activity_id
      where e.user_id = auth.uid() and e.entry_date >= $1 and e.entry_date < $2
      group by %s order by 2 desc', sel, sel)
  using p_from, p_to;
end $$;
revoke all on function public.dt_summary(text[], date, date) from public, anon;
grant execute on function public.dt_summary(text[], date, date) to authenticated;

-- Invoiced hours count each client period once (duplicate invoices for the
-- same period are the ledger's job to resolve), matching the tax ledger.
create or replace function public.dt_billable_vs_invoiced(p_from date, p_to date)
returns table (month date, logged_hours numeric, invoiced_hours numeric)
language sql stable security invoker set search_path = public as $$
  with months as (
    select generate_series(date_trunc('month', p_from), date_trunc('month', p_to - 1), interval '1 month')::date as m
  ),
  logged as (
    select date_trunc('month', e.entry_date)::date as m, sum(e.minutes) / 60.0 as h
      from public.dt_time_entries e join public.dt_projects p on p.id = e.project_id
     where e.user_id = auth.uid() and p.billable and e.entry_date >= p_from and e.entry_date < p_to
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
