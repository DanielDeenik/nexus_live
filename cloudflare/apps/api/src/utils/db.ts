/**
 * Database utilities for D1
 */

import type { D1Database, D1Result } from '@cloudflare/workers-types';

/**
 * Run a query and return results
 */
export async function queryDb<T>(
  db: D1Database,
  sql: string,
  bindings?: unknown[]
): Promise<T[]> {
  try {
    const stmt = db.prepare(sql);
    const bound = bindings ? stmt.bind(...bindings) : stmt;
    const result = await bound.all<T>();
    return result.results || [];
  } catch (error) {
    throw new Error(`Database query failed: ${error}`);
  }
}

/**
 * Get a single row
 */
export async function getOneDb<T>(
  db: D1Database,
  sql: string,
  bindings?: unknown[]
): Promise<T | null> {
  try {
    const stmt = db.prepare(sql);
    const bound = bindings ? stmt.bind(...bindings) : stmt;
    const result = await bound.first<T>();
    return result || null;
  } catch (error) {
    throw new Error(`Database query failed: ${error}`);
  }
}

/**
 * Execute a statement (insert, update, delete)
 */
export async function execDb(
  db: D1Database,
  sql: string,
  bindings?: unknown[]
): Promise<{ success: boolean; changes?: number }> {
  try {
    const stmt = db.prepare(sql);
    const bound = bindings ? stmt.bind(...bindings) : stmt;
    const result = await bound.run();
    return {
      success: result.success,
      changes: result.meta.changes,
    };
  } catch (error) {
    throw new Error(`Database operation failed: ${error}`);
  }
}

/**
 * Batch execute multiple statements
 */
export async function batchDb(
  db: D1Database,
  statements: Array<{ sql: string; bindings?: unknown[] }>
): Promise<D1Result[]> {
  try {
    const prepared = statements.map(stmt => {
      const p = db.prepare(stmt.sql);
      return stmt.bindings ? p.bind(...stmt.bindings) : p;
    });
    return await db.batch(prepared);
  } catch (error) {
    throw new Error(`Database batch operation failed: ${error}`);
  }
}

/**
 * Pagination helper
 */
export interface PaginationOptions {
  limit?: number;
  offset?: number;
  page?: number;
}

export function getPaginationParams(
  options: PaginationOptions
): { limit: number; offset: number } {
  const limit = Math.min(options.limit || 20, 100);
  const offset = options.offset
    ? options.offset
    : options.page
      ? (options.page - 1) * limit
      : 0;
  return { limit, offset };
}

/**
 * Count rows in a table
 */
export async function countDb(
  db: D1Database,
  table: string,
  whereClause?: string,
  bindings?: unknown[]
): Promise<number> {
  const sql = `SELECT COUNT(*) as count FROM ${table}${
    whereClause ? ` WHERE ${whereClause}` : ''
  }`;
  const result = await getOneDb<{ count: number }>(
    db,
    sql,
    bindings
  );
  return result?.count || 0;
}
