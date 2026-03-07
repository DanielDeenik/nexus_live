'use strict';
/**
 * routes/api.js — All /api/* endpoints
 *
 * Each route:
 *   1. Resolves the workspace via ?ws=<id> (defaults to primary)
 *   2. Checks the in-memory cache
 *   3. Queries Notion, shapes the result
 *   4. Caches and returns JSON
 *
 * Error responses always include a human-readable `error` field.
 */

const { Router }                       = require('express');
const { prop, queryAll, translateError } = require('../lib/notion');
const cache                             = require('../lib/cache');
const { getWorkspace, listWorkspaces, checkConnectivity } = require('../lib/workspace');
const { compare, project, projectWithBands, defaultScenario, calcNLTax } = require('../lib/simulator');
const { getFeed, refresh: refreshFeed, getFeedMeta } = require('../workers/jobFeed');
const { assessContract } = require('../lib/forecast');
const { parsePdf, extractContractFields } = require('../lib/pdfParser');
const scenarioStore                     = require('../lib/scenarioStore');
const store                             = require('../lib/store');

const router = Router();

// ── Middleware: resolve workspace ──────────────────────────────────────────────
function requireWorkspace(req, res, next) {
  const ws = getWorkspace(req.query.ws);
  if (!ws) {
    return res.status(400).json({
      error: `Workspace "${req.query.ws}" not found. Available: ${listWorkspaces().map(w => w.id).join(', ')}`,
    });
  }
  if (!ws.token) {
    return res.status(503).json({ error: 'No Notion token configured for this workspace.' });
  }
  req.ws = ws;
  next();
}

function ck(endpoint, ws) { return `${endpoint}:${ws.id}`; }

// ── GET /api/workspaces ────────────────────────────────────────────────────────
router.get('/workspaces', (_req, res) => {
  res.json(listWorkspaces());
});

// ── GET /api/status ───────────────────────────────────────────────────────────
// Connectivity check — tells you which databases are accessible
router.get('/status', async (_req, res) => {
  try {
    const report = await checkConnectivity();
    const allOk  = report.every(r => r.status === 'ok');
    res.status(allOk ? 200 : 207).json({ ok: allOk, databases: report });
  } catch (e) {
    res.status(500).json({ error: translateError(e) });
  }
});

// ── GET /api/config ────────────────────────────────────────────────────────────
// Reads the Profile DB (key-value rows) and returns a merged config object.
// No hardcoded defaults — all values come from Notion.
router.get('/config', async (req, res) => {
  // ── Local store fast-path (zero-key) ─────────────────────────────────────
  // If Notion is not configured or unreachable, return the locally stored config.
  const ws = getWorkspace(req.query.ws);
  if (!ws?.token) {
    const local = store.get('config', {});
    return res.json(local);
  }
  req.ws = ws;

  const key    = ck('config', req.ws);
  const cached = cache.get(key);
  if (cached) return res.json(cached);

  try {
    const pages = await queryAll(req.ws.client, req.ws.dbs.profile);

    // Start with nulls — no fallbacks baked in
    const cfg = {
      name: null, currency: null, hourlyRate: null, dayRate: null,
      burn: null, wiseBalance: null, contractEnd: null, agency: null,
      client: null, mkbPct: null, zvwPct: null, fxBuffer: null,
      payLagDays: null, taxReservePct: null, vatPct: null, tags: [], skills: [],
      availHoursPerWeek: null, targetIndustries: [], headline: null, location: null,
    };

    for (const page of pages) {
      const parameter = prop(page, 'Parameter');
      const value     = prop(page, 'Value');
      const category  = prop(page, 'Category');
      if (!parameter || value === null || value === '') continue;

      const v = String(value).trim();
      switch (parameter) {
        case 'Full Name':          cfg.name          = v; break;
        case 'Hourly Rate EUR':    cfg.hourlyRate     = parseFloat(v); break;
        case 'Day Rate EUR':       cfg.dayRate        = parseFloat(v); break;
        case 'Invoice Currency':   cfg.currency       = v; break;
        case 'Monthly Burn EUR':   cfg.burn           = parseFloat(v); break;
        case 'Wise Balance EUR':   cfg.wiseBalance    = parseFloat(v); break;
        case 'Contract End Date':  cfg.contractEnd    = v; break;
        case 'Agency':             cfg.agency         = v; break;
        case 'Current Client':     cfg.client         = v; break;
        case 'MKB Pct':            cfg.mkbPct         = parseFloat(v); break;
        case 'ZVW Pct':            cfg.zvwPct         = parseFloat(v); break;
        case 'FX Buffer Pct':      cfg.fxBuffer       = parseFloat(v); break;
        case 'Payment Lag Days':   cfg.payLagDays     = parseInt(v); break;
        case 'Tax Reserve Pct':    cfg.taxReservePct  = parseFloat(v); break;
        case 'BTW Rate Pct':       cfg.vatPct            = parseFloat(v); break;
        case 'VAT Pct':            cfg.vatPct            = parseFloat(v); break;
        case 'Avail Hours Per Week': cfg.availHoursPerWeek = parseFloat(v); break;
        case 'Target Industries':  cfg.targetIndustries  = v.split(',').map(s => s.trim()).filter(Boolean); break;
        case 'Professional Title': cfg.headline          = v; break;
        case 'Location':           cfg.location          = v; break;
        default:
          if (category === 'Skills — Tier 1') cfg.skills.push({ label: parameter, tier: 1 });
          else if (category === 'Skills — Tier 2') cfg.skills.push({ label: parameter, tier: 2 });
          else if (category === 'Skills — Tier 3') cfg.skills.push({ label: parameter, tier: 3 });
      }
    }

    // Deduplicate skills — Profile rows may be duplicated if seed.js ran on existing data.
    const seenSkills = new Set();
    cfg.skills = cfg.skills.filter(s => {
      if (seenSkills.has(s.label)) return false;
      seenSkills.add(s.label);
      return true;
    });

    // Merge with any locally stored overrides (e.g. from POST /api/config)
    const localOverride = store.get('config', {});
    const merged = { ...cfg, ...localOverride };

    cache.set(key, merged);
    res.json(merged);
  } catch (e) {
    console.error('[config] Notion failed, falling back to local store:', e.message);
    // Notion unreachable — return local store
    return res.json(store.get('config', {}));
  }
});

// ── POST /api/config ───────────────────────────────────────────────────────────
// Save config. Always writes to local store (zero-key). Also syncs to Notion
// if a token is configured (fire-and-forget, non-blocking).
router.post('/config', async (req, res) => {
  const payload = req.body || {};

  // Always save locally first — works with zero external keys
  store.merge('config', payload);

  // Optional: async Notion sync (don't block response)
  const ws = getWorkspace(req.query.ws);
  if (ws?.token && ws?.dbs?.profile) {
    setImmediate(async () => {
      try {
        const { upsertProfileRow } = require('../lib/notion');
        const FIELD_MAP = {
          name:              'Full Name',
          headline:          'Professional Title',
          location:          'Location',
          hourlyRate:        'Hourly Rate EUR',
          dayRate:           'Day Rate EUR',
          availHoursPerWeek: 'Avail Hours Per Week',
          burn:              'Monthly Burn EUR',
          vatPct:            'VAT Pct',
          taxReservePct:     'Tax Reserve Pct',
          utilisation:       'Utilisation Pct',
        };
        const pages = await queryAll(ws.client, ws.dbs.profile);
        for (const [jsKey, notionParam] of Object.entries(FIELD_MAP)) {
          if (payload[jsKey] != null) {
            const page = pages.find(p => prop(p, 'Parameter') === notionParam);
            if (page) {
              await ws.client.pages.update({
                page_id: page.id,
                properties: { 'Value': { rich_text: [{ text: { content: String(payload[jsKey]) } }] } },
              });
            }
          }
        }
        // Bust cache so next GET reflects changes
        cache.del(ck('config', ws));
      } catch (e) {
        console.warn('[config POST] Notion sync skipped:', e.message);
      }
    });
  }

  res.json({ ok: true, saved: 'local' });
});

// ── PATCH /api/config ─────────────────────────────────────────────────────────
// Update Profile DB rows in Notion. Body: { 'Full Name': 'Dan', 'Hourly Rate EUR': 120 }
router.patch('/config', requireWorkspace, async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Body must be an object of { parameter: value }' });
  }
  try {
    const pages = await queryAll(req.ws.client, req.ws.dbs.profile);
    const updated = [];
    for (const [param, value] of Object.entries(updates)) {
      const page = pages.find(p => prop(p, 'Parameter') === param);
      if (!page) { console.warn(`[config] No Profile row found for parameter: "${param}"`); continue; }
      await req.ws.client.pages.update({
        page_id: page.id,
        properties: {
          'Value': { rich_text: [{ text: { content: String(value) } }] },
        },
      });
      updated.push(param);
    }
    // Bust config cache so next load reflects changes
    cache.del(ck('config', req.ws));
    res.json({ updated, skipped: Object.keys(updates).length - updated.length });
  } catch (e) {
    console.error('[config PATCH]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── GET /api/expenses ─────────────────────────────────────────────────────────
router.get('/expenses', requireWorkspace, async (req, res) => {
  const key = ck('expenses', req.ws);
  const cached = cache.get(key);
  if (cached) return res.json(cached);

  try {
    const pages = await queryAll(req.ws.client, req.ws.dbs.expenses, undefined, [
      { property: 'Date', direction: 'descending' },
    ]);
    const data = pages.map(p => ({
      id:          p.id,
      description: prop(p, 'Description') || 'Untitled',
      date:        prop(p, 'Date'),
      amountEur:   prop(p, 'Amount EUR')     ?? 0,
      category:    prop(p, 'Category')       || 'Other',
      currency:    prop(p, 'Currency')       || 'EUR',
      amountOrig:  prop(p, 'Amount Original') ?? 0,
      fxRate:      prop(p, 'FX Rate')        ?? 1,
      source:      prop(p, 'Source')         || 'Manual',
      year:        prop(p, 'Year'),
      notes:       prop(p, 'Notes')          || '',
    }));
    cache.set(key, data);
    res.json(data);
  } catch (e) {
    console.error('[expenses]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── POST /api/expenses ────────────────────────────────────────────────────────
router.post('/expenses', requireWorkspace, async (req, res) => {
  const { description, date, amountEur, category, currency, amountOrig, fxRate, notes } = req.body;
  if (!description || !date || amountEur == null) {
    return res.status(400).json({ error: 'description, date, and amountEur are required' });
  }
  try {
    const year = new Date(date).getFullYear();
    const page = await req.ws.client.pages.create({
      parent: { database_id: req.ws.dbs.expenses },
      properties: {
        'Description':     { title:     [{ text: { content: String(description) } }] },
        'Date':            { date:      { start: date } },
        'Amount EUR':      { number:    parseFloat(amountEur) || 0 },
        'Category':        { select:    { name: category || 'Other' } },
        'Currency':        { select:    { name: currency || 'EUR' } },
        'Amount Original': { number:    parseFloat(amountOrig ?? amountEur) || 0 },
        'FX Rate':         { number:    parseFloat(fxRate) || 1 },
        'Source':          { select:    { name: 'Manual' } },
        'Year':            { number:    year },
        'Notes':           { rich_text: [{ text: { content: notes || '' } }] },
      },
    });
    cache.del(ck('expenses', req.ws));
    res.json({ id: page.id, success: true });
  } catch (e) {
    console.error('[expenses POST]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── DELETE /api/expenses/:id ──────────────────────────────────────────────────
router.delete('/expenses/:id', requireWorkspace, async (req, res) => {
  try {
    await req.ws.client.pages.update({ page_id: req.params.id, archived: true });
    cache.del(ck('expenses', req.ws));
    res.json({ success: true });
  } catch (e) {
    console.error('[expenses DELETE]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── GET /api/contracts ────────────────────────────────────────────────────────
router.get('/contracts', requireWorkspace, async (req, res) => {
  const key = ck('contracts', req.ws);
  const cached = cache.get(key);
  if (cached) return res.json(cached);

  try {
    const pages = await queryAll(req.ws.client, req.ws.dbs.contracts, undefined, [
      { property: 'Effective Date', direction: 'descending' },
    ]);
    const data = pages.map(p => ({
      id:             p.id,
      name:           prop(p, 'Document Name') || 'Untitled',
      client:         prop(p, 'Client'),
      counterparty:   prop(p, 'Counterparty'),
      contactJpsb:    prop(p, 'Contact JPSB'),
      dayRateCad:     prop(p, 'Day Rate CAD'),
      hourlyRateEur:  prop(p, 'Hourly Rate EUR'),
      docType:        prop(p, 'Document Type'),
      effectiveDate:  prop(p, 'Effective Date'),
      endDate:        prop(p, 'End Date'),
      renewalDate:    prop(p, 'Renewal Date'),
      status:         prop(p, 'Status'),
      paymentTerms:   prop(p, 'Payment Terms Days'),
      governingLaw:   prop(p, 'Governing Law'),
      noticePeriod:   prop(p, 'Notice Period'),
      insuranceReq:   prop(p, 'Insurance Required CAD'),
      keyObligations: prop(p, 'Key Obligations'),
      keyRisks:       prop(p, 'Key Risks'),
      notes:          prop(p, 'Notes'),
    }));
    cache.set(key, data);
    res.json(data);
  } catch (e) {
    console.error('[contracts]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── GET /api/signals ──────────────────────────────────────────────────────────
router.get('/signals', requireWorkspace, async (req, res) => {
  const key = ck('signals', req.ws);
  const cached = cache.get(key);
  if (cached) return res.json(cached);

  try {
    // Sort by Year then by month name (no property sort on text fields)
    const pages = await queryAll(req.ws.client, req.ws.dbs.signals);
    const MONTH_ORDER = { January:1,February:2,March:3,April:4,May:5,June:6,
                          July:7,August:8,September:9,October:10,November:11,December:12 };
    const data = pages.map(p => ({
      id:              p.id,
      name:            prop(p, 'Signal Name'),
      month:           prop(p, 'Month'),
      year:            prop(p, 'Year'),
      region:          prop(p, 'Region'),
      hiringIndex:     prop(p, 'Hiring Index'),
      rawValue:        prop(p, 'Raw Value'),
      kalmanSmoothed:  prop(p, 'Kalman Smoothed'),
      contractorRatio: prop(p, 'Contractor Ratio'),
      budgetOpenScore: prop(p, 'Budget Open Score'),
      anomalyFlag:     prop(p, 'Anomaly Flag'),
      dataSource:      prop(p, 'Data Source'),
      confidence:      prop(p, 'Confidence'),
      sourceUrl:       prop(p, 'Source URL'),
      notes:           prop(p, 'Notes'),
    })).sort((a, b) => {
      if ((a.year ?? 0) !== (b.year ?? 0)) return (a.year ?? 0) - (b.year ?? 0);
      return (MONTH_ORDER[a.month] ?? 0) - (MONTH_ORDER[b.month] ?? 0);
    });
    cache.set(key, data);
    res.json(data);
  } catch (e) {
    console.error('[signals]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── GET /api/cashflow ─────────────────────────────────────────────────────────
router.get('/cashflow', requireWorkspace, async (req, res) => {
  const key = ck('cashflow', req.ws);
  const cached = cache.get(key);
  if (cached) return res.json(cached);

  try {
    const pages = await queryAll(req.ws.client, req.ws.dbs.cashflow, undefined, [
      { property: 'Date', direction: 'ascending' },
    ]);
    const raw = pages.map(p => ({
      id:               p.id,
      label:            prop(p, 'Month Label'),
      date:             prop(p, 'Date'),
      year:             prop(p, 'Year'),
      monthNumber:      prop(p, 'Month Number'),
      grossRevenue:     prop(p, 'Gross Revenue EUR'),
      monthlyBurn:      prop(p, 'Monthly Burn EUR'),
      taxReserve:       prop(p, 'Tax Reserve EUR'),
      netAfterTax:      prop(p, 'Net After Tax EUR'),
      closingBalance:   prop(p, 'Closing Balance EUR'),
      wiseSnapshot:     prop(p, 'Wise Balance Snapshot'),
      contractsActive:  prop(p, 'Contracts Active'),
      paymentLag:       prop(p, 'Payment Lag Days'),
      seasonScore:      prop(p, 'Season Score'),
      fxRate:           prop(p, 'FX Rate Applied'),
      currency:         prop(p, 'Invoice Currency'),
      zone:             prop(p, 'Zone'),
      decisionScore:    prop(p, 'Decision Score'),
      notes:            prop(p, 'Notes'),
      // ── Abundant Spending Engine fields ─────────────────────────────────
      mlPredictedSpend: prop(p, 'ML Predicted Spend EUR'),
      spendingRisk:     prop(p, 'Spending Risk'),
      abundanceScore:   prop(p, 'Abundance Score'),
      spendVariance:    prop(p, 'Spend Variance'),
    }));

    // Deduplicate by YEAR-MONTH — keeps one row per calendar month.
    // Uses year+monthNumber when available, otherwise extracts YYYY-MM from date string.
    // Keeps the row with the highest closingBalance (real seeded data beats blank manual entries).
    const seen = new Map();
    for (const row of raw) {
      const mo = row.year && row.monthNumber
        ? `${row.year}-${String(row.monthNumber).padStart(2,'0')}`
        : (row.date || '').slice(0, 7);
      if (!mo) continue;
      const existing = seen.get(mo);
      if (!existing || (row.closingBalance ?? 0) > (existing.closingBalance ?? 0)) {
        seen.set(mo, row);
      }
    }
    const data = Array.from(seen.values()).sort((a, b) => {
      const ka = a.year && a.monthNumber ? `${a.year}-${String(a.monthNumber).padStart(2,'0')}` : (a.date||'').slice(0,7);
      const kb = b.year && b.monthNumber ? `${b.year}-${String(b.monthNumber).padStart(2,'0')}` : (b.date||'').slice(0,7);
      return ka.localeCompare(kb);
    });
    cache.set(key, data);
    res.json(data);
  } catch (e) {
    console.error('[cashflow]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── POST /api/cashflow ────────────────────────────────────────────────────────
router.post('/cashflow', requireWorkspace, async (req, res) => {
  const d = req.body;
  if (!d.date || !d.label) {
    return res.status(400).json({ error: 'date and label are required' });
  }
  try {
    const page = await req.ws.client.pages.create({
      parent: { database_id: req.ws.dbs.cashflow },
      properties: {
        'Month Label':          { title:  [{ text: { content: d.label } }] },
        'Date':                 { date:   { start: d.date } },
        'Year':                 { number: d.year || new Date(d.date).getFullYear() },
        'Month Number':         { number: d.monthNumber || new Date(d.date).getMonth() + 1 },
        'Gross Revenue EUR':    { number: d.grossRevenue  || 0 },
        'Monthly Burn EUR':     { number: d.monthlyBurn   || 0 },
        'Tax Reserve EUR':      { number: d.taxReserve    || 0 },
        'Net After Tax EUR':    { number: d.netAfterTax   || 0 },
        'Closing Balance EUR':  { number: d.closingBalance || 0 },
        'Wise Balance Snapshot':{ number: d.wiseSnapshot  || 0 },
        'Season Score':         { number: d.seasonScore   || 0 },
        'Decision Score':       { number: d.decisionScore || 0 },
        'Zone':                 { select: { name: d.zone || 'TRANSITIONAL' } },
        'Invoice Currency':     { select: { name: d.currency || 'EUR' } },
        ...(d.contractsActive != null ? { 'Contracts Active': { number: parseInt(d.contractsActive) || 0 } } : {}),
        ...(d.paymentLag      != null ? { 'Payment Lag Days': { number: parseInt(d.paymentLag)      || 30 } } : {}),
      },
    });
    cache.del(ck('cashflow', req.ws));
    res.json({ id: page.id, success: true });
  } catch (e) {
    console.error('[cashflow POST]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── GET /api/companies ────────────────────────────────────────────────────────
router.get('/companies', requireWorkspace, async (req, res) => {
  const key = ck('companies', req.ws);
  const cached = cache.get(key);
  if (cached) return res.json(cached);

  try {
    const pages = await queryAll(req.ws.client, req.ws.dbs.companies);
    const data = pages.map(p => ({
      id:              p.id,
      name:            prop(p, 'Name'),
      industry:        prop(p, 'Industry'),
      status:          prop(p, 'Status'),
      tags:            prop(p, 'Tags')      || [],
      budgetScore:     prop(p, 'Budget Score'),
      contractLength:  prop(p, 'Contract Length'),
      fiscalYearEnd:   prop(p, 'Fiscal Year End'),
      approachMonth:   prop(p, 'Approach Month'),
      lastPlacement:   prop(p, 'Last Placement'),
      linkedIn:        prop(p, 'LinkedIn URL'),
      notes:           prop(p, 'Notes'),
    }));
    cache.set(key, data);
    res.json(data);
  } catch (e) {
    console.error('[companies]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── GET /api/opportunities ────────────────────────────────────────────────────
router.get('/opportunities', requireWorkspace, async (req, res) => {
  const key = ck('opportunities', req.ws);
  const cached = cache.get(key);
  if (cached) return res.json(cached);

  try {
    const pages = await queryAll(req.ws.client, req.ws.dbs.opportunities, undefined, [
      { property: 'Match Score', direction: 'descending' },
    ]);
    const data = pages.map(p => ({
      id:                 p.id,
      roleTitle:          prop(p, 'Role Title'),
      company:            prop(p, 'Company'),
      dayRateEur:         prop(p, 'Day Rate EUR'),
      status:             prop(p, 'Status'),
      action:             prop(p, 'Action'),
      matchScore:         prop(p, 'Match Score'),
      contractLength:     prop(p, 'Contract Length'),
      remote:             prop(p, 'Remote'),
      postedDate:         prop(p, 'Posted Date'),
      estimatedStart:     prop(p, 'Estimated Start'),
      skillsRequired:     prop(p, 'Skills Required'),
      sourceUrl:          prop(p, 'Source URL'),
      notes:              prop(p, 'Notes'),
      // Forecast v2 fields
      outreachSent:       prop(p, 'Outreach Sent')       ?? false,
      runwayImpactWeeks:  prop(p, 'Runway Impact Weeks') ?? null,
    }));
    cache.set(key, data, 60);
    res.json(data);
  } catch (e) {
    console.error('[opportunities]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── GET /api/history ──────────────────────────────────────────────────────────
router.get('/history', requireWorkspace, async (req, res) => {
  const key = ck('history', req.ws);
  const cached = cache.get(key);
  if (cached) return res.json(cached);

  try {
    const pages = await queryAll(req.ws.client, req.ws.dbs.history, undefined, [
      { property: 'Start Month', direction: 'descending' },
    ]);
    const data = pages.map(p => ({
      id:                p.id,
      projectName:       prop(p, 'Project Name'),
      client:            prop(p, 'Client'),
      clientSector:      prop(p, 'Client Sector'),
      roleTitle:         prop(p, 'Role Title'),
      startMonth:        prop(p, 'Start Month'),
      endMonth:          prop(p, 'End Month'),
      durationMonths:    prop(p, 'Duration Months'),
      ratePerHour:       prop(p, 'Rate EUR per Hour'),
      ratePerDay:        prop(p, 'Rate EUR per Day'),
      contractType:      prop(p, 'Contract Type'),
      platform:          prop(p, 'Platform')          || [],
      howWon:            prop(p, 'How Won'),
      marginTaken:       prop(p, 'Margin Taken'),
      regulatoryDriver:  prop(p, 'Regulatory Driver') || [],
      demandTrigger:     prop(p, 'Demand Trigger')    || [],
      whyEnded:          prop(p, 'Why Ended'),
      renewalOffered:    prop(p, 'Renewal Offered'),
      referralGenerated: prop(p, 'Referral Generated'),
      seasonStartMonth:  prop(p, 'Season Start Month'),
      notes:             prop(p, 'Notes'),
    }));
    cache.set(key, data);
    res.json(data);
  } catch (e) {
    console.error('[history]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── POST /api/contracts ───────────────────────────────────────────────────────
// Create a new contract in Notion and return the new page ID.
router.post('/contracts', requireWorkspace, async (req, res) => {
  const d = req.body;
  if (!d.documentName) {
    return res.status(400).json({ error: 'documentName is required' });
  }
  try {
    const page = await req.ws.client.pages.create({
      parent: { database_id: req.ws.dbs.contracts },
      properties: {
        'Document Name':      { title:     [{ text: { content: String(d.documentName || 'Untitled Contract') } }] },
        'Client':             { rich_text: [{ text: { content: String(d.client        || '') } }] },
        'Counterparty':       { rich_text: [{ text: { content: String(d.counterparty  || '') } }] },
        'Contact JPSB':       { rich_text: [{ text: { content: String(d.contactJpsb   || '') } }] },
        'Document Type':      { select:    { name: d.docType || 'Service Agreement' } },
        'Status':             { select:    { name: d.status  || 'Active' } },
        ...(d.effectiveDate ? { 'Effective Date': { date: { start: d.effectiveDate } } } : {}),
        ...(d.endDate       ? { 'End Date':       { date: { start: d.endDate       } } } : {}),
        ...(d.renewalDate   ? { 'Renewal Date':   { date: { start: d.renewalDate   } } } : {}),
        ...(d.hourlyRateEur != null ? { 'Hourly Rate EUR':        { number: parseFloat(d.hourlyRateEur) } } : {}),
        ...(d.dayRateCad    != null ? { 'Day Rate CAD':           { number: parseFloat(d.dayRateCad)   } } : {}),
        ...(d.paymentTerms  != null ? { 'Payment Terms Days':     { number: parseInt(d.paymentTerms)   } } : {}),
        ...(d.governingLaw  ? { 'Governing Law':       { rich_text: [{ text: { content: d.governingLaw  } }] } } : {}),
        ...(d.noticePeriod  ? { 'Notice Period':       { rich_text: [{ text: { content: d.noticePeriod  } }] } } : {}),
        ...(d.keyObligations? { 'Key Obligations':     { rich_text: [{ text: { content: d.keyObligations} }] } } : {}),
        ...(d.keyRisks      ? { 'Key Risks':           { rich_text: [{ text: { content: d.keyRisks      } }] } } : {}),
        ...(d.insuranceReq  != null ? { 'Insurance Required CAD': { number: parseFloat(d.insuranceReq) || 0 } } : {}),
        ...(d.notes         ? { 'Notes':               { rich_text: [{ text: { content: d.notes         } }] } } : {}),
      },
    });
    cache.del(ck('contracts', req.ws));
    res.json({ id: page.id, success: true, url: page.url });
  } catch (e) {
    console.error('[contracts POST]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── POST /api/contracts/parse ─────────────────────────────────────────────────
// Accepts multipart upload (field: 'contract') OR JSON body with { text }.
// Returns extracted contract fields (does NOT save to Notion).
router.post('/contracts/parse', async (req, res) => {
  try {
    // multer attaches req.file if a PDF was uploaded
    if (req.file) {
      const fields = await parsePdf(req.file.buffer);
      return res.json(fields);
    }
    // Fallback: raw text in body
    if (req.body?.text) {
      return res.json(extractContractFields(req.body.text));
    }
    res.status(400).json({ error: 'Upload a PDF (multipart/form-data, field: contract) or send { text: "..." }' });
  } catch (e) {
    console.error('[contracts/parse]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/forecast/assess ─────────────────────────────────────────────────
// Full ML assessment of a proposed contract against historical cashflow + history.
// Body: { contract: {...}, config?: {...} }
router.post('/forecast/assess', requireWorkspace, async (req, res) => {
  try {
    const { contract = {}, config: bodyConfig = {} } = req.body || {};

    // Fetch required data in parallel (use cache where available)
    const [cashflowData, historyData, signalsData, configData] = await Promise.allSettled([
      (async () => {
        const key = ck('cashflow', req.ws);
        const c = cache.get(key);
        if (c) return c;
        const pages = await queryAll(req.ws.client, req.ws.dbs.cashflow, undefined,
          [{ property: 'Date', direction: 'ascending' }]);
        const data = pages.map(p => ({
          date:           prop(p, 'Date'),
          grossRevenue:   prop(p, 'Gross Revenue EUR') ?? 0,
          monthlyBurn:    prop(p, 'Monthly Burn EUR')  ?? 0,
          closingBalance: prop(p, 'Closing Balance EUR') ?? 0,
        }));
        cache.set(key, data);
        return data;
      })(),
      (async () => {
        const key = ck('history', req.ws);
        const c = cache.get(key);
        if (c) return c;
        const pages = await queryAll(req.ws.client, req.ws.dbs.history, undefined,
          [{ property: 'Start Month', direction: 'descending' }]);
        const data = pages.map(p => ({
          ratePerHour: prop(p, 'Rate EUR per Hour'),
          ratePerDay:  prop(p, 'Rate EUR per Day'),
          clientSector: prop(p, 'Client Sector'),
          durationMonths: prop(p, 'Duration Months'),
        }));
        cache.set(key, data);
        return data;
      })(),
      (async () => {
        const key = ck('signals', req.ws);
        const c = cache.get(key);
        if (c) return c;
        const pages = await queryAll(req.ws.client, req.ws.dbs.signals);
        const data = pages.map(p => ({
          month:       prop(p, 'Month'),
          year:        prop(p, 'Year'),
          hiringIndex: prop(p, 'Hiring Index'),
        }));
        cache.set(key, data);
        return data;
      })(),
      (async () => {
        const key = ck('config', req.ws);
        return cache.get(key) || {};
      })(),
    ]);

    const cashflowHistory     = cashflowData.status  === 'fulfilled' ? cashflowData.value  : [];
    const historicalContracts = historyData.status   === 'fulfilled' ? historyData.value   : [];
    const signals             = signalsData.status   === 'fulfilled' ? signalsData.value   : [];
    const config              = { ...(configData.status === 'fulfilled' ? configData.value : {}), ...bodyConfig };

    const result = assessContract({
      cashflowHistory,
      contract,
      historicalContracts,
      signals,
      config,
    });

    res.json(result);
  } catch (e) {
    console.error('[forecast/assess]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/simulate ────────────────────────────────────────────────────────
// Pure computation — no Notion calls. Returns 18-month projection + comparison.
//
// Body:
//   baseline  — current contract params (see defaultScenario())
//   candidate — new role params
//   tax       — optional NL tax overrides { mkbPct, zvwPct, za }
//   mode      — 'compare' (default) | 'single' | 'bands'
//
router.post('/simulate', (req, res) => {
  try {
    const { baseline, candidate, tax = {}, mode = 'compare' } = req.body || {};

    const def = defaultScenario();

    if (mode === 'single') {
      // Single scenario projection (no comparison)
      if (!candidate && !baseline) {
        return res.status(400).json({ error: 'Provide baseline or candidate for single mode.' });
      }
      const scenario = { ...def, ...(candidate || baseline) };
      const result   = projectWithBands(scenario, tax);
      return res.json(result);
    }

    if (mode === 'tax') {
      // Tax-only calculation
      const annualProfit = parseFloat(req.body.annualProfit) || 0;
      return res.json(calcNLTax(annualProfit, {
        mkbPct:  tax.mkbPct != null ? tax.mkbPct / 100 : undefined,
        zvwRate: tax.zvwPct != null ? tax.zvwPct / 100 : undefined,
        zelfstandigenAftrek: tax.za,
      }));
    }

    // Default: compare baseline vs candidate
    if (!baseline || !candidate) {
      return res.status(400).json({ error: 'Both baseline and candidate scenarios are required for compare mode.' });
    }

    const b = { ...def, name: 'Current Contract', ...baseline };
    const c = { ...def, name: 'New Opportunity',  ...candidate };

    const result = compare(b, c, tax);
    return res.json(result);

  } catch (e) {
    console.error('[simulate]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/feed ─────────────────────────────────────────────────────────────
// Returns scored job feed (cached 1hr). Optionally filters by tier.
// Query params: ?tier=HOT,WARM  ?limit=20
//
router.get('/feed', requireWorkspace, async (req, res) => {
  try {
    // Use profile skills from Notion to personalise scoring
    const cfgCacheKey = `config:${req.ws.id}`;
    const cfg         = cache.get(cfgCacheKey) || {};
    const profileSkills = (cfg.skills || []).map(s => s.label);

    const items = await getFeed(profileSkills);

    // Optional tier filter
    const tierFilter = req.query.tier
      ? req.query.tier.split(',').map(t => t.trim().toUpperCase())
      : null;

    const filtered = tierFilter
      ? items.filter(i => tierFilter.includes(i.tier))
      : items;

    // Optional limit
    const limit  = parseInt(req.query.limit) || 100;
    const paged  = filtered.slice(0, limit);

    res.json({ meta: getFeedMeta(), items: paged });
  } catch (e) {
    console.error('[feed]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/feed/refresh ─────────────────────────────────────────────────────
// Manually trigger an immediate feed refresh.
//
router.post('/feed/refresh', requireWorkspace, async (req, res) => {
  try {
    const cfgCacheKey  = `config:${req.ws.id}`;
    const cfg          = cache.get(cfgCacheKey) || {};
    const profileSkills = (cfg.skills || []).map(s => s.label);

    const items = await refreshFeed(profileSkills);
    res.json({ refreshed: true, count: items.length, meta: getFeedMeta() });
  } catch (e) {
    console.error('[feed/refresh]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/feed/meta ────────────────────────────────────────────────────────
// Returns feed metadata without re-fetching items.
//
router.get('/feed/meta', (_req, res) => {
  res.json(getFeedMeta());
});

// ── GET /api/health ───────────────────────────────────────────────────────────
router.get('/health', (_req, res) => {
  res.json({
    status:     'ok',
    workspaces: listWorkspaces().map(w => w.id),
    cache:      cache.size,
    ts:         new Date().toISOString(),
  });
});

// ── POST /api/cache/clear ─────────────────────────────────────────────────────
router.post('/cache/clear', (req, res) => {
  const ws = req.query.ws;
  if (ws) {
    cache.delPrefix(ws + ':');
    res.json({ cleared: `workspace ${ws}` });
  } else {
    cache.clear();
    res.json({ cleared: 'all' });
  }
});

// ── Scenario Planner endpoints ────────────────────────────────────────────────
//
// Requires DB_SCENARIOS and DB_SCENARIO_PROJECTIONS in .env
// (run setup-scenarios.js once to create these databases in Notion)
//
// Routes:
//   GET    /api/scenarios              — list all scenarios
//   POST   /api/scenarios              — create a new scenario
//   PATCH  /api/scenarios/:id          — update scenario parameters
//   DELETE /api/scenarios/:id          — archive a scenario
//   POST   /api/scenarios/:id/compute  — compute 18-month projections + write to Notion
//   GET    /api/scenarios/:id/projections — read stored projections for one scenario
//   GET    /api/scenarios/compare      — compare projections for multiple scenarios (?ids=id1,id2,...)

function requireScenariosDb(req, res, next) {
  const ws = req.ws;
  if (!ws.dbs.scenarios) {
    return res.status(503).json({
      error: 'Scenario Planner not configured. Run: node setup-scenarios.js',
    });
  }
  if (!ws.dbs.scenarioProjections) {
    return res.status(503).json({
      error: 'Scenario Projections DB not configured. Run: node setup-scenarios.js',
    });
  }
  next();
}

// GET /api/scenarios
router.get('/scenarios', requireWorkspace, requireScenariosDb, async (req, res) => {
  try {
    const key    = ck('scenarios', req.ws);
    const cached = cache.get(key);
    if (cached) return res.json(cached);

    const scenarios = await scenarioStore.listScenarios(req.ws.client, req.ws.dbs.scenarios);
    cache.set(key, scenarios, 30); // 30s TTL
    res.json(scenarios);
  } catch (e) {
    console.error('[scenarios GET]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// POST /api/scenarios — create new scenario
router.post('/scenarios', requireWorkspace, requireScenariosDb, async (req, res) => {
  try {
    const scenario = await scenarioStore.createScenario(
      req.ws.client, req.ws.dbs.scenarios, req.body
    );
    cache.del(ck('scenarios', req.ws));
    res.json({ success: true, scenario });
  } catch (e) {
    console.error('[scenarios POST]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// PATCH /api/scenarios/:id — update scenario parameters
router.patch('/scenarios/:id', requireWorkspace, requireScenariosDb, async (req, res) => {
  try {
    const scenario = await scenarioStore.updateScenario(
      req.ws.client, req.params.id, req.body
    );
    cache.del(ck('scenarios', req.ws));
    res.json({ success: true, scenario });
  } catch (e) {
    console.error('[scenarios PATCH]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// DELETE /api/scenarios/:id — archive a scenario
router.delete('/scenarios/:id', requireWorkspace, requireScenariosDb, async (req, res) => {
  try {
    await scenarioStore.archiveScenario(req.ws.client, req.params.id);
    cache.del(ck('scenarios', req.ws));
    res.json({ success: true, archived: req.params.id });
  } catch (e) {
    console.error('[scenarios DELETE]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// POST /api/scenarios/:id/compute — run projection engine and write time series to Notion
// Body: optional { tax: { mkbPct, zvwPct } }
router.post('/scenarios/:id/compute', requireWorkspace, requireScenariosDb, async (req, res) => {
  try {
    const taxOverrides = req.body?.tax || {};

    // Fetch config for NL tax params if not overridden
    const cfgKey = ck('config', req.ws);
    const cfg    = cache.get(cfgKey) || {};
    const tax    = {
      mkbPct: taxOverrides.mkbPct ?? cfg.mkbPct,
      zvwPct: taxOverrides.zvwPct ?? cfg.zvwPct,
    };

    // Extract seasonal burn map from request body (sent by frontend after
    // fetching /api/spending/seasonal). Keyed by calendar month string "1"–"12".
    const seasonalBurnMap = req.body?.seasonalBurnMap || null;
    // Normalise keys to integers (JSON may stringify numeric keys as strings)
    const normalisedSeasonalMap = seasonalBurnMap
      ? Object.fromEntries(Object.entries(seasonalBurnMap).map(([k, v]) => [parseInt(k, 10), v]))
      : null;

    console.log(`[scenarios/compute] Starting MC computation for ${req.params.id}` +
      (normalisedSeasonalMap ? ' (with seasonal burn map)' : ''));
    const result = await scenarioStore.computeAndStore(
      req.ws.client,
      req.ws.dbs.scenarios,
      req.ws.dbs.scenarioProjections,
      req.params.id,
      tax,
      req.ws,                    // ← pass workspace for ML learning from history
      normalisedSeasonalMap ? { seasonalBurnMap: normalisedSeasonalMap } : {},
    );

    // Bust caches
    cache.del(ck('scenarios', req.ws));
    cache.del(`projections:${req.params.id}:${req.ws.id}`);

    console.log(`[scenarios/compute] Done — wrote ${result.written} rows (${result.mcRuns} MC runs, learned from ${result.learnedFrom})`);
    res.json({
      success:     true,
      scenario:    result.scenario,
      summary:     result.summary,
      tax:         result.tax,
      cleared:     result.cleared,
      written:     result.written,
      mcRuns:      result.mcRuns,
      mcEnd:       result.mcEnd,
      learnedFrom: result.learnedFrom,
    });
  } catch (e) {
    console.error('[scenarios/compute]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// GET /api/ml/insights — return learned distributions from Notion history
router.get('/ml/insights', requireWorkspace, async (req, res) => {
  try {
    const { learnFromHistory } = require('../lib/mlEngine');
    const cacheKey = `ml_insights:${req.ws.id}`;
    const cached   = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const insights = await learnFromHistory(req.ws.client, req.ws);
    cache.set(cacheKey, insights, 300); // cache 5 mins
    res.json(insights);
  } catch (e) {
    console.error('[ml/insights]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// GET /api/scenarios/compare?ids=id1,id2,id3 — multi-scenario comparison grid
// IMPORTANT: registered before /:id/projections so static path wins
router.get('/scenarios/compare', requireWorkspace, requireScenariosDb, async (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 scenario IDs as ?ids=id1,id2' });
    }
    const result = await scenarioStore.compareProjections(
      req.ws.client, req.ws.dbs.scenarioProjections, ids
    );
    res.json(result);
  } catch (e) {
    console.error('[scenarios/compare]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// GET /api/scenarios/:id/projections — read stored monthly projections
router.get('/scenarios/:id/projections', requireWorkspace, requireScenariosDb, async (req, res) => {
  try {
    const cacheKey = `projections:${req.params.id}:${req.ws.id}`;
    const cached   = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const projections = await scenarioStore.getProjections(
      req.ws.client, req.ws.dbs.scenarioProjections, req.params.id
    );
    cache.set(cacheKey, projections, 60);
    res.json(projections);
  } catch (e) {
    console.error('[scenarios/projections GET]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── Spending Engine Integration ───────────────────────────────────────────────
//
// These routes implement the 5-step integration loop described in the Abundant
// Spending Engine spec:
//   1.  GET  /api/spending/seasonal       — 18-month seasonal spend baselines
//   2.  GET  /api/spending/net-cashflow   — income vs spend overlay (18m)
//   3.  POST /api/income/projected        — push income projection from scenario run
//   4.  GET  /api/spending/abundance      — latest abundance score from Cashflow Months
//
// Seasonal baselines come from the Cashflow Months DB (ML Predicted Spend EUR).
// Hardcoded 5-year averages are the fallback when DB rows are sparse.
// ─────────────────────────────────────────────────────────────────────────────

// 5-year spending seasonality baselines (monthly calendar averages, EUR)
// Source: Abundant Spending Engine — used when DB values are absent
const SEASONAL_FALLBACK = {
  1:  5200,   // Jan — medium
  2:  2400,   // Feb — low  (historically quietest)
  3:  2600,   // Mar — low
  4:  5200,   // Apr — medium
  5:  7100,   // May — high (first summer spike)
  6:  5200,   // Jun — medium
  7:  7400,   // Jul — high (peak summer)
  8:  7000,   // Aug — high
  9:  7000,   // Sep — high
  10: 5200,   // Oct — medium
  11: 11048,  // Nov — outlier (year-end expenses)
  12: 5200,   // Dec — medium
};

// Risk classification matching the spending engine thresholds
function spendRisk(monthNum) {
  if ([2, 3].includes(monthNum))             return 'Low';
  if ([5, 7, 8, 9, 11].includes(monthNum))  return 'High';
  return 'Medium';
}

// In-memory projected income store (keyed by YYYY-MM)
const _projectedIncome = new Map();

// ── GET /api/spending/seasonal ────────────────────────────────────────────────
// Returns calendar month baselines (1–12) from the Cashflow Months DB.
// Falls back to 5-year hardcoded averages where DB rows are missing.
router.get('/spending/seasonal', requireWorkspace, async (req, res) => {
  const cacheKey = ck('spending_seasonal', req.ws);
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Pull Cashflow Months rows that have ML Predicted Spend EUR
    const pages = await queryAll(req.ws.client, req.ws.dbs.cashflow, undefined, [
      { property: 'Date', direction: 'ascending' },
    ]);

    // Group by calendar month number and average the ML predicted spend
    const monthSums   = {};
    const monthCounts = {};
    for (const p of pages) {
      const mo   = prop(p, 'Month Number');
      const ml   = prop(p, 'ML Predicted Spend EUR');
      if (!mo || ml == null) continue;
      monthSums[mo]   = (monthSums[mo]   || 0) + ml;
      monthCounts[mo] = (monthCounts[mo] || 0) + 1;
    }

    // Build 12-month map; fill gaps with fallback
    const baselines = {};
    for (let m = 1; m <= 12; m++) {
      baselines[m] = monthCounts[m]
        ? Math.round(monthSums[m] / monthCounts[m])
        : SEASONAL_FALLBACK[m];
    }

    // Compute bounds (+60% lower headroom, +80% upper headroom based on spec)
    const result = { baselines, bounds: {}, risk: {}, source: {} };
    for (let m = 1; m <= 12; m++) {
      const base         = baselines[m];
      result.bounds[m]   = { lower: Math.round(base * 0.60), upper: Math.round(base * 1.80) };
      result.risk[m]     = spendRisk(m);
      result.source[m]   = monthCounts[m] ? 'notion' : 'fallback';
    }

    cache.set(cacheKey, result, 300); // cache 5 min
    res.json(result);
  } catch (e) {
    console.error('[spending/seasonal]', e.message);
    // Always serve fallback so frontend never blocks
    const result = { baselines: { ...SEASONAL_FALLBACK }, bounds: {}, risk: {}, source: {} };
    for (let m = 1; m <= 12; m++) {
      const base        = SEASONAL_FALLBACK[m];
      result.bounds[m]  = { lower: Math.round(base * 0.60), upper: Math.round(base * 1.80) };
      result.risk[m]    = spendRisk(m);
      result.source[m]  = 'fallback';
    }
    res.json(result);
  }
});

// ── GET /api/spending/net-cashflow ────────────────────────────────────────────
// Combines 18 months of projected income (from _projectedIncome store + cashflow
// history) with the seasonal spend baselines to return surplus/deficit per month.
router.get('/spending/net-cashflow', requireWorkspace, async (req, res) => {
  try {
    // Get seasonal baselines (reuse cache)
    const seasonKey    = ck('spending_seasonal', req.ws);
    let seasonData     = cache.get(seasonKey);
    if (!seasonData) {
      seasonData = { baselines: { ...SEASONAL_FALLBACK } };
    }

    // Get cashflow history for actuals
    const cashflowKey  = ck('cashflow', req.ws);
    const history      = cache.get(cashflowKey) || [];

    // Build 18-month forward view starting from current month
    const today  = new Date();
    const months = [];
    for (let i = 0; i < 18; i++) {
      const dt      = new Date(today.getFullYear(), today.getMonth() + i, 1);
      const yyyymm  = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      const calMo   = dt.getMonth() + 1;
      const label   = dt.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });

      // Actual from history if available
      const actual  = history.find(h => (h.date || '').startsWith(yyyymm));

      // Projected income: from in-memory store or actual gross revenue
      const projInc = _projectedIncome.get(yyyymm) ?? (actual?.grossRevenue ?? null);
      // ML spend baseline
      const mlSpend = seasonData.baselines[calMo] ?? SEASONAL_FALLBACK[calMo];

      months.push({
        month:           yyyymm,
        label,
        calendarMonth:   calMo,
        projectedIncome: projInc,
        projectedSpend:  mlSpend,
        netCashflow:     projInc != null ? projInc - mlSpend : null,
        surplusDeficit:  projInc != null ? (projInc >= mlSpend ? 'surplus' : 'deficit') : 'unknown',
        spendingRisk:    seasonData.risk?.[calMo] ?? spendRisk(calMo),
        isActual:        !!actual,
      });
    }

    res.json({ months, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[spending/net-cashflow]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── GET /api/spending/abundance ───────────────────────────────────────────────
// Latest abundance score from the Cashflow Months DB.
// Returns the most recent row that has an Abundance Score set.
router.get('/spending/abundance', requireWorkspace, async (req, res) => {
  const cacheKey = ck('spending_abundance', req.ws);
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const pages = await queryAll(req.ws.client, req.ws.dbs.cashflow, undefined, [
      { property: 'Date', direction: 'descending' },
    ]);

    let latestScore = null;
    let latestDate  = null;
    for (const p of pages) {
      const score = prop(p, 'Abundance Score');
      if (score != null) {
        latestScore = score;
        latestDate  = prop(p, 'Date');
        break; // descending sort — first hit is most recent
      }
    }

    const result = {
      score:  latestScore,
      date:   latestDate,
      label:  latestScore == null ? 'No data'
            : latestScore >= 70   ? 'Abundant'
            : latestScore >= 40   ? 'Balanced'
            : 'Constrained',
    };
    cache.set(cacheKey, result, 300);
    res.json(result);
  } catch (e) {
    console.error('[spending/abundance]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── POST /api/income/projected ────────────────────────────────────────────────
// Accept income projections from scenario runs (or external callers).
// Payload: { date: "2026-08-01", amount: 23000, source: "scenario", confidence: 0.95 }
// Or array: [{ date, amount, source, confidence }, ...]
// Stores in memory; recalculates net cashflow cache.
router.post('/income/projected', requireWorkspace, (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    const updated = [];

    for (const item of items) {
      if (!item.date || item.amount == null) continue;
      const yyyymm = item.date.slice(0, 7); // "2026-08" from "2026-08-01"
      _projectedIncome.set(yyyymm, {
        amount:     item.amount,
        source:     item.source     || 'scenario',
        confidence: item.confidence ?? 1.0,
        pushedAt:   new Date().toISOString(),
      });
      updated.push(yyyymm);
    }

    // Bust net-cashflow cache so next GET reflects new projections
    cache.del(ck('spending_net_cashflow', req.ws));

    res.json({ ok: true, updated, total: _projectedIncome.size });
  } catch (e) {
    console.error('[income/projected POST]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── FORECAST v2 — Engagements & Outreach ─────────────────────────────────────
//
// Engagements = contract-driven source of truth for the Forecast tab.
// Each row: Client Name, Monthly Rate EUR, BTW Applicable, Status,
//           Start Date, End Date, Days Per Week, Renewal Probability, Notes.
//
// Outreach = log of recruiter/client messages dispatched from Pipeline tab.
//
// Opportunities (existing DB) is reused for Role matching + radar.
//   Added columns: Runway Impact Weeks, Outreach Sent.
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/engagements ──────────────────────────────────────────────────────
router.get('/engagements', requireWorkspace, async (req, res) => {
  const key    = ck('engagements', req.ws);
  const cached = cache.get(key);
  if (cached) return res.json(cached);

  try {
    const dbId = req.ws.dbs.engagements;
    if (!dbId) return res.status(503).json({ error: 'DB_ENGAGEMENTS not configured' });

    const pages = await queryAll(req.ws.client, dbId, undefined, [
      { property: 'Status', direction: 'ascending' },
    ]);

    const data = pages.map(p => ({
      id:                 p.id,
      clientName:         prop(p, 'Client Name'),
      monthlyRateEur:     prop(p, 'Monthly Rate EUR'),
      btwApplicable:      prop(p, 'BTW Applicable') ?? false,
      status:             prop(p, 'Status'),
      startDate:          prop(p, 'Start Date'),
      endDate:            prop(p, 'End Date'),
      daysPerWeek:        prop(p, 'Days Per Week'),
      renewalProbability: prop(p, 'Renewal Probability'),
      notes:              prop(p, 'Notes'),
    }));

    cache.set(key, data, 60);
    res.json(data);
  } catch (e) {
    console.error('[engagements GET]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── POST /api/engagements ─────────────────────────────────────────────────────
router.post('/engagements', requireWorkspace, async (req, res) => {
  const d = req.body;
  if (!d.clientName) return res.status(400).json({ error: 'clientName is required' });

  const dbId = req.ws.dbs.engagements;
  if (!dbId) return res.status(503).json({ error: 'DB_ENGAGEMENTS not configured' });

  try {
    const page = await req.ws.client.pages.create({
      parent: { database_id: dbId },
      properties: {
        'Client Name':         { title:    [{ text: { content: String(d.clientName) } }] },
        'Monthly Rate EUR':    { number:   parseFloat(d.monthlyRateEur) || 0 },
        'BTW Applicable':      { checkbox: !!d.btwApplicable },
        'Status':              { select:   { name: d.status || 'Active' } },
        ...(d.startDate          ? { 'Start Date':          { date: { start: d.startDate } } } : {}),
        ...(d.endDate            ? { 'End Date':            { date: { start: d.endDate   } } } : {}),
        ...(d.daysPerWeek != null ? { 'Days Per Week':      { number: parseFloat(d.daysPerWeek) || 5 } } : {}),
        ...(d.renewalProbability != null ? { 'Renewal Probability': { number: parseFloat(d.renewalProbability) } } : {}),
        ...(d.notes              ? { 'Notes':               { rich_text: [{ text: { content: String(d.notes) } }] } } : {}),
      },
    });
    cache.del(ck('engagements', req.ws));
    res.json({ id: page.id, success: true, url: page.url });
  } catch (e) {
    console.error('[engagements POST]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── PATCH /api/engagements/:id ────────────────────────────────────────────────
router.patch('/engagements/:id', requireWorkspace, async (req, res) => {
  const d = req.body;
  try {
    const props = {};
    if (d.monthlyRateEur    != null) props['Monthly Rate EUR']    = { number:   parseFloat(d.monthlyRateEur) };
    if (d.btwApplicable     != null) props['BTW Applicable']      = { checkbox: !!d.btwApplicable };
    if (d.status                   ) props['Status']              = { select:   { name: d.status } };
    if (d.endDate                  ) props['End Date']            = { date:     { start: d.endDate } };
    if (d.renewalProbability!= null) props['Renewal Probability'] = { number:   parseFloat(d.renewalProbability) };
    if (d.notes                    ) props['Notes']               = { rich_text:[{ text: { content: String(d.notes) } }] };

    await req.ws.client.pages.update({ page_id: req.params.id, properties: props });
    cache.del(ck('engagements', req.ws));
    res.json({ success: true });
  } catch (e) {
    console.error('[engagements PATCH]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── GET /api/outreach ─────────────────────────────────────────────────────────
router.get('/outreach', requireWorkspace, async (req, res) => {
  const key    = ck('outreach', req.ws);
  const cached = cache.get(key);
  if (cached) return res.json(cached);

  try {
    const dbId = req.ws.dbs.outreach;
    if (!dbId) return res.status(503).json({ error: 'DB_OUTREACH not configured' });

    const pages = await queryAll(req.ws.client, dbId, undefined, [
      { property: 'Sent Date', direction: 'descending' },
    ]);

    const data = pages.map(p => ({
      id:             p.id,
      subject:        prop(p, 'Subject'),
      recipient:      prop(p, 'Recipient'),
      recipientEmail: prop(p, 'Recipient Email'),
      channel:        prop(p, 'Channel'),
      messageBody:    prop(p, 'Message Body'),
      status:         prop(p, 'Status'),
      sentDate:       prop(p, 'Sent Date'),
      followUpDate:   prop(p, 'Follow Up Date'),
      notes:          prop(p, 'Notes'),
    }));

    cache.set(key, data, 60);
    res.json(data);
  } catch (e) {
    console.error('[outreach GET]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── POST /api/outreach ────────────────────────────────────────────────────────
// Saves a new outreach record to Notion.
// Body: { subject, recipient, recipientEmail?, channel, messageBody, status?,
//         sentDate?, followUpDate?, notes? }
router.post('/outreach', requireWorkspace, async (req, res) => {
  const d = req.body;
  if (!d.subject || !d.recipient) {
    return res.status(400).json({ error: 'subject and recipient are required' });
  }

  const dbId = req.ws.dbs.outreach;
  if (!dbId) return res.status(503).json({ error: 'DB_OUTREACH not configured' });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const page  = await req.ws.client.pages.create({
      parent: { database_id: dbId },
      properties: {
        'Subject':        { title:     [{ text: { content: String(d.subject) } }] },
        'Recipient':      { rich_text: [{ text: { content: String(d.recipient) } }] },
        'Channel':        { select:    { name: d.channel || 'Email' } },
        'Message Body':   { rich_text: [{ text: { content: String(d.messageBody || '') } }] },
        'Status':         { select:    { name: d.status  || 'Sent' } },
        ...(d.recipientEmail ? { 'Recipient Email': { email: d.recipientEmail } } : {}),
        ...(d.sentDate       ? { 'Sent Date':       { date: { start: d.sentDate       } } }
                             : { 'Sent Date':       { date: { start: today            } } }),
        ...(d.followUpDate   ? { 'Follow Up Date':  { date: { start: d.followUpDate   } } } : {}),
        ...(d.notes          ? { 'Notes':           { rich_text: [{ text: { content: String(d.notes) } }] } } : {}),
      },
    });
    cache.del(ck('outreach', req.ws));
    res.json({ id: page.id, success: true, url: page.url });
  } catch (e) {
    console.error('[outreach POST]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── PATCH /api/opportunities/:id ──────────────────────────────────────────────
// Update outreach status, runway impact, or match score on a role.
router.patch('/opportunities/:id', requireWorkspace, async (req, res) => {
  const d = req.body;
  try {
    const props = {};
    if (d.status                ) props['Status']              = { select: { name: d.status } };
    if (d.action                ) props['Action']              = { select: { name: d.action } };
    if (d.outreachSent != null  ) props['Outreach Sent']       = { checkbox: !!d.outreachSent };
    if (d.runwayImpactWeeks != null) props['Runway Impact Weeks'] = { number: parseFloat(d.runwayImpactWeeks) };
    if (d.matchScore    != null ) props['Match Score']         = { number: parseFloat(d.matchScore) };
    if (d.notes                 ) props['Notes']               = { rich_text: [{ text: { content: String(d.notes) } }] };

    await req.ws.client.pages.update({ page_id: req.params.id, properties: props });
    cache.del(ck('opportunities', req.ws));
    res.json({ success: true });
  } catch (e) {
    console.error('[opportunities PATCH]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── GET /api/ml/seasonal ──────────────────────────────────────────────────────
// Returns monthly income multipliers derived from cashflow actuals.
// Multiplier 1.0 = average month. Used by the Forecast tab to show seasonal
// adjustment to contract revenue projections.
// Also returns expense seasonality from spending/seasonal for the Intelligence tab.
router.get('/ml/seasonal', requireWorkspace, async (req, res) => {
  const cacheKey = ck('ml_seasonal', req.ws);
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Pull cashflow history (ascending to build actuals)
    const pages = await queryAll(req.ws.client, req.ws.dbs.cashflow, undefined, [
      { property: 'Date', direction: 'ascending' },
    ]);

    // Group gross revenue by calendar month → compute average per month
    const revSums   = {};
    const revCounts = {};
    for (const p of pages) {
      const mo  = prop(p, 'Month Number');
      const rev = prop(p, 'Gross Revenue EUR');
      if (!mo || rev == null || rev === 0) continue;
      revSums[mo]   = (revSums[mo]   || 0) + rev;
      revCounts[mo] = (revCounts[mo] || 0) + 1;
    }

    // Compute average per known month, then normalise to a multiplier
    const avgRevByMonth = {};
    for (let m = 1; m <= 12; m++) {
      if (revCounts[m]) avgRevByMonth[m] = revSums[m] / revCounts[m];
    }

    const knownAvgs = Object.values(avgRevByMonth);
    const overallAvg = knownAvgs.length
      ? knownAvgs.reduce((a, b) => a + b, 0) / knownAvgs.length
      : null;

    const incomeMultipliers = {};
    const incomeSource      = {};
    for (let m = 1; m <= 12; m++) {
      if (avgRevByMonth[m] && overallAvg) {
        incomeMultipliers[m] = Math.round((avgRevByMonth[m] / overallAvg) * 100) / 100;
        incomeSource[m]      = 'notion';
      } else {
        // Neutral multiplier — no data for this month
        incomeMultipliers[m] = 1.0;
        incomeSource[m]      = 'neutral';
      }
    }

    // Expense seasonality: reuse spending/seasonal cache if available
    const spendKey  = ck('spending_seasonal', req.ws);
    const spendData = cache.get(spendKey);
    const expenseBaselines = spendData?.baselines || null;

    // Compute expense multipliers if available
    const expenseMultipliers = {};
    if (expenseBaselines) {
      const expVals = Object.values(expenseBaselines);
      const expAvg  = expVals.reduce((a, b) => a + b, 0) / expVals.length;
      for (let m = 1; m <= 12; m++) {
        expenseMultipliers[m] = expAvg > 0
          ? Math.round((expenseBaselines[m] / expAvg) * 100) / 100
          : 1.0;
      }
    }

    // Data quality: number of actuals used
    const dataPoints = Object.values(revCounts).reduce((a, b) => a + b, 0);

    const result = {
      incomeMultipliers,
      incomeSource,
      expenseMultipliers: Object.keys(expenseMultipliers).length ? expenseMultipliers : null,
      expenseBaselines:   expenseBaselines || null,
      dataPoints,
      confidence: dataPoints >= 12 ? 'high' : dataPoints >= 6 ? 'medium' : 'low',
      generatedAt: new Date().toISOString(),
    };

    cache.set(cacheKey, result, 300);
    res.json(result);
  } catch (e) {
    console.error('[ml/seasonal]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

// ── GET /api/forecast/build ───────────────────────────────────────────────────
// Contract-driven forecast builder.
// Combines engagements + seasonal multipliers → 12-month income projection
// for each scenario (base/conservative/optimistic/custom).
// Query: ?scenario=base|conservative|optimistic  (default: base)
//
// base:         all Active engagements at 100% rate
// conservative: Active at 100%, Pipeline at 50%
// optimistic:   Active at 100%, Pipeline at 100%
//
// Returns: months[]{month, label, grossRevenue, netRevenue, burn, runway,
//                   btwProvision, taxProvision, surplusDeficit}
//          + summary { totalRunway, avgNet, runwayMonths }
router.get('/forecast/build', requireWorkspace, async (req, res) => {
  const scenario = (req.query.scenario || 'base').toLowerCase();

  try {
    // Fetch engagements, config, seasonal multipliers in parallel
    const [engagements, cfgRaw, seasonal] = await Promise.all([
      (async () => {
        const key    = ck('engagements', req.ws);
        const cached = cache.get(key);
        if (cached) return cached;
        const dbId   = req.ws.dbs.engagements;
        if (!dbId) return [];
        const pages  = await queryAll(req.ws.client, dbId);
        return pages.map(p => ({
          id:                 p.id,
          clientName:         prop(p, 'Client Name'),
          monthlyRateEur:     prop(p, 'Monthly Rate EUR') ?? 0,
          btwApplicable:      prop(p, 'BTW Applicable')   ?? false,
          status:             prop(p, 'Status'),
          startDate:          prop(p, 'Start Date'),
          endDate:            prop(p, 'End Date'),
          renewalProbability: prop(p, 'Renewal Probability') ?? 50,
        }));
      })(),
      (async () => cache.get(ck('config', req.ws)) || {})(),
      (async () => {
        const key    = ck('ml_seasonal', req.ws);
        const cached = cache.get(key);
        if (cached) return cached;
        return null; // will use neutral multipliers
      })(),
    ]);

    const cfg = cfgRaw;
    const vatPct     = (cfg.vatPct     ?? 21) / 100;
    const taxResPct  = (cfg.taxReservePct ?? 35) / 100;
    const burnRate   = cfg.burn ?? 0;

    // Income multiplier (fallback: 1.0 for all months)
    const incMult = seasonal?.incomeMultipliers || {};

    // Filter engagements by scenario rules
    const active   = engagements.filter(e => e.status === 'Active');
    const pipeline = engagements.filter(e => e.status === 'Pipeline');

    function scenarioWeight(status) {
      if (status === 'Active')   return 1.0;
      if (status === 'Pipeline') {
        if (scenario === 'base')         return 0;
        if (scenario === 'conservative') return 0.5;
        if (scenario === 'optimistic')   return 1.0;
      }
      return 0;
    }

    // Build 12-month forward projection
    const today   = new Date();
    const months  = [];
    let   balance = cfg.wiseBalance ?? 0;

    for (let i = 0; i < 12; i++) {
      const dt      = new Date(today.getFullYear(), today.getMonth() + i, 1);
      const yyyymm  = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      const calMo   = dt.getMonth() + 1;
      const label   = dt.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
      const mult    = incMult[calMo] ?? 1.0;

      // Gross revenue: sum active + weighted pipeline
      let grossRevenue = 0;
      let btwRevenue   = 0;

      for (const eng of [...active, ...pipeline]) {
        const w = scenarioWeight(eng.status);
        if (!w) continue;

        // Check date overlap (if dates set)
        if (eng.startDate && eng.startDate > yyyymm + '-31') continue;
        if (eng.endDate   && eng.endDate   < yyyymm + '-01') continue;

        const rate = (eng.monthlyRateEur ?? 0) * mult * w;
        grossRevenue += rate;
        if (eng.btwApplicable) btwRevenue += rate;
      }

      const btwProvision   = Math.round(btwRevenue * vatPct);
      const taxProvision   = Math.round((grossRevenue - btwProvision) * taxResPct);
      const netRevenue     = Math.round(grossRevenue - btwProvision - taxProvision);
      const surplus        = netRevenue - burnRate;
      balance             += surplus;

      months.push({
        month:          yyyymm,
        label,
        calendarMonth:  calMo,
        grossRevenue:   Math.round(grossRevenue),
        btwProvision,
        taxProvision,
        netRevenue,
        burn:           burnRate,
        surplusDeficit: surplus,
        closingBalance: Math.round(balance),
        seasonalMult:   mult,
        activeContracts: active.length + pipeline.filter(e => scenarioWeight(e.status) > 0).length,
      });
    }

    // Summary metrics
    const runwayMonths = burnRate > 0
      ? months.findIndex(m => m.closingBalance <= 0)
      : 99;
    const avgNet = months.length
      ? Math.round(months.reduce((s, m) => s + m.netRevenue, 0) / months.length)
      : 0;

    // Expiring engagements (within 90 days)
    const ninetyDaysOut = new Date(today.getTime() + 90 * 86400000).toISOString().slice(0, 10);
    const expiringSoon  = active
      .filter(e => e.endDate && e.endDate <= ninetyDaysOut)
      .map(e => ({
        id:      e.id,
        client:  e.clientName,
        endDate: e.endDate,
        daysLeft: Math.round((new Date(e.endDate) - today) / 86400000),
        renewalProbability: e.renewalProbability,
      }));

    res.json({
      scenario,
      months,
      summary: {
        avgNet,
        runwayMonths:    runwayMonths < 0 ? months.length : runwayMonths,
        runwayLabel:     runwayMonths < 0 ? `${months.length}+ mo` : `${runwayMonths} mo`,
        totalEngagements: engagements.length,
        activeEngagements: active.length,
        pipelineEngagements: pipeline.length,
      },
      expiringSoon,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[forecast/build]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
});

module.exports = router;
