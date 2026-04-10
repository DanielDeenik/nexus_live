/// <reference types="@cloudflare/workers-types" />

/**
 * Financial dashboard routes
 * GET /summary, /burn-history, /forecast
 * POST /forecast/compute
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { computeForecast, computeDutchTax } from '@nexus-live/shared';
import { loadConfig } from '@nexus-live/shared';
import { queryDb, getOneDb } from '../utils/db';
import type { Context } from 'hono';
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type { Invoice } from '@nexus-live/shared';

interface Variables {
  userId: string;
  userRole: 'owner' | 'stakeholder' | 'api';
  scope?: string[];
}

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  JWT_SECRET: string;
}

type HonoContext = Context<{ Bindings: Env; Variables: Variables }>;

const router = new Hono<{ Bindings: Env; Variables: Variables }>();

interface FinancialSummary {
  cashPaid: number;
  cashPending: number;
  cashPendingHedged: number;
  monthlyBurn: number;
  taxReserve: number;
  runwayMonths: number;
  currency: string;
  asOf: string;
}

/**
 * Compute cash paid from invoices
 */
async function computeCashPaid(
  db: D1Database,
  userId: string
): Promise<{ amount: number; currency: string }> {
  const result = await getOneDb<{ total: number; currency: string }>(
    db,
    `
    SELECT COALESCE(SUM(paid_amount), 0) as total, currency
    FROM invoices
    WHERE user_id = ?1 AND status IN ('paid')
    GROUP BY currency
    LIMIT 1
    `,
    [userId]
  );

  return {
    amount: result?.total || 0,
    currency: result?.currency || 'USD',
  };
}

/**
 * Compute pending cash from outstanding invoices
 */
async function computeCashPending(
  db: D1Database,
  userId: string
): Promise<{ amount: number; hedged: number; currency: string }> {
  const invoices = await queryDb<Invoice>(
    db,
    `
    SELECT id, amount, currency, status
    FROM invoices
    WHERE user_id = ?1 AND status IN ('sent', 'viewed', 'overdue')
    `,
    [userId]
  );

  let total = 0;
  let hedged = 0;

  for (const inv of invoices) {
    total += inv.amount;

    // Check if hedged
    const hedge = await getOneDb<{ hedged_amount: number }>(
      db,
      'SELECT hedged_amount FROM hedging_contracts WHERE invoice_id = ?1',
      [inv.id]
    );

    if (hedge) {
      hedged += hedge.hedged_amount;
    }
  }

  return {
    amount: total,
    hedged,
    currency: invoices[0]?.currency || 'USD',
  };
}

/**
 * Compute monthly burn from expenses
 */
async function computeMonthlyBurn(
  db: D1Database,
  userId: string
): Promise<{ amount: number; currency: string }> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    .toISOString()
    .split('T')[0];

  const result = await getOneDb<{ total: number; currency: string }>(
    db,
    `
    SELECT COALESCE(SUM(amount), 0) as total, currency
    FROM expenses
    WHERE user_id = ?1 AND date >= ?2
    GROUP BY currency
    LIMIT 1
    `,
    [userId, thirtyDaysAgo]
  );

  return {
    amount: result?.total || 0,
    currency: result?.currency || 'USD',
  };
}

/**
 * Compute tax reserve from historical tax obligations
 */
async function computeTaxReserve(
  db: D1Database,
  userId: string,
  config: any
): Promise<{ amount: number; currency: string }> {
  // Get last 12 months of income
  const thirtyMonthsAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000)
    .toISOString()
    .split('T')[0];

  const invoices = await queryDb<Invoice>(
    db,
    `
    SELECT amount, currency
    FROM invoices
    WHERE user_id = ?1 AND status = 'paid' AND paid_date >= ?2
    `,
    [userId, thirtyMonthsAgo]
  );

  if (invoices.length === 0) {
    return { amount: 0, currency: 'USD' };
  }

  const totalIncome = invoices.reduce((sum, inv) => sum + inv.amount, 0);
  const currency = invoices[0].currency;

  // Compute Dutch tax on annual income
  const annualIncome = totalIncome;
  const taxResult = computeDutchTax(annualIncome, config.taxConfig);

  // Monthly reserve = annual tax / 12
  const monthlyReserve = (taxResult.totalTaxAndContributions || 0) / 12;

  return {
    amount: monthlyReserve,
    currency,
  };
}

/**
 * GET /finance/summary
 * Comprehensive financial summary with KPIs
 */
router.get('/summary', async (c: HonoContext) => {
  try {
    const userId = c.get('userId') as string;

    // Load config
    const config = await loadConfig(c.env.DB as any);

    // Get user details
    const user = await getOneDb<{ currency: string }>(
      c.env.DB,
      'SELECT currency FROM users WHERE id = ?1',
      [userId]
    );

    const currency = user?.currency || 'USD';

    // Compute KPIs
    const [cashPaid, cashPending, monthlyBurn, taxReserve] = await Promise.all([
      computeCashPaid(c.env.DB, userId),
      computeCashPending(c.env.DB, userId),
      computeMonthlyBurn(c.env.DB, userId),
      computeTaxReserve(c.env.DB, userId, config),
    ]);

    // Compute runway
    const monthlyBurnAmount = monthlyBurn.amount;
    const availableCash = cashPaid.amount + cashPending.amount - taxReserve.amount;
    const runwayMonths =
      monthlyBurnAmount > 0 ? availableCash / monthlyBurnAmount : 0;

    const summary: FinancialSummary = {
      cashPaid: cashPaid.amount,
      cashPending: cashPending.amount,
      cashPendingHedged: cashPending.hedged,
      monthlyBurn: monthlyBurnAmount,
      taxReserve: taxReserve.amount,
      runwayMonths: Math.max(0, runwayMonths),
      currency,
      asOf: new Date().toISOString(),
    };

    return c.json(summary);
  } catch (error) {
    throw error;
  }
});

/**
 * GET /finance/burn-history
 * Historical monthly burn data
 */
router.get('/burn-history', async (c: HonoContext) => {
  try {
    const userId = c.get('userId') as string;
    const months = z
      .string()
      .transform(Number)
      .pipe(z.number().int().positive().max(60))
      .default('12')
      .parse(c.req.query('months'));

    const cutoffDate = new Date(Date.now() - months * 30 * 24 * 3600 * 1000)
      .toISOString()
      .split('T')[0];

    const burnHistory = await queryDb<any>(
      c.env.DB,
      `
      SELECT
        date,
        daily_burn as dailyBurn,
        cumulative_burn as cumulativeBurn,
        runway,
        runway_days as runwayDays,
        notes
      FROM burn_history
      WHERE user_id = ?1 AND date >= ?2
      ORDER BY date ASC
      `,
      [userId, cutoffDate]
    );

    return c.json(burnHistory);
  } catch (error) {
    throw error;
  }
});

/**
 * GET /finance/forecast
 * Get cached forecast or compute fresh
 */
router.get('/forecast', async (c: HonoContext) => {
  try {
    const userId = c.get('userId') as string;

    // Try cache first
    const cacheKey = `forecast:${userId}`;
    const cached = await c.env.CACHE.get(cacheKey, 'json');
    if (cached) {
      return c.json(cached);
    }

    // Compute fresh forecast
    return await computeForecastInternal(c, userId);
  } catch (error) {
    throw error;
  }
});

/**
 * Compute forecast and cache
 */
async function computeForecastInternal(c: HonoContext, userId: string) {
  const config = await loadConfig(c.env.DB as any);

  // Get last 24 months of cashflow history
  const cutoffDate = new Date(Date.now() - 24 * 30 * 24 * 3600 * 1000)
    .toISOString()
    .split('T')[0];

  const history = await queryDb<any>(
    c.env.DB,
    `
    SELECT date, net_cashflow as value
    FROM cashflow_history
    WHERE user_id = ?1 AND date >= ?2
    ORDER BY date ASC
    `,
    [userId, cutoffDate]
  );

  if (history.length < 2) {
    return c.json({
      forecast: [],
      trend: 0,
      confidence: 0,
      message: 'Insufficient data for forecast',
    });
  }

  // Run forecast
  const forecast = computeForecast(history, config.forecastConfig);

  // Cache for 1 hour
  const cacheKey = `forecast:${userId}`;
  await c.env.CACHE.put(cacheKey, JSON.stringify(forecast), {
    expirationTtl: 3600,
  });

  return c.json(forecast);
}

/**
 * POST /forecast/compute
 * Trigger fresh forecast computation
 */
router.post('/forecast/compute', async (c: HonoContext) => {
  try {
    const userId = c.get('userId') as string;

    // Invalidate cache
    const cacheKey = `forecast:${userId}`;
    await c.env.CACHE.delete(cacheKey);

    // Compute fresh
    return await computeForecastInternal(c, userId);
  } catch (error) {
    throw error;
  }
});

export default router;
