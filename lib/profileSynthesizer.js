'use strict';
/**
 * lib/profileSynthesizer.js — Multi-source professional profile synthesizer
 *
 * Merges data from three sources:
 *   1. LinkedIn OpenID Connect (name, headline, location, email)
 *   2. CV / LinkedIn PDF (skills, industries, years exp, job titles)
 *   3. SOW / contract PDFs (services, deliverables, keywords, client types)
 *
 * Outputs a unified SearchProfile used to:
 *   a) Show the user a "Is this you?" confirmation card
 *   b) Generate daily market intelligence search filters
 *   c) Score inbound signals for relevance
 *
 * The "profile confidence" score (0-100) drives:
 *   - How many manual fields to ask for in human-in-the-loop step
 *   - How specific the generated search filters can be
 *
 * Exported:
 *   synthesize(linkedin, cv, sow[])  → SearchProfile
 *   generateSearchFilters(profile)   → SearchFilters
 *   scoreSignal(signal, profile)     → number 0-100
 */

// ── Dedup helper ──────────────────────────────────────────────────────────────
function dedup(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function dedupInsensitive(arr) {
  const seen = new Set();
  return (arr || []).filter(s => {
    const k = s.toLowerCase().trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── Keyword merging ───────────────────────────────────────────────────────────
// Given multiple keyword arrays (from CV, SOW, LinkedIn), merge them and
// rank by frequency across sources — terms appearing in 2+ sources score higher.

function mergeKeywords(...arrays) {
  const freq = new Map();
  for (const arr of arrays) {
    for (const term of (arr || [])) {
      const k = term.toLowerCase().trim();
      if (k.length < 2) continue;
      freq.set(k, (freq.get(k) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([k]) => k);
}

// ── Industry consolidation ─────────────────────────────────────────────────────
// Ensure no duplicates and map close synonyms to canonical labels.

const INDUSTRY_SYNONYMS = {
  'Fund Operations':   'Asset Management',
  'Fund Management':   'Asset Management',
  'Investment Funds':  'Asset Management',
  'Buyside':           'Asset Management',
  'Sellside':          'Capital Markets',
  'Investment Banking':'Capital Markets',
  'Regulatory Affairs':'Compliance & Regulatory',
  'Risk Management':   'Compliance & Regulatory',
  'SimCorp':           'Asset Management',  // common system → implies AM vertical
};

function canonicalizeIndustry(ind) {
  return INDUSTRY_SYNONYMS[ind] || ind;
}

function mergeIndustries(...arrays) {
  const seen = new Set();
  const result = [];
  for (const arr of arrays) {
    for (const ind of (arr || [])) {
      const canonical = canonicalizeIndustry(ind);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        result.push(canonical);
      }
    }
  }
  return result;
}

// ── Seniority inference ───────────────────────────────────────────────────────

function inferSeniority(headline, yearsExp) {
  if (!headline && !yearsExp) return null;
  const h = (headline || '').toLowerCase();
  if (/\b(?:vp|vice\s+president|managing\s+director|c[eooft]o?)\b/.test(h)) return 'Executive';
  if (/\b(?:head\s+of|director|principal|partner)\b/.test(h)) return 'Director';
  if (/\b(?:senior|lead|staff|sr\.?)\b/.test(h)) return 'Senior';
  if (/\b(?:junior|graduate|trainee|entry)\b/.test(h)) return 'Junior';
  if (yearsExp) {
    if (yearsExp >= 15) return 'Senior';
    if (yearsExp >= 8)  return 'Mid-Senior';
    if (yearsExp >= 3)  return 'Mid';
    return 'Junior';
  }
  return 'Mid-Senior';
}

// ── Company size inference ─────────────────────────────────────────────────────
// Based on client types from SOW

function inferCompanySize(clientTypes) {
  if (!clientTypes?.length) return ['Mid-Market', 'Enterprise'];
  const hasEnterprise = clientTypes.some(t =>
    /bank|pension|insurance|asset\s+manager|private\s+equity/i.test(t));
  const hasMid = clientTypes.some(t =>
    /fintech|consultancy|technology/i.test(t));
  if (hasEnterprise) return ['Enterprise', 'Mid-Market'];
  if (hasMid)        return ['Mid-Market', 'SME'];
  return ['Mid-Market', 'Enterprise'];
}

// ── Search keyword generation ─────────────────────────────────────────────────
// Build high-signal search terms from the profile.

function buildSearchKeywords(profile) {
  const terms = new Set();

  // 1. Top skills (first 8)
  for (const s of (profile.skills || []).slice(0, 8)) terms.add(s);

  // 2. Industries (converted to search-friendly terms)
  for (const ind of (profile.industries || []).slice(0, 4)) {
    terms.add(ind);
    // Also add common abbreviations / synonyms for searches
    if (/asset\s+management/i.test(ind))   terms.add('fund operations');
    if (/compliance/i.test(ind))           terms.add('regulatory compliance');
    if (/capital\s+markets/i.test(ind))    terms.add('investment banking');
  }

  // 3. Services from SOW (convert to search terms by taking noun phrases)
  for (const svc of (profile.services || []).slice(0, 5)) {
    // Extract 2-3 word noun phrases from service descriptions
    const nouns = svc.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g);
    if (nouns) nouns.slice(0, 2).forEach(n => terms.add(n.toLowerCase()));
  }

  // 4. SOW keywords (already filtered/ranked)
  for (const kw of (profile.sowKeywords || []).slice(0, 6)) terms.add(kw);

  // 5. Headline keywords
  if (profile.headline) {
    const headlineWords = profile.headline
      .split(/[\s,\/\|]+/)
      .map(w => w.trim().toLowerCase())
      .filter(w => w.length > 3 && !/^(?:and|the|with|for|in|at|of)$/.test(w));
    headlineWords.slice(0, 4).forEach(w => terms.add(w));
  }

  return [...terms].filter(t => t.length > 2).slice(0, 20);
}

// ── Lead indicator signal types ───────────────────────────────────────────────

const SIGNAL_TYPES = {
  LEADERSHIP_CHANGE: 'Leadership change',    // new CTO/CIO = new projects incoming
  AD_SPEND_SPIKE:    'Ad spend spike',        // company ramping up = hiring budget
  TECH_PURCHASE:     'Tech/vendor purchase',  // new platform = needs impl. support
  REGULATORY:        'Regulatory deadline',   // compliance deadline = urgent hiring
  FUNDING:           'Funding round',         // raised $ = building team
  JOB_POSTING:       'Job posting',           // direct signal
  NEWS:              'Company news',          // general company intelligence
};

// ── Main: synthesize ──────────────────────────────────────────────────────────

// ── LinkedIn export helpers ───────────────────────────────────────────────────

/**
 * Parse a LinkedIn export date string like "Jul 2020" or "2020" → { year }
 */
function parseLinkedInDate(str) {
  if (!str || /present|current|now/i.test(str)) return null;
  const m = str.match(/\b(19[7-9]\d|20[0-3]\d)\b/);
  return m ? { year: parseInt(m[1], 10) } : null;
}

/**
 * Derive years-of-experience from LinkedIn export positions array.
 * Uses the earliest start year to current year.
 */
function deriveYearsFromLinkedInExport(positions) {
  if (!positions || positions.length === 0) return null;
  const years = positions
    .map(p => parseLinkedInDate(p.started)?.year)
    .filter(Boolean);
  if (!years.length) return null;
  const earliest = Math.min(...years);
  return Math.round(new Date().getFullYear() - earliest);
}

/**
 * Convert LinkedIn export positions[] to the standard workHistory format.
 */
function linkedInPositionsToWorkHistory(positions) {
  return positions
    .filter(p => p.company || p.title)
    .map(p => {
      const start  = parseLinkedInDate(p.started);
      const end    = parseLinkedInDate(p.finished);
      const isCurrent = !p.finished || /present|current|now/i.test(p.finished);
      const endYear   = isCurrent ? new Date().getFullYear() : end?.year || null;
      const durationMonths = (start?.year && endYear)
        ? Math.round((endYear - start.year) * 12)
        : null;
      return {
        company:        p.company      || '',
        title:          p.title        || '',
        startYear:      start?.year    || null,
        startMonth:     null,
        endYear:        endYear,
        endMonth:       null,
        isCurrent,
        durationMonths,
      };
    });
}

// ── Main: synthesize ──────────────────────────────────────────────────────────

/**
 * Merge data from all ingestion sources into a unified SearchProfile.
 *
 * @param {object|null} linkedin  — from LinkedIn OAuth or CSV export:
 *                                  OAuth:  { name, headline, email, picture, country }
 *                                  Export: { name, headline, location, skills[], positions[], _fromExport:true }
 * @param {object|null} cv        — from cvParser: { name, headline, email, skills, industries, yearsExperience, location }
 * @param {object[]}    sows      — array of parseSow() results (0 or more)
 * @returns {SearchProfile}
 */
function synthesize(linkedin, cv, sows = []) {
  const li = linkedin || {};
  const c  = cv      || {};

  // Detect LinkedIn data-export (CSV) vs basic OAuth
  const liIsExport  = li._fromExport === true;
  const liPositions = liIsExport ? (li.positions || []) : [];
  const liSkills    = liIsExport ? (li.skills    || []) : [];

  // ── Identity (LinkedIn first, CV fallback) ───────────────────────────────
  const name     = li.name     || c.name     || null;
  const headline = li.headline || c.headline || null;
  const email    = li.email    || c.email    || null;
  const location = li.location || li.country || c.location || null;
  const picture  = li.picture  || null;

  // ── Work history (CV primary; LinkedIn export as supplement/fallback) ────
  const cvWorkHistory = c.workHistory || [];
  const workHistory   = cvWorkHistory.length > 0
    ? cvWorkHistory
    : (liIsExport && liPositions.length > 0
        ? linkedInPositionsToWorkHistory(liPositions)
        : []);

  // ── Skills (CV primary + LinkedIn export supplement) ─────────────────────
  // If we have a LinkedIn export, merge its skills with CV skills (CV first)
  const skills = dedupInsensitive([...(c.skills || []), ...liSkills]);

  // ── Industries (merge CV industries + SOW-inferred verticals) ───────────
  const sowVerticals = sows.flatMap(s => s.verticals || []);
  const industries   = mergeIndustries(c.industries || [], sowVerticals);

  // ── SOW aggregate data ───────────────────────────────────────────────────
  const sowKeywords     = dedup(sows.flatMap(s => s.keywords    || []));
  const sowServices     = dedup(sows.flatMap(s => s.services    || []));
  const sowDeliverables = dedup(sows.flatMap(s => s.deliverables || []));
  const sowClientTypes  = dedup(sows.flatMap(s => s.verticals   || []));
  const sowSignals      = dedup(sows.flatMap(s => s.urgencySignals || []));
  const rateHints       = sows.map(s => s.rateHint).filter(Boolean);
  const durationHints   = sows.map(s => s.durationHint).filter(Boolean);

  // ── Inferred metadata ────────────────────────────────────────────────────
  // ── Years experience: CV primary, LinkedIn export as fallback ───────────
  const yearsExp = c.yearsExperience
    || (liIsExport ? deriveYearsFromLinkedInExport(liPositions) : null)
    || null;

  const seniority    = inferSeniority(headline, yearsExp);
  const companySizes = inferCompanySize(sowClientTypes);

  // ── Rate context ─────────────────────────────────────────────────────────
  // Prefer SOW duration hints; fall back to CV-derived average contract months
  const avgDuration = durationHints.length
    ? durationHints.reduce((a, v) => a + v, 0) / durationHints.length
    : c.avgContractMonths || null;

  // ── Confidence: how complete is the profile? ─────────────────────────────
  const fields = [name, headline, email, location,
    skills.length > 0, industries.length > 0,
    sowServices.length > 0, sowKeywords.length > 0];
  const confidence = Math.round(fields.filter(Boolean).length / fields.length * 100);

  // ── Sources summary ───────────────────────────────────────────────────────
  const sources = [];
  if (li.name || liPositions.length > 0) sources.push(liIsExport ? 'LinkedIn Export' : 'LinkedIn');
  if (c.name || c.skills?.length)        sources.push('CV');
  if (sows.length > 0)    sources.push(`${sows.length} contract${sows.length > 1 ? 's' : ''}`);

  return {
    // Identity
    name, headline, email, location, picture,

    // Professional profile
    skills,
    industries,
    seniority,
    yearsExperience: yearsExp,
    companySizes,
    workHistory,           // structured job positions from CV

    // From SOW/contracts
    services:      sowServices,
    deliverables:  sowDeliverables,
    sowKeywords,
    clientTypes:   sowClientTypes,
    urgencySignals: sowSignals,

    // Context
    avgContractDuration: avgDuration,
    rateHints,

    // Meta
    confidence,
    sources,
    createdAt: new Date().toISOString(),
  };
}

// ── Generate search filters ───────────────────────────────────────────────────

/**
 * From a synthesized profile, generate a set of daily search filters
 * used by the marketIntel worker to find leading indicators.
 *
 * @param {object} profile — from synthesize()
 * @returns {SearchFilters}
 */
function generateSearchFilters(profile) {
  const keywords     = buildSearchKeywords(profile);
  const industries   = (profile.industries || []).slice(0, 6);
  const clientTypes  = profile.clientTypes || [];
  const companySizes = profile.companySizes || ['Mid-Market', 'Enterprise'];

  // Geographic scope: default NL + REMOTE; widen if location says UK/US etc.
  const geos = ['Netherlands', 'Remote'];
  const loc = (profile.location || '').toLowerCase();
  if (/\buk\b|united\s+kingdom|london/.test(loc)) geos.unshift('United Kingdom');
  if (/\bus\b|united\s+states|new\s+york/.test(loc)) geos.push('United States');
  if (/\bde\b|germany|deutschland/.test(loc)) geos.push('Germany');

  // Build news search queries (for Google News RSS)
  const newsQueries = [];

  // Query 1: Leadership changes at target company types
  if (industries.length > 0) {
    const indList = industries.slice(0, 2).join(' OR ');
    newsQueries.push({
      type:   SIGNAL_TYPES.LEADERSHIP_CHANGE,
      query:  `(new CTO OR new CIO OR new CFO OR appointed) (${indList})`,
      weight: 30,
    });
  }

  // Query 2: Funding rounds at target verticals
  if (clientTypes.length > 0 || industries.length > 0) {
    const target = [...clientTypes, ...industries].slice(0, 2).join(' OR ');
    newsQueries.push({
      type:   SIGNAL_TYPES.FUNDING,
      query:  `(raises OR funded OR series A OR series B OR investment) (${target || 'fintech'})`,
      weight: 20,
    });
  }

  // Query 3: Tech/vendor purchases (platform migration signals)
  const techKeywords = keywords.filter(k =>
    /simcorp|aladdin|murex|bloomberg|salesforce|sap|oracle|workday|servicenow|microsoft|cloud/i.test(k)
  );
  if (techKeywords.length > 0) {
    newsQueries.push({
      type:   SIGNAL_TYPES.TECH_PURCHASE,
      query:  `(implements OR deploys OR adopts OR migrates) (${techKeywords.slice(0,3).join(' OR ')})`,
      weight: 25,
    });
  }

  // Query 4: Regulatory deadline signals
  const regKeywords = ['DORA', 'NIS2', 'ESG reporting', 'MiFID', 'AIFMD', 'UCITS', 'SFDR', 'GDPR'];
  newsQueries.push({
    type:   SIGNAL_TYPES.REGULATORY,
    query:  `(${regKeywords.slice(0,4).join(' OR ')}) (deadline OR compliance OR implementation OR 2025 OR 2026)`,
    weight: 20,
  });

  // Job search queries (extend existing jobFeed with profile-specific terms)
  const jobQueries = keywords.slice(0, 5).map(kw => ({
    keyword: kw,
    industries,
    geographies: geos,
  }));

  return {
    keywords,
    industries,
    geographies: geos,
    companySizes,
    clientTypes,
    newsQueries,
    jobQueries,
    generatedAt: new Date().toISOString(),
    profileConfidence: profile.confidence,
  };
}

// ── Score a signal against a profile ──────────────────────────────────────────

/**
 * Score how relevant a market signal is to this freelancer's profile.
 *
 * @param {object} signal  — { title, description, source, type, publishedAt }
 * @param {object} profile — from synthesize()
 * @returns {number} 0-100
 */
function scoreSignal(signal, profile) {
  if (!signal || !profile) return 0;

  const text  = `${signal.title || ''} ${signal.description || ''}`.toLowerCase();
  let score   = 0;

  // 1. Keyword matches (up to 40 pts)
  const searchKws = buildSearchKeywords(profile);
  const matchCount = searchKws.filter(kw => text.includes(kw.toLowerCase())).length;
  score += Math.min(40, matchCount * 8);

  // 2. Industry match (up to 25 pts)
  const profileInds = (profile.industries || []).map(i => i.toLowerCase());
  const indMatches  = profileInds.filter(ind => {
    const parts = ind.split(/[\s\/&]+/);
    return parts.some(p => p.length > 3 && text.includes(p));
  }).length;
  score += Math.min(25, indMatches * 12);

  // 3. Signal type bonus
  const signalTypeBonuses = {
    [SIGNAL_TYPES.LEADERSHIP_CHANGE]: 20,
    [SIGNAL_TYPES.FUNDING]:           18,
    [SIGNAL_TYPES.TECH_PURCHASE]:     16,
    [SIGNAL_TYPES.REGULATORY]:        14,
    [SIGNAL_TYPES.AD_SPEND_SPIKE]:    12,
    [SIGNAL_TYPES.JOB_POSTING]:       8,
    [SIGNAL_TYPES.NEWS]:              5,
  };
  score += signalTypeBonuses[signal.type] || 5;

  // 4. Recency bonus (up to 10 pts)
  if (signal.publishedAt) {
    const ageMs   = Date.now() - new Date(signal.publishedAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 2)  score += 10;
    else if (ageDays < 7)  score += 7;
    else if (ageDays < 14) score += 4;
    else if (ageDays < 30) score += 1;
  }

  return Math.min(100, Math.round(score));
}

// ── Tier mapping ─────────────────────────────────────────────────────────────
function scoreTier(score) {
  if (score >= 75) return 'HOT';
  if (score >= 50) return 'WARM';
  if (score >= 25) return 'MONITOR';
  return 'COLD';
}

module.exports = {
  synthesize,
  generateSearchFilters,
  scoreSignal,
  scoreTier,
  SIGNAL_TYPES,
};
