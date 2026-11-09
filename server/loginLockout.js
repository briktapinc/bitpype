'use strict';

/**
 * Batch 154 (§9) — per-account LOGIN lockout for both login surfaces.
 *
 * Before this batch, password guessing was throttled only per-IP
 * (server/rateLimit.js on the auth routers) plus the MFA code
 * throttle (server/mfa.js) once the second factor was reached. The
 * Oct 2026 reviews left per-account lockout as an open §9 decision;
 * Ely ordered the §9 list implemented on 2026-11-06.
 *
 *   staff  → platform `users` table
 *   portal → platform `client_portal_users` table
 *
 * (Both surfaces live in the platform DB — see server/mfa.js header.)
 *
 * Storage (columns added by server/db.js migrate on both tables):
 *   login_failed_attempts  consecutive failed password attempts
 *   login_locked_until     set when attempts hit
 *                          MAX_FAILED_ATTEMPTS; while in the future,
 *                          the credential-verify path refuses the
 *                          login BEFORE password verification can
 *                          complete the flow (so a locked account
 *                          never reaches an MFA challenge), and the
 *                          outward response is the SAME generic
 *                          credential failure as a wrong password —
 *                          the lock is visible only in server-side
 *                          logs / SEC-21 auth events.
 *
 * Rules (mirroring server/mfa.js discipline):
 *   - MAX_FAILED_ATTEMPTS consecutive failures engage the lock for
 *     LOCK_MS. The counter resets when the lock engages, and a
 *     successful login resets it at any time.
 *   - Failures are recorded with an in-SQL increment (Batch 145/F13
 *     lesson: read/modify/write loses concurrent failures).
 *   - Failures are NOT recorded while a lock is active, so an
 *     attacker cannot extend a victim's lock indefinitely; the
 *     lock expires LOCK_MS after it engaged, whatever happens.
 */

const { query } = require('./db');

const SURFACES = {
  staff: 'users',
  portal: 'client_portal_users',
};

const MAX_FAILED_ATTEMPTS = 10;
const LOCK_MS = 15 * 60 * 1000;

function tableFor(surface) {
  const table = SURFACES[surface];
  if (!table) throw new Error(`unknown login-lockout surface: ${surface}`);
  return table;
}

function toSqlDateTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function parseSqlDateTime(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T') + 'Z');
  return Number.isFinite(d.getTime()) ? d : null;
}

async function readRow(surface, id) {
  const table = tableFor(surface);
  const rows = await query(`SELECT login_failed_attempts, login_locked_until FROM ${table} WHERE id = :id LIMIT 1`, {
    id: Number(id),
  });
  return rows[0] || null;
}

/** { locked: boolean, lockedUntil: Date|null } for an account. */
async function getState(surface, id) {
  const row = await readRow(surface, id);
  if (!row) return { locked: false, lockedUntil: null };
  const locked = parseSqlDateTime(row.login_locked_until);
  if (locked && locked.getTime() > Date.now()) return { locked: true, lockedUntil: locked };
  // Batch 168 (S1#5): a NON-EMPTY but unparseable stored lock value
  // (manual DB edit, a legacy zero/garbage date) previously read as
  // "not locked" — fail OPEN on a security control. Fail closed with
  // a fresh lock window instead (mirrors the Batch 143 discipline:
  // an unreadable expiry is an active expiry, never an absent one).
  const raw = row.login_locked_until;
  if (raw != null && String(raw).trim() !== '') {
    return { locked: true, lockedUntil: new Date(Date.now() + LOCK_MS) };
  }
  return { locked: false, lockedUntil: null };
}

async function isLocked(surface, id) {
  return (await getState(surface, id)).locked;
}

/**
 * Count a failed password attempt. Returns { locked, justLocked }:
 * `locked` is the state after this failure; `justLocked` is true
 * only on the failure that crossed the threshold (callers use it to
 * raise the SEC-21 lockout event exactly once). A no-op while a
 * lock is already active (see header — locks never extend).
 */
async function recordFailure(surface, id) {
  const table = tableFor(surface);
  const before = await getState(surface, id);
  if (before.locked) return { locked: true, justLocked: false };
  await query(`UPDATE ${table} SET login_failed_attempts = COALESCE(login_failed_attempts, 0) + 1 WHERE id = :id`, {
    id: Number(id),
  });
  const row = await readRow(surface, id);
  const attempts = row ? Number(row.login_failed_attempts) || 0 : 0;
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    // Reset + lock, guarded on the counter still being at/over the
    // threshold so a racing recordSuccess isn't clobbered.
    const stamp = await query(
      `UPDATE ${table} SET login_failed_attempts = 0, login_locked_until = :until WHERE id = :id AND login_failed_attempts >= :max`,
      {
        until: toSqlDateTime(Date.now() + LOCK_MS),
        id: Number(id),
        max: MAX_FAILED_ATTEMPTS,
      }
    );
    const engaged = Number(stamp.affectedRows || stamp.changes || 0) > 0;
    return { locked: true, justLocked: engaged };
  }
  return { locked: false, justLocked: false };
}

/** A successful login clears the counter and any expired lock. */
async function recordSuccess(surface, id) {
  const table = tableFor(surface);
  await query(`UPDATE ${table} SET login_failed_attempts = 0, login_locked_until = NULL WHERE id = :id`, {
    id: Number(id),
  });
}

module.exports = {
  SURFACES,
  MAX_FAILED_ATTEMPTS,
  LOCK_MS,
  getState,
  isLocked,
  recordFailure,
  recordSuccess,
};
