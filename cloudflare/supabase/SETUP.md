# Nexus — Supabase foundation setup runbook

Everything in `supabase/` and the frontend wiring is built. These are the steps
only you can do (they need live credentials). Follow top to bottom.

## 0. Prerequisites

```bash
npm install -g supabase        # Supabase CLI
supabase --version
```

## 1. Create the project

1. Create a project at https://supabase.com/dashboard (pick an EU region for NL
   data residency).
2. Note the project ref, the anon key, and the service-role key
   (Project settings → API).

```bash
cd cloudflare
supabase login
supabase link --project-ref YOUR-PROJECT-REF
```

## 2. Apply the schema

```bash
supabase db push        # runs supabase/migrations/*.sql in order
```

This creates all tables, RLS policies, the profile trigger, the cache/rate-limit
infra, seeds `app_config` + the 6 agents, and installs the pg_cron jobs.

## 3. Auth providers (optional but recommended)

In the dashboard → Authentication → Providers, enable Google and LinkedIn (OIDC)
and paste each client id/secret. Set the site URL to your SPA origin.

## 4. Function secrets

```bash
supabase secrets set \
  ANTHROPIC_API_KEY=... \
  WEB_ORIGIN=https://your-app.pages.dev \
  MONEYBIRD_API_TOKEN=... \
  WISE_API_KEY=... \
  STRIPE_SECRET_KEY=... \
  GOCARDLESS_SECRET_ID=... \
  GOCARDLESS_SECRET_KEY=...
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## 5. Deploy the Edge Functions

```bash
supabase functions deploy sync-moneybird sync-wise sync-stripe sync-bank run-agents recalc
```

## 6. Wire pg_cron secrets (Vault)

The cron jobs call the functions using two Vault secrets. Run once in the SQL
editor (Database → SQL):

```sql
select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co/functions/v1', 'edge_base_url');
select vault.create_secret('YOUR-SERVICE-ROLE-KEY', 'edge_service_key');
```

Cadence is configurable in `app_config` (`cron.recalc_schedule`,
`cron.sync_integrations_schedule`, `cron.feed_refresh_schedule`).

## 7. Link your financial data (per source)

For each source, insert one `data_sources` row. Non-secret identifiers live in
`config_json`; the API keys are the secrets from step 4.

```sql
-- Moneybird
insert into data_sources (user_id, type, config_json)
values (auth.uid(), 'moneybird', '{"administration_id":"123456789"}');

-- Wise
insert into data_sources (user_id, type, config_json)
values (auth.uid(), 'wise', '{"profile_id":"12345678"}');

-- Stripe (no extra id needed)
insert into data_sources (user_id, type, config_json)
values (auth.uid(), 'stripe', '{}');

-- Bank via GoCardless (account_id from the requisition flow)
insert into data_sources (user_id, type, config_json)
values (auth.uid(), 'gocardless', '{"account_id":"..."}');
```

Trigger a sync now instead of waiting for cron:

```bash
supabase functions invoke sync-moneybird
```

## 8. Frontend

```bash
cd apps/web
cp ../../.env.example .env      # fill VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
pnpm install                    # pulls @supabase/supabase-js
pnpm typecheck                  # verify the TS changes
pnpm dev
```

Auth now runs through Supabase; direct data access uses `src/lib/data.ts`.

## 9. Deploy the SPA

Build `apps/web` and deploy to Cloudflare Pages (static). Set the two `VITE_`
vars as Pages environment variables. Point `WEB_ORIGIN` (step 4) and the auth
site URL (step 3) at the Pages URL.

## 10. Decommission the old backend

Once verified, delete the Workers API and its bindings:
- remove `apps/api` from the deploy pipeline,
- delete the D1 database, KV namespace, R2 bucket, and the `[[ai]]` binding.

---

## What still needs doing after this (tracked as separate sub-projects)

- Page/query rewrite: the 10 pages still import `useApi(path)` against the old
  REST endpoints. They migrate onto `src/lib/data.ts` during the terminal
  restyle (which rewrites the pages anyway).
- Financial-linking sub-project: refine the Stripe/GoCardless field mappings and
  add the GoCardless requisition (bank-consent) flow.
- Job-scraping agent sub-project: point the market agent at real gig sources
  writing scored rows into `market_signals`.
