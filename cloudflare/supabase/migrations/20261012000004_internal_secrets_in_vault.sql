-- Internal secrets are generated inside Postgres and never leave Supabase.
--   edge_service_key    bearer the scheduler (invoke_edge) sends to the nexus function
--   oauth_state_secret  HMAC key for the Google OAuth state parameter
-- edge_base_url is project specific; set it once per project:
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1', 'edge_base_url');
-- Agent jobs call invoke_edge('nexus/<route>'); foundation jobs call invoke_edge('<function>').
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'edge_service_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'edge_service_key');
  end if;
  if not exists (select 1 from vault.secrets where name = 'oauth_state_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'oauth_state_secret');
  end if;
end $$;

create or replace function public.nexus_internal_secret(p_name text)
returns text language sql security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets
  where name = p_name and p_name in ('edge_service_key', 'oauth_state_secret');
$$;
revoke all on function public.nexus_internal_secret(text) from public, anon, authenticated;
grant execute on function public.nexus_internal_secret(text) to service_role;
