/**
 * Wise (TransferWise) API Client (Workers-native, fetch-based, READ-ONLY)
 * Never initiates transfers — read-only by policy.
 */

import { loadConfig } from '@nexus-live/shared';
import type { D1Database } from '@cloudflare/workers-types';

export interface WiseBalance {
  id: number;
  currency: string;
  amount: { value: number; currency: string };
  reservedAmount?: { value: number; currency: string };
  cashAmount?: { value: number; currency: string };
}

export class WiseClient {
  private constructor(
    private readonly token: string,
    private readonly apiBase: string,
    private readonly profileId: string | null
  ) {}

  static async create(db: D1Database, env: { WISE_TOKEN?: string; WISE_PROFILE_ID?: string }): Promise<WiseClient | null> {
    if (!env.WISE_TOKEN) return null;
    const cfg = await loadConfig(db as any);
    const apiBase = (cfg['integrations.wise.api_base'] as string) || 'https://api.wise.com';
    return new WiseClient(env.WISE_TOKEN, apiBase, env.WISE_PROFILE_ID || null);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  async getProfiles(): Promise<unknown[]> {
    const res = await fetch(`${this.apiBase}/v2/profiles`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Wise getProfiles failed: ${res.status}`);
    return (await res.json()) as unknown[];
  }

  async getBalances(profileId?: string): Promise<WiseBalance[]> {
    const pid = profileId || this.profileId;
    if (!pid) throw new Error('Wise profile id required');
    const res = await fetch(`${this.apiBase}/v4/profiles/${pid}/balances?types=STANDARD`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Wise getBalances failed: ${res.status}`);
    return (await res.json()) as WiseBalance[];
  }

  async getQuote(source: string, target: string, sourceAmount: number): Promise<unknown> {
    if (!this.profileId) throw new Error('Wise profile id required');
    const res = await fetch(`${this.apiBase}/v3/profiles/${this.profileId}/quotes`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        sourceCurrency: source,
        targetCurrency: target,
        sourceAmount,
      }),
    });
    if (!res.ok) throw new Error(`Wise getQuote failed: ${res.status}`);
    return res.json();
  }
}
