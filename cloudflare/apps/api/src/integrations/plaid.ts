/**
 * Plaid API Client (Workers-native, fetch-based)
 * Zero hardcoded values — all config via app_config / env secrets
 */

import { loadConfig } from '@nexus-live/shared';
import type { D1Database } from '@cloudflare/workers-types';

export interface PlaidEnvBindings {
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_ENV?: string;
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  name: string;
  category?: string[];
  pending: boolean;
}

function envBaseUrl(env: string): string {
  // sandbox | development | production
  return `https://${env}.plaid.com`;
}

export class PlaidClient {
  private constructor(
    private readonly clientId: string,
    private readonly secret: string,
    private readonly baseUrl: string,
    private readonly batchSize: number
  ) {}

  static async create(db: D1Database, env: PlaidEnvBindings): Promise<PlaidClient | null> {
    if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) return null;
    const cfg = await loadConfig(db as any);
    const plaidEnv = (env.PLAID_ENV as string) || (cfg['integrations.plaid.env'] as string) || 'sandbox';
    const batchSize = Number(cfg['integrations.plaid.tx_batch_size'] ?? 250);
    return new PlaidClient(env.PLAID_CLIENT_ID, env.PLAID_SECRET, envBaseUrl(plaidEnv), batchSize);
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        secret: this.secret,
        ...body,
      }),
    });
    if (!res.ok) throw new Error(`Plaid ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async getTransactions(accessToken: string, startDate: string, endDate: string): Promise<PlaidTransaction[]> {
    const all: PlaidTransaction[] = [];
    let offset = 0;
    while (true) {
      const data = await this.post<{ transactions: PlaidTransaction[]; total_transactions: number }>(
        '/transactions/get',
        {
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { count: this.batchSize, offset },
        }
      );
      all.push(...data.transactions);
      if (all.length >= data.total_transactions) break;
      offset += data.transactions.length;
      if (data.transactions.length === 0) break;
    }
    return all;
  }

  async getAccounts(accessToken: string): Promise<unknown> {
    return this.post('/accounts/get', { access_token: accessToken });
  }

  async exchangePublicToken(publicToken: string): Promise<{ access_token: string; item_id: string }> {
    return this.post('/item/public_token/exchange', { public_token: publicToken });
  }
}
