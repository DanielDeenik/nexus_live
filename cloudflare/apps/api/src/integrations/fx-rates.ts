/**
 * FX Rate Provider (Workers-native, fetch-based)
 * Pluggable provider via app_config: integrations.fx.provider
 * Supported providers: exchangerate.host (free), openexchangerates, frankfurter
 * Caches results in KV with TTL from app_config.
 */

import { loadConfig } from '@nexus-live/shared';
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

export interface FxRates {
  base: string;
  rates: Record<string, number>;
  fetchedAt: string;
  source: string;
}

export interface FxProviderConfig {
  provider: string;
  apiBase: string;
  apiKey?: string;
  ttlSeconds: number;
  baseCurrency: string;
}

async function getFxConfig(db: D1Database, env: Record<string, unknown>): Promise<FxProviderConfig> {
  const cfg = await loadConfig(db as any);
  return {
    provider: (cfg['integrations.fx.provider'] as string) || 'frankfurter',
    apiBase: (cfg['integrations.fx.api_base'] as string) || 'https://api.frankfurter.app',
    apiKey: (env.FX_API_KEY as string | undefined),
    ttlSeconds: Number(cfg['integrations.fx.cache_ttl_seconds'] ?? 3600),
    baseCurrency: (cfg['fx.base_currency'] as string) || 'EUR',
  };
}

export class FxRateClient {
  private constructor(
    private readonly cfg: FxProviderConfig,
    private readonly cache: KVNamespace
  ) {}

  static async create(db: D1Database, env: Record<string, unknown>, cache: KVNamespace): Promise<FxRateClient> {
    const cfg = await getFxConfig(db, env);
    return new FxRateClient(cfg, cache);
  }

  async getLatest(base?: string): Promise<FxRates> {
    const baseCurrency = base || this.cfg.baseCurrency;
    const cacheKey = `fx:latest:${this.cfg.provider}:${baseCurrency}`;
    const cached = await this.cache.get<FxRates>(cacheKey, 'json');
    if (cached) return cached;

    const rates = await this.fetchFromProvider(baseCurrency);
    await this.cache.put(cacheKey, JSON.stringify(rates), { expirationTtl: this.cfg.ttlSeconds });
    return rates;
  }

  private async fetchFromProvider(base: string): Promise<FxRates> {
    let url: string;
    let headers: Record<string, string> = {};

    switch (this.cfg.provider) {
      case 'frankfurter':
        url = `${this.cfg.apiBase}/latest?from=${base}`;
        break;
      case 'exchangerate.host':
        url = `${this.cfg.apiBase}/latest?base=${base}`;
        if (this.cfg.apiKey) url += `&access_key=${this.cfg.apiKey}`;
        break;
      case 'openexchangerates':
        url = `${this.cfg.apiBase}/latest.json?base=${base}`;
        if (this.cfg.apiKey) headers['Authorization'] = `Token ${this.cfg.apiKey}`;
        break;
      default:
        throw new Error(`Unknown FX provider: ${this.cfg.provider}`);
    }

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`FX fetch failed (${this.cfg.provider}): ${res.status}`);
    const data = (await res.json()) as { base?: string; rates: Record<string, number> };

    return {
      base: data.base || base,
      rates: data.rates,
      fetchedAt: new Date().toISOString(),
      source: this.cfg.provider,
    };
  }

  async convert(amount: number, from: string, to: string): Promise<number> {
    if (from === to) return amount;
    const rates = await this.getLatest(from);
    const rate = rates.rates[to];
    if (!rate) throw new Error(`No FX rate available: ${from}->${to}`);
    return amount * rate;
  }
}
