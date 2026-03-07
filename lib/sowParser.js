'use strict';
/**
 * lib/sowParser.js — Statement of Work / Contract PDF text extractor
 *
 * Pulls structured intelligence from a freelancer's SOW or contract:
 *   - services[]    What the freelancer is hired to DO (verb phrases)
 *   - deliverables[] Specific outputs / artefacts mentioned
 *   - keywords[]    Domain-specific terms (tech, methodologies, frameworks)
 *   - clientType    Inferred type of hiring organisation
 *   - rateHint      Day/hour rate mentioned (€ / USD / £)
 *   - durationHint  Engagement length (months)
 *   - verticals[]   Industry verticals inferred from client/context
 *   - signals       Things that indicate urgency / why they need a contractor
 *
 * Designed to complement cvParser.js: the CV tells you who YOU are;
 * the SOW tells you what CLIENTS actually pay you for.
 */

// ── Service / Deliverable verb patterns ───────────────────────────────────────
// Looks for sentences with these active-voice verbs in the work scope section.

const WORK_VERBS = [
  'design', 'develop', 'build', 'implement', 'deliver', 'create', 'manage',
  'analyse', 'analyze', 'review', 'assess', 'audit', 'consult', 'advise',
  'support', 'lead', 'architect', 'migrate', 'integrate', 'configure',
  'test', 'validate', 'document', 'report', 'maintain', 'deploy', 'optimise',
  'optimize', 'define', 'establish', 'execute', 'coordinate', 'facilitate',
  'automate', 'model', 'forecast', 'transform', 'onboard', 'train', 'coach',
  'remediate', 'upgrade', 'consolidate', 'streamline', 'restructure',
];

// ── Scope / deliverable section headers ───────────────────────────────────────
const SCOPE_HEADERS = /(?:scope\s+of\s+(?:work|services?)|deliverables?|services?\s+to\s+be\s+(?:provided|delivered|performed)|work\s+(?:packages?|description|statement)|activities|responsibilities|tasks?|objectives?)/i;
const SCOPE_STOP    = /(?:payment|compensation|rate|fee|invoice|confidential|ip\s+rights|intellectual\s+property|termination|governing\s+law|warranty|liability|indemnif)/i;

// ── Rate extraction ────────────────────────────────────────────────────────────
// Matches €120, €120/hr, €960/day, $150 per hour, etc.
const RATE_PATTERN = /(?:rate|fee|compensation|day\s*rate|hour(?:ly)?\s*rate)\D{0,30}([$€£]?\s*[\d,]+(?:\.\d+)?\s*(?:per\s+(?:hour|day|week|month)|\/\s*(?:hr|h|day|diem|wk|mo(?:nth)?)|[-–]\s*[$€£]?\s*[\d,]+(?:\.\d+)?)?)/gi;

// ── Duration extraction ────────────────────────────────────────────────────────
const DURATION_PATTERN = /\b(\d+(?:\.\d+)?)\s*(?:-month|month(?:s)?|week(?:s)?)\s*(?:engagement|contract|assignment|project|period)?\b/gi;

// ── Client type signals ────────────────────────────────────────────────────────
const CLIENT_TYPES = [
  { re: /\b(?:asset\s+manager|fund\s+manager|investment\s+manager|amc)\b/i,    label: 'Asset Manager' },
  { re: /\b(?:hedge\s+fund|hf\b)\b/i,                                           label: 'Hedge Fund' },
  { re: /\b(?:pension\s+fund|pension\s+scheme)\b/i,                             label: 'Pension Fund' },
  { re: /\b(?:private\s+equity|pe\s+firm|buyout)\b/i,                           label: 'Private Equity' },
  { re: /\b(?:bank(?:ing\s+institution)?|clearing\s+bank)\b/i,                  label: 'Bank' },
  { re: /\b(?:insurance|insurer|re-?insur)\b/i,                                 label: 'Insurance' },
  { re: /\b(?:fintech|financial\s+technology\s+(?:firm|company))\b/i,           label: 'FinTech' },
  { re: /\b(?:consulting\s+firm|consultancy|advisory\s+firm)\b/i,               label: 'Consultancy' },
  { re: /\b(?:technology\s+company|software\s+company|tech\s+firm|saas)\b/i,   label: 'Technology Company' },
  { re: /\b(?:regulator|authority|central\s+bank|supervisory)\b/i,              label: 'Regulator' },
  { re: /\b(?:government|ministry|municipality|public\s+sector)\b/i,            label: 'Government' },
  { re: /\b(?:ngo|non-?profit|foundation|charity)\b/i,                          label: 'NGO / Non-profit' },
  { re: /\b(?:hospital|healthcare|pharma|life\s+sciences)\b/i,                  label: 'Healthcare' },
  { re: /\b(?:law\s+firm|legal\s+services|barristers?)\b/i,                     label: 'Law Firm' },
  { re: /\b(?:university|academic\s+institution|research\s+institute)\b/i,      label: 'Academia' },
];

// ── Urgency / trigger signals in contract language ─────────────────────────────
const URGENCY_SIGNALS = [
  { re: /\b(?:regulatory|compliance|dora|nis2|esg|mifid|aifmd|ucits|gdpr|basel)\b/i, type: 'Regulatory' },
  { re: /\b(?:audit|remediation|urgent|critical|immediate|asap|deadline)\b/i,        type: 'Urgent remediation' },
  { re: /\b(?:migration|transition|go-live|cutover|decommission)\b/i,                type: 'System migration' },
  { re: /\b(?:transformation|restructur|reorg|merger|acquisition|integration)\b/i,   type: 'Transformation' },
  { re: /\b(?:interim|maternity\s+cover|parental\s+leave|backfill|replacement)\b/i,  type: 'Interim coverage' },
  { re: /\b(?:cost\s+reduction|efficiency|optimis|streamlin)\b/i,                    type: 'Cost optimisation' },
];

// ── Generic keyword extraction ────────────────────────────────────────────────
// High-signal professional / technical terms that tend to appear in SOWs.
const TECH_KEYWORD_PATTERN = /\b([A-Z][a-zA-Z0-9\-\.]{2,25}|[A-Z]{2,12})\b/g;

const COMMON_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'With', 'From', 'Into', 'Upon',
  'Each', 'Any', 'All', 'Has', 'Have', 'Had', 'Will', 'Shall', 'May',
  'Can', 'Are', 'Were', 'Been', 'Being', 'Not', 'For', 'And', 'But', 'Or',
  'Inc', 'Ltd', 'BV', 'GmbH', 'LLC', 'NV', 'AG', 'SE', 'SA', 'AB',
  'Part', 'Section', 'Article', 'Annex', 'Schedule', 'Appendix',
  'Date', 'Name', 'Party', 'Client', 'Contractor', 'Service', 'Work',
  'Project', 'Agreement', 'Contract', 'SOW', 'Statement',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function sentences(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/[.!?\n]+/)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 20);
}

function extractScopeSection(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let inScope = false;
  const scopeLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const looksLikeHeader = line.length < 80 && /^[0-9\.]*\s*[A-Z]/.test(line);

    if (SCOPE_HEADERS.test(line)) {
      inScope = true;
      continue;
    }

    if (inScope) {
      if (looksLikeHeader && SCOPE_STOP.test(line)) break;
      // Stop at next major section not related to work scope
      if (looksLikeHeader && scopeLines.length > 3 && !SCOPE_HEADERS.test(line)) {
        // Only stop if it looks like a completely different section
        if (SCOPE_STOP.test(line)) break;
      }
      scopeLines.push(line);
      if (scopeLines.length > 100) break; // cap at 100 lines
    }
  }

  return inScope ? scopeLines.join('\n') : text.slice(0, 4000);
}

function extractServices(scopeText) {
  const found = new Set();
  const s = sentences(scopeText);

  for (const sent of s) {
    const lower = sent.toLowerCase();
    for (const verb of WORK_VERBS) {
      if (lower.includes(verb)) {
        // Clean up: remove numbering, bullets, normalize
        const clean = sent
          .replace(/^[\d\.\-\*•●►\s]+/, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (clean.length > 15 && clean.length < 200) {
          found.add(clean);
          break; // one service per sentence
        }
      }
    }
  }

  return [...found].slice(0, 15);
}

function extractDeliverables(text) {
  const found = new Set();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const delivPatterns = [
    /(?:deliverables?|outputs?|artefacts?|artifacts?|products?)[:\s](.+)/gi,
    /[-•►]\s+(.{10,120})/g, // bullet points often = deliverables in SOW
  ];

  for (const line of lines) {
    for (const re of delivPatterns) {
      const m = line.match(re);
      if (m) {
        const clean = line.replace(/^[-•►\d\.\s]+/, '').trim();
        if (clean.length > 8 && clean.length < 150) found.add(clean);
      }
    }
  }

  return [...found].slice(0, 12);
}

function extractRateHint(text) {
  const matches = [];
  let m;
  const re = new RegExp(RATE_PATTERN.source, 'gi');
  while ((m = re.exec(text)) !== null) {
    const raw = m[1]?.trim();
    if (raw) {
      const numStr = raw.replace(/[^0-9.,]/g, '').replace(',', '');
      const val = parseFloat(numStr);
      if (val > 10 && val < 10000) {
        matches.push({ raw, value: val, context: m[0].slice(0, 60) });
      }
    }
  }
  return matches.length > 0 ? matches[0] : null;
}

function extractDurationHint(text) {
  const durations = [];
  let m;
  const re = new RegExp(DURATION_PATTERN.source, 'gi');
  while ((m = re.exec(text)) !== null) {
    const num = parseFloat(m[1]);
    const unit = m[0].toLowerCase();
    const months = unit.includes('week') ? num / 4.33
                 : unit.includes('month') ? num
                 : null;
    if (months !== null && months >= 0.5 && months <= 36) {
      durations.push(Math.round(months * 10) / 10);
    }
  }
  return durations.length > 0 ? Math.max(...durations) : null;
}

function extractClientType(text) {
  for (const { re, label } of CLIENT_TYPES) {
    if (re.test(text)) return label;
  }
  return null;
}

function extractVerticals(text) {
  const found = [];
  for (const { re, label } of CLIENT_TYPES) {
    if (re.test(text)) found.push(label);
  }
  return [...new Set(found)];
}

function extractUrgencySignals(text) {
  const found = [];
  for (const { re, type } of URGENCY_SIGNALS) {
    if (re.test(text)) found.push(type);
  }
  return [...new Set(found)];
}

function extractKeywords(text) {
  const words = new Map();
  let m;
  const re = new RegExp(TECH_KEYWORD_PATTERN.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const w = m[1];
    if (w.length < 3 || w.length > 25) continue;
    if (COMMON_WORDS.has(w)) continue;
    if (/^\d+$/.test(w)) continue;
    words.set(w, (words.get(w) || 0) + 1);
  }
  // Return words that appear ≥ 2 times (signal-to-noise filter)
  return [...words.entries()]
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .map(([w]) => w)
    .slice(0, 30);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract professional intelligence from a SOW/contract text.
 *
 * @param {string} rawText - Full plain text from pdf-parse
 * @returns {{
 *   services: string[],
 *   deliverables: string[],
 *   keywords: string[],
 *   clientType: string|null,
 *   verticals: string[],
 *   rateHint: {raw:string, value:number}|null,
 *   durationHint: number|null,
 *   urgencySignals: string[],
 *   confidence: number
 * }}
 */
function parseSow(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      services: [], deliverables: [], keywords: [],
      clientType: null, verticals: [], rateHint: null,
      durationHint: null, urgencySignals: [], confidence: 0,
    };
  }

  const scopeText = extractScopeSection(rawText);

  const services      = extractServices(scopeText);
  const deliverables  = extractDeliverables(scopeText);
  const keywords      = extractKeywords(rawText);
  const clientType    = extractClientType(rawText);
  const verticals     = extractVerticals(rawText);
  const rateHint      = extractRateHint(rawText);
  const durationHint  = extractDurationHint(rawText);
  const urgencySignals = extractUrgencySignals(rawText);

  // Confidence: based on how much we found
  const hits = [
    services.length > 0,
    keywords.length > 3,
    clientType !== null,
    rateHint !== null || durationHint !== null,
  ].filter(Boolean).length;
  const confidence = Math.round((hits / 4) * 100);

  return {
    services,
    deliverables,
    keywords,
    clientType,
    verticals,
    rateHint,
    durationHint,
    urgencySignals,
    confidence,
  };
}

module.exports = { parseSow };
