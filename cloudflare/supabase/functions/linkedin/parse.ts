// LinkedIn insights: pure parsing. Everything here is deterministic and
// network free so it can be tested with synthetic fixtures. Sheet names,
// column headers, file names, keyword lists and date order all arrive in a
// LinkedInConfig built from app_config; nothing about the export layout is
// fixed in code, so a renamed sheet or column is a config change.
import { strFromU8, unzipSync } from "npm:fflate@0.8.2";

export type Kind = "content" | "archive" | "screenshot";
export type Cell = string;
export type Grid = Cell[][];

export interface LinkedInConfig {
  contentSheets: Record<string, string[]>;
  contentColumns: Record<string, string[]>;
  demographicDimensions: Record<string, string>;
  archiveFiles: Record<string, string[]>;
  archiveColumns: Record<string, Record<string, string[]>>;
  sentFolders: string[];
  recruiterKeywords: string[];
  recruiterMessageFields: string[];
  snippetMaxChars: number;
  dateOrder: "MDY" | "DMY";
  imageExtensions: string[];
  limits: ArchiveLimits;
}

/** Caps that keep a hostile or broken file from exhausting memory. */
export interface ArchiveLimits { maxEntryBytes: number; maxSheetRows: number; maxSheetCols: number }

/** Builds the typed config from app_config rows; a missing key throws, so a
 *  broken seed is loud instead of silently parsing nothing. */
export function linkedinConfig(cfg: Record<string, string>): LinkedInConfig {
  const j = <T>(k: string): T => {
    if (cfg[k] === undefined) throw new Error(`app_config ${k} is missing`);
    return JSON.parse(cfg[k]) as T;
  };
  const n = Number(cfg["linkedin.snippet_max_chars"]);
  if (!Number.isFinite(n)) throw new Error("app_config linkedin.snippet_max_chars missing or not a number");
  const order = cfg["linkedin.date_order"];
  if (order !== "MDY" && order !== "DMY") throw new Error("app_config linkedin.date_order must be MDY or DMY");
  return {
    contentSheets: j("linkedin.content_sheets"),
    contentColumns: j("linkedin.content_columns"),
    demographicDimensions: j("linkedin.demographic_dimensions"),
    archiveFiles: j("linkedin.archive_files"),
    archiveColumns: j("linkedin.archive_columns"),
    sentFolders: j("linkedin.sent_folders"),
    recruiterKeywords: j("linkedin.recruiter_keywords"),
    recruiterMessageFields: j("linkedin.recruiter_message_fields"),
    snippetMaxChars: n,
    dateOrder: order,
    imageExtensions: j("linkedin.image_extensions"),
    limits: j("linkedin.parse_limits"),
  };
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();
const base = (p: string) => p.split("/").pop() ?? p;

/** Lowercased full name with collapsed spaces, for joining people by name. */
export const nameKey = (s: string) => norm(s);

/** Canonical form of a LinkedIn profile URL for joining senders to connections. */
export function urlKey(u: string | null | undefined): string {
  const s = clean(u).toLowerCase();
  if (!s) return "";
  return s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
}

export function toInt(v: string | undefined): number | null {
  const s = clean(v).replace(/[,\s]/g, "");
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}

/** Percentages as a fraction. "12%" and "0.12" both give 0.12; a bound such
 *  as "< 1%" gives null because the exact value is not in the export. */
export function toPct(v: string | undefined): number | null {
  const s = clean(v);
  if (!s || /[<>]/.test(s)) return null;
  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1).replace(",", "."));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(s.replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  mrt: 3, mei: 5, okt: 10,
};
const iso = (y: number, m: number, d: number) => {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
};

/** A calendar date from the forms LinkedIn exports use: ISO, "12 Oct 2025",
 *  "Oct 12, 2025", slashed dates in the configured order, or an Excel serial. */
export function parseDate(v: string | undefined, order: "MDY" | "DMY"): string | null {
  const s = clean(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) return order === "MDY" ? iso(+m[3], +m[1], +m[2]) : iso(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3})[A-Za-z]*\.?[\s-]+(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = s.match(/^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    // Excel serials for 1960 to 2100; anything else is not a date.
    if (serial > 21916 && serial < 73051) return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
  }
  return null;
}

/** A timestamp from messages.csv ("2025-10-01 09:15:31 UTC") or any form
 *  Date understands; null when unreadable. */
export function parseTimestamp(v: string | undefined): string | null {
  const s = clean(v);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(UTC|Z)?$/i);
  const d = m ? new Date(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}Z`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Two dates in one text, as in "10/13/2024 - 10/11/2025". */
export function parseRange(v: string, order: "MDY" | "DMY"): { from: string; to: string } | null {
  const parts = clean(v).split(/\s+(?:-|to|tot)\s+/i);
  if (parts.length !== 2) return null;
  const from = parseDate(parts[0], order);
  const to = parseDate(parts[1], order);
  return from && to ? { from, to } : null;
}

// ---------------------------------------------------------------------------
// Recruiter detection
// ---------------------------------------------------------------------------

/** Deterministic keyword match: a keyword counts when it starts a word, so
 *  "recruiter" matches "Recruiters" but "staffing" does not match inside
 *  another word. Returns the keywords found. */
export function recruiterHits(text: string | null | undefined, keywords: string[]): string[] {
  const t = norm(text ?? "");
  if (!t) return [];
  const hits: string[] = [];
  for (const k of keywords) {
    const kw = norm(k);
    if (!kw) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u");
    if (re.test(t)) hits.push(k);
  }
  return hits;
}

export const isRecruiter = (text: string | null | undefined, keywords: string[]) => recruiterHits(text, keywords).length > 0;

// ---------------------------------------------------------------------------
// Containers: zip and xlsx
// ---------------------------------------------------------------------------

const isZip = (b: Uint8Array) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);
const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Names inside a zip without inflating anything. */
export function zipNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(bytes, { filter: (f) => { names.push(f.name); return false; } });
  return names;
}

export function imageMediaType(name: string, bytes: Uint8Array): string | null {
  if (isPng(bytes)) return "image/png";
  if (isJpeg(bytes)) return "image/jpeg";
  return null;
}

/** What an uploaded file is, from its bytes first and its name second:
 *  an xlsx workbook is the content export, a zip holding any configured
 *  archive file is the data archive, a PNG or JPEG is a screenshot. */
export function detectKind(name: string, bytes: Uint8Array, cfg: LinkedInConfig): Kind | null {
  if (isPng(bytes) || isJpeg(bytes)) return "screenshot";
  if (isZip(bytes)) {
    const names = zipNames(bytes);
    if (names.some((n) => n.toLowerCase() === "xl/workbook.xml")) return "content";
    const wanted = new Set(Object.values(cfg.archiveFiles).flat().map((f) => f.toLowerCase()));
    if (names.some((n) => wanted.has(base(n).toLowerCase()))) return "archive";
    return null;
  }
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (cfg.imageExtensions.map((e) => e.toLowerCase()).includes(ext)) return "screenshot";
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? `&${e};`);
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join("");
const attr = (tag: string, a: string) => tag.match(new RegExp(`\\s${a}="([^"]*)"`))?.[1];

function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Minimal xlsx reader: every sheet as a grid of strings, keyed by sheet
 *  name. Handles shared strings, inline strings, numbers and booleans, and
 *  keeps cell positions so offset header rows stay where they are. */
export function readXlsx(bytes: Uint8Array, limits: ArchiveLimits): Map<string, Grid> {
  const files = unzipSync(bytes, { filter: (f) => {
    if (!(f.name.startsWith("xl/") && f.name.endsWith(".xml") || f.name.endsWith(".rels"))) return false;
    if (f.originalSize > limits.maxEntryBytes) throw new Error(`${f.name} unpacks to more than linkedin.parse_limits.maxEntryBytes`);
    return true;
  } });
  const get = (p: string) => (files[p] ? strFromU8(files[p]) : "");
  const shared = [...get("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rels = new Map<string, string>();
  for (const m of get("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const out = new Map<string, Grid>();
  for (const m of get("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)) {
    const name = unxml(attr(m[0], "name") ?? "");
    const rid = attr(m[0], "r:id");
    const path = rid ? rels.get(rid) : undefined;
    if (!path) continue;
    const grid: Grid = [];
    for (const row of get(path).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = Number(attr(`<row${row[1]}>`, "r") ?? grid.length + 1) - 1;
      if (!Number.isInteger(r) || r < 0 || r >= limits.maxSheetRows) throw new Error(`sheet ${name} has a row beyond linkedin.parse_limits.maxSheetRows`);
      const cells: Cell[] = [];
      for (const c of (row[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const head = `<c${c[1]}>`;
        const ref = attr(head, "r");
        const idx = ref ? colIndex(ref) : cells.length;
        if (idx < 0 || idx >= limits.maxSheetCols) throw new Error(`sheet ${name} has a column beyond linkedin.parse_limits.maxSheetCols`);
        const t = attr(head, "t");
        const body = c[2] ?? "";
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let val = "";
        if (t === "s") val = v !== undefined ? shared[Number(v)] ?? "" : "";
        else if (t === "inlineStr") val = textOf(body);
        else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
        else val = v !== undefined ? unxml(v) : "";
        while (cells.length < idx) cells.push("");
        cells[idx] = val;
      }
      while (grid.length < r) grid.push([]);
      grid[r] = cells;
    }
    out.set(name, grid);
  }
  return out;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, line breaks inside quotes. */
export function parseCsv(text: string): Grid {
  const rows: Grid = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { f += '"'; i++; } else q = false;
      } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(f); rows.push(row); row = []; f = "";
    } else f += ch;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// Header location
// ---------------------------------------------------------------------------

export interface Header {
  row: number;
  cols: Record<string, number>;
}

const matches = (cell: string, aliases: string[]) => {
  const c = norm(cell);
  return aliases.some((a) => norm(a) === c);
};

/** Finds the first row holding every required column (by alias), so
 *  preamble lines and offset headers do not matter. Optional columns are
 *  picked up when present. */
export function findHeader(grid: Grid, map: Record<string, string[]>, required: string[], from = 0): Header | null {
  for (let r = from; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const cols: Record<string, number> = {};
    for (const [key, aliases] of Object.entries(map)) {
      const i = row.findIndex((c) => matches(c ?? "", aliases));
      if (i >= 0) cols[key] = i;
    }
    if (required.every((k) => cols[k] !== undefined)) return { row: r, cols };
  }
  return null;
}

function sheetFor(sheets: Map<string, Grid>, aliases: string[] | undefined): Grid | null {
  if (!aliases) return null;
  for (const [name, g] of sheets) if (matches(name, aliases)) return g;
  return null;
}

// ---------------------------------------------------------------------------
// Content analytics export (.xlsx)
// ---------------------------------------------------------------------------

export interface ContentDay { day: string; impressions?: number | null; engagements?: number | null; new_followers?: number | null }
export interface ContentPost { url: string; published_on: string | null; impressions?: number | null; engagements?: number | null }
export interface AudienceRow { dimension: string; value: string; pct: number | null; pct_label: string }

export interface ContentExport {
  period: { from: string; to: string } | null;
  discovery: { impressions: number | null; members_reached: number | null };
  days: ContentDay[];
  posts: ContentPost[];
  followersTotal: { as_of: string | null; total: number } | null;
  audience: AudienceRow[];
  sheetsFound: string[];
  warnings: string[];
}

/** Value in the cell right of the first cell matching a label, scanning
 *  the whole sheet: DISCOVERY and FOLLOWERS hold label and value pairs. */
function labelled(grid: Grid, aliases: string[] | undefined, prefix = false): { label: string; value: string } | null {
  if (!aliases?.length) return null;
  for (const row of grid) {
    for (let i = 0; i < (row?.length ?? 0); i++) {
      const c = norm(row[i] ?? "");
      if (!c) continue;
      const hit = aliases.some((a) => (prefix ? c.startsWith(norm(a)) : c === norm(a)));
      if (!hit) continue;
      const next = row.slice(i + 1).find((x) => clean(x) !== "");
      return { label: clean(row[i]), value: clean(next) };
    }
  }
  return null;
}

export function parseContentExport(bytes: Uint8Array, cfg: LinkedInConfig): ContentExport {
  const sheets = readXlsx(bytes, cfg.limits);
  const S = cfg.contentSheets;
  const C = cfg.contentColumns;
  const order = cfg.dateOrder;
  const warnings: string[] = [];
  const found: string[] = [];
  const sheet = (k: string) => {
    const g = sheetFor(sheets, S[k]);
    if (g) found.push(k); else warnings.push(`sheet ${k} not found (looked for ${(S[k] ?? []).join(", ")})`);
    return g;
  };

  // Discovery: overall period and totals.
  let period: ContentExport["period"] = null;
  const discovery = { impressions: null as number | null, members_reached: null as number | null };
  const disc = sheet("discovery");
  if (disc) {
    const p = labelled(disc, C.overall);
    if (p) period = parseRange(p.value, order) ?? parseRange(p.label, order);
    if (!period) {
      for (const row of disc) for (const c of row ?? []) period ??= parseRange(c ?? "", order);
    }
    discovery.impressions = toInt(labelled(disc, C.impressions)?.value);
    discovery.members_reached = toInt(labelled(disc, C.members_reached)?.value);
  }

  // Daily impressions and engagements, and daily new followers, merged by day.
  const byDay = new Map<string, ContentDay>();
  const dayRow = (d: string) => byDay.get(d) ?? byDay.set(d, { day: d }).get(d)!;
  const eng = sheet("engagement");
  if (eng) {
    const h = findHeader(eng, { date: C.date, impressions: C.impressions, engagements: C.engagements }, ["date"]);
    if (!h) warnings.push("engagement header row not found");
    else {
      for (const row of eng.slice(h.row + 1)) {
        const d = parseDate(row?.[h.cols.date], order);
        if (!d) continue;
        const r = dayRow(d);
        if (h.cols.impressions !== undefined) r.impressions = toInt(row[h.cols.impressions]) ?? 0;
        if (h.cols.engagements !== undefined) r.engagements = toInt(row[h.cols.engagements]) ?? 0;
      }
    }
  }
  let followersTotal: ContentExport["followersTotal"] = null;
  const fol = sheet("followers");
  if (fol) {
    const t = labelled(fol, C.total_followers, true);
    const total = toInt(t?.value);
    if (t && total !== null) {
      const inLabel = t.label.match(/(\d{1,4}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2})/)?.[1];
      followersTotal = { as_of: parseDate(inLabel, order) ?? period?.to ?? null, total };
    }
    const h = findHeader(fol, { date: C.date, new_followers: C.new_followers }, ["date", "new_followers"]);
    if (!h) warnings.push("followers header row not found");
    else {
      for (const row of fol.slice(h.row + 1)) {
        const d = parseDate(row?.[h.cols.date], order);
        if (d) dayRow(d).new_followers = toInt(row[h.cols.new_followers]) ?? 0;
      }
    }
  }
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  if (!period && days.length) period = { from: days[0].day, to: days[days.length - 1].day };
  if (followersTotal && !followersTotal.as_of) followersTotal.as_of = period?.to ?? null;

  // Top posts: LinkedIn puts two tables side by side (by engagements, by
  // impressions), each starting with a Post URL column. Every block is read
  // and merged per URL.
  const posts = new Map<string, ContentPost>();
  const top = sheet("top_posts");
  if (top) {
    const urlAliases = C.post_url ?? [];
    const hr = top.findIndex((row) => (row ?? []).some((c) => matches(c ?? "", urlAliases)));
    if (hr < 0) warnings.push("top posts header row not found");
    else {
      const head = top[hr];
      const starts = head.map((c, i) => (matches(c ?? "", urlAliases) ? i : -1)).filter((i) => i >= 0);
      starts.forEach((s, bi) => {
        const end = starts[bi + 1] ?? head.length;
        const block = head.slice(s, end);
        const at = (key: string) => {
          const i = block.findIndex((c) => matches(c ?? "", C[key] ?? []));
          return i >= 0 ? s + i : -1;
        };
        const iPub = at("published_on"), iImp = at("impressions"), iEng = at("engagements");
        for (const row of top.slice(hr + 1)) {
          const url = clean(row?.[s]);
          if (!/^https?:\/\//i.test(url)) continue;
          const p = posts.get(url) ?? { url, published_on: null };
          if (iPub >= 0) p.published_on = parseDate(row[iPub], order) ?? p.published_on;
          if (iImp >= 0) p.impressions = toInt(row[iImp]);
          if (iEng >= 0) p.engagements = toInt(row[iEng]);
          posts.set(url, p);
        }
      });
    }
  }

  // Demographics: dimension label, value, percentage.
  const audience: AudienceRow[] = [];
  const dem = sheet("demographics");
  if (dem) {
    const h = findHeader(dem, { dimension: C.dimension, value: C.value, pct: C.pct }, ["dimension", "value", "pct"]);
    if (!h) warnings.push("demographics header row not found");
    else {
      const seen = new Set<string>();
      for (const row of dem.slice(h.row + 1)) {
        const label = clean(row?.[h.cols.dimension]);
        const value = clean(row?.[h.cols.value]);
        if (!label || !value) continue;
        const dimension = Object.entries(cfg.demographicDimensions).find(([k]) => norm(k) === norm(label))?.[1]
          ?? norm(label).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        const key = `${dimension}|${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const raw = clean(row[h.cols.pct]);
        audience.push({ dimension, value, pct: toPct(raw), pct_label: raw });
      }
    }
  }

  return { period, discovery, days, posts: [...posts.values()], followersTotal, audience, sheetsFound: found, warnings };
}

// ---------------------------------------------------------------------------
// Data archive (.zip)
// ---------------------------------------------------------------------------

export interface Connection {
  name: string;
  profile_url: string | null;
  company: string | null;
  position: string | null;
  connected_on: string | null;
  is_recruiter: boolean;
}

export interface InboundMessage {
  msg_key: string;
  conversation_id: string | null;
  sent_at: string;
  sender_name: string;
  sender_profile_url: string | null;
  company: string | null;
  subject: string | null;
  snippet: string | null;
  is_recruiter: boolean;
}

export interface ArchiveImport {
  self: { name: string | null; source: "profile" | "sent_folder" | "conversations" | null };
  connections: Connection[];
  messages: InboundMessage[];
  invitations: { inbound: number; inbound_recruiter: number };
  filesFound: string[];
  skipped: { own_messages: number; unreadable: number };
  period: { from: string; to: string } | null;
  warnings: string[];
}

type Rows = { header: Header; rows: Grid } | null;

function table(files: Record<string, Uint8Array>, names: string[] | undefined, cols: Record<string, string[]> | undefined, required: string[]): Rows {
  if (!names || !cols) return null;
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const hit = Object.keys(files).find((p) => wanted.has(base(p).toLowerCase()));
  if (!hit) return null;
  const grid = parseCsv(strFromU8(files[hit]));
  const header = findHeader(grid, cols, required);
  if (!header) return null;
  return { header, rows: grid.slice(header.row + 1).filter((r) => r.some((c) => clean(c) !== "")) };
}

const at = (t: NonNullable<Rows>, row: string[], key: string) => {
  const i = t.header.cols[key];
  return i === undefined ? "" : clean(row[i]);
};

/** The archive owner's own name: Profile.csv first; else the most frequent
 *  sender in the sent folders; else whoever appears in the most
 *  conversations (the owner is in every one of them). */
export function identifySelf(
  profileName: string | null,
  messages: { conversation_id: string; from: string; to: string; folder: string }[],
  sentFolders: string[],
): ArchiveImport["self"] {
  if (profileName && clean(profileName)) return { name: clean(profileName), source: "profile" };
  const sent = new Set(sentFolders.map(norm));
  const counts = new Map<string, number>();
  for (const m of messages) if (m.from && sent.has(norm(m.folder))) counts.set(m.from, (counts.get(m.from) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) return { name: top[0], source: "sent_folder" };
  const convs = new Map<string, Set<string>>();
  for (const m of messages) {
    for (const who of [m.from, ...m.to.split(",")].map(clean).filter(Boolean)) {
      const k = nameKey(who);
      (convs.get(k) ?? convs.set(k, new Set()).get(k)!).add(m.conversation_id);
    }
  }
  const best = [...convs.entries()].sort((a, b) => b[1].size - a[1].size)[0];
  if (!best || best[1].size < 2) return { name: null, source: null };
  const display = messages.find((m) => nameKey(m.from) === best[0])?.from ?? best[0];
  return { name: display, source: "conversations" };
}

/** Short stable key for one message: conversation, time and sender. */
export async function messageKey(conversationId: string, sentAt: string, sender: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${conversationId}|${sentAt}|${nameKey(sender)}`));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function snippetOf(text: string | null | undefined, max: number): string | null {
  const s = clean(text);
  if (!s) return null;
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 3)).trimEnd() + "...";
}

export async function parseArchive(bytes: Uint8Array, cfg: LinkedInConfig): Promise<ArchiveImport> {
  const wanted = new Set(Object.values(cfg.archiveFiles).flat().map((f) => f.toLowerCase()));
  const files = unzipSync(bytes, { filter: (f) => {
    if (!wanted.has(base(f.name).toLowerCase())) return false;
    if (f.originalSize > cfg.limits.maxEntryBytes) throw new Error(`${f.name} unpacks to more than linkedin.parse_limits.maxEntryBytes`);
    return true;
  } });
  const F = cfg.archiveFiles;
  const A = cfg.archiveColumns;
  const warnings: string[] = [];
  const kw = cfg.recruiterKeywords;

  const conT = table(files, F.connections, A.connections, ["first_name", "last_name"]);
  const msgT = table(files, F.messages, A.messages, ["from", "date"]);
  const invT = table(files, F.invitations, A.invitations, ["from"]);
  const proT = table(files, F.profile, A.profile, ["first_name", "last_name"]);
  const filesFound = [conT && "connections", msgT && "messages", invT && "invitations", proT && "profile"].filter(Boolean) as string[];
  if (!conT) warnings.push("connections file not found or header not recognised");
  if (!msgT) warnings.push("messages file not found or header not recognised");

  // Connections: no email addresses are read or kept.
  const connections: Connection[] = [];
  const byUrl = new Map<string, Connection>();
  const byName = new Map<string, Connection | null>();
  for (const row of conT?.rows ?? []) {
    const name = clean(`${at(conT!, row, "first_name")} ${at(conT!, row, "last_name")}`);
    if (!name) continue;
    const position = at(conT!, row, "position") || null;
    const c: Connection = {
      name,
      profile_url: at(conT!, row, "url") || null,
      company: at(conT!, row, "company") || null,
      position,
      connected_on: parseDate(at(conT!, row, "connected_on"), cfg.dateOrder),
      is_recruiter: isRecruiter(position, kw),
    };
    connections.push(c);
    if (c.profile_url) byUrl.set(urlKey(c.profile_url), c);
    const nk = nameKey(name);
    byName.set(nk, byName.has(nk) ? null : c); // ambiguous names never join
  }

  // Messages: identify the owner, keep inbound metadata only.
  const raw = (msgT?.rows ?? []).map((row) => ({
    conversation_id: at(msgT!, row, "conversation_id"),
    from: at(msgT!, row, "from"),
    sender_url: at(msgT!, row, "sender_url"),
    to: at(msgT!, row, "to"),
    date: at(msgT!, row, "date"),
    subject: at(msgT!, row, "subject"),
    content: at(msgT!, row, "content"),
    folder: at(msgT!, row, "folder"),
  }));
  const profileName = proT?.rows[0] ? clean(`${at(proT, proT.rows[0], "first_name")} ${at(proT, proT.rows[0], "last_name")}`) : null;
  const self = identifySelf(profileName, raw, cfg.sentFolders);
  if (!self.name && raw.length) warnings.push("could not identify the archive owner; no messages were stored");
  const selfKey = self.name ? nameKey(self.name) : null;
  const selfUrls = new Set(raw.filter((m) => selfKey && nameKey(m.from) === selfKey && m.sender_url).map((m) => urlKey(m.sender_url)));

  const messages: InboundMessage[] = [];
  const seen = new Set<string>();
  let own = 0, unreadable = 0;
  for (const m of raw) {
    if (!selfKey) break;
    if (!m.from) { unreadable++; continue; }
    if (nameKey(m.from) === selfKey || (m.sender_url && selfUrls.has(urlKey(m.sender_url)))) { own++; continue; }
    const sent_at = parseTimestamp(m.date);
    if (!sent_at) { unreadable++; continue; }
    const conn = (m.sender_url && byUrl.get(urlKey(m.sender_url))) || byName.get(nameKey(m.from)) || null;
    const fields: Record<string, string> = { subject: m.subject, content: m.content, conversation_title: "" };
    const textHit = cfg.recruiterMessageFields.some((f) => isRecruiter(fields[f] ?? "", kw));
    const msg_key = await messageKey(m.conversation_id, sent_at, m.from);
    if (seen.has(msg_key)) continue;
    seen.add(msg_key);
    messages.push({
      msg_key,
      conversation_id: m.conversation_id || null,
      sent_at,
      sender_name: m.from,
      sender_profile_url: m.sender_url || null,
      company: conn?.company ?? null,
      subject: snippetOf(m.subject, cfg.snippetMaxChars),
      snippet: snippetOf(m.content, cfg.snippetMaxChars),
      is_recruiter: !!conn?.is_recruiter || textHit,
    });
  }

  // Invitations: counted only.
  let inbound = 0, inboundRecruiter = 0;
  for (const row of invT?.rows ?? []) {
    const dir = at(invT!, row, "direction");
    const from = at(invT!, row, "from");
    const incoming = dir ? /^in/i.test(dir) : !!selfKey && nameKey(from) !== selfKey;
    if (!incoming) continue;
    inbound++;
    const conn = byName.get(nameKey(from));
    if (conn?.is_recruiter || isRecruiter(at(invT!, row, "message"), kw)) inboundRecruiter++;
  }

  const dates = [...connections.map((c) => c.connected_on).filter(Boolean) as string[], ...messages.map((m) => m.sent_at.slice(0, 10))].sort();
  const period = dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null;
  return {
    self,
    connections,
    messages,
    invitations: { inbound, inbound_recruiter: inboundRecruiter },
    filesFound,
    skipped: { own_messages: own, unreadable },
    period,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Profile analytics screenshots (read by the model, checked here)
// ---------------------------------------------------------------------------

export interface Counted { label: string; count: number | null }
export interface ScreenshotReading {
  kind: "views" | "search" | "unknown";
  period_label: string | null;
  period_days: number | null;
  total: number | null;
  change_pct: number | null;
  viewer_titles: Counted[];
  viewer_companies: Counted[];
  viewer_locations: Counted[];
  appeared_where: Counted[];
  keywords: Counted[];
  searcher_companies: Counted[];
  searcher_titles: Counted[];
}

const LISTS = ["viewer_titles", "viewer_companies", "viewer_locations", "appeared_where", "keywords", "searcher_companies", "searcher_titles"] as const;

export const screenshotTool = {
  name: "record_linkedin_screenshot",
  description: "Record only what is visible in a LinkedIn profile analytics screenshot.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["views", "search", "unknown"], description: "views for Who viewed your profile, search for Search appearances" },
      period_label: { type: ["string", "null"], description: "The period exactly as shown, for example Past 90 days" },
      period_days: { type: ["integer", "null"], description: "Number of days in the period when the label states it" },
      total: { type: ["integer", "null"], description: "The headline number of views or appearances" },
      change_pct: { type: ["number", "null"], description: "Change shown next to the total, in percent, negative for a drop" },
      ...Object.fromEntries(LISTS.map((k) => [k, {
        type: "array",
        items: { type: "object", properties: { label: { type: "string" }, count: { type: ["integer", "null"] } }, required: ["label", "count"] },
      }])),
    },
    required: ["kind", "period_label", "period_days", "total", "change_pct", ...LISTS],
  },
};

/** Deterministic check of what the model returned: types coerced, empty or
 *  duplicate labels dropped, negative counts rejected. */
export function cleanReading(v: unknown): ScreenshotReading {
  const o = (v ?? {}) as Record<string, unknown>;
  const int = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x) : typeof x === "string" ? toInt(x) : null);
  const list = (x: unknown): Counted[] => {
    if (!Array.isArray(x)) return [];
    const seen = new Set<string>();
    const out: Counted[] = [];
    for (const it of x) {
      const label = clean((it as { label?: string })?.label);
      if (!label || seen.has(norm(label))) continue;
      seen.add(norm(label));
      const c = int((it as { count?: unknown })?.count);
      out.push({ label, count: c !== null && c >= 0 ? c : null });
    }
    return out;
  };
  const kind = o.kind === "views" || o.kind === "search" ? o.kind : "unknown";
  const pct = typeof o.change_pct === "number" && Number.isFinite(o.change_pct) ? o.change_pct : null;
  return {
    kind,
    period_label: clean(o.period_label as string) || null,
    period_days: int(o.period_days),
    total: int(o.total),
    change_pct: pct,
    ...Object.fromEntries(LISTS.map((k) => [k, list(o[k])])) as Pick<ScreenshotReading, typeof LISTS[number]>,
  };
}
