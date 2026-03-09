/**
 * lib/db.js — Pure-JS SQLite via sql.js, multi-user, no native bindings
 *
 * Schema:
 *   users       — identity, OAuth IDs, magic-link tokens
 *   profiles    — synthesized SearchProfile JSON per user
 *   configs     — rates, availability, preferences per user
 *   files       — CV/SOW blobs + extracted text
 *   rate_cache  — market rate benchmarks (7-day TTL)
 *   season_cache— seasonality data per industry/location (7-day TTL)
 */

const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'nexus.db');
const WAL_KEY  = '__wal__';

let _db   = null;   // sql.js Database instance
let _dirty = false; // track unsaved changes

// ─── Schema ────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT    UNIQUE,
  name           TEXT,
  password_hash  TEXT,
  linkedin_id    TEXT    UNIQUE,
  google_id      TEXT    UNIQUE,
  avatar_url     TEXT,
  magic_token    TEXT,
  magic_expires  INTEGER,
  created_at     INTEGER DEFAULT (strftime('%s','now')),
  last_login     INTEGER,
  plan           TEXT    DEFAULT 'free'
);

CREATE TABLE IF NOT EXISTS profiles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data         TEXT    NOT NULL DEFAULT '{}',
  confidence   INTEGER DEFAULT 0,
  updated_at   INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS configs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT    NOT NULL DEFAULT '{}',
  updated_at INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS files (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           TEXT    NOT NULL,
  filename       TEXT    NOT NULL,
  mime_type      TEXT,
  size           INTEGER,
  buffer         BLOB,
  extracted_text TEXT,
  uploaded_at    INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS rate_cache (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_key  TEXT    NOT NULL,
  currency   TEXT    DEFAULT 'EUR',
  daily_low  INTEGER,
  daily_mid  INTEGER,
  daily_high INTEGER,
  sources    TEXT,
  scraped_at INTEGER DEFAULT (strftime('%s','now')),
  expires_at INTEGER,
  UNIQUE(skill_key, currency)
);

CREATE TABLE IF NOT EXISTS season_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  industry_key TEXT    NOT NULL,
  location     TEXT    DEFAULT 'NL',
  data         TEXT    NOT NULL,
  source       TEXT    DEFAULT 'trends',
  scraped_at   INTEGER DEFAULT (strftime('%s','now')),
  expires_at   INTEGER,
  UNIQUE(industry_key, location)
);
`;

// ─── Init ───────────────────────────────────────────────────────────────────

async function init() {
  if (_db) return _db;

  const SQL = await initSqlJs();

  // Load existing DB from disk if it exists
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }

  _db.run(SCHEMA);
  _persist();  // write fresh/empty schema to disk
  return _db;
}

// ─── Persist to disk ────────────────────────────────────────────────────────

function _persist() {
  if (!_db) return;
  try {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    _dirty = false;
  } catch (e) {
    console.warn('[db] persist failed:', e.message);
  }
}

// Auto-persist every 5 seconds if dirty
setInterval(() => { if (_dirty) _persist(); }, 5000);

// ─── Low-level helpers ──────────────────────────────────────────────────────

function run(sql, params = []) {
  _db.run(sql, params);
  _dirty = true;
}

function get(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const results = [];
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

// ─── Users ──────────────────────────────────────────────────────────────────

const users = {
  findById(id) {
    return get('SELECT * FROM users WHERE id = ?', [id]);
  },

  findByEmail(email) {
    return get('SELECT * FROM users WHERE email = ?', [email?.toLowerCase()]);
  },

  findByLinkedIn(linkedinId) {
    return get('SELECT * FROM users WHERE linkedin_id = ?', [linkedinId]);
  },

  findByGoogle(googleId) {
    return get('SELECT * FROM users WHERE google_id = ?', [googleId]);
  },

  findByMagicToken(token) {
    const now = Math.floor(Date.now() / 1000);
    return get(
      'SELECT * FROM users WHERE magic_token = ? AND magic_expires > ?',
      [token, now]
    );
  },

  create({ email, name, password_hash, linkedin_id, google_id, avatar_url } = {}) {
    run(
      `INSERT INTO users (email, name, password_hash, linkedin_id, google_id, avatar_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [email?.toLowerCase() || null, name || null, password_hash || null,
       linkedin_id || null, google_id || null, avatar_url || null]
    );
    const row = get('SELECT last_insert_rowid() AS id FROM users');
    return users.findById(row.id);
  },

  upsertLinkedIn({ linkedin_id, email, name, avatar_url }) {
    const existing = users.findByLinkedIn(linkedin_id)
      || (email && users.findByEmail(email));
    if (existing) {
      run(
        `UPDATE users SET linkedin_id=?, name=COALESCE(?,name), avatar_url=COALESCE(?,avatar_url),
         last_login=strftime('%s','now') WHERE id=?`,
        [linkedin_id, name, avatar_url, existing.id]
      );
      return users.findById(existing.id);
    }
    return users.create({ email, name, linkedin_id, avatar_url });
  },

  upsertGoogle({ google_id, email, name, avatar_url }) {
    const existing = users.findByGoogle(google_id)
      || (email && users.findByEmail(email));
    if (existing) {
      run(
        `UPDATE users SET google_id=?, name=COALESCE(?,name), avatar_url=COALESCE(?,avatar_url),
         last_login=strftime('%s','now') WHERE id=?`,
        [google_id, name, avatar_url, existing.id]
      );
      return users.findById(existing.id);
    }
    return users.create({ email, name, google_id, avatar_url });
  },

  setMagicToken(userId, token, expiresInSeconds = 3600) {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    run('UPDATE users SET magic_token=?, magic_expires=? WHERE id=?',
        [token, expires, userId]);
    _persist();
  },

  clearMagicToken(userId) {
    run('UPDATE users SET magic_token=NULL, magic_expires=NULL, last_login=strftime(\'%s\',\'now\') WHERE id=?',
        [userId]);
    _persist();
  },

  setPassword(userId, hash) {
    run('UPDATE users SET password_hash=? WHERE id=?', [hash, userId]);
    _persist();
  },

  touch(userId) {
    run('UPDATE users SET last_login=strftime(\'%s\',\'now\') WHERE id=?', [userId]);
    _dirty = true;
  },

  updateName(userId, name) {
    run('UPDATE users SET name=? WHERE id=?', [name, userId]);
    _dirty = true;
  }
};

// ─── Profiles ────────────────────────────────────────────────────────────────

const profiles = {
  get(userId) {
    const row = get('SELECT * FROM profiles WHERE user_id = ?', [userId]);
    if (!row) return null;
    try { return JSON.parse(row.data); } catch { return {}; }
  },

  set(userId, profileObj) {
    const json = JSON.stringify(profileObj);
    const conf = profileObj.confidence || 0;
    run(
      `INSERT INTO profiles (user_id, data, confidence, updated_at)
       VALUES (?, ?, ?, strftime('%s','now'))
       ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,
         confidence=excluded.confidence, updated_at=excluded.updated_at`,
      [userId, json, conf]
    );
    _dirty = true;
  },

  merge(userId, patch) {
    const current = profiles.get(userId) || {};
    profiles.set(userId, { ...current, ...patch });
  }
};

// ─── Configs ─────────────────────────────────────────────────────────────────

const configs = {
  get(userId) {
    const row = get('SELECT * FROM configs WHERE user_id = ?', [userId]);
    if (!row) return null;
    try { return JSON.parse(row.data); } catch { return {}; }
  },

  set(userId, cfgObj) {
    const json = JSON.stringify(cfgObj);
    run(
      `INSERT INTO configs (user_id, data, updated_at)
       VALUES (?, ?, strftime('%s','now'))
       ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
      [userId, json]
    );
    _dirty = true;
  },

  merge(userId, patch) {
    const current = configs.get(userId) || {};
    configs.set(userId, { ...current, ...patch });
  }
};

// ─── Files ───────────────────────────────────────────────────────────────────

const fileStore = {
  save(userId, { type, filename, mime_type, size, buffer, extracted_text }) {
    run(
      `INSERT INTO files (user_id, type, filename, mime_type, size, buffer, extracted_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, type, filename, mime_type || null, size || null,
       buffer || null, extracted_text || null]
    );
    const row = get('SELECT last_insert_rowid() AS id FROM files');
    _dirty = true;
    return row.id;
  },

  list(userId, type = null) {
    if (type) return all('SELECT id, type, filename, mime_type, size, uploaded_at FROM files WHERE user_id=? AND type=? ORDER BY uploaded_at DESC', [userId, type]);
    return all('SELECT id, type, filename, mime_type, size, uploaded_at FROM files WHERE user_id=? ORDER BY uploaded_at DESC', [userId]);
  },

  getBuffer(fileId, userId) {
    const row = get('SELECT buffer, filename, mime_type FROM files WHERE id=? AND user_id=?', [fileId, userId]);
    return row;
  },

  getText(userId, type) {
    const rows = all('SELECT extracted_text FROM files WHERE user_id=? AND type=? AND extracted_text IS NOT NULL ORDER BY uploaded_at DESC', [userId, type]);
    return rows.map(r => r.extracted_text).filter(Boolean);
  }
};

// ─── Rate cache ──────────────────────────────────────────────────────────────

const rateCache = {
  get(skillKey, currency = 'EUR') {
    const now = Math.floor(Date.now() / 1000);
    return get(
      'SELECT * FROM rate_cache WHERE skill_key=? AND currency=? AND expires_at > ?',
      [skillKey, currency, now]
    );
  },

  set(skillKey, { currency = 'EUR', daily_low, daily_mid, daily_high, sources = [] }) {
    const now   = Math.floor(Date.now() / 1000);
    const ttl   = 7 * 24 * 3600; // 7 days
    run(
      `INSERT INTO rate_cache (skill_key, currency, daily_low, daily_mid, daily_high, sources, scraped_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(skill_key, currency) DO UPDATE SET daily_low=excluded.daily_low,
         daily_mid=excluded.daily_mid, daily_high=excluded.daily_high,
         sources=excluded.sources, scraped_at=excluded.scraped_at, expires_at=excluded.expires_at`,
      [skillKey, currency, daily_low, daily_mid, daily_high, JSON.stringify(sources), now, now + ttl]
    );
    _dirty = true;
  }
};

// ─── Seasonality cache ────────────────────────────────────────────────────────

const seasonCache = {
  get(industryKey, location = 'NL') {
    const now = Math.floor(Date.now() / 1000);
    const row = get(
      'SELECT * FROM season_cache WHERE industry_key=? AND location=? AND expires_at > ?',
      [industryKey, location, now]
    );
    if (!row) return null;
    try { return { ...row, data: JSON.parse(row.data) }; } catch { return null; }
  },

  set(industryKey, location = 'NL', dataObj, source = 'trends') {
    const now = Math.floor(Date.now() / 1000);
    const ttl = 7 * 24 * 3600; // 7 days
    run(
      `INSERT INTO season_cache (industry_key, location, data, source, scraped_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(industry_key, location) DO UPDATE SET data=excluded.data,
         source=excluded.source, scraped_at=excluded.scraped_at, expires_at=excluded.expires_at`,
      [industryKey, location, JSON.stringify(dataObj), source, now, now + ttl]
    );
    _dirty = true;
  }
};

// ─── Legacy bridge ─────────────────────────────────────────────────────────
// Maps old store.get/set('profile'|'config') to user 0 (single-user fallback)

const LEGACY_USER_ID = 1;

const legacyBridge = {
  ensureLegacyUser() {
    const existing = users.findById(LEGACY_USER_ID);
    if (!existing) {
      run(`INSERT OR IGNORE INTO users (id, name, email) VALUES (?, ?, ?)`,
          [LEGACY_USER_ID, 'Local User', 'local@nexus.app']);
      _persist();
    }
  },

  getProfile() {
    this.ensureLegacyUser();
    return profiles.get(LEGACY_USER_ID);
  },

  setProfile(p) {
    this.ensureLegacyUser();
    profiles.set(LEGACY_USER_ID, p);
  },

  getConfig() {
    this.ensureLegacyUser();
    return configs.get(LEGACY_USER_ID);
  },

  setConfig(c) {
    this.ensureLegacyUser();
    configs.set(LEGACY_USER_ID, c);
  }
};

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  init,
  persist: _persist,
  users,
  profiles,
  configs,
  fileStore,
  rateCache,
  seasonCache,
  legacy: legacyBridge,
  // Direct helpers for one-off queries
  run,
  get,
  all,
};
