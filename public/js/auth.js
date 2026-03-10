/**
 * public/js/auth.js — Reusable AUTH client module
 *
 * Exposes a single `window.AUTH` object with:
 *
 *   AUTH.init()               → fetch /auth/session (single call replacing 3) and cache the result
 *   AUTH.getSession()         → return the cached session object (null until init() called)
 *   AUTH.action(type, data)   → unified async handler: 'magic'|'password'|'register'|'logout'
 *   AUTH.onPopupMessage(cb)   → unified postMessage listener (NEXUS_AUTH + legacy nexus-linkedin)
 *   AUTH.providers()          → fetch /auth/providers → [{id,label,url}]
 *   AUTH.STATES               → enum of FSM states
 *
 * First-principles design rationale:
 *  - ONE network call on startup instead of three (/auth/me + /api/auth/status + /api/onboard/status)
 *  - Single auth action handler eliminates 3 copy-pasted try/catch functions
 *  - Unified postMessage listener works for both OAuth login and profile-import popups
 *  - Explicit state enum makes the login FSM readable and testable
 *  - IIFE keeps everything out of global scope except `window.AUTH`
 */

/* global window, fetch */
'use strict';

window.AUTH = (() => {

  // ─── State constants ────────────────────────────────────────────────────────

  const STATES = Object.freeze({
    LOADING:          'loading',
    NEW_USER:         'new_user',
    PARTIAL_ONBOARD:  'partial_onboard',
    RETURNING_NO_PIN: 'returning_no_pin',
    RETURNING_PIN:    'returning_pin',
    AUTHED:           'authed',
    ONBOARDING:       'onboarding',
  });

  // ─── Internal cache ─────────────────────────────────────────────────────────

  let _session = null;   // populated by init()

  // ─── init() — single unified session fetch ──────────────────────────────────

  /**
   * Fetch /auth/session once and cache the result.
   * Returns the session object:
   * {
   *   authenticated:     boolean,
   *   user:              { id, name, email, avatar_url, plan } | null,
   *   hasPin:            boolean,
   *   hasProfile:        boolean,
   *   onboardingComplete: boolean,
   *   name:              string | null,
   *   headline:          string | null,
   * }
   */
  async function init() {
    try {
      const r = await fetch('/auth/session', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      _session = await r.json();
    } catch {
      _session = {
        authenticated: false,
        user: null,
        hasPin: false,
        hasProfile: false,
        onboardingComplete: false,
        name: null,
        headline: null,
      };
    }
    return _session;
  }

  /** Return the cached session (null until init() called). */
  function getSession() { return _session; }

  // ─── action() — unified auth action ─────────────────────────────────────────

  const _ENDPOINTS = {
    magic:    { url: '/auth/magic',    method: 'POST' },
    password: { url: '/auth/login',    method: 'POST' },
    register: { url: '/auth/register', method: 'POST' },
    logout:   { url: '/auth/logout',   method: 'POST' },
  };

  /**
   * Perform an auth action.
   * @param {'magic'|'password'|'register'|'logout'} type
   * @param {object} data   Body payload (e.g. { email, password })
   * @returns {Promise<object>}  Server JSON response
   */
  async function action(type, data = {}) {
    const ep = _ENDPOINTS[type];
    if (!ep) throw new Error(`Unknown auth action: "${type}"`);
    const r = await fetch(ep.url, {
      method:  ep.method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(data),
    });
    return r.json();
  }

  // ─── onPopupMessage() — unified OAuth popup listener ────────────────────────

  /**
   * Register a one-time listener for postMessages from OAuth popups.
   * Handles both the new unified format and the legacy nexus-linkedin format.
   *
   * Callback receives a normalised object:
   * {
   *   ok:      boolean,
   *   purpose: 'login' | 'profile_import',
   *   user:    object | null,      // present for login popups
   *   profile: object | null,      // present for profile_import popups
   *   error:   string | null,
   * }
   *
   * @param {function} callback
   * @returns {function}  Cleanup function (call to remove the listener early)
   */
  function onPopupMessage(callback) {
    function handler(e) {
      // New unified format: { type: 'NEXUS_AUTH', purpose, ok, user, profile, error }
      if (e.data?.type === 'NEXUS_AUTH') {
        window.removeEventListener('message', handler);
        callback({
          ok:      e.data.ok !== false,
          purpose: e.data.purpose || 'login',
          user:    e.data.user    || null,
          profile: e.data.profile || null,
          error:   e.data.error   || null,
        });
        return;
      }
      // Legacy format from onboard LinkedIn popup: { source: 'nexus-linkedin', payload: {...} }
      if (e.data?.source === 'nexus-linkedin') {
        window.removeEventListener('message', handler);
        const p = e.data.payload || {};
        callback({
          ok:      p.ok !== false,
          purpose: 'profile_import',
          user:    null,
          profile: p.profile || null,
          error:   p.error   || null,
        });
        return;
      }
    }
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }

  // ─── providers() — dynamic OAuth provider list ──────────────────────────────

  /**
   * Fetch the list of configured OAuth providers from the server.
   * @returns {Promise<Array<{id:string, label:string, url:string}>>}
   */
  async function providers() {
    try {
      const r = await fetch('/auth/providers');
      const d = await r.json();
      return d.providers || [];
    } catch {
      return [];
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  return { STATES, init, getSession, action, onPopupMessage, providers };

})();
