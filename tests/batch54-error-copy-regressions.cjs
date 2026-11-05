'use strict';
/**
 * Batch 54 — human error messages + stop the silent failures
 * (expert review 2026-10-29: High #3 / finding U-1 + the
 * swallow-and-empty family B-2, parser leak B-5).
 *
 * PART A — error copy at the choke point. Server: server/apiErrors.js
 * shapes every route-family fail() tail + the global error handler.
 * Authored codes keep their code + user-written message; an uncoded
 * 5xx is logged with a reference id (`err_<8 hex>`) and answered with
 * code INTERNAL + a generic message + the same ref — never the raw
 * exception text. Body-parser failures map to 400 BAD_JSON. Client:
 * public/js/errorCopy.js is the one mapper both shells load; the toast
 * helper, form setMsg sinks, error rows/cards and the Page-failed-to-
 * load card all render errText(err) instead of err.message.
 *
 * PART B — swallow-and-empty. The server/ catch sites that returned
 * []/0/defaults silently now log with context; adminCallsOverview —
 * the review's named worst case — additionally returns a `warnings`
 * array the Calls page renders as a visible banner (LeadScout's
 * overview carries the same pattern for its health section).
 *
 * NEGATIVE PROOF: B54_NEGATIVE=1 loads the client mapper from a
 * scratch copy whose describe() is reverted to raw err.message
 * passthrough; the INTERNAL-leak checks MUST fail in that mode.
 *
 * Harness: unit tests (apiErrors + VM-loaded mapper + facade-level
 * overview) + HTTP tests against the real server booted on a temp
 * platform DB (batch53 pattern). APP_URL is pinned — the Batch 51
 * gate lesson (stripeClient.appUrl throws without it in production
 * mode and an overview catch-all would silently empty the payload).
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b54-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch54', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 11).toString('base64');

const NEGATIVE = process.env.B54_NEGATIVE === '1';
const PORT = 31454;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}

/* ===================================================================== */
/* Part A1 — server/apiErrors shaping                                     */
/* ===================================================================== */

const apiErrors = require(path.join(root, 'server/apiErrors.js'));

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

function partA1() {
  check('uncoded 500 → INTERNAL + generic + ref, log line carries the same ref', () => {
    const res = mockRes();
    const logged = [];
    const origErr = console.error;
    console.error = (...a) => logged.push(a.map(String).join(' '));
    try {
      apiErrors.sendError(res, new Error('boom: table websites has no column named x'), 500, {
        area: 'test',
      });
    } finally {
      console.error = origErr;
    }
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'INTERNAL');
    assert.equal(res.body.error, apiErrors.GENERIC_MESSAGE);
    assert.match(res.body.ref, /^err_[0-9a-f]{8}$/);
    assert(!JSON.stringify(res.body).includes('boom'), 'raw exception text must not reach the body');
    assert(
      logged.some((l) => l.includes('[test]') && l.includes(res.body.ref) && l.includes('boom')),
      'server log must carry the ref + the real error'
    );
  });

  check('authored coded error keeps code + message at any status (no ref)', () => {
    const res = mockRes();
    const e = new Error('That email is already used by another lead');
    e.code = 'DUPLICATE_EMAIL';
    apiErrors.sendError(res, e, 409, { area: 'test' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'DUPLICATE_EMAIL');
    assert.equal(res.body.error, 'That email is already used by another lead');
    assert.equal(res.body.ref, undefined);
  });

  check('authored coded 5xx (config diagnostic) still passes through', () => {
    const res = mockRes();
    const e = new Error('Stripe is not configured: set the secret key in Admin settings');
    e.code = 'STRIPE_NOT_CONFIGURED';
    apiErrors.sendError(res, e, 503, { area: 'test' });
    assert.equal(res.body.code, 'STRIPE_NOT_CONFIGURED');
    assert.match(res.body.error, /not configured/);
  });

  check('body-parser failure → 400 BAD_JSON with friendly copy, parser text hidden', () => {
    const res = mockRes();
    const e = new Error('Unexpected token } in JSON at position 42');
    e.type = 'entity.parse.failed';
    e.status = 400;
    apiErrors.sendError(res, e, 400, { area: 'test' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'BAD_JSON');
    assert(!res.body.error.includes('Unexpected token'), 'parser internals must not leak (B-5)');
  });

  check('nested shape: INTERNAL carries ref inside error{} and at top level', () => {
    const res = mockRes();
    apiErrors.sendError(res, new Error('nested boom'), 500, { area: 'test', nested: true });
    assert.equal(res.body.error.code, 'INTERNAL');
    assert.equal(res.body.error.message, apiErrors.GENERIC_MESSAGE);
    assert.match(res.body.error.ref, /^err_[0-9a-f]{8}$/);
    assert.equal(res.body.ref, res.body.error.ref);
  });

  check('uncoded <500 keeps the legacy ERROR code + authored message', () => {
    const res = mockRes();
    apiErrors.sendError(res, new Error('Limit must be between 1 and 200'), 422, { area: 'test' });
    assert.equal(res.body.code, 'ERROR');
    assert.equal(res.body.error, 'Limit must be between 1 and 200');
  });

  check('mask5xx (public form surfaces): authored 5xx keeps its code but never its message', () => {
    const res = mockRes();
    const e = new Error('SMTP error: expected 250 but got 503');
    e.code = 'EMAIL_FAILED';
    const logged = [];
    const origErr = console.error;
    console.error = (...a) => logged.push(a.map(String).join(' '));
    try {
      apiErrors.sendError(res, e, 502, { area: 'test', mask5xx: true });
    } finally {
      console.error = origErr;
    }
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'EMAIL_FAILED', 'code survives for client mapping');
    assert.equal(res.body.error, apiErrors.GENERIC_MESSAGE);
    assert.match(res.body.ref, /^err_[0-9a-f]{8}$/);
    assert(!JSON.stringify(res.body).includes('SMTP'));
    // …while the same error on a staff surface (no mask) keeps its copy.
    const res2 = mockRes();
    apiErrors.sendError(res2, e, 502, { area: 'test' });
    assert.equal(res2.body.error, 'SMTP error: expected 250 but got 503');
  });
}

/* ===================================================================== */
/* Part A2 — client mapper (public/js/errorCopy.js)                       */
/* ===================================================================== */

function loadMapper() {
  let src = fs.readFileSync(path.join(root, 'public/js/errorCopy.js'), 'utf8');
  if (NEGATIVE) {
    // Revert describe() to the pre-fix behavior between the markers:
    // raw err.message straight through.
    const begin = src.indexOf('// B54-DESCRIBE-BEGIN');
    const end = src.indexOf('// B54-DESCRIBE-END');
    assert(begin > 0 && end > begin, 'mapper markers present');
    src =
      src.slice(0, begin) +
      '// B54-DESCRIBE-BEGIN\n  function describe(err) { return (err && err.message) || String(err); }\n  ' +
      src.slice(end);
  }
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'errorCopy.js' });
  return sandbox;
}

function partA2() {
  const sandbox = loadMapper();
  const errText = sandbox.window.errText;
  check('mapper loads and exposes errText + ScoutErrorCopy', () => {
    assert.equal(typeof errText, 'function');
    assert.equal(sandbox.window.ScoutErrorCopy.describe, errText);
  });

  check('known codes render plain-language copy', () => {
    assert.equal(errText({ code: 'FORBIDDEN', status: 403, message: 'x' }), "You don't have permission for that.");
    assert.equal(errText({ code: 'INVALID_CREDENTIALS', status: 401, message: 'x' }), 'Email or password is incorrect.');
    assert.equal(
      errText({ code: 'SESSION_IDLE', status: 401, message: 'SESSION_IDLE' }),
      'Signed out after 30 hours of inactivity. Please sign in again.'
    );
  });

  check('INTERNAL renders generic + the reference id (support quotes the ref)', () => {
    assert.equal(
      errText({ code: 'INTERNAL', status: 500, message: 'whatever', ref: 'err_deadbeef' }),
      'Something went wrong on our side. Reference: err_deadbeef'
    );
  });

  check('raw exception text NEVER reaches mapped output for INTERNAL / uncoded 500', () => {
    const smtp = errText({
      code: 'INTERNAL',
      status: 500,
      message: 'SMTP error: expected 250 but got 503 AUTH LOGIN cleartext',
      ref: 'err_0123abcd',
    });
    assert(!smtp.includes('SMTP'), 'SMTP internals leaked: ' + smtp);
    assert(smtp.startsWith('Something went wrong on our side.'));
    const uncoded = errText({ status: 500, message: 'APP_URL_REQUIRED at stripeClient.js:41' });
    assert(!uncoded.includes('APP_URL'), 'internal key leaked: ' + uncoded);
    assert(!uncoded.includes('stripeClient'), 'internal path leaked: ' + uncoded);
    const sql = errText({ status: 500, code: 'ERROR', message: 'SQLITE_ERROR: no such table: leads' });
    assert(!sql.includes('SQLITE'), 'SQL text leaked: ' + sql);
  });

  check('authored VALIDATION copy passes through untouched', () => {
    assert.equal(
      errText({ code: 'VALIDATION', status: 400, message: 'Name is required' }),
      'Name is required'
    );
    assert.equal(
      errText({ code: 'DUPLICATE_EMAIL', status: 409, message: 'That email is already used by another lead' }),
      'That email is already used by another lead'
    );
  });

  check('authored 5xx config diagnostics (…_NOT_CONFIGURED) keep their message', () => {
    assert.equal(
      errText({ code: 'STRIPE_NOT_CONFIGURED', status: 503, message: 'Stripe is not configured: set the secret key' }),
      'Stripe is not configured: set the secret key'
    );
  });

  check('message-as-code (legacy flat shape) maps by code', () => {
    assert.equal(errText(new Error('AUTH_REQUIRED')), 'Please sign in again.');
    assert.equal(errText('FORBIDDEN'), "You don't have permission for that.");
  });

  check('network failure → connection copy; client-authored message passes through', () => {
    const typeErr = vm.runInContext('new TypeError("Failed to fetch")', sandbox);
    assert.match(errText(typeErr), /Could not reach the server/);
    assert.equal(errText(new Error('Could not save fonts')), 'Could not save fonts');
    assert.equal(errText(null), 'Something went wrong on our side.');
  });

  check('4xx route-authored copy shows; literal "Server error" never does', () => {
    assert.equal(errText({ status: 404, message: 'Lead not found' }), 'Lead not found');
    assert.equal(errText({ status: 400, message: 'Server error' }), 'Something went wrong on our side.');
  });
}

/* ===================================================================== */
/* Part A3 — static pins: helpers route through the mapper                */
/* ===================================================================== */

function partA3() {
  const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const portal = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const portalHtml = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');

  check('errorCopy.js loads before api.js (staff) and before portal.js (portal)', () => {
    assert(indexHtml.indexOf('/js/errorCopy.js') > -1);
    assert(indexHtml.indexOf('/js/errorCopy.js') < indexHtml.indexOf('/js/api.js'));
    assert(portalHtml.indexOf('/js/errorCopy.js') > -1);
    assert(portalHtml.indexOf('/js/errorCopy.js') < portalHtml.indexOf('/js/portal.js'));
  });

  check('api.js + portal.js capture err.ref from error bodies', () => {
    assert(api.includes('err.ref ='), 'api.js must carry the ref');
    assert(portal.includes('err.ref ='), 'portal.js must carry the ref');
  });

  check('Page-failed-to-load card renders errText(err), never err.message', () => {
    const i = app.indexOf('Page failed to load');
    assert(i > 0);
    const card = app.slice(i, i + 220);
    assert(card.includes('errText(err)'), 'page-failed card must use the mapper');
    assert(!card.includes('err.message'), 'page-failed card must not print err.message');
  });

  check('safeRun toast + warnings banner are wired through the mapper', () => {
    assert(app.includes("toast(errText(err), 'err')"), 'safeRun central toast must use errText');
    assert.equal(app.split('warningsBannerHtml(d.warnings)').length - 1, 2, 'Calls + LeadScout pages render warnings');
    assert(app.includes('function warningsBannerHtml(warnings)'));
  });

  check('sink census: no direct err.message DOM sinks remain in either shell', () => {
    const SINK =
      /(?:toast|setMsg|alert|moduleMsg|moduleModalMsg|setStructureMsg|setAgentChatStatus)\([^\n]*?(?:err|error|invErr|ex|e)\.message|textContent = (?:err|error|invErr|ex|e)\.message|esc\((?:err|error|invErr|ex|e)\.message|loadError(?:Row|Card)Html\([^\n]*?(?:err|error|invErr|ex|e)\.message/g;
    for (const [name, src] of [['app.js', app], ['portal.js', portal]]) {
      const hits = src.match(SINK) || [];
      assert.equal(hits.length, 0, `${name} raw sinks: ${hits.slice(0, 3).join(' | ')}`);
    }
    assert(app.split('errText(').length - 1 >= 100, 'app.js mapper call sites present');
    assert(portal.split('errText(').length - 1 >= 50, 'portal.js mapper call sites present');
  });

  check('server global handler shapes through apiErrors (no raw err.message responses)', () => {
    const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert(serverJs.includes('apiErrors.shapeError(err'), 'global handler must use shapeError');
    const routeFiles = [
      'server/routes/billing.js', 'server/routes/portal.js', 'server/routes/auth.js',
      'server/routes/admin.js', 'server/routes/gbp.js', 'server/routes/formsPublic.js',
    ];
    for (const f of routeFiles) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      assert(src.includes("require('../apiErrors')"), `${f} must require apiErrors`);
      assert(src.includes('apiErrors.sendError'), `${f} fail() must shape via apiErrors`);
    }
  });
}

/* ===================================================================== */
/* Part B — adminCallsOverview warnings                                   */
/* ===================================================================== */

async function partB() {
  const pdb = require(path.join(root, 'server/db.js'));
  await pdb.migrate(); // platform schema, as server boot does
  // Batch 143: registration defaults CLOSED when unset now; the
  // register-validation checks below run with it explicitly open.
  await require('./lib/platformTestDb.cjs').setPlatformSetting(pdb, 'registration.open', '1');
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const domain = require(path.join(root, 'server/domain.js'));
  const stripeClient = require(path.join(root, 'server/stripeClient.js'));

  const WS = 54;
  const db = openWorkspaceDb(WS);
  const leadId = Number(
    db.prepare("INSERT INTO leads (business_name, phone) VALUES ('Batch54 Biz', '+15550001111')").run()
      .lastInsertRowid
  );
  db.prepare(
    "INSERT INTO site_module_embeds (lead_id, module_type, title, published, embed_enabled, target_page_slug, created_at, updated_at) VALUES (?, 'calltracking', 'Call tracking', 1, 1, '', datetime('now'), datetime('now'))"
  ).run(leadId);

  await checkAsync('overview success path: data loads and warnings is an empty array', async () => {
    const payload = await domain.adminCallsOverview(WS);
    assert.equal(payload.businesses.length, 1);
    assert.equal(payload.pickerBusinesses.length, 1);
    assert.deepEqual(payload.warnings, []);
  });

  await checkAsync('failing sub-builder → defaults PLUS warnings entries PLUS a log line', async () => {
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.map(String).join(' '));
    const origAppUrl = stripeClient.appUrl;
    // The Batch 51 incident, reproduced: appUrl throws in production
    // mode without APP_URL and the overview used to empty silently.
    stripeClient.appUrl = () => {
      throw new Error('APP_URL_REQUIRED');
    };
    let payload;
    try {
      payload = await domain.adminCallsOverview(WS);
    } finally {
      stripeClient.appUrl = origAppUrl;
      console.warn = origWarn;
    }
    assert.equal(payload.businesses.length, 0, 'default preserved');
    assert.equal(payload.pickerBusinesses.length, 0, 'default preserved');
    const sections = payload.warnings.map((w) => w.section);
    assert(sections.includes('businesses'), 'businesses warning present: ' + JSON.stringify(payload.warnings));
    assert(sections.includes('pickerBusinesses'), 'picker warning present');
    assert(
      payload.warnings.every((w) => typeof w.message === 'string' && w.message.length > 10),
      'warnings carry plain-language messages'
    );
    assert(
      warns.some((l) => l.includes('[domain] adminCallsOverview businesses:') && l.includes('APP_URL_REQUIRED')),
      'a contextual log line was written'
    );
  });
}

/* ===================================================================== */
/* Part A4 — HTTP: global handler + coded routes over the wire            */
/* ===================================================================== */

async function partA4() {
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

    await checkAsync('malformed JSON → 400 BAD_JSON via the global handler (no parser leak)', async () => {
      const res = await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{oops',
      });
      const body = await res.json();
      assert.equal(res.status, 400);
      assert.equal(body.code, 'BAD_JSON');
      assert(!String(body.error).includes('Unexpected token'), 'parser text leaked: ' + body.error);
      assert(!String(body.error).includes('JSON at position'), 'parser detail leaked: ' + body.error);
    });

    await checkAsync('coded route error keeps its code over the wire (INVALID_CREDENTIALS)', async () => {
      const res = await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@batch54.invalid', password: 'wrong-password' }),
      });
      const body = await res.json();
      assert.equal(res.status, 401);
      // Login's legacy flat shape: the code rides in `error` (the
      // client normalizes message-as-code — see api.js + errorCopy.js).
      assert.equal(body.error, 'INVALID_CREDENTIALS');
      assert.equal(body.ref, undefined, 'coded errors carry no ref');
    });

    await checkAsync('register validation keeps its authored message over the wire', async () => {
      const res = await fetch(`${BASE}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      assert.equal(res.status, 400);
      // Register's early validations answer with authored copy in the
      // legacy flat shape; the client mapper passes 4xx authored copy
      // through — it must arrive intact, not genericized.
      assert.equal(body.error, 'You must accept the Terms and Privacy Policy');
    });
  } finally {
    child.kill('SIGTERM');
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

(async () => {
  partA1();
  partA2();
  partA3();
  await partB();
  await partA4();
  console.log(
    JSON.stringify({
      file: 'batch54-error-copy-regressions',
      checks: results.length,
      passed: true,
      negativeMode: NEGATIVE,
      names: results,
    })
  );
})().catch((e) => {
  console.error('batch54 regressions FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
