/// <reference types="@cloudflare/workers-types" />

/**
 * Daily recalculation handler
 * Pipeline: sync data → recompute → cache → run agent swarm
 * Now real: integration clients + orchestrator route + commitment recompute.
 */

import { loadConfig, computeForecast } from '@nexus-live/shared';
import { queryDb, execDb } from '../utils/db';
import { Orchestrator } from '../agents/orchestrator';
import { buildIntegrations, type IntegrationsBag, type IntegrationEnv } from '../integrations';
import { recomputePacingMetrics } from '../services/commitments';

interface RecalcEnv extends IntegrationEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  JWT_SECRET: string;
}

/**
 * Main daily recalculation handler.
 */
export async function triggerDaily(env: RecalcEnv): Promise<void> {
  const startTime = Date.now();
  console.log('[RECALC] Daily recalculation starting');

  try {
    const config = await loadConfig(env.DB as any);
    const integrations = await buildIntegrations(env.DB, env.CACHE, env);

    const userLimit = Number(config['recalc.user_batch_size'] ?? 100);
    const users = await queryDb<{ id: string }>(
      env.DB,
      `SELECT id FROM users WHERE last_login IS NOT NULL ORDER BY last_login DESC LIMIT ?1`,
      [userLimit]
    );

    console.log(`[RECALC] Processing ${users.length} active users`);

    for (const user of users) {
      await processUserRecalc(user.id, config, integrations, env);
    }

    const duration = Date.now() - startTime;
    console.log(`[RECALC] Daily recalculation completed in ${duration}ms`);
  } catch (error) {
    console.error('[RECALC] Error:', error);
    throw error;
  }
}

/**
 * Process recalc for a single user.
 */
async function processUserRecalc(
  userId: string,
  config: Record<string, unknown>,
  integrations: IntegrationsBag,
  env: RecalcEnv
): Promise<void> {
  const startTime = Date.now();
  const logId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await execDb(
      env.DB,
      `INSERT INTO recalc_log (id, user_id, trigger, status, started_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
      [logId, userId, 'cron-daily', 'running', now]
    );

    const steps: Record<string, unknown> = {};

    steps.notion = await syncNotionData(userId, integrations, env);
    steps.plaid = await syncPlaidData(userId, integrations, env);
    steps.moneybird = await syncMoneybirdData(userId, integrations, env);
    steps.fx = await refreshFxRates(integrations);
    steps.forecast = await recomputeForecasts(userId, config, env);
    steps.commitments = await recomputePacingMetrics(env.DB, env.CACHE, userId);
    steps.kv = await updateKVCache(userId, env);
    steps.agents = await runAgentSwarm(userId, env);

    const duration = Date.now() - startTime;
    await execDb(
      env.DB,
      `UPDATE recalc_log
         SET status = ?1, completed_at = ?2, steps_json = ?3
         WHERE id = ?4`,
      ['completed', new Date().toISOString(), JSON.stringify({ ...steps, duration_ms: duration }), logId]
    );
    console.log(`[RECALC] User ${userId} completed in ${duration}ms`);
  } catch (error) {
    console.error(`[RECALC] Error processing user ${userId}:`, error);
    await execDb(
      env.DB,
      `UPDATE recalc_log
         SET status = ?1, completed_at = ?2, error_message = ?3
         WHERE id = ?4`,
      ['error', new Date().toISOString(), String(error), logId]
    );
  }
}

/**
 * Sync data from Notion (uses per-user data_source config).
 */
async function syncNotionData(userId: string, integrations: IntegrationsBag, env: RecalcEnv) {
  if (!integrations.notion) return { skipped: 'no notion token' };

  const sources = await queryDb<{ id: string; config_json: string }>(
    env.DB,
    `SELECT id, config_json FROM data_sources WHERE user_id = ?1 AND type = 'notion'`,
    [userId]
  );
  if (sources.length === 0) return { skipped: 'no notion data_source' };

  let totalRows = 0;
  for (const src of sources) {
    try {
      const cfg = JSON.parse(src.config_json) as { database_id?: string };
      if (!cfg.database_id) continue;
      const rows = await integrations.notion.queryDatabase(cfg.database_id);
      totalRows += rows.length;
      await execDb(
        env.DB,
        `UPDATE data_sources SET last_sync_at = ?1, sync_status = ?2, error_message = NULL WHERE id = ?3`,
        [new Date().toISOString(), 'idle', src.id]
      );
    } catch (e) {
      await execDb(
        env.DB,
        `UPDATE data_sources SET sync_status = ?1, error_message = ?2 WHERE id = ?3`,
        ['error', String(e), src.id]
      );
    }
  }
  return { rowsFetched: totalRows };
}

/**
 * Sync data from Plaid (transactions land in expenses + cashflow_history).
 */
async function syncPlaidData(userId: string, integrations: IntegrationsBag, env: RecalcEnv) {
  if (!integrations.plaid) return { skipped: 'no plaid credentials' };

  const sources = await queryDb<{ id: string; config_json: string }>(
    env.DB,
    `SELECT id, config_json FROM data_sources WHERE user_id = ?1 AND type = 'plaid'`,
    [userId]
  );
  if (sources.length === 0) return { skipped: 'no plaid data_source' };

  const cfgRows = await loadConfig(env.DB as any);
  const lookbackDays = Number(cfgRows['integrations.plaid.lookback_days'] ?? 30);
  const today = new Date();
  const start = new Date(today.getTime() - lookbackDays * 86400 * 1000);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = today.toISOString().slice(0, 10);

  let totalTx = 0;
  for (const src of sources) {
    try {
      const cfg = JSON.parse(src.config_json) as { access_token?: string };
      if (!cfg.access_token) continue;
      const txs = await integrations.plaid.getTransactions(cfg.access_token, startStr, endStr);
      totalTx += txs.length;
      // Persist each transaction as an expense row (idempotent on plaid_transaction_id)
      for (const tx of txs) {
        if (tx.pending) continue;
        await execDb(
          env.DB,
          `INSERT OR IGNORE INTO expenses (id, user_id, amount, currency, category, description, date, source, plaid_transaction_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'plaid', ?8, ?9)`,
          [
            crypto.randomUUID(),
            userId,
            tx.amount,
            tx.iso_currency_code || 'EUR',
            (tx.category && tx.category[0]) || 'uncategorized',
            tx.name,
            tx.date,
            tx.transaction_id,
            new Date().toISOString(),
          ]
        );
      }
      await execDb(
        env.DB,
        `UPDATE data_sources SET last_sync_at = ?1, sync_status = 'idle', error_message = NULL WHERE id = ?2`,
        [new Date().toISOString(), src.id]
      );
    } catch (e) {
      await execDb(
        env.DB,
        `UPDATE data_sources SET sync_status = 'error', error_message = ?1 WHERE id = ?2`,
        [String(e), src.id]
      );
    }
  }
  return { transactionsImported: totalTx };
}

/**
 * Sync sales invoices from Moneybird → invoices table.
 */
async function syncMoneybirdData(userId: string, integrations: IntegrationsBag, env: RecalcEnv) {
  if (!integrations.moneybird) return { skipped: 'no moneybird credentials' };

  const sources = await queryDb<{ id: string }>(
    env.DB,
    `SELECT id FROM data_sources WHERE user_id = ?1 AND type = 'moneybird'`,
    [userId]
  );
  if (sources.length === 0) return { skipped: 'no moneybird data_source' };

  let imported = 0;
  try {
    const invoices = (await integrations.moneybird.listSalesInvoices()) as Array<Record<string, any>>;
    for (const inv of invoices) {
      // Map Moneybird state → schema enum (pending|paid|overdue)
      const rawState = String(inv.state || 'pending').toLowerCase();
      const status = rawState === 'paid' ? 'paid' : (rawState === 'late' || rawState === 'overdue') ? 'overdue' : 'pending';
      await execDb(
        env.DB,
        `INSERT OR IGNORE INTO invoices (id, user_id, client, amount, currency, status, issued_date, due_date, source, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'moneybird', ?9)`,
        [
          crypto.randomUUID(),
          userId,
          String(inv.contact?.company_name || inv.contact?.firstname || 'Unknown'),
          Number(inv.total_price_incl_tax || inv.total_price_excl_tax || 0),
          inv.currency || 'EUR',
          status,
          inv.invoice_date || new Date().toISOString().slice(0, 10),
          inv.due_date || new Date().toISOString().slice(0, 10),
          new Date().toISOString(),
        ]
      );
      imported++;
    }
    for (const src of sources) {
      await execDb(
        env.DB,
        `UPDATE data_sources SET last_sync_at = ?1, sync_status = 'idle', error_message = NULL WHERE id = ?2`,
        [new Date().toISOString(), src.id]
      );
    }
  } catch (e) {
    for (const src of sources) {
      await execDb(
        env.DB,
        `UPDATE data_sources SET sync_status = 'error', error_message = ?1 WHERE id = ?2`,
        [String(e), src.id]
      );
    }
  }
  return { invoicesImported: imported };
}

async function refreshFxRates(integrations: IntegrationsBag) {
  try {
    const rates = await integrations.fx.getLatest();
    return { base: rates.base, count: Object.keys(rates.rates).length };
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * Recompute forecast and store in KV.
 */
async function recomputeForecasts(userId: string, config: Record<string, unknown>, env: RecalcEnv) {
  const months = Number(config['forecast.history_months'] ?? 24);
  // cashflow_history stores monthly buckets keyed by `month` (YYYY-MM)
  const cutoffMonth = (() => {
    const d = new Date(Date.now() - months * 30 * 24 * 3600 * 1000);
    return d.toISOString().slice(0, 7);
  })();

  const history = await queryDb<{ date: string; value: number }>(
    env.DB,
    `SELECT month as date, COALESCE(profit, COALESCE(revenue,0) - COALESCE(costs,0)) as value
       FROM cashflow_history
       WHERE user_id = ?1 AND month >= ?2
       ORDER BY month ASC`,
    [userId, cutoffMonth]
  );

  if (history.length < 2) return { skipped: 'insufficient history' };

  const forecast = computeForecast(history as any, config as any);
  const ttl = Number(config['cache.forecast_ttl_seconds'] ?? 3600);
  await env.CACHE.put(`forecast:${userId}`, JSON.stringify(forecast), { expirationTtl: ttl });
  return { points: forecast?.predictions?.length ?? 0 };
}

/**
 * Cache user summary in KV.
 */
async function updateKVCache(userId: string, env: RecalcEnv) {
  const invoices = await queryDb<{ amount: number; status: string; currency: string }>(
    env.DB,
    `SELECT amount, status, currency FROM invoices WHERE user_id = ?1`,
    [userId]
  );

  const cashPaid = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + i.amount, 0);
  const cashPending = invoices
    .filter(i => ['pending', 'overdue'].includes(i.status))
    .reduce((s, i) => s + i.amount, 0);

  const cfgRows = await loadConfig(env.DB as any);
  const ttl = Number(cfgRows['cache.summary_ttl_seconds'] ?? 3600);

  await env.CACHE.put(
    `summary:${userId}`,
    JSON.stringify({ cashPaid, cashPending, computedAt: new Date().toISOString() }),
    { expirationTtl: ttl }
  );
  return { cashPaid, cashPending };
}

/**
 * Run agent swarm via the orchestrator.
 */
async function runAgentSwarm(userId: string, env: RecalcEnv) {
  try {
    const orchestrator = new Orchestrator(env as any);
    const { specialists } = await orchestrator.route({
      userId,
      query: 'Daily automatic analysis: review cashflow, taxes, FX, market signals, and commitment pacing.',
      userState: {},
      data: {},
    });
    return { invoked: specialists.length, success: specialists.filter(s => s.status === 'success').length };
  } catch (e) {
    return { error: String(e) };
  }
}
