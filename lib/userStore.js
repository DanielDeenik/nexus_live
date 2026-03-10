'use strict';
/**
 * lib/userStore.js — Per-user scoped store wrapper
 *
 * Wraps lib/store.js to prefix every key with `u${userId}:`,
 * isolating each user's data in the shared JSON store.
 *
 * Usage (in route handlers — req.userStore is attached by middleware):
 *   req.userStore.get('config', {})          // reads `u${userId}:config`
 *   req.userStore.set('profile', obj)        // writes `u${userId}:profile`
 *   req.userStore.merge('auth', { pin: h })  // shallow-merges into `u${userId}:auth`
 *
 * Direct usage (e.g. server startup where there is no req):
 *   const userStore = require('./lib/userStore');
 *   userStore(1).get('profile');             // user 1's profile
 *
 * Backward compatibility:
 *   userId=1 (legacy local user) falls back to un-prefixed keys on reads
 *   so that data saved before the multi-user migration is still accessible.
 *   All writes go to the prefixed key — so the next read also finds them.
 */

const store = require('./store');

function userStore(userId) {
  const uid    = userId || 1;
  const prefix = `u${uid}:`;

  return {
    /**
     * Read a value for this user.
     * Falls back to the un-prefixed legacy key for user 1
     * so existing single-user data is preserved after migration.
     */
    get(key, def = null) {
      const val = store.get(prefix + key);
      if (val !== null && val !== undefined) return val;
      // Backward compat: user 1 may have un-prefixed keys from before multi-user
      if (uid === 1) return store.get(key, def);
      return (def !== undefined && def !== null) ? def : null;
    },

    /** Write a value for this user (always uses the prefixed key). */
    set(key, value) {
      store.set(prefix + key, value);
    },

    /**
     * Shallow-merge a patch into an existing stored object for this user.
     * Reads current value (with legacy fallback) then writes to prefixed key.
     */
    merge(key, patch) {
      const existing = this.get(key, {});
      store.set(prefix + key, { ...(existing || {}), ...patch });
    },
  };
}

module.exports = userStore;
