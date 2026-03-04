'use strict';
/**
 * lib/scheduler.js — Cron job manager
 *
 * Wraps node-cron to schedule recurring tasks.
 * Gracefully degrades if node-cron is not installed.
 *
 * Registered jobs:
 *   - jobFeedRefresh: daily at 06:00 — refreshes RSS job board cache
 */

let cron;
try {
  cron = require('node-cron');
} catch {
  cron = null;
}

const { refresh: refreshFeed } = require('../workers/jobFeed');

const jobs = {};

/**
 * Register and start all scheduled jobs.
 * Called once at server startup from server.js.
 */
function start() {
  if (!cron) {
    console.warn('  ⚠  node-cron not installed — scheduled jobs disabled.');
    console.warn('     Run: npm install node-cron  to enable automatic feed refresh.');
    return;
  }

  // ── Daily feed refresh — 06:00 every morning ────────────────────────────
  jobs.jobFeedRefresh = cron.schedule('0 6 * * *', async () => {
    console.log('[scheduler] Running daily job feed refresh…');
    try {
      const items = await refreshFeed();
      console.log(`[scheduler] Job feed refreshed — ${items.length} items`);
    } catch (err) {
      console.error('[scheduler] Job feed refresh failed:', err.message);
    }
  }, {
    timezone: 'Europe/Amsterdam',
  });

  console.log('  ✓  Scheduler started — job feed refresh at 06:00 Amsterdam time');
}

/**
 * Manually trigger a job by name (e.g. from /api/feed/refresh endpoint).
 * @param {string} name — job name key
 */
async function runNow(name) {
  if (name === 'jobFeedRefresh' || name === 'feed') {
    return refreshFeed();
  }
  throw new Error(`Unknown job: ${name}`);
}

/**
 * Stop all scheduled jobs (used in tests / graceful shutdown).
 */
function stop() {
  for (const job of Object.values(jobs)) {
    if (job && typeof job.destroy === 'function') job.destroy();
  }
  console.log('[scheduler] All jobs stopped.');
}

module.exports = { start, runNow, stop };
