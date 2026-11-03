'use strict';

/**
 * Batch 121 — portal set-password flow ("Email me a link to set my
 * password"). Portal accounts are provisioned with a random,
 * never-disclosed password hash (sign-in is by magic link), so most
 * portal users have NO usable password — yet MFA setup/disable asks
 * for one. This module issues a one-time set-password link instead:
 * the emailed link never carries a password (hashes are one-way);
 * it lets the user SET a new one.
 *
 * Mechanics mirror the staff flow (server/passwordReset.js) — sha256
 * token hash at rest, 1-hour expiry, single use, prior tokens deleted
 * on issue — but against client_portal_users +
 * client_portal_password_tokens, never the staff `users` table.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, driver } = require('./db');
const { findByEmail, findById, normalizeEmail, allowAccessEmail } = require('./portalAccounts');
const { sendPlatformMail } = require('./mailer');
const { appUrl } = require('./stripeClient');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function issuePasswordSetLink(user) {
  const raw = crypto.randomBytes(24).toString('hex');
  const tokenHash = hashToken(raw);
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  const expiresSql = expires.toISOString().slice(0, 19).replace('T', ' ');

  await query('DELETE FROM client_portal_password_tokens WHERE portal_user_id = :uid', {
    uid: user.id,
  });
  await query(
    `INSERT INTO client_portal_password_tokens (portal_user_id, token_hash, expires_at)
     VALUES (:uid, :tokenHash, :expiresAt)`,
    { uid: user.id, tokenHash, expiresAt: expiresSql }
  );

  const link = `${appUrl()}/portal?setpw=${encodeURIComponent(raw)}`;
  const safeName = user.business_name ? ` for ${user.business_name}` : '';
  try {
    await sendPlatformMail({
      to: user.email,
      subject: 'Set your Bitpype portal password',
      title: 'Set your portal password',
      paragraphs: [
        `Use this link to set a password for your Bitpype client portal account${safeName}.`,
        'This link expires in 1 hour and can only be used once.',
        'If you did not request this, you can ignore this email — your sign-in links keep working and nothing changes.',
      ],
      cta: { url: link, label: 'Set my password' },
      text: `Set a password for your Bitpype client portal account${safeName}.\n\nSet my password: ${link}\n\nExpires in 1 hour and can only be used once.\n`,
    });
  } catch (err) {
    // Never put set-password links in the HTTP response body.
    if (err.code === 'SMTP_NOT_CONFIGURED' && process.env.NODE_ENV !== 'production') {
      console.warn('[portalPassword] SMTP not configured — set-password link (dev console only):', link);
    } else {
      console.warn('[portalPassword] email send failed:', err.message);
    }
  }
  return { ok: true, userId: user.id, email: user.email };
}

/**
 * Signed-in path: the caller is already authenticated as this portal
 * user (requireClient), so the link goes to the account's own email —
 * no address input, no enumeration surface.
 */
async function requestForUser(userId) {
  const user = await findById(userId);
  if (!user || String(user.status) !== 'active') return { ok: true };
  return issuePasswordSetLink(user);
}

/**
 * Signed-out path: ALWAYS resolves to a generic { ok: true } at the
 * route. Unknown, malformed, rate-limited, and disabled addresses all
 * behave identically and send nothing. The per-email rate limit is the
 * same bucket /access uses (allowAccessEmail, 3/hour).
 */
async function requestByEmail(email) {
  const e = normalizeEmail(email);
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    return { ok: true };
  }
  if (!allowAccessEmail(e)) {
    return { ok: true };
  }
  const user = await findByEmail(e);
  if (!user || String(user.status) !== 'active') {
    return { ok: true };
  }
  return issuePasswordSetLink(user);
}

async function confirmPasswordSet(rawToken, newPassword, { keepSessionId } = {}) {
  if (!newPassword || String(newPassword).length < 8) {
    throw Object.assign(new Error('password must be at least 8 characters'), { code: 'WEAK_PASSWORD' });
  }
  const raw = String(rawToken || '').trim();
  if (!raw || raw.length < 16) {
    throw Object.assign(new Error('INVALID_TOKEN'), { code: 'INVALID_TOKEN' });
  }
  const tokenHash = hashToken(raw);
  const rows = await query('SELECT * FROM client_portal_password_tokens WHERE token_hash = :tokenHash LIMIT 1', {
    tokenHash,
  });
  const row = rows[0];
  if (!row) throw Object.assign(new Error('INVALID_TOKEN'), { code: 'INVALID_TOKEN' });
  if (row.used_at) throw Object.assign(new Error('TOKEN_USED'), { code: 'TOKEN_USED' });
  const exp = new Date(String(row.expires_at).replace(' ', 'T') + 'Z');
  if (Number.isFinite(exp.getTime()) && exp.getTime() < Date.now()) {
    throw Object.assign(new Error('TOKEN_EXPIRED'), { code: 'TOKEN_EXPIRED' });
  }

  const user = await findById(row.portal_user_id);
  if (!user || String(user.status) !== 'active') {
    throw Object.assign(new Error('INVALID_TOKEN'), { code: 'INVALID_TOKEN' });
  }

  const hash = await bcrypt.hash(String(newPassword), 12);
  const stamp =
    driver() === 'sqlite'
      ? "UPDATE client_portal_users SET password_hash = :hash, updated_at = datetime('now') WHERE id = :id"
      : 'UPDATE client_portal_users SET password_hash = :hash, updated_at = CURRENT_TIMESTAMP WHERE id = :id';
  await query(stamp, { hash, id: user.id });
  await query(
    driver() === 'sqlite'
      ? "UPDATE client_portal_password_tokens SET used_at = datetime('now') WHERE id = :id"
      : 'UPDATE client_portal_password_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = :id',
    { id: row.id }
  );
  // Single-use means the whole family dies: every other outstanding
  // set-password token for this user is deleted.
  await query('DELETE FROM client_portal_password_tokens WHERE portal_user_id = :uid AND id <> :id', {
    uid: user.id,
    id: row.id,
  });

  // Session hygiene (mirrors the staff reset): every OTHER portal
  // session for this user dies; the session that submitted the set —
  // if it is this user's own — survives, so a signed-in user who sets
  // a password from their email link is not bounced out of the portal.
  try {
    const uid = Number(user.id);
    const candidates = await query(`SELECT session_id, data FROM sessions WHERE data LIKE :pat`, {
      pat: '%"clientPortalId"%',
    });
    for (const sess of candidates || []) {
      if (keepSessionId && sess.session_id === keepSessionId) continue;
      let parsed;
      try {
        parsed = JSON.parse(sess.data);
      } catch {
        continue;
      }
      if (Number(parsed && parsed.clientPortalId) === uid) {
        await query('DELETE FROM sessions WHERE session_id = :sid', { sid: sess.session_id });
      }
    }
  } catch (e) {
    console.warn('[portalPassword] session wipe:', e.message);
  }

  return { ok: true, userId: user.id, email: user.email, workspaceId: user.workspace_id };
}

module.exports = { requestForUser, requestByEmail, confirmPasswordSet };
