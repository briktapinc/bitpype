'use strict';

/**
 * Batch 55 (review C-3) — durable rate-limit counters.
 *
 * Counters live in the PLATFORM database (server/db.js — MySQL in
 * production, SQLite in dev/tests), in one append-only events table:
 * every hit inserts one row (bucket, key, at) and the sliding-window
 * count is a COUNT over the window. That keeps the pre-Batch-55
 * sliding-window semantics exactly, while making budgets survive app
 * restarts and deploys — the in-memory Map they replace reset to zero
 * on every restart, i.e. every deploy handed every IP a fresh budget.
 *
 * Why not Redis: the production stack (docker-compose.yml) has no
 * Redis service — only MySQL + the app. The platform DB is already
 * there, already backed up, and already the home of every other
 * cross-workspace counter in this codebase.
 *
 * The table is created by db.migrate() at boot AND lazily here, so
 * processes that never run migrations (unit tests, route modules
 * loaded standalone) still work.
 */

const { query, driver } = require('./db');

let ensured = null;
let pruneHorizonMs = 60 * 60 * 1000; // longest window in the codebase today (OAuth DCR, 1h)
let hitsSincePrune = 0;
const PRUNE_EVERY_HITS = 250;

function ensureTable() {
  if (!ensured) {
    ensured = (async () => {
      if (driver() === 'sqlite') {
        await query(
          `CREATE TABLE IF NOT EXISTS rate_limit_hits (
             bucket TEXT NOT NULL,
             k TEXT NOT NULL,
             at INTEGER NOT NULL
           )`
        );
        await query('CREATE INDEX IF NOT EXISTS idx_rate_limit_hits ON rate_limit_hits (bucket, k, at)');
      } else {
        await query(
          `CREATE TABLE IF NOT EXISTS rate_limit_hits (
             bucket VARCHAR(160) NOT NULL,
             k VARCHAR(255) NOT NULL,
             at BIGINT NOT NULL,
             KEY idx_rate_limit_hits (bucket, k, at)
           ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        );
      }
    })();
    // If DDL failed (DB not up yet), let the next hit retry instead of
    // caching the rejection forever. The caller still gets the error for
    // THIS hit and rateLimit.js falls back to in-memory counting.
    ensured.catch(() => {
      ensured = null;
    });
  }
  return ensured;
}

/** Delete rows older than the longest live window. Opportunistic. */
async function pruneExpired(now) {
  await query('DELETE FROM rate_limit_hits WHERE at <= :cutoff', { cutoff: now - pruneHorizonMs });
}

/**
 * Record one hit and return the sliding-window count for (bucket, key)
 * INCLUDING this hit — the same number the old in-memory limiter
 * compared against max.
 */
async function recordHit(bucket, key, windowMs, now) {
  await ensureTable();
  if (windowMs > pruneHorizonMs) pruneHorizonMs = windowMs;
  await query('INSERT INTO rate_limit_hits (bucket, k, at) VALUES (:bucket, :k, :at)', {
    bucket,
    k: key,
    at: now,
  });
  const rows = await query(
    'SELECT COUNT(*) AS c FROM rate_limit_hits WHERE bucket = :bucket AND k = :k AND at > :since',
    { bucket, k: key, since: now - windowMs }
  );
  if (++hitsSincePrune >= PRUNE_EVERY_HITS) {
    hitsSincePrune = 0;
    pruneExpired(now).catch(() => {
      /* pruning is housekeeping — never fail a request over it */
    });
  }
  return Number(rows && rows[0] ? rows[0].c : 0);
}

/** Test/maintenance helper: wipe one bucket's counters. */
async function clearBucket(bucket) {
  await ensureTable();
  await query('DELETE FROM rate_limit_hits WHERE bucket = :bucket', { bucket });
}

module.exports = { recordHit, pruneExpired, clearBucket, ensureTable };
