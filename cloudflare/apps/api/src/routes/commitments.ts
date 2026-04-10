/// <reference types="@cloudflare/workers-types" />

/**
 * Commitments routes — decision staging gates pipeline
 *
 * GET    /                     list commitments
 * POST   /                     create commitment (starts in 'explore')
 * GET    /:id                  get one
 * GET    /:id/transitions      stage history
 * POST   /:id/evaluate         dry-run a gate evaluation
 * POST   /:id/advance          attempt to advance stage (gate-checked)
 * POST   /:id/abandon          abandon commitment
 * GET    /pacing/metrics       overall pacing metrics
 * GET    /pacing/forecast      weighted forecast overlay
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

import {
  listCommitments,
  getCommitment,
  createCommitment,
  abandonCommitment,
  evaluateCommitmentGate,
  advanceCommitment,
  listTransitions,
  getPacingMetrics,
  getWeightedForecast,
} from '../services/commitments';
import { NotFoundError, ValidationError } from '../utils/errors';

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

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const router = new Hono<{ Bindings: Env; Variables: Variables }>();

const stageSchema = z.enum(['explore', 'soft_commit', 'hard_commit', 'locked', 'abandoned']);

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  commitmentType: z.enum(['contract', 'expense', 'investment', 'project', 'hire', 'subscription']),
  amount: z.number().nonnegative(),
  currency: z.string().min(3).max(3),
  monthlyImpact: z.number().optional(),
  counterparty: z.string().max(200).optional(),
  relatedScenarioId: z.string().optional(),
});

const advanceSchema = z.object({
  targetStage: stageSchema,
  notes: z.string().max(2000).optional(),
});

const evaluateSchema = z.object({
  targetStage: stageSchema,
});

const abandonSchema = z.object({
  reason: z.string().max(2000).optional(),
});

router.get('/', async (c: Ctx) => {
  const userId = c.get('userId');
  const items = await listCommitments(c.env.DB, userId);
  return c.json({ items });
});

router.post('/', async (c: Ctx) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError('Invalid commitment payload', parsed.error.format());
  const created = await createCommitment(c.env.DB, userId, parsed.data);
  return c.json({ commitment: created }, 201);
});

router.get('/pacing/metrics', async (c: Ctx) => {
  const userId = c.get('userId');
  const cacheKey = `pacing:${userId}`;
  const cached = await c.env.CACHE.get(cacheKey, 'json');
  if (cached) return c.json({ metrics: cached, cached: true });
  const metrics = await getPacingMetrics(c.env.DB, userId);
  return c.json({ metrics, cached: false });
});

router.get('/pacing/forecast', async (c: Ctx) => {
  const userId = c.get('userId');
  const overlay = await getWeightedForecast(c.env.DB, userId);
  return c.json({ overlay });
});

router.get('/:id', async (c: Ctx) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const commitment = await getCommitment(c.env.DB, userId, id);
  if (!commitment) throw new NotFoundError('Commitment not found');
  return c.json({ commitment });
});

router.get('/:id/transitions', async (c: Ctx) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const commitment = await getCommitment(c.env.DB, userId, id);
  if (!commitment) throw new NotFoundError('Commitment not found');
  const transitions = await listTransitions(c.env.DB, id);
  return c.json({ transitions });
});

router.post('/:id/evaluate', async (c: Ctx) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = evaluateSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError('Invalid evaluate payload', parsed.error.format());
  const result = await evaluateCommitmentGate(c.env.DB, userId, id, parsed.data.targetStage);
  return c.json({ gate: result });
});

router.post('/:id/advance', async (c: Ctx) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = advanceSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError('Invalid advance payload', parsed.error.format());
  const out = await advanceCommitment(c.env.DB, userId, id, parsed.data.targetStage, parsed.data.notes);
  // Bust pacing cache so the next read recomputes
  await c.env.CACHE.delete(`pacing:${userId}`);
  return c.json(out);
});

router.post('/:id/abandon', async (c: Ctx) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = abandonSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError('Invalid abandon payload', parsed.error.format());
  await abandonCommitment(c.env.DB, userId, id, parsed.data.reason);
  await c.env.CACHE.delete(`pacing:${userId}`);
  return c.json({ ok: true });
});

export default router;
