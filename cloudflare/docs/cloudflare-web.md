# Nexus live web on Cloudflare

Nexus live is the application of the LensIQ company. Its web app (`cloudflare/apps/web`) runs on
the Cloudflare Worker **nexuslive** as static assets. Cloudflare Workers Builds builds and deploys
it from this repository; GitHub Actions (`.github/workflows/nexus-web.yml`) only runs the tests and
the build as a check.

| What | Where |
|---|---|
| Worker config | `cloudflare/apps/web/wrangler.jsonc` (name, assets folder, single page app routing, build command) |
| Public Supabase settings | `cloudflare/apps/web/.env.production` (URL and publishable key; secrets never go here) |
| Look and feel | `cloudflare/apps/web/src/lib/theme.ts` (LensIQ colours, fonts, validated chart colours) |
| Menu | `cloudflare/apps/web/src/lib/nav.ts`, checked by `supabase/tests/nav_web_test.ts` |

## One time setup in the Cloudflare dashboard

Workers and Pages, open **nexuslive**, then Settings, Build.

1. Git repository: this repository (already connected).
2. Root directory: `cloudflare/apps/web`
3. Build command: leave empty. `wrangler.jsonc` runs `pnpm install --frozen-lockfile && pnpm run build` itself.
4. Deploy command: `npx wrangler deploy` (the default).
5. Non-production branch deploy command: `npx wrangler versions upload` (the default; gives a preview link per branch).
6. Production branch: the branch that holds the web app. Today that is `feat/supabase-foundation`; switch it to `main` once that branch is merged.
7. Build watch paths, include: `cloudflare/apps/web/*`, `cloudflare/packages/*`, `cloudflare/supabase/functions/_shared/fiscal/*`, `cloudflare/pnpm-lock.yaml`.
8. Retry the last build (Deployments, then Retry) or push a change. When it is green the app answers on the Worker's `workers.dev` address.

## Supabase settings for each new address

Authentication, URL Configuration in the Supabase project:

- Redirect URLs: add `https://<worker>.workers.dev/**` to try the app there before the domain moves.
- Site URL: the address people sign in on (`https://app.lensiq.company`). The OAuth server's
  authorization path `/oauth/consent` is relative to it, so Claude Code's consent page moves with it.

## Moving app.lensiq.company to the Worker

GitHub Pages serves `app.lensiq.company` today (branch `gh-pages`). The domain moves in one go:

1. Check the app on the `workers.dev` address first: sign in, open Look-through and Review.
2. Cloudflare, zone `lensiq.company`, DNS, Records: delete the `app` CNAME that points at GitHub Pages.
3. Worker **nexuslive**, Settings, Domains and Routes, Add, Custom domain: `app.lensiq.company`. Cloudflare creates the record and the certificate.
4. GitHub, this repository, Settings, Pages: remove the custom domain and turn Pages off, so `gh-pages` stops serving.

## Later: one site on lensiq.company

The decision is one site: the public LensIQ pages stay on `lensiq.company` and Nexus live sits
behind sign-in on the same address. That change lives in the repository of the **lensiq** Worker,
which is not this one; it waits until that repository is known.
