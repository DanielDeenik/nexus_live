'use strict';
const crypto           = require('crypto');
const db               = require('../lib/db');
const { currentUserId }      = require('../lib/auth');
const { getSeasonality, getAllAvailable } = require('../lib/seasonalityEngine');
const { getRates, recommendRate }        = require('../lib/rateEngine');
const { parseCV, parseSOW, mergeDocuments } = require('../lib/cvParser');
/**
 * routes/onboard.js — Onboarding wizard API
 *
 * POST /api/onboard/extract          — Upload CV/LinkedIn PDF, returns extracted profile
 * POST /api/onboard/complete         — Save completed profile to Notion Profile DB
 * GET  /api/onboard/seasonality      — Industry-based seasonal patterns (Jan–Dec)
 * GET  /api/onboard/status           — Has the user completed onboarding?
 * GET  /api/onboard/linkedin/auth    — Start LinkedIn OAuth flow (opens in popup)
 * GET  /api/onboard/linkedin/callback— LinkedIn OAuth callback, posts profile to opener
 */

const express    = require('express');
const router     = express.Router();
const https      = require('https');
const { Client } = require('@notionhq/client');

const { parsePdf }        = require('../lib/pdfParser');
const { extractCvProfile } = require('../lib/cvParser');
const { extractWithLLM, isLLMAvailable } = require('../lib/llmProfileExtractor');

// Multer for PDF uploads (memory storage — never writes to disk)
let multer;
try { multer = require('multer'); } catch { multer = null; }

let upload;
if (multer) {
  upload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 20 * 1024 * 1024 },  // 20 MB
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
        cb(null, true);
      } else {
        cb(new Error('Only PDF files are accepted'));
      }
    },
  }).single('cv');
}

// ── Notion helpers ────────────────────────────────────────────────────────────

function notionClient() {
  const token = process.env.NOTION_TOKEN;
  if (!token) return null;  // graceful — local-only mode
  return new Client({ auth: token });
}

function profileDbId() {
  return process.env.DB_PROFILE || null;  // graceful — null if not configured
}

/** Fetch all existing Profile DB rows, keyed by Parameter (title) */
async function fetchExistingRows(notion, dbId) {
  const rows = {};
  let cursor;
  do {
    const resp = await notion.databases.query({
      database_id:  dbId,
      page_size:    100,
      start_cursor: cursor ?? undefined,
    });
    for (const page of resp.results) {
      const param = page.properties['Parameter']?.title?.[0]?.plain_text;
      if (param) rows[param] = page.id;
    }
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return rows;
}

/** Create or update a Profile DB row */
async function upsertRow(notion, dbId, existing, param, value, category, source, confidence = 'Confirmed') {
  if (!value && value !== 0) return; // skip empty values

  const props = {
    'Parameter': { title:     [{ text: { content: String(param).slice(0, 200) } }] },
    'Value':     { rich_text: [{ text: { content: String(value).slice(0, 2000) } }] },
    'Category':  { select:    { name: String(category) } },
    'Source':    { select:    { name: String(source) } },
    'Confidence':{ select:    { name: confidence } },
  };

  if (existing[param]) {
    // Update existing row
    await notion.pages.update({ page_id: existing[param], properties: props });
  } else {
    // Create new row
    await notion.pages.create({ parent: { database_id: dbId }, properties: props });
  }
}

// ── Seasonality data ──────────────────────────────────────────────────────────

// All seasonality now comes from lib/seasonalityEngine.js (live + cached, no hardcoding)
// All rate benchmarks now come from lib/rateEngine.js (scraped + cached, no hardcoding)

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/onboard/extract
 * Upload a CV/LinkedIn PDF — extract profile fields.
 * Returns extracted JSON without saving anything.
 */
router.post('/extract', (req, res, next) => {
  if (!upload) {
    return res.status(503).json({ error: 'PDF upload unavailable — multer not installed' });
  }
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      // Extract raw text from the uploaded PDF
      const parsed  = await parsePdf(req.file.buffer);
      const rawText = parsed.rawText || '';

      // ── LLM-first extraction ──────────────────────────────────────────────
      // Try Claude for intelligent, context-aware extraction.
      // Falls back to regex parser if ANTHROPIC_API_KEY not set.
      let profile;
      if (isLLMAvailable()) {
        profile = await extractWithLLM(rawText);
      }
      if (!profile) {
        // Regex fallback — still useful without an API key
        const regexProfile = extractCvProfile(rawText);
        profile = { ...regexProfile, extractedBy: 'regex' };
      }

      res.json({
        ok:          true,
        profile,
        pages:       req.file.size,
        extractedBy: profile.extractedBy || 'regex',
        llmAvailable: isLLMAvailable(),
      });
    } catch (e) {
      res.status(500).json({ error: `CV parsing failed: ${e.message}` });
    }
  });
});

/**
 * POST /api/onboard/complete
 * Save the completed wizard data to the Notion Profile DB.
 * Body: { identity, rates, preferences, seasonality }
 */
router.post('/complete', async (req, res) => {
  try {
    // Support both legacy { identity, rates, preferences, skills } and the
    // current flat format sent by the onboarding wizard:
    // { name, headline, location, rates:{...}, industry, seasonData, linkedinId }
    const body = req.body || {};
    const isFlat = body.name !== undefined || body.rates !== undefined;

    let identity, rates, preferences, skills;
    if (isFlat) {
      identity    = { name: body.name, headline: body.headline, location: body.location };
      rates       = body.rates || {};
      preferences = { industries: body.industry ? [body.industry] : [] };
      skills      = body.skills || [];
    } else {
      ({ identity = {}, rates = {}, preferences = {}, skills = [] } = body);
    }

    // ── Always save to local store first (zero-key) ────────────────────────
    const cfgPatch = {
      name:              identity.name          || null,
      headline:          identity.headline       || null,
      location:          identity.location       || null,
      hourlyRate:        rates.hourlyRate         || null,
      dayRate:           rates.dayRate            || null,
      availHoursPerWeek: rates.availHoursPerWeek  || 32,
      burn:              rates.burn || rates.monthlyBurn || null,
      savings:           rates.savings            || null,
      vatPct:            rates.vatPct             || 21,
      taxReservePct:     rates.taxReservePct       || 35,
      utilisation:       rates.utilisation         || 75,
      targetIndustries:  preferences.industries    || [],
      linkedinId:        body.linkedinId           || null,
      // Contract fields
      contractStartDate: body.contractStartDate    || null,
      contractMonths:    body.contractMonths        || null,
      // Seasonality preset (written by obApplySeasonPreset — persists across sessions)
      _seasonalityPreset: body._seasonalityPreset  || null,
    };
    // Remove nulls to avoid overwriting real data with null on re-saves
    Object.keys(cfgPatch).forEach(k => cfgPatch[k] === null && delete cfgPatch[k]);
    req.userStore.merge('config', cfgPatch);

    // ── Always respond with local success ─────────────────────────────────
    // Notion sync is best-effort and must NOT block or fail the response.
    res.json({ ok: true, saved: 0, message: 'Saved locally' });

    // ── Optional: async sync to Notion (fire-and-forget) ──────────────────
    const notion = notionClient();
    const dbId   = profileDbId();
    if (!notion || !dbId) return; // local-only mode — done

    (async () => {
      try {
        const existing = await fetchExistingRows(notion, dbId);
        const rows = [];

        // ── Identity ────────────────────────────────────────────────────────
        if (identity.name)          rows.push(['Full Name',          identity.name,          'Identity',   'Self Reported']);
        if (identity.headline)      rows.push(['Professional Title', identity.headline,      'Identity',   'Self Reported']);
        if (identity.email)         rows.push(['Email',              identity.email,         'Identity',   'Self Reported']);
        if (identity.location)      rows.push(['Location',           identity.location,      'Identity',   'Self Reported']);
        if (identity.entityType)    rows.push(['Entity Type',        identity.entityType,    'Identity',   'Self Reported']);
        if (identity.specialty)     rows.push(['Specialty',          identity.specialty,     'Identity',   'Self Reported']);
        if (identity.yearsExp)      rows.push(['Years Experience',   String(identity.yearsExp), 'Identity', 'CV Extracted']);

        // ── Rates & Finances ─────────────────────────────────────────────────
        if (rates.dayRate)          rows.push(['Day Rate EUR',       String(rates.dayRate),   'Rate',       'Self Reported']);
        if (rates.hourlyRate)       rows.push(['Hourly Rate EUR',    String(rates.hourlyRate),'Rate',       'Self Reported']);
        if (rates.monthlyBurn)      rows.push(['Monthly Burn EUR',   String(rates.monthlyBurn),'Identity',  'Self Reported']);
        if (rates.taxReservePct)    rows.push(['Tax Reserve Pct',    String(rates.taxReservePct),'Rate',    'Self Reported']);
        if (rates.vatPct != null)   rows.push(['VAT Pct',             String(rates.vatPct),   'Rate',       'Self Reported']);
        if (rates.currency)         rows.push(['Invoice Currency',   rates.currency,         'Identity',   'Self Reported']);
        if (rates.runway != null)        rows.push(['Runway Months',       String(rates.runway),            'Identity',   'Self Reported']);
        if (rates.availHoursPerWeek)     rows.push(['Avail Hours Per Week', String(rates.availHoursPerWeek), 'Identity',   'Self Reported']);

        // ── Work Preferences ─────────────────────────────────────────────────
        if (preferences.availableFrom) rows.push(['Available From',     preferences.availableFrom, 'Constraint', 'Self Reported']);
        if (preferences.engagementLen) rows.push(['Preferred Engagement Length', preferences.engagementLen, 'Identity', 'Self Reported']);
        if (preferences.workMode)      rows.push(['Work Mode',           preferences.workMode,      'Identity',   'Self Reported']);
        if (preferences.industries?.length) {
          rows.push(['Target Industries', preferences.industries.join(', '), 'Identity', 'Self Reported']);
        }

        // ── Skills ───────────────────────────────────────────────────────────
        const cvSkills    = (skills || []).filter(s => s.source === 'cv' || !s.source);
        const addedSkills = (skills || []).filter(s => s.source === 'manual');
        for (const skill of cvSkills) {
          const n = typeof skill === 'string' ? skill : skill.name;
          if (n) rows.push([n, 'Proficient', 'Skills — Tier 1', 'CV Extracted']);
        }
        for (const skill of addedSkills) {
          const n = typeof skill === 'string' ? skill : skill.name;
          if (n) rows.push([n, 'Proficient', 'Skills — Tier 1', 'Self Reported']);
        }

        for (const [param, value, category, source] of rows) {
          await upsertRow(notion, dbId, existing, param, value, category, source);
        }
        console.log(`[onboard/complete] Notion sync: ${rows.length} rows`);
      } catch (e) {
        console.warn('[onboard/complete] Notion sync failed (non-fatal):', e.message);
      }
    })();

  } catch (e) {
    console.error('[onboard/complete]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/onboard/seasonality?industries=Asset+Management,Banking
 * Returns monthly seasonality data for given industries.
 */
router.get('/seasonality', async (req, res) => {
  const rawIndustries = req.query.industries || '';
  const location      = req.query.location   || 'NL';
  const industries    = rawIndustries.split(',').map(i => i.trim()).filter(Boolean);
  const industry      = industries[0] || 'default';

  try {
    // Live seasonality — falls back to preset if Trends unavailable
    const season = await getSeasonality(industry, location, db);
    res.json({
      ok:        true,
      industry:  season.industry,
      location:  season.location,
      months:    season.months,
      data:      season.data,
      peak:      season.peak,
      slow:      season.slow,
      source:    season.source,
      fresh:     season.fresh,
      available: getAllAvailable(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/onboard/rates — Live market rate benchmarks for given skills/seniority/industry
 */
router.get('/rates', async (req, res) => {
  const { skills = '', seniority = 'Senior', industry = 'default', location = 'NL' } = req.query;
  const skillsArr = skills.split(',').map(s => s.trim()).filter(Boolean);

  try {
    const userId    = currentUserId(req);
    const profile   = db.profiles.get(userId) || {};
    const rates     = await getRates({
      skills:   skillsArr.length ? skillsArr : profile.skills || [],
      seniority: seniority || profile.seniority || 'Senior',
      industry:  industry  || (profile.industries || [])[0] || 'default',
      location,
      db,
    });
    const recommendation = recommendRate(profile, rates);

    res.json({ ok: true, ...rates, recommendation });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/onboard/status
 * Returns whether onboarding has been completed (name is set in Profile DB).
 */
router.get('/status', async (req, res) => {
  // First: check local store (fast, no network)
  const localCfg = req.userStore.get('config') || {};
  if (localCfg.name) {
    return res.json({ ok: true, completed: true, name: localCfg.name, source: 'local' });
  }

  // Fallback: check Notion (optional, only if configured)
  try {
    const notion = notionClient();
    const dbId   = profileDbId();
    if (!notion || !dbId) {
      return res.json({ ok: true, completed: false, name: null, source: 'local' });
    }

    const resp = await notion.databases.query({
      database_id: dbId,
      filter: { property: 'Parameter', title: { equals: 'Full Name' } },
      page_size: 1,
    });

    const page = resp.results[0];
    const name = page?.properties?.['Value']?.rich_text?.[0]?.plain_text || null;
    res.json({ ok: true, completed: !!name, name, source: 'notion' });
  } catch (e) {
    // Notion unreachable — treat as not completed, don't block onboarding
    res.json({ ok: true, completed: false, name: null, source: 'fallback', error: e.message });
  }
});

// ── LinkedIn OAuth ────────────────────────────────────────────────────────────

const LI_AUTH_URL    = 'https://www.linkedin.com/oauth/v2/authorization';
const LI_TOKEN_URL   = 'https://www.linkedin.com/oauth/v2/accessToken';
const LI_USERINFO    = 'https://api.linkedin.com/v2/userinfo';
const LI_SCOPES      = 'openid profile email';

function liConfig() {
  const clientId     = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri  = process.env.LINKEDIN_REDIRECT_URI ||
                       'http://localhost:3333/api/onboard/linkedin/callback';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri };
}

/** Simple HTTPS GET/POST helper (no extra deps) */
function httpsRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method,
      headers,
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * GET /api/onboard/linkedin/auth
 * Redirects the browser (popup) to LinkedIn's consent screen.
 */
router.get('/linkedin/auth', (req, res) => {
  const cfg = liConfig();
  if (!cfg) {
    return res.status(503).send(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#0f1117;color:#e8eaf2">
        <h3>LinkedIn not configured</h3>
        <p>Add <code>LINKEDIN_CLIENT_ID</code> and <code>LINKEDIN_CLIENT_SECRET</code> to your <code>.env</code> file.</p>
        <p>Create a free app at <a href="https://www.linkedin.com/developers/" style="color:#6c7aff" target="_blank">linkedin.com/developers</a></p>
        <button onclick="window.close()" style="margin-top:1rem;padding:8px 16px;background:#6c7aff;border:none;border-radius:8px;color:#fff;cursor:pointer">Close</button>
      </body></html>
    `);
  }

  // Cryptographically secure state for CSRF protection (replaces Math.random)
  const state  = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     cfg.clientId,
    redirect_uri:  cfg.redirectUri,
    scope:         LI_SCOPES,
    state,
  });

  // Store state + caller origin in cookies for CSRF check and postMessage targeting
  const callerOrigin = req.query.origin || '';
  res.cookie('li_state',  state,        { httpOnly: true, maxAge: 5 * 60 * 1000, sameSite: 'lax' });
  res.cookie('li_origin', callerOrigin, { httpOnly: true, maxAge: 5 * 60 * 1000, sameSite: 'lax' });
  res.redirect(`${LI_AUTH_URL}?${params}`);
});

/**
 * GET /api/onboard/linkedin/callback
 * LinkedIn redirects here after consent. Exchanges code for token, fetches
 * profile via OpenID Connect /userinfo, then sends data back to the opener
 * window via postMessage and closes the popup.
 */
router.get('/linkedin/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Helper — render a page that posts a message to opener then closes.
  // targetOrigin is read from the li_origin cookie (set during /linkedin/auth).
  // Falls back to window.location.origin so postMessage is never broadcast to '*'.
  const targetOrigin = req.cookies?.li_origin || null;
  const respond = (payload) => {
    const json           = JSON.stringify(payload);
    const targetOriginJs = targetOrigin
      ? JSON.stringify(targetOrigin)   // e.g. "https://app.example.com"
      : 'window.location.origin';      // same-origin fallback (no quotes — JS expression)
    res.send(`<!DOCTYPE html>
<html><head><title>Connecting…</title></head>
<body style="font-family:sans-serif;background:#0f1117;color:#e8eaf2;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center">
    <div style="font-size:2rem;margin-bottom:1rem">${payload.ok ? '✅' : '❌'}</div>
    <div>${payload.ok ? 'Profile loaded — closing…' : (payload.error || 'Something went wrong')}</div>
  </div>
  <script>
    try {
      if (window.opener) {
        // Unified NEXUS_AUTH format — postMessage to verified origin, never '*'
        var _p = ${json};
        var msg = _p.ok
          ? { type: 'NEXUS_AUTH', ok: true,  purpose: 'profile_import', profile: _p.profile }
          : { type: 'NEXUS_AUTH', ok: false, purpose: 'profile_import', error:   _p.error };
        window.opener.postMessage(msg, ${targetOriginJs});
      }
    } catch(e) {}
    setTimeout(function(){ window.close(); }, 1200);
  </script>
</body></html>`);
  };

  if (error) return respond({ ok: false, error: error_description || error });

  const cfg = liConfig();
  if (!cfg) return respond({ ok: false, error: 'LinkedIn not configured' });

  // Optional CSRF check
  const storedState = req.cookies?.li_state;
  if (storedState && storedState !== state) {
    return respond({ ok: false, error: 'State mismatch — possible CSRF' });
  }

  try {
    // 1. Exchange code for access token
    const tokenBody = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  cfg.redirectUri,
      client_id:     cfg.clientId,
      client_secret: cfg.clientSecret,
    }).toString();

    const tokenRes = await httpsRequest(LI_TOKEN_URL, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(tokenBody),
      },
      body: tokenBody,
    });

    if (tokenRes.status !== 200 || !tokenRes.body.access_token) {
      return respond({ ok: false, error: 'Failed to get access token', detail: tokenRes.body });
    }

    const accessToken = tokenRes.body.access_token;

    // 2. Fetch profile via OpenID Connect userinfo
    const profileRes = await httpsRequest(LI_USERINFO, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (profileRes.status !== 200) {
      return respond({ ok: false, error: 'Failed to fetch profile', detail: profileRes.body });
    }

    const u = profileRes.body;
    // u = { sub, name, given_name, family_name, email, picture, locale, headline }

    // Map locale country code to readable label
    const localeCountry = u.locale?.country || null;
    const countryMap = {
      NL:'Netherlands', GB:'United Kingdom', US:'United States',
      DE:'Germany', FR:'France', BE:'Belgium', CH:'Switzerland',
      IE:'Ireland', SE:'Sweden', DK:'Denmark', NO:'Norway',
      CA:'Canada', AU:'Australia', SG:'Singapore', IN:'India',
    };
    const country = localeCountry ? (countryMap[localeCountry] || localeCountry) : null;

    // Build full name from multiple LinkedIn fields (name is most reliable;
    // given_name + family_name are fallbacks in case display name is absent)
    const fullName = u.name
      || (u.given_name && u.family_name ? `${u.given_name} ${u.family_name}` : null)
      || u.given_name
      || u.family_name
      || null;

    respond({
      ok: true,
      profile: {
        name:        fullName,
        given_name:  u.given_name  || null,   // first name
        family_name: u.family_name || null,   // last name
        headline:    u.headline    || u.job_title || null,  // role title (LinkedIn-specific extension)
        about:       u.about       || null,   // "About" summary (not in standard openid scope)
        email:       u.email       || null,
        picture:     u.picture     || null,
        country,
        localeCountry,
        locale:      u.locale      || null,   // e.g. { country:'NL', language:'en' }
        linkedInSub: u.sub         || null,   // LinkedIn OpenID sub (stable user identifier)
        source: 'linkedin-oauth',
      },
    });

  } catch (e) {
    respond({ ok: false, error: e.message });
  }
});

module.exports = router;
