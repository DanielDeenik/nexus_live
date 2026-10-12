-- Nexus — Supabase foundation: scheduled work via pg_cron + pg_net.
-- Replaces Cloudflare cron triggers. Schedules are read from app_config so the
-- cadence stays configurable; the Edge base URL and service-role key are read
-- from Vault (never hardcoded) — populate them in the setup runbook:
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'edge_base_url');
--   select vault.create_secret('<service-role-key>', 'edge_service_key');

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Calls an Edge Function by name, authenticated with the service-role key.
create or replace function public.invoke_edge(fn text, body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer set search_path = public, vault, extensions
as $$
declare
  base text;
  key text;
  req_id bigint;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'edge_base_url';
  select decrypted_secret into key  from vault.decrypted_secrets where name = 'edge_service_key';
  if base is null or key is null then
    raise notice 'invoke_edge: edge_base_url / edge_service_key not set in Vault; skipping %', fn;
    return null;
  end if;
  select net.http_post(
    url     := base || '/' || fn,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || key),
    body    := body
  ) into req_id;
  return req_id;
end;
$$;

-- (Re)schedule a cron job using a cadence stored in app_config.
create or replace function public.schedule_from_config(job_name text, cfg_key text, command text)
returns void
language plpgsql
security definer set search_path = public, cron
as $$
declare
  sched text;
begin
  select value into sched from public.app_config where key = cfg_key;
  if sched is null then
    raise notice 'schedule_from_config: no schedule for %, skipping', cfg_key;
    return;
  end if;
  if exists (select 1 from cron.job where jobname = job_name) then
    perform cron.unschedule(job_name);
  end if;
  perform cron.schedule(job_name, sched, command);
end;
$$;

-- Daily recalc (cron.recalc_schedule, default 06:00 UTC).
select public.schedule_from_config('nexus-recalc', 'cron.recalc_schedule',
  $$select public.invoke_edge('recalc')$$);

-- Integration syncs (cron.sync_integrations_schedule, default 02:00 UTC).
select public.schedule_from_config('nexus-sync-moneybird', 'cron.sync_integrations_schedule',
  $$select public.invoke_edge('sync-moneybird')$$);
select public.schedule_from_config('nexus-sync-wise', 'cron.sync_integrations_schedule',
  $$select public.invoke_edge('sync-wise')$$);
select public.schedule_from_config('nexus-sync-stripe', 'cron.sync_integrations_schedule',
  $$select public.invoke_edge('sync-stripe')$$);
select public.schedule_from_config('nexus-sync-bank', 'cron.sync_integrations_schedule',
  $$select public.invoke_edge('sync-bank')$$);

-- Agent swarm (cron.feed_refresh_schedule, default every 4 hours).
select public.schedule_from_config('nexus-run-agents', 'cron.feed_refresh_schedule',
  $$select public.invoke_edge('run-agents')$$);
