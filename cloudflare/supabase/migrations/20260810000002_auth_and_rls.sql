-- Nexus — Supabase foundation: auth wiring + Row-Level Security
-- A profile row is auto-created for every new auth.users row. Every
-- user-scoped table is locked to `user_id = auth.uid()`.

-- ============================================================================
-- Auto-create a profile when a user signs up
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- Enable RLS everywhere
-- ============================================================================

alter table public.profiles              enable row level security;
alter table public.invoices              enable row level security;
alter table public.expenses              enable row level security;
alter table public.contracts             enable row level security;
alter table public.cashflow_history      enable row level security;
alter table public.burn_history          enable row level security;
alter table public.wise_accounts         enable row level security;
alter table public.hedging_contracts     enable row level security;
alter table public.market_signals        enable row level security;
alter table public.market_trends         enable row level security;
alter table public.leads                 enable row level security;
alter table public.projects              enable row level security;
alter table public.scenarios             enable row level security;
alter table public.agent_configs         enable row level security;
alter table public.agent_knowledge_graph enable row level security;
alter table public.data_sources          enable row level security;
alter table public.app_config            enable row level security;
alter table public.recalc_log            enable row level security;
alter table public.commitment_stages     enable row level security;
alter table public.commitment_transitions enable row level security;

-- ============================================================================
-- profiles: a user can see/update only their own profile
-- ============================================================================

create policy "profiles_select_own" on public.profiles
  for select using (id = auth.uid());
create policy "profiles_update_own" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ============================================================================
-- Owner-scoped tables: full CRUD limited to rows where user_id = auth.uid()
-- Generated uniformly so every table behaves identically.
-- ============================================================================

do $$
declare
  t text;
  owner_tables text[] := array[
    'invoices','expenses','contracts','cashflow_history','burn_history',
    'wise_accounts','hedging_contracts','market_signals','leads','projects',
    'scenarios','agent_knowledge_graph','data_sources','recalc_log',
    'commitment_stages'
  ];
begin
  foreach t in array owner_tables loop
    execute format($f$
      create policy "%1$s_select_own" on public.%1$s
        for select using (user_id = auth.uid());
      create policy "%1$s_insert_own" on public.%1$s
        for insert with check (user_id = auth.uid());
      create policy "%1$s_update_own" on public.%1$s
        for update using (user_id = auth.uid()) with check (user_id = auth.uid());
      create policy "%1$s_delete_own" on public.%1$s
        for delete using (user_id = auth.uid());
    $f$, t);
  end loop;
end $$;

-- ============================================================================
-- commitment_transitions: scoped through its parent commitment's owner
-- ============================================================================

create policy "commitment_transitions_select_own" on public.commitment_transitions
  for select using (
    exists (
      select 1 from public.commitment_stages cs
      where cs.id = commitment_transitions.commitment_id and cs.user_id = auth.uid()
    )
  );
create policy "commitment_transitions_insert_own" on public.commitment_transitions
  for insert with check (
    exists (
      select 1 from public.commitment_stages cs
      where cs.id = commitment_transitions.commitment_id and cs.user_id = auth.uid()
    )
  );

-- ============================================================================
-- Global reference tables: readable by any authenticated user; writes are
-- service-role only (Edge Functions), which bypasses RLS entirely.
-- ============================================================================

create policy "market_trends_read" on public.market_trends
  for select to authenticated using (true);
create policy "app_config_read" on public.app_config
  for select to authenticated using (true);
create policy "agent_configs_read" on public.agent_configs
  for select to authenticated using (true);
