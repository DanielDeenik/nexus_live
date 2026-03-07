'use strict';
/**
 * lib/store.js — Zero-key local data store
 *
 * Single JSON file at data/nexus-store.json.
 * Primary data layer — no API keys, no external services required.
 * Notion (when configured) is an optional sync layer on top.
 *
 * API:
 *   store.get(key, default?)  → value
 *   store.set(key, value)     → void
 *   store.merge(key, patch)   → void  (shallow merge into existing object)
 *   store.all()               → full store object
 */

const fs   = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '../data/nexus-store.json');
const TMP_PATH   = STORE_PATH + '.tmp';

// ── Ensure data directory exists ──────────────────────────────────────────────
try {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
} catch {}

// ── Read / write ──────────────────────────────────────────────────────────────

function readAll() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeAll(data) {
  // Atomic write: write to .tmp then rename to avoid corruption on crash
  fs.writeFileSync(TMP_PATH, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(TMP_PATH, STORE_PATH);
}

// ── Public API ────────────────────────────────────────────────────────────────

function get(key, def = null) {
  const data = readAll();
  return key in data ? data[key] : def;
}

function set(key, value) {
  const data = readAll();
  data[key] = value;
  writeAll(data);
}

/** Shallow-merge a patch object into an existing stored object */
function merge(key, patch) {
  const data    = readAll();
  data[key]     = { ...(data[key] || {}), ...patch };
  writeAll(data);
}

function all() {
  return readAll();
}

module.exports = { get, set, merge, all };
