/// <reference types="@cloudflare/workers-types" />

/**
 * Generic CRUD factory
 * Creates full CRUD routes for any resource type
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { queryDb, getOneDb, execDb, countDb, getPaginationParams } from '../utils/db';
import { validate, paginationSchema } from '../utils/validation';
import { NotFoundError } from '../utils/errors';
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
}

type HonoContext = Context<{ Bindings: Env; Variables: Variables }>;

export interface CrudOptions {
  tableName: string;
  idField?: string;
  schema?: z.ZodSchema;
  allowedFields?: string[];
  ownershipCheck?: (row: any) => boolean;
}

/**
 * Create CRUD routes for a resource
 */
export function createCrudRoutes(options: CrudOptions): Hono<{ Bindings: Env; Variables: Variables }> {
  const router = new Hono<{ Bindings: Env; Variables: Variables }>();
  const { tableName, idField = 'id', schema, allowedFields = [] } = options;

  /**
   * GET / - List with pagination and filters
   */
  router.get('/', async (c: HonoContext) => {
    try {
      const userId = c.get('userId');
      const paginationData = validate(paginationSchema, {
        limit: c.req.query('limit'),
        offset: c.req.query('offset'),
        page: c.req.query('page'),
      });

      const { limit, offset } = getPaginationParams(paginationData as any);

      const [items, total] = await Promise.all([
        queryDb(
          c.env.DB,
          `SELECT * FROM ${tableName} WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`,
          [userId, limit, offset]
        ),
        countDb(c.env.DB, tableName, 'user_id = ?1', [userId]),
      ]);

      return c.json({
        items,
        pagination: {
          total,
          limit,
          offset,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      throw error;
    }
  });

  /**
   * GET /:id - Get single item
   */
  router.get('/:id', async (c: HonoContext) => {
    try {
      const userId = c.get('userId');
      const id = c.req.param('id');

      const item = await getOneDb(
        c.env.DB,
        `SELECT * FROM ${tableName} WHERE ${idField} = ?1 AND user_id = ?2`,
        [id, userId]
      );

      if (!item) {
        throw new NotFoundError(tableName.slice(0, -1)); // Singularize
      }

      return c.json(item);
    } catch (error) {
      throw error;
    }
  });

  /**
   * POST / - Create item
   */
  router.post('/', async (c: HonoContext) => {
    try {
      const userId = c.get('userId');
      const body = await c.req.json();

      // Validate if schema provided
      let data = body;
      if (schema) {
        data = validate(schema, body);
      }

      // Filter to allowed fields
      const row: Record<string, unknown> = {
        [idField]: crypto.randomUUID(),
        user_id: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      for (const [key, value] of Object.entries(data)) {
        const dbKey = convertToCamelCase(key);
        if (allowedFields.length === 0 || allowedFields.includes(dbKey)) {
          row[dbKey] = value;
        }
      }

      // Build INSERT statement
      const columns = Object.keys(row).join(', ');
      const placeholders = Object.keys(row)
        .map((_, i) => `?${i + 1}`)
        .join(', ');

      await execDb(
        c.env.DB,
        `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders})`,
        Object.values(row)
      );

      return c.json(row, 201);
    } catch (error) {
      throw error;
    }
  });

  /**
   * PUT /:id - Update item
   */
  router.put('/:id', async (c: HonoContext) => {
    try {
      const userId = c.get('userId');
      const id = c.req.param('id');
      const body = await c.req.json();

      // Check ownership
      const existing = await getOneDb(
        c.env.DB,
        `SELECT * FROM ${tableName} WHERE ${idField} = ?1 AND user_id = ?2`,
        [id, userId]
      );

      if (!existing) {
        throw new NotFoundError(tableName.slice(0, -1));
      }

      // Validate if schema provided
      let data = body;
      if (schema) {
        data = validate(schema, data);
      }

      // Filter to allowed fields
      const updates: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };

      for (const [key, value] of Object.entries(data)) {
        const dbKey = convertToCamelCase(key);
        if (allowedFields.length === 0 || allowedFields.includes(dbKey)) {
          updates[dbKey] = value;
        }
      }

      // Build UPDATE statement
      const setClauses = Object.keys(updates)
        .map((key, i) => `${key} = ?${i + 1}`)
        .join(', ');
      const values = [...Object.values(updates), id, userId];

      await execDb(
        c.env.DB,
        `UPDATE ${tableName} SET ${setClauses} WHERE ${idField} = ?${
          Object.keys(updates).length + 1
        } AND user_id = ?${Object.keys(updates).length + 2}`,
        values
      );

      // Fetch updated
      const updated = await getOneDb(
        c.env.DB,
        `SELECT * FROM ${tableName} WHERE ${idField} = ?1`,
        [id]
      );

      return c.json(updated);
    } catch (error) {
      throw error;
    }
  });

  /**
   * DELETE /:id - Delete item
   */
  router.delete('/:id', async (c: HonoContext) => {
    try {
      const userId = c.get('userId');
      const id = c.req.param('id');

      // Check ownership
      const existing = await getOneDb(
        c.env.DB,
        `SELECT * FROM ${tableName} WHERE ${idField} = ?1 AND user_id = ?2`,
        [id, userId]
      );

      if (!existing) {
        throw new NotFoundError(tableName.slice(0, -1));
      }

      await execDb(
        c.env.DB,
        `DELETE FROM ${tableName} WHERE ${idField} = ?1 AND user_id = ?2`,
        [id, userId]
      );

      return c.json({ success: true });
    } catch (error) {
      throw error;
    }
  });

  return router;
}

/**
 * Convert snake_case to camelCase
 */
function convertToCamelCase(str: string): string {
  return str.replace(/_(.)/g, (_, char) => char.toUpperCase());
}

/**
 * Create resource-specific routers
 */
export function createInvoiceRoutes() {
  return createCrudRoutes({
    tableName: 'invoices',
    allowedFields: [
      'invoiceNumber',
      'clientId',
      'clientName',
      'issueDate',
      'dueDate',
      'amount',
      'currency',
      'tax',
      'status',
      'description',
      'notes',
    ],
  });
}

export function createExpenseRoutes() {
  return createCrudRoutes({
    tableName: 'expenses',
    allowedFields: [
      'date',
      'category',
      'description',
      'amount',
      'currency',
      'paymentMethod',
      'tax',
      'taxRate',
      'taxable',
      'receipt',
      'notes',
    ],
  });
}

export function createContractRoutes() {
  return createCrudRoutes({
    tableName: 'contracts',
    allowedFields: [
      'clientId',
      'clientName',
      'title',
      'hourlyRate',
      'hoursPerWeek',
      'startDate',
      'endDate',
      'currency',
      'status',
      'renewalDate',
      'terms',
      'notes',
    ],
  });
}

export function createScenarioRoutes() {
  return createCrudRoutes({
    tableName: 'scenarios',
    allowedFields: [
      'name',
      'description',
      'type',
      'revenueChange',
      'rateChange',
      'hoursChange',
      'expenseIncrease',
      'startMonth',
      'duration',
    ],
  });
}

export function createWiseAccountRoutes() {
  return createCrudRoutes({
    tableName: 'wise_accounts',
    allowedFields: ['accountId', 'currency', 'balance', 'balanceUSD', 'type', 'status'],
  });
}

export function createHedgingRoutes() {
  return createCrudRoutes({
    tableName: 'hedging_contracts',
    allowedFields: [
      'invoiceId',
      'originalAmount',
      'originalCurrency',
      'hedgedAmount',
      'hedgedCurrency',
      'rate',
      'premium',
      'expiryDate',
      'status',
      'provider',
    ],
  });
}

export function createLeadRoutes() {
  return createCrudRoutes({
    tableName: 'leads',
    allowedFields: [
      'companyName',
      'contactName',
      'email',
      'phone',
      'budget',
      'currency',
      'industry',
      'status',
      'score',
      'probability',
      'source',
      'notes',
      'lastContact',
      'expectedClosingDate',
    ],
  });
}

export function createProjectRoutes() {
  return createCrudRoutes({
    tableName: 'projects',
    allowedFields: [
      'clientId',
      'clientName',
      'name',
      'description',
      'scope',
      'budget',
      'currency',
      'spent',
      'status',
      'completionPercentage',
      'startDate',
      'dueDate',
      'endDate',
      'notes',
    ],
  });
}
