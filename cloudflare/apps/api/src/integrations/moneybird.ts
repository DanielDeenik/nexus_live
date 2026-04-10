/**
 * Moneybird API Client (Workers-native, fetch-based, READ-ONLY)
 * Reads invoices, contacts — does not create or send.
 */

import { loadConfig } from '@nexus-live/shared';
import type { D1Database } from '@cloudflare/workers-types';

export class MoneybirdClient {
  private constructor(
    private readonly token: string,
    private readonly apiBase: string,
    private readonly administrationId: string,
    private readonly perPage: number
  ) {}

  static async create(
    db: D1Database,
    env: { MONEYBIRD_TOKEN?: string; MONEYBIRD_ADMINISTRATION_ID?: string }
  ): Promise<MoneybirdClient | null> {
    if (!env.MONEYBIRD_TOKEN || !env.MONEYBIRD_ADMINISTRATION_ID) return null;
    const cfg = await loadConfig(db as any);
    const apiBase = (cfg['integrations.moneybird.api_base'] as string) || 'https://moneybird.com/api/v2';
    const perPage = Number(cfg['integrations.moneybird.per_page'] ?? 100);
    return new MoneybirdClient(env.MONEYBIRD_TOKEN, apiBase, env.MONEYBIRD_ADMINISTRATION_ID, perPage);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  private url(path: string): string {
    return `${this.apiBase}/${this.administrationId}${path}`;
  }

  async listSalesInvoices(state?: string): Promise<unknown[]> {
    const all: unknown[] = [];
    let page = 1;
    while (true) {
      const qs = new URLSearchParams({ per_page: String(this.perPage), page: String(page) });
      if (state) qs.set('filter', `state:${state}`);
      const res = await fetch(this.url(`/sales_invoices.json?${qs.toString()}`), { headers: this.headers() });
      if (!res.ok) throw new Error(`Moneybird listSalesInvoices failed: ${res.status}`);
      const batch = (await res.json()) as unknown[];
      all.push(...batch);
      if (batch.length < this.perPage) break;
      page++;
    }
    return all;
  }

  async listContacts(): Promise<unknown[]> {
    const res = await fetch(this.url('/contacts.json'), { headers: this.headers() });
    if (!res.ok) throw new Error(`Moneybird listContacts failed: ${res.status}`);
    return (await res.json()) as unknown[];
  }
}
