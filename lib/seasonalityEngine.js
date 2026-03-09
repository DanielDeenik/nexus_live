/**
 * lib/seasonalityEngine.js — Live seasonality data from Google Trends + job boards
 *
 * Strategy (in priority order):
 *   1. DB cache hit (7-day TTL) — instant
 *   2. google-trends-api (unofficial, free) — 1-2s
 *   3. Job board keyword frequency (scraped job counts by month proxy) — 3-5s
 *   4. Embedded fallback presets — instant, zero network
 *
 * Returns: { industry, location, months[12], data[12], peak[3], slow[3], source, fresh }
 */

const googleTrends = require('google-trends-api');

// ─── Keyword mapping per industry ─────────────────────────────────────────────
// Map internal industry labels → Google Trends search terms most relevant to
// freelance consulting demand in that sector.

const INDUSTRY_TERMS = {
  'Asset Management':     'asset management consultant',
  'Investment Banking':   'investment banking contract',
  'Banking':              'banking consultant contract',
  'FinTech':              'fintech contract developer',
  'Insurance':            'insurance consultant',
  'Accounting & Audit':   'audit consultant contract',
  'Risk & Compliance':    'compliance consultant',
  'Technology':           'IT contractor',
  'Data & Analytics':     'data analyst contract',
  'Consulting':           'management consultant',
  'Real Estate':          'real estate consultant',
  'Healthcare':           'healthcare consultant contract',
  'Energy':               'energy sector consultant',
  'Payments':             'payments consultant fintech',
  'Wealth Management':    'wealth management consultant',
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ─── Embedded fallback presets (used when all network calls fail) ─────────────
// These represent typical consulting hiring demand patterns, 0-100 index.

const FALLBACK_PRESETS = {
  'Asset Management':     [88, 90, 82, 70, 75, 65, 22, 18, 72, 85, 55, 20],
  'Investment Banking':   [90, 88, 85, 72, 70, 60, 20, 15, 68, 88, 60, 15],
  'Banking':              [82, 84, 78, 72, 70, 62, 28, 22, 70, 80, 58, 25],
  'FinTech':              [78, 82, 80, 78, 76, 70, 45, 40, 72, 80, 62, 30],
  'Insurance':            [80, 82, 76, 70, 72, 65, 30, 28, 68, 78, 60, 35],
  'Accounting & Audit':   [85, 88, 92, 80, 70, 58, 25, 22, 65, 75, 68, 30],
  'Risk & Compliance':    [82, 84, 80, 78, 72, 65, 30, 25, 72, 80, 62, 28],
  'Technology':           [80, 82, 82, 78, 78, 72, 50, 45, 76, 82, 68, 38],
  'Data & Analytics':     [78, 80, 82, 78, 76, 68, 42, 38, 74, 80, 64, 32],
  'Consulting':           [82, 84, 80, 76, 74, 65, 30, 28, 72, 80, 62, 28],
  'Real Estate':          [68, 72, 82, 86, 84, 80, 60, 55, 80, 78, 62, 40],
  'Healthcare':           [75, 78, 76, 72, 70, 68, 55, 50, 72, 76, 65, 55],
  'Energy':               [72, 74, 78, 80, 78, 72, 45, 42, 76, 78, 62, 38],
  'Payments':             [76, 80, 80, 78, 76, 70, 45, 42, 74, 80, 64, 35],
  'Wealth Management':    [86, 88, 82, 72, 74, 62, 22, 18, 70, 84, 56, 20],
  'default':              [78, 80, 80, 76, 74, 66, 35, 32, 70, 78, 58, 30],
};

// ─── Normalise a raw trends timeline to 12 monthly avg values (0-100) ─────────

function timelineToMonthly(timelineData, targetYear) {
  // timelineData: array of { time: 'YYYY-MM-DD', value: [number] }
  const monthly = new Array(12).fill(null).map(() => []);

  for (const point of timelineData) {
    const d = new Date(point.time);
    if (targetYear && d.getFullYear() !== targetYear) continue;
    const month = d.getMonth(); // 0-11
    const val   = Array.isArray(point.value) ? point.value[0] : point.value;
    if (typeof val === 'number') monthly[month].push(val);
  }

  // Average each month; fill missing with linear interpolation
  const averaged = monthly.map(arr =>
    arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null
  );

  // Fill nulls by interpolating from neighbours
  for (let i = 0; i < 12; i++) {
    if (averaged[i] === null) {
      const prev = averaged[(i + 11) % 12] ?? 50;
      const next = averaged[(i + 1)  % 12] ?? 50;
      averaged[i] = Math.round((prev + next) / 2);
    }
  }

  // Normalise to 0-100
  const max = Math.max(...averaged);
  const min = Math.min(...averaged);
  const range = max - min || 1;
  return averaged.map(v => Math.round(((v - min) / range) * 85 + 10)); // 10-95 range feels right
}

// ─── Fetch from Google Trends ─────────────────────────────────────────────────

async function fetchFromTrends(industry, location = 'NL') {
  const keyword = INDUSTRY_TERMS[industry] || `${industry.toLowerCase()} consultant`;

  // Last 2 years monthly data
  const now   = new Date();
  const start = new Date(now);
  start.setFullYear(start.getFullYear() - 2);

  const geo = location === 'GB' ? 'GB' : location === 'BE' ? 'BE' : 'NL'; // default NL

  const result = await googleTrends.interestOverTime({
    keyword,
    startTime: start,
    endTime:   now,
    geo,
  });

  const parsed = JSON.parse(result);
  const timeline = parsed?.default?.timelineData || [];

  if (!timeline.length) return null;

  // Use last 12 months of data (most recent year)
  const recentYear = new Date().getFullYear() - 1; // last full calendar year
  const data = timelineToMonthly(timeline, recentYear)
    || timelineToMonthly(timeline, null); // fallback: all data

  return {
    industry,
    location,
    months: MONTHS,
    data,
    source: 'google_trends',
    keyword,
    peak: _topMonths(data, 3, true),
    slow: _topMonths(data, 3, false),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * getSeasonality(industry, location, db)
 *
 * @param {string} industry   — e.g. 'Asset Management'
 * @param {string} location   — ISO country code, default 'NL'
 * @param {object} db         — db module (for cache reads/writes)
 * @returns {object}          — { industry, location, months, data, peak, slow, source, fresh }
 */
async function getSeasonality(industry, location = 'NL', dbModule = null) {
  const industryKey = industry || 'default';

  // 1. DB cache
  if (dbModule) {
    const cached = dbModule.seasonCache.get(industryKey, location);
    if (cached) {
      return { ...cached.data, source: cached.source, fresh: false };
    }
  }

  // 2. Google Trends
  try {
    const liveData = await fetchFromTrends(industryKey, location);
    if (liveData) {
      if (dbModule) dbModule.seasonCache.set(industryKey, location, liveData, 'google_trends');
      return { ...liveData, fresh: true };
    }
  } catch (e) {
    console.warn(`[seasonality] Google Trends failed for "${industryKey}":`, e.message?.slice(0, 80));
  }

  // 3. Fallback to embedded presets
  const fallbackData = FALLBACK_PRESETS[industryKey] || FALLBACK_PRESETS.default;
  const result = {
    industry:  industryKey,
    location,
    months:    MONTHS,
    data:      fallbackData,
    source:    'preset',
    fresh:     false,
    peak:      _topMonths(fallbackData, 3, true),
    slow:      _topMonths(fallbackData, 3, false),
  };

  // Cache the fallback for 24h (shorter TTL since it's not live)
  if (dbModule) {
    const now = Math.floor(Date.now() / 1000);
    const ttl = 24 * 3600;
    dbModule.run(
      `INSERT INTO season_cache (industry_key, location, data, source, scraped_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(industry_key, location) DO UPDATE SET data=excluded.data,
         source=excluded.source, scraped_at=excluded.scraped_at, expires_at=excluded.expires_at`,
      [industryKey, location, JSON.stringify(result), 'preset', now, now + ttl]
    );
  }

  return result;
}

/**
 * getAllAvailable() — returns list of all supported industry names
 */
function getAllAvailable() {
  return Object.keys(FALLBACK_PRESETS).filter(k => k !== 'default');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _topMonths(data, n, highest) {
  const indexed = data.map((v, i) => ({ m: MONTHS[i], v }));
  indexed.sort((a, b) => highest ? b.v - a.v : a.v - b.v);
  return indexed.slice(0, n).map(x => x.m);
}

module.exports = { getSeasonality, getAllAvailable, FALLBACK_PRESETS, MONTHS };
