/**
 * Stripe API Client (Workers-native, fetch-based, READ-ONLY)
 * Reads payouts, charges, balance — does not initiate payments.
 */

import { loadConfig } from '@nexus-live/shared';
import type { D1Database } from '@cloudflare/workers-types';

export class StripeClient {
  private constructor(
    private readonly secret: string,
    private readonly apiBase: string,
    private readonly apiVersion: string
  ) {}

  static async create(db: D1Database, env: { STRIPE_SECRET?: string }): Promise<StripeClient | null> {
    if (!env.STRIPE_SECRET) return null;
    const cfg = await loadConfig(db as any);
    const apiBase = (cfg['integrations.stripe.api_base'] as string) || 'https://api.stripe.com';
    const apiVersion = (cfg['integrations.stripe.api_version'] as string) || '2024-06-20';
    return new StripeClient(env.STRIPE_SECRET, apiBase, apiVersion);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.secret}`,
      'Stripe-Version': this.apiVersion,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
  }

  private async get<T>(path: string, query?: Record<string, string>): Promise<T> {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const res = await fetch(`${this.apiBase}${path}${qs}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Stripe ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async listCharges(limit: number, startingAfter?: string): Promise<unknown> {
    const q: Record<string, string> = { limit: String(limit) };
    if (startingAfter) q.starting_after = startingAfter;
    return this.get('/v1/charges', q);
  }

  async listPayouts(limit: number): Promise<unknown> {
    return this.get('/v1/payouts', { limit: String(limit) });
  }

  async getBalance(): Promise<unknown> {
    return this.get('/v1/balance');
  }
}
