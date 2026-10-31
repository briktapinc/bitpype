'use strict';

/**
 * Batch 97 — per-site, per-day design-chat ("Improve with AI")
 * request counting, the storage half of the per-plan daily cap.
 *
 * A "request" is one owner/partner chat message that enters the
 * chat pipeline (portal POST /site/agent-chat). Requests are
 * counted per SITE (lead) per calendar day; all sites in a
 * workspace share the workspace plan's cap, but each site has its
 * own pool (the counter key is the lead, never the workspace).
 *
 * The day boundary is site-local where the site has a timezone —
 * the only per-site timezone the platform keeps is the bookings
 * settings row, read here WITHOUT side effects (the bookings
 * getter creates a default row on read; this probe must not, or
 * every site would suddenly "have" the default timezone). Sites
 * with no configured timezone count on UTC days, per Ely's spec.
 *
 * The plan/limit half lives in server/plans.js
 * (chatRequestsPerDayFor, fed by the Batch 57 contents overrides);
 * the gate orchestration lives in clientPortal.js
 * (gateSiteChatRequest). This module is storage + calendar math
 * only, in the siteChatThread/siteChatPending leaf style.
 */

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_chat_daily_usage (
      lead_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (lead_id, day)
    )
  `);
}

/** True when `tz` is a timezone Intl can actually resolve. */
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The site's configured timezone, or null. Read-only probe of the
 * bookings settings row: a row with a usable timezone means the
 * site HAS a timezone; no row (or an unusable value) means it
 * doesn't, and the caller falls back to UTC.
 */
function siteTimezone(db, leadId) {
  try {
    const row = db
      .prepare('SELECT timezone FROM booking_settings WHERE lead_id = ?')
      .get(Number(leadId));
    const tz = row && row.timezone ? String(row.timezone).trim() : '';
    return isValidTimezone(tz) ? tz : null;
  } catch {
    return null; // bookings tables absent — the site has no timezone
  }
}

/** 'YYYY-MM-DD' for `nowMs` in `timezone` (null/invalid → UTC). */
function dayKey(timezone, nowMs = Date.now()) {
  const tz = isValidTimezone(timezone) ? timezone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function getDailyCount(db, leadId, day) {
  ensureTable(db);
  const row = db
    .prepare('SELECT requests FROM site_chat_daily_usage WHERE lead_id = ? AND day = ?')
    .get(Number(leadId), String(day));
  return row ? Number(row.requests) || 0 : 0;
}

/** Count one request against (lead, day); returns the new total. */
function recordDailyRequest(db, leadId, day) {
  ensureTable(db);
  const row = db
    .prepare(
      `INSERT INTO site_chat_daily_usage (lead_id, day, requests)
       VALUES (?, ?, 1)
       ON CONFLICT(lead_id, day) DO UPDATE SET
         requests = requests + 1,
         updated_at = datetime('now')
       RETURNING requests`
    )
    .get(Number(leadId), String(day));
  return row ? Number(row.requests) || 0 : getDailyCount(db, leadId, day);
}

/**
 * The gate's decision core, kept pure over (db, leadId, limit) so
 * the regression suite can drive it without a billing fixture:
 *   - limit null → unlimited: always allowed, nothing counted.
 *   - count >= limit → refused; the count is NOT incremented (a
 *     refused request never enters the pipeline and is not a
 *     request).
 *   - otherwise the request is counted FIRST (it is about to
 *     enter the pipeline) and allowed.
 * Returns { allowed, used, limit, timezone, day } where `used` is
 * the count AFTER this decision for an allowed turn.
 */
function checkAndRecord(db, { leadId, limit, nowMs } = {}) {
  const timezone = siteTimezone(db, leadId);
  const day = dayKey(timezone, nowMs);
  if (limit == null) return { allowed: true, used: null, limit: null, timezone, day };
  const used = getDailyCount(db, leadId, day);
  if (used >= limit) return { allowed: false, used, limit, timezone, day };
  const next = recordDailyRequest(db, leadId, day);
  return { allowed: true, used: next, limit, timezone, day };
}

module.exports = {
  ensureTable,
  isValidTimezone,
  siteTimezone,
  dayKey,
  getDailyCount,
  recordDailyRequest,
  checkAndRecord,
};
