-- Privacy hardening: who may have an account, and who may change the books.

-- 1. Accounts only for allow-listed emails (app_config auth.allowed_emails).
--    Blocks sign-ups by anyone else, whatever the dashboard setting says.
insert into public.app_config (key, value, description) values
('auth.allowed_emails', '["deenikdaniel@gmail.com"]', 'Only these emails may create an account (JSON array)')
on conflict (key) do nothing;

create or replace function public.enforce_signup_allowlist()
returns trigger language plpgsql security definer set search_path = public as $$
declare allowed jsonb;
begin
  select value::jsonb into allowed from public.app_config where key = 'auth.allowed_emails';
  if allowed is null or not (allowed ? lower(new.email)) then
    raise exception 'sign-up is not open for this address' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.enforce_signup_allowlist() from public, anon, authenticated;

create or replace trigger enforce_signup_allowlist
  before insert on auth.users
  for each row execute function public.enforce_signup_allowlist();

-- 2. The books change only through the agents and review-decide (service
--    role). Restrictive policies AND with the existing permissive ones, so a
--    signed-in browser can read its own rows but never write them directly.
create policy "expenses_no_direct_write_ins" on public.expenses as restrictive for insert to authenticated with check (false);
create policy "expenses_no_direct_write_upd" on public.expenses as restrictive for update to authenticated using (false);
create policy "expenses_no_direct_write_del" on public.expenses as restrictive for delete to authenticated using (false);
create policy "invoices_no_direct_write_ins" on public.invoices as restrictive for insert to authenticated with check (false);
create policy "invoices_no_direct_write_upd" on public.invoices as restrictive for update to authenticated using (false);
create policy "invoices_no_direct_write_del" on public.invoices as restrictive for delete to authenticated using (false);
create policy "fixed_assets_no_direct_write_ins" on public.fixed_assets as restrictive for insert to authenticated with check (false);
create policy "fixed_assets_no_direct_write_upd" on public.fixed_assets as restrictive for update to authenticated using (false);
create policy "fixed_assets_no_direct_write_del" on public.fixed_assets as restrictive for delete to authenticated using (false);
create policy "kg_no_direct_write_ins" on public.agent_knowledge_graph as restrictive for insert to authenticated with check (false);
create policy "kg_no_direct_write_upd" on public.agent_knowledge_graph as restrictive for update to authenticated using (false);
create policy "kg_no_direct_write_del" on public.agent_knowledge_graph as restrictive for delete to authenticated using (false);

-- 3. A user may edit their own profile settings, but not their role or plan.
create or replace function public.protect_profile_privileges()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
              current_setting('request.jwt.claim.role', true), '') = 'authenticated'
     and (new.role is distinct from old.role or new.plan is distinct from old.plan
          or new.invited_by is distinct from old.invited_by or new.email is distinct from old.email) then
    raise exception 'role, plan and email are managed by the service' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.protect_profile_privileges() from public, anon, authenticated;

create or replace trigger protect_profile_privileges
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();

-- 4. Receipts are immutable evidence: no client-side overwrite or delete
--    (no update/delete policy exists on storage.objects for this bucket), and
--    the bucket stays private.
