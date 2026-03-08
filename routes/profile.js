'use strict';
/**
 * routes/profile.js — AI Profile Builder + Market Intelligence API
 *
 * POST /api/profile/build
 *   Upload CV PDF + optional SOW PDFs, plus any LinkedIn data in body.
 *   Extracts and synthesizes a unified SearchProfile.
 *   Returns the profile for human-in-the-loop confirmation — does NOT save.
 *
 * POST /api/profile/confirm
 *   User confirms (or edits) the synthesized profile.
 *   Saves to Notion Profile DB, sets the profile in marketIntel worker,
 *   triggers an initial signal refresh.
 *
 * GET  /api/profile/filters
 *   Returns the current search filters derived from the confirmed profile.
 *
 * GET  /api/profile/signals
 *   Returns the latest market intelligence signals (scored + sorted).
 *   ?tier=HOT|WARM|MONITOR — filter by tier
 *   ?limit=N               — max results (default 20)
 *
 * POST /api/profile/signals/refresh
 *   Manually triggers a signal refresh (normally runs on schedule).
 *
 * GET  /api/profile/signals/meta
 *   Returns metadata: count, last run time, tier breakdown.
 */

const express    = require('express');
const router     = express.Router();
const { Client } = require('@notionhq/client');
const store      = require('../lib/store');

const { parsePdf }              = require('../lib/pdfParser');
const { extractCvProfile }      = require('../lib/cvParser');
const { parseSow }              = require('../lib/sowParser');
const { synthesize, generateSearchFilters } = require('../lib/profileSynthesizer');
const intel                     = require('../workers/marketIntel');

// Multer for multi-file PDF uploads (memory storage)
let multer;
try { multer = require('multer'); } catch { multer = null; }

let upload;
if (multer) {
  const storage = multer.memoryStorage();
  const fileFilter = (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname?.endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files accepted'));
    }
  };
  upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 }, fileFilter })
    .fields([
      { name: 'cv',       maxCount: 1 },
      { name: 'sow',      maxCount: 5 },
      { name: 'contract', maxCount: 5 },
    ]);
}

// ── Notion helpers ────────────────────────────────────────────────────────────

function notionClient() {
  const token = process.env.NOTION_TOKEN;
  if (!token) return null;
  return new Client({ auth: token });
}

function profileDbId() {
  return process.env.DB_PROFILE || null;
}

async function fetchExistingRows(notion, dbId) {
  const rows = {};
  let cursor;
  do {
    const resp = await notion.databases.query({ database_id: dbId, page_size: 100, start_cursor: cursor ?? undefined });
    for (const page of resp.results) {
      const param = page.properties['Parameter']?.title?.[0]?.plain_text;
      if (param) rows[param] = page.id;
    }
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return rows;
}

async function upsertRow(notion, dbId, existing, param, value, category, source, confidence = 'AI Extracted') {
  if (!value && value !== 0) return;
  const props = {
    'Parameter': { title:     [{ text: { content: String(param).slice(0, 200) } }] },
    'Value':     { rich_text: [{ text: { content: String(value).slice(0, 2000) } }] },
    'Category':  { select:    { name: String(category) } },
    'Source':    { select:    { name: String(source) } },
    'Confidence':{ select:    { name: confidence } },
  };
  if (existing[param]) {
    await notion.pages.update({ page_id: existing[param], properties: props });
  } else {
    await notion.pages.create({ parent: { database_id: dbId }, properties: props });
  }
}

// ── POST /api/profile/build ───────────────────────────────────────────────────

/**
 * Accepts:
 *   multipart/form-data with fields:
 *     cv         (PDF file, optional)
 *     sow        (PDF file(s), optional — can upload multiple)
 *     contract   (PDF file(s), optional — alias for sow)
 *     linkedin   (JSON string — from LinkedIn OAuth)
 *
 * Returns synthesized profile for human-in-the-loop confirmation.
 * Nothing is saved at this stage.
 */
router.post('/build', (req, res) => {
  if (!upload) {
    return res.status(503).json({ error: 'PDF upload unavailable — multer not installed' });
  }

  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    try {
      // 1. Parse LinkedIn data from body (sent as JSON string)
      let linkedin = null;
      if (req.body?.linkedin) {
        try { linkedin = JSON.parse(req.body.linkedin); } catch { /* ignore */ }
      }

      // 2. Parse CV PDF — use fullText (untruncated) for accurate extraction
      let cv = null;
      const cvFile = req.files?.cv?.[0];
      if (cvFile) {
        const parsed = await parsePdf(cvFile.buffer);
        cv = extractCvProfile(parsed.fullText || parsed.rawText || '');
      }

      // 3. Parse SOW / contract PDFs — use fullText for accurate extraction
      const sowFiles = [
        ...(req.files?.sow      || []),
        ...(req.files?.contract || []),
      ];
      const sows = [];
      for (const file of sowFiles) {
        const parsed = await parsePdf(file.buffer);
        const sow    = parseSow(parsed.fullText || parsed.rawText || '');
        sows.push({ ...sow, filename: file.originalname });
      }

      // 4. Synthesize
      const profile  = synthesize(linkedin, cv, sows);
      const filters  = generateSearchFilters(profile);

      // 5. Return for confirmation — do NOT save yet
      res.json({
        ok:      true,
        profile,
        filters,
        sources: {
          linkedin: !!linkedin,
          cv:       !!cv,
          sows:     sows.length,
        },
      });

    } catch (e) {
      console.error('[profile/build]', e.message);
      res.status(500).json({ error: `Profile build failed: ${e.message}` });
    }
  });
});

// ── POST /api/profile/confirm ─────────────────────────────────────────────────

/**
 * User has reviewed the synthesized profile and confirmed (or edited) it.
 * Body: the full profile object (possibly with user edits applied).
 *
 * Actions:
 *   1. Saves profile fields to Notion Profile DB
 *   2. Sets the profile in marketIntel worker
 *   3. Triggers an initial signal refresh (async — returns immediately)
 */
router.post('/confirm', async (req, res) => {
  const profile = req.body?.profile;
  if (!profile) return res.status(400).json({ error: 'profile object required in body' });

  let saved = 0;

  // 1. Save to Notion (best-effort — don't fail if Notion unavailable)
  try {
    const notion = notionClient();
    const dbId   = profileDbId();
    if (notion && dbId) {
      const existing = await fetchExistingRows(notion, dbId);

      const rows = [];

      // Identity
      if (profile.name)        rows.push(['Full Name',           profile.name,             'Identity',   'AI Extracted',    'AI Extracted']);
      if (profile.headline)    rows.push(['Professional Title',  profile.headline,         'Identity',   'AI Extracted',    'AI Extracted']);
      if (profile.email)       rows.push(['Email',               profile.email,            'Identity',   'Self Reported',   'Confirmed']);
      if (profile.location)    rows.push(['Location',            profile.location,         'Identity',   'AI Extracted',    'AI Extracted']);

      // Skills
      if (profile.skills?.length) {
        rows.push(['Top Skills', profile.skills.slice(0, 20).join(', '), 'Skills — Tier 1', 'CV Extracted', 'AI Extracted']);
      }

      // Industries
      if (profile.industries?.length) {
        rows.push(['Target Industries', profile.industries.join(', '), 'Identity', 'AI Extracted', 'AI Extracted']);
      }

      // Services from SOW
      if (profile.services?.length) {
        rows.push(['Services Provided', profile.services.slice(0,5).join(' | '), 'Identity', 'SOW Extracted', 'AI Extracted']);
      }

      // Search keywords
      const filters = generateSearchFilters(profile);
      if (filters.keywords?.length) {
        rows.push(['Search Keywords', filters.keywords.join(', '), 'Identity', 'AI Generated', 'AI Extracted']);
      }

      // Seniority / experience
      if (profile.seniority)       rows.push(['Seniority Level',   profile.seniority,       'Identity', 'AI Extracted', 'AI Extracted']);
      if (profile.yearsExperience) rows.push(['Years Experience',  String(profile.yearsExperience), 'Identity', 'CV Extracted', 'AI Extracted']);

      for (const rowArgs of rows) {
        await upsertRow(notion, dbId, existing, ...rowArgs.slice(0, 5));
        saved++;
      }
    }
  } catch (e) {
    console.warn('[profile/confirm] Notion save failed (non-fatal):', e.message);
  }

  // 2. Always save profile to local store (zero-key)
  store.set('profile', profile);

  // 3. Set profile in market intel worker
  intel.setProfile(profile);

  // 3. Trigger initial refresh (fire-and-forget — don't block response)
  intel.refresh().catch(e => console.error('[profile/confirm] initial refresh failed:', e.message));

  res.json({
    ok:           true,
    saved,
    message:      `Profile confirmed. ${saved} fields saved to Notion. Signal refresh started.`,
    signalsMeta:  intel.getMeta(),
  });
});

// ── GET /api/profile/filters ──────────────────────────────────────────────────

router.get('/filters', (req, res) => {
  const filters = intel.getFilters();
  if (!filters) {
    return res.status(404).json({ ok: false, error: 'No profile confirmed yet. Call POST /api/profile/confirm first.' });
  }
  res.json({ ok: true, filters });
});

// ── GET /api/profile/signals ──────────────────────────────────────────────────

router.get('/signals', (req, res) => {
  const { tier, limit = '20' } = req.query;
  let signals = intel.getSignals();

  if (tier) {
    signals = signals.filter(s => s.tier === tier.toUpperCase());
  }

  const limitN = Math.min(100, parseInt(limit, 10) || 20);
  const page   = signals.slice(0, limitN);

  res.json({
    ok:       true,
    signals:  page,
    total:    signals.length,
    meta:     intel.getMeta(),
  });
});

// ── POST /api/profile/signals/refresh ────────────────────────────────────────

router.post('/signals/refresh', async (req, res) => {
  if (!intel.getProfile()) {
    return res.status(400).json({ ok: false, error: 'No profile set. Confirm your profile first.' });
  }
  // Fire refresh async — return immediately
  intel.refresh().catch(e => console.error('[signals/refresh]', e.message));
  res.json({ ok: true, message: 'Signal refresh started. Poll GET /api/profile/signals for results.', meta: intel.getMeta() });
});

// ── GET /api/profile/signals/meta ─────────────────────────────────────────────

router.get('/signals/meta', (req, res) => {
  res.json({ ok: true, ...intel.getMeta() });
});

module.exports = router;
