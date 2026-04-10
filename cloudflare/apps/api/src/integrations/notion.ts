/**
 * Notion API Client (Workers-native, fetch-based)
 * Zero hardcoded values — all config via app_config
 */

import { loadConfig } from '@nexus-live/shared';
import type { D1Database } from '@cloudflare/workers-types';

export interface NotionConfig {
  apiBase: string;
  apiVersion: string;
  pageSize: number;
}

async function getNotionConfig(db: D1Database): Promise<NotionConfig> {
  const cfg = await loadConfig(db as any);
  return {
    apiBase: (cfg['integrations.notion.api_base'] as string) || 'https://api.notion.com/v1',
    apiVersion: (cfg['integrations.notion.api_version'] as string) || '2022-06-28',
    pageSize: Number(cfg['integrations.notion.page_size'] ?? 100),
  };
}

function authHeaders(token: string, version: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': version,
    'Content-Type': 'application/json',
  };
}

export class NotionClient {
  constructor(
    private readonly token: string,
    private readonly cfg: NotionConfig
  ) {}

  static async create(db: D1Database, token: string): Promise<NotionClient> {
    const cfg = await getNotionConfig(db);
    return new NotionClient(token, cfg);
  }

  async queryDatabase(databaseId: string, filter?: unknown): Promise<unknown[]> {
    const results: unknown[] = [];
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = { page_size: this.cfg.pageSize };
      if (cursor) body.start_cursor = cursor;
      if (filter) body.filter = filter;
      const res = await fetch(`${this.cfg.apiBase}/databases/${databaseId}/query`, {
        method: 'POST',
        headers: authHeaders(this.token, this.cfg.apiVersion),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as { results: unknown[]; next_cursor?: string; has_more: boolean };
      results.push(...data.results);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    return results;
  }

  async getPage(pageId: string): Promise<unknown> {
    const res = await fetch(`${this.cfg.apiBase}/pages/${pageId}`, {
      headers: authHeaders(this.token, this.cfg.apiVersion),
    });
    if (!res.ok) throw new Error(`Notion getPage failed: ${res.status}`);
    return res.json();
  }

  async createPage(parentDatabaseId: string, properties: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.cfg.apiBase}/pages`, {
      method: 'POST',
      headers: authHeaders(this.token, this.cfg.apiVersion),
      body: JSON.stringify({
        parent: { database_id: parentDatabaseId },
        properties,
      }),
    });
    if (!res.ok) throw new Error(`Notion createPage failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async updatePage(pageId: string, properties: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.cfg.apiBase}/pages/${pageId}`, {
      method: 'PATCH',
      headers: authHeaders(this.token, this.cfg.apiVersion),
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) throw new Error(`Notion updatePage failed: ${res.status}`);
    return res.json();
  }
}
