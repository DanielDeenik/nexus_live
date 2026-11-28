-- Nexus agents in Claude Code: the registry the mcp function serves, and the
-- schedules it shows. The mcp function reads and runs agents as the signed-in
-- user; approvals stay in Nexus, so nothing here can decide a review item.

-- 1. The registry. Each agent: what Claude Code calls it, the route that runs
--    it for the caller, the body that route takes for a run, the agent_runs id
--    its runs are logged under, the cron job that schedules it, and which
--    extra arguments a run may pass on.
insert into public.app_config (key, value, description) values
  ('mcp.agents',
   '[{"id": "expense", "label": "Expense agent", "does": "Collects receipts and invoices from mail and Drive, reads them and books costs; unclear ones open review items", "route": "nexus/expense-agent", "run_body": {}, "runs_as": "expense", "cron_job": "nexus-expense-agent", "run_args": []},
     {"id": "tax", "label": "Tax agent", "does": "Drafts the VAT quarter and income tax year filings; drafts wait for approval in Nexus", "route": "nexus/tax-agent", "run_body": {}, "runs_as": "tax_drafter", "cron_job": "nexus-tax-agent", "run_args": ["kind", "period"]},
     {"id": "forecast", "label": "Forecast", "does": "Recomputes the live tax reserve, payments, investing and BV forecast", "route": "nexus/forecast", "run_body": {"record_run": true}, "runs_as": "forecast", "cron_job": "nexus-forecast", "run_args": []},
     {"id": "accounts", "label": "Accounts sync", "does": "Pulls balances and lines from the linked banks, Wise and eToro", "route": "nexus/accounts", "run_body": {"action": "sync"}, "runs_as": "accounts_sync", "cron_job": "nexus-accounts-sync", "run_args": []},
     {"id": "spend", "label": "Spend agent", "does": "Reads order mail, matches receipts to bank lines, opens line reviews and keeps the stop list", "route": "spend", "run_body": {"action": "run"}, "runs_as": "spend", "cron_job": "nexus-spend", "run_args": []},
     {"id": "moneybird", "label": "Moneybird sync", "does": "Reads documents from Moneybird and pairs them with cost lines and invoices; writes nothing to Moneybird", "route": "nexus/moneybird", "run_body": {"mode": "sync"}, "runs_as": "moneybird_sync", "cron_job": "nexus-sync-moneybird", "run_args": []},
     {"id": "recruiter", "label": "Recruiter", "does": "Works the recruiter mail intake queue", "route": "nexus/recruiter", "run_body": {"mode": "intake"}, "runs_as": "recruiter", "cron_job": "nexus-recruiter", "run_args": []},
     {"id": "role_monitor", "label": "Role monitor", "does": "Scans the job sources for new roles", "route": "nexus/recruiter", "run_body": {"mode": "roles"}, "runs_as": "role_monitor", "cron_job": "nexus-role-monitor", "run_args": []}]',
   'Agents served to Claude Code by the mcp function. route: the edge function path that runs it for the caller; run_body: the body for a run; runs_as: its agent_runs.agent_id; cron_job: its cron.job name; run_args: extra keys a run may pass on'),
  ('mcp.runs_default', '10', 'Runs the mcp function lists for an agent when none is asked for'),
  ('mcp.runs_max', '50', 'Most runs the mcp function lists for an agent in one call'),
  ('mcp.reviews_max', '50', 'Most open review items the mcp function lists in one call'),
  ('mcp.result_max_chars', '20000', 'Longest agent result the mcp function returns to Claude Code; the rest stays in Nexus'),
  ('mcp.server_name', 'nexus', 'The name Settings suggests for claude mcp add'),
  ('mcp.consent_trusted_hosts', '["localhost", "127.0.0.1", "[::1]", "claude.ai"]', 'Redirect hosts the consent page shows as expected for Claude Code and Claude; any other host gets a warning before approval')
on conflict (key) do nothing;

-- 2. Schedules. cron is not readable by signed-in users; this returns only the
--    jobs the registry names, with their last start and status.
create or replace function public.nx_agent_schedules()
returns table (jobname text, schedule text, active boolean, last_start timestamptz, last_status text)
language sql
stable security definer
set search_path = ''
as $$
  with names as (
    select a ->> 'cron_job' as jobname
    from jsonb_array_elements((select c.value::jsonb from public.app_config c where c.key = 'mcp.agents')) a
  )
  select j.jobname::text, j.schedule::text, j.active,
         d.start_time, d.status::text
  from cron.job j
  join names n on n.jobname = j.jobname
  left join lateral (
    select r.start_time, r.status from cron.job_run_details r
    where r.jobid = j.jobid order by r.start_time desc limit 1
  ) d on true
  where auth.uid() is not null
$$;

revoke all on function public.nx_agent_schedules() from public, anon;
grant execute on function public.nx_agent_schedules() to authenticated;
