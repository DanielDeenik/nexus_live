/// <reference types="@cloudflare/workers-types" />

/**
 * Authentication routes
 * POST /register, /login, /magic, GET /magic/verify, /session, POST /logout
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  signJWT,
  hashToken,
  generateToken,
} from '../utils/crypto';
import { validate } from '../utils/validation';
import { getOneDb, execDb } from '../utils/db';
import { AuthError, ValidationError } from '../utils/errors';
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
  JWT_EXPIRY_HOURS?: string;
}

type HonoContext = Context<{ Bindings: Env; Variables: Variables }>;

const router = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /register
 * Register a new user with email and password
 */
router.post('/register', async (c: HonoContext) => {
  try {
    const body = await c.req.json();

    const registerSchema = z.object({
      email: z.string().email(),
      password: z
        .string()
        .min(8)
        .regex(/[A-Z]/)
        .regex(/[a-z]/)
        .regex(/[0-9]/),
      name: z.string().min(2),
      timezone: z.string().default('UTC'),
      currency: z.string().default('USD'),
    });

    const data = validate(registerSchema, body) as any;

    // Check if user exists
    const existing = await getOneDb<{ id: string }>(
      c.env.DB,
      'SELECT id FROM users WHERE email = ?1',
      [data?.email || '']
    );

    if (existing) {
      throw new ValidationError('Email already registered');
    }

    // Hash password with crypto API
    const encoder = new TextEncoder();
    const passwordData = encoder.encode(data.password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', passwordData);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const passwordHash = hashArray
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Create user
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();

    await execDb(
      c.env.DB,
      `
      INSERT INTO users (id, email, name, timezone, currency, password_hash, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      `,
      [userId, data?.email || '', data?.name || '', data?.timezone || 'UTC', data?.currency || 'USD', passwordHash, now, now]
    );

    // Create JWT session
    const sessionId = crypto.randomUUID();
    const jwtExpiry = parseInt(c.env.JWT_EXPIRY_HOURS || '24');
    const token = await signJWT(
      {
        userId,
        sessionId,
      },
      c.env.JWT_SECRET,
      jwtExpiry
    );

    // Store session in DB
    const expiryDate = new Date(Date.now() + jwtExpiry * 3600000).toISOString();
    await execDb(
      c.env.DB,
      `
      INSERT INTO sessions (id, user_id, token, expires_at, last_activity_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `,
      [sessionId, userId, token, expiryDate, now, now]
    );

    return c.json(
      {
        userId,
        email: data?.email || '',
        token,
      },
      201
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      return c.json({ error: error.message, details: error.details }, 400);
    }
    throw error;
  }
});

/**
 * POST /login
 * Login with email and password
 */
router.post('/login', async (c: HonoContext) => {
  try {
    const body = await c.req.json();

    const loginSchema = z.object({
      email: z.string().email(),
      password: z.string().min(1),
    });

    const data = validate(loginSchema, body) as any;

    // Find user
    const user = await getOneDb<{ id: string; password_hash: string }>(
      c.env.DB,
      'SELECT id, password_hash FROM users WHERE email = ?1',
      [data?.email || '']
    );

    if (!user) {
      throw new AuthError('Invalid email or password');
    }

    // Verify password
    const encoder = new TextEncoder();
    const passwordData = encoder.encode(data?.password || '');
    const hashBuffer = await crypto.subtle.digest('SHA-256', passwordData);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const passwordHash = hashArray
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (passwordHash !== user.password_hash) {
      throw new AuthError('Invalid email or password');
    }

    // Create JWT session
    const sessionId = crypto.randomUUID();
    const jwtExpiry = parseInt(c.env.JWT_EXPIRY_HOURS || '24');
    const token = await signJWT(
      {
        userId: user.id,
        sessionId,
      },
      c.env.JWT_SECRET,
      jwtExpiry
    );

    // Store session
    const now = new Date().toISOString();
    const expiryDate = new Date(Date.now() + jwtExpiry * 3600000).toISOString();
    await execDb(
      c.env.DB,
      `
      INSERT INTO sessions (id, user_id, token, expires_at, last_activity_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `,
      [sessionId, user.id, token, expiryDate, now, now]
    );

    // Update last login
    await execDb(
      c.env.DB,
      'UPDATE users SET last_login = ?1 WHERE id = ?2',
      [now, user.id]
    );

    return c.json({ token, userId: user.id });
  } catch (error) {
    if (error instanceof AuthError) {
      return c.json({ error: error.message }, 401);
    }
    throw error;
  }
});

/**
 * POST /magic
 * Generate a magic link for passwordless login
 */
router.post('/magic', async (c: HonoContext) => {
  try {
    const body = await c.req.json();

    const magicSchema = z.object({
      email: z.string().email(),
    });

    const data = validate(magicSchema, body) as any;

    // Find user (create if doesn't exist)
    let user = await getOneDb<{ id: string }>(
      c.env.DB,
      'SELECT id FROM users WHERE email = ?1',
      [data?.email || '']
    );

    if (!user) {
      // Create user with minimal data
      const userId = crypto.randomUUID();
      const now = new Date().toISOString();
      const userEmail = data?.email || '';
      await execDb(
        c.env.DB,
        `
        INSERT INTO users (id, email, name, timezone, currency, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        `,
        [userId, userEmail, userEmail.split('@')[0], 'UTC', 'USD', now, now]
      );
      user = { id: userId };
    }

    // Generate magic link token
    const magicToken = generateToken(32);
    const hashedToken = await hashToken(magicToken);

    // Store in KV with 15 minute expiry
    const magicKey = `magic:${hashedToken}`;
    await c.env.CACHE.put(magicKey, user.id, {
      expirationTtl: 900, // 15 minutes
    });

    return c.json(
      {
        email: data?.email || '',
        magicLink: `${(c.env as any).WEB_BASE_URL || 'https://app.example.com'}/auth/magic?token=${magicToken}`,
      },
      200
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

/**
 * GET /magic/verify
 * Verify magic link and create session
 */
router.get('/magic/verify', async (c: HonoContext) => {
  try {
    const magicToken = c.req.query('token');

    if (!magicToken) {
      throw new ValidationError('Magic token required');
    }

    // Hash and lookup
    const hashedToken = await hashToken(magicToken);
    const magicKey = `magic:${hashedToken}`;
    const userId = await c.env.CACHE.get(magicKey);

    if (!userId) {
      throw new AuthError('Invalid or expired magic link');
    }

    // Clean up
    await c.env.CACHE.delete(magicKey);

    // Create JWT session
    const sessionId = crypto.randomUUID();
    const jwtExpiry = parseInt(c.env.JWT_EXPIRY_HOURS || '24');
    const token = await signJWT(
      {
        userId,
        sessionId,
      },
      c.env.JWT_SECRET,
      jwtExpiry
    );

    // Store session
    const now = new Date().toISOString();
    const expiryDate = new Date(Date.now() + jwtExpiry * 3600000).toISOString();
    await execDb(
      c.env.DB,
      `
      INSERT INTO sessions (id, user_id, token, expires_at, last_activity_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `,
      [sessionId, userId, token, expiryDate, now, now]
    );

    return c.json({ token, userId });
  } catch (error) {
    if (error instanceof AuthError) {
      return c.json({ error: error.message }, 401);
    }
    if (error instanceof ValidationError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

/**
 * GET /session
 * Get current session info
 */
router.get('/session', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      throw new AuthError('No session');
    }

    const user = await getOneDb(
      c.env.DB,
      `
      SELECT id, email, name, timezone, currency, country, business_type as businessType, vat_number as vatNumber
      FROM users
      WHERE id = ?1
      `,
      [userId]
    );

    if (!user) {
      throw new AuthError('User not found');
    }

    return c.json(user);
  } catch (error) {
    if (error instanceof AuthError) {
      return c.json({ error: error.message }, 401);
    }
    throw error;
  }
});

/**
 * POST /logout
 * Logout and invalidate session
 */
router.post('/logout', async (c: HonoContext) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: true });
    }

    // Mark session as expired
    const now = new Date().toISOString();
    await execDb(
      c.env.DB,
      'UPDATE sessions SET expires_at = ?1 WHERE user_id = ?2',
      [now, userId]
    );

    return c.json({ success: true });
  } catch (error) {
    throw error;
  }
});

export default router;
