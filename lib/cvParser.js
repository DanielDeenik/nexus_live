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
  // Match years from 1970 through 2039 — avoids regex needing annual updates
  const yearMatches  = [...text.matchAll(/\b(19[7-9]\d|20[0-3]\d)\b/g)];
  if (!yearMatches.length) return null;
  const years      = yearMatches.map(m => parseInt(m[1]));
  const oldestYear = Math.min(...years);
  // Sanity: must be plausibly within a working career (1985 to last year)
  if (oldestYear < 1985 || oldestYear > currentYear - 1) return null;
  return currentYear - oldestYear;
}

// ── Work history extraction ────────────────────────────────────────────────────
// Extracts structured job positions: company, title, start, end, durationMonths
//
// Strategy: find the Experience section, then scan for repeating patterns of
// "Title\nCompany · Employment Type\nDates" (LinkedIn PDF) or
// "Title — Company  2018 – 2022" (standard CV formats).

const EXPERIENCE_HEADERS = /^(?:experience|work\s+experience|employment|professional\s+experience|career\s+history|work\s+history|professional\s+background)$/i;
const EDUCATION_HEADERS  = /^(?:education|academic|qualifications?|degrees?|university|certifications?)$/i;

// Matches date ranges like: 2018 – 2022, Jan 2019 – Mar 2021, 2020 – Present
const DATE_RANGE_RE = /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+)?((?:19[7-9]\d|20[0-3]\d))\s*[-–—to]+\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+)?((?:19[7-9]\d|20[0-3]\d)|present|current|now)\b/i;

const MONTH_MAP = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

function parseDateRange(str) {
  const m = str.match(DATE_RANGE_RE);
  if (!m) return null;
  const startMonth = m[1] ? MONTH_MAP[(m[1].trim().slice(0,3).toLowerCase())] || 1 : 1;
  const startYear  = parseInt(m[2]);
  const endRaw     = (m[4] || '').toLowerCase().trim();
  const isCurrent  = /present|current|now/.test(endRaw);
  const endYear    = isCurrent ? new Date().getFullYear() : parseInt(m[4]);
  const endMonth   = isCurrent ? new Date().getMonth() + 1 : (m[3] ? MONTH_MAP[(m[3].trim().slice(0,3).toLowerCase())] || 12 : 12);
  if (!startYear || startYear < 1970) return null;
  const durationMonths = (endYear - startYear) * 12 + (endMonth - startMonth);
  return {
    startYear, startMonth,
    endYear: isCurrent ? null : endYear,
    endMonth: isCurrent ? null : endMonth,
    isCurrent,
    durationMonths: Math.max(1, durationMonths),
  };
}

function extractWorkHistory(text, rawLines) {
  const positions = [];
  let inExp       = false;
  let expLines    = [];

  // ── 1. Isolate Experience section ───────────────────────────────────────────
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (EXPERIENCE_HEADERS.test(line)) { inExp = true; continue; }
    if (inExp) {
      // Stop when we hit another major section (Education, Skills, etc.)
      if (EDUCATION_HEADERS.test(line)) break;
      if (STOP_HEADERS.test(line) && expLines.length > 3) break;
      expLines.push(line);
      if (expLines.length > 200) break;
    }
  }

  // Fall back to full text if no experience header found
  if (expLines.length < 3) expLines = rawLines.slice(0, 150);

  // ── 2. Scan for date-range lines and group adjacent lines into positions ────
  for (let i = 0; i < expLines.length; i++) {
    const line = expLines[i];
    const dateRange = parseDateRange(line);
    if (!dateRange) continue;

    // Look back up to 3 lines for title + company
    const before = expLines.slice(Math.max(0, i - 3), i).filter(l => l.length > 2 && l.length < 120);
    // Look forward up to 3 lines for description
    const after  = expLines.slice(i + 1, Math.min(expLines.length, i + 4)).filter(l => l.length > 2 && l.length < 200);

    let title   = null;
    let company = null;

    // LinkedIn PDF format: "Title\nCompany · Type\nDates"
    if (before.length >= 2) {
      const possibleCompany = before[before.length - 1];
      const possibleTitle   = before[before.length - 2];
      // Company line often has " · " separator (LinkedIn) or is a standalone company name
      if (/·|,\s*[A-Z]/.test(possibleCompany) || possibleCompany.split(/\s+/).length <= 6) {
        company = possibleCompany.split('·')[0].trim();
        title   = possibleTitle;
      } else {
        company = possibleCompany;
        title   = possibleTitle;
      }
    } else if (before.length === 1) {
      // Could be either title or company
      title = before[0];
    }

    // Standard CV format: "Title — Company  2018–2022" on one line
    const inlineTitleCo = line.match(/^(.+?)\s*[-–—@|]\s*(.+?)\s+\d{4}/);
    if (!title && inlineTitleCo) {
      title   = inlineTitleCo[1].trim();
      company = inlineTitleCo[2].trim();
    }

    if (!title && !company) continue; // Skip if we can't identify the role

    // Normalise: remove very long strings (likely paragraphs)
    if (title   && title.length   > 100) title   = null;
    if (company && company.length > 100) company = null;

    positions.push({
      title:          title   || null,
      company:        company || null,
      startYear:      dateRange.startYear,
      startMonth:     dateRange.startMonth,
      endYear:        dateRange.endYear,
      endMonth:       dateRange.endMonth,
      isCurrent:      dateRange.isCurrent,
      durationMonths: dateRange.durationMonths,
    });
  }

  // ── 3. Deduplicate (same role+company sometimes appears twice) ──────────────
  const seen = new Set();
  return positions.filter(p => {
    const key = `${p.title}|${p.company}|${p.startYear}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12); // Cap at 12 positions
}

// ── Derive career metrics from work history ────────────────────────────────────
function deriveCareerMetrics(positions) {
  if (!positions.length) return { avgContractMonths: null, yearsExperienceFromHistory: null };
  const durArr = positions.map(p => p.durationMonths).filter(Boolean);
  const avgContractMonths = durArr.length
    ? Math.round(durArr.reduce((a, v) => a + v, 0) / durArr.length)
    : null;
  const currentYear = new Date().getFullYear();
  const oldestStart = Math.min(...positions.map(p => p.startYear).filter(Boolean));
  const yearsExperienceFromHistory = (oldestStart >= 1985 && oldestStart < currentYear)
    ? currentYear - oldestStart
    : null;
  return { avgContractMonths, yearsExperienceFromHistory };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract a professional profile from raw CV/LinkedIn PDF text.
 * Generic — works for any industry and any country.
 *
 * @param {string} text — raw text from pdf-parse
 * @returns {{ name, headline, email, phone, location, country,
 *             industries, skills, yearsExperience, workHistory,
 *             avgContractMonths, confidence, isLinkedIn }}
 */
function extractCvProfile(text) {
  if (!text || typeof text !== 'string') {
    return {
      name: null, headline: null, email: null, phone: null,
      location: null, country: null, industries: [], skills: [],
      yearsExperience: null, workHistory: [], avgContractMonths: null,
      confidence: 0, isLinkedIn: false,
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
  const workHistory     = extractWorkHistory(cleaned, rawLines);
  const { avgContractMonths, yearsExperienceFromHistory } = deriveCareerMetrics(workHistory);
  // Prefer history-derived YoE (more accurate) over simple oldest-year heuristic
  const yearsExperience = yearsExperienceFromHistory || extractYearsExperience(cleaned);

  // Confidence: 0–100 based on how many key fields were found
  const keyFields  = [name, headline, email, location,
                      skills.length > 0 ? true : null,
                      industries.length > 0 ? true : null,
                      workHistory.length > 0 ? true : null];
  const confidence = Math.round(keyFields.filter(Boolean).length / keyFields.length * 100);

  return {
    name, headline, email, phone, location, country,
    industries, skills, yearsExperience,
    workHistory, avgContractMonths,
    confidence, isLinkedIn: isLI,
  };
}

module.exports = { extractCvProfile };
