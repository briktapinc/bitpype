'use strict';

/**
 * Batch 40 — TOTP core (RFC 6238) + recovery codes, built only on
 * Node's crypto: HMAC-SHA1, 30-second step, 6-digit codes, ±1 step
 * verification window, base32 (RFC 4648) secrets. No new dependency —
 * the primitives are tiny and the RFC test vectors in
 * tests/mfa-totp-regressions.cjs pin the implementation.
 *
 * Secrets are 160-bit (20 random bytes → 32 base32 chars), the size
 * the RFC 4226/6238 examples assume. Recovery codes are single-use:
 * this module only generates + hashes them; storage and consumption
 * live in server/mfa.js.
 */

const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'BitPype';
const RECOVERY_CODE_COUNT = 10;

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '')
    .toUpperCase()
    .replace(/[\s=-]+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('INVALID_BASE32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** New random TOTP secret as base32 (160-bit). */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBytes, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secretBytes).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  const code = binary % 10 ** digits;
  return String(code).padStart(digits, '0');
}

function counterFor(atMs, stepSeconds = STEP_SECONDS) {
  return Math.floor(Number(atMs) / 1000 / stepSeconds);
}

function totp(secretBase32, { at = Date.now(), digits = DIGITS, stepSeconds = STEP_SECONDS } = {}) {
  return hotp(base32Decode(secretBase32), counterFor(at, stepSeconds), digits);
}

/** Normalize a user-typed code to bare digits ('' when not 6 digits). */
function normalizeCode(raw) {
  const digits = String(raw || '').replace(/\D+/g, '');
  return digits.length === DIGITS ? digits : '';
}

function codesEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify a 6-digit code against the secret at time `at`, accepting the
 * current step ± `window` steps. Returns the matched step offset
 * (-1/0/+1) or null. Comparisons are constant-time per candidate.
 */
function verify(secretBase32, rawCode, { at = Date.now(), window = 1, stepSeconds = STEP_SECONDS } = {}) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  let secretBytes;
  try {
    secretBytes = base32Decode(secretBase32);
  } catch {
    return null;
  }
  if (!secretBytes.length) return null;
  const counter = counterFor(at, stepSeconds);
  for (let offset = -window; offset <= window; offset++) {
    if (counter + offset < 0) continue;
    if (codesEqual(hotp(secretBytes, counter + offset), code)) return offset;
  }
  return null;
}

function otpauthUrl(secretBase32, account, issuer = ISSUER) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: String(secretBase32 || ''),
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ------------------------------------------------------------------
// Recovery codes: 8 hex chars displayed XXXX-XXXX. Only the SHA-256
// of the normalized code is ever stored (same one-way treatment as
// workspace tokens in server/workspace.js hashToken).
// ------------------------------------------------------------------

function normalizeRecoveryCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^0-9A-F]+/g, '');
}

function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const hex = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${hex.slice(0, 4)}-${hex.slice(4)}`);
  }
  return codes;
}

function hashRecoveryCode(raw) {
  const normalized = normalizeRecoveryCode(raw);
  if (normalized.length !== 8) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

module.exports = {
  STEP_SECONDS,
  DIGITS,
  ISSUER,
  RECOVERY_CODE_COUNT,
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  totp,
  verify,
  normalizeCode,
  otpauthUrl,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
};
