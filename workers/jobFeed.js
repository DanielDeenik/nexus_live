'use strict';
/**
 * workers/jobFeed.js — RSS job board fetcher + Waze-style multi-source scorer
 *
 * Waze analogy:
 *   Each RSS source is an independent "sensor" reporting traffic (demand).
 *   Signal strength = keyword relevance × source authority × recency.
 *   Multiple sensors seeing the same role = stronger confirmation → score boost.
 *   Final score → tier: HOT (80+) / WARM (55-79) / MONITOR (30-54) / COLD (<30)
 *
 * Sources:
 *   - Indeed NL RSS  (finance / risk / regulatory roles)
 *   - eFinancialCareers RSS
 *   - Other sources can be added to SOURCES array
 *
 * Output (cached in memory, refreshed daily via lib/scheduler.js):
 *   Array of scored FeedItem objects, sorted by score descending.
 */

let RssParser;
try {
  RssParser = require('rss-parser');
} catch {
  RssParser = null; // Graceful fallback if rss-parser not installed yet
}

// ── RSS Sources ───────────────────────────────────────────────────────────────

const SOURCES = [
  {
    id:        'indeed-nl-finance',
    name:      'Indeed NL — Finance & Risk',
    authority: 1.0,  // 0–1 weighting multiplier
    url:       'https://nl.indeed.com/rss?q=fund+operations+risk+compliance&l=Netherlands&radius=50',
  },
  {
    id:        'efinancial-nl',
    name:      'eFinancialCareers NL',
    authority: 1.2,  // Specialist board — higher authority
    url:       'https://www.efinancialcareers.com/rss/jobs?country=NL&keywords=fund+operations+regulatory',
  },
  {
    id:        'linkedin-rss-fo',
    name:      'LinkedIn Jobs — Fund Ops NL',
    authority: 0.9,
    url:       'https://www.linkedin.com/jobs/search/?keywords=fund+operations&location=Netherlands&f_WT=1&format=rss',
  },
];

// ── Keyword Score Matrix ──────────────────────────────────────────────────────
// Points awarded per keyword found in title + description.
// Calibrated for Dan Deenik (Senior FO Consultant, FX/RegReporting/SimCorp/DORA).

const KEYWORD_SCORES = [
  // Core skill matches (high value)
  { pattern: /simcorp/i,              pts: 25, tier: 'core' },
  { pattern: /fund\s+operations?/i,   pts: 20, tier: 'core' },
  { pattern: /transfer\s+pricing/i,   pts: 18, tier: 'core' },
  { pattern: /regulatory\s+report/i,  pts: 18, tier: 'core' },
  { pattern: /dora/i,                 pts: 15, tier: 'regulatory' },
  { pattern: /sfdr/i,                 pts: 15, tier: 'regulatory' },
  { pattern: /aifmd/i,                pts: 15, tier: 'regulatory' },
  { pattern: /mifid/i,                pts: 15, tier: 'regulatory' },
  { pattern: /emir/i,                 pts: 12, tier: 'regulatory' },
  { pattern: /ucits/i,                pts: 12, tier: 'regulatory' },
  { pattern: /ifrs\s*9/i,             pts: 12, tier: 'accounting' },
  { pattern: /hedg(e|ing)/i,          pts: 10, tier: 'finance' },
  { pattern: /fx\s+(risk|report|ops)/i, pts: 12, tier: 'core' },
  { pattern: /derivatives/i,          pts: 10, tier: 'finance' },
  { pattern: /asset\s+manag/i,        pts: 10, tier: 'finance' },
  { pattern: /investment\s+manag/i,   pts: 8,  tier: 'finance' },
  { pattern: /treasury/i,             pts: 8,  tier: 'finance' },
  { pattern: /financial\s+operations?/i, pts: 8, tier: 'finance' },
  { pattern: /middle\s+office/i,      pts: 10, tier: 'core' },
  { pattern: /back\s+office/i,        pts: 7,  tier: 'finance' },
  { pattern: /reconciliation/i,       pts: 8,  tier: 'core' },
  { pattern: /collateral\s+manag/i,   pts: 10, tier: 'core' },
  { pattern: /securities\s+(ops|lending)/i, pts: 10, tier: 'finance' },
  { pattern: /risk\s+(manag|model|officer)/i, pts: 10, tier: 'finance' },
  { pattern: /compliance/i,           pts: 7,  tier: 'regulatory' },
  { pattern: /controller/i,           pts: 6,  tier: 'accounting' },
  { pattern: /senior/i,               pts: 5,  tier: 'seniority' },
  { pattern: /lead/i,                 pts: 4,  tier: 'seniority' },
  { pattern: /principal/i,            pts: 4,  tier: 'seniority' },
  { pattern: /freelan|interim|contract|zzp|consultant/i, pts: 8, tier: 'engagement' },
  // Location signals
  { pattern: /amsterdam|schiphol/i,   pts: 5,  tier: 'location' },
  { pattern: /netherlands|nederland/i,pts: 3,  tier: 'location' },
  { pattern: /remote|hybrid/i,        pts: 3,  tier: 'location' },
  // Negative signals (reduce score for poor fits)
  { pattern: /junior|graduate|entry.level|trainee/i, pts: -10, tier: 'negative' },
  { pattern: /internship|stage/i,     pts: -20, tier: 'negative' },
  { pattern: /python\s+developer|software\s+engineer/i, pts: -8, tier: 'negative' },
  { pattern: /permanent\s+only|perm\s+only/i, pts: -5, tier: 'negative' },
];

// ── Recency decay ─────────────────────────────────────────────────────────────
// Score multiplier based on days since posting.
// Fresh signal (0–3 days) = 1.0x, week-old = 0.75x, month-old = 0.3x.

function recencyMultiplier(pubDate) {
  if (!pubDate) return 0.5;
  const ageMs   = Date.now() - new Date(pubDate).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 3)  return 1.0;
  if (ageDays < 7)  return 0.85;
  if (ageDays < 14) return 0.70;
  if (ageDays < 30) return 0.50;
  return 0.30;
}

// ── Score a single item ────────────────────────────────────────────────────────

function scoreItem(item, sourceAuthority) {
  const text    = `${item.title || ''} ${item.contentSnippet || item.content || item.summary || ''}`;
  let rawScore  = 0;
  const matches = [];

  for (const kw of KEYWORD_SCORES) {
    if (kw.pattern.test(text)) {
      rawScore += kw.pts;
      if (kw.pts > 0) matches.push({ keyword: kw.pattern.source, pts: kw.pts, tier: kw.tier });
    }
  }

  const decay = recencyMultiplier(item.pubDate || item.isoDate);
  const score = Math.round(rawScore * decay * sourceAuthority);

  return { score, rawScore, decay, matches };
}

// ── Tier assignment ────────────────────────────────────────────────────────────

function assignTier(score) {
  if (score >= 80) return 'HOT';
  if (score >= 55) return 'WARM';
  if (score >= 30) return 'MONITOR';
  return 'COLD';
}

// ── Deduplication (same role, multiple sources) ───────────────────────────────

function dedup(items) {
  const seen = new Map();
  for (const item of items) {
    // Normalise title for comparison
    const key = (item.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (!seen.has(key)) {
      seen.set(key, item);
    } else {
      // Merge: keep higher score, add source to sources array
      const existing = seen.get(key);
      if (item.score > existing.score) {
        seen.set(key, { ...item, sources: [...(existing.sources || [existing.sourceId]), item.sourceId] });
      } else {
        existing.sources = [...(existing.sources || [existing.sourceId]), item.sourceId];
        // Multi-source confirmation bonus (+10)
        existing.score   = Math.min(100, existing.score + 10);
        existing.tier    = assignTier(existing.score);
      }
    }
  }
  return Array.from(seen.values());
}

// ── Fetch and score one source ─────────────────────────────────────────────────

async function fetchSource(source) {
  if (!RssParser) {
    console.warn('[jobFeed] rss-parser not installed. Run: npm install rss-parser');
    return [];
  }

  const parser = new RssParser({
    timeout: 10000,
    headers: { 'User-Agent': 'Nexus-Live-JobFeed/5.0 (+https://github.com/nexus-live)' },
  });

  try {
    const feed  = await parser.parseURL(source.url);
    const items = (feed.items || []).slice(0, 50); // max 50 per source

    return items.map(item => {
      const { score, rawScore, decay, matches } = scoreItem(item, source.authority);
      return {
        id:          `${source.id}::${encodeURIComponent(item.link || item.title || Math.random())}`,
        title:       item.title    || 'Untitled',
        company:     item.creator  || extractCompany(item),
        link:        item.link     || null,
        pubDate:     item.pubDate  || item.isoDate || null,
        snippet:     (item.contentSnippet || item.summary || '').slice(0, 280),
        sourceId:    source.id,
        sourceName:  source.name,
        sources:     [source.id],
        score,
        rawScore,
        decay:       Math.round(decay * 100) / 100,
        tier:        assignTier(score),
        matchedKeywords: matches,
      };
    });
  } catch (err) {
    console.warn(`[jobFeed] Failed to fetch ${source.name}: ${err.message}`);
    return [];
  }
}

// Try to extract company name from feed item
function extractCompany(item) {
  const text = item.title || '';
  // Common patterns: "Role Title at Company", "Company – Role Title"
  const m = text.match(/\bat\s+([A-Z][^-–|]+)/);
  if (m) return m[1].trim();
  const m2 = text.match(/^([A-Z][^–|-]+)[–|-]/);
  if (m2) return m2[1].trim();
  return null;
}

// ── In-memory store ────────────────────────────────────────────────────────────

let _cachedFeed = null;
let _lastFetch  = null;
const FEED_TTL_MS = 60 * 60 * 1000; // 1 hour

function isFeedStale() {
  if (!_lastFetch) return true;
  return (Date.now() - _lastFetch) > FEED_TTL_MS;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Refresh the feed from all sources. Stores result in memory.
 * @param {string[]} [profileSkills] — extra keywords from the user's Notion profile
 * @returns {object[]} scored feed items
 */
async function refresh(profileSkills = []) {
  console.log('[jobFeed] Refreshing feeds from', SOURCES.length, 'sources…');

  // Fetch all sources in parallel
  const results = await Promise.allSettled(SOURCES.map(s => fetchSource(s)));
  let items = [];
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value);
  }

  // Apply profile skill boosts
  if (profileSkills.length > 0) {
    for (const item of items) {
      const text = `${item.title} ${item.snippet}`.toLowerCase();
      let boost = 0;
      for (const skill of profileSkills) {
        if (text.includes(skill.toLowerCase())) boost += 5;
      }
      item.score     = Math.min(100, item.score + boost);
      item.tier      = assignTier(item.score);
    }
  }

  // Dedup and sort
  const deduped = dedup(items).sort((a, b) => b.score - a.score);

  _cachedFeed = deduped;
  _lastFetch  = Date.now();

  const tierCount = { HOT: 0, WARM: 0, MONITOR: 0, COLD: 0 };
  for (const item of deduped) tierCount[item.tier] = (tierCount[item.tier] || 0) + 1;

  console.log(`[jobFeed] ${deduped.length} roles scored:`, tierCount);
  return deduped;
}

/**
 * Return cached feed (refresh if stale).
 */
async function getFeed(profileSkills = []) {
  if (isFeedStale() || !_cachedFeed) {
    return refresh(profileSkills);
  }
  return _cachedFeed;
}

/**
 * Return feed metadata (last fetch time, counts, stale flag).
 */
function getFeedMeta() {
  const tierCount = { HOT: 0, WARM: 0, MONITOR: 0, COLD: 0 };
  if (_cachedFeed) {
    for (const item of _cachedFeed) tierCount[item.tier] = (tierCount[item.tier] || 0) + 1;
  }
  return {
    lastFetch:  _lastFetch ? new Date(_lastFetch).toISOString() : null,
    stale:      isFeedStale(),
    totalItems: _cachedFeed?.length ?? 0,
    tierCount,
    sources:    SOURCES.map(s => ({ id: s.id, name: s.name })),
  };
}

module.exports = { getFeed, refresh, getFeedMeta, SOURCES, KEYWORD_SCORES };
