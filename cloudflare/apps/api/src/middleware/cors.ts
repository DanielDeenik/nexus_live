/**
 * CORS middleware
 * Reads allowed origins from environment configuration
 */

import { createMiddleware } from 'hono/factory';

/**
 * Parse allowed origins from env var
 */
function getAllowedOrigins(env: Record<string, unknown>): string[] {
  const originsEnv = (env.ALLOWED_ORIGINS as string) || 'http://localhost:3000';
  return originsEnv.split(',').map(o => o.trim());
}

/**
 * CORS middleware
 */
export function corsMiddleware() {
  return createMiddleware(async (c, next) => {
    const allowedOrigins = getAllowedOrigins(c.env);
    const origin = c.req.header('origin') || '';

    // Check if origin is allowed
    const isAllowed =
      allowedOrigins.includes('*') || allowedOrigins.includes(origin);

    // Set CORS headers
    if (isAllowed || allowedOrigins.includes('*')) {
      c.header('Access-Control-Allow-Origin', origin || '*');
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      c.header(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Accept'
      );
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Access-Control-Max-Age', '86400');
    }

    // Handle preflight
    if (c.req.method === 'OPTIONS') {
      return c.text('', 200);
    }

    return next();
  });
}
