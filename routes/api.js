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

const router = Router();

// ── Middleware: resolve workspace ──────────────────────────────────────────────
function requireWorkspace(req, res, next) {
  const ws = getWorkspace(req.query.ws);
  if (!ws) {
    return res.status(400).json({
      error: `Workspace "${req.query.ws}" not found. Available: ${listWorkspaces().map(w => w.id).join(', ')}`,
    });
  }
  if (!ws.client._auth) {
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
router.get('/config', requireWorkspace, async (req, res) => {
  const key = ck('config', req.ws);
  const cached = cache.get(key);
  if (cached) return res.json(cached);

  try {
    const pages = await queryAll(req.ws.client, req.ws.dbs.profile);

    // Start with nulls — no fallbacks baked in
    const cfg = {
      name: null, currency: null, hourlyRate: null, dayRate: null,
      burn: null, wiseBalance: null, contractEnd: null, agency: null,
      client: null, mkbPct: null, zvwPct: null, fxBuffer: null,
      payLagDays: null, taxReservePct: null, tags: [], skills: [],
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
        default:
          if (category === 'Skills — Tier 1') cfg.skills.push({ label: parameter, tier: 1 });
          else if (category === 'Skills — Tier 2') cfg.skills.push({ label: parameter, tier: 2 });
          else if (category === 'Skills — Tier 3') cfg.skills.push({ label: parameter, tier: 3 });
      }
    }

    cache.set(key, cfg);
    res.json(cfg);
  } catch (e) {
    console.error('[config]', e.message);
    res.status(500).json({ error: translateError(e) });
  }
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
    const data = pages.map(p => ({
      id:              p.id,
      label:           prop(p, 'Month Label'),
      date:            prop(p, 'Date'),
      year:            prop(p, 'Year'),
      monthNumber:     prop(p, 'Month Number'),
      grossRevenue:    prop(p, 'Gross Revenue EUR'),
      monthlyBurn:     prop(p, 'Monthly Burn EUR'),
      taxReserve:      prop(p, 'Tax Reserve EUR'),
      netAfterTax:     prop(p, 'Net After Tax EUR'),
      closingBalance:  prop(p, 'Closing Balance EUR'),
      wiseSnapshot:    prop(p, 'Wise Balance Snapshot'),
      contractsActive: prop(p, 'Contracts Active'),
      paymentLag:      prop(p, 'Payment Lag Days'),
      seasonScore:     prop(p, 'Season Score'),
      fxRate:          prop(p, 'FX Rate Applied'),
      currency:        prop(p, 'Invoice Currency'),
      zone:            prop(p, 'Zone'),
      decisionScore:   prop(p, 'Decision Score'),
      notes:           prop(p, 'Notes'),
    }));
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
      id:              p.id,
      roleTitle:       prop(p, 'Role Title'),
      company:         prop(p, 'Company'),
      dayRateEur:      prop(p, 'Day Rate EUR'),
      status:          prop(p, 'Status'),
      action:          prop(p, 'Action'),
      matchScore:      prop(p, 'Match Score'),
      contractLength:  prop(p, 'Contract Length'),
      remote:          prop(p, 'Remote'),
      postedDate:      prop(p, 'Posted Date'),
      estimatedStart:  prop(p, 'Estimated Start'),
      skillsRequired:  prop(p, 'Skills Required'),
      sourceUrl:       prop(p, 'Source URL'),
      notes:           prop(p, 'Notes'),
    }));
    cache.set(key, data);
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
        ...(d.insuranceReq  != null ? { 'Insurance Required CAD': { checkbox: Boolean(d.insuranceReq) } } : {}),
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

module.exports = router;
