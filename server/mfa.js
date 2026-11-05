'use strict';

/**
 * Batch 40 — MFA (TOTP) service for both login surfaces.
 *
 *   staff  → platform `users` table; TOTP is REQUIRED (Ely 2026-10-28):
 *            a staff login with no confirmed TOTP is routed into the
 *            inline enrollment flow and gets NO session until a code
 *            confirms the secret.
 *   portal → platform `client_portal_users` table; TOTP is OPT-IN:
 *            the code step appears at login only when the client has
 *            enabled it from the portal Security section.
 *
 * (Portal users live in the platform DB — server/clientPortal.js is
 * explicit that the table is "platform DB only, never workspace
 * SQLite" — so both surfaces store their MFA state here.)
 *
 * Storage (columns added by server/db.js migrate on both tables):
 *   totp_secret           confirmed secret, secretBox-encrypted
 *   totp_pending_secret   enrollment-in-progress secret, encrypted;
 *                         NEVER counts as enabled on its own, so a
 *                         half-finished enrollment can't lock anyone
 *                         out or silently arm MFA
 *   totp_enabled          1 only after a code confirmed the secret
 *   totp_recovery_hashes  JSON array of SHA-256 hashes (codes are
 *                         single-use: a match removes its hash)
 *   totp_failed_attempts  consecutive failed code attempts
 *   totp_locked_until     set when attempts hit MAX_FAILED_ATTEMPTS;
 *                         while in the future, EVERY code (even a
 *                         correct one) is refused with MFA_LOCKED.
 *                         Persisted per account, so re-logging in
 *                         does not reset the throttle.
 *   totp_last_step        (Batch 143) highest TOTP step ever
 *                         accepted for the account; a code matching
 *                         that step or an earlier one is a replay
 *                         and is refused — TOTP codes are
 *                         single-use, like the recovery codes.
 *
 * Secrets are encrypted with src/secretBox (AES-256-GCM when
 * SETTINGS_ENCRYPTION_KEY is configured, as in production) and are
 * never returned by any function here except startEnrollment, which
 * hands the NEW pending secret to its owner for QR/manual setup.
 */

const { query } = require('./db');
const secretBox = require('../src/secretBox');
const totp = require('../src/totp');

const SURFACES = {
  staff: 'users',
  portal: 'client_portal_users',
};

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

function tableFor(surface) {
  const table = SURFACES[surface];
  if (!table) throw new Error(`unknown MFA surface: ${surface}`);
  return table;
}

function codedError(code, message, extra) {
  return Object.assign(new Error(message || code), { code, ...(extra || {}) });
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
  const rows = await query(
    `SELECT totp_secret, totp_pending_secret, totp_enabled, totp_recovery_hashes,
            totp_failed_attempts, totp_locked_until, totp_last_step
     FROM ${table} WHERE id = :id LIMIT 1`,
    { id: Number(id) }
  );
  return rows[0] || null;
}

async function getState(surface, id) {
  const row = await readRow(surface, id);
  if (!row) return { exists: false, enabled: false, hasPending: false, lockedUntil: null };
  const locked = parseSqlDateTime(row.totp_locked_until);
  return {
    exists: true,
    enabled: Number(row.totp_enabled) === 1 && !!row.totp_secret,
    hasPending: !!row.totp_pending_secret,
    lockedUntil: locked && locked.getTime() > Date.now() ? locked : null,
  };
}

async function isEnabled(surface, id) {
  return (await getState(surface, id)).enabled;
}

function decryptSecret(stored) {
  if (!stored) return null;
  try {
    return secretBox.decryptValue(stored);
  } catch {
    return null;
  }
}

async function assertNotLocked(surface, id) {
  const state = await getState(surface, id);
  if (state.lockedUntil) {
    throw codedError('MFA_LOCKED', 'Too many incorrect codes. Try again in a few minutes.', {
      lockedUntil: state.lockedUntil.toISOString(),
    });
  }
}

/** Count a failed code attempt; the MAX-th consecutive failure locks. */
async function recordFailure(surface, id) {
  const table = tableFor(surface);
  // Batch 145 (external review F13): the increment happens IN SQL —
  // the old read/modify/write lost concurrent failures (two parallel
  // bad codes left the counter at 1), diluting the lockout. The
  // follow-up read only observes the atomically-incremented value.
  await query(
    `UPDATE ${table} SET totp_failed_attempts = COALESCE(totp_failed_attempts, 0) + 1 WHERE id = :id`,
    { id: Number(id) }
  );
  const row = await readRow(surface, id);
  const attempts = row ? Number(row.totp_failed_attempts) || 0 : 0;
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    // Reset + lock, guarded on the counter still being at/over the
    // threshold so a racing recordSuccess isn't clobbered.
    await query(
      `UPDATE ${table} SET totp_failed_attempts = 0, totp_locked_until = :until WHERE id = :id AND totp_failed_attempts >= :max`,
      {
        until: toSqlDateTime(Date.now() + LOCK_MS),
        id: Number(id),
        max: MAX_FAILED_ATTEMPTS,
      }
    );
    throw codedError('MFA_LOCKED', 'Too many incorrect codes. Try again in a few minutes.', {
      lockedUntil: new Date(Date.now() + LOCK_MS).toISOString(),
    });
  }
}

async function recordSuccess(surface, id) {
  const table = tableFor(surface);
  await query(`UPDATE ${table} SET totp_failed_attempts = 0, totp_locked_until = NULL WHERE id = :id`, {
    id: Number(id),
  });
}

/**
 * Try a code against a stored (encrypted) secret, or against the
 * stored recovery-code hashes. Both shapes are always attempted in
 * order (TOTP first): a recovery code whose hex happens to contain
 * exactly six digits must still reach the recovery branch — gating
 * the branch on "doesn't look like a TOTP code" would silently reject
 * ~1 in 4 recovery codes. A recovery match CONSUMES the code (its
 * hash is removed before this returns). Throws MFA_INVALID_CODE.
 */
async function tryCode(surface, id, row, rawCode, opts = {}) {
  const code = String(rawCode || '').trim();
  if (!code) throw codedError('MFA_INVALID_CODE', 'Enter the code from your authenticator app.');

  const secret = decryptSecret(row.totp_secret || row.totp_pending_secret);
  if (secret) {
    const step = totp.matchedStep(secret, code);
    if (step != null) {
      // Batch 143 (full review): TOTP codes are single-use AT LOGIN.
      // The highest accepted step is persisted per account; a login
      // code at or below it is a replay and is refused (and counted
      // as a failed attempt by the callers, like any bad code). The
      // stamp is a conditional UPDATE so two concurrent verifies of
      // the same code can't both win — the loser's UPDATE matches no
      // row. Enrollment confirmation passes consumeStep:false — it
      // must not burn the step, or the owner's first login inside
      // the same 30s window (confirm → sign in with the code still
      // on screen) would be refused as a false replay.
      if (opts.consumeStep === false) return { via: 'totp' };
      const table = tableFor(surface);
      const stamp = await query(
        `UPDATE ${table} SET totp_last_step = :s WHERE id = :id AND (totp_last_step IS NULL OR totp_last_step < :s)`,
        { s: step, id: Number(id) }
      );
      if (!(Number(stamp.affectedRows || stamp.changes || 0) > 0)) {
        throw codedError('MFA_INVALID_CODE', 'That code has already been used. Wait for a new code and try again.');
      }
      return { via: 'totp' };
    }
  }

  const hash = totp.hashRecoveryCode(code);
  if (hash && row.totp_recovery_hashes) {
    let hashes = [];
    try {
      hashes = JSON.parse(row.totp_recovery_hashes) || [];
    } catch {
      hashes = [];
    }
    const idx = hashes.indexOf(hash);
    if (idx >= 0) {
      hashes.splice(idx, 1);
      const table = tableFor(surface);
      // Batch 145 (external review F13): consumption is a
      // compare-and-swap on the exact snapshot this request read —
      // the same discipline as the TOTP step stamp above. Two
      // concurrent requests presenting the same code both read the
      // unused snapshot, but only the first UPDATE matches; the
      // loser's snapshot is stale, matches no row, and the code is
      // refused as already used.
      const consumed = await query(
        `UPDATE ${table} SET totp_recovery_hashes = :h WHERE id = :id AND totp_recovery_hashes = :old`,
        {
          h: JSON.stringify(hashes),
          id: Number(id),
          old: row.totp_recovery_hashes,
        }
      );
      if (!(Number(consumed.affectedRows || consumed.changes || 0) > 0)) {
        throw codedError('MFA_INVALID_CODE', 'That code has already been used.');
      }
      return { via: 'recovery' };
    }
  }
  throw codedError('MFA_INVALID_CODE', 'That code is not correct.');
}

/**
 * Begin (or restart) enrollment: a fresh pending secret is stored
 * encrypted and returned ONCE to its owner for QR/manual setup.
 * Enrollment is not active until confirmEnrollment verifies a code.
 */
async function startEnrollment(surface, id, email) {
  const table = tableFor(surface);
  const secret = totp.generateSecret();
  await query(`UPDATE ${table} SET totp_pending_secret = :s WHERE id = :id`, {
    s: secretBox.encryptValue(secret),
    id: Number(id),
  });
  return { secret, otpauthUrl: totp.otpauthUrl(secret, email) };
}

/**
 * Confirm enrollment with a code from the authenticator app. On
 * success the pending secret becomes the confirmed secret, MFA turns
 * on, and 10 single-use recovery codes are generated — the plaintext
 * codes are returned here and never stored or shown again.
 */
async function confirmEnrollment(surface, id, rawCode) {
  const table = tableFor(surface);
  await assertNotLocked(surface, id);
  const row = await readRow(surface, id);
  if (!row || !row.totp_pending_secret) {
    throw codedError('MFA_NO_PENDING', 'Start the authenticator setup first.');
  }
  try {
    await tryCode(surface, id, { ...row, totp_secret: row.totp_pending_secret, totp_recovery_hashes: null }, rawCode, { consumeStep: false });
  } catch (e) {
    if (e.code === 'MFA_INVALID_CODE') await recordFailure(surface, id);
    throw e;
  }
  const recoveryCodes = totp.generateRecoveryCodes(totp.RECOVERY_CODE_COUNT);
  const hashes = recoveryCodes.map((c) => totp.hashRecoveryCode(c));
  await query(
    `UPDATE ${table}
     SET totp_secret = totp_pending_secret, totp_pending_secret = NULL,
         totp_enabled = 1, totp_recovery_hashes = :h,
         totp_failed_attempts = 0, totp_locked_until = NULL
     WHERE id = :id`,
    { h: JSON.stringify(hashes), id: Number(id) }
  );
  return { recoveryCodes };
}

/**
 * Verify a code for an account with MFA enabled (the login second
 * factor, or the code half of portal self-disable). Accepts a TOTP
 * code or a recovery code. Throws MFA_INVALID_CODE / MFA_LOCKED.
 * The login path consumes the TOTP step (single-use, Batch 143);
 * the self-disable path passes consumeStep:false — it already runs
 * inside an authenticated session behind a password check, and
 * burning the step there would refuse a legitimate disable done in
 * the same 30s window as the login that started the session.
 */
async function verifyLoginCode(surface, id, rawCode, opts = {}) {
  await assertNotLocked(surface, id);
  const row = await readRow(surface, id);
  if (!row || Number(row.totp_enabled) !== 1 || !row.totp_secret) {
    throw codedError('MFA_NOT_ENABLED', 'Two-factor authentication is not enabled for this account.');
  }
  try {
    const result = await tryCode(surface, id, row, rawCode, opts);
    await recordSuccess(surface, id);
    return result;
  } catch (e) {
    if (e.code === 'MFA_INVALID_CODE') await recordFailure(surface, id);
    throw e;
  }
}

/** Clear every MFA field (self-disable after auth, or admin reset). */
async function clearMfa(surface, id) {
  const table = tableFor(surface);
  await query(
    `UPDATE ${table}
     SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0,
         totp_recovery_hashes = NULL, totp_failed_attempts = 0, totp_locked_until = NULL, totp_last_step = NULL
     WHERE id = :id`,
    { id: Number(id) }
  );
}

module.exports = {
  SURFACES,
  MAX_FAILED_ATTEMPTS,
  LOCK_MS,
  getState,
  isEnabled,
  startEnrollment,
  confirmEnrollment,
  verifyLoginCode,
  clearMfa,
};
