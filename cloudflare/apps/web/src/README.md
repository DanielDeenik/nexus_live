# Nexus web app

React 19, Vite, Tailwind and react-router. All data comes from Supabase under
Row-Level Security (`lib/supabase.ts`); changes that agents must validate go
through the `nexus` Edge Function (`callNexus` in `lib/nexus.ts`). Tunable
numbers live in `app_config` or `tax_parameters`, never in code.

## Pages

| Menu | Path | Page | Data |
|---|---|---|---|
| Income & Tax | `/` | `pages/IncomeTax.tsx` | invoices, time_entries, expenses, tax_parameters |
| Forecast | `/forecast` | `pages/Forecast.tsx` | invoices, dt_billable_vs_invoiced, app_config `forecast.*`, tax_parameters |
| Review | `/review` | `pages/Review.tsx` | review_items |
| Expenses | `/expenses` | `pages/Expenses.tsx` | expenses, fixed_assets |
| Tax filings | `/tax` | `pages/TaxFilings.tsx` | tax_filings |
| Time | `/time`, `/time/entries`, `/time/projects`, `/time/flow` | `pages/time/*` | dt_* tables and RPCs |
| Recruiter | `/recruiter`, `/recruiter/fit`, `/recruiter/applications`, `/recruiter/roles` | `pages/recruiter/*` | rec_* tables |
| LinkedIn | `/linkedin` | `pages/linkedin/LinkedInOverview.tsx` | li_summary RPC, li_imports |
| Settings | `/settings` | `pages/Settings.tsx` (sections in `pages/settings/`) | profiles, integration_connections, dt_device_tokens |

Old addresses redirect: `/agent-settings` to `/settings#agents` (keeping the
query string the Google sign-in callback carries), `/time/devices` to
`/settings#devices`, `/linkedin/imports` to `/linkedin#import-history`, and
anything unknown to `/`.

## Forecast maths

`lib/forecast.ts` is pure (no imports) so it runs in the browser and under
`deno test supabase/tests/forecast_web_test.ts --allow-read`. `lib/forecastData.ts`
does the Supabase reads.

## Adding a page

1. Create the page in `src/pages/`.
2. Add its route in `App.tsx`, its menu item in `components/Sidebar.tsx` and
   its title in `components/Header.tsx`.
