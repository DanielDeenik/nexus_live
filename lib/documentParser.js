'use strict';
/**
 * lib/documentParser.js — Universal document text extractor
 *
 * Accepts any of: PDF, DOCX, DOC, XLSX, XLS, ODS, ODP, ODF, RTF, TXT, CSV
 * Returns plain text regardless of input format.
 *
 * Strategy:
 *   .pdf                 → pdf-parse  (already installed)
 *   .docx / .doc         → mammoth    (pure JS, high quality)
 *   .xlsx / .xls / .ods  → officeparser
 *   .rtf                 → officeparser
 *   .txt / .csv / .md    → Buffer.toString() (plain UTF-8)
 *   unknown              → try officeparser → fallback to UTF-8
 *
 * All functions are async and accept a Buffer + filename.
 * Returns: { text: string, format: string, error: string|null }
 */

const path = require('path');

// ── Lazy-load parsers (graceful if not installed) ─────────────────────────────

function loadPdfParse() {
  try { return require('pdf-parse'); } catch { return null; }
}

function loadMammoth() {
  try { return require('mammoth'); } catch { return null; }
}

function loadOfficeParser() {
  try { return require('officeparser'); } catch { return null; }
}

// ── Supported MIME types → canonical format ───────────────────────────────────

const MIME_MAP = {
  'application/pdf':                                                        'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword':                                                     'doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':     'xlsx',
  'application/vnd.ms-excel':                                               'xls',
  'application/vnd.oasis.opendocument.text':                                'odt',
  'application/vnd.oasis.opendocument.spreadsheet':                        'ods',
  'application/rtf':                                                        'rtf',
  'text/rtf':                                                               'rtf',
  'text/plain':                                                             'txt',
  'text/csv':                                                               'csv',
  'text/markdown':                                                          'txt',
};

const EXT_MAP = {
  '.pdf':  'pdf',
  '.docx': 'docx',
  '.doc':  'doc',
  '.xlsx': 'xlsx',
  '.xls':  'xls',
  '.odt':  'odt',
  '.ods':  'ods',
  '.odp':  'odp',
  '.rtf':  'rtf',
  '.txt':  'txt',
  '.csv':  'csv',
  '.md':   'txt',
  '.text': 'txt',
};

/**
 * Detect format from MIME type and/or filename.
 */
function detectFormat(mimetype, filename) {
  if (mimetype && MIME_MAP[mimetype]) return MIME_MAP[mimetype];
  if (filename) {
    const ext = path.extname(filename).toLowerCase();
    if (EXT_MAP[ext]) return EXT_MAP[ext];
  }
  return 'unknown';
}

/**
 * Returns true if this format is supported.
 */
function isSupported(mimetype, filename) {
  return detectFormat(mimetype, filename) !== 'unknown';
}

// ── Per-format extractors ─────────────────────────────────────────────────────

async function extractPdf(buffer) {
  const pdfParse = loadPdfParse();
  if (!pdfParse) throw new Error('pdf-parse not installed');
  const result = await pdfParse(buffer);
  return result.text || '';
}

async function extractDocx(buffer) {
  const mammoth = loadMammoth();
  if (!mammoth) throw new Error('mammoth not installed');
  const result = await mammoth.extractRawText({ buffer });
  return result.value || '';
}

async function extractOffice(buffer, filename) {
  const { parseOffice } = loadOfficeParser();
  if (!parseOffice) throw new Error('officeparser not installed');
  return new Promise((resolve, reject) => {
    parseOffice(buffer, (text, err) => {
      if (err) reject(err);
      else resolve(text || '');
    }, { outputErrorToConsole: false });
  });
}

function extractPlainText(buffer) {
  return buffer.toString('utf8');
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Extract plain text from any supported document buffer.
 *
 * @param {Buffer}  buffer    — File buffer (from multer memory storage)
 * @param {string}  filename  — Original filename (used for format detection)
 * @param {string}  [mimetype] — MIME type from upload (optional, used first)
 * @returns {Promise<{ text: string, format: string, error: string|null }>}
 */
async function extractText(buffer, filename, mimetype) {
  const format = detectFormat(mimetype, filename);

  try {
    let text = '';

    switch (format) {
      case 'pdf':
        text = await extractPdf(buffer);
        break;

      case 'docx':
        text = await extractDocx(buffer);
        break;

      case 'doc':
        // Try mammoth first (handles some .doc), fall back to officeparser
        try {
          text = await extractDocx(buffer);
        } catch {
          text = await extractOffice(buffer, filename);
        }
        break;

      case 'xlsx':
      case 'xls':
      case 'ods':
      case 'odt':
      case 'odp':
      case 'rtf':
        text = await extractOffice(buffer, filename);
        break;

      case 'txt':
      case 'csv':
        text = extractPlainText(buffer);
        break;

      default:
        // Best-effort: try officeparser, fall back to UTF-8
        try {
          text = await extractOffice(buffer, filename);
        } catch {
          text = extractPlainText(buffer);
        }
    }

    return { text: text.trim(), format, error: null };

  } catch (err) {
    // Last-resort fallback: treat as plain text
    const fallback = buffer.toString('utf8').replace(/[^\x20-\x7E\n\r\t]/g, ' ').trim();
    return {
      text:   fallback,
      format,
      error:  `Parser failed (${err.message}) — used text fallback`,
    };
  }
}

// ── Multer file filter ─────────────────────────────────────────────────────────

/**
 * Express/multer fileFilter that accepts all supported document formats.
 * Drop-in replacement for the old PDF-only filter.
 */
function documentFileFilter(_req, file, cb) {
  const format = detectFormat(file.mimetype, file.originalname);
  if (format !== 'unknown') {
    cb(null, true);
  } else {
    cb(new Error(
      `Unsupported file type: ${path.extname(file.originalname) || file.mimetype}. ` +
      'Accepted: PDF, Word (DOCX/DOC), Excel (XLSX), OpenDocument, RTF, TXT, CSV'
    ));
  }
}

/**
 * Human-readable list of accepted extensions for the error message above.
 */
const ACCEPTED_EXTENSIONS = Object.keys(EXT_MAP).join(', ');

module.exports = {
  extractText,
  detectFormat,
  isSupported,
  documentFileFilter,
  ACCEPTED_EXTENSIONS,
  MIME_MAP,
  EXT_MAP,
};
