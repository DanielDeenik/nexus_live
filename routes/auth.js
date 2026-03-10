/**
 * routes/auth.js — All authentication endpoints
 *
 * GET  /auth/linkedin           → start LinkedIn OAuth
 * GET  /auth/linkedin/callback  → LinkedIn OAuth callback
 * GET  /auth/google             → start Google OAuth
 * GET  /auth/google/callback    → Google OAuth callback
 * POST /auth/register           → email + password registration
 * POST /auth/login              → email + password login
 * POST /auth/magic              → request magic link (by email)
 * GET  /auth/magic              → verify magic link token
 * POST /auth/logout             → destroy session
 * GET  /auth/me                 → current user info
 * GET  /auth/session            → unified session state (replaces /auth/me + /api/auth/status + /api/onboard/status)
 * GET  /auth/providers          → list of configured OAuth providers
 */

const express    = require('express');
const passport   = require('passport');
const bcrypt     = require('bcryptjs');
const { generateToken, sendMagicLink } = require('../lib/magicLink');
const { currentUserId } = require('../lib/auth');

let db; // injected via module.exports.init()

const router = express.Router();

// ─── Helper — after-auth redirect ────────────────────────────────────────────

function afterAuth(req, res) {
  // If this was a popup (LinkedIn flow compatibility), use postMessage
  if (req.query.popup === '1') {
    const user = req.user;
    return res.send(`
      <script>
        window.opener && window.opener.postMessage({
          type: 'NEXUS_AUTH',
          user: ${JSON.stringify({ id: user.id, name: user.name, email: user.email, avatar_url: user.avatar_url })}
        }, '*');
        window.close();
      </script>
    `);
  }
  res.redirect('/');
}

// ─── LinkedIn ─────────────────────────────────────────────────────────────────

router.get('/linkedin', (req, res, next) => {
  if (!passport._strategies?.linkedin) {
    return res.status(503).json({ ok: false, error: 'LinkedIn OAuth not configured on this server.' });
  }
  passport.authenticate('linkedin', { state: true })(req, res, next);
});

router.get('/linkedin/callback',
  (req, res, next) => {
    if (!passport._strategies?.linkedin) return res.redirect('/?auth_error=linkedin_not_configured');
    next();
  },
  passport.authenticate('linkedin', { failureRedirect: '/?auth_error=linkedin_failed' }),
  afterAuth
);

// ─── Google ───────────────────────────────────────────────────────────────────

router.get('/google', (req, res, next) => {
  if (!passport._strategies?.google) {
    return res.status(503).json({ ok: false, error: 'Google OAuth not configured on this server.' });
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

router.get('/google/callback',
  (req, res, next) => {
    if (!passport._strategies?.google) return res.redirect('/?auth_error=google_not_configured');
    next();
  },
  passport.authenticate('google', { failureRedirect: '/?auth_error=google_failed' }),
  afterAuth
);

// ─── Email registration ───────────────────────────────────────────────────────

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required.' });
  if (password.length < 8)  return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });

  const existing = db.users.findByEmail(email);
  if (existing) return res.status(409).json({ ok: false, error: 'An account with that email already exists.' });

  const hash = await bcrypt.hash(password, 12);
  const user = db.users.create({ email, name: name || email.split('@')[0], password_hash: hash });

  req.login(user, err => {
    if (err) return res.status(500).json({ ok: false, error: 'Login after registration failed.' });
    res.json({ ok: true, user: _safeUser(user) });
  });
});

// ─── Email login ──────────────────────────────────────────────────────────────

router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err)   return res.status(500).json({ ok: false, error: err.message });
    if (!user) return res.status(401).json({ ok: false, error: info?.message || 'Authentication failed.' });
    req.login(user, loginErr => {
      if (loginErr) return res.status(500).json({ ok: false, error: loginErr.message });
      res.json({ ok: true, user: _safeUser(user) });
    });
  })(req, res, next);
});

// ─── Magic link request ───────────────────────────────────────────────────────

router.post('/magic', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: 'Email required.' });

  // Find or create user
  let user = db.users.findByEmail(email);
  if (!user) {
    user = db.users.create({ email, name: email.split('@')[0] });
  }

  const MAGIC_TTL = 900; // 15 minutes — best-practice for one-click auth tokens

  // Rate-limit: prevent re-sending within 60 seconds
  if (!db.users.canSendMagicLink(user.id, MAGIC_TTL)) {
    return res.status(429).json({ ok: false, error: 'Please wait 60 seconds before requesting another link.' });
  }

  const token   = generateToken();
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

  db.users.setMagicToken(user.id, token, MAGIC_TTL);

  try {
    await sendMagicLink(email, token, baseUrl);
    res.json({ ok: true, message: 'Magic link sent. Check your inbox — it expires in 15 minutes.' });
  } catch (e) {
    console.error('[auth/magic] email send failed:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to send email. Please try again.' });
  }
});

// ─── Magic link verify ────────────────────────────────────────────────────────

router.get('/magic', (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/?auth_error=missing_token');

  // Try valid (not-yet-expired) token first
  const user = db.users.findByMagicToken(token);
  if (!user) {
    // Distinguish: does the token exist but is expired?
    const expired = db.users.findExpiredMagicToken(token);
    if (expired) return res.redirect('/?auth_error=link_expired');
    return res.redirect('/?auth_error=invalid_token');
  }

  // Atomically clear token so it cannot be reused
  db.users.clearMagicToken(user.id);

  req.login(user, err => {
    if (err) return res.redirect('/?auth_error=login_failed');
    res.redirect('/');
  });
});

// ─── Logout ───────────────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
  req.logout(err => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    req.session.destroy(() => res.json({ ok: true }));
  });
});

// ─── Me ───────────────────────────────────────────────────────────────────────

router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.json({ ok: true, authenticated: false, user: null });
  }
  res.json({ ok: true, authenticated: true, user: _safeUser(req.user) });
});

// ─── Session (unified) ────────────────────────────────────────────────────────

/**
 * GET /auth/session
 *
 * Single endpoint that replaces three separate calls:
 *   GET /auth/me            (is user authenticated?)
 *   GET /api/auth/status    (hasPin, hasProfile, name, headline)
 *   GET /api/onboard/status (onboardingComplete)
 *
 * Response: {
 *   authenticated:      boolean,
 *   user:               SafeUser | null,
 *   hasPin:             boolean,
 *   hasProfile:         boolean,
 *   onboardingComplete: boolean,
 *   name:               string | null,
 *   headline:           string | null,
 * }
 */
router.get('/session', (req, res) => {
  const cfg  = req.userStore.get('config', {});
  const auth = req.userStore.get('auth',   {});

  const hasPin     = Boolean(auth.pinHash);
  const hasProfile = Boolean(cfg.name || cfg.hourlyRate || cfg.headline);
  const onboardingComplete = Boolean(cfg.name);

  if (req.isAuthenticated()) {
    return res.json({
      authenticated:      true,
      user:               _safeUser(req.user),
      hasPin,
      hasProfile,
      onboardingComplete,
      name:               cfg.name     || req.user?.name     || null,
      headline:           cfg.headline || req.user?.headline  || null,
    });
  }

  res.json({
    authenticated:      false,
    user:               null,
    hasPin,
    hasProfile,
    onboardingComplete,
    name:               cfg.name     || null,
    headline:           cfg.headline || null,
  });
});

// ─── Providers ────────────────────────────────────────────────────────────────

/**
 * GET /auth/providers
 *
 * Returns the list of OAuth providers that are actually configured on this
 * server instance.  The client renders login buttons from this list rather
 * than hard-coding them in HTML — so adding / removing a provider on the
 * server side automatically reflects in the UI.
 *
 * Response: { providers: [{ id, label, url }] }
 */
router.get('/providers', (req, res) => {
  const providers = [];
  if (passport._strategies?.linkedin) {
    providers.push({ id: 'linkedin', label: 'LinkedIn', url: '/auth/linkedin' });
  }
  if (passport._strategies?.google) {
    providers.push({ id: 'google',   label: 'Google',   url: '/auth/google'   });
  }
  res.json({ ok: true, providers });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _safeUser(u) {
  if (!u) return null;
  return {
    id:         u.id,
    name:       u.name,
    email:      u.email,
    avatar_url: u.avatar_url,
    plan:       u.plan,
    created_at: u.created_at,
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────────

module.exports = router;
module.exports.init = function(dbInstance) { db = dbInstance; };
