/// <reference types="@cloudflare/workers-types" />

/**
 * RSS feed refresh handler
 * Fetches configured RSS sources, scores signals, updates market_signals table
 */

import { scoreSignal, loadConfig } from '@nexus-live/shared';
import { queryDb, execDb } from '../utils/db';

interface FeedEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  JWT_SECRET: string;
}

/**
 * Main feed refresh handler
 */
export async function triggerFeedRefresh(env: FeedEnv): Promise<void> {
  const startTime = Date.now();
  console.log('[FEED] RSS feed refresh starting');

  try {
    // Load config
    const config = await loadConfig(env.DB as any);

    // Get configured RSS feeds
    const feeds = await queryDb<any>(
      env.DB,
      `
      SELECT id, user_id, type, url, is_active
      FROM data_sources
      WHERE type = 'rss' AND is_active = 1
      `,
      []
    );

    console.log(`[FEED] Processing ${feeds.length} RSS feeds`);

    for (const feed of feeds) {
      await processFeed(feed, config, env);
    }

    const duration = Date.now() - startTime;
    console.log(`[FEED] Feed refresh completed in ${duration}ms`);
  } catch (error) {
    console.error('[FEED] Error:', error);
  }
}

/**
 * Process a single RSS feed
 */
async function processFeed(
  feed: any,
  config: any,
  env: FeedEnv
): Promise<void> {
  try {
    console.log(`[FEED] Processing feed: ${feed.url}`);

    // Fetch RSS feed
    const entries = await fetchRSSFeed(feed.url);
    console.log(`[FEED] Fetched ${entries.length} entries from ${feed.url}`);

    const now = new Date().toISOString();
    let processed = 0;

    // Process each entry
    for (const entry of entries) {
      // Score signal
      const scoredSignal = scoreSignal(
        {
          id: crypto.randomUUID(),
          type: feed.type as 'currency' | 'market' | 'industry' | 'lead' | 'operational',
          subtype: entry.subtype || 'general',
          data: { description: entry.description, ...(entry.dataPoints || {}) },
          timestamp: now,
        },
        { riskTolerance: 'medium', goals: [], constraints: [] } as any,
        config.scoringConfig
      );

      // Determine tier
      const tier = getTier(scoredSignal.score, config.scoringConfig);

      // Check if signal already exists (by URL or description hash)
      const existing = await queryDb<any>(
        env.DB,
        `
        SELECT id FROM market_signals
        WHERE user_id = ?1 AND description = ?2 AND created_at > datetime('now', '-1 day')
        `,
        [feed.userId, entry.description]
      );

      if (existing.length === 0) {
        // Insert new signal
        const signalId = crypto.randomUUID();
        const expiryDate = getExpiryDate(tier);

        await execDb(
          env.DB,
          `
          INSERT INTO market_signals
          (id, user_id, type, subtype, severity, score, tier, description, action, data_points, created_at, expires_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
          `,
          [
            signalId,
            feed.userId,
            feed.type,
            entry.subtype || 'general',
            getSeverity(scoredSignal.score),
            scoredSignal.score,
            tier,
            entry.description,
            getActionFromTier(tier),
            JSON.stringify(entry.dataPoints || {}),
            now,
            expiryDate,
          ]
        );

        processed++;
      }
    }

    // Update feed sync time
    await execDb(
      env.DB,
      `
      UPDATE data_sources
      SET synced_at = ?, next_sync_at = ?
      WHERE id = ?
      `,
      [now, getNextSyncTime(), feed.id]
    );

    console.log(`[FEED] Processed ${processed} new signals from ${feed.url}`);
  } catch (error) {
    console.error(`[FEED] Error processing feed ${feed.url}:`, error);
  }
}

/**
 * Fetch RSS feed entries
 */
async function fetchRSSFeed(url: string): Promise<Array<{
  description: string;
  subtype?: string;
  dataPoints?: Record<string, any>;
}>> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();

    // Parse RSS/Atom feed
    const entries = parseRSSFeed(text);
    return entries;
  } catch (error) {
    console.error(`[FEED] Error fetching ${url}:`, error);
    return [];
  }
}

/**
 * Simple RSS/Atom parser
 */
function parseRSSFeed(xml: string): Array<{
  description: string;
  subtype?: string;
  dataPoints?: Record<string, any>;
}> {
  const entries: any[] = [];

  // Simple regex-based parsing (for Cloudflare Workers without DOM API)
  const itemRegex = /<item[^>]*>[\s\S]*?<\/item>/gi;
  const entryRegex = /<entry[^>]*>[\s\S]*?<\/entry>/gi;

  const items = xml.match(itemRegex) || [];
  const atomEntries = xml.match(entryRegex) || [];

  const allEntries = [...items, ...atomEntries];

  for (const item of allEntries) {
    try {
      const titleMatch = item.match(/<title[^>]*>([^<]+)<\/title>/i);
      const descMatch = item.match(/<description[^>]*>([^<]+)<\/description>/i) ||
        item.match(/<summary[^>]*>([^<]+)<\/summary>/i);
      const linkMatch = item.match(/<link[^>]*>([^<]+)<\/link>/i) ||
        item.match(/href=["']([^"']+)["']/i);

      if (titleMatch || descMatch) {
        entries.push({
          description: `${titleMatch ? titleMatch[1] : ''} ${descMatch ? descMatch[1] : ''}`.trim(),
          dataPoints: {
            source: 'rss_feed',
            link: linkMatch ? linkMatch[1] : null,
          },
        });
      }
    } catch {
      // Skip malformed entries
    }
  }

  return entries;
}

/**
 * Determine signal tier from score
 */
function getTier(
  score: number,
  config: any
): 'HOT' | 'WARM' | 'MONITOR' | 'COLD' {
  if (score >= config.hotThreshold) return 'HOT';
  if (score >= config.warmThreshold) return 'WARM';
  if (score >= config.monitorThreshold) return 'MONITOR';
  return 'COLD';
}

/**
 * Get severity level
 */
function getSeverity(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

/**
 * Get action from tier
 */
function getActionFromTier(tier: string): string {
  switch (tier) {
    case 'HOT':
      return 'Investigate immediately';
    case 'WARM':
      return 'Review soon';
    case 'MONITOR':
      return 'Keep watching';
    default:
      return 'Archive';
  }
}

/**
 * Get expiry date based on tier
 */
function getExpiryDate(tier: string): string {
  const days =
    tier === 'HOT'
      ? 7
      : tier === 'WARM'
        ? 14
        : tier === 'MONITOR'
          ? 30
          : 60;

  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

/**
 * Get next sync time
 */
function getNextSyncTime(): string {
  // Next sync in 4 hours
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString();
}
