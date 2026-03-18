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

const express        = require('express');
const cors           = require('cors');
const path           = require('path');
const session        = require('express-session');
const FileStore      = require('session-file-store')(session);
const passport       = require('passport');

const db             = require('./lib/db');
const authConfig     = require('./lib/auth');
const authRouter     = require('./routes/auth');
const { load, checkConnectivity } = require('./lib/workspace');
const apiRouter                   = require('./routes/api');
const budgetAppRouter             = require('./routes/budget-app');
const onboardRouter               = require('./routes/onboard');
const profileRouter               = require('./routes/profile');
const scheduler                   = require('./lib/scheduler');
const basicAuth                   = require('./lib/basicAuth');
const intel                       = require('./workers/marketIntel');
const userStore                   = require('./lib/userStore');
const { currentUserId }           = require('./lib/auth');

// ── Multer for PDF file uploads ───────────────────────────────────────────────
let multer;
try {
  multer = require('multer');
} catch {
  console.warn('  ⚠  multer not installed — PDF upload disabled. Run: npm install multer');
}

const app = express();

// ── Trust Railway/Render/Fly reverse proxy ────────────────────────────────────
// Without this, req.protocol is 'http' and session cookies break OAuth state
// checks when behind Railway's load balancer.
app.set('trust proxy', 1);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// cookie-parser for OAuth state CSRF checks
try {
  const cookieParser = require('cookie-parser');
  app.use(cookieParser());
} catch { /* not installed */ }

// ── Session (file-backed, survives restarts) ─────────────────────────────────
const sessDir = path.join(__dirname, 'data', 'sessions');
require('fs').mkdirSync(sessDir, { recursive: true });

app.use(session({
  store:             new FileStore({ path: sessDir, ttl: 86400 * 30, retries: 0, logFn: () => {} }),
  secret:            process.env.SESSION_SECRET || 'nexus-dev-secret-change-in-prod',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',                  // CSRF protection — allows OAuth redirects back to app
    maxAge:   30 * 24 * 3600 * 1000, // 30 days
  },
}));

// ── Passport ──────────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

// ── Per-user store — attach after passport so req.user is already populated ──
app.use((req, _res, next) => {
  req.userStore = userStore(currentUserId(req));
  next();
});

app.use(basicAuth);  // no-op if SANDBOX_USER/SANDBOX_PASS not set
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
  // Apply only to the parse endpoint (onboard/extract handles its own multer instance)
  app.use('/api/contracts/parse', upload.single('contract'));
}

// ── Health check (exempt from basic auth — used by uptime monitors) ───────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Auth routes (no /api prefix — handles /auth/* directly) ──────────────────
app.use('/auth', authRouter);

// ── Login page (SPA handles it, but serve index.html for /login) ──────────────
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api', apiRouter);
app.use('/api/budget-app', budgetAppRouter);
app.use('/api/onboard', onboardRouter);
app.use('/api/profile', profileRouter);

// ── Catch-all: serve index.html for client-side navigation ────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3333', 10);

// ── DB + Auth init then start server ─────────────────────────────────────────
db.init().then(() => {
  // Wire passport strategies + inject DB module (not the raw sql.js instance) into auth layer
  authConfig.init(db);
  authRouter.init(db);

  // Seed legacy local user so old store.get('profile') still works
  db.legacy.ensureLegacyUser();

  startServer();
}).catch(e => {
  console.error('DB init failed:', e.message);
  process.exit(1);
});

function startServer() {
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

  // Restore saved profile into market intel worker (survives server restarts)
  // Uses user 1 (legacy local user) — multi-user: each user's profile is loaded on their first request
  const savedProfile = userStore(1).get('profile');
  if (savedProfile) {
    intel.setProfile(savedProfile);
    console.log('  ✓  Restored profile from local store —', savedProfile.name || 'unnamed');
  }

  // Start market intel scheduler (runs daily signal refresh when profile is set)
  intel.startScheduler();
});
} // end startServer
