/**
 * Integration factory — lazy-instantiates clients only when secrets present.
 * Zero hardcoded values: every base URL, page size, TTL flows through app_config.
 */

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import { NotionClient } from './notion';
import { PlaidClient } from './plaid';
import { WiseClient } from './wise';
import { StripeClient } from './stripe';
import { MoneybirdClient } from './moneybird';
import { FxRateClient } from './fx-rates';

export interface IntegrationEnv {
  NOTION_TOKEN?: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_ENV?: string;
  WISE_TOKEN?: string;
  WISE_PROFILE_ID?: string;
  STRIPE_SECRET?: string;
  MONEYBIRD_TOKEN?: string;
  MONEYBIRD_ADMINISTRATION_ID?: string;
  FX_API_KEY?: string;
}

export interface IntegrationsBag {
  notion: NotionClient | null;
  plaid: PlaidClient | null;
  wise: WiseClient | null;
  stripe: StripeClient | null;
  moneybird: MoneybirdClient | null;
  fx: FxRateClient;
}

export async function buildIntegrations(
  db: D1Database,
  cache: KVNamespace,
  env: IntegrationEnv & Record<string, unknown>
): Promise<IntegrationsBag> {
  const [notion, plaid, wise, stripe, moneybird, fx] = await Promise.all([
    env.NOTION_TOKEN ? NotionClient.create(db, env.NOTION_TOKEN) : Promise.resolve(null),
    PlaidClient.create(db, env),
    WiseClient.create(db, env),
    StripeClient.create(db, env),
    MoneybirdClient.create(db, env),
    FxRateClient.create(db, env, cache),
  ]);

  return { notion, plaid, wise, stripe, moneybird, fx };
}

export {
  NotionClient,
  PlaidClient,
  WiseClient,
  StripeClient,
  MoneybirdClient,
  FxRateClient,
};
