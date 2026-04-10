/// <reference types="@cloudflare/workers-types" />

/**
 * Stakeholder routes
 * POST /invite, GET /, DELETE /:id, GET /dashboard
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { signJWT, generateToken, hashToken } from '../utils/crypto';
import { queryDb, getOneDb, execDb } from '../utils/db';
import { validate } from '../utils/validation';
import { NotFoundError, ForbiddenError } from '../utils/errors';
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
 * POST /invite
 * Generate invite link with expiring JWT
 */
router.post('/invite', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();

    const schema = z.object({
      email: z.string().email(),
      scope: z.array(z.string()).default(['read:finance']),
      expiryHours: z.number().positive().default(168), // 7 days
    });

    const data = validate(schema, body) as any;

    // Generate invite token
    const inviteToken = generateToken(32);
    const hashedToken = await hashToken(inviteToken);

    const inviteId = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiryDate = new Date(Date.now() + (data?.expiryHours || 168) * 3600 * 1000).toISOString();

    // Store invite in DB
    await execDb(
      c.env.DB,
      `
      INSERT INTO stakeholder_invites (id, user_id, email, hashed_token, scope, expires_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `,
      [inviteId, userId, data?.email || '', hashedToken, (data?.scope || []).join(','), expiryDate, now]
    );

    // Generate shareable JWT
    await signJWT(
      {
        type: 'stakeholder_invite',
        inviteId,
        userId,
        scope: data?.scope || [],
      },
      c.env.JWT_SECRET,
      data?.expiryHours || 168
    );

    return c.json(
      {
        inviteId,
        email: data?.email || '',
        inviteLink: `${c.env.WEB_BASE_URL || 'https://app.example.com'}/stakeholder/accept?token=${inviteToken}`,
        expiresAt: expiryDate,
        scope: data?.scope || [],
      },
      201
    );
  } catch (error) {
    throw error;
  }
});

/**
 * GET /
 * List stakeholders with access to this user's data
 */
router.get('/', async (c: HonoContext) => {
  try {
    const userId = c.get('userId') || '';

    const stakeholders = await queryDb<any>(
      c.env.DB,
      `
      SELECT id, email, scope, granted_at as grantedAt, is_active as isActive
      FROM stakeholders
      WHERE user_id = ?1
      ORDER BY granted_at DESC
      `,
      [userId]
    );

    return c.json(stakeholders);
  } catch (error) {
    throw error;
  }
});

/**
 * DELETE /:id
 * Revoke stakeholder access
 */
router.delete('/:id', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');
    const stakeholderId = c.req.param('id');

    // Verify ownership
    const stakeholder = await getOneDb(
      c.env.DB,
      'SELECT user_id FROM stakeholders WHERE id = ?1',
      [stakeholderId]
    );

    if (!stakeholder || (stakeholder as any).user_id !== userId) {
      throw new NotFoundError('Stakeholder');
    }

    // Revoke access
    await execDb(
      c.env.DB,
      'UPDATE stakeholders SET is_active = 0 WHERE id = ?1',
      [stakeholderId]
    );

    return c.json({ success: true });
  } catch (error) {
    throw error;
  }
});

/**
 * GET /dashboard
 * Read-only financial summary for stakeholders
 */
router.get('/dashboard', async (c: HonoContext) => {
  try {
    const userRole = c.get('userRole') as string;

    if (userRole !== 'stakeholder') {
      throw new ForbiddenError('Stakeholder access required');
    }

    // This endpoint is called with stakeholder JWT that contains userId
    // The userId in the token points to the owner, not the stakeholder
    const scope = (c.get('scope') as string[]) || [];

    // Check if stakeholder has read:finance scope
    const hasFinanceAccess = scope.includes('read:finance') || scope.includes('read:*');

    if (!hasFinanceAccess) {
      throw new ForbiddenError('No access to financial data');
    }

    // Return read-only summary similar to /finance/summary
    return c.json({
      message: 'Stakeholder dashboard available',
      scope,
      note: 'This is a read-only view',
    });
  } catch (error) {
    throw error;
  }
});

/**
 * POST /accept
 * Accept stakeholder invite
 */
router.post('/accept', async (c: HonoContext) => {
  try {
    const body = await c.req.json();
    const schema = z.object({
      inviteToken: z.string(),
      email: z.string().email(),
    });

    const data = validate(schema, body) as any;

    // Hash and lookup invite
    const hashedToken = await hashToken(data?.inviteToken || '');
    const invite = await getOneDb<any>(
      c.env.DB,
      `
      SELECT id, user_id, email, scope, expires_at
      FROM stakeholder_invites
      WHERE hashed_token = ?1
      `,
      [hashedToken]
    );

    if (!invite) {
      throw new NotFoundError('Invite');
    }

    // Verify email matches
    if (invite.email !== data?.email) {
      throw new ForbiddenError('Email does not match invite');
    }

    // Verify not expired
    if (new Date(invite.expires_at) < new Date()) {
      throw new ForbiddenError('Invite has expired');
    }

    // Create stakeholder record
    const stakeholderId = crypto.randomUUID();
    const now = new Date().toISOString();

    await execDb(
      c.env.DB,
      `
      INSERT INTO stakeholders (id, user_id, email, scope, is_active, granted_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `,
      [stakeholderId, invite.user_id, invite.email, invite.scope, true, now]
    );

    // Mark invite as used
    await execDb(
      c.env.DB,
      'DELETE FROM stakeholder_invites WHERE id = ?1',
      [invite.id]
    );

    return c.json({
      stakeholderId,
      email: invite.email,
      scope: invite.scope.split(','),
      message: 'Stakeholder access granted',
    });
  } catch (error) {
    throw error;
  }
});

export default router;
