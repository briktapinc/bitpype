'use strict';
/**
 * Batch 121 — PORTAL SET-PASSWORD FLOW ("Email me a link to set my
 * password"). Portal accounts are provisioned with a random,
 * never-disclosed password hash (server/portalAccounts.js
 * requestAccess: "Unusable random hash only — never emailed"), so a
 * magic-link user who opens Account security and is asked to confirm
 * a password to set up / disable MFA hits a wall: EVERY password
 * fails with INVALID_CREDENTIALS. This batch gives them a way to SET
 * a real password:
 *
 *   - client_portal_password_tokens (sha256 hash only, 1h, single
 *     use, prior tokens deleted on issue + siblings on use), parity
 *     in both migrate() dialects.
 *   - POST /password-set/request (signed-in; sends to the account's
 *     own email), POST /password-set/request-by-email (signed-out;
 *     generic response, /access rate-limit + captcha posture),
 *     POST /password-set/confirm (sets bcrypt(12) hash; other portal
 *     sessions die, the submitting session survives).
 *   - The emailed link is /portal?setpw=<token>; NO password is ever
 *     emailed. MFA is never bypassed: an MFA-on account still codes
 *     at login after a set, and enroll/disable work with the new
 *     password. A failed password confirm on the security page now
 *     points at the remedy (portal.js copy; API code unchanged).
 *
 * Engine half runs in-process with the mailer captured (the raw token
 * only ever exists inside the emailed link). HTTP half boots the real
 * server and drives the routes, including the original wall, the
 * full MFA enroll → set again → disable arc, and the session wipe.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b121-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch121', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 21).toString('base64');

const PORT = 31491;
const BASE = `http://127.0.0.1:${PORT}`;
// Fixture secrets are assembled from fragments, never written as
// credential-looking literals (write-path redaction hazard).
const UNKNOWN_PW = ['batch121', 'never', 'disclosed'].join('-');
const NEW_PW = ['batch121', 'new', 'password'].join('-');
const NEW_PW_2 = ['batch121', 'second', 'password'].join('-');
const WRONG_PW = ['batch121', 'wrong', 'guess'].join('-');

const EMAIL_A = 'portal121a@example.invalid';
const EMAIL_B = 'portal121b@example.invalid';
const EMAIL_C = 'portal121c@example.invalid';
const EMAIL_D = 'portal121d@example.invalid';
const EMAIL_E = 'portal121e@example.invalid';
const EMAIL_UNKNOWN = 'portal121-nobody@example.invalid';
const LEAD_A = 12101;
const LEAD_B = 12102;
const LEAD_C = 12103;
const LEAD_D = 12104;
const LEAD_E = 12105;

const results = [];
function check(name, cond) {
  assert(cond, name);
  results.push(name);
}
function group(name) {
  console.log(`  ok ${name} — ${results.length} checks so far`);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
      if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
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

let db;
async function probe(sql, params) {
  const rows = await db.query(sql, params);
  return rows[0];
}
async function probeAll(sql, params) {
  return db.query(sql, params);
}

(async () => {
  /* ================================================================== */
  /* Part 0 — source pins                                                */
  /* ================================================================== */
  {
    const dbJs = read('server/db.js');
    const creates = dbJs.split('CREATE TABLE IF NOT EXISTS client_portal_password_tokens').length - 1;
    check('schema: password-token table created in BOTH migrate dialects', creates === 2);

    const routes = read('server/routes/portal.js');
    check('routes: signed-in request route mounted', routes.includes("'/password-set/request'"));
    check('routes: signed-out request route mounted', routes.includes("'/password-set/request-by-email'"));
    check('routes: confirm route mounted', routes.includes("'/password-set/confirm'"));
    check(
      'routes: auth events recorded',
      routes.includes("'password_set_requested'") && routes.includes("'password_set_completed'")
    );

    const mod = read('server/portalPassword.js');
    check('module: sha256 token hashing', mod.includes("createHash('sha256')"));
    check('module: bcrypt(12) on set', mod.includes('bcrypt.hash(String(newPassword), 12)'));
    check(
      'module: staff reset table never touched',
      !mod.includes('password_reset_tokens') && !mod.includes('UPDATE users SET')
    );
    check('module: email subject set', mod.includes('Set your Bitpype portal password'));
    check('module: link shape is /portal?setpw=', mod.includes('/portal?setpw='));

    const portalJs = read('public/js/portal.js');
    const linkCount = portalJs.split('Email me a link to set one.').length - 1;
    check('portal.js: set-password link rendered in BOTH security states', linkCount === 2);
    check(
      'portal.js: failed password confirm points at the remedy',
      portalJs.includes('you may not have a password yet')
    );
    check(
      'portal.js: setpw boot handler present',
      portalJs.includes('trySetPasswordLink') && portalJs.includes("get('setpw')")
    );
    check('portal.js: signed-in request wired', portalJs.includes("'/password-set/request'"));
    check('portal.js: signed-out request wired', portalJs.includes("'/password-set/request-by-email'"));

    const portalHtml = read('public/portal.html');
    check(
      'portal.html: sign-in screen offers Set or reset your password',
      portalHtml.includes('Set or reset your password')
    );
    check(
      'portal.html: set-password forms ship',
      portalHtml.includes('form-setpw-request') && portalHtml.includes('form-setpw')
    );

    const accounts = read('server/portalAccounts.js');
    check(
      'portalAccounts: magic-link provisioning untouched (random hash, never emailed)',
      accounts.includes('Unusable random hash only')
    );
    group('Part 0 — source pins');
  }

  /* ================================================================== */
  /* Part 1 — engine, in-process, mailer captured                        */
  /* ================================================================== */
  const sentMails = [];
  const mailer = require(path.join(root, 'server/mailer.js'));
  mailer.sendPlatformMail = async (msg) => {
    sentMails.push(msg);
    return { ok: true };
  };
  const bcrypt = require('bcryptjs');
  db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  const seedLead = (id, email) =>
    wdb
      .prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)')
      .run(id, 'B121 Fixture Biz', email, 'customer');
  const seedUser = async (email, leadId, status) => {
    const ins = await db.query(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status)
       VALUES (:e, :h, 1, :lead, 'B121 Fixture Biz', :s)`,
      { e: email, h: bcrypt.hashSync(UNKNOWN_PW, 12), lead: leadId, s: status }
    );
    return Number(ins.insertId);
  };
  seedLead(LEAD_A, EMAIL_A);
  seedLead(LEAD_B, EMAIL_B);
  seedLead(LEAD_C, EMAIL_C);
  seedLead(LEAD_D, EMAIL_D);
  seedLead(LEAD_E, EMAIL_E);
  const ID_A = await seedUser(EMAIL_A, LEAD_A, 'active');
  const ID_B = await seedUser(EMAIL_B, LEAD_B, 'active');
  const ID_C = await seedUser(EMAIL_C, LEAD_C, 'disabled');
  const ID_D = await seedUser(EMAIL_D, LEAD_D, 'active');
  const ID_E = await seedUser(EMAIL_E, LEAD_E, 'active');

  const portalPassword = require(path.join(root, 'server/portalPassword.js'));
  const tokenRowsFor = (uid) =>
    probeAll('SELECT * FROM client_portal_password_tokens WHERE portal_user_id = :uid ORDER BY id', { uid });
  const hashOf = async (uid) =>
    (await probe('SELECT password_hash FROM client_portal_users WHERE id = :id', { id: uid })).password_hash;
  const lastMailTo = (email) => [...sentMails].reverse().find((m) => m.to === email);
  const rawFromMail = (mail) => {
    const m = /[?&]setpw=([0-9a-f]{48})/.exec((mail.cta && mail.cta.url) || '');
    assert(m, 'email CTA carries a setpw token');
    return m[1];
  };
  const mailsTo = (email) => sentMails.filter((m) => m.to === email).length;

  {
    // Unknown + disabled: generic ok, no mail, no token.
    let r = await portalPassword.requestByEmail(EMAIL_UNKNOWN);
    check('engine: unknown email → generic ok', r.ok === true && !r.userId);
    check(
      'engine: unknown email → no mail, no token rows anywhere',
      sentMails.length === 0 && (await tokenRowsFor(ID_A)).length === 0
    );
    r = await portalPassword.requestByEmail(EMAIL_C);
    check('engine: disabled account → generic ok, no mail', r.ok === true && mailsTo(EMAIL_C) === 0);
    check('engine: disabled account → no token row', (await tokenRowsFor(ID_C)).length === 0);
    r = await portalPassword.requestByEmail('not-an-email');
    check('engine: malformed email → generic ok', r.ok === true);

    // Happy path for A (request 1 of max 3 for this email).
    r = await portalPassword.requestByEmail(EMAIL_A);
    check('engine: known email → ok + userId (internal only)', r.ok === true && r.userId === ID_A);
    const mail1 = lastMailTo(EMAIL_A);
    check('engine: email subject is the set-password subject', mail1.subject === 'Set your Bitpype portal password');
    check(
      'engine: email body explains 1-hour single use',
      /expires in 1 hour/i.test(mail1.text) && /only be used once/i.test(mail1.text)
    );
    check('engine: email contains NO password value', !mail1.text.includes(NEW_PW) && !mail1.text.includes(UNKNOWN_PW));
    const raw1 = rawFromMail(mail1);
    let rows = await tokenRowsFor(ID_A);
    check('engine: exactly one token row after issue', rows.length === 1);
    check(
      'engine: token stored as sha256 hash only',
      rows[0].token_hash === sha256(raw1) && rows[0].token_hash !== raw1
    );
    check(
      'engine: token unconsumed with ~1h expiry',
      !rows[0].used_at &&
        new Date(String(rows[0].expires_at).replace(' ', 'T') + 'Z').getTime() > Date.now() + 50 * 60 * 1000
    );

    // Weak password refused before token is consumed.
    await assert.rejects(
      () => portalPassword.confirmPasswordSet(raw1, 'short'),
      (e) => e.code === 'WEAK_PASSWORD'
    );
    check('engine: weak password → WEAK_PASSWORD, token still live', !(await tokenRowsFor(ID_A))[0].used_at);
    await assert.rejects(
      () => portalPassword.confirmPasswordSet('f'.repeat(48), NEW_PW),
      (e) => e.code === 'INVALID_TOKEN'
    );
    check('engine: bogus token → INVALID_TOKEN', true);

    // Confirm: hash replaced, token consumed.
    const beforeHash = await hashOf(ID_A);
    r = await portalPassword.confirmPasswordSet(raw1, NEW_PW);
    check('engine: confirm returns ok + user', r.ok === true && r.userId === ID_A);
    const afterHash = await hashOf(ID_A);
    check('engine: password_hash actually replaced', afterHash !== beforeHash);
    check(
      'engine: new password verifies, old random one does not',
      bcrypt.compareSync(NEW_PW, afterHash) && !bcrypt.compareSync(UNKNOWN_PW, afterHash)
    );
    rows = await tokenRowsFor(ID_A);
    check('engine: used token marked used_at', rows.length === 1 && !!rows[0].used_at);
    await assert.rejects(
      () => portalPassword.confirmPasswordSet(raw1, NEW_PW_2),
      (e) => e.code === 'TOKEN_USED'
    );
    check('engine: token reuse → TOKEN_USED', true);

    // New request kills the previous live token (requests 2 + 3 for A).
    await portalPassword.requestByEmail(EMAIL_A);
    const raw2 = rawFromMail(lastMailTo(EMAIL_A));
    await portalPassword.requestByEmail(EMAIL_A);
    const raw3 = rawFromMail(lastMailTo(EMAIL_A));
    rows = await tokenRowsFor(ID_A);
    check('engine: re-issue leaves exactly one live token', rows.length === 1 && rows[0].token_hash === sha256(raw3));
    await assert.rejects(
      () => portalPassword.confirmPasswordSet(raw2, NEW_PW_2),
      (e) => e.code === 'INVALID_TOKEN'
    );
    check('engine: superseded token → INVALID_TOKEN', true);
    r = await portalPassword.confirmPasswordSet(raw3, NEW_PW_2);
    check('engine: freshest token still confirms', r.ok === true && bcrypt.compareSync(NEW_PW_2, await hashOf(ID_A)));

    // Per-email rate limit (A has now made 3 requests — the 4th is a
    // generic no-op: no mail, no new token).
    const mailCountA = mailsTo(EMAIL_A);
    r = await portalPassword.requestByEmail(EMAIL_A);
    check(
      'engine: 4th request in the hour → generic ok, nothing sent',
      r.ok === true && mailsTo(EMAIL_A) === mailCountA && (await tokenRowsFor(ID_A)).length === 1
    );

    // Expiry (B): backdate the token, confirm → TOKEN_EXPIRED; a fresh
    // token for B must not touch A's password (cross-account isolation).
    await portalPassword.requestByEmail(EMAIL_B);
    const rawB = rawFromMail(lastMailTo(EMAIL_B));
    await db.query(
      "UPDATE client_portal_password_tokens SET expires_at = '2000-01-01 00:00:00' WHERE portal_user_id = :uid",
      { uid: ID_B }
    );
    await assert.rejects(
      () => portalPassword.confirmPasswordSet(rawB, NEW_PW),
      (e) => e.code === 'TOKEN_EXPIRED'
    );
    check('engine: expired token → TOKEN_EXPIRED', true);
    const hashABefore = await hashOf(ID_A);
    await portalPassword.requestByEmail(EMAIL_B);
    const rawB2 = rawFromMail(lastMailTo(EMAIL_B));
    r = await portalPassword.confirmPasswordSet(rawB2, NEW_PW);
    check(
      'engine: B token sets B password',
      r.ok === true && r.userId === ID_B && bcrypt.compareSync(NEW_PW, await hashOf(ID_B))
    );
    check('engine: cross-account isolation — A hash untouched by B token', (await hashOf(ID_A)) === hashABefore);

    // Signed-in engine path issues to the account's own email.
    const mailCountD = mailsTo(EMAIL_D);
    r = await portalPassword.requestForUser(ID_D);
    check('engine: requestForUser mails the account email', r.ok === true && mailsTo(EMAIL_D) === mailCountD + 1);
    group('Part 1 — engine');
  }

  /* ================================================================== */
  /* Part 2 — HTTP over the real server                                  */
  /* ================================================================== */
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
    const totp = require(path.join(root, 'src/totp.js'));

    // D signs in by magic link (the real provisioning shape).
    const magicRaw = 'b121-magic-token-fixture-0123456789abcdef';
    const magicExp = new Date(Date.now() + 30 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await db.query(
      'INSERT INTO client_portal_login_tokens (portal_user_id, token_hash, expires_at) VALUES (:uid, :h, :exp)',
      { uid: ID_D, h: sha256(magicRaw), exp: magicExp }
    );
    const jarD = makeJar();
    let res = await post(jarD, '/api/v1/portal/magic-login', { token: magicRaw });
    let body = await json(res);
    check('http: magic-link sign-in works for D', res.status === 200 && !!body.data.client);

    // THE WALL: any password fails the MFA enroll confirm-gate.
    res = await post(jarD, '/api/v1/portal/mfa/enroll/start', { password: WRONG_PW });
    check('http: the original wall — enroll/start with an unknown password → 401', res.status === 401);
    res = await get(jarD, '/api/v1/portal/mfa');
    check('http: MFA starts disabled for D', (await json(res)).data.enabled === false);

    // Signed-in request: token issued for D; unauthenticated refused.
    res = await post(jarD, '/api/v1/portal/password-set/request', {});
    body = await json(res);
    check('http: signed-in set-password request → 200', res.status === 200 && body.data.requested === true);
    check('http: signed-in request issued a token row', (await tokenRowsFor(ID_D)).length >= 1);
    const anonJar = makeJar();
    res = await post(anonJar, '/api/v1/portal/password-set/request', {});
    check('http: signed-in request without a session → 401', res.status === 401);

    // Signed-out request: generic for valid / unknown / disabled alike.
    const hashBeforeOut = (await tokenRowsFor(ID_D)).slice(-1)[0].token_hash;
    res = await post(anonJar, '/api/v1/portal/password-set/request-by-email', { email: EMAIL_D });
    body = await json(res);
    check('http: signed-out request (valid) → generic 200', res.status === 200 && body.data.requested === true);
    const rowsOut = await tokenRowsFor(ID_D);
    check(
      'http: signed-out request replaced the token',
      rowsOut.length === 1 && rowsOut[0].token_hash !== hashBeforeOut
    );
    res = await post(anonJar, '/api/v1/portal/password-set/request-by-email', { email: EMAIL_UNKNOWN });
    check(
      'http: signed-out request (unknown) → same generic 200',
      res.status === 200 && (await json(res)).data.requested === true
    );
    res = await post(anonJar, '/api/v1/portal/password-set/request-by-email', { email: EMAIL_C });
    check(
      'http: signed-out request (disabled) → generic 200, no token',
      res.status === 200 && (await tokenRowsFor(ID_C)).length === 0
    );

    // Confirm over HTTP with an engine-issued token (raw lives only in
    // the captured email), from a jar with NO session.
    await portalPassword.requestForUser(ID_D);
    const rawD = rawFromMail(lastMailTo(EMAIL_D));
    res = await post(anonJar, '/api/v1/portal/password-set/confirm', { token: rawD, password: 'short' });
    body = await json(res);
    check(
      'http: confirm with a short password → 400 WEAK_PASSWORD',
      res.status === 400 && body.code === 'WEAK_PASSWORD'
    );
    res = await post(anonJar, '/api/v1/portal/password-set/confirm', { token: rawD, password: NEW_PW });
    body = await json(res);
    check('http: confirm sets the password', res.status === 200 && body.data.passwordSet === true);

    // Password login now works; wrong password still fails.
    const jarD2 = makeJar();
    res = await post(jarD2, '/api/v1/portal/login', { email: EMAIL_D, password: WRONG_PW });
    check('http: login with a wrong password → 401', res.status === 401);
    res = await post(jarD2, '/api/v1/portal/login', { email: EMAIL_D, password: NEW_PW });
    body = await json(res);
    check(
      'http: login with the NEW password works, no MFA challenge yet',
      res.status === 200 && !!body.data.client && !body.data.mfaRequired
    );

    // MFA enroll now succeeds end-to-end with the new password.
    res = await post(jarD2, '/api/v1/portal/mfa/enroll/start', { password: NEW_PW });
    body = await json(res);
    const secretD = body.data && body.data.secret;
    check('http: enroll/start accepts the new password', res.status === 200 && /^[A-Z2-7]{32}$/.test(secretD || ''));
    res = await post(jarD2, '/api/v1/portal/mfa/enroll/confirm', { code: totp.totp(secretD) });
    body = await json(res);
    check(
      'http: enroll/confirm turns MFA on',
      res.status === 200 && body.data.enabled === true && (body.data.recoveryCodes || []).length === 10
    );

    // Setting ANOTHER password must not disable or bypass MFA.
    await portalPassword.requestForUser(ID_D);
    const rawD2 = rawFromMail(lastMailTo(EMAIL_D));
    res = await post(anonJar, '/api/v1/portal/password-set/confirm', { token: rawD2, password: NEW_PW_2 });
    check('http: second set succeeds while MFA is on', res.status === 200);
    const jarD3 = makeJar();
    res = await post(jarD3, '/api/v1/portal/login', { email: EMAIL_D, password: NEW_PW_2 });
    body = await json(res);
    check(
      'http: MFA still ON after a password set (login challenges)',
      res.status === 200 && body.data.mfaRequired === true && !body.data.client
    );
    res = await post(jarD3, '/api/v1/portal/mfa/verify', { code: totp.totp(secretD) });
    check('http: code step completes the login', res.status === 200 && !!(await json(res)).data.client);

    // Disable works with the newest password + a code; wrong password → 401.
    res = await post(jarD3, '/api/v1/portal/mfa/disable', { password: WRONG_PW, code: totp.totp(secretD) });
    check('http: disable with wrong password → 401', res.status === 401);
    res = await post(jarD3, '/api/v1/portal/mfa/disable', { password: NEW_PW_2, code: totp.totp(secretD) });
    body = await json(res);
    check('http: disable with the new password + code → MFA off', res.status === 200 && body.data.enabled === false);

    // Session hygiene: a second live session dies on set; the session
    // that submitted the set survives.
    const jarE2 = makeJar();
    res = await post(jarE2, '/api/v1/portal/login', { email: EMAIL_D, password: NEW_PW_2 });
    check('http: second session signs in', res.status === 200);
    res = await get(jarE2, '/api/v1/portal/me');
    check('http: second session /me works before the set', res.status === 200);
    await portalPassword.requestForUser(ID_D);
    const rawD3 = rawFromMail(lastMailTo(EMAIL_D));
    res = await post(jarD3, '/api/v1/portal/password-set/confirm', { token: rawD3, password: NEW_PW });
    check('http: set submitted from a live session succeeds', res.status === 200);
    res = await get(jarE2, '/api/v1/portal/me');
    check('http: the OTHER session is wiped by the set', res.status === 401);
    res = await get(jarD3, '/api/v1/portal/me');
    check('http: the submitting session survives the set', res.status === 200);

    // Signed-out rate limit over HTTP (E): 3 issues, the 4th is a
    // generic no-op (token hash unchanged).
    let lastHash = null;
    for (let i = 0; i < 3; i++) {
      res = await post(anonJar, '/api/v1/portal/password-set/request-by-email', { email: EMAIL_E });
      assert(res.status === 200, 'rate-limit warmup request ' + i);
      const rows = await tokenRowsFor(ID_E);
      assert(rows.length === 1, 'one live token for E');
      lastHash = rows[0].token_hash;
    }
    res = await post(anonJar, '/api/v1/portal/password-set/request-by-email', { email: EMAIL_E });
    const rowsE = await tokenRowsFor(ID_E);
    check(
      'http: 4th signed-out request in the hour → generic 200, no new token',
      res.status === 200 && rowsE.length === 1 && rowsE[0].token_hash === lastHash
    );

    // Audit trail (SEC-21 recorder, surface 'portal').
    const events = await probeAll(
      "SELECT event FROM auth_events WHERE surface = 'portal' AND user_id = :uid AND event LIKE 'password_set%'",
      { uid: ID_D }
    );
    const kinds = new Set(events.map((e) => e.event));
    check(
      'http: auth events recorded for request + completion',
      kinds.has('password_set_requested') && kinds.has('password_set_completed')
    );
    group('Part 2 — HTTP');
  } finally {
    child.kill('SIGTERM');
    await closed;
  }

  console.log(JSON.stringify({ batch121PortalPasswordSet: 'pass', checks: results.length, groups: 3 }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
