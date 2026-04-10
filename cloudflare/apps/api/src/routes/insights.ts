/// <reference types="@cloudflare/workers-types" />

/**
 * Agent insights routes
 * POST /advice, GET /history, GET /agents, PUT /agents/:id
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { Orchestrator } from '../agents/orchestrator';
import { TaxAgent } from '../agents/tax-agent';
import { CashflowAgent } from '../agents/cashflow-agent';
import { MarketAgent } from '../agents/market-agent';
import { HedgeAgent } from '../agents/hedge-agent';
import { queryDb, getOneDb, execDb } from '../utils/db';
import { validate } from '../utils/validation';
import { ForbiddenError } from '../utils/errors';
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
  AI: any;
}

type HonoContext = Context<{ Bindings: Env; Variables: Variables }>;

const router = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /advice
 * Main endpoint - query through orchestrator
 */
router.post('/advice', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();

    const schema = z.object({
      query: z.string().min(10),
      context: z.record(z.unknown()).optional(),
    });

    const data = validate(schema, body) as any;

    // Get user data
    const user = await getOneDb<any>(
      c.env.DB,
      'SELECT * FROM users WHERE id = ?1',
      [userId]
    );

    // Run orchestrator
    const orchestrator = new Orchestrator(c.env as any);
    const orchestResult = await orchestrator.invoke({
      userId,
      query: data?.query || '',
      userState: user || {},
      data: data?.context || {},
    });

    // Run selected agents in parallel
    const agentInstances = [
      new TaxAgent(c.env as any),
      new CashflowAgent(c.env as any),
      new MarketAgent(c.env as any),
      new HedgeAgent(c.env as any),
    ];

    const agentResults = await Promise.allSettled(
      agentInstances.map(agent =>
        agent.invoke({
          userId,
          query: data?.query || '',
          userState: user || {},
          data: data?.context || {},
        })
      )
    );

    const insights = agentResults
      .filter(r => r.status === 'fulfilled')
      .map(r => (r as PromiseFulfilledResult<any>).value);

    // Store in knowledge graph / history
    const adviceId = crypto.randomUUID();
    const now = new Date().toISOString();

    await execDb(
      c.env.DB,
      `
      INSERT INTO agent_advice_history (id, user_id, query, orchestrator_result, agent_insights, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `,
      [
        adviceId,
        userId,
        data?.query || '',
        JSON.stringify(orchestResult),
        JSON.stringify(insights),
        now,
      ]
    );

    return c.json({
      adviceId,
      orchestration: orchestResult,
      insights,
      createdAt: now,
    });
  } catch (error) {
    throw error;
  }
});

/**
 * GET /history
 * Retrieve past insights from knowledge graph
 */
router.get('/history', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');
    const limit = z
      .string()
      .transform(Number)
      .pipe(z.number().int().positive().max(50))
      .default('20')
      .parse(c.req.query('limit'));

    const history = await queryDb<any>(
      c.env.DB,
      `
      SELECT id, query, orchestrator_result, agent_insights, created_at
      FROM agent_advice_history
      WHERE user_id = ?1
      ORDER BY created_at DESC
      LIMIT ?2
      `,
      [userId, limit]
    );

    // Parse JSON fields
    return c.json(
      history.map(h => ({
        ...h,
        orchestratorResult: h.orchestrator_result ? JSON.parse(h.orchestrator_result) : null,
        agentInsights: h.agent_insights ? JSON.parse(h.agent_insights) : null,
      }))
    );
  } catch (error) {
    throw error;
  }
});

/**
 * GET /agents
 * List agent configurations (admin only)
 */
router.get('/agents', async (c: HonoContext) => {
  try {
    const userRole = c.get('userRole');

    if (userRole !== 'owner') {
      throw new ForbiddenError('Admin access required');
    }

    const agents = await queryDb<any>(
      c.env.DB,
      `
      SELECT id, agent_id, enabled, priority, config, created_at, updated_at
      FROM agent_configs
      ORDER BY priority DESC
      `,
      []
    );

    return c.json(agents);
  } catch (error) {
    throw error;
  }
});

/**
 * PUT /agents/:id
 * Update agent configuration (admin only)
 */
router.put('/agents/:id', async (c: HonoContext) => {
  try {
    const userRole = c.get('userRole');

    if (userRole !== 'owner') {
      throw new ForbiddenError('Admin access required');
    }

    const agentId = c.req.param('id');
    const body = await c.req.json();

    const schema = z.object({
      enabled: z.boolean().optional(),
      priority: z.number().int().optional(),
      config: z.record(z.unknown()).optional(),
    });

    const data = validate(schema, body) as any;
    const now = new Date().toISOString();

    // Update agent config
    const updates: string[] = [];
    const values: any[] = [];

    if (data?.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(data.enabled ? 1 : 0);
    }

    if (data?.priority !== undefined) {
      updates.push('priority = ?');
      values.push(data.priority);
    }

    if (data?.config !== undefined) {
      updates.push('config = ?');
      values.push(JSON.stringify(data.config));
    }

    updates.push('updated_at = ?');
    values.push(now);
    values.push(agentId);

    if (updates.length > 1) {
      // Don't include updated_at in the count
      await execDb(
        c.env.DB,
        `UPDATE agent_configs SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }

    const updated = await getOneDb(
      c.env.DB,
      'SELECT * FROM agent_configs WHERE id = ?1',
      [agentId]
    );

    return c.json(updated);
  } catch (error) {
    throw error;
  }
});

export default router;
