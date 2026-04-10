/// <reference types="@cloudflare/workers-types" />

/**
 * Cowork integration routes
 * POST /recalc, /push, GET /status
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../utils/validation';
import { execDb, getOneDb } from '../utils/db';
import type { Context } from 'hono';
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

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

/**
 * POST /recalc
 * Trigger full recalculation pipeline
 */
router.post('/recalc', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();

    const schema = z.object({
      types: z.array(z.enum(['forecast', 'tax', 'cashflow', 'signals', 'all'])).optional(),
    });

    const data = validate(schema, body) as any;
    const types = (data?.types || ["all"]) || ['all'];

    // Create recalc log entry
    const logId = crypto.randomUUID();
    const now = new Date().toISOString();

    await execDb(
      c.env.DB,
      `
      INSERT INTO recalc_log (id, user_id, type, status, started_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      `,
      [logId, userId, types[0] || 'all', 'pending', now]
    );

    // Queue recalc job
    await c.env.CACHE.put(
      `recalc-job:${logId}`,
      JSON.stringify({
        logId,
        userId,
        types,
        status: 'queued',
        queuedAt: now,
      }),
      { expirationTtl: 86400 }
    );

    return c.json({
      logId,
      types,
      status: 'queued',
      message: 'Full recalculation job queued',
    });
  } catch (error) {
    throw error;
  }
});

/**
 * POST /push
 * Accept data push from Cowork integration
 */
router.post('/push', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();

    const schema = z.object({
      dataType: z.enum(['invoices', 'expenses', 'contracts', 'cashflow']),
      records: z.array(z.record(z.unknown())).min(1),
      timestamp: z.string().datetime().optional(),
    });

    const data = validate(schema, body) as any;
    const now = new Date().toISOString();
    const processedAt = data.timestamp || now;

    // Process based on data type
    let processed = 0;

    if (data.dataType === 'invoices') {
      // Upsert invoices
      for (const record of data.records) {
        const inv = record as any;
        await c.env.DB.prepare(
          `
          INSERT INTO invoices (id, user_id, invoice_number, client_name, issue_date, due_date,
                                amount, currency, tax, status, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
          ON CONFLICT(id) DO UPDATE SET
            amount=?7, status=?10, updated_at=?12
          `
        )
          .bind(
            inv.id || crypto.randomUUID(),
            userId,
            inv.invoiceNumber,
            inv.clientName,
            inv.issueDate,
            inv.dueDate,
            inv.amount,
            inv.currency,
            inv.tax || 0,
            inv.status || 'sent',
            processedAt,
            now
          )
          .run();
        processed++;
      }
    } else if (data.dataType === 'expenses') {
      // Upsert expenses
      for (const record of data.records) {
        const exp = record as any;
        await c.env.DB.prepare(
          `
          INSERT INTO expenses (id, user_id, date, category, description, amount,
                                currency, payment_method, tax, taxable, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
          ON CONFLICT(id) DO UPDATE SET
            amount=?6, category=?4, updated_at=?12
          `
        )
          .bind(
            exp.id || crypto.randomUUID(),
            userId,
            exp.date,
            exp.category,
            exp.description,
            exp.amount,
            exp.currency,
            exp.paymentMethod || 'other',
            exp.tax || 0,
            exp.taxable !== false ? 1 : 0,
            processedAt,
            now
          )
          .run();
        processed++;
      }
    }

    // Log push event
    await execDb(
      c.env.DB,
      `
      INSERT INTO recalc_log (id, user_id, type, status, started_at, completed_at, affected_records)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `,
      [crypto.randomUUID(), userId, data.dataType, 'completed', processedAt, now, processed]
    );

    return c.json({
      dataType: data.dataType,
      recordsProcessed: processed,
      processedAt: now,
      message: `${processed} ${data.dataType} records processed`,
    });
  } catch (error) {
    throw error;
  }
});

/**
 * GET /status
 * System health and last recalc status
 */
router.get('/status', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');

    // Get last recalc log
    const lastRecalc = await getOneDb<any>(
      c.env.DB,
      `
      SELECT id, type, status, started_at as startedAt, completed_at as completedAt,
             duration, affected_records as affectedRecords
      FROM recalc_log
      WHERE user_id = ?1
      ORDER BY started_at DESC
      LIMIT 1
      `,
      [userId]
    );

    // Get pending jobs
    const allKeys = await c.env.CACHE.list({ prefix: `recalc-job:` });

    return c.json({
      status: 'healthy',
      userId,
      lastRecalc: lastRecalc || null,
      pendingJobs: allKeys.keys.length,
      systemTime: new Date().toISOString(),
    });
  } catch (error) {
    throw error;
  }
});

export default router;
