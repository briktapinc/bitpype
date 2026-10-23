'use strict';

/**
 * Encryption at rest for secret settings (audit M6).
 *
 * Secret setting values (see SECRET_KEYS in server/settingsKeys.js) are
 * stored AES-256-GCM-encrypted in the settings tables when a key is
 * configured via SETTINGS_ENCRYPTION_KEY (base64 or hex, 32 bytes —
 * generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * ).
 *
 * Stored format: "enc:v1:<base64 iv|tag|ciphertext>". Values without
 * the prefix are legacy plaintext and pass through decrypt untouched,
 * so enabling the key is a lazy migration (workspaceDb and the boot
 * sequence encrypt existing plaintext rows), never a flag day.
 *
 * Without a configured key, encrypt is a no-op (plaintext, the
 * historical behavior) so local dev keeps working — production MUST
 * set the key. Losing the key makes stored secrets unrecoverable by
 * design; they would have to be re-entered in Settings.
 */

const crypto = require('crypto');
const { SECRET_KEYS } = require('../server/settingsKeys');

const PREFIX = 'enc:v1:';
let cachedKey = null;
let keyLoaded = false;

function loadKey() {
  if (keyLoaded) return cachedKey;
  keyLoaded = true;
  const raw = String(process.env.SETTINGS_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    cachedKey = null;
    return cachedKey;
  }
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
  else {
    try {
      buf = Buffer.from(raw, 'base64');
    } catch {
      buf = null;
    }
  }
  if (!buf || buf.length !== 32) {
    // Loud, not silent: a malformed key must never quietly fall back
    // to plaintext storage in production.
    throw new Error('SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64 or hex)');
  }
  cachedKey = buf;
  return cachedKey;
}

function hasKey() {
  return !!loadKey();
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encryptValue(plain) {
  const key = loadKey();
  if (!key || plain == null || plain === '' || isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, body]).toString('base64');
}

function decryptValue(stored) {
  if (!isEncrypted(stored)) return stored;
  const key = loadKey();
  if (!key) {
    const e = new Error('Encrypted setting found but SETTINGS_ENCRYPTION_KEY is not set');
    e.code = 'SETTINGS_KEY_MISSING';
    throw e;
  }
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const body = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch (err) {
    const e = new Error('Failed to decrypt setting (wrong key or corrupted value)');
    e.code = 'SETTINGS_DECRYPT_FAILED';
    e.cause = err;
    throw e;
  }
}

/** Encrypt only when the setting key is a registered secret. */
function encryptSetting(key, value) {
  if (!SECRET_KEYS.includes(key)) return value;
  return encryptValue(value);
}

/** Decrypt is prefix-gated, so it is safe to apply to any setting. */
function decryptSetting(key, value) {
  return decryptValue(value);
}

module.exports = { hasKey, isEncrypted, encryptValue, decryptValue, encryptSetting, decryptSetting, PREFIX };
