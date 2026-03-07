'use strict';
/**
 * lib/cvParser.js — Generic CV / LinkedIn PDF profile extractor
 *
 * Works for any professional: engineer, designer, lawyer, marketer,
 * consultant, healthcare, creative, finance, and more.
 *
 * Strategy: extract structure from the text itself rather than matching
 * against hardcoded domain-specific keyword lists.
 *
 * Returns: { name, headline, email, phone, location, country,
 *            industries[], skills[], yearsExperience, confidence, isLinkedIn }
 */

// ── Skill section header patterns ─────────────────────────────────────────────
// Matches common CV section headings that precede skill lists.

const SKILL_HEADERS = [
  /^(?:top\s+)?skills?$/i,
  /^technical\s+skills?$/i,
  /^core\s+(?:skills?|competenc(?:ies|y)|capabilities?)$/i,
  /^areas?\s+of\s+expertise$/i,
  /^key\s+(?:skills?|competenc(?:ies|y))$/i,
  /^tools?\s+(?:&\s+)?(?:technologies|platforms?)?$/i,
  /^technologies$/i,
  /^software\s+(?:skills?|proficiency)$/i,
  /^languages?\s+(?:&\s+)?(?:frameworks?|tools?)?$/i,
  /^certifications?\s*(?:&\s*training)?$/i,
  /^qualifications?$/i,
  /^expertise$/i,
  /^proficienc(?:y|ies)$/i,
  /^speciali[sz](?:ations?|ms?)$/i,
  /^hard\s+skills?$/i,
];

// Headers that signal we've left the skills section
const STOP_HEADERS = /^(?:experience|education|employment|work\s+history|projects?|publications?|awards?|interests?|references?|about|summary|contact|volunteer)/i;

// ── Industry patterns → canonical labels ──────────────────────────────────────
// Broad coverage across verticals — no single industry hardcoded as primary.

const INDUSTRY_PATTERNS = [
  // Finance
  { re: /asset\s+management|fund\s+management|investment\s+management/i,    label: 'Asset Management' },
  { re: /wealth\s+management|private\s+(?:banking|wealth)/i,                 label: 'Wealth Management' },
  { re: /hedge\s+fund/i,                                                      label: 'Hedge Funds' },
  { re: /pension\s+fund/i,                                                    label: 'Pension Funds' },
  { re: /private\s+equity|venture\s+capital/i,                                label: 'Private Equity / VC' },
  { re: /investment\s+banking|capital\s+markets?/i,                           label: 'Capital Markets' },
  { re: /retail\s+banking|commercial\s+banking|financial\s+services/i,        label: 'Banking' },
  { re: /insurance|actuarial/i,                                                label: 'Insurance' },
  { re: /accounting|audit(?:ing)?|tax\s+advisory/i,                           label: 'Accounting & Audit' },
  { re: /fintech|financial\s+technology/i,                                     label: 'FinTech' },
  // Consulting & Professional Services
  { re: /management\s+consulting|strategy\s+consulting/i,                     label: 'Management Consulting' },
  { re: /professional\s+services|advisory\s+services/i,                       label: 'Professional Services' },
  // Technology
  { re: /software\s+(?:engineer|development|architect)|full.stack|back.end|front.end/i, label: 'Software Engineering' },
  { re: /machine\s+learning|artificial\s+intelligence|deep\s+learning|data\s+science/i, label: 'AI / Machine Learning' },
  { re: /cloud\s+(?:computing|infrastructure|architect)|\baws\b|\bazure\b|\bgcp\b/i,     label: 'Cloud / Infrastructure' },
  { re: /cybersecurity|information\s+security|infosec|penetration\s+test/i,             label: 'Cybersecurity' },
  { re: /product\s+management|product\s+owner|product\s+strategy/i,                     label: 'Product Management' },
  { re: /data\s+engineer|data\s+analyst|business\s+intelligence|\banalytics\b/i,        label: 'Data & Analytics' },
  { re: /ux\b|user\s+experience|ui\s+design|interaction\s+design/i,                     label: 'UX / Product Design' },
  { re: /it\s+(?:consulting|services|management)|enterprise\s+technology/i,             label: 'IT Consulting' },
  { re: /\bsaas\b|b2b\s+software|enterprise\s+software/i,                              label: 'SaaS / Software' },
  { re: /devops|site\s+reliability|platform\s+engineer/i,                              label: 'DevOps / Platform' },
  // Marketing & Creative
  { re: /digital\s+marketing|performance\s+marketing|growth\s+market/i,               label: 'Digital Marketing' },
  { re: /brand(?:ing)?\s+(?:strategy|management|design)/i,                            label: 'Branding / Creative' },
  { re: /content\s+(?:marketing|strategy|creation)/i,                                 label: 'Content & SEO' },
  { re: /advertising|media\s+(?:buying|planning)|paid\s+(?:media|ads)/i,              label: 'Advertising / Media' },
  { re: /public\s+relations|communications?\s+(?:director|manager|strategy)/i,        label: 'PR & Communications' },
  { re: /graphic\s+design|creative\s+direction|art\s+direction/i,                     label: 'Graphic Design' },
  // Legal
  { re: /corporate\s+law|commercial\s+law|legal\s+counsel|solicitor|attorney/i,       label: 'Legal' },
  { re: /compliance|regulatory\s+affairs|governance/i,                                label: 'Compliance & Regulatory' },
  // Healthcare
  { re: /healthcare|medical\s+device|clinical\s+(?:trial|research)/i,                 label: 'Healthcare' },
  { re: /pharmaceutical|biotech|life\s+sciences?/i,                                   label: 'Life Sciences' },
  // Real Estate & Construction
  { re: /real\s+estate|property\s+(?:management|development)|\breit\b/i,              label: 'Real Estate' },
  { re: /construction|architecture|engineering\s+(?:firm|project)/i,                  label: 'Construction & Architecture' },
  // Operations & Supply Chain
  { re: /supply\s+chain|logistics|procurement|operations\s+manager/i,                 label: 'Supply Chain & Logistics' },
  { re: /project\s+management|programme\s+manager|\bpmo\b/i,                          label: 'Project Management' },
  // HR & Talent
  { re: /human\s+resources|\bhrm?\b|talent\s+acquisition|people\s+(?:ops|partner)/i,  label: 'HR & People' },
  // Education
  { re: /higher\s+education|university|teaching|academic/i,                           label: 'Education' },
  { re: /non.?profit|\bngo\b|social\s+impact/i,                                       label: 'Non-profit / NGO' },
  // Energy & Sustainability
  { re: /renewable\s+energy|sustainability|\besg\b\s+(?:reporting|strategy)/i,        label: 'Energy & Sustainability' },
  // Media & Entertainment
  { re: /media\s+(?:production|company)|entertainment|publishing|journalism/i,        label: 'Media & Entertainment' },
  // E-commerce & Retail
  { re: /e.?commerce|retail\s+(?:strategy|management)|d2c|direct.to.consumer/i,      label: 'E-commerce / Retail' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function lines(text) {
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

function isLinkedIn(text) {
  return /linkedin\.com|Top\s+Skills?|Honors\s*(?:&|and)\s*Awards/i.test(text.slice(0, 3000));
}

function extractName(rawLines) {
  for (const line of rawLines.slice(0, 20)) {
    if (line.length < 4 || line.length > 70) continue;
    if (/[@:/|©\d]/.test(line)) continue;
    if (/^(page|curriculum\s+vitae|resume|cv|profile|linkedin)/i.test(line)) continue;
    const words = line.trim().split(/\s+/);
    if (words.length < 2 || words.length > 5) continue;
    const allNameLike = words.every(w =>
      /^[A-ZÁÉÍÓÚÀÈÌÒÙÄËÏÖÜ][a-záéíóúàèìòùäëïöü]+$/.test(w) ||
      /^(de|van|der|den|von|le|la|du|di|da|al|bin|mc|mac|o')$/i.test(w) ||
      /^[A-Z]\.$/.test(w)
    );
    if (allNameLike) return line;
  }
  return null;
}

function extractHeadline(rawLines, name) {
  const nameIdx = name ? rawLines.findIndex(l => l.includes(name)) : -1;
  const start   = nameIdx >= 0 ? nameIdx + 1 : 1;
  for (const line of rawLines.slice(start, start + 12)) {
    if (line.length < 6 || line.length > 160) continue;
    if (/^\+?\d[\d\s\-().]{6,}$/.test(line)) continue; // phone
    if (/@/.test(line)) continue;                        // email
    if (/^\d{4}/.test(line)) continue;                  // year
    if (/^https?:\/\//i.test(line)) continue;           // URL
    const wordCount = line.split(/\s+/).length;
    const titleRe   = /senior|lead|head|principal|manager|consultant|analyst|engineer|director|officer|advisor|specialist|interim|freelance|independent|contractor|founder|cto|cfo|coo|ceo|vp\s/i;
    if (wordCount >= 2 || titleRe.test(line)) return line;
  }
  return null;
}

function extractEmail(text) {
  const m = text.match(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/);
  return m ? m[1] : null;
}

function extractPhone(text) {
  const m = text.match(/(?:\+\d{1,3}[\s\-.]?)?\(?\d{2,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,6}/);
  return m ? m[0].trim() : null;
}

function extractLocation(text, rawLines) {
  // Try labelled location first
  const labelled = text.match(
    /(?:location|address|city|based\s+in|located\s+in)\s*[:\-–]\s*([^\n]{3,60})/i
  );
  if (labelled) return labelled[1].trim();

  // Look for "City, Country" pattern in first 40 lines
  for (const line of rawLines.slice(0, 40)) {
    if (/^[\w\s\-\.]+,\s*[\w\s\-\.]{2,}$/.test(line) && line.length < 60) {
      if (!/^\d|@|http|linkedin/i.test(line)) return line;
    }
    // Standalone country name
    if (/^(united\s+states|united\s+kingdom|netherlands|germany|france|australia|canada|singapore|india|ireland|switzerland|sweden|denmark|norway|finland|spain|italy|belgium|austria|new\s+zealand)$/i.test(line)) {
      return line;
    }
  }
  return null;
}

function extractCountry(location) {
  if (!location) return null;
  const l = location.toLowerCase();
  if (/netherlands|nederland|\bnl\b/.test(l))      return 'NL';
  if (/united kingdom|\buk\b|england|scotland/.test(l)) return 'UK';
  if (/united states|\busa?\b/.test(l))             return 'US';
  if (/germany|deutschland/.test(l))                return 'DE';
  if (/france/.test(l))                             return 'FR';
  if (/canada/.test(l))                             return 'CA';
  if (/australia/.test(l))                          return 'AU';
  if (/singapore/.test(l))                          return 'SG';
  if (/ireland/.test(l))                            return 'IE';
  if (/switzerland/.test(l))                        return 'CH';
  if (/belgium/.test(l))                            return 'BE';
  if (/sweden/.test(l))                             return 'SE';
  if (/denmark/.test(l))                            return 'DK';
  if (/norway/.test(l))                             return 'NO';
  if (/india/.test(l))                              return 'IN';
  return null;
}

/**
 * Dynamic skill extraction — parses the document structure rather than
 * matching against a hardcoded keyword list. Works for any profession.
 */
function extractSkills(text, rawLines) {
  const skills = new Set();

  // ── 1. Parse named skills section ───────────────────────────────────────────
  let inSection  = false;
  let sectionLines = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line     = rawLines[i];
    const isHeader = SKILL_HEADERS.some(re => re.test(line));
    const isStop   = !isHeader && STOP_HEADERS.test(line);

    if (isHeader) {
      inSection = true;
      continue;
    }

    if (inSection) {
      // Detect a new section header by heuristic (short, title-case, no punctuation)
      const looksLikeHeader = !isHeader && line.length < 40 &&
                              /^[A-Z]/.test(line) &&
                              line.split(/\s+/).length <= 4 &&
                              !/[,•·|]/.test(line) &&
                              sectionLines.length > 2;

      if (isStop || looksLikeHeader) break;
      if (line.length > 1 && line.length < 80) sectionLines.push(line);
      if (sectionLines.length > 50) break;
    }
  }

  for (const line of sectionLines) {
    const items = line.split(/[,•·|；;]+/).map(s =>
      s.replace(/^[-–•·*▪◦→\s]+/, '').trim()
    );
    for (const item of items) {
      if (item.length >= 2 && item.length <= 60 && !/^\d+$/.test(item)) {
        skills.add(item);
      }
    }
  }

  // ── 2. LinkedIn "Top Skills" block ──────────────────────────────────────────
  const topSkillsMatch = text.match(
    /Top\s+Skills?\s*\n([\s\S]{0,800}?)(?:\n[A-Z][^\n]{2,}\n[A-Z]|\n{3})/m
  );
  if (topSkillsMatch) {
    topSkillsMatch[1]
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 1 && l.length < 60)
      .forEach(l => {
        if (!/^\d{4}/.test(l) && !/@/.test(l)) skills.add(l);
      });
  }

  // ── 3. Certifications / Licences block ──────────────────────────────────────
  const certMatch = text.match(
    /(?:certifications?|licen[sc]es?)\s*\n([\s\S]{0,600}?)(?:\n[A-Z][^\n]{3,}\n[A-Z]|$)/mi
  );
  if (certMatch) {
    certMatch[1]
      .split('\n')
      .map(l => l.trim())
      .filter(l =>
        l.length > 3 &&
        l.length < 80 &&
        !/^\d{4}/.test(l) &&
        !/^(issued|expires?)/i.test(l)
      )
      .forEach(l => skills.add(l));
  }

  // ── Normalise and cap ────────────────────────────────────────────────────────
  return [...skills]
    .map(s => s.replace(/\s+/g, ' ').replace(/[.,:;]+$/, '').trim())
    .filter(s => s.length >= 2 && s.length <= 60)
    .filter(s => !/^(and|or|the|in|of|for|with|using|etc|more)$/i.test(s))
    .slice(0, 50);
}

function extractIndustries(text) {
  const found = new Set();
  for (const { re, label } of INDUSTRY_PATTERNS) {
    if (re.test(text)) found.add(label);
  }
  return [...found];
}

function extractYearsExperience(text) {
  const currentYear  = new Date().getFullYear();
  const yearMatches  = [...text.matchAll(/\b(19[89]\d|20[01]\d|202[0-5])\b/g)];
  if (!yearMatches.length) return null;
  const years      = yearMatches.map(m => parseInt(m[1]));
  const oldestYear = Math.min(...years);
  if (oldestYear < 1985 || oldestYear > currentYear - 1) return null;
  return currentYear - oldestYear;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract a professional profile from raw CV/LinkedIn PDF text.
 * Generic — works for any industry and any country.
 *
 * @param {string} text — raw text from pdf-parse
 * @returns {{ name, headline, email, phone, location, country,
 *             industries, skills, yearsExperience, confidence, isLinkedIn }}
 */
function extractCvProfile(text) {
  if (!text || typeof text !== 'string') {
    return {
      name: null, headline: null, email: null, phone: null,
      location: null, country: null, industries: [], skills: [],
      yearsExperience: null, confidence: 0, isLinkedIn: false,
    };
  }

  const cleaned  = text.replace(/\r\n/g, '\n').replace(/[ \t]{2,}/g, ' ');
  const rawLines = lines(cleaned);
  const isLI     = isLinkedIn(cleaned);

  const name            = extractName(rawLines);
  const headline        = extractHeadline(rawLines, name);
  const email           = extractEmail(cleaned);
  const phone           = extractPhone(cleaned);
  const location        = extractLocation(cleaned, rawLines);
  const country         = extractCountry(location);
  const skills          = extractSkills(cleaned, rawLines);
  const industries      = extractIndustries(cleaned);
  const yearsExperience = extractYearsExperience(cleaned);

  // Confidence: 0–100 based on how many key fields were found
  const keyFields  = [name, headline, email, location,
                      skills.length > 0 ? true : null,
                      industries.length > 0 ? true : null];
  const confidence = Math.round(keyFields.filter(Boolean).length / keyFields.length * 100);

  return {
    name, headline, email, phone, location, country,
    industries, skills, yearsExperience, confidence, isLinkedIn: isLI,
  };
}

module.exports = { extractCvProfile };
