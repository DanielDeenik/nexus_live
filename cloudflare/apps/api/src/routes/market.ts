/// <reference types="@cloudflare/workers-types" />

/**
 * Market intelligence routes
 * GET /signals, POST /signals/refresh, GET /trends
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { queryDb, getOneDb, getPaginationParams } from '../utils/db';
import { validate, paginationSchema } from '../utils/validation';
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
 * GET /signals
 * List market signals with tier filtering
 */
router.get('/signals', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');

    const tierFilter = z
      .enum(['HOT', 'WARM', 'MONITOR', 'COLD'])
      .optional()
      .parse(c.req.query('tier'));

    const paginationData = validate(paginationSchema, {
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
      page: c.req.query('page'),
    });

    const { limit, offset } = getPaginationParams(paginationData as any);

    let query = `
      SELECT *
      FROM market_signals
      WHERE user_id = ?1 AND (expires_at IS NULL OR expires_at > datetime('now'))
    `;
    const bindings: any[] = [userId];

    if (tierFilter) {
      query += ` AND tier = ?${bindings.length + 1}`;
      bindings.push(tierFilter);
    }

    query += ` ORDER BY score DESC, created_at DESC LIMIT ?${bindings.length + 1} OFFSET ?${bindings.length + 2}`;
    bindings.push(limit, offset);

    const signals = await queryDb(c.env.DB, query, bindings);

    const total = await getOneDb<{ count: number }>(
      c.env.DB,
      `
      SELECT COUNT(*) as count
      FROM market_signals
      WHERE user_id = ?1 AND (expires_at IS NULL OR expires_at > datetime('now'))
      ${tierFilter ? 'AND tier = ?' : ''}
      `,
      tierFilter ? [userId, tierFilter] : [userId]
    );

    return c.json({
      signals,
      pagination: {
        total: total?.count || 0,
        limit,
        offset,
      },
    });
  } catch (error) {
    throw error;
  }
});

/**
 * POST /signals/refresh
 * Trigger RSS feed refresh (queues job)
 */
router.post('/signals/refresh', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');

    // Queue refresh job in KV
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.CACHE.put(
      `refresh-job:${jobId}`,
      JSON.stringify({
        jobId,
        userId,
        status: 'queued',
        createdAt: now,
      }),
      { expirationTtl: 86400 }
    );

    return c.json({
      jobId,
      status: 'queued',
      message: 'Feed refresh job queued',
    });
  } catch (error) {
    throw error;
  }
});

/**
 * GET /trends
 * Seasonality and hiring trends
 */
router.get('/trends', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');

    const metric = z
      .enum(['revenue', 'expenses', 'burn', 'cashflow', 'hours'])
      .default('revenue')
      .parse(c.req.query('metric'));

    const period = z
      .enum(['weekly', 'monthly', 'quarterly'])
      .default('monthly')
      .parse(c.req.query('period'));

    const trends = await queryDb(
      c.env.DB,
      `
      SELECT
        id,
        metric,
        period,
        slope,
        intercept,
        r_squared as rSquared,
        direction,
        start_date as startDate,
        end_date as endDate,
        data_points as dataPoints,
        created_at
      FROM market_trends
      WHERE user_id = ?1 AND metric = ?2 AND period = ?3
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [userId, metric, period]
    );

    if (trends.length === 0) {
      return c.json({
        metric,
        period,
        message: 'No trend data available',
        trends: [],
      });
    }

    return c.json({
      metric,
      period,
      trends,
    });
  } catch (error) {
    throw error;
  }
});

/**
 * POST /signals/:id/acknowledge
 * Mark signal as acknowledged
 */
router.post('/signals/:id/acknowledge', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');
    const signalId = c.req.param('id');
    const now = new Date().toISOString();

    await c.env.DB.prepare(
      `
      UPDATE market_signals
      SET acknowledged = 1, acknowledged_at = ?1
      WHERE id = ?2 AND user_id = ?3
      `
    )
      .bind(now, signalId, userId)
      .run();

    const signal = await getOneDb(
      c.env.DB,
      `SELECT * FROM market_signals WHERE id = ?1 AND user_id = ?2`,
      [signalId, userId]
    );

    return c.json(signal);
  } catch (error) {
    throw error;
  }
});

export default router;
