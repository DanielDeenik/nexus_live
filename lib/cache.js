'use strict';
/**
 * lib/cache.js — Simple in-memory TTL cache
 * Reduces Notion API calls when the user navigates between pages.
 * Default TTL: 30 seconds.
 */

const DEFAULT_TTL_MS = 30_000;

class TTLCache {
  constructor() {
    this._store = new Map();
  }

  get(key) {
    const item = this._store.get(key);
    if (!item) return undefined;
    if (Date.now() > item.exp) {
      this._store.delete(key);
      return undefined;
    }
    return item.val;
  }

  set(key, val, ttlMs = DEFAULT_TTL_MS) {
    this._store.set(key, { val, exp: Date.now() + ttlMs });
    return this;
  }

  del(key) {
    this._store.delete(key);
  }

  /** Delete all keys that start with a given prefix. */
  delPrefix(prefix) {
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) this._store.delete(key);
    }
  }

  clear() {
    this._store.clear();
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  get size() {
    return this._store.size;
  }
}

module.exports = new TTLCache();
