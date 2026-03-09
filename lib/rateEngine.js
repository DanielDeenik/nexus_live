/**
 * lib/rateEngine.js — Dynamic rate benchmarking from live job board data
 *
 * Sources (in priority order):
 *   1. DB cache (7-day TTL)
 *   2. Scrape eFinancialCareers RSS (contract roles in finance/tech)
 *   3. Scrape Indeed job feed (broader market)
 *   4. Fallback: seniority × industry multiplier table
 *
 * Outputs day rates in EUR. Converts GBP × 1.17, USD × 0.92.
 *
 * Returns: {
 *   skillKey,          — normalised cache key
 *   currency: 'EUR',
 *   daily_low,         — 10th percentile
 *   daily_mid,         — 50th percentile (recommended)
 *   daily_high,        — 90th percentile
 *   sources[],         — which sources contributed
 *   confidence,        — 0-100 (higher = more data points)
 *   sampleSize,        — number of job listings parsed
 *   fresh,             — true if from live scrape
 * }
 */

const https    = require('https');
const cheerio  = require('cheerio');

// ─── FX rates (approximate; refreshed daily via a lightweight endpoint) ────────

let FX = { GBP: 1.17, USD: 0.92, EUR: 1.00 };

async function refreshFX() {
  try {
    // Use European Central Bank public API
    const data = await fetchText('https://api.frankfurter.app/latest?from=EUR&to=GBP,USD');
    const json = JSON.parse(data);
    if (json?.rates) {
      FX.GBP = +(1 / json.rates.GBP).toFixed(4);
      FX.USD = +(1 / json.rates.USD).toFixed(4);
    }
  } catch { /* keep last known rates */ }
}
refreshFX(); // run once at startup
setInterval(refreshFX, 24 * 3600 * 1000); // refresh daily

function toEUR(amount, currency = 'EUR') {
  const factor = FX[currency.toUpperCase()] || 1;
  return Math.round(amount * factor);
}

// ─── Fallback rate table (EUR/day) ───────────────────────────────────────────
// seniority × industry multiplier

const BASE_RATES = {
  'Junior':     { low: 300, mid: 375, high: 450 },
  'Mid':        { low: 425, mid: 525, high: 625 },
  'Mid-Senior': { low: 550, mid: 675, high: 800 },
  'Senior':     { low: 700, mid: 850, high: 1000 },
  'Director':   { low: 875, mid: 1075, high: 1275 },
  'Executive':  { low: 1000, mid: 1250, high: 1500 },
};

const INDUSTRY_MULTIPLIERS = {
  'Investment Banking': 1.25,
  'Asset Management':   1.20,
  'Banking':            1.10,
  'Risk & Compliance':  1.10,
  'FinTech':            1.15,
  'Payments':           1.10,
  'Wealth Management':  1.15,
  'Technology':         1.05,
  'Data & Analytics':   1.10,
  'Consulting':         1.00,
  'Healthcare':         0.90,
  'Energy':             0.95,
  'Real Estate':        0.90,
  'default':            1.00,
};

const SKILLS_PREMIUM = {
  // High-value system skills add a flat day-rate premium
  'SimCorp Dimension':   150,
  'Aladdin':             140,
  'Murex':               160,
  'Bloomberg Terminal':  100,
  'SWIFT':                80,
  'FIS':                  80,
  'Calypso':             130,
  'FactSet':              80,
  'Temenos':             100,
  'Salesforce':           60,
  'SAP':                  70,
};

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function fetchText(url, maxMs = 8000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), maxMs);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusBot/1.0)' } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { clearTimeout(timeout); resolve(body); });
      res.on('error', e => { clearTimeout(timeout); reject(e); });
    }).on('error', e => { clearTimeout(timeout); reject(e); });
  });
}

// ─── Rate extraction regex ────────────────────────────────────────────────────

const RATE_PATTERNS = [
  // "£600 per day", "€750/day", "$650 p/d", "600 GBP daily"
  /[£€$](\d{3,4})\s*(?:per\s*day|\/day|p\/d|daily|pd\b)/gi,
  /(\d{3,4})\s*(?:GBP|EUR|USD|£|€)\s*(?:per\s*day|\/day|p\/d|daily|pd\b)/gi,
  // "day rate: £600", "daily rate: €750"
  /day\s*rate[:\s]+[£€$]?(\d{3,4})/gi,
  // "inside IR35 £550 per day"
  /(?:inside|outside)\s+IR35[^£€$]*[£€$](\d{3,4})/gi,
  // Salary ranges with "contract" — use to estimate day rate (÷ 220)
  /(?:contract[^£€$]*)[£€$](\d{4,6})\s*(?:pa|p\.a\.|per\s*annum|annually)/gi,
];

function extractRates(text) {
  const rates = [];
  const clean = text.replace(/,/g, '').replace(/\s+/g, ' ');

  for (const pattern of RATE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(clean)) !== null) {
      let val = parseInt(match[1], 10);
      // If it looks like annual salary, convert to day rate
      if (val > 2000) val = Math.round(val / 220);
      // Reasonable day rate range: €200-€2500
      if (val >= 200 && val <= 2500) rates.push(val);
    }
  }
  return rates;
}

function detectCurrency(text) {
  if (/£/.test(text)) return 'GBP';
  if (/\$/.test(text)) return 'USD';
  return 'EUR';
}

// ─── eFinancialCareers RSS feed scraper ──────────────────────────────────────

async function scrapeEFC(keywords, location = 'NL') {
  const geoMap = { NL: 'netherlands', BE: 'belgium', GB: 'united-kingdom', IE: 'ireland', LU: 'luxembourg' };
  const geo    = geoMap[location] || 'netherlands';
  const q      = encodeURIComponent(keywords.slice(0, 3).join(' '));

  // eFC contract/interim RSS
  const url = `https://www.efinancialcareers.com/search/jobs?query=${q}&location=${geo}&contract=true&format=rss`;

  const xml  = await fetchText(url, 8000);
  const $    = cheerio.load(xml, { xmlMode: true });
  const items = [];

  $('item').each((_, el) => {
    const title       = $(el).find('title').text();
    const description = $(el).find('description').text();
    const combined    = `${title} ${description}`;
    const currency    = detectCurrency(combined);
    const rawRates    = extractRates(combined);
    const eurRates    = rawRates.map(r => toEUR(r, currency));
    if (eurRates.length) items.push(...eurRates);
  });

  return items;
}

// ─── Indeed RSS feed scraper ──────────────────────────────────────────────────

async function scrapeIndeed(keywords, location = 'NL') {
  const locMap = { NL: 'nl', BE: 'be', GB: 'co.uk', IE: 'ie', LU: 'lu' };
  const tld    = locMap[location] || 'nl';
  const q      = encodeURIComponent(`${keywords.slice(0, 2).join(' ')} contract`);

  const url = `https://www.indeed.${tld}/rss?q=${q}&sort=date`;
  const xml  = await fetchText(url, 8000);
  const $    = cheerio.load(xml, { xmlMode: true });
  const items = [];

  $('item').each((_, el) => {
    const title       = $(el).find('title').text();
    const description = $(el).find('description').text();
    const combined    = `${title} ${description}`;
    const currency    = detectCurrency(combined);
    const rawRates    = extractRates(combined);
    const eurRates    = rawRates.map(r => toEUR(r, currency));
    if (eurRates.length) items.push(...eurRates);
  });

  return items;
}

// ─── Compute percentiles from rate array ──────────────────────────────────────

function percentiles(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const p = pct => sorted[Math.min(Math.floor(sorted.length * pct), sorted.length - 1)];
  return {
    low:  p(0.10),
    mid:  p(0.50),
    high: p(0.90),
  };
}

// ─── Normalise skill key ──────────────────────────────────────────────────────

function buildSkillKey(skills = [], seniority = 'Senior', industry = 'default') {
  const topSkill = (skills[0] || '').toLowerCase().replace(/\s+/g, '_').slice(0, 30);
  const ind      = (industry || 'default').toLowerCase().replace(/\s+/g, '_').slice(0, 20);
  const sen      = (seniority || 'Senior').toLowerCase();
  return `${topSkill}|${sen}|${ind}`;
}

// ─── Skill premium calculation ────────────────────────────────────────────────

function calcSkillPremium(skills = []) {
  let premium = 0;
  for (const skill of skills) {
    for (const [name, bonus] of Object.entries(SKILLS_PREMIUM)) {
      if (skill.toLowerCase().includes(name.toLowerCase())) {
        premium = Math.max(premium, bonus); // take highest matching premium
        break;
      }
    }
  }
  return premium;
}

// ─── Main public API ──────────────────────────────────────────────────────────

/**
 * getRates({ skills, seniority, industry, location, db })
 *
 * Returns market rate benchmarks for the given profile.
 */
async function getRates({ skills = [], seniority = 'Senior', industry = 'default', location = 'NL', db: dbModule = null } = {}) {
  const skillKey = buildSkillKey(skills, seniority, industry);
  const currency = 'EUR';

  // 1. DB cache
  if (dbModule) {
    const cached = dbModule.rateCache.get(skillKey, currency);
    if (cached) {
      return {
        skillKey,
        currency,
        daily_low:  cached.daily_low,
        daily_mid:  cached.daily_mid,
        daily_high: cached.daily_high,
        sources:    JSON.parse(cached.sources || '[]'),
        confidence: 80,
        sampleSize: 0,
        fresh:      false,
      };
    }
  }

  // 2. Live scrape
  const allRates = [];
  const sources  = [];

  const searchKeywords = [
    ...(skills.slice(0, 2)),
    seniority,
    industry !== 'default' ? industry : '',
    'contract',
  ].filter(Boolean);

  try {
    const efcRates = await scrapeEFC(searchKeywords, location);
    if (efcRates.length) { allRates.push(...efcRates); sources.push('eFinancialCareers'); }
  } catch (e) {
    console.warn('[rateEngine] eFC scrape failed:', e.message?.slice(0, 60));
  }

  try {
    const indeedRates = await scrapeIndeed(searchKeywords, location);
    if (indeedRates.length) { allRates.push(...indeedRates); sources.push('Indeed'); }
  } catch (e) {
    console.warn('[rateEngine] Indeed scrape failed:', e.message?.slice(0, 60));
  }

  // 3. If we got live data, compute percentiles
  let low, mid, high, confidence;

  if (allRates.length >= 3) {
    const p  = percentiles(allRates);
    low  = p.low;
    mid  = p.mid;
    high = p.high;
    confidence = Math.min(100, 40 + allRates.length * 3);
  } else {
    // 4. Fallback: seniority table + industry multiplier + skill premium
    const base = BASE_RATES[seniority] || BASE_RATES['Senior'];
    const mult = INDUSTRY_MULTIPLIERS[industry] || INDUSTRY_MULTIPLIERS.default;
    const prem = calcSkillPremium(skills);

    low  = Math.round(base.low  * mult) + prem;
    mid  = Math.round(base.mid  * mult) + prem;
    high = Math.round(base.high * mult) + prem;
    confidence = 30; // low — fallback only
    sources.push('benchmark_table');
  }

  const result = { skillKey, currency, daily_low: low, daily_mid: mid, daily_high: high, sources, confidence, sampleSize: allRates.length, fresh: allRates.length > 0 };

  // Cache result
  if (dbModule) {
    dbModule.rateCache.set(skillKey, { currency, daily_low: low, daily_mid: mid, daily_high: high, sources });
  }

  return result;
}

/**
 * recommendRate(profile, marketRates)
 *
 * Given user's existing rate hints from their SOW/CV, blend with market data
 * to produce a final recommendation.
 */
function recommendRate(profile, marketRates) {
  const { rateHints = [], yearsExperience = 5 } = profile;

  // Extract numeric day rates from hints
  const hintRates = [];
  for (const hint of rateHints) {
    const nums = (hint.toString().match(/\d{3,4}/g) || []).map(Number);
    hintRates.push(...nums.filter(n => n >= 200 && n <= 2500));
  }

  const experienceBonus = Math.min(yearsExperience * 5, 100); // max +€100/day for experience

  if (!hintRates.length) {
    // No historical data — pure market benchmark
    return {
      recommended: marketRates.daily_mid + experienceBonus,
      range: { low: marketRates.daily_low, high: marketRates.daily_high },
      basis: 'market',
      marketMid: marketRates.daily_mid,
    };
  }

  const hintMid = Math.round(hintRates.reduce((s, v) => s + v, 0) / hintRates.length);
  const blended = Math.round((hintMid * 0.4 + marketRates.daily_mid * 0.6) + experienceBonus);

  return {
    recommended: blended,
    range: {
      low:  Math.min(hintMid, marketRates.daily_low),
      high: Math.max(hintMid, marketRates.daily_high),
    },
    basis:     'blended',
    hintMid,
    marketMid: marketRates.daily_mid,
  };
}

module.exports = { getRates, recommendRate, buildSkillKey, BASE_RATES, INDUSTRY_MULTIPLIERS };
