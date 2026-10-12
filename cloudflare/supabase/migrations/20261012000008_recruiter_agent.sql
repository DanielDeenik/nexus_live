-- Recruiter agent in Nexus, on LangGraph.
--
-- Gmail stays the intake (the lensiq.company Worker mails every website
-- submission) and the approval surface: the agent writes Gmail drafts and
-- calendar invitations, it never sends. This schema is the record: what came
-- in, how each spec was weighed, which CV and letter were drafted, which
-- roles the monitor found. The knowledge it reasons from (skill profile,
-- master CV, fact base, sharing and tailoring rules, job sources) stays in
-- the DanielDeenik/lensiq repo and is cached here on each run.

-- ---------------------------------------------------------------------------
-- 1. Configuration
-- ---------------------------------------------------------------------------
insert into public.app_config (key, value, description) values
('llm.providers', '{
  "anthropic": {"kind": "anthropic", "key_env": "ANTHROPIC_API_KEY"},
  "moonshot":  {"kind": "openai", "key_env": "MOONSHOT_API_KEY", "base_url": "https://api.moonshot.ai/v1"},
  "deepseek":  {"kind": "openai", "key_env": "DEEPSEEK_API_KEY", "base_url": "https://api.deepseek.com"}
}', 'Model providers the LangChain layer can build; agent_configs picks provider and model per agent'),
('recruiter.knowledge_base_url', 'https://raw.githubusercontent.com/DanielDeenik/lensiq/main/config/',
  'Where the recruiter knowledge files live (Dan edits them in the lensiq repo)'),
('recruiter.knowledge_files', '["agent.json", "skill-profile.json", "cv_tailoring_rules.md", "cv_master.md", "fact_base.md", "sharing_rules.md", "nexus-agent-config.json"]',
  'Knowledge files loaded at the start of every recruiter run'),
('recruiter.intake_query', 'from:{intake_from} newer_than:30d', 'Gmail search for website submissions; {intake_from} comes from agent.json'),
('recruiter.legacy_handled_query', 'in:sent subject:"{prefix}" newer_than:35d',
  'Submissions the earlier Cowork batch already handled (its "handled" mails to Dan); skipped here'),
('recruiter.max_per_run', '10', 'Most submissions one run processes'),
('recruiter.cv_bucket', 'recruiter', 'Private storage bucket for tailored CVs'),
('recruiter.role_max_age_days', '30', 'Roles older than this are ignored by the monitor'),
('recruiter.role_min_score', '30', 'Roles scoring below this are not stored'),
('integrations.google_scopes_extra',
  'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly',
  'Added to the Google consent for the recruiter agent: write drafts (never send) and create call invitations'),
('integrations.calendar_api_base', 'https://www.googleapis.com/calendar/v3', 'Google Calendar API base'),
('cron.recruiter_schedule', '23 * * * *', 'Recruiter agent: work the intake queue (UTC, hourly)'),
('cron.role_monitor_schedule', '7 6,14 * * *', 'Role monitor: scan job sources (UTC, twice daily)')
on conflict (key) do nothing;

insert into public.agent_configs (id, agent_id, display_name, system_prompt, llm_provider, llm_model, max_tokens, temperature, cache_ttl_seconds, rate_limit_per_day, enabled, runner)
values
('agent_recruiter_001', 'recruiter', 'Recruiter Agent',
'You are Dan Deenik''s recruiter agent. You work only from the knowledge files you are given: the skill profile decides what a match is worth, the master CV and fact base are the only source of claims, the sharing rules bind every word that can reach a recruiter, and the tailoring rules govern every CV and letter. Never invent employers, dates, tools, certifications, metrics or outcomes. Never state a rate, salary, notice period or availability. Never use em dashes or arrow characters. Plain, specific prose.',
'moonshot', 'kimi-k2.5', 8192, 0.2, 0, 300, true, 'dedicated'),
('agent_rolemon_001', 'role_monitor', 'Role Monitor',
'Deterministic scan of job sources against the configured keywords, recency bands and score tiers. No model call.',
'anthropic', 'none', 0, 0, 0, 100, true, 'dedicated')
on conflict (agent_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.rec_knowledge (
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  content text not null,
  sha256 text not null,
  source_url text not null,
  fetched_at timestamptz not null default now(),
  primary key (user_id, name)
);

create table if not exists public.rec_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  gmail_message_id text not null,
  received_at timestamptz not null,
  kind text not null check (kind in ('spec', 'question', 'call')),
  name text,
  email text,
  company text,
  role text,
  call_preference text,
  question text,
  spec text,
  status text not null default 'new' check (status in ('new', 'drafted', 'no_match', 'scheduled', 'failed', 'skipped')),
  outcome jsonb not null default '{}'::jsonb,
  gmail_draft_id text,
  calendar_event_id text,
  error text,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  unique (user_id, gmail_message_id)
);
create index if not exists idx_rec_submissions_user on public.rec_submissions (user_id, received_at desc);

create table if not exists public.rec_fit_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  submission_id uuid references public.rec_submissions(id) on delete cascade,
  role_title text,
  company text,
  score integer not null check (score between 0 and 100),
  verdict text not null,
  is_match boolean not null,
  centre_of_gravity text not null,
  requirements jsonb not null,
  gaps jsonb not null default '[]'::jsonb,
  report text not null,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_rec_fit_user on public.rec_fit_reports (user_id, created_at desc);

create table if not exists public.rec_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  submission_id uuid references public.rec_submissions(id) on delete cascade,
  fit_report_id uuid references public.rec_fit_reports(id) on delete set null,
  role_title text not null,
  company text,
  recipient_email text not null,
  cv_markdown text not null,
  cover_letter text not null,
  cv_path text,
  gmail_draft_id text,
  status text not null default 'drafted' check (status in ('drafted', 'sent', 'withdrawn')),
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_rec_applications_user on public.rec_applications (user_id, created_at desc);

create table if not exists public.rec_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  dedup_key text not null,
  source_ids text[] not null,
  title text not null,
  company text,
  link text,
  posted_at timestamptz,
  snippet text,
  score integer not null,
  tier text not null,
  matched jsonb not null default '[]'::jsonb,
  status text not null default 'new' check (status in ('new', 'shortlisted', 'dismissed', 'applied')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, dedup_key)
);
create index if not exists idx_rec_roles_user on public.rec_roles (user_id, score desc);

-- ---------------------------------------------------------------------------
-- 3. Privacy: owner reads; the agents (service role) write. The browser
--    changes only a role's status, through the recruiter route.
-- ---------------------------------------------------------------------------
alter table public.rec_knowledge    enable row level security;
alter table public.rec_submissions  enable row level security;
alter table public.rec_fit_reports  enable row level security;
alter table public.rec_applications enable row level security;
alter table public.rec_roles        enable row level security;

create policy "rec_knowledge_read_own" on public.rec_knowledge for select to authenticated using (user_id = auth.uid());
create policy "rec_submissions_read_own" on public.rec_submissions for select to authenticated using (user_id = auth.uid());
create policy "rec_fit_read_own" on public.rec_fit_reports for select to authenticated using (user_id = auth.uid());
create policy "rec_applications_read_own" on public.rec_applications for select to authenticated using (user_id = auth.uid());
create policy "rec_roles_read_own" on public.rec_roles for select to authenticated using (user_id = auth.uid());

revoke all on public.rec_knowledge, public.rec_submissions, public.rec_fit_reports,
  public.rec_applications, public.rec_roles from anon, authenticated;
grant select on public.rec_knowledge, public.rec_submissions, public.rec_fit_reports,
  public.rec_applications, public.rec_roles to authenticated;
grant all on public.rec_knowledge, public.rec_submissions, public.rec_fit_reports,
  public.rec_applications, public.rec_roles to service_role;

-- Tailored CVs: private bucket, one folder per user, read by the owner only.
insert into storage.buckets (id, name, public) values ('recruiter', 'recruiter', false)
on conflict (id) do nothing;
create policy "recruiter_read_own_folder" on storage.objects for select to authenticated
  using (bucket_id = 'recruiter' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 4. Schedules
-- ---------------------------------------------------------------------------
select public.schedule_from_config('nexus-recruiter', 'cron.recruiter_schedule',
  $$select public.invoke_edge('nexus/recruiter', '{"mode": "intake"}'::jsonb)$$);
select public.schedule_from_config('nexus-role-monitor', 'cron.role_monitor_schedule',
  $$select public.invoke_edge('nexus/recruiter', '{"mode": "roles"}'::jsonb)$$);
