'use strict';

/**
 * Sliding-window rate limiter — Batch 55: counters are DURABLE.
 *
 * History: this limiter used to keep counters in a per-process Map.
 * They reset on every deploy/restart (verified in the 2026-10-29
 * expert review, C-3) and RATE_LIMIT_REDIS_URL only produced a log
 * line saying it was "set but unused" — an operator could believe
 * Redis-backed limiting was on when it was not.
 *
 * Now: hits are recorded in the platform database via
 * server/rateLimitStore.js (this stack has no Redis service — see
 * docker-compose.yml — so the platform DB is the shared store).
 * Budgets therefore survive restarts and are shared by construction.
 * If the store is briefly unavailable, a request falls back to the old
 * in-memory counting for that request only, with a throttled warning —
 * availability first, but never silently.
 *
 * Bucket identity: an explicit `name` (other than 'default') IS the
 * bucket. Unnamed limiters derive a bucket from their construction
 * site (caller file + per-file ordinal + window + max), which is
 * stable across restarts for a given code shape — that is what makes
 * the persisted counters line up with the same limiter after a deploy.
 */

const path = require('path');
const dbStore = require('./rateLimitStore');

let activeStore = dbStore;
let loggedMode = false;
let fallbackWarnedAt = 0;
const ordinals = new Map();
const fallbackHits = new Map(); // bucket -> Map(key -> number[])

function logModeOnce() {
  if (loggedMode) return;
  loggedMode = true;
  try {
    if (process.env.RATE_LIMIT_REDIS_URL) {
      console.info(
        '[rateLimit] RATE_LIMIT_REDIS_URL is set, but this build does not use Redis — counters are stored in the platform database and survive restarts.'
      );
    } else {
      console.info('[rateLimit] counters: platform database (durable — survive restarts/deploys)');
    }
  } catch {
    /* ignore */
  }
}

/** First stack frame outside this file, as a repo-relative path. */
function callerSite() {
  const lines = String(new Error().stack || '').split('\n').slice(1);
  for (const line of lines) {
    const m = /\(([^()]+):\d+:\d+\)\s*$/.exec(line.trim()) || /at\s+(?:\S+\s+)?(\S+):\d+:\d+\s*$/.exec(line.trim());
    if (!m) continue;
    const file = m[1];
    if (file.endsWith('rateLimit.js') || file.includes('node:internal') || file === '<anonymous>') continue;
    const rel = path.relative(path.join(__dirname, '..'), file);
    return rel && !rel.startsWith('..') ? rel : path.basename(file);
  }
  return 'unknown';
}

function deriveBucket(name, windowMs, max) {
  if (name && name !== 'default') return String(name).slice(0, 120);
  const site = callerSite();
  const ord = ordinals.get(site) || 0;
  ordinals.set(site, ord + 1);
  return `${site}#${ord}|w${windowMs}|m${max}`;
}

/** The pre-Batch-55 in-memory behaviour, kept as the store-outage fallback. */
function memoryHit(bucket, key, windowMs, now) {
  let byKey = fallbackHits.get(bucket);
  if (!byKey) {
    byKey = new Map();
    fallbackHits.set(bucket, byKey);
  }
  if (byKey.size > 5000) {
    for (const [k, arr] of byKey) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (!kept.length) byKey.delete(k);
      else byKey.set(k, kept);
    }
  }
  const arr = (byKey.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  byKey.set(key, arr);
  return arr.length;
}

function rateLimit({ windowMs = 15 * 60 * 1000, max = 30, keyFn, name = 'default' } = {}) {
  logModeOnce();
  const bucket = deriveBucket(name, windowMs, max);

  return async (req, res, next) => {
    const now = Date.now();
    // Prefer Express req.ip (respects trust proxy). Do not trust leftmost XFF alone.
    const key = String((keyFn ? keyFn(req) : null) || req.ip || 'unknown').slice(0, 255);
    let count;
    try {
      count = await activeStore.recordHit(bucket, key, windowMs, now);
    } catch (e) {
      if (now - fallbackWarnedAt > 60 * 1000) {
        fallbackWarnedAt = now;
        try {
          console.warn(
            `[rateLimit] counter store unavailable (${e && e.message ? e.message : e}) — this request was counted in-memory only`
          );
        } catch {
          /* ignore */
        }
      }
      count = memoryHit(bucket, key, windowMs, now);
    }
    if (count > max) {
      try {
        console.warn(
          `[rateLimit] 429 name=${name} key=${key.slice(0, 80)} count=${count} max=${max} windowMs=${windowMs}`
        );
      } catch {
        /* ignore */
      }
      return res.status(429).json({ ok: false, error: 'RATE_LIMITED', code: 'RATE_LIMITED' });
    }
    next();
  };
}

module.exports = {
  rateLimit,
  // Test hooks: swap the counter store (e.g. a throwing stub to prove
  // the fallback) and inspect bucket derivation.
  _setStoreForTests(store) {
    activeStore = store || dbStore;
  },
  _deriveBucketForTests: deriveBucket,
};
