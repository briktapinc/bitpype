'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, driver } = require('./db');
const { findUserByEmail } = require('./workspace');
const { staffUrl } = require('./appUrls');
const { sendPlatformMail } = require('./mailer');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/* Batch 180 (L1): per-email throttle for the STAFF reset path,
 * mirroring the portal side's allowAccessEmail (portalAccounts.js:
 * 3 hits per sliding hour in the durable Batch 55 rateLimitStore,
 * in-memory Map only as the store-outage fallback). Before this,
 * requestReset had NO per-email bucket — only the route's per-IP
 * limit + captcha — so rotating IPs could keep deleting a victim's
 * outstanding reset token (each request below deletes it before
 * issuing a new one) and flood their inbox indefinitely. The
 * bucket is staff-specific ('staff-reset-email'), not shared with
 * the portal bucket. */
/* rateLimitStore is required lazily inside allowResetEmail: a
 * store module that cannot load is just another store outage and
 * lands in the same in-memory fallback (and strict VM module
 * loaders in the regression suites keep working). */
const RESET_EMAIL_BUCKET = 'staff-reset-email';
const RESET_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const RESET_EMAIL_MAX = 3;
const resetEmailHits = new Map(); // fallback only: email -> { n, resetAt }
let resetEmailFallbackWarnedAt = 0;
function allowResetEmailMemory(email) {
  const key = String(email || '');
  const now = Date.now();
  let row = resetEmailHits.get(key);
  if (!row || now >= row.resetAt) {
    row = { n: 0, resetAt: now + RESET_EMAIL_WINDOW_MS };
    resetEmailHits.set(key, row);
  }
  if (row.n >= RESET_EMAIL_MAX) return false;
  row.n += 1;
  if (resetEmailHits.size > 5000) {
    for (const [k, v] of resetEmailHits) {
      if (now >= v.resetAt) resetEmailHits.delete(k);
    }
  }
  return true;
}
async function allowResetEmail(email) {
  const key = String(email || '');
  try {
    const rateLimitStore = require('./rateLimitStore');
    const count = await rateLimitStore.recordHit(RESET_EMAIL_BUCKET, key, RESET_EMAIL_WINDOW_MS, Date.now());
    return count <= RESET_EMAIL_MAX;
  } catch (e) {
    const now = Date.now();
    if (now - resetEmailFallbackWarnedAt > 60 * 1000) {
      resetEmailFallbackWarnedAt = now;
      console.warn(
        `[passwordReset] reset-email counter store unavailable (${e && e.message ? e.message : e}) — counted in-memory only`
      );
    }
    return allowResetEmailMemory(key);
  }
}

async function requestReset(email) {
  // Throttle BEFORE any token work, keyed on the normalized email —
  // a throttled request must not delete the victim's live reset
  // token or send mail, and answers identically to any other
  // request (enumeration-uniform, like the portal side).
  const cleanEmail = String(email || '')
    .trim()
    .toLowerCase();
  if (cleanEmail && !(await allowResetEmail(cleanEmail))) {
    return { ok: true };
  }
  const user = await findUserByEmail(email);
  // Always return ok to avoid email enumeration
  if (!user || String(user.status) === 'disabled') {
    return { ok: true };
  }
  const raw = crypto.randomBytes(24).toString('hex');
  const tokenHash = hashToken(raw);
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  const expiresSql = expires.toISOString().slice(0, 19).replace('T', ' ');

  await query('DELETE FROM password_reset_tokens WHERE user_id = :userId', { userId: user.id });
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES (:userId, :tokenHash, :expiresAt)`,
    { userId: user.id, tokenHash, expiresAt: expiresSql }
  );

  const link = staffUrl(`reset/${encodeURIComponent(raw)}`);
  try {
    await sendPlatformMail({
      to: user.email,
      subject: 'Reset your Bitpype password',
      title: 'Reset your password',
      paragraphs: [
        'We received a request to reset your Bitpype password.',
        'This link expires in 1 hour. If you did not ask for a reset, you can ignore this email.',
      ],
      cta: { url: link, label: 'Reset password' },
      text: `Reset your Bitpype password.\n\nReset password: ${link}\n\nExpires in 1 hour.`,
    });
  } catch (e) {
    // Never put reset links in the HTTP response body.
    if (e.code === 'SMTP_NOT_CONFIGURED' && process.env.NODE_ENV !== 'production') {
      console.warn('[passwordReset] SMTP not configured — reset link (dev console only):', link);
    } else {
      console.warn('[passwordReset] email:', e.message);
    }
  }
  // Uniform response — no emailed/resetLink fields (enumeration + credential leak).
  return { ok: true };
}

async function confirmReset(rawToken, newPassword) {
  if (!newPassword || String(newPassword).length < 8) {
    throw Object.assign(new Error('password must be at least 8 characters'), { code: 'WEAK_PASSWORD' });
  }
  const tokenHash = hashToken(rawToken);
  const rows = await query('SELECT * FROM password_reset_tokens WHERE token_hash = :tokenHash LIMIT 1', { tokenHash });
  const row = rows[0];
  if (!row) throw Object.assign(new Error('INVALID_TOKEN'), { code: 'INVALID_TOKEN' });
  if (row.used_at) throw Object.assign(new Error('TOKEN_USED'), { code: 'TOKEN_USED' });
  const exp = new Date(String(row.expires_at).replace(' ', 'T') + 'Z');
  // Batch 143: expiry fails CLOSED — an unparseable stored date (e.g.
  // a MySQL zero-date) is treated as expired, never as "no expiry".
  if (!Number.isFinite(exp.getTime()) || exp.getTime() < Date.now()) {
    throw Object.assign(new Error('TOKEN_EXPIRED'), { code: 'TOKEN_EXPIRED' });
  }

  // Batch 143: claim the token atomically BEFORE the slow bcrypt
  // hash. The previous shape checked used_at, awaited bcrypt, and
  // only then marked the token used — two concurrent confirms both
  // passed the check and both set a password. The conditional UPDATE
  // is the single-use claim; a loser sees TOKEN_USED.
  const claim = await query(
    driver() === 'sqlite'
      ? "UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = :id AND used_at IS NULL"
      : 'UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = :id AND used_at IS NULL',
    { id: row.id }
  );
  if (!(Number(claim.affectedRows || claim.changes || 0) > 0)) {
    throw Object.assign(new Error('TOKEN_USED'), { code: 'TOKEN_USED' });
  }

  const hash = await bcrypt.hash(String(newPassword), 12);
  await query('UPDATE users SET password_hash = :hash WHERE id = :id', { hash, id: row.user_id });
  // (used_at was already stamped by the atomic claim above.)
  // Invalidate staff sessions for this user by parsing session JSON (never LIKE substrings).
  try {
    const uid = Number(row.user_id);
    const candidates = await query(`SELECT session_id, data FROM sessions WHERE data LIKE :pat`, { pat: '%"userId"%' });
    for (const sess of candidates || []) {
      let parsed;
      try {
        parsed = JSON.parse(sess.data);
      } catch {
        continue;
      }
      if (Number(parsed && parsed.userId) === uid) {
        await query('DELETE FROM sessions WHERE session_id = :sid', { sid: sess.session_id });
      }
    }
  } catch (e) {
    console.warn('[passwordReset] session wipe:', e.message);
  }
  return { ok: true };
}

module.exports = { requestReset, confirmReset, allowResetEmail };
