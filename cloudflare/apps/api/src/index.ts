/// <reference types="@cloudflare/workers-types" />

/**
 * Nexus Financial Platform - API Entry Point
 * Main Hono app with route mounting and scheduled handlers
 */

import { Hono } from 'hono';
import type { D1Database, KVNamespace, R2Bucket, ScheduledEvent, ExecutionContext, MessageBatch } from '@cloudflare/workers-types';

// Middleware
import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { corsMiddleware } from './middleware/cors';

// Routes
import authRoutes from './routes/auth';
import financeRoutes from './routes/finance';
import marketRoutes from './routes/market';
import scenarioRoutes from './routes/scenarios';
import configRoutes from './routes/config';
import stakeholderRoutes from './routes/stakeholders';
import coworkRoutes from './routes/cowork';
import insightsRoutes from './routes/insights';
import commitmentRoutes from './routes/commitments';
import {
  createInvoiceRoutes,
  createExpenseRoutes,
  createContractRoutes,
  createLeadRoutes,
  createProjectRoutes,
  createWiseAccountRoutes,
  createHedgingRoutes,
} from './routes/crud';

// Cron handlers
import { triggerDaily } from './cron/recalc';
import { triggerFeedRefresh } from './cron/feed-refresh';

// Utils
import { ApiError } from './utils/errors';

/**
 * Environment type for Cloudflare Workers
 */
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  FILES: R2Bucket;
  AI: any;
  JWT_SECRET: string;
  JWT_EXPIRY_HOURS?: string;
  API_BASE_URL: string;
  WEB_BASE_URL: string;
  ALLOWED_ORIGINS?: string;
  NOTION_TOKEN?: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_ENV?: string;
  SMTP_CONNECTION_STRING?: string;
  SENTRY_DSN?: string;
}

/**
 * Create and configure Hono app
 */
function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Set basePath
  const api = app.basePath('/api/v1');

  // Global error handling
  api.onError((err, c) => {
    console.error('[ERROR]', err);

    if (err instanceof ApiError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details && { details: err.details }),
          },
        },
        err.statusCode as any
      );
    }

    return c.json(
      {
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An internal server error occurred',
        },
      },
      500
    );
  });

  // Apply global middleware
  api.use('*', corsMiddleware());
  api.use('*', rateLimitMiddleware());

  // Health check (public)
  api.get('/health', c => {
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    });
  });

  // Apply auth middleware to protected routes
  api.use('*', authMiddleware());

  // Mount route groups
  api.route('/auth', authRoutes);
  api.route('/finance', financeRoutes);
  api.route('/market', marketRoutes);
  api.route('/scenarios', scenarioRoutes);
  api.route('/config', configRoutes);
  api.route('/stakeholders', stakeholderRoutes);
  api.route('/cowork', coworkRoutes);
  api.route('/insights', insightsRoutes);
  api.route('/commitments', commitmentRoutes);

  // CRUD routes for resources
  api.route('/invoices', createInvoiceRoutes());
  api.route('/expenses', createExpenseRoutes());
  api.route('/contracts', createContractRoutes());
  api.route('/leads', createLeadRoutes());
  api.route('/projects', createProjectRoutes());
  api.route('/wise-accounts', createWiseAccountRoutes());
  api.route('/hedging', createHedgingRoutes());

  return app;
}

/**
 * Main Hono app instance
 */
const app = createApp();

/**
 * Fetch handler for HTTP requests
 */
export default {
  /**
   * Handle HTTP requests
   */
  fetch: app.fetch,

  /**
   * Handle scheduled cron triggers
   */
  scheduled: async (
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ) => {
    console.log(`[CRON] Triggered: ${event.cron}`);

    try {
      // Daily recalculation at 06:00 UTC (0 6 * * *)
      if (event.cron === '0 6 * * *') {
        ctx.waitUntil(triggerDaily(env as any));
      }

      // Feed refresh every 4 hours (0 */4 * * *)
      if (event.cron === '0 */4 * * *') {
        ctx.waitUntil(triggerFeedRefresh(env as any));
      }
    } catch (error) {
      console.error('[CRON] Error:', error);
    }
  },

  /**
   * Handle queued jobs (optional Durable Objects integration)
   */
  queue: async (batch: MessageBatch<any>, env: Env) => {
    console.log(`[QUEUE] Processing ${batch.messages.length} messages`);

    for (const message of batch.messages) {
      try {
        // Process based on message type
        if (message.body.type === 'recalc') {
          // Triggered recalculation
          await triggerDaily(env as any);
        } else if (message.body.type === 'feed-refresh') {
          // Triggered feed refresh
          await triggerFeedRefresh(env as any);
        }

        message.ack();
      } catch (error) {
        console.error('[QUEUE] Error processing message:', error);
        message.retry();
      }
    }
  },
};
