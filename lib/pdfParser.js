'use strict';
/**
 * lib/pdfParser.js — PDF text extraction + contract field parser
 *
 * Uses pdf-parse (via pdfjs-dist fallback) to extract raw text,
 * then applies regex patterns calibrated for:
 *   - Dutch / UK / Canadian freelance contract formats
 *   - JPSB / agency contract formats (based on Dan's history)
 *   - Standard service agreement templates
 *
 * Extracted fields (all optional — returns null if not found):
 *   documentName, client, counterparty, contactName,
 *   hourlyRateEur, dayRateCad, effectiveDate, endDate,
 *   paymentTermsDays, governingLaw, noticePeriod,
 *   keyObligations, keyRisks, docType, rawText
 */

let pdfParse;
try {
  pdfParse = require('pdf-parse');
} catch {
  pdfParse = null;
}

// ── Currency helpers ───────────────────────────────────────────────────────────

const CURRENCY_PATTERNS = [
  // EUR hourly: "€115/hour", "EUR 115 per hour", "€ 115,00 per uur"
  { field: 'hourlyRateEur', currency: 'EUR',
    regex: /(?:EUR|€)\s*(\d[\d,.]*)\s*(?:\/\s*h(?:our|r)?|per\s+(?:hour|uur|h))/gi },
  // EUR day rate: "€920 per day", "EUR 920/dag"
  { field: 'dayRateEur', currency: 'EUR',
    regex: /(?:EUR|€)\s*(\d[\d,.]*)\s*(?:\/\s*d(?:ay|ag)?|per\s+(?:day|dag))/gi },
  // CAD day rate: "CAD 1,150/day", "$1150 per day"
  { field: 'dayRateCad', currency: 'CAD',
    regex: /(?:CAD|\$C?)\s*(\d[\d,.]*)\s*(?:\/\s*day|per\s+day)/gi },
];

// ── Date patterns ──────────────────────────────────────────────────────────────

const DATE_PATTERNS = [
  // ISO: 2026-04-01
  /(\d{4})-(\d{2})-(\d{2})/,
  // European: 01-04-2026, 01/04/2026, 1 April 2026
  /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/,
  // Long form: April 1, 2026 / 1st April 2026
  /(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i,
  /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i,
];

const MONTH_MAP = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

function parseDate(text) {
  if (!text) return null;
  // ISO
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // Long form: 1 April 2026
  const long = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i);
  if (long) return `${long[3]}-${MONTH_MAP[long[2].toLowerCase()]}-${long[1].padStart(2, '0')}`;
  // Month day year
  const mdy = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i);
  if (mdy) return `${mdy[3]}-${MONTH_MAP[mdy[1].toLowerCase()]}-${mdy[2].padStart(2, '0')}`;
  // DD/MM/YYYY
  const dmy = text.match(/\b(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})\b/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
}

// ── Section extractors ─────────────────────────────────────────────────────────

function extractRates(text) {
  const result = {};
  for (const { field, regex } of CURRENCY_PATTERNS) {
    const matches = [...text.matchAll(regex)];
    if (matches.length > 0) {
      // Take the first non-zero match
      for (const m of matches) {
        const raw = m[1].replace(/,/g, '').replace(/\./g, '');
        const n   = parseFloat(raw);
        if (n > 0 && n < 10000) { // sanity range
          result[field] = n;
          break;
        }
      }
    }
  }
  return result;
}

function extractDates(text) {
  // Look for labelled dates
  const effectivePatterns = [
    /(?:effective|commencement|start|ingangsdatum|startdatum)\s*(?:date|datum)?\s*[:\-–]\s*([^\n,;]{5,30})/i,
    /(?:commencing|starting)\s+(?:on|from)\s+([^\n,;]{5,30})/i,
    /(?:from|vanaf)\s+(\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2})/i,
  ];
  const endPatterns = [
    /(?:expiry|expiration|end|termination|einddatum)\s*(?:date|datum)?\s*[:\-–]\s*([^\n,;]{5,30})/i,
    /(?:until|through|ending|to)\s+(\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2})/i,
    /(?:op|until|tot)\s+(\d{1,2}\s+\w+\s+\d{4})/i,
  ];

  let effectiveDate = null, endDate = null;

  for (const p of effectivePatterns) {
    const m = text.match(p);
    if (m) { effectiveDate = parseDate(m[1]); if (effectiveDate) break; }
  }
  for (const p of endPatterns) {
    const m = text.match(p);
    if (m) { endDate = parseDate(m[1]); if (endDate) break; }
  }

  return { effectiveDate, endDate };
}

function extractPaymentTerms(text) {
  const m = text.match(/(?:payment\s*terms?|betaaltermijn|net)\s*[:\-–]?\s*(\d+)\s*(?:days?|dagen)/i);
  return m ? parseInt(m[1]) : null;
}

function extractParties(text) {
  // Client / buyer
  const clientPatterns = [
    /(?:client|opdrachtgever|buyer|hiring\s+party)\s*[:\-–]\s*([A-Z][^\n,;]{2,60})/i,
    /(?:between)\s+(?:[A-Z][a-z]+ ){1,3}\("Contractor"\)\s+and\s+([A-Z][^\n,;]{2,60})\s*\("?(?:Client|Company)/i,
  ];
  const counterpartyPatterns = [
    /(?:agency|intermediair|placement\s+agency|staffing)\s*[:\-–]\s*([A-Z][^\n,;]{2,60})/i,
    /(?:JPSB|intermediary)\b[^\n]{0,20}([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/i,
  ];
  const contactPatterns = [
    /(?:contact|account\s+manager|recruiter|consultant)\s*[:\-–]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i,
  ];

  let client = null, counterparty = null, contact = null;
  for (const p of clientPatterns)      { const m = text.match(p); if (m) { client = m[1].trim().slice(0, 80); break; } }
  for (const p of counterpartyPatterns){ const m = text.match(p); if (m) { counterparty = m[1].trim().slice(0, 80); break; } }
  for (const p of contactPatterns)     { const m = text.match(p); if (m) { contact = m[1].trim().slice(0, 60); break; } }

  return { client, counterparty, contact };
}

function extractGoverningLaw(text) {
  const m = text.match(/(?:governing\s+law|applicable\s+law|jurisdiction)\s*[:\-–]\s*([^\n,;]{3,40})/i);
  return m ? m[1].trim() : null;
}

function extractNoticePeriod(text) {
  const m = text.match(/(?:notice\s*period|opzegtermijn)\s*[:\-–]?\s*(\d+)\s*(days?|weeks?|months?|dagen|weken|maanden)/i);
  if (m) return `${m[1]} ${m[2]}`;
  return null;
}

function extractDocumentType(text) {
  const lower = text.toLowerCase();
  if (lower.includes('statement of work') || lower.includes('sow'))     return 'Statement of Work';
  if (lower.includes('master service') || lower.includes('msa'))         return 'Master Services Agreement';
  if (lower.includes('freelance') || lower.includes('zzp'))              return 'Freelance Agreement';
  if (lower.includes('interim'))                                          return 'Interim Contract';
  if (lower.includes('consulting') || lower.includes('consultancy'))     return 'Consulting Agreement';
  if (lower.includes('non-disclosure') || lower.includes('nda'))         return 'NDA';
  return 'Service Agreement';
}

function extractDocumentName(text) {
  // First non-empty line that looks like a title
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 5 && l.length < 120);
  for (const line of lines.slice(0, 10)) {
    if (/contract|agreement|statement|services|overeenkomst/i.test(line)) {
      return line.slice(0, 100);
    }
  }
  return lines[0]?.slice(0, 100) || null;
}

function extractObligations(text) {
  const m = text.match(/(?:key\s+obligations?|scope\s+of\s+work|deliverables?|werkzaamheden)\s*[:\-–]\s*([^§\n]{10,300})/i);
  return m ? m[1].trim().slice(0, 300) : null;
}

function extractRisks(text) {
  const m = text.match(/(?:key\s+risks?|limitations?|liability|disclaimers?)\s*[:\-–]\s*([^§\n]{10,300})/i);
  return m ? m[1].trim().slice(0, 300) : null;
}

// ── Main parse function ────────────────────────────────────────────────────────

/**
 * Parse a PDF buffer and extract contract fields.
 * @param {Buffer} buffer — PDF file buffer
 * @returns {Promise<object>} extracted fields
 */
async function parsePdf(buffer) {
  if (!pdfParse) {
    throw new Error('pdf-parse not installed. Run: npm install pdf-parse');
  }

  let rawText = '';
  try {
    const data = await pdfParse(buffer, {
      // Don't throw on encrypted/malformed PDFs
      max: 0,
    });
    rawText = data.text || '';
  } catch (err) {
    throw new Error(`PDF parsing failed: ${err.message}`);
  }

  return extractContractFields(rawText);
}

/**
 * Extract contract fields from raw text (also usable without PDF).
 * @param {string} text
 * @returns {object}
 */
function extractContractFields(text) {
  if (!text || typeof text !== 'string') return { rawText: '', confidence: 0 };

  // Normalise whitespace
  const cleaned = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');

  const rates       = extractRates(cleaned);
  const dates       = extractDates(cleaned);
  const parties     = extractParties(cleaned);
  const payTerms    = extractPaymentTerms(cleaned);
  const govLaw      = extractGoverningLaw(cleaned);
  const notice      = extractNoticePeriod(cleaned);
  const docType     = extractDocumentType(cleaned);
  const docName     = extractDocumentName(cleaned);
  const obligations = extractObligations(cleaned);
  const risks       = extractRisks(cleaned);

  // Calculate confidence: how many key fields were extracted
  const keyFields = [
    rates.hourlyRateEur || rates.dayRateEur || rates.dayRateCad,
    dates.effectiveDate, dates.endDate, parties.client, parties.counterparty,
  ];
  const confidence = Math.round(keyFields.filter(Boolean).length / keyFields.length * 100);

  return {
    documentName:   docName,
    client:         parties.client,
    counterparty:   parties.counterparty,
    contactJpsb:    parties.contact,
    hourlyRateEur:  rates.hourlyRateEur    ?? null,
    dayRateEur:     rates.dayRateEur       ?? null,
    dayRateCad:     rates.dayRateCad       ?? null,
    effectiveDate:  dates.effectiveDate,
    endDate:        dates.endDate,
    paymentTermsDays: payTerms,
    governingLaw:   govLaw,
    noticePeriod:   notice,
    docType,
    keyObligations: obligations,
    keyRisks:       risks,
    confidence,
    rawText:        cleaned.slice(0, 2000), // truncated for display only
    fullText:       cleaned,               // full text for profile/SOW extraction
  };
}

module.exports = { parsePdf, extractContractFields };
