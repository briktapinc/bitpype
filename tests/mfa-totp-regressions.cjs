'use strict';
/**
 * Batch 40 — MFA (TOTP): required for staff, opt-in for portal clients
 * (Ely 2026-10-28). Boots the real server on sqlite and drives both
 * login surfaces over HTTP:
 *
 *   unit — RFC 6238 vectors, ±1 window, wrong-code rejection, base32.
 *   staff — password alone issues NO session; forced inline enrollment
 *           (pending secret encrypted, not enabled until a code
 *           confirms); code step on later logins; recovery codes are
 *           single-use; 5 bad codes lock the factor (persisted, not
 *           reset by re-login); a super admin can reset another staff
 *           member, who then re-enrolls — never a lockout.
 *   portal — no code step while opt-in is off; Security endpoints
 *           enable (password → QR → confirm → recovery codes); login
 *           AND magic link both stop at the code step while on;
 *           self-disable needs password + code; admin reset works.
 *
 * Negative proofs (each applied, caught, restored):
 *   - finishStaffLogin called from /login (session before factor),
 *   - startEnrollment storing the plaintext secret,
 *   - recovery-code consumption removed (code reusable).
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bitpype-mfa40-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.CAPTCHA_OPTIONAL = '1';
process.env.APP_URL = 'https://bitpype.test';
process.env.SESSION_SECRET = 'mfa40-fixture-session-secret';
process.env.NODE_ENV = 'production';
process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const PORT = 31407;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
function check(name, cond) {
  assert(cond, name);
  results.push(name);
}

const ADMIN_EMAIL = 'admin40@example.invalid';
const ADMIN_PASSWORD = 'AdminPass40!';
const STAFF_EMAIL = 'staff40@example.invalid';
const STAFF_PASSWORD = 'StaffPass40!';
const PORTAL_EMAIL = 'portal40@example.invalid';
const PORTAL_PASSWORD = 'PortalPass40!';

const totp = require(path.join(root, 'src/totp.js'));
const secretBox = require(path.join(root, 'src/secretBox.js'));

function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
      if (cookies.size) {
        headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      }
      if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
      const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
      const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const c of set) {
        const pair = String(c).split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return res;
    },
  };
}

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Batch 112: dialect-aware probe. The platform rows live wherever
// the facade points (temp SQLite file in the SQLite pass, a real
// MySQL database in the MySQL pass) — a readonly better-sqlite3
// handle on SQLITE_PATH only ever worked in one dialect.
async function probe(sql, ...params) {
  const pdb = require(path.join(root, 'server/db.js'));
  const pragma = /pragma_table_info\('([a-z_]+)'\)/i.exec(sql);
  if (pragma && pdb.driver() === 'mysql') {
    const like = /name LIKE '([^']+)'/i.exec(sql)[1];
    const rows = await pdb.query(
      'SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME LIKE :p',
      { t: pragma[1], p: like }
    );
    return { c: Number(rows[0].c) };
  }
  const rows = await pdb.query(sql, params);
  return rows[0];
}

// Batch 112: dialect-aware, like probe() above (was: a direct
// better-sqlite3 write to the platform SQLite file).
async function execSql(sql, ...params) {
  const pdb = require(path.join(root, 'server/db.js'));
  return pdb.query(sql, params);
}

async function main() {
  // ------------------------------------------------------------- unit
  const rfcSecret = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  check('base32 of the RFC secret', rfcSecret === 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  check('base32 roundtrip', totp.base32Decode(rfcSecret).equals(Buffer.from('12345678901234567890', 'ascii')));
  // RFC 6238 Appendix B SHA-1 vectors (cross-verified against an
  // independent implementation; the RFC's printed value for the final
  // row is a known erratum — the value below is the computed one).
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [sec, expected] of vectors) {
    check(`RFC 6238 vector T=${sec}`, totp.totp(rfcSecret, { at: sec * 1000, digits: 8 }) === expected);
  }
  check('6-digit truncation', totp.totp(rfcSecret, { at: 59000 }) === '287082');
  const codeAt59 = totp.totp(rfcSecret, { at: 59000 });
  check('verify accepts the current step', totp.verify(rfcSecret, codeAt59, { at: 59000 }) === 0);
  check('verify accepts -1 step', totp.verify(rfcSecret, codeAt59, { at: 89000 }) === -1);
  check('verify accepts +1 step', totp.verify(rfcSecret, codeAt59, { at: 29000 }) === 1);
  check('verify rejects ±2 steps', totp.verify(rfcSecret, codeAt59, { at: 119000 }) === null);
  check('verify rejects a wrong code', totp.verify(rfcSecret, '000000', { at: 59000 }) === null);
  check('verify rejects a malformed code', totp.verify(rfcSecret, '12-34', { at: 59000 }) === null);
  const generated = totp.generateSecret();
  check('generated secret is 160-bit base32', /^[A-Z2-7]{32}$/.test(generated));
  const rc = totp.generateRecoveryCodes(10);
  check('10 recovery codes, XXXX-XXXX shape', rc.length === 10 && rc.every((c) => /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(c)));
  check(
    'recovery hash matches sha256 of the normalized code',
    totp.hashRecoveryCode(rc[0]) === crypto.createHash('sha256').update(rc[0].replace('-', '')).digest('hex')
  );

  // ------------------------------------------------------- wiring
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const portalJs = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
  const portalHtml = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');
  const dbJs = fs.readFileSync(path.join(root, 'server/db.js'), 'utf8');
  check('staff SPA handles the MFA challenge', appJs.includes('mfaRequired') && appJs.includes('renderAuthMfa'));
  check('staff SPA wires enroll + verify + admin reset', appJs.includes('mfaEnrollStart') && appJs.includes('data-reset-mfa'));
  check('portal JS handles the MFA challenge', portalJs.includes('mfaRequired') && portalJs.includes('showMfaForm'));
  check('portal JS wires the Security section', portalJs.includes('loadMfaSecurity') && portalJs.includes('/mfa/enroll/start'));
  check('portal HTML ships the code form + security section', portalHtml.includes('form-mfa') && portalHtml.includes('sec-security'));
  check('migration adds MFA columns', dbJs.includes('totp_pending_secret') && dbJs.includes('totp_recovery_hashes') && dbJs.includes('totp_locked_until'));

  // ------------------------------------------------------- seeding
  const bcrypt = require('bcryptjs');
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  const hash = (pw) => bcrypt.hashSync(pw, 12);
  const adminIns = await db.query(
    'INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)',
    { e: ADMIN_EMAIL, h: hash(ADMIN_PASSWORD), n: 'Fixture Admin', s: 'active' }
  );
  const staffIns = await db.query(
    'INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 0, :s)',
    { e: STAFF_EMAIL, h: hash(STAFF_PASSWORD), n: 'Fixture Staff', s: 'active' }
  );
  const ADMIN_ID = Number(adminIns.insertId);
  const STAFF_ID = Number(staffIns.insertId);
  const portalIns = await db.query(
    `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status)
     VALUES (:e, :h, 1, 501, 'MFA Fixture Biz', 'active')`,
    { e: PORTAL_EMAIL, h: hash(PORTAL_PASSWORD) }
  );
  const PORTAL_ID = Number(portalIns.insertId);
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  wdb.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (501, ?, ?, ?)').run('MFA Fixture Biz', PORTAL_EMAIL, 'customer');

  const migCols = await probe("SELECT COUNT(*) AS c FROM pragma_table_info('users') WHERE name LIKE 'totp_%'");
  check('migration added the MFA columns to users (6 + Batch 143 totp_last_step replay guard)', migCols.c === 7);
  const migColsP = await probe("SELECT COUNT(*) AS c FROM pragma_table_info('client_portal_users') WHERE name LIKE 'totp_%'");
  check('migration added the MFA columns to client_portal_users (6 + Batch 143 totp_last_step)', migColsP.c === 7);

  // ------------------------------------------------------- boot
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (b) => (output += b));
  child.stderr.on('data', (b) => (output += b));
  const closed = new Promise((resolve) => child.once('close', resolve));
  try {
    let ready = false;
    for (let n = 0; n < 300 && !ready; n++) {
      if (child.exitCode != null) throw new Error('server exited early: ' + output);
      try {
        const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
        if (r.ok) ready = true;
      } catch {}
      if (!ready) await new Promise((r) => setTimeout(r, 200));
    }
    assert(ready, 'server did not become ready: ' + output);

    const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
    const get = (jar, p) => jar.fetch(BASE + p);

    // ============================ STAFF: forced enrollment ==========
    const adminJar = makeJar();
    let res = await post(adminJar, '/api/v1/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    let body = await json(res);
    check('staff login: password alone returns an MFA challenge', res.status === 200 && body.data.mfaRequired === true);
    check('staff login: first challenge stage is enroll', body.data.mfaStage === 'enroll');
    res = await get(adminJar, '/api/v1/auth/me');
    check('staff login: NO session exists before the second factor', res.status === 401);

    res = await post(adminJar, '/api/v1/auth/mfa/verify', { code: '123456' });
    check('staff enroll stage: the verify endpoint refuses (wrong stage)', res.status === 400);
    res = await post(adminJar, '/api/v1/auth/mfa/enroll/confirm', { code: '123456' });
    body = await json(res);
    check('staff enroll: confirm before start → MFA_NO_PENDING', res.status === 400 && body.code === 'MFA_NO_PENDING');

    res = await post(adminJar, '/api/v1/auth/mfa/enroll/start', {});
    body = await json(res);
    const adminSecret = body.data.secret;
    check('staff enroll start returns secret + QR data URL', /^[A-Z2-7]{32}$/.test(adminSecret) && String(body.data.qrDataUrl).startsWith('data:image/'));
    let row = await probe('SELECT totp_secret, totp_pending_secret, totp_enabled FROM users WHERE id = ?', ADMIN_ID);
    check('pending secret is stored ENCRYPTED (enc:v1:)', String(row.totp_pending_secret).startsWith('enc:v1:'));
    check('pending secret is not the plaintext secret', row.totp_pending_secret !== adminSecret && !String(row.totp_pending_secret).includes(adminSecret));
    check('stored pending decrypts back to the secret', secretBox.decryptValue(row.totp_pending_secret) === adminSecret);
    check('a pending secret alone does NOT enable MFA', Number(row.totp_enabled) === 0 && !row.totp_secret);

    res = await post(adminJar, '/api/v1/auth/mfa/enroll/confirm', { code: '000000' });
    check('staff enroll confirm: wrong code → 401', res.status === 401);
    row = await probe('SELECT totp_enabled FROM users WHERE id = ?', ADMIN_ID);
    check('staff enroll confirm: wrong code does not enable MFA', Number(row.totp_enabled) === 0);
    res = await get(adminJar, '/api/v1/auth/me');
    check('staff enroll confirm: wrong code still leaves NO session', res.status === 401);

    res = await post(adminJar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(adminSecret) });
    body = await json(res);
    check('staff enroll confirm: correct code signs in', res.status === 200 && body.data.user.email === ADMIN_EMAIL);
    const adminRecovery = body.data.recoveryCodes || [];
    check('staff enroll confirm returns 10 recovery codes, once', adminRecovery.length === 10);
    row = await probe('SELECT totp_secret, totp_pending_secret, totp_enabled, totp_recovery_hashes FROM users WHERE id = ?', ADMIN_ID);
    check('confirmed secret stored encrypted, pending cleared', String(row.totp_secret).startsWith('enc:v1:') && row.totp_pending_secret === null);
    check('MFA enabled only after the confirming code', Number(row.totp_enabled) === 1);
    const storedHashes = JSON.parse(row.totp_recovery_hashes);
    check('recovery codes stored as hashes only', storedHashes.length === 10 && storedHashes.every((h) => /^[0-9a-f]{64}$/.test(h)) && !adminRecovery.some((c) => storedHashes.includes(c)));
    check(
      'stored hash equals sha256 of a recovery code',
      storedHashes.includes(crypto.createHash('sha256').update(adminRecovery[0].replace('-', '')).digest('hex'))
    );
    res = await get(adminJar, '/api/v1/auth/me');
    check('staff session works after enrollment', res.status === 200);

    // ============================ STAFF: code step + throttle =======
    await post(adminJar, '/api/v1/auth/logout', {});
    res = await post(adminJar, '/api/v1/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    body = await json(res);
    check('staff re-login: challenge stage is verify once enrolled', body.data.mfaStage === 'verify');
    res = await get(adminJar, '/api/v1/auth/me');
    check('staff re-login: still no session before the code', res.status === 401);
    for (let i = 1; i <= 4; i++) {
      res = await post(adminJar, '/api/v1/auth/mfa/verify', { code: '000000' });
      check(`staff verify: wrong code ${i} → 401`, res.status === 401);
    }
    res = await post(adminJar, '/api/v1/auth/mfa/verify', { code: '000000' });
    body = await json(res);
    check('staff verify: 5th wrong code locks the factor (429 MFA_LOCKED)', res.status === 429 && body.code === 'MFA_LOCKED');
    res = await post(adminJar, '/api/v1/auth/mfa/verify', { code: totp.totp(adminSecret) });
    body = await json(res);
    check('staff verify: even the CORRECT code is refused while locked', res.status === 429 && body.code === 'MFA_LOCKED');
    row = await probe('SELECT totp_locked_until FROM users WHERE id = ?', ADMIN_ID);
    check('the lock is persisted on the account', !!row.totp_locked_until);
    // Simulate the cooldown elapsing.
    await execSql('UPDATE users SET totp_locked_until = NULL, totp_failed_attempts = 0 WHERE id = ?', ADMIN_ID);
    res = await post(adminJar, '/api/v1/auth/mfa/verify', { code: totp.totp(adminSecret) });
    check('staff verify: correct code signs in after the cooldown', res.status === 200);

    // ============================ STAFF: recovery codes =============
    await post(adminJar, '/api/v1/auth/logout', {});
    await post(adminJar, '/api/v1/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    res = await post(adminJar, '/api/v1/auth/mfa/verify', { code: adminRecovery[0] });
    check('staff verify: a recovery code signs in', res.status === 200);
    await post(adminJar, '/api/v1/auth/logout', {});
    await post(adminJar, '/api/v1/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    res = await post(adminJar, '/api/v1/auth/mfa/verify', { code: adminRecovery[0] });
    check('staff verify: the same recovery code is then REJECTED (single-use)', res.status === 401);
    res = await post(adminJar, '/api/v1/auth/mfa/verify', { code: adminRecovery[1] });
    check('staff verify: the next recovery code still works', res.status === 200);

    // ============================ STAFF: second member + admin reset
    const staffJar = makeJar();
    res = await post(staffJar, '/api/v1/auth/login', { email: STAFF_EMAIL, password: STAFF_PASSWORD });
    body = await json(res);
    check('second staff member also gets the forced enrollment', body.data.mfaRequired === true && body.data.mfaStage === 'enroll');
    res = await post(staffJar, '/api/v1/auth/mfa/enroll/start', {});
    const staffSecret = (await json(res)).data.secret;
    res = await post(staffJar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(staffSecret) });
    check('second staff member enrolls and signs in', res.status === 200);

    res = await post(staffJar, `/api/v1/admin/users/${ADMIN_ID}/mfa/reset`, {});
    check('non-super staff cannot reset MFA → 403', res.status === 403);
    res = await post(adminJar, `/api/v1/admin/users/${STAFF_ID}/mfa/reset`, {});
    check('super admin resets a staff member\u2019s MFA', res.status === 200);
    row = await probe('SELECT totp_secret, totp_enabled, totp_recovery_hashes FROM users WHERE id = ?', STAFF_ID);
    check('reset clears secret + flag + recovery hashes', row.totp_secret === null && Number(row.totp_enabled) === 0 && row.totp_recovery_hashes === null);
    await post(staffJar, '/api/v1/auth/logout', {});
    res = await post(staffJar, '/api/v1/auth/login', { email: STAFF_EMAIL, password: STAFF_PASSWORD });
    body = await json(res);
    check('after reset the member re-enrolls at next login (no lockout)', body.data.mfaRequired === true && body.data.mfaStage === 'enroll');

    // ============================ PORTAL: opt-in ====================
    const portalJar = makeJar();
    res = await post(portalJar, '/api/v1/portal/login', { email: PORTAL_EMAIL, password: PORTAL_PASSWORD });
    body = await json(res);
    check('portal login with MFA off: straight in, no challenge', res.status === 200 && !body.data.mfaRequired && !!body.data.client);
    res = await get(portalJar, '/api/v1/portal/mfa');
    body = await json(res);
    check('portal MFA state starts disabled', body.data.enabled === false);
    res = await post(portalJar, '/api/v1/portal/mfa/enroll/start', { password: 'wrong-password' });
    check('portal enroll start requires the account password', res.status === 401);
    res = await post(portalJar, '/api/v1/portal/mfa/enroll/start', { password: PORTAL_PASSWORD });
    body = await json(res);
    const portalSecret = body.data.secret;
    check('portal enroll start returns secret + QR', /^[A-Z2-7]{32}$/.test(portalSecret) && String(body.data.qrDataUrl).startsWith('data:image/'));
    row = await probe('SELECT totp_pending_secret, totp_enabled FROM client_portal_users WHERE id = ?', PORTAL_ID);
    check('portal pending secret stored encrypted, MFA not yet on', String(row.totp_pending_secret).startsWith('enc:v1:') && Number(row.totp_enabled) === 0);
    res = await post(portalJar, '/api/v1/portal/mfa/enroll/confirm', { code: '000000' });
    check('portal enroll confirm: wrong code → 401', res.status === 401);
    res = await post(portalJar, '/api/v1/portal/mfa/enroll/confirm', { code: totp.totp(portalSecret) });
    body = await json(res);
    const portalRecovery = body.data.recoveryCodes || [];
    check('portal enroll confirm: correct code enables + returns recovery codes', res.status === 200 && body.data.enabled === true && portalRecovery.length === 10);
    res = await get(portalJar, '/api/v1/portal/mfa');
    body = await json(res);
    check('portal MFA state now enabled', body.data.enabled === true);

    // login gate
    await post(portalJar, '/api/v1/portal/logout', {});
    res = await post(portalJar, '/api/v1/portal/login', { email: PORTAL_EMAIL, password: PORTAL_PASSWORD });
    body = await json(res);
    check('portal login with MFA on: challenge, no client payload', res.status === 200 && body.data.mfaRequired === true && !body.data.client);
    res = await get(portalJar, '/api/v1/portal/me');
    check('portal login with MFA on: NO session before the code', res.status === 401);
    res = await post(portalJar, '/api/v1/portal/mfa/verify', { code: '000000' });
    check('portal verify: wrong code → 401', res.status === 401);
    res = await post(portalJar, '/api/v1/portal/mfa/verify', { code: totp.totp(portalSecret) });
    body = await json(res);
    check('portal verify: correct code establishes the session', res.status === 200 && !!body.data.client);
    res = await get(portalJar, '/api/v1/portal/me');
    check('portal /me works after the code step', res.status === 200);

    // magic-link gate
    const { hashToken } = require(path.join(root, 'server/workspace.js'));
    const magicRaw = 'mfa40-magic-token-fixture-0123456789';
    const exp = new Date(Date.now() + 30 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await db.query(
      'INSERT INTO client_portal_login_tokens (portal_user_id, token_hash, expires_at) VALUES (:uid, :h, :exp)',
      { uid: PORTAL_ID, h: hashToken(magicRaw), exp }
    );
    const magicJar = makeJar();
    res = await post(magicJar, '/api/v1/portal/magic-login', { token: magicRaw });
    body = await json(res);
    check('magic link with MFA on: challenge, not a session', res.status === 200 && body.data.mfaRequired === true);
    res = await get(magicJar, '/api/v1/portal/me');
    check('magic link with MFA on: /me still 401 before the code', res.status === 401);
    res = await post(magicJar, '/api/v1/portal/mfa/verify', { code: portalRecovery[0] });
    check('magic login completes with a recovery code', res.status === 200);

    // admin reset for the portal user
    res = await post(adminJar, `/api/v1/admin/portal-users/${PORTAL_ID}/mfa/reset`, {});
    check('super admin resets a portal client\u2019s MFA', res.status === 200);
    const portalJar2 = makeJar();
    res = await post(portalJar2, '/api/v1/portal/login', { email: PORTAL_EMAIL, password: PORTAL_PASSWORD });
    body = await json(res);
    check('after admin reset the client signs in password-only again', res.status === 200 && !body.data.mfaRequired && !!body.data.client);

    // re-enable, then self-disable (password + code)
    res = await post(portalJar2, '/api/v1/portal/mfa/enroll/start', { password: PORTAL_PASSWORD });
    const portalSecret2 = (await json(res)).data.secret;
    res = await post(portalJar2, '/api/v1/portal/mfa/enroll/confirm', { code: totp.totp(portalSecret2) });
    check('portal re-enable works after a reset', res.status === 200);
    // Hazard shape: a recovery code whose 8 hex chars contain exactly
    // 6 digits ('A1B234-56') must still verify — a "looks like a TOTP
    // code" gate on the recovery branch would reject it.
    await execSql(
      'UPDATE client_portal_users SET totp_recovery_hashes = ? WHERE id = ?',
      JSON.stringify([crypto.createHash('sha256').update('A1B23456').digest('hex')]),
      PORTAL_ID
    );
    await post(portalJar2, '/api/v1/portal/logout', {});
    res = await post(portalJar2, '/api/v1/portal/login', { email: PORTAL_EMAIL, password: PORTAL_PASSWORD });
    check('hazard-shape setup: login challenges again', (await json(res)).data.mfaRequired === true);
    res = await post(portalJar2, '/api/v1/portal/mfa/verify', { code: 'A1B234-56' });
    check('hazard-shape recovery code (6 digits + 2 letters) verifies', res.status === 200);
    res = await post(portalJar2, '/api/v1/portal/mfa/disable', { password: 'wrong-password', code: totp.totp(portalSecret2) });
    check('portal disable: wrong password → 401', res.status === 401);
    res = await post(portalJar2, '/api/v1/portal/mfa/disable', { password: PORTAL_PASSWORD, code: '000000' });
    check('portal disable: wrong code → 401', res.status === 401);
    res = await get(portalJar2, '/api/v1/portal/mfa');
    check('portal disable: failed attempts leave MFA on', (await json(res)).data.enabled === true);
    res = await post(portalJar2, '/api/v1/portal/mfa/disable', { password: PORTAL_PASSWORD, code: totp.totp(portalSecret2) });
    body = await json(res);
    check('portal disable: password + current code turns MFA off', res.status === 200 && body.data.enabled === false);
    await post(portalJar2, '/api/v1/portal/logout', {});
    res = await post(portalJar2, '/api/v1/portal/login', { email: PORTAL_EMAIL, password: PORTAL_PASSWORD });
    body = await json(res);
    check('portal login after disable: no challenge', res.status === 200 && !body.data.mfaRequired);

    console.log(JSON.stringify({ passed: true, groups: results.length, checks: results }));
  } finally {
    child.kill('SIGTERM');
    await closed.catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
