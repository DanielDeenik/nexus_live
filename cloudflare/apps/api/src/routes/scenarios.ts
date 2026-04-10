/// <reference types="@cloudflare/workers-types" />

/**
 * Scenario routes
 * POST /:id/compute, GET /:id/projections, POST /compare
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { simulateScenario, loadConfig } from '@nexus-live/shared';
import { queryDb, getOneDb, execDb } from '../utils/db';
import { NotFoundError } from '../utils/errors';
import type { Context } from 'hono';
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type { Scenario, ScenarioProjection } from '@nexus-live/shared';

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
 * POST /:id/compute
 * Run scenario simulation
 */
router.post('/:id/compute', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');
    const scenarioId = c.req.param('id');

    // Get scenario
    const scenario = await getOneDb<Scenario>(
      c.env.DB,
      `
      SELECT id, user_id, name, description, type, revenue_change as revenueChange,
             rate_change as rateChange, hours_change as hoursChange,
             expense_increase as expenseIncrease, start_month as startMonth,
             duration, created_at, updated_at
      FROM scenarios
      WHERE id = ?1 AND user_id = ?2
      `,
      [scenarioId, userId]
    );

    if (!scenario) {
      throw new NotFoundError('Scenario');
    }

    // Get config
    const config = await loadConfig(c.env.DB as any);

    // Get historical data for baseline
    const thirtyMonthsAgo = new Date(Date.now() - 30 * 30 * 24 * 3600 * 1000)
      .toISOString()
      .split('T')[0];

    const history = await queryDb<any>(
      c.env.DB,
      `
      SELECT date, net_cashflow as netCashflow
      FROM cashflow_history
      WHERE user_id = ?1 AND date >= ?2
      ORDER BY date ASC
      `,
      [userId, thirtyMonthsAgo]
    );

    if (history.length < 3) {
      return c.json({
        error: 'Insufficient historical data for simulation',
      }, 400);
    }

    // Map scenario to simulation params
    const avgMonthlyRevenue = history.reduce((sum, h) => sum + (h.netCashflow || 0), 0) / Math.max(history.length, 1);
    const scenarioParams = {
      name: (scenario as any).name,
      description: (scenario as any).description,
      baseMonthlyRevenue: Math.max(avgMonthlyRevenue, 1),
      revenueChange: (scenario as any).revenueChange || 0,
      baseHourlyRate: 50,
      rateChange: (scenario as any).rateChange || 0,
      baseHoursPerMonth: 160,
      hoursChange: (scenario as any).hoursChange || 0,
      baseMonthlyExpenses: 1000,
      expenseIncrease: (scenario as any).expenseIncrease || 0,
      startMonth: (scenario as any).startMonth || 0,
      duration: (scenario as any).duration || 12,
    };

    // Run simulation
    const projections = simulateScenario(scenarioParams, config.taxConfig);

    // Store projections
    const now = new Date().toISOString();
    const projectionsJson = JSON.stringify(projections.projections);

    await execDb(
      c.env.DB,
      `
      UPDATE scenarios
      SET projections = ?1, updated_at = ?2
      WHERE id = ?3
      `,
      [projectionsJson, now, scenarioId]
    );

    return c.json({
      scenarioId,
      projections: projections.projections,
      summary: projections.summary,
      computedAt: now,
    });
  } catch (error) {
    throw error;
  }
});

/**
 * GET /:id/projections
 * Get computed projections for a scenario
 */
router.get('/:id/projections', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');
    const scenarioId = c.req.param('id');

    const scenario = await getOneDb<any>(
      c.env.DB,
      `
      SELECT id, name, type, projections, created_at, updated_at
      FROM scenarios
      WHERE id = ?1 AND user_id = ?2
      `,
      [scenarioId, userId]
    );

    if (!scenario) {
      throw new NotFoundError('Scenario');
    }

    let projections: ScenarioProjection[] = [];
    try {
      if (scenario.projections) {
        projections = JSON.parse(scenario.projections);
      }
    } catch {
      // Invalid JSON, return empty
    }

    return c.json({
      scenarioId,
      name: scenario.name,
      type: scenario.type,
      projections,
      computedAt: scenario.updated_at,
    });
  } catch (error) {
    throw error;
  }
});

/**
 * POST /compare
 * Compare up to 3 scenarios side by side
 */
router.post('/compare', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();

    const compareSchema = z.object({
      scenarioIds: z.array(z.string()).min(1).max(3),
    });

    const { scenarioIds } = compareSchema.parse(body);

    // Get all scenarios
    const scenarios = await queryDb<any>(
      c.env.DB,
      `
      SELECT id, name, type, projections, created_at
      FROM scenarios
      WHERE id IN (${scenarioIds.map(() => '?').join(',')})
      AND user_id = ?${scenarioIds.length + 1}
      `,
      [...scenarioIds, userId]
    );

    if (scenarios.length === 0) {
      throw new NotFoundError('Scenarios');
    }

    // Parse projections for each scenario
    const comparison = scenarios.map(scenario => {
      let projections: ScenarioProjection[] = [];
      try {
        if (scenario.projections) {
          projections = JSON.parse(scenario.projections);
        }
      } catch {
        // Invalid JSON
      }

      return {
        scenarioId: scenario.id,
        name: scenario.name,
        type: scenario.type,
        projections,
        summary: projections.length > 0 ? {
          totalRevenue: projections.reduce((sum, p) => sum + p.revenue, 0),
          totalTax: projections.reduce((sum, p) => sum + p.tax, 0),
          totalNetCashflow: projections.reduce((sum, p) => sum + p.netCashflow, 0),
        } : null,
      };
    });

    return c.json({
      scenarios: comparison,
      comparisonDate: new Date().toISOString(),
    });
  } catch (error) {
    throw error;
  }
});

/**
 * POST /
 * Create new scenario
 */
router.post('/', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();

    const createSchema = z.object({
      name: z.string(),
      description: z.string().optional(),
      type: z.enum(['revenue', 'expense', 'growth', 'contraction', 'custom']),
      revenueChange: z.number(),
      rateChange: z.number(),
      hoursChange: z.number(),
      expenseIncrease: z.number(),
      startMonth: z.string(),
      duration: z.number().positive(),
    });

    const data = createSchema.parse(body);
    const scenarioId = crypto.randomUUID();
    const now = new Date().toISOString();

    await execDb(
      c.env.DB,
      `
      INSERT INTO scenarios (id, user_id, name, description, type, revenue_change,
                             rate_change, hours_change, expense_increase, start_month,
                             duration, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      `,
      [
        scenarioId,
        userId,
        data.name,
        data.description || null,
        data.type,
        data.revenueChange,
        data.rateChange,
        data.hoursChange,
        data.expenseIncrease,
        data.startMonth,
        data.duration,
        now,
        now,
      ]
    );

    return c.json({
      id: scenarioId,
      ...data,
      createdAt: now,
    }, 201);
  } catch (error) {
    throw error;
  }
});

/**
 * GET /
 * List scenarios
 */
router.get('/', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');

    const scenarios = await queryDb<any>(
      c.env.DB,
      `
      SELECT id, name, description, type, revenue_change as revenueChange,
             rate_change as rateChange, hours_change as hoursChange,
             expense_increase as expenseIncrease, start_month as startMonth,
             duration, created_at, updated_at
      FROM scenarios
      WHERE user_id = ?1
      ORDER BY created_at DESC
      `,
      [userId]
    );

    return c.json(scenarios);
  } catch (error) {
    throw error;
  }
});

export default router;
