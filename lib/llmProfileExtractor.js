'use strict';
/**
 * lib/llmProfileExtractor.js — LLM-powered professional profile extractor
 *
 * Uses Claude (Haiku) to intelligently parse raw CV/LinkedIn text and return
 * a comprehensive, structured professional profile.
 *
 * First principles design:
 *   1. LLMs understand context — "worked at PIMCO" → Asset Management
 *   2. Skills should be tiered by emphasis, not just listed
 *   3. Services (what you sell) are different from skills (what you know)
 *   4. Industries should be inferred from company names + project context
 *   5. Education, certifications, languages matter for matching
 *   6. Work preferences are critical for filtering opportunities
 *
 * Falls back to regex (cvParser.js) if ANTHROPIC_API_KEY not set.
 *
 * Environment: ANTHROPIC_API_KEY
 * Model: claude-haiku-4-5-20251001 (fast, cost-effective for extraction)
 *
 * Returns: RichProfile — comprehensive schema covering all professional fields
 */

const https = require('https');

const MODEL      = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 4096;
// Truncate CV text to avoid exceeding context limits (Haiku handles ~80k tokens)
const MAX_CV_CHARS = 24000;

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert professional profile analyst. Your job is to extract a comprehensive, structured profile from raw CV or LinkedIn PDF text.

Return ONLY valid JSON — no markdown fences, no commentary, no trailing commas.

Extraction principles:
- Infer industries from company names, project names, and context — not just literal keywords.
  (e.g. "PIMCO" → Asset Management; "Goldman Sachs Fixed Income" → Capital Markets + Banking)
- Tier skills by depth of evidence:
  - tier1: Skills mentioned as primary expertise, in headline, or used across multiple roles (5-8 max)
  - tier2: Supporting skills mentioned in job descriptions or skills sections (5-12)
  - tier3: Adjacent skills mentioned once or in passing (up to 20)
  - tools: Specific named software, platforms, systems (Bloomberg, Jira, Workday, SimCorp, etc.)
- Services = what this person is hired to DELIVER (outcomes/engagements), not just their skills.
  Infer these from job titles, project descriptions, and deliverables.
- Generate a professional summary if none exists — 2-3 sentences, third person, value-focused.
- Generate an elevator pitch — 1 sentence: "I help [client type] [achieve outcome] by [method]."
- Infer primary engagement type from patterns: mostly short contracts = Contracting; advisory roles = Consulting; etc.
- If a field is genuinely unknown, use null — never fabricate data.`;

// ── Extraction prompt ─────────────────────────────────────────────────────────

function buildPrompt(cvText, linkedinData) {
  const liSection = linkedinData
    ? `\n\n## LinkedIn OAuth Data\n${JSON.stringify(linkedinData, null, 2)}`
    : '';

  return `Extract a comprehensive professional profile from this CV/LinkedIn text.${liSection}

## CV / LinkedIn Text
\`\`\`
${cvText.slice(0, MAX_CV_CHARS)}
\`\`\`

Return a JSON object with EXACTLY this structure (omit keys with null values to keep it compact):

{
  "name": "string | null",
  "headline": "string | null — professional title/role",
  "email": "string | null",
  "phone": "string | null",
  "location": "string | null — City, Country",
  "country": "2-letter ISO code | null",
  "linkedinUrl": "string | null",
  "githubUrl": "string | null",
  "portfolioUrl": "string | null",
  "websiteUrl": "string | null",

  "summary": "string | null — 2-3 sentence professional bio, third person, value-focused",
  "elevatorPitch": "string | null — 1 sentence: I help [clients] [achieve outcome] by [method]",

  "skills": {
    "tier1": ["primary skills — what they are hired for, 5-8 max"],
    "tier2": ["supporting skills mentioned in roles, 5-12"],
    "tier3": ["adjacent/background skills, up to 20"],
    "softSkills": ["leadership", "stakeholder management", etc.],
    "tools": ["specific named software, platforms, systems"]
  },

  "certifications": [
    { "name": "string", "issuer": "string | null", "year": number | null }
  ],

  "services": [
    {
      "name": "short engagement title",
      "description": "what this engagement involves and delivers",
      "deliverables": ["tangible output 1", "tangible output 2"]
    }
  ],

  "industries": [
    {
      "name": "canonical industry name",
      "confidence": "high | medium | low",
      "reason": "brief reason for inference"
    }
  ],

  "yearsExperience": number | null,
  "seniority": "Junior | Mid | Mid-Senior | Senior | Director | Executive | null",
  "primaryEngagementType": "Contracting | Consulting | Permanent | Mixed | null",
  "avgContractMonths": number | null,

  "workHistory": [
    {
      "company": "string | null",
      "title": "string | null",
      "startYear": number | null,
      "startMonth": number | null,
      "endYear": number | null,
      "endMonth": number | null,
      "isCurrent": boolean,
      "durationMonths": number | null,
      "description": "1-2 sentence summary of the role",
      "keyAchievements": ["measurable achievement 1", "achievement 2"],
      "skillsUsed": ["skill1", "skill2"]
    }
  ],

  "education": [
    {
      "institution": "string",
      "degree": "string — e.g. MBA, BSc Computer Science",
      "field": "string | null",
      "year": number | null
    }
  ],

  "languages": [
    { "language": "string", "proficiency": "Native | Fluent | Professional | Basic" }
  ],

  "workPreferences": {
    "remote": true | false | null,
    "hybrid": true | false | null,
    "onSite": true | false | null,
    "preferredLocations": ["City, Country"],
    "minContractMonths": number | null,
    "maxContractMonths": number | null,
    "availability": "string | null — e.g. Immediately, 2 weeks notice, Q2 2026"
  },

  "confidence": number 0-100
}`;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function callAnthropic(prompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return reject(new Error('ANTHROPIC_API_KEY not set'));

    const body = JSON.stringify({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error.message || 'Anthropic API error'));
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse Anthropic response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(45000, () => { req.destroy(new Error('Anthropic API timeout')); });
    req.write(body);
    req.end();
  });
}

// ── JSON extraction from LLM response ────────────────────────────────────────

function extractJsonFromResponse(responseText) {
  // Strip any accidental markdown fences
  const cleaned = responseText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  // Find the outermost { ... } block
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in response');

  return JSON.parse(cleaned.slice(start, end + 1));
}

// ── Profile normaliser ────────────────────────────────────────────────────────
// Ensures backwards compatibility with the rest of the codebase that expects
// the flat { skills: string[] } and { industries: string[] } format.

function normaliseProfile(raw) {
  // Flatten skills into a simple array for backwards compat (tier1 first)
  const skills = raw.skills || {};
  const flatSkills = [
    ...(skills.tier1 || []),
    ...(skills.tier2 || []),
    ...(skills.tier3 || []),
    ...(skills.tools || []),
  ].filter((v, i, a) => v && a.indexOf(v) === i); // dedup

  // Flatten industries into simple string array (for backwards compat)
  const flatIndustries = (raw.industries || []).map(i =>
    typeof i === 'string' ? i : i.name
  ).filter(Boolean);

  return {
    // ── Identity ──────────────────────────────────────────────────────────
    name:          raw.name         || null,
    headline:      raw.headline     || null,
    email:         raw.email        || null,
    phone:         raw.phone        || null,
    location:      raw.location     || null,
    country:       raw.country      || null,
    linkedinUrl:   raw.linkedinUrl  || null,
    githubUrl:     raw.githubUrl    || null,
    portfolioUrl:  raw.portfolioUrl || null,
    websiteUrl:    raw.websiteUrl   || null,

    // ── Bio ───────────────────────────────────────────────────────────────
    summary:        raw.summary       || null,
    elevatorPitch:  raw.elevatorPitch || null,

    // ── Skills (both rich + flat for compat) ─────────────────────────────
    skills:          flatSkills,           // flat list (backwards compat)
    skillTiers: {                          // rich tiered data
      tier1:      skills.tier1      || [],
      tier2:      skills.tier2      || [],
      tier3:      skills.tier3      || [],
      softSkills: skills.softSkills || [],
      tools:      skills.tools      || [],
    },
    certifications: raw.certifications || [],

    // ── Services ──────────────────────────────────────────────────────────
    services:    (raw.services || []).map(s =>
      typeof s === 'string' ? s : (s.name || s.description || '')
    ).filter(Boolean),
    servicesRich: raw.services || [],     // full service objects

    // ── Industries (both rich + flat) ─────────────────────────────────────
    industries:     flatIndustries,        // flat list (backwards compat)
    industriesRich: raw.industries || [],  // rich with confidence + reason

    // ── Career ────────────────────────────────────────────────────────────
    yearsExperience:       raw.yearsExperience       || null,
    seniority:             raw.seniority             || null,
    primaryEngagementType: raw.primaryEngagementType || null,
    avgContractMonths:     raw.avgContractMonths     || null,
    workHistory:           raw.workHistory           || [],

    // ── Education & Languages ─────────────────────────────────────────────
    education:  raw.education  || [],
    languages:  raw.languages  || [],

    // ── Work preferences ──────────────────────────────────────────────────
    workPreferences: raw.workPreferences || {
      remote: null, hybrid: null, onSite: null,
      preferredLocations: [], minContractMonths: null,
      maxContractMonths: null, availability: null,
    },

    // ── Meta ──────────────────────────────────────────────────────────────
    confidence:    raw.confidence ?? 0,
    extractedBy:  'llm',
    extractedAt:  new Date().toISOString(),
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract a comprehensive professional profile using Claude.
 *
 * @param {string} cvText        — raw text from the CV/LinkedIn PDF
 * @param {object} [linkedinData] — OAuth data from LinkedIn (name, headline, email, etc.)
 * @returns {Promise<object|null>}  RichProfile or null if LLM unavailable
 */
async function extractWithLLM(cvText, linkedinData = null) {
  if (!cvText || !process.env.ANTHROPIC_API_KEY) return null;

  try {
    const prompt   = buildPrompt(cvText, linkedinData);
    const response = await callAnthropic(prompt);
    const content  = response?.content?.[0]?.text;
    if (!content) throw new Error('Empty LLM response');

    const raw = extractJsonFromResponse(content);
    return normaliseProfile(raw);

  } catch (err) {
    console.warn('[llmProfileExtractor] LLM extraction failed, will fall back to regex:', err.message);
    return null;
  }
}

/**
 * Check whether LLM extraction is available (API key set).
 */
function isLLMAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
}

module.exports = { extractWithLLM, isLLMAvailable, normaliseProfile };
