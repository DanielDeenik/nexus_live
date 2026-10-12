# Nexus — Supabase Foundation (Design Spec)

Date: 2026-08-10
Status: Approved for planning
Scope: Foundation only. Financial-data linking, the job-scraping agent, and the
terminal UI restyle are separate sub-project specs that build on this.

## 1. Context & decision

Nexus currently runs Cloudflare-native: a Hono API on Workers, Cloudflare D1
(SQLite) as the database, KV for cache, R2 for files, custom JWT auth. The daily
recalc has been deploy-blocked on this stack for ~10 days.

Decision (locked with the user): move the data layer and backend logic to
Supabase; rehome hosting off Workers. This is a clean cutover — current DB
contents are dummy seed data (migration `0004_seed_dummy_data.sql`), so there is
no production-data migration risk.

Backend style (locked): **hybrid**. The React app talks to Supabase directly for
plain CRUD (guarded by Row-Level Security); server-side Edge Functions are used
only for work that needs secret keys or orchestration (integration syncs, agent
runs, webhooks, cron).

### Target architecture

| Concern | Today | Target |
|---|---|---|
| Database | Cloudflare D1 (SQLite) | Supabase Postgres |
| Auth | Custom JWT + sessions + api_tokens | Supabase Auth (email + Google/LinkedIn OAuth) |
| CRUD API | Hono routes on Workers | Direct `supabase-js` from the SPA, RLS-scoped |
| Privileged logic | Hono routes | Supabase Edge Functions (Deno) |
| Cron | Cloudflare cron triggers | `pg_cron` → Edge Function / SQL routine |
| Cache | Cloudflare KV | Postgres tables / function-level; KV retired |
| File storage | Cloudflare R2 | Supabase Storage |
| LLM for agents | Cloudflare Workers AI (`[[ai]]`, Llama) | Anthropic/Gemini over HTTP |
| Frontend host | (Workers-adjacent) | Cloudflare Pages (static React) |

## 2. Schema port (D1 SQLite → Postgres)

Port all 22 tables. Global type conventions (no hardcoded values — types carry
meaning):

- Primary keys: `text` → `uuid default gen_random_uuid()`.
- `user_id`: `text` → `uuid`, referencing the owning user (see §3).
- Money (`amount`, `rate`, `revenue`, `costs`, `profit`, `balance`,
  `locked_rate`, `monthly_burn`, …): `REAL` → `numeric(14,2)`. Floating-point
  money is a latent bug; fix it in the migration.
- Timestamps (`*_at`, `*_date` stored as text): → `timestamptz`
  (date-only fields such as `issued_date`, `due_date`, `month` may stay `date`).
- Booleans stored as `INTEGER` (`is_jar`, `enabled`): → `boolean`.
- JSON text columns (`config_json`, `extracted_json`, `context_json`,
  `output_json`, `steps_json`, `data_json`): → `jsonb`.
- `CHECK (… IN (…))` constraints: preserved as Postgres CHECK constraints (kept
  as CHECKs rather than enums so adding a value is a one-line migration).

Tables ported: `profiles` (was `users`, see §3), `invoices`, `expenses`,
`contracts`, `cashflow_history`, `burn_history`, `wise_accounts`,
`hedging_contracts`, `market_signals`, `market_trends`, `leads`, `projects`,
`scenarios`, `agent_configs`, `agent_knowledge_graph`, `data_sources`,
`app_config`, `recalc_log`, `commitment_stages`, `commitment_transitions`.

Dropped (replaced by Supabase Auth): `api_tokens`, `sessions`, and the
`password_hash` column.

`data_sources.type` CHECK gains `gocardless` (EU/NL bank aggregator) alongside
the existing `notion`/`moneybird`/`plaid`/`wise`/`stripe`/`zapier`/`custom_api`.

Note: `market_signals` already models a scored job/opportunity feed (title,
company, location, `score`, `tier` hot/warm/monitor, `source_url`,
`jurisdiction`). The job-scraping agent sub-project writes into this table — no
new schema needed there.

## 3. Auth cutover

- Identity moves to Supabase `auth.users` (email/password + Google & LinkedIn
  OAuth providers — the old `users` table already carried `google_id` /
  `linkedin_id`).
- A `public.profiles` table holds app-level identity: `id uuid primary key
  references auth.users(id) on delete cascade`, plus `name`, `avatar_url`,
  `role`, `plan`, `base_currency`, `monthly_burn`, `created_at`.
- A trigger (`on auth.users insert`) auto-creates the matching `profiles` row.
- All `user_id` foreign keys reference `profiles(id)` (= `auth.uid()`).
- Custom crypto/JWT/session/api-token code in `apps/api` is removed.

## 4. Row-Level Security

- RLS enabled on every user-scoped table.
- Standard policy per table: `using (user_id = auth.uid())` for select/update/
  delete, and `with check (user_id = auth.uid())` for insert.
- `profiles`: `id = auth.uid()`.
- Global reference tables without a `user_id` (`market_trends`, `app_config`,
  `agent_configs`): readable by authenticated users; writes restricted to the
  service role (Edge Functions).
- Edge Functions use the service-role key and bypass RLS deliberately for sync/
  agent writes; they always set `user_id` explicitly.

## 5. Backend — hybrid

Direct from the SPA via `supabase-js` (RLS-enforced): reads/writes for
`invoices`, `expenses`, `contracts`, `scenarios`, `projects`, `leads`,
dashboard summary queries, commitment views.

Edge Functions (Deno, service-role) — one function per concern:

- `sync-moneybird`, `sync-wise`, `sync-stripe`, `sync-bank` (GoCardless) —
  pull external data, upsert into Postgres, update `data_sources.last_sync_at`/
  `sync_status`. HTTP logic reuses `apps/api/src/integrations/*.ts` (plain
  `fetch`, `import type` only). Porting effort: the external-fetch code moves
  almost verbatim; each module currently takes a `D1Database` handle and
  reads/writes through it, so the DB access layer is swapped to the Supabase
  Postgres client. `integrations/fx-rates.ts` additionally uses KV for caching —
  its cache is reimplemented as a Postgres table (see §6).
- `run-agents` — invokes the orchestrator + agents (`base-agent`, `cashflow`,
  `commitment`, `hedge`, `market`, `tax`). This is a **rewrite, not a verbatim
  port** (see §5a): the LLM call, cache, and rate limiter are all Cloudflare-
  bound today.
- `recalc` — the daily recalculation currently in `apps/api/src/cron/recalc.ts`.
- Webhook receivers as needed (e.g. Stripe events).

Secrets live in Supabase Edge Function secrets / Vault, never in the client.

### 5a. Agent-layer rework (called out explicitly)

The agent framework is more Cloudflare-coupled than a straight port implies, and
these three items are in-scope for the foundation:

- **LLM layer.** `base-agent.ts` calls `env.AI.run('@cf/meta/llama-2-7b-chat-int8', …)`
  via the Workers AI binding. Replace with an HTTP LLM client (Anthropic and/or
  Gemini, provider + model read from `agent_configs`, key from function secrets).
- **Cache + rate limiter.** `base-agent.ts` uses KV (`env.CACHE`) for insight
  caching and the per-agent per-day rate limit. Reimplement both against
  Postgres tables (a cache table with TTL column, and a counter table keyed by
  agent + day).
- **Schema-drift bug fixes.** The current agent code writes to a non-existent
  `agent_execution_log` table and writes `agent_knowledge_graph` with columns
  (`category/key/value/source`) that don't match the real schema
  (`entry_type/context_json/output_json/confidence`). Reconcile during the port:
  add `agent_execution_log` to the schema (or route to `recalc_log`) and align
  the knowledge-graph writes to the real columns.

## 6. Cron

A Postgres cache table (key, value jsonb, expires_at) replaces KV for the
fx-rates cache and agent-insight cache; a small counter table replaces the KV
rate limiter. `pg_cron` schedules:
- daily `recalc` (the job that's currently deploy-blocked),
- periodic integration syncs,
- the market/job agent run.

Each schedule invokes the corresponding Edge Function (via `pg_net`/`http`) or a
SQL routine. This removes the Cloudflare deploy path entirely for scheduled work.

## 7. Hosting & repo structure

- Frontend: Cloudflare Pages, static build of `apps/web`. Only change is the API
  client — swap the custom fetch client for `supabase-js` plus function calls.
  The terminal restyle (separate sub-project) also lands here.
- Backend: Supabase (Postgres + Auth + Edge Functions + Storage + pg_cron).
- New `/supabase` directory: `migrations/` (SQL), `functions/` (Edge Functions),
  `config.toml`, `seed.sql`.
- `apps/api` (Hono/Workers) retired after cutover; `wrangler.toml`, D1/KV/R2
  bindings removed.

## 8. Configuration (no hardcoded values)

A single `.env.example` documents every key the build reads; nothing is inlined:
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`MONEYBIRD_API_TOKEN`, `MONEYBIRD_ADMINISTRATION_ID`, `WISE_API_KEY`,
`GOCARDLESS_SECRET_ID`, `GOCARDLESS_SECRET_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY` (and/or `GEMINI_API_KEY`).
App-tunable values (base currency default, agent models, rate limits) stay in the
`app_config` / `agent_configs` tables, not in code.

## 9. What the build produces vs. what the user must do

Claude builds: Postgres migrations, RLS policies, the `profiles` trigger, all
Edge Functions, `pg_cron` schedules, the SPA data-layer swap, `.env.example`,
and a setup runbook.

The user must (cannot be done in-session — live credentials): create the Supabase
project; add OAuth apps (Google, LinkedIn); obtain and paste API keys for
Moneybird, Wise, GoCardless, Stripe; run the migrations and deploy functions per
the runbook.

## 10. Cutover sequence (high level; detailed plan follows)

1. Stand up Supabase project + schema migrations + RLS.
2. Wire Supabase Auth into the SPA; swap the data client to `supabase-js`.
3. Port integration + agent + recalc logic into Edge Functions.
4. Wire `pg_cron` schedules.
5. Deploy SPA to Cloudflare Pages against Supabase.
6. Decommission `apps/api` Workers + D1/KV/R2.

## 11. Non-goals (this spec)

- Actual credential entry / live data linking (separate sub-project).
- Job-scraping agent source selection and scoring logic (separate sub-project).
- Terminal UI restyle (separate, parallel sub-project).
- Realtime subscriptions, multi-user/team features, billing.
