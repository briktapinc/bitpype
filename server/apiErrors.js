'use strict';

/**
 * apiErrors — the one place API error responses are shaped (Batch 54,
 * from expert-review finding U-1/B-5: raw internal error text was, in
 * effect, UI copy, and unexpected 500s leaked library internals).
 *
 * Contract:
 *  - An error carrying an authored code (SCREAMING_SNAKE, thrown by our
 *    own engines with a message written for an audience) passes through
 *    with its code + message at any status.
 *  - A body-parser failure becomes 400 BAD_JSON with a plain message —
 *    never the parser's own wording (it echoes request bytes).
 *  - Anything else at 5xx is UNEXPECTED: the real error is logged with
 *    a short reference id (`err_<8 hex>`) and the client receives only
 *    code INTERNAL, a generic safe message, and the same ref — no raw
 *    exception message, stack, SQL text, or internal path.
 *  - Anything else below 500 keeps the legacy behaviour (message +
 *    code ERROR) so existing 4xx flows are untouched.
 *
 * Route `fail()` helpers keep their own code→status mappings (those are
 * deliberate per-surface policy); they call sendError() for the body.
 */

const crypto = require('node:crypto');

const AUTHORED_CODE = /^[A-Z][A-Z0-9_]+$/;
const GENERIC_MESSAGE = 'Something went wrong on our side.';
const BAD_JSON_MESSAGE = 'The request body could not be read as JSON.';

/* Batch 168 (S8#F3): DRIVER error codes also match the authored
 * shape — SQLITE_CONSTRAINT_UNIQUE, ER_DUP_ENTRY, SQLITE_ERROR,
 * ER_NO_SUCH_TABLE, Node errnos (ECONNREFUSED…) — and their raw
 * messages name tables, columns, constraint values and file paths
 * ("UNIQUE constraint failed: client_portal_users.email"). They are
 * NOT authored copy: an error carrying one of these codes is an
 * unexpected internal failure and must take the masking branch like
 * any uncoded error, at any status. Authored app codes never use
 * these prefixes (engines throw VALIDATION / NOT_FOUND / …). */
const DRIVER_CODE_PREFIXES = ['SQLITE_', 'ER_', 'PROTOCOL_', 'EAI_'];
const DRIVER_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'ENOENT',
  'EACCES',
  'EPERM',
  'EEXIST',
]);

function isDriverCode(code) {
  if (typeof code !== 'string') return false;
  if (DRIVER_CODES.has(code)) return true;
  return DRIVER_CODE_PREFIXES.some((p) => code.startsWith(p));
}

function newErrorRef() {
  return 'err_' + crypto.randomBytes(4).toString('hex');
}

function isAuthoredCode(code) {
  return typeof code === 'string' && AUTHORED_CODE.test(code) && code !== 'INTERNAL' && !isDriverCode(code);
}

function isBadJsonError(e) {
  return !!(
    e &&
    (e.type === 'entity.parse.failed' ||
      (e instanceof SyntaxError && (e.status === 400 || e.statusCode === 400)))
  );
}

/** Log the real error with its reference id; returns the ref. */
function logError(area, err, ref) {
  const r = ref || newErrorRef();
  console.error(`[${area || 'api'}] ${r}:`, err && err.stack ? err.stack : err);
  return r;
}

/**
 * Normalize any thrown value into { status, code, message, ref? }.
 * `http` is the status the caller already decided (route fail() mapping
 * or err.status). Logs (with ref) only in the INTERNAL branch.
 * opts.mask5xx (public form surfaces, whose pre-Batch-54 helpers masked
 * every ≥500 message to 'Server error'): at ≥500 the message is always
 * the generic one + ref, even for authored codes — the code survives.
 */
function shapeError(e, http, area, opts = {}) {
  const status =
    Number.isInteger(http) && http >= 400 && http < 600 ? http : 500;
  if (isBadJsonError(e)) {
    return { status: 400, code: 'BAD_JSON', message: BAD_JSON_MESSAGE };
  }
  const code = e && typeof e.code === 'string' ? e.code : undefined;
  if (isDriverCode(code)) {
    // Batch 168 (S8#F3): a driver-coded error is unexpected wherever
    // it lands — log it with a ref and answer generically, whatever
    // status the caller mapped (the old flow passed the raw driver
    // message through at 500 via the authored branch, and at 4xx
    // via the legacy branch).
    const ref = logError(area, e);
    return { status, code: 'INTERNAL', message: GENERIC_MESSAGE, ref };
  }
  if (opts.mask5xx && status >= 500) {
    const ref = logError(area, e);
    return { status, code: isAuthoredCode(code) ? code : 'INTERNAL', message: GENERIC_MESSAGE, ref };
  }
  if (isAuthoredCode(code)) {
    return { status, code, message: (e && (e.message || e.code)) || String(e) };
  }
  if (status >= 500) {
    const ref = logError(area, e);
    return { status, code: 'INTERNAL', message: GENERIC_MESSAGE, ref };
  }
  return { status, code: 'ERROR', message: (e && (e.message || e.detail)) || String(e) };
}

/**
 * Send the shaped error in the caller's existing body shape:
 *  - flat (most route families): { ok:false, error: <message>, code, ref? }
 *  - nested (domainApi): { ok:false, error: { code, message, ref? }, ref? }
 */
function sendError(res, e, http, opts = {}) {
  const shaped = shapeError(e, http, opts.area, opts);
  if (opts.nested) {
    const error = { code: shaped.code, message: shaped.message };
    if (shaped.ref) error.ref = shaped.ref;
    const body = { ok: false, error };
    if (shaped.ref) body.ref = shaped.ref;
    return res.status(shaped.status).json(body);
  }
  const body = { ok: false, error: shaped.message, code: shaped.code };
  if (shaped.ref) body.ref = shaped.ref;
  return res.status(shaped.status).json(body);
}

module.exports = {
  newErrorRef,
  isAuthoredCode,
  isDriverCode,
  isBadJsonError,
  logError,
  shapeError,
  sendError,
  GENERIC_MESSAGE,
  BAD_JSON_MESSAGE,
};
