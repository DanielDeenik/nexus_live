-- Nexus — Supabase foundation: infra tables that replace Cloudflare KV
-- (agent/fx cache + per-agent daily rate limiter) and the agent execution log
-- the old code wrote to but never created.

-- ============================================================================
-- Generic key/value cache with TTL (replaces Workers KV)
-- ============================================================================

create table if not exists public.kv_cache (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_kv_cache_expires_at on public.kv_cache(expires_at);

comment on table public.kv_cache is
  'General cache for agent insights and fx-rates. Reads must check expires_at.';

-- Atomic get-or-null that ignores expired rows.
create or replace function public.cache_get(p_key text)
returns jsonb
language sql
security definer set search_path = public
as $$
  select value from public.kv_cache
  where key = p_key and expires_at > now();
$$;

-- Upsert with TTL in seconds.
create or replace function public.cache_set(p_key text, p_value jsonb, p_ttl_seconds integer)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.kv_cache (key, value, expires_at)
  values (p_key, p_value, now() + make_interval(secs => p_ttl_seconds))
  on conflict (key) do update
    set value = excluded.value,
        expires_at = excluded.expires_at,
        created_at = now();
$$;

-- ============================================================================
-- Per-agent, per-user, per-day rate limiter (replaces KV counters)
-- ============================================================================

create table if not exists public.agent_rate_limits (
  agent_id text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  count integer not null default 0,
  primary key (agent_id, user_id, day)
);

-- Increments the counter and returns true if still within `p_limit`.
create or replace function public.rate_limit_check(
  p_agent_id text,
  p_user_id uuid,
  p_limit integer
)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  new_count integer;
begin
  insert into public.agent_rate_limits (agent_id, user_id, day, count)
  values (p_agent_id, p_user_id, current_date, 1)
  on conflict (agent_id, user_id, day)
    do update set count = public.agent_rate_limits.count + 1
  returning count into new_count;

  return new_count <= p_limit;
end;
$$;

-- ============================================================================
-- Agent execution log (was referenced in base-agent but never created)
-- ============================================================================

create table if not exists public.agent_execution_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  agent_id text not null,
  status text not null,
  duration_ms integer,
  executed_at timestamptz not null default now()
);
create index if not exists idx_agent_exec_user_id on public.agent_execution_log(user_id);
create index if not exists idx_agent_exec_agent_id on public.agent_execution_log(agent_id);

alter table public.agent_execution_log enable row level security;
create policy "agent_exec_select_own" on public.agent_execution_log
  for select using (user_id = auth.uid());

-- kv_cache and agent_rate_limits carry no user-facing reads; keep RLS on with
-- no policies so only the service role (Edge Functions) can touch them.
alter table public.kv_cache enable row level security;
alter table public.agent_rate_limits enable row level security;
