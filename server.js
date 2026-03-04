'use strict';
/**
 * Nexus Live — server.js
 * Slim entry point: loads config, mounts middleware, starts server.
 *
 * All business logic lives in:
 *   lib/notion.js     — Notion SDK utilities
 *   lib/cache.js      — TTL cache
 *   lib/workspace.js  — Multi-workspace config loader
 *   routes/api.js     — All /api/* endpoints
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { load, checkConnectivity } = require('./lib/workspace');
const apiRouter                   = require('./routes/api');
const scheduler                   = require('./lib/scheduler');

// ── Multer for PDF file uploads ───────────────────────────────────────────────
let multer;
try {
  multer = require('multer');
} catch {
  console.warn('  ⚠  multer not installed — PDF upload disabled. Run: npm install multer');
}

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── PDF upload middleware (only for /api/contracts/parse) ─────────────────────
if (multer) {
  const upload = multer({
    storage: multer.memoryStorage(),   // keep PDF in memory (no disk write)
    limits:  { fileSize: 20 * 1024 * 1024 }, // 20MB max
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
        cb(null, true);
      } else {
        cb(new Error('Only PDF files are accepted'));
      }
    },
  });
  // Apply only to the parse endpoint
  app.use('/api/contracts/parse', upload.single('contract'));
}

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── Catch-all: serve index.html for client-side navigation ────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3333', 10);

app.listen(PORT, async () => {
  console.log(`\n⬡  Nexus Live  →  http://localhost:${PORT}\n`);

  // Eagerly load workspaces so any config errors surface at startup
  try { load(); } catch (e) { console.error('  Workspace load error:', e.message); }

  // Run a connectivity check on all configured databases
  console.log('  Checking Notion database access…');
  try {
    const report = await checkConnectivity();
    for (const { workspace, db, status, message } of report) {
      const icon = status === 'ok' ? '✓' : status === 'unconfigured' ? '○' : '✗';
      const detail = message ? `  ← ${message.slice(0, 100)}` : '';
      console.log(`  ${icon}  [${workspace}] ${db}${detail}`);
    }

    const errors = report.filter(r => r.status === 'error');
    if (errors.length) {
      console.log(`\n  ⚠  ${errors.length} database(s) unreachable.`);
      console.log('     → Open each Notion database → Share → invite your integration.\n');
    } else {
      console.log('\n  All databases accessible ✓\n');
    }
  } catch (e) {
    console.error('  Connectivity check failed:', e.message);
  }

  // Start scheduled background jobs (feed refresh, etc.)
  scheduler.start();
});
