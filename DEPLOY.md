# Nexus Live — Deploying to hustle1000.com (Multi-User SaaS)

This guide deploys your tool as a **multi-user SaaS** at `app.hustle1000.com`.
Stack: **Railway** (Node.js hosting) + **Google Domains** (CNAME pointing to Railway).

---

## 1. Pre-deployment checklist

The codebase is multi-user ready as of commit `ff07f56`:

- ✅ SQL DB with per-user tables (users, profiles, configs, files)
- ✅ Passport auth: LinkedIn OAuth, Google OAuth, email + password, magic-link
- ✅ Per-user store isolation (`lib/userStore.js` — each user's config/PIN/profile isolated)
- ✅ Session cookies: httpOnly, secure, sameSite=lax
- ✅ Magic-link tokens: SHA-256 hashed, 15-min TTL, 60-sec rate-limit
- ✅ OAuth CSRF state: `crypto.randomBytes(16)`

---

## 2. Deploy to Railway

### 2a. Create the project

1. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
2. Authorise Railway to access your GitHub
3. Select the `nexus_live` repository

Railway auto-detects Node.js and will run `npm start`.

### 2b. Add a persistent volume (important — prevents data loss on redeploy)

Railway's container filesystem resets on every deploy. Before the first deploy:

1. Railway → your service → **Volumes** → **Add Volume**
2. Mount path: `/app/data`

This keeps the SQLite DB (`data/nexus.db`), the local store (`data/nexus-store.json`), and session files across restarts and deploys.

### 2c. Set environment variables

Railway → your project → **Variables** → add each of these:

| Variable | Value | Notes |
|----------|-------|-------|
| `SESSION_SECRET` | 64-char random string | **Required — must be set before first user signs up** |
| `NODE_ENV` | `production` | Enables secure cookies |
| `BASE_URL` | `https://app.hustle1000.com` | Used in magic-link emails |
| `LINKEDIN_CLIENT_ID` | your LinkedIn app client ID | LinkedIn OAuth login |
| `LINKEDIN_CLIENT_SECRET` | your LinkedIn app secret | — |
| `LINKEDIN_CALLBACK_URL` | `https://app.hustle1000.com/auth/linkedin/callback` | Must match LinkedIn app settings exactly |
| `GOOGLE_CLIENT_ID` | your Google OAuth client ID | Google login |
| `GOOGLE_CLIENT_SECRET` | your Google OAuth secret | — |
| `GOOGLE_CALLBACK_URL` | `https://app.hustle1000.com/auth/google/callback` | Must match Google Console exactly |
| `SMTP_HOST` | e.g. `smtp.gmail.com` | Magic-link emails (optional — logs to console if absent) |
| `SMTP_PORT` | `587` | — |
| `SMTP_USER` | your email address | — |
| `SMTP_PASS` | Gmail App Password | Never use your real Gmail password |
| `SMTP_FROM` | `Nexus <noreply@hustle1000.com>` | From-name shown in emails |
| `SANDBOX_USER` | (optional) e.g. `admin` | HTTP basic auth gate — omit to disable |
| `SANDBOX_PASS` | (optional) password | — |
| `NOTION_TOKEN` | your Notion integration token | Optional — for Notion sync |
| `DB_PROFILE` | your Notion Profile DB ID | Optional |

**Generate a secure SESSION_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2d. Add the custom domain in Railway

1. Railway → your service → **Settings → Domains → Add Custom Domain**
2. Enter: `app.hustle1000.com`
3. Railway shows a **CNAME target** (e.g. `nexus-live.up.railway.app`) — copy it for the next step

---

## 3. Configure DNS in Google Domains

1. Go to [domains.google.com](https://domains.google.com)
2. Select `hustle1000.com` → **DNS → Manage custom records**
3. Click **Create new record**:

| Host name | Type | TTL | Data |
|-----------|------|-----|------|
| `app` | `CNAME` | `3600` | ← paste Railway's CNAME target here |

4. Click **Save**

DNS propagates in 5–30 minutes. Railway auto-provisions a free TLS certificate (Let's Encrypt) once it detects the CNAME.

---

## 4. Update OAuth callback URLs

### LinkedIn

1. [linkedin.com/developers](https://www.linkedin.com/developers/apps) → your app → **Auth tab**
2. Under **Authorized redirect URLs**, add:
   ```
   https://app.hustle1000.com/auth/linkedin/callback
   ```

### Google

1. [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services → Credentials** → your OAuth client
2. Under **Authorized redirect URIs**, add:
   ```
   https://app.hustle1000.com/auth/google/callback
   ```

---

## 5. Verify the deployment

Once DNS is propagated and Railway shows the deploy as healthy:

```bash
# Health check — should return {"ok":true,...}
curl https://app.hustle1000.com/health

# OAuth providers — shows which login methods are active
curl https://app.hustle1000.com/auth/providers
```

Then open `https://app.hustle1000.com` in a browser — you should see the Nexus login screen.

---

## 6. How multi-user isolation works

Every authenticated user gets their own namespace in the JSON store:

| Data | Store key (per user) |
|------|---------------------|
| Config (name, rates, currency, etc.) | `u{id}:config` |
| PIN hash | `u{id}:auth` |
| AI-built search profile | `u{id}:profile` |
| Expenses, contracts, scenarios | SQL table rows with `user_id` FK (already isolated) |

Your existing personal data (saved before this update) is readable as user 1 via automatic backward-compat fallback — nothing is lost.

---

## 7. Deployment summary checklist

| Step | Status |
|------|--------|
| Push code to GitHub | ☐ |
| Create Railway project from repo | ☐ |
| Add Railway Volume at `/app/data` | ☐ |
| Set all required env vars in Railway | ☐ |
| Add `app.hustle1000.com` domain in Railway | ☐ |
| Copy CNAME target from Railway | ☐ |
| Add CNAME record in Google Domains | ☐ |
| Add callback URLs in LinkedIn developer app | ☐ |
| Add callback URLs in Google Cloud Console | ☐ |
| Visit `https://app.hustle1000.com` | ☐ |
