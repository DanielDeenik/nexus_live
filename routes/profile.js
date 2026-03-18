'use strict';
/**
 * routes/profile.js — AI Profile Builder + Market Intelligence API
 *
 * POST /api/profile/build
 *   Upload CV + optional SOW documents (PDF, DOCX, DOC, XLSX, RTF, TXT, CSV),
 *   plus any LinkedIn data in body.
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

const { extractText, documentFileFilter, ACCEPTED_EXTENSIONS } = require('../lib/documentParser');
const { extractCvProfile }      = require('../lib/cvParser');
const { parseSow }              = require('../lib/sowParser');
const { extractWithLLM, isLLMAvailable } = require('../lib/llmProfileExtractor');
const {
  synthesize, generateSearchFilters,
  mergeSearchImport, getSeasonalityPreset, getActionableGaps,
} = require('../lib/profileSynthesizer');
const intel                     = require('../workers/marketIntel');

// Multer for multi-file document uploads (memory storage)
// Accepts: PDF, DOCX, DOC, XLSX, XLS, ODS, ODT, RTF, TXT, CSV
let multer;
try { multer = require('multer'); } catch { multer = null; }

let upload;
if (multer) {
  const storage = multer.memoryStorage();
  upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: documentFileFilter,   // from documentParser — all supported formats
  }).fields([
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
 *     cv         (document file, optional — PDF, DOCX, DOC, RTF, TXT, CSV)
 *     sow        (document file(s), optional — can upload multiple)
 *     contract   (document file(s), optional — alias for sow)
 *     linkedin   (JSON string — from LinkedIn OAuth)
 *
 * Returns synthesized profile for human-in-the-loop confirmation.
 * Nothing is saved at this stage.
 */
router.post('/build', (req, res) => {
  // If multer unavailable (rare), still allow LinkedIn-only builds via JSON body
  const handleBuild = async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });

    try {
      // 1. Parse LinkedIn / session data from body (sent as JSON string)
      let linkedin = null;
      const liRaw = req.body?.linkedin;
      if (liRaw) {
        try { linkedin = typeof liRaw === 'string' ? JSON.parse(liRaw) : liRaw; } catch { /* ignore */ }
      }

      // 2. Parse CV (any supported format)
      let cv = null;
      let llmProfile = null;
      const cvFile = req.files?.cv?.[0];
      if (cvFile) {
        const extracted = await extractText(cvFile.buffer, cvFile.originalname, cvFile.mimetype);
        if (extracted.error) console.warn('[profile/build] CV parse warning:', extracted.error);
        const rawText = extracted.text || '';

        // ── LLM-first extraction ────────────────────────────────────────────
        // Claude extracts context-aware industries, tiered skills, services,
        // education, languages, work preferences — things regex can't infer.
        if (isLLMAvailable()) {
          llmProfile = await extractWithLLM(rawText, linkedin);
        }
        // Always run regex parser too — some fields are reliably extracted by regex
        cv = extractCvProfile(rawText);
      }

      // 3. Parse SOW / contract documents (any supported format)
      const sowFiles = [
        ...(req.files?.sow      || []),
        ...(req.files?.contract || []),
      ];
      const sows = [];
      for (const file of sowFiles) {
        const extracted = await extractText(file.buffer, file.originalname, file.mimetype);
        if (extracted.error) console.warn('[profile/build] SOW parse warning:', extracted.error);
        const sow = parseSow(extracted.text || '');
        sows.push({ ...sow, filename: file.originalname, format: extracted.format });
      }

      // 4. Guard: need at least some input
      if (!linkedin && !cv && !llmProfile && sows.length === 0) {
        return res.status(400).json({ ok: false, error: 'No data provided. Upload a CV, SOW, or connect LinkedIn.' });
      }

      // 5. Synthesize — merge all sources
      // Use LLM profile as the CV input if available (it's richer);
      // synthesize() handles backwards compat flat-field format
      const cvInput  = llmProfile || cv;
      const profile  = synthesize(linkedin, cvInput, sows);

      // 6. Overlay rich LLM-only fields that synthesize() doesn't handle yet
      if (llmProfile) {
        profile.skillTiers        = llmProfile.skillTiers;
        profile.certifications    = llmProfile.certifications   || [];
        profile.servicesRich      = llmProfile.servicesRich     || [];
        profile.industriesRich    = llmProfile.industriesRich   || [];
        profile.education         = llmProfile.education        || [];
        profile.languages         = llmProfile.languages        || [];
        profile.workPreferences   = llmProfile.workPreferences  || {};
        profile.elevatorPitch     = llmProfile.elevatorPitch    || null;
        profile.summary           = profile.summary || llmProfile.summary || null;
        profile.primaryEngagementType = llmProfile.primaryEngagementType || null;
        profile.extractedBy       = 'llm';
      }

      const filters = generateSearchFilters(profile);

      res.json({
        ok: true,
        profile,
        filters,
        sources:      { linkedin: !!linkedin, cv: !!cv, sows: sows.length },
        llmAvailable: isLLMAvailable(),
        extractedBy:  profile.extractedBy || 'regex',
      });

    } catch (e) {
      console.error('[profile/build] error:', e.message, e.stack);
      res.status(500).json({ ok: false, error: e.message || 'Profile build failed' });
    }
  };

  if (upload) {
    upload(req, res, handleBuild);
  } else {
    // No multer — parse JSON body directly (LinkedIn-only path)
    handleBuild(null);
  }
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

      // Skills — tiered if LLM extracted, flat otherwise
      const t = profile.skillTiers;
      if (t?.tier1?.length)      rows.push(['Skills — Tier 1 (Primary)',    t.tier1.join(', '),      'Skills — Tier 1',   'AI Extracted', 'AI Extracted']);
      if (t?.tier2?.length)      rows.push(['Skills — Tier 2 (Supporting)', t.tier2.join(', '),      'Skills — Tier 2',   'AI Extracted', 'AI Extracted']);
      if (t?.tier3?.length)      rows.push(['Skills — Tier 3 (Adjacent)',   t.tier3.join(', '),      'Skills — Tier 3',   'AI Extracted', 'AI Extracted']);
      if (t?.tools?.length)      rows.push(['Tools & Platforms',            t.tools.join(', '),      'Skills — Tier 1',   'AI Extracted', 'AI Extracted']);
      if (t?.softSkills?.length) rows.push(['Soft Skills',                  t.softSkills.join(', '), 'Skills — Tier 3',   'AI Extracted', 'AI Extracted']);
      // Flat fallback if no tiers
      if (!t && profile.skills?.length) {
        rows.push(['Top Skills', profile.skills.slice(0, 20).join(', '), 'Skills — Tier 1', 'CV Extracted', 'AI Extracted']);
      }

      // Certifications
      if (profile.certifications?.length) {
        const certStr = profile.certifications.map(c =>
          c.name + (c.issuer ? ` (${c.issuer})` : '') + (c.year ? ` — ${c.year}` : '')
        ).join(' | ');
        rows.push(['Certifications', certStr, 'Skills — Tier 1', 'CV Extracted', 'Confirmed']);
      }

      // Industries (rich or flat)
      if (profile.industriesRich?.length) {
        rows.push(['Target Industries', profile.industriesRich.map(i => i.name || i).join(', '), 'Identity', 'AI Extracted', 'AI Extracted']);
        const highConf = profile.industriesRich.filter(i => i.confidence === 'high').map(i => i.name);
        if (highConf.length) rows.push(['Primary Industry', highConf[0], 'Identity', 'AI Extracted', 'AI Extracted']);
      } else if (profile.industries?.length) {
        rows.push(['Target Industries', profile.industries.join(', '), 'Identity', 'AI Extracted', 'AI Extracted']);
      }

      // Services
      if (profile.servicesRich?.length) {
        profile.servicesRich.slice(0, 5).forEach((svc, i) => {
          const name  = typeof svc === 'string' ? svc : svc.name;
          const desc  = typeof svc === 'object' ? (svc.description || '') : '';
          rows.push([`Service ${i + 1}`, name + (desc ? ` — ${desc}` : ''), 'Identity', 'AI Extracted', 'AI Extracted']);
        });
      } else if (profile.services?.length) {
        rows.push(['Services Provided', profile.services.slice(0,5).join(' | '), 'Identity', 'SOW Extracted', 'AI Extracted']);
      }

      // Education
      if (profile.education?.length) {
        const eduStr = profile.education.map(e =>
          `${e.degree}${e.field ? ` in ${e.field}` : ''}, ${e.institution}${e.year ? ` (${e.year})` : ''}`
        ).join(' | ');
        rows.push(['Education', eduStr, 'Identity', 'CV Extracted', 'Confirmed']);
      }

      // Languages
      if (profile.languages?.length) {
        rows.push(['Languages', profile.languages.map(l => `${l.language} (${l.proficiency})`).join(', '), 'Identity', 'CV Extracted', 'AI Extracted']);
      }

      // Engagement type / work preferences
      if (profile.primaryEngagementType) rows.push(['Engagement Type', profile.primaryEngagementType, 'Identity', 'AI Extracted', 'AI Extracted']);
      if (profile.workPreferences?.availability) rows.push(['Availability', profile.workPreferences.availability, 'Identity', 'Self Reported', 'Self Reported']);

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

  // 2. Always save profile to local store (scoped to this user)
  req.userStore.set('profile', profile);

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

// ── GET /api/profile/me ───────────────────────────────────────────────────────
/**
 * Returns the currently stored synthesized profile for this user.
 * Used by the settings page to populate skill/industry chips.
 */
router.get('/me', (req, res) => {
  const profile = req.userStore.get('profile') || {};
  res.json({ ok: true, profile });
});

// ── PATCH /api/profile/me ─────────────────────────────────────────────────────
/**
 * Merge a patch into the stored profile (skills, industries, services, etc.)
 * Body: partial profile object — only provided keys are updated.
 */
router.patch('/me', (req, res) => {
  const patch = req.body || {};
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    return res.status(400).json({ ok: false, error: 'Body must be an object' });
  }
  const current = req.userStore.get('profile') || {};
  const updated = { ...current, ...patch };
  req.userStore.set('profile', updated);
  // Keep market intel worker in sync
  try { intel.setProfile(updated); } catch { /* intel may not have started */ }
  res.json({ ok: true, profile: updated });
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

// ── GET /api/profile/seasonality-preset ──────────────────────────────────────
/**
 * Returns the best-fit seasonality preset for the current confirmed profile.
 * Used by the UI to show a 1-click "Apply [Industry] seasonal pattern" card.
 *
 * No params needed — reads from the confirmed profile in the local store.
 * If no profile confirmed yet, returns the default preset.
 *
 * Response:
 *   { ok, industry, data[12], months[12], peak[3], slow[3], isDefault, gaps[] }
 */
router.get('/seasonality-preset', (req, res) => {
  const profile = req.userStore.get('profile') || {};
  const preset  = getSeasonalityPreset(profile);
  const gaps    = getActionableGaps(profile);
  res.json({ ok: true, ...preset, gaps });
});

// ── POST /api/profile/import-searches ────────────────────────────────────────
/**
 * Import saved/scheduled search results from Cowork into the profile.
 *
 * Designed to be called by a Cowork scheduled task that runs market searches
 * on a schedule, then POSTs the results here to enrich the profile's
 * keyword/industry/skill coverage.
 *
 * Body: {
 *   searches: [
 *     {
 *       query:    string,           // e.g. "SimCorp Dimension consultant Netherlands"
 *       industry: string|null,      // e.g. "Asset Management"
 *       results:  [                 // array of search result objects
 *         {
 *           title:   string,
 *           company: string|null,
 *           url:     string,
 *           snippet: string,
 *           tags:    string[]        // optional explicit labels from Cowork
 *         }
 *       ]
 *     }
 *   ],
 *   source: string,                 // e.g. "cowork-scheduled", "manual"
 *   scheduledTaskId: string|null,   // Cowork task ID for traceability
 * }
 *
 * Response: { ok, profile, filters, enriched: { skillsAdded, keywordsAdded, industriesAdded } }
 */
router.post('/import-searches', (req, res) => {
  const { searches, source = 'unknown', scheduledTaskId } = req.body || {};

  if (!Array.isArray(searches) || searches.length === 0) {
    return res.status(400).json({ ok: false, error: 'searches array is required and must be non-empty' });
  }

  // Get existing profile (or empty shell)
  const existing = req.userStore.get('profile') || {};

  const beforeSkills     = (existing.skills     || []).length;
  const beforeKeywords   = (existing.sowKeywords || []).length;
  const beforeIndustries = (existing.industries  || []).length;

  // Merge the imports
  const enriched = mergeSearchImport(existing, searches);

  // Persist (scoped to this user)
  req.userStore.set('profile', enriched);

  // Update market intel worker if running
  try { intel.setProfile(enriched); } catch { /* ignore if intel not started */ }

  // Trigger a signal refresh in the background (non-blocking)
  try { intel.refresh().catch(() => {}); } catch { /* ignore */ }

  const enrichedStats = {
    skillsAdded:     (enriched.skills     || []).length - beforeSkills,
    keywordsAdded:   (enriched.sowKeywords|| []).length - beforeKeywords,
    industriesAdded: (enriched.industries || []).length - beforeIndustries,
    searchesImported: searches.length,
    source,
    scheduledTaskId: scheduledTaskId || null,
    importedAt: new Date().toISOString(),
  };

  console.log(`[profile/import-searches] ${enrichedStats.searchesImported} searches, ` +
    `+${enrichedStats.keywordsAdded} keywords, +${enrichedStats.skillsAdded} skills`);

  const filters = generateSearchFilters(enriched);

  res.json({
    ok:       true,
    profile:  enriched,
    filters,
    enriched: enrichedStats,
    gaps:     getActionableGaps(enriched),
  });
});

// ── GET /api/profile/import-searches ─────────────────────────────────────────
/**
 * Returns metadata about past search imports (count, last run, etc.)
 * Used by the UI to show the "Linked Searches" status widget.
 */
router.get('/import-searches', (req, res) => {
  const profile = req.userStore.get('profile') || {};
  res.json({
    ok:             true,
    searchImports:  profile.searchImports   || 0,
    lastImportAt:   profile.lastImportAt    || null,
    keywordCount:   (profile.sowKeywords    || []).length,
    industryCount:  (profile.industries     || []).length,
    confidence:     profile.confidence      || 0,
    gaps:           getActionableGaps(profile),
  });
});

module.exports = router;
