/**
 * Authentication middleware
 * Supports JWT sessions, API tokens, and stakeholder JWTs
 */

import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { verifyJWT, hashToken } from '../utils/crypto';
import { getOneDb } from '../utils/db';
import { AuthError } from '../utils/errors';

export interface AuthContext {
  userId: string;
  userRole: 'owner' | 'stakeholder' | 'api';
  sessionId?: string;
  scope?: string[];
}

/**
 * Extract JWT from cookie or Authorization header
 */
function extractJWT(c: Context): string | null {
  // Check Authorization header (Bearer token)
  const authHeader = c.req.header('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check cookie
  const cookie = c.req.header('cookie');
  if (cookie) {
    const match = cookie.match(/session=([^;]+)/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Verify JWT session token
 */
async function verifySession(
  _c: Context,
  token: string,
  jwtSecret: string
): Promise<AuthContext | null> {
  try {
    const claims = await verifyJWT(token, jwtSecret);
    if (!claims || !claims.userId) {
      return null;
    }

    return {
      userId: claims.userId as string,
      userRole: 'owner',
      sessionId: claims.sessionId as string | undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Verify API token against database
 */
async function verifyApiToken(
  c: Context,
  token: string
): Promise<AuthContext | null> {
  try {
    const hashedToken = await hashToken(token);

    const apiToken = await getOneDb<{
      userId: string;
      scope: string;
      isActive: boolean;
      expiresAt: string;
    }>(
      c.env.DB,
      `
      SELECT user_id as userId, scope, is_active as isActive, expires_at as expiresAt
      FROM api_tokens
      WHERE hashed_token = ?1
      `,
      [hashedToken]
    );

    if (!apiToken || !apiToken.isActive) {
      return null;
    }

    // Check expiry
    if (new Date(apiToken.expiresAt) < new Date()) {
      return null;
    }

    // Update last used
    await c.env.DB.prepare(
      'UPDATE api_tokens SET last_used_at = ?1 WHERE hashed_token = ?2'
    )
      .bind(new Date().toISOString(), hashedToken)
      .run();

    return {
      userId: apiToken.userId,
      userRole: 'api',
      scope: apiToken.scope ? apiToken.scope.split(',') : [],
    };
  } catch {
    return null;
  }
}

/**
 * Verify stakeholder JWT
 */
async function verifyStakeholder(
  token: string,
  jwtSecret: string
): Promise<AuthContext | null> {
  try {
    const claims = await verifyJWT(token, jwtSecret);
    if (!claims || !claims.userId || claims.type !== 'stakeholder') {
      return null;
    }

    return {
      userId: claims.userId as string,
      userRole: 'stakeholder',
      scope: (claims.scope as string[]) || ['read:finance'],
    };
  } catch {
    return null;
  }
}

/**
 * Public routes that don't require authentication
 */
const publicRoutes = [
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/magic',
  '/api/v1/health',
];

/**
 * Auth middleware with three authentication modes
 */
export function authMiddleware() {
  return createMiddleware(async (c, next) => {
    const path = new URL(c.req.url).pathname;

    // Skip auth for public routes
    if (publicRoutes.some(route => path === route || path.startsWith(route))) {
      return next();
    }

    const jwtToken = extractJWT(c);
    const jwtSecret = c.env.JWT_SECRET as string;

    if (!jwtToken) {
      throw new AuthError('No authentication token provided');
    }

    let auth: AuthContext | null = null;

    // Try session JWT first
    auth = await verifySession(c, jwtToken, jwtSecret);

    // Try API token if JWT verification failed
    if (!auth) {
      auth = await verifyApiToken(c, jwtToken);
    }

    // Try stakeholder JWT if still no auth
    if (!auth) {
      auth = await verifyStakeholder(jwtToken, jwtSecret);
    }

    if (!auth) {
      throw new AuthError('Invalid or expired token');
    }

    // Set auth context
    c.set('userId', auth.userId);
    c.set('userRole', auth.userRole);
    c.set('scope', auth.scope || []);

    return next();
  });
}

/**
 * Require specific user role
 */
export function requireRole(role: 'owner' | 'stakeholder' | 'api' | 'any' = 'owner') {
  return createMiddleware(async (c, next) => {
    const userRole = c.get('userRole') as string;

    if (role !== 'any' && userRole !== role) {
      throw new AuthError(`Requires ${role} role`);
    }

    return next();
  });
}

/**
 * Require specific scope
 */
export function requireScope(...scopes: string[]) {
  return createMiddleware(async (c, next) => {
    const userScope = (c.get('scope') as string[]) || [];

    const hasScope = scopes.some(scope =>
      userScope.includes(scope) || userScope.includes('*')
    );

    if (!hasScope) {
      throw new AuthError(`Insufficient permissions for scope: ${scopes.join(', ')}`);
    }

    return next();
  });
}

/**
 * Optional auth - continues even if auth fails
 */
export function optionalAuth() {
  return createMiddleware(async (c, next) => {
    const jwtToken = extractJWT(c);
    const jwtSecret = c.env.JWT_SECRET as string;

    if (!jwtToken) {
      return next();
    }

    let auth: AuthContext | null = null;

    auth = await verifySession(c, jwtToken, jwtSecret);
    if (!auth) {
      auth = await verifyApiToken(c, jwtToken);
    }
    if (!auth) {
      auth = await verifyStakeholder(jwtToken, jwtSecret);
    }

    if (auth) {
      c.set('userId', auth.userId);
      c.set('userRole', auth.userRole);
      c.set('scope', auth.scope || []);
    }

    return next();
  });
}
