'use strict';
/**
 * lib/basicAuth.js — Optional HTTP Basic Auth middleware
 *
 * Enabled when SANDBOX_USER and SANDBOX_PASS are set in the environment.
 * This protects the hosted sandbox from public access without adding
 * a full authentication system.
 *
 * Usage in server.js:
 *   const basicAuth = require('./lib/basicAuth');
 *   app.use(basicAuth);
 *
 * Exempt paths (always public):
 *   /health  — for uptime monitoring
 */

const EXEMPT = ['/health'];

/**
 * Returns a middleware function. If SANDBOX_USER / SANDBOX_PASS are not set,
 * returns a no-op passthrough so local dev is unaffected.
 */
function createBasicAuth() {
  const user = process.env.SANDBOX_USER;
  const pass = process.env.SANDBOX_PASS;

  // No credentials set → no-op (local dev, single-user self-hosted)
  if (!user || !pass) {
    return (_req, _res, next) => next();
  }

  const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  return function basicAuthMiddleware(req, res, next) {
    // Always allow exempt paths
    if (EXEMPT.includes(req.path)) return next();

    const auth = req.headers['authorization'];
    if (auth === expected) return next();

    // Prompt browser login dialog
    res.setHeader('WWW-Authenticate', 'Basic realm="Nexus Sandbox"');
    res.status(401).send('Access restricted — contact the workspace owner for credentials.');
  };
}

module.exports = createBasicAuth();
