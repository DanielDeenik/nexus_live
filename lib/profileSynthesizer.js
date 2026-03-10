'use strict';
/**
 * lib/profileSynthesizer.js — Multi-source professional profile synthesizer
 *
 * Merges data from up to FOUR sources:
 *   1. LinkedIn OpenID Connect (name, headline, location, email)
 *   2. CV / LinkedIn PDF (skills, industries, years exp, job titles)
 *   3. SOW / contract PDFs (services, deliverables, keywords, client types)
 *   4. Cowork saved/scheduled search imports (query terms, discovered industries)
 *
 * Outputs a unified SearchProfile used to:
 *   a) Show the user a "Is this you?" confirmation card
 *   b) Generate daily market intelligence search filters
 *   c) Score inbound signals for relevance
 *   d) Auto-select seasonality preset with 1-click confirm
 *
 * The "profile confidence" score (0-100) is tied to actionable value:
 *   - <40  : Ask for more data (show completeness nudge)
 *   - 40-70 : Profile usable, signal quality moderate
 *   - 70+  : High-quality signals, seasonality auto-applied
 *
 * Exported:
 *   synthesize(linkedin, cv, sow[])          → SearchProfile
 *   generateSearchFilters(profile)           → SearchFilters
 *   scoreSignal(signal, profile)             → number 0-100
 *   mergeSearchImport(profile, searches[])   → SearchProfile (enriched)
 *   getSeasonalityPreset(profile)            → { industry, data[], peak[], slow[] }
 *   ACTIONABLE_GAPS(profile)                 → string[] (human-readable missing items)
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
  // Name: prefer full display name; construct from given+family if absent
  const name = li.name
    || (li.given_name && li.family_name ? `${li.given_name} ${li.family_name}` : null)
    || li.given_name
    || c.name
    || null;
  // Headline: LinkedIn "headline" is a non-standard OpenID extension; also check job_title
  const headline = li.headline || li.job_title || c.headline || null;
  const email    = li.email    || c.email    || null;
  const location = li.location || li.country || c.location || null;
  const picture  = li.picture  || null;
  // Summary: LinkedIn "about" section, plus "summary" field from CSV export
  const summary  = li.about || li.summary || c.summary || null;

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
  // Weighted scoring — mimics LinkedIn/Upwork profile strength algorithm
  const completenessWeights = [
    [name,                    20],   // identity
    [headline,                15],   // title
    [summary,                 15],   // summary/bio
    [skills.length >= 3,      15],   // skills (need ≥3)
    [industries.length > 0,   10],   // industries
    [workHistory.length > 0,  10],   // work history
    [location,                10],   // location
    [email,                    5],   // email
  ];
  const confidence = Math.round(
    completenessWeights.reduce((sum, [val, w]) => sum + (val ? w : 0), 0)
  );

  // ── Sources summary ───────────────────────────────────────────────────────
  const sources = [];
  if (li.name || li.given_name || liPositions.length > 0) sources.push(liIsExport ? 'LinkedIn Export' : 'LinkedIn');
  if (c.name || c.skills?.length)        sources.push('CV');
  if (sows.length > 0)    sources.push(`${sows.length} contract${sows.length > 1 ? 's' : ''}`);

  return {
    // Identity
    name, headline, email, location, picture, summary,

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

// ── Seasonality presets (mirrors onboard.js SEASONALITY table) ──────────────
// Subset of industry → 12-month demand index (Jan–Dec, 0-100).
// Kept lean here — full table lives in routes/onboard.js.
// This allows the profile synthesizer to suggest a preset without an HTTP roundtrip.

const SEASON_PRESETS = {
  'Asset Management':       [88, 90, 82, 70, 75, 65, 22, 18, 72, 85, 55, 20],
  'Capital Markets':        [85, 88, 82, 72, 75, 65, 20, 16, 70, 84, 54, 18],
  'Banking':                [80, 85, 78, 72, 70, 65, 28, 22, 68, 80, 55, 22],
  'FinTech':                [78, 82, 80, 78, 76, 70, 45, 40, 72, 80, 62, 30],
  'Compliance & Regulatory':[82, 85, 80, 75, 72, 65, 30, 25, 70, 80, 55, 25],
  'Management Consulting':  [80, 82, 78, 75, 72, 65, 30, 25, 70, 80, 55, 25],
  'Professional Services':  [78, 80, 78, 75, 72, 65, 32, 28, 70, 78, 55, 28],
  'Software Engineering':   [80, 82, 80, 78, 76, 72, 50, 45, 74, 80, 65, 35],
  'AI / Machine Learning':  [82, 85, 82, 80, 78, 74, 55, 50, 76, 82, 68, 38],
  'Data & Analytics':       [80, 82, 80, 78, 76, 70, 50, 45, 74, 80, 65, 35],
  'Cybersecurity':          [80, 82, 80, 78, 76, 72, 52, 48, 76, 82, 65, 35],
  'IT Consulting':          [78, 80, 78, 75, 72, 65, 40, 35, 72, 78, 60, 30],
  'Digital Marketing':      [75, 78, 82, 80, 78, 72, 40, 38, 78, 82, 65, 35],
  'Legal':                  [82, 85, 80, 75, 72, 65, 30, 25, 70, 80, 58, 28],
  'Healthcare':             [78, 80, 80, 78, 75, 68, 40, 38, 72, 78, 60, 32],
  'default':                [78, 80, 80, 76, 74, 66, 35, 32, 70, 78, 58, 30],
};

const SEASON_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Get the best seasonality preset for a profile.
 * Returns the preset data immediately — no HTTP call needed.
 *
 * @param {object} profile — from synthesize()
 * @returns {{ industry:string, data:number[], peak:string[], slow:string[] }}
 */
function getSeasonalityPreset(profile) {
  const industries = profile.industries || [];
  let matchedInd = 'default';
  let data = SEASON_PRESETS.default;

  for (const ind of industries) {
    if (SEASON_PRESETS[ind]) {
      matchedInd = ind;
      data = SEASON_PRESETS[ind];
      break;
    }
  }

  const indexed = data.map((val, i) => ({ month: SEASON_MONTHS[i], val }));
  const sorted  = [...indexed].sort((a, b) => b.val - a.val);
  return {
    industry: matchedInd,
    data,
    months:   SEASON_MONTHS,
    peak:     sorted.slice(0, 3).map(m => m.month),
    slow:     sorted.slice(-3).map(m => m.month),
    isDefault: matchedInd === 'default',
  };
}

// ── Actionable gaps ───────────────────────────────────────────────────────────
/**
 * Returns human-readable descriptions of what's missing from the profile,
 * ordered by impact on forecast/signal quality.
 *
 * @param {object} profile — from synthesize()
 * @returns {string[]} e.g. ["Add 2+ contract PDFs to extract your service keywords",...]
 */
function getActionableGaps(profile) {
  const gaps = [];
  if (!profile.skills || profile.skills.length < 3)
    gaps.push('Add at least 3 skills to sharpen market signal matching');
  if (!profile.industries || profile.industries.length === 0)
    gaps.push('Select your primary industry to unlock seasonality presets');
  if (!profile.sowKeywords || profile.sowKeywords.length === 0)
    gaps.push('Upload a contract or SOW to extract your service keywords');
  if (!profile.yearsExperience)
    gaps.push('Add years of experience to improve seniority-based signal scoring');
  if (!profile.location)
    gaps.push('Add your location to get geo-targeted market intelligence');
  if (!profile.headline)
    gaps.push('Add a professional headline so Nexus can refine your search terms');
  return gaps;
}

// ── Cowork search import ──────────────────────────────────────────────────────
/**
 * Merge a batch of Cowork saved/scheduled search results into an existing profile.
 *
 * Called by POST /api/profile/import-searches.
 *
 * Each search object has shape:
 *   {
 *     query:    string,          — the search query string
 *     industry: string|null,    — optional forced industry tag
 *     results:  [               — array of discovered results
 *       { title, company, url, snippet, tags:string[] }
 *     ]
 *   }
 *
 * Extraction logic:
 *   1. Parse query terms → add to sowKeywords (de-duped)
 *   2. Map industry tags → add to profile.industries
 *   3. Extract company names → add to profile.clientTypes (for signal targeting)
 *   4. Extract tech/skill mentions from snippets → add to skills
 *   5. Recalculate confidence
 *
 * @param {object}   profile  — existing SearchProfile from synthesize()
 * @param {object[]} searches — array of search objects as above
 * @returns {SearchProfile} updated profile (new object, not mutated)
 */
function mergeSearchImport(profile, searches = []) {
  if (!searches || searches.length === 0) return profile;

  const newKeywords  = [];
  const newIndustries= [];
  const newClients   = [];
  const newSkills    = [];

  // Skill-like tokens to detect in snippets
  const SKILL_PATTERNS = [
    /\b(python|typescript|javascript|java|c\+\+|golang|rust|scala|sql|r\b)\b/gi,
    /\b(simcorp|aladdin|murex|bloomberg terminal|salesforce|servicenow|sap|oracle|workday)\b/gi,
    /\b(aws|azure|gcp|kubernetes|docker|terraform|kafka|spark|databricks|snowflake)\b/gi,
    /\b(react|angular|vue|node\.?js|django|flask|spring|\.net|fastapi)\b/gi,
    /\b(power bi|tableau|looker|qlik|metabase|grafana|dbt|airflow|prefect)\b/gi,
  ];

  for (const search of searches) {
    // 1. Query terms → keywords
    if (search.query) {
      // Tokenise query into 1-3 word phrases, skip stopwords
      const tokens = search.query
        .replace(/["""'()]/g, ' ')
        .split(/[\s,]+/)
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length > 2 && !/^(and|or|not|the|for|in|at|of|a|an|with|by|to)$/.test(t));
      newKeywords.push(...tokens);

      // Extract quoted phrases as-is
      const phrases = (search.query.match(/[""]([^""]+)[""]/g) || [])
        .map(p => p.replace(/[""]/g, '').trim().toLowerCase())
        .filter(p => p.length > 3);
      newKeywords.push(...phrases);
    }

    // 2. Explicit industry tag
    if (search.industry) newIndustries.push(search.industry);

    // 3. Results: companies + snippets
    for (const result of (search.results || [])) {
      // Company names → client types
      if (result.company && result.company.length > 1) {
        newClients.push(result.company.trim());
      }

      // Tags (explicit labels from Cowork)
      if (result.tags) {
        for (const tag of result.tags) {
          if (tag) newKeywords.push(tag.toLowerCase().trim());
        }
      }

      // Skill extraction from snippets
      const text = `${result.title || ''} ${result.snippet || ''}`;
      for (const pattern of SKILL_PATTERNS) {
        const matches = text.match(pattern) || [];
        for (const m of matches) {
          newSkills.push(m.trim());
        }
      }
    }
  }

  // Build updated profile (immutable — return new object)
  const updatedProfile = {
    ...profile,
    sowKeywords:    dedupInsensitive([...(profile.sowKeywords || []), ...newKeywords]).slice(0, 40),
    industries:     mergeIndustries(profile.industries || [], newIndustries),
    clientTypes:    dedup([...(profile.clientTypes || []), ...newClients]).slice(0, 20),
    skills:         dedupInsensitive([...(profile.skills || []), ...newSkills]).slice(0, 30),
    // Track that this profile has been enriched with search imports
    searchImports:  (profile.searchImports || 0) + searches.length,
    lastImportAt:   new Date().toISOString(),
  };

  // Recalculate confidence
  const fields = [
    updatedProfile.name,
    updatedProfile.headline,
    updatedProfile.email,
    updatedProfile.location,
    updatedProfile.skills.length > 0,
    updatedProfile.industries.length > 0,
    updatedProfile.sowKeywords.length > 0,
    updatedProfile.yearsExperience,
  ];
  updatedProfile.confidence = Math.round(fields.filter(Boolean).length / fields.length * 100);

  return updatedProfile;
}

module.exports = {
  synthesize,
  generateSearchFilters,
  scoreSignal,
  scoreTier,
  mergeSearchImport,
  getSeasonalityPreset,
  getActionableGaps,
  SIGNAL_TYPES,
};
