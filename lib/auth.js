/**
 * lib/auth.js — Passport strategy configuration
 *
 * Strategies:
 *   linkedin   — OAuth 2.0 via passport-linkedin-oauth2
 *   google     — OAuth 2.0 via passport-google-oauth20
 *   local      — email + password via passport-local
 *   magic      — token-based magic link (custom)
 *
 * All strategies resolve to a DB user row.
 */

const passport        = require('passport');
const LinkedInStrategy = require('passport-linkedin-oauth2').Strategy;
const GoogleStrategy  = require('passport-google-oauth20').Strategy;
const LocalStrategy   = require('passport-local').Strategy;
const bcrypt          = require('bcryptjs');

let db; // injected after db.init()

// ─── Serialize / Deserialize ─────────────────────────────────────────────────

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  try {
    const user = db.users.findById(id);
    done(null, user || false);
  } catch (e) {
    done(e, false);
  }
});

// ─── LinkedIn Strategy ────────────────────────────────────────────────────────

function initLinkedIn() {
  if (!process.env.LINKEDIN_CLIENT_ID || !process.env.LINKEDIN_CLIENT_SECRET) {
    console.info('[auth] LinkedIn OAuth not configured (set LINKEDIN_CLIENT_ID + LINKEDIN_CLIENT_SECRET)');
    return;
  }

  passport.use('linkedin', new LinkedInStrategy(
    {
      clientID:     process.env.LINKEDIN_CLIENT_ID,
      clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
      callbackURL:  process.env.LINKEDIN_CALLBACK_URL || '/auth/linkedin/callback',
      scope:        ['openid', 'profile', 'email'],
      state:        true,
    },
    (accessToken, refreshToken, profile, done) => {
      try {
        const email    = profile.emails?.[0]?.value || null;
        const name     = profile.displayName || null;
        const avatar   = profile.photos?.[0]?.value || null;
        const user     = db.users.upsertLinkedIn({
          linkedin_id: profile.id,
          email,
          name,
          avatar_url: avatar,
        });
        done(null, user);
      } catch (e) {
        done(e, false);
      }
    }
  ));
}

// ─── Google Strategy ─────────────────────────────────────────────────────────

function initGoogle() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.info('[auth] Google OAuth not configured (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET)');
    return;
  }

  passport.use('google', new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
      scope:        ['profile', 'email'],
    },
    (accessToken, refreshToken, profile, done) => {
      try {
        const email  = profile.emails?.[0]?.value || null;
        const name   = profile.displayName || null;
        const avatar = profile.photos?.[0]?.value || null;
        const user   = db.users.upsertGoogle({
          google_id:  profile.id,
          email,
          name,
          avatar_url: avatar,
        });
        done(null, user);
      } catch (e) {
        done(e, false);
      }
    }
  ));
}

// ─── Local Strategy (email + password) ───────────────────────────────────────

passport.use('local', new LocalStrategy(
  { usernameField: 'email', passwordField: 'password' },
  async (email, password, done) => {
    try {
      const user = db.users.findByEmail(email);
      if (!user)              return done(null, false, { message: 'No account found for that email.' });
      if (!user.password_hash) return done(null, false, { message: 'This account uses social login. Try LinkedIn or Google.' });
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok)                return done(null, false, { message: 'Incorrect password.' });
      db.users.touch(user.id);
      return done(null, user);
    } catch (e) {
      return done(e);
    }
  }
));

// ─── Magic Link (custom — verified in routes/auth.js) ───────────────────────
// No strategy needed; handled manually: token → user lookup → req.login()

// ─── Init ─────────────────────────────────────────────────────────────────────

function init(dbInstance) {
  db = dbInstance;
  initLinkedIn();
  initGoogle();
  return passport;
}

// ─── Middleware helpers ───────────────────────────────────────────────────────

/**
 * requireAuth — redirect to /login if not authenticated.
 * For API routes, returns 401 JSON instead of redirect.
 */
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'Not authenticated', redirect: '/login' });
  }
  res.redirect('/login');
}

/**
 * optionalAuth — populates req.user if session exists, never blocks.
 */
function optionalAuth(req, res, next) {
  next(); // passport already populates req.user via session
}

/**
 * currentUser — extracts userId from session or falls back to legacy (local mode).
 */
function currentUserId(req) {
  return req.user?.id || 1; // 1 = legacy local user
}

module.exports = { init, requireAuth, optionalAuth, currentUserId };
