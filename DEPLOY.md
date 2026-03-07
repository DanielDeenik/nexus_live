# Nexus Live — Sandbox Deployment Guide

Deploy a shared hosted instance so testers can access the dashboard via a URL, no local setup needed.

---

## What Gets Deployed

- The Nexus Live Node.js dashboard (port 3333)
- Password-protected via HTTP Basic Auth (`SANDBOX_USER` / `SANDBOX_PASS`)
- Connected to **your existing Notion workspace** (read + write)
- Budget App integration disabled by default in hosted mode (runs locally only)

---

## Option A — Render (Recommended, easiest)

**Cost:** Free tier available · Starter ($7/mo) for always-on
**Time:** ~10 minutes

### Step 1 — Push to GitHub
```bash
cd nexus_live
git init          # if not already a repo
git add .
git commit -m "Add deployment config"
gh repo create nexus-live --private --push --source=.
```
Or push to an existing private repo.

### Step 2 — Create Render Web Service
1. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Web Service**
2. Connect your GitHub repo
3. Render auto-detects the `render.yaml` — click **Apply**

### Step 3 — Set Environment Variables
In Render Dashboard → your service → **Environment**, add:

| Variable | Value | Notes |
|----------|-------|-------|
| `NOTION_TOKEN` | `ntn_xxx...` | From your Notion integration |
| `DB_PROFILE` | `b0e5a566-...` | From your `.env` |
| `DB_EXPENSES` | `fee01210-...` | From your `.env` |
| `DB_CONTRACTS` | `240d284d-...` | From your `.env` |
| `DB_SIGNALS` | `fe00287c-...` | From your `.env` |
| `DB_CASHFLOW` | `3841c101-...` | From your `.env` |
| `DB_COMPANIES` | `94fa68ba-...` | From your `.env` |
| `DB_OPPORTUNITIES` | `bddacedc-...` | From your `.env` |
| `DB_HISTORY` | `885597af-...` | From your `.env` |
| `SANDBOX_USER` | `tester` | Share with testers |
| `SANDBOX_PASS` | `nexus-demo-2026` | Choose something memorable |
| `NODE_ENV` | `production` | |
| `PORT` | `3333` | |

### Step 4 — Deploy
Click **Manual Deploy** or push to `main`. Render builds and deploys (~2 min).

### Step 5 — Share with Testers
Send testers:
```
URL:      https://nexus-live-sandbox.onrender.com
Username: tester
Password: nexus-demo-2026
```

---

## Option B — Railway

**Cost:** ~$2–5/month
**Time:** ~8 minutes

### Step 1 — Push to GitHub
Same as Render Step 1 above.

### Step 2 — Deploy
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Step 3 — Set Variables
```bash
railway variables set NOTION_TOKEN=ntn_xxx...
railway variables set DB_PROFILE=b0e5a566-...
railway variables set DB_EXPENSES=fee01210-...
railway variables set DB_CONTRACTS=240d284d-...
railway variables set DB_SIGNALS=fe00287c-...
railway variables set DB_CASHFLOW=3841c101-...
railway variables set DB_COMPANIES=94fa68ba-...
railway variables set DB_OPPORTUNITIES=bddacedc-...
railway variables set DB_HISTORY=885597af-...
railway variables set SANDBOX_USER=tester
railway variables set SANDBOX_PASS=nexus-demo-2026
railway variables set NODE_ENV=production
railway variables set PORT=3333
```

### Step 4 — Get URL
```bash
railway open
```
Railway assigns a `.up.railway.app` URL automatically.

---

## Option C — Docker (any VPS / cloud)

**Cost:** Depends on host
**Time:** ~15 minutes

```bash
# Build image
docker build -t nexus-live .

# Run with env vars
docker run -d \
  -p 3333:3333 \
  -e NOTION_TOKEN=ntn_xxx... \
  -e DB_PROFILE=b0e5a566-... \
  -e DB_EXPENSES=fee01210-... \
  -e DB_CONTRACTS=240d284d-... \
  -e DB_SIGNALS=fe00287c-... \
  -e DB_CASHFLOW=3841c101-... \
  -e DB_COMPANIES=94fa68ba-... \
  -e DB_OPPORTUNITIES=bddacedc-... \
  -e DB_HISTORY=885597af-... \
  -e SANDBOX_USER=tester \
  -e SANDBOX_PASS=nexus-demo-2026 \
  -e NODE_ENV=production \
  --name nexus-sandbox \
  nexus-live
```

Add a reverse proxy (Caddy, nginx, or Cloudflare Tunnel) for HTTPS.

---

## Sandbox Access Control

When `SANDBOX_USER` and `SANDBOX_PASS` are set:
- The app prompts for credentials on every new browser session
- Only `/health` is public (used by uptime monitors)
- If either variable is unset, the app runs without auth (local dev mode)

To change credentials: update the env vars in your platform dashboard and redeploy.

---

## Giving Testers Read-Only Access

By default, testers can use all features including saving data to your Notion workspace. To restrict to read-only:

1. Create a **separate Notion integration** with read-only permissions
2. Create a **demo Notion workspace** with seeded test data:
   ```bash
   # In your local nexus_live directory:
   node seed.js
   ```
3. Use that integration's token as `NOTION_TOKEN` for the sandbox

This way testers see realistic data without touching your real workspace.

---

## Seeding a Demo Workspace

If you want testers to see pre-populated data:

1. Create a new Notion account (or use a secondary workspace)
2. Create the required databases (Profile, Expenses, Contracts, Signals, Cashflow, Companies, Opportunities, History)
3. Share all databases with your integration
4. Copy the database IDs into the sandbox env vars
5. Run the seed script locally against the demo workspace:
   ```bash
   NOTION_TOKEN=ntn_demo... \
   DB_PROFILE=... \
   node seed.js
   ```

---

## Monitoring

Both Render and Railway show logs and uptime automatically.

For external monitoring, use [UptimeRobot](https://uptimerobot.com) (free):
- Monitor URL: `https://your-sandbox-url.onrender.com/health`
- Type: HTTP(s)
- Interval: 5 minutes
- This also prevents Render free-tier cold starts by pinging regularly

---

## Environment Variable Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `NOTION_TOKEN` | ✓ | Notion integration token (`ntn_...`) |
| `DB_PROFILE` | ✓ | Profile database ID |
| `DB_EXPENSES` | ✓ | Expenses database ID |
| `DB_CONTRACTS` | ✓ | Contracts database ID |
| `DB_SIGNALS` | ✓ | Seasonality signals database ID |
| `DB_CASHFLOW` | ✓ | Cashflow database ID |
| `DB_COMPANIES` | ✓ | Companies / leads database ID |
| `DB_OPPORTUNITIES` | ✓ | Opportunities database ID |
| `DB_HISTORY` | ✓ | History database ID |
| `PORT` | — | Defaults to `3333` |
| `NODE_ENV` | — | Set to `production` for hosted |
| `SANDBOX_USER` | — | Basic auth username (omit for no auth) |
| `SANDBOX_PASS` | — | Basic auth password (omit for no auth) |
| `BUDGET_APP_URL` | — | Leave empty in hosted mode |
