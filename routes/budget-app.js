'use strict';
/**
 * routes/budget-app.js
 *
 * Bridge between Nexus Live and the local Nexus Budget app (FastAPI, port 8501).
 * Proxies data from the budget app and optionally syncs transactions into
 * the Notion Expenses DB.
 *
 * Configured via BUDGET_APP_URL in .env (default: http://localhost:8501)
 *
 * Endpoints:
 *   GET  /api/budget-app/health          → check if budget app is reachable
 *   GET  /api/budget-app/transactions    → paginated ML-classified transactions
 *   GET  /api/budget-app/summary         → monthly + category aggregations
 *   GET  /api/budget-app/budget          → ZZP budget model
 *   GET  /api/budget-app/forecast        → 3-month ML spending forecast
 *   POST /api/budget-app/sync            → import transactions → Notion Expenses DB
 */

const express   = require('express');
const fetch     = require('node-fetch');
const cache     = require('../lib/cache');

const router  = express.Router();
const BASE    = (process.env.BUDGET_APP_URL || 'http://localhost:8501').replace(/\/$/, '');
const TIMEOUT = 8000; // ms

// ── Helpers ───────────────────────────────────────────────────────────────────

async function budgetFetch(path, opts = {}) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const r = await fetch(`${BASE}${path}`, { signal: controller.signal, ...opts });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Budget app returned HTTP ${r.status} for ${path}`);
    return await r.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Budget app timed out — is it running on port 8501?');
    throw e;
  }
}

// Normalise a budget-app transaction into Nexus Live's expense shape.
// Real API schema: { Date, Amount, Name, Description, final_label,
//                   expense_category, ml_confidence, final_confidence,
//                   prob_EXPENSE, prob_INCOME, account_label, ... }
function normaliseTransaction(t) {
  const rawAmt    = t.Amount ?? t.amount ?? 0;
  const amount    = Math.abs(rawAmt);
  // Use ML label: EXPENSE means money out, INCOME means money in
  const finalLabel = t.final_label || t.expense_category || '';
  const isExpense  = finalLabel === 'EXPENSE' || rawAmt < 0;

  // Best description: Name (full bank desc) or Description field
  const description = (t.Name || t.Description || t.description || '').trim();

  // Best category: expense_category > ml_category > fallback
  const category = (isExpense
    ? (t.expense_category && t.expense_category !== 'EXPENSE' ? t.expense_category : null)
      || t.ml_category
      || 'Other'
    : 'Income');

  // Date: strip timestamp if present (ISO datetime → YYYY-MM-DD)
  const date = (t.Date || t.date || '').toString().slice(0, 10);

  return {
    id:           t.id || t.transaction_id || null,
    description,
    date,
    amount,
    isExpense,
    label:        finalLabel,
    category,
    confidence:   t.final_confidence ?? t.ml_confidence ?? null,
    probExpense:  t.prob_EXPENSE ?? null,
    account:      t.account_label || t.Account || null,
    currency:     'EUR',
    source:       'budget-app',
  };
}

// ── GET /api/budget-app/health ────────────────────────────────────────────────
router.get('/health', async (_req, res) => {
  try {
    const data = await budgetFetch('/health');
    res.json({
      reachable:   true,
      version:     data.version || data.app_version || '—',
      dataVersion: data.data_version || null,
      transactions: data.transactions_loaded ?? data.stats?.total_transactions ?? data.total_transactions ?? null,
      url:         BASE,
    });
  } catch (e) {
    res.json({ reachable: false, error: e.message, url: BASE });
  }
});

// ── GET /api/budget-app/transactions ─────────────────────────────────────────
// Query: ?page=1&per_page=200&category=<cat>&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
router.get('/transactions', async (req, res) => {
  const cacheKey = `budget_txns:${JSON.stringify(req.query)}`;
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const { page = 1, per_page = 200, category, start_date, end_date, label } = req.query;
  const params = new URLSearchParams({ page, per_page });
  if (category)   params.set('category',   category);
  if (start_date) params.set('start_date', start_date);
  if (end_date)   params.set('end_date',   end_date);
  if (label)      params.set('label',      label);

  try {
    const raw = await budgetFetch(`/api/v1/transactions?${params}`);
    const pg  = raw.pagination || {};
    const data = {
      total:        pg.total        || 0,
      page:         pg.page         || 1,
      per_page:     pg.per_page     || Number(per_page),
      pages:        pg.total_pages  || Math.ceil((pg.total || 0) / Number(per_page)),
      transactions: (raw.data       || []).map(normaliseTransaction),
    };
    cache.set(cacheKey, data, 30_000); // 30s
    res.json(data);
  } catch (e) {
    console.error('[budget-app/transactions]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /api/budget-app/summary ───────────────────────────────────────────────
router.get('/summary', async (_req, res) => {
  const cacheKey = 'budget_summary';
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await budgetFetch('/api/v1/transactions/summary');
    cache.set(cacheKey, data, 60_000); // 60s
    res.json(data);
  } catch (e) {
    console.error('[budget-app/summary]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /api/budget-app/budget ────────────────────────────────────────────────
router.get('/budget', async (_req, res) => {
  const cacheKey = 'budget_model';
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await budgetFetch('/api/v1/budget');
    cache.set(cacheKey, data, 120_000); // 2 min
    res.json(data);
  } catch (e) {
    console.error('[budget-app/budget]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /api/budget-app/forecast ──────────────────────────────────────────────
router.get('/forecast', async (_req, res) => {
  const cacheKey = 'budget_forecast';
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await budgetFetch('/api/v1/forecast');
    cache.set(cacheKey, data, 300_000); // 5 min
    res.json(data);
  } catch (e) {
    console.error('[budget-app/forecast]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── POST /api/budget-app/sync ─────────────────────────────────────────────────
// Pulls transactions from budget app and writes new ones to Notion Expenses DB.
// Body: { ws: 'primary', limit: 500, since: 'YYYY-MM-DD', dryRun: false }
//
// Returns: { imported: N, skipped: N, errors: N, items: [...] }
router.post('/sync', async (req, res) => {
  const { ws = 'primary', limit = 500, since, dryRun = false } = req.body || {};

  // Resolve workspace
  let workspace;
  try {
    const { load } = require('../lib/workspace');
    const workspaces = load();
    workspace = workspaces[ws];
    if (!workspace) return res.status(400).json({ error: `Workspace "${ws}" not found` });
  } catch (e) {
    return res.status(500).json({ error: 'Could not load workspace config: ' + e.message });
  }

  const expensesDbId = workspace.dbs?.expenses;
  if (!expensesDbId) {
    return res.status(503).json({ error: 'DB_EXPENSES not configured in workspace' });
  }

  try {
    // Fetch transactions from budget app
    const params = new URLSearchParams({ per_page: limit });
    if (since) params.set('start_date', since);
    const raw  = await budgetFetch(`/api/v1/transactions?${params}`);
    const txns = (raw.data || raw.transactions || []).map(normaliseTransaction);

    // Only import expense rows (negative amounts = money out)
    const expenses = txns.filter(t => t.isExpense && t.date && t.description);

    const results  = { imported: 0, skipped: 0, errors: 0, items: [] };

    if (dryRun) {
      results.dryRun  = true;
      results.preview = expenses.slice(0, 20);
      results.total   = expenses.length;
      return res.json(results);
    }

    // Write each expense to Notion in sequence (rate-limit friendly)
    const { pages } = require('../lib/notion');
    const client    = workspace.client;

    for (const exp of expenses) {
      try {
        const page = await client.pages.create({
          parent: { database_id: expensesDbId },
          properties: {
            'Description': { title:     [{ text: { content: exp.description.slice(0, 2000) } }] },
            'Amount':      { number:    exp.amount },
            'Date':        { date:      { start: exp.date } },
            'Category':    { select:    { name: exp.category } },
            'Currency':    { select:    { name: exp.currency } },
            'Notes':       { rich_text: [{ text: { content: `Imported from Nexus Budget. ML confidence: ${exp.confidence != null ? (exp.confidence * 100).toFixed(0) + '%' : 'n/a'}` } }] },
          },
        });
        results.imported++;
        results.items.push({ id: page.id, description: exp.description, amount: exp.amount, date: exp.date, category: exp.category });
      } catch (pageErr) {
        console.error('[budget-app/sync] page create error:', pageErr.message);
        results.errors++;
      }
    }

    // Bust the expenses cache so the dashboard refreshes
    const cacheLib = require('../lib/cache');
    cacheLib.del(`expenses:${ws}`);

    res.json(results);
  } catch (e) {
    console.error('[budget-app/sync]', e.message);
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
