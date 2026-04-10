/// <reference types="@cloudflare/workers-types" />

/**
 * Configuration and API token management routes
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { loadConfig, setConfigValue } from '@nexus-live/shared';
import { queryDb, execDb } from '../utils/db';
import { hashToken, generateToken } from '../utils/crypto';
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
  WEB_BASE_URL?: string;
}

type HonoContext = Context<{ Bindings: Env; Variables: Variables }>;

const router = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /config
 * List all app_config entries (admin only)
 */
router.get('/config', async (c: HonoContext) => {
  try {
    const userRole = c.get('userRole');

    if (userRole !== 'owner') {
      throw new ForbiddenError('Admin access required');
    }

    const config = await loadConfig(c.env.DB as any);

    return c.json(config);
  } catch (error) {
    throw error;
  }
});

/**
 * PUT /config/:key
 * Update config value (admin only)
 */
router.put('/config/:key', async (c: HonoContext) => {
  try {
    const userRole = c.get('userRole');

    if (userRole !== 'owner') {
      throw new ForbiddenError('Admin access required');
    }

    const key = c.req.param('key');
    const body = await c.req.json();
    const schema = z.object({
      value: z.union([z.string(), z.number(), z.boolean(), z.record(z.unknown())]),
      type: z.enum(['string', 'number', 'boolean', 'json']).optional(),
    });

    const data = validate(schema, body) as any;
    let valueStr: any;
    if (typeof data.value === 'string') {
      valueStr = data.value;
    } else {
      valueStr = JSON.stringify(data.value);
    }

    await (setConfigValue as any)(c.env.DB, key, valueStr);

    return c.json({
      key,
      value: data.value,
      updated: new Date().toISOString(),
    });
  } catch (error) {
    throw error;
  }
});

/**
 * GET /tokens
 * List API tokens (masked)
 */
router.get('/tokens', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');

    const tokens = await queryDb<any>(
      c.env.DB,
      `
      SELECT id, name, expires_at as expiresAt, last_used_at as lastUsedAt, scope, is_active as isActive, created_at
      FROM api_tokens
      WHERE user_id = ?1
      ORDER BY created_at DESC
      `,
      [userId]
    );

    // Mask tokens
    return c.json(
      tokens.map(t => ({
        ...t,
        token: `${t.token?.substring(0, 8)}...` || 'hidden',
      }))
    );
  } catch (error) {
    throw error;
  }
});

/**
 * POST /tokens
 * Create new API token (return plaintext once)
 */
router.post('/tokens', async (c: HonoContext) => {
  try {
    const userId = c.get('userId') as string;
    const body = await c.req.json();

    const schema = z.object({
      name: z.string().min(1),
      scope: z.array(z.string()).default(['read:*', 'write:*']),
      expiryDays: z.number().positive().default(90),
    });

    const data = validate(schema, body) as any;

    // Generate token
    const plainToken = generateToken(32);
    const hashedToken = await hashToken(plainToken);

    const tokenId = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiryDate = new Date(Date.now() + (data?.expiryDays || 90) * 24 * 3600 * 1000).toISOString();

    await execDb(
      c.env.DB,
      `
      INSERT INTO api_tokens (id, user_id, name, token, hashed_token, scope, expires_at, is_active, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      `,
      [
        tokenId,
        userId,
        (data?.name || ""),
        plainToken,
        hashedToken,
        ((data?.scope || []).join(',')),
        expiryDate,
        true,
        now,
      ]
    );

    return c.json(
      {
        id: tokenId,
        name: (data?.name || ""),
        token: plainToken,
        scope: (data?.scope || []),
        expiresAt: expiryDate,
        warning: 'Save this token securely. You will not be able to see it again.',
      },
      201
    );
  } catch (error) {
    throw error;
  }
});

/**
 * DELETE /tokens/:id
 * Revoke token
 */
router.delete('/tokens/:id', async (c: HonoContext) => {
  try {
    const userId = c.get('userId') as string;
    const tokenId = c.req.param('id');

    await execDb(
      c.env.DB,
      `
      UPDATE api_tokens
      SET is_active = 0
      WHERE id = ?1 AND user_id = ?2
      `,
      [tokenId, userId]
    );

    return c.json({ success: true });
  } catch (error) {
    throw error;
  }
});

export default router;
