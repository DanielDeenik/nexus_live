-- LinkedIn insights in Nexus.
--
-- Dan uploads three kinds of LinkedIn material into his own folder in the
-- receipts bucket and the nexus/linkedin route imports them:
--   * the creator Content analytics export (.xlsx): daily impressions,
--     engagements and new followers, top posts, follower total, audience
--   * the "Get a copy of your data" archive (.zip): connections and inbound
--     message metadata, with recruiters flagged by a deterministic keyword list
--   * screenshots of Who viewed your profile and Search appearances, read by
--     the linkedin agent because LinkedIn offers no export for them
-- Every sheet name, column header, file name, keyword and limit below is
-- configuration, so a change in LinkedIn's export layout is a row change.
-- Message bodies are never stored: at most a short snippet.

-- ---------------------------------------------------------------------------
-- 1. Configuration
-- ---------------------------------------------------------------------------
insert into public.app_config (key, value, description) values
('linkedin.bucket', 'receipts', 'Private bucket the LinkedIn uploads land in (the web uploads to {uid}/uploads/)'),
('linkedin.max_import_bytes', '104857600', 'Largest LinkedIn file one import reads'),
('linkedin.parse_limits', '{"maxEntryBytes": 209715200, "maxSheetRows": 200000, "maxSheetCols": 300}', 'Largest single file unpacked from an export, and the most rows and columns read from one sheet'),
('linkedin.upsert_chunk', '500', 'Rows per upsert call during a LinkedIn import'),
('linkedin.date_order', 'MDY', 'Order of slashed dates in LinkedIn exports (MDY or DMY)'),
('linkedin.image_extensions', '["png", "jpg", "jpeg"]', 'File extensions treated as profile analytics screenshots'),
('linkedin.content_sheets', '{
  "discovery": ["DISCOVERY"],
  "engagement": ["ENGAGEMENT"],
  "top_posts": ["TOP POSTS"],
  "followers": ["FOLLOWERS"],
  "demographics": ["DEMOGRAPHICS"]
}', 'Sheet names in the Content analytics export, per section (any alias matches, case insensitive)'),
('linkedin.content_columns', '{
  "overall": ["Overall Performance"],
  "impressions": ["Impressions"],
  "members_reached": ["Members reached"],
  "date": ["Date"],
  "engagements": ["Engagements"],
  "new_followers": ["New followers"],
  "total_followers": ["Total followers"],
  "post_url": ["Post URL"],
  "published_on": ["Post publish date"],
  "dimension": ["Top Demographics"],
  "value": ["Value"],
  "pct": ["Percentage"]
}', 'Header and label cells in the Content analytics export; total_followers is matched as a prefix'),
('linkedin.demographic_dimensions', '{
  "Job titles": "job_title",
  "Locations": "location",
  "Industries": "industry",
  "Seniority": "seniority",
  "Company size": "company_size",
  "Companies": "company"
}', 'Demographic group labels mapped to the dimension stored in li_audience'),
('linkedin.archive_files', '{
  "connections": ["Connections.csv"],
  "messages": ["messages.csv"],
  "invitations": ["Invitations.csv"],
  "profile": ["Profile.csv"]
}', 'File names read from the data archive (matched in any folder, case insensitive)'),
('linkedin.archive_columns', '{
  "connections": {"first_name": ["First Name"], "last_name": ["Last Name"], "url": ["URL"], "company": ["Company"], "position": ["Position"], "connected_on": ["Connected On"]},
  "messages": {"conversation_id": ["CONVERSATION ID"], "conversation_title": ["CONVERSATION TITLE"], "from": ["FROM"], "sender_url": ["SENDER PROFILE URL"], "to": ["TO"], "date": ["DATE"], "subject": ["SUBJECT"], "content": ["CONTENT"], "folder": ["FOLDER"]},
  "invitations": {"from": ["From"], "to": ["To"], "sent_at": ["Sent At"], "message": ["Message"], "direction": ["Direction"]},
  "profile": {"first_name": ["First Name"], "last_name": ["Last Name"]}
}', 'Columns read from each archive file; email columns are deliberately absent'),
('linkedin.sent_folders', '["SENT"]', 'messages.csv FOLDER values that mark messages Dan sent (used to identify him when Profile.csv is missing)'),
('linkedin.recruiter_keywords', '["recruiter", "recruiting", "recruitment", "talent acquisition", "talent partner", "talent sourcer", "headhunter", "head hunter", "executive search", "sourcer", "resourcing", "staffing", "werving", "werver", "wervingsspecialist"]',
  'A connection or message counts as recruiter when one of these starts a word in the position, subject or content'),
('linkedin.recruiter_message_fields', '["subject", "content"]', 'Message fields checked against the recruiter keywords (the sender''s position is always checked)'),
('linkedin.snippet_max_chars', '200', 'Longest message snippet kept (the table also caps it at 200)'),
('linkedin.summary_top_n', '10', 'Rows per list in the LinkedIn summary (top posts, audience per dimension, companies)'),
('linkedin.company_suffixes', '["bv", "nv", "ltd", "limited", "inc", "llc", "gmbh", "plc", "ag", "sa", "group", "holding", "holdings"]',
  'Trailing words ignored when matching company names across LinkedIn and recruiter roles'),
('linkedin.screenshot_instruction', 'This is a screenshot of a LinkedIn profile analytics page. Record what it shows using the tool.',
  'Text sent with each screenshot; the agent prompt in agent_configs governs how it is read'),
('linkedin.screenshot_hints', '{
  "views": "The owner says this is the Who viewed your profile page.",
  "search": "The owner says this is the Search appearances page."
}', 'Extra line sent when the upload names the page')
on conflict (key) do nothing;

-- Same model as the expense agent (both read images into structured fields).
insert into public.agent_configs (id, agent_id, display_name, system_prompt, llm_provider, llm_model, max_tokens, temperature, cache_ttl_seconds, rate_limit_per_day, enabled, runner)
values
('agent_linkedin_001', 'linkedin', 'LinkedIn Insights',
'You read screenshots of LinkedIn profile analytics for the owner: the Who viewed your profile page and the Search appearances page. Record only what is visible in the image. Never guess, estimate, infer or complete a value that is cut off, blurred or hidden behind an upgrade prompt: use null for a missing number and leave a list empty when it is not shown. Copy labels exactly as written (job titles, companies, locations, keywords, where you appeared). A count belongs to a label only when the image shows that number for that label. Set kind to views or search from the page title, or unknown when the image is neither. Never use em dashes or arrow characters.',
'anthropic', 'claude-sonnet-5-5', 2048, 0.0, 0, 200, true, 'dedicated')
on conflict (agent_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.li_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  sha256 text not null,
  kind text not null check (kind in ('content', 'archive', 'screenshot')),
  path text not null,
  status text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
  period_from date,
  period_to date,
  counts jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  error text,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  imported_at timestamptz not null default now(),
  unique (user_id, sha256)
);
create index if not exists idx_li_imports_user on public.li_imports (user_id, imported_at desc);

create table if not exists public.li_content_daily (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  impressions integer,
  engagements integer,
  new_followers integer,
  import_id uuid references public.li_imports(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table if not exists public.li_posts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  url text not null,
  published_on date,
  impressions integer,
  engagements integer,
  import_id uuid references public.li_imports(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, url)
);

create table if not exists public.li_followers_total (
  user_id uuid not null references public.profiles(id) on delete cascade,
  as_of date not null,
  total integer not null,
  import_id uuid references public.li_imports(id) on delete set null,
  primary key (user_id, as_of)
);

create table if not exists public.li_audience (
  user_id uuid not null references public.profiles(id) on delete cascade,
  as_of date not null,
  dimension text not null,
  value text not null,
  pct numeric,
  pct_label text,
  import_id uuid references public.li_imports(id) on delete set null,
  primary key (user_id, as_of, dimension, value)
);

create table if not exists public.li_connections (
  user_id uuid not null references public.profiles(id) on delete cascade,
  conn_key text not null,
  name text not null,
  profile_url text,
  company text,
  position text,
  connected_on date,
  is_recruiter boolean not null default false,
  import_id uuid references public.li_imports(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, conn_key)
);
create index if not exists idx_li_connections_recruiter on public.li_connections (user_id) where is_recruiter;

-- Inbound messages only, metadata only: no email address, no full body.
create table if not exists public.li_messages (
  user_id uuid not null references public.profiles(id) on delete cascade,
  msg_key text not null,
  conversation_id text,
  sent_at timestamptz not null,
  sender_name text not null,
  sender_profile_url text,
  company text,
  subject text check (subject is null or char_length(subject) <= 200),
  snippet text check (snippet is null or char_length(snippet) <= 200),
  is_recruiter boolean not null default false,
  import_id uuid references public.li_imports(id) on delete set null,
  primary key (user_id, msg_key)
);
create index if not exists idx_li_messages_user on public.li_messages (user_id, sent_at desc);

create table if not exists public.li_profile_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('views', 'search')),
  source_sha256 text not null,
  period_label text,
  period_days integer,
  period_from date,
  period_to date,
  total integer,
  details jsonb not null default '{}'::jsonb,
  import_id uuid references public.li_imports(id) on delete set null,
  captured_at timestamptz not null default now(),
  unique (user_id, kind, source_sha256)
);
create index if not exists idx_li_snapshots_user on public.li_profile_snapshots (user_id, kind, captured_at desc);

-- ---------------------------------------------------------------------------
-- 3. Privacy: owner reads; the import route (service role) writes.
-- ---------------------------------------------------------------------------
alter table public.li_imports           enable row level security;
alter table public.li_content_daily     enable row level security;
alter table public.li_posts             enable row level security;
alter table public.li_followers_total   enable row level security;
alter table public.li_audience          enable row level security;
alter table public.li_connections       enable row level security;
alter table public.li_messages          enable row level security;
alter table public.li_profile_snapshots enable row level security;

create policy "li_imports_read_own" on public.li_imports for select to authenticated using (user_id = auth.uid());
create policy "li_content_daily_read_own" on public.li_content_daily for select to authenticated using (user_id = auth.uid());
create policy "li_posts_read_own" on public.li_posts for select to authenticated using (user_id = auth.uid());
create policy "li_followers_total_read_own" on public.li_followers_total for select to authenticated using (user_id = auth.uid());
create policy "li_audience_read_own" on public.li_audience for select to authenticated using (user_id = auth.uid());
create policy "li_connections_read_own" on public.li_connections for select to authenticated using (user_id = auth.uid());
create policy "li_messages_read_own" on public.li_messages for select to authenticated using (user_id = auth.uid());
create policy "li_profile_snapshots_read_own" on public.li_profile_snapshots for select to authenticated using (user_id = auth.uid());

revoke all on public.li_imports, public.li_content_daily, public.li_posts, public.li_followers_total,
  public.li_audience, public.li_connections, public.li_messages, public.li_profile_snapshots from anon, authenticated;
grant select on public.li_imports, public.li_content_daily, public.li_posts, public.li_followers_total,
  public.li_audience, public.li_connections, public.li_messages, public.li_profile_snapshots to authenticated;
grant all on public.li_imports, public.li_content_daily, public.li_posts, public.li_followers_total,
  public.li_audience, public.li_connections, public.li_messages, public.li_profile_snapshots to service_role;

-- ---------------------------------------------------------------------------
-- 4. Summary for the web page. Security invoker: every read runs under the
--    caller's own RLS, so it only ever sees the caller's rows.
-- ---------------------------------------------------------------------------

-- Company name reduced for matching: lower case, dots removed, punctuation
-- to spaces, trailing legal-form words (from config) dropped.
create or replace function public.li_company_key(p_name text, p_suffixes text[])
returns text language plpgsql immutable as $$
declare
  t text[];
begin
  if p_name is null then return null; end if;
  t := regexp_split_to_array(btrim(regexp_replace(replace(lower(p_name), '.', ''), '[^[:alnum:]]+', ' ', 'g')), ' ');
  while array_length(t, 1) > 1 and t[array_length(t, 1)] = any(p_suffixes) loop
    t := t[1:array_length(t, 1) - 1];
  end loop;
  return nullif(array_to_string(t, ' '), '');
end $$;

create or replace function public.li_summary(p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  uid uuid := auth.uid();
  d_from date := coalesce(p_from, '-infinity'::date);
  d_to date := coalesce(p_to, 'infinity'::date);
  top_n int := coalesce((select value::int from app_config where key = 'linkedin.summary_top_n'), 10);
  suffixes text[] := coalesce((select array(select jsonb_array_elements_text(value::jsonb)) from app_config where key = 'linkedin.company_suffixes'), '{}');
  v_out jsonb;
begin
  with
  daily as (
    select day, impressions, engagements, new_followers from li_content_daily
    where user_id = uid and day between d_from and d_to
  ),
  totals as (
    select coalesce(sum(impressions), 0) as impressions, coalesce(sum(engagements), 0) as engagements,
           coalesce(sum(new_followers), 0) as new_followers, count(*) as days, min(day) as first_day, max(day) as last_day
    from daily
  ),
  fol as (
    select as_of, total from li_followers_total where user_id = uid and as_of <= d_to order by as_of desc limit 1
  ),
  posts as (
    select url, published_on, impressions, engagements,
           case when coalesce(impressions, 0) > 0 then round(engagements::numeric / impressions, 4) end as rate
    from li_posts
    where user_id = uid and (published_on is null or published_on between d_from and d_to)
    order by engagements desc nulls last, impressions desc nulls last
    limit top_n
  ),
  aud_asof as (
    select coalesce(
      (select max(as_of) from li_audience where user_id = uid and as_of <= d_to),
      (select max(as_of) from li_audience where user_id = uid)) as as_of
  ),
  aud as (
    select dimension, value, pct, pct_label,
           row_number() over (partition by dimension order by pct desc nulls last, value) as rn
    from li_audience a, aud_asof x where a.user_id = uid and a.as_of = x.as_of
  ),
  conns as (
    select * from li_connections where user_id = uid
  ),
  rec_companies as (
    select li_company_key(company, suffixes) as ckey, min(company) as company, count(*) as recruiters
    from conns where is_recruiter and company is not null and li_company_key(company, suffixes) is not null
    group by 1
  ),
  msgs as (
    select * from li_messages where user_id = uid and sent_at::date between d_from and d_to
  ),
  roles as (
    select li_company_key(company, suffixes) as ckey, count(*) as roles,
           jsonb_agg(jsonb_build_object('title', title, 'score', score, 'tier', tier, 'status', status) order by score desc) as role_list
    from rec_roles where user_id = uid and company is not null and status <> 'dismissed'
    group by 1
  ),
  snap as (
    select distinct on (kind) kind, period_label, period_from, period_to, total, details, captured_at
    from li_profile_snapshots where user_id = uid
    order by kind, captured_at desc
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to,
      'first_day', (select first_day from totals), 'last_day', (select last_day from totals)),
    'content', (select jsonb_build_object(
        'impressions', impressions, 'engagements', engagements, 'days', days,
        'engagement_rate', case when impressions > 0 then round(engagements::numeric / impressions, 4) end)
      from totals),
    'series', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'impressions', impressions, 'engagements', engagements, 'new_followers', new_followers) order by day) from daily), '[]'::jsonb),
    'followers', jsonb_build_object(
      'total', (select total from fol), 'as_of', (select as_of from fol),
      'growth', (select new_followers from totals)),
    'top_posts', coalesce((select jsonb_agg(to_jsonb(p)) from posts p), '[]'::jsonb),
    'audience', jsonb_build_object(
      'as_of', (select as_of from aud_asof),
      'dimensions', coalesce((select jsonb_object_agg(dimension, items) from (
        select dimension, jsonb_agg(jsonb_build_object('value', value, 'pct', pct, 'pct_label', pct_label) order by rn) as items
        from aud where rn <= top_n group by dimension) g), '{}'::jsonb)),
    'network', jsonb_build_object(
      'connections', (select count(*) from conns),
      'connections_in_period', (select count(*) from conns where connected_on between d_from and d_to),
      'recruiters', (select count(*) from conns where is_recruiter),
      'top_recruiter_companies', coalesce((select jsonb_agg(jsonb_build_object('company', company, 'recruiters', recruiters) order by recruiters desc, company)
        from (select * from rec_companies order by recruiters desc, company limit top_n) t), '[]'::jsonb)),
    'messages', jsonb_build_object(
      'inbound', (select count(*) from msgs),
      'inbound_recruiter', (select count(*) from msgs where is_recruiter),
      'recruiter_by_month', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'count', n) order by m)
        from (select to_char(date_trunc('month', sent_at), 'YYYY-MM') as m, count(*) as n from msgs where is_recruiter group by 1) t), '[]'::jsonb),
      'top_recruiter_senders_companies', coalesce((select jsonb_agg(jsonb_build_object('company', company, 'messages', n) order by n desc, company)
        from (select company, count(*) as n from msgs where is_recruiter and company is not null group by company order by n desc, company limit top_n) t), '[]'::jsonb)),
    'profile', jsonb_build_object(
      'views', (select to_jsonb(s) - 'kind' from snap s where kind = 'views'),
      'search', (select to_jsonb(s) - 'kind' from snap s where kind = 'search')),
    'warm_companies', coalesce((select jsonb_agg(jsonb_build_object(
        'company', c.company, 'recruiters', c.recruiters, 'roles', r.roles, 'role_list', r.role_list) order by r.roles desc, c.recruiters desc, c.company)
      from rec_companies c join roles r on r.ckey = c.ckey), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;

revoke all on function public.li_summary(date, date) from public, anon;
grant execute on function public.li_summary(date, date) to authenticated, service_role;
grant execute on function public.li_company_key(text, text[]) to authenticated, service_role;
