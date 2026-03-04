'use strict';
/**
 * lib/workspace.js — Multi-workspace configuration loader
 *
 * Priority:
 *   1. config/workspaces.json  (preferred — supports multiple workspaces)
 *   2. .env variables          (fallback — single workspace, backward compatible)
 *
 * Each workspace has:
 *   id      - unique string identifier
 *   name    - display name
 *   client  - Notion SDK client instance
 *   dbs     - map of database role → Notion page UUID
 */

const fs   = require('fs');
const path = require('path');
const { createClient, translateError } = require('./notion');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'workspaces.json');

/** Singleton: loaded once at startup */
let _registry = null;

function buildFromConfig(raw) {
  const workspaces = {};
  for (const ws of (raw.workspaces || [])) {
    if (!ws.id || !ws.token) {
      console.warn(`⚠  Skipping workspace "${ws.id || '(no id)'}" — missing id or token`);
      continue;
    }
    workspaces[ws.id] = {
      id:     ws.id,
      name:   ws.name || ws.id,
      client: createClient(ws.token),
      dbs:    ws.databases || {},
    };
  }
  return {
    default:    raw.default || Object.keys(workspaces)[0] || 'primary',
    workspaces,
  };
}

function buildFromEnv() {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    console.error('\n  ✗ NOTION_TOKEN is not set.\n    Set it in .env (copy .env.example → .env) or in config/workspaces.json\n');
  }

  // Warn about any missing DB IDs
  const DB_VARS = ['DB_PROFILE','DB_EXPENSES','DB_CONTRACTS','DB_SIGNALS',
                   'DB_CASHFLOW','DB_COMPANIES','DB_OPPORTUNITIES','DB_HISTORY'];
  for (const v of DB_VARS) {
    if (!process.env[v]) console.warn(`  ⚠  ${v} not set in .env — that endpoint will fail`);
  }

  return {
    default: 'primary',
    workspaces: {
      primary: {
        id:     'primary',
        name:   process.env.WORKSPACE_NAME || 'Primary Workspace',
        client: createClient(token || ''),
        dbs: {
          profile:       process.env.DB_PROFILE       || '',
          expenses:      process.env.DB_EXPENSES       || '',
          contracts:     process.env.DB_CONTRACTS      || '',
          signals:       process.env.DB_SIGNALS        || '',
          cashflow:      process.env.DB_CASHFLOW       || '',
          companies:     process.env.DB_COMPANIES      || '',
          opportunities: process.env.DB_OPPORTUNITIES  || '',
          history:       process.env.DB_HISTORY        || '',
        },
      },
    },
  };
}

function load() {
  if (_registry) return _registry;

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      _registry = buildFromConfig(raw);
      const count = Object.keys(_registry.workspaces).length;
      console.log(`⬡  Loaded ${count} workspace(s) from config/workspaces.json`);
    } catch (e) {
      console.error('⚠  Failed to parse config/workspaces.json:', e.message, '— falling back to .env');
      _registry = buildFromEnv();
    }
  } else {
    console.log('⬡  Using .env for workspace configuration (create config/workspaces.json for multi-workspace support)');
    _registry = buildFromEnv();
  }

  return _registry;
}

/** Returns a workspace object by id, or the default if id is omitted. */
function getWorkspace(id) {
  const reg = load();
  return reg.workspaces[id || reg.default] || null;
}

/** Returns a summary array suitable for the /api/workspaces endpoint. */
function listWorkspaces() {
  const reg = load();
  return Object.values(reg.workspaces).map(ws => ({
    id:      ws.id,
    name:    ws.name,
    default: ws.id === reg.default,
    dbs:     Object.keys(ws.dbs).filter(k => !!ws.dbs[k]),
  }));
}

/**
 * Run a quick connectivity check against all configured databases.
 * Returns a structured report: { workspaceId, db, status: 'ok'|'error', message? }
 */
async function checkConnectivity() {
  const reg = load();
  const report = [];
  for (const ws of Object.values(reg.workspaces)) {
    for (const [dbRole, dbId] of Object.entries(ws.dbs)) {
      if (!dbId) {
        report.push({ workspace: ws.id, db: dbRole, status: 'unconfigured' });
        continue;
      }
      try {
        await ws.client.databases.retrieve({ database_id: dbId });
        report.push({ workspace: ws.id, db: dbRole, status: 'ok' });
      } catch (e) {
        report.push({ workspace: ws.id, db: dbRole, status: 'error', message: translateError(e) });
      }
    }
  }
  return report;
}

module.exports = { load, getWorkspace, listWorkspaces, checkConnectivity };
