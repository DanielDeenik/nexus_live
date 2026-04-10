/// <reference types="@cloudflare/workers-types" />

/**
 * Rate limiting middleware using KV
 */

import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { RateLimitError } from '../utils/errors';
import { getConfigValue } from '@nexus-live/shared';

interface RateLimitConfig {
  window: number; // seconds
  limit: number; // requests per window
}

/**
 * Get rate limit config from database
 */
async function getRateLimitConfig(
  c: Context
): Promise<Record<string, RateLimitConfig>> {
  try {
    const configJson = await getConfigValue(c.env.DB, 'ratelimit_config');
    if (configJson) {
      return JSON.parse(configJson);
    }
  } catch {
    // Fall through to defaults
  }

  // Default rate limits
  return {
    auth: { window: 3600, limit: 10 }, // 10 per hour for auth endpoints
    api: { window: 60, limit: 100 }, // 100 per minute for API
    forecast: { window: 3600, limit: 5 }, // 5 per hour for expensive operations
  };
}

/**
 * Get identifier for rate limiting (IP or user ID)
 */
function getIdentifier(c: Context): string {
  const userId = c.get('userId');
  if (userId) {
    return `user:${userId}`;
  }

  // Fall back to IP address
  const ip = c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for') ||
    'unknown';
  return `ip:${ip}`;
}

/**
 * Determine rate limit tier based on endpoint
 */
function getRateLimitTier(path: string): string {
  if (path.includes('/auth/')) {
    return 'auth';
  }
  if (path.includes('/forecast') || path.includes('/compute')) {
    return 'forecast';
  }
  return 'api';
}

/**
 * Check rate limit in KV
 */
async function checkRateLimit(
  kv: KVNamespace,
  identifier: string,
  tier: string,
  config: RateLimitConfig
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / config.window);
  const key = `ratelimit:${identifier}:${tier}:${window}`;

  const current = await kv.get<number>(key, 'json');
  const count = (current || 0) + 1;

  if (count > config.limit) {
    return false;
  }

  // Set with expiry
  await kv.put(key, JSON.stringify(count), {
    expirationTtl: config.window + 10,
  });

  return true;
}

/**
 * Rate limiting middleware
 */
export function rateLimitMiddleware() {
  return createMiddleware(async (c, next) => {
    const path = new URL(c.req.url).pathname;

    // Skip rate limiting for health checks
    if (path === '/api/v1/health') {
      return next();
    }

    const kv = c.env.CACHE as KVNamespace;
    const identifier = getIdentifier(c);
    const tier = getRateLimitTier(path);
    const config = await getRateLimitConfig(c);
    const tierConfig = config[tier] || { window: 60, limit: 100 };

    const allowed = await checkRateLimit(kv, identifier, tier, tierConfig);

    if (!allowed) {
      throw new RateLimitError(
        `Rate limit exceeded: ${tierConfig.limit} requests per ${tierConfig.window}s`
      );
    }

    return next();
  });
}

/**
 * Get rate limit status
 */
export async function getRateLimitStatus(c: Context): Promise<{
  limit: number;
  remaining: number;
  reset: number;
}> {
  const path = new URL(c.req.url).pathname;
  const identifier = getIdentifier(c);
  const tier = getRateLimitTier(path);

  const config = await getRateLimitConfig(c);
  const tierConfig = config[tier] || { window: 60, limit: 100 };

  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / tierConfig.window);
  const key = `ratelimit:${identifier}:${tier}:${window}`;

  const kv = c.env.CACHE as KVNamespace;
  const current = await kv.get<number>(key, 'json');
  const count = current || 0;

  return {
    limit: tierConfig.limit,
    remaining: Math.max(0, tierConfig.limit - count),
    reset: (window + 1) * tierConfig.window,
  };
}
