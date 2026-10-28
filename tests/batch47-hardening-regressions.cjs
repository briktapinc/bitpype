'use strict';
/**
 * Batch 47 — hardening, four items:
 *
 *  (1) GLOBAL SECURITY HEADERS. Helmet was already global (CSP with
 *      frame-ancestors 'self', enforced in production) but helmet has no
 *      Permissions-Policy, its X-Frame-Options duplicated the CSP framing
 *      control, and HSTS was purely env-gated. Now server/securityHeaders.js
 *      owns the policy: helmetOptions() (the old helmet config, moved,
 *      with frameguard disabled — CSP frame-ancestors is THE framing
 *      mechanism) + securityHeaders() middleware (Permissions-Policy
 *      always; nosniff / Referrer-Policy / HSTS filled only when absent,
 *      so a route's own headers — e.g. the preview CSP — are never
 *      duplicated or clobbered). The control app below (same helmet, no
 *      middleware) is the falsifiable proof: the new headers vanish.
 *
 *  (2) TURNSTILE HONESTY. Finding first: unconfigured Turnstile was NEVER
 *      silently off in production — getCaptchaConfig reports
 *      misconfigured, verifyCaptchaToken fails closed (503 at routes) and
 *      assertProductionReady refuses to boot. Skipping happens only
 *      outside production or with CAPTCHA_OPTIONAL=1. What was missing is
 *      visibility: getCaptchaConfig now carries a one-word `state`,
 *      getCaptchaStatus() exposes {configured, …} with no key material,
 *      Admin → Settings embeds it (routes/admin.js) and the General
 *      settings page renders a banner (public/js/app.js). No behavior
 *      change: NOT fail-closed anywhere it wasn't already.
 *
 *  (3) leads:list ORDER BY. The column came from a map, but membership was
 *      a truthiness lookup — inherited keys ('constructor',
 *      'hasOwnProperty') resolved to functions and were interpolated into
 *      the SQL. Now: frozen map + hasOwnProperty membership + the existing
 *      strict ASC/DESC outcome. NEGATIVE PROOF (run at build time):
 *      restoring the truthiness lookup makes the 'constructor' case below
 *      return ok:false (function source in SQL) → restored, green.
 *
 *  (4) pagesAddDomain ALREADY-ATTACHED TOLERANCE (live bug, Berks repair
 *      2026-10-28). List-first: an attached domain satisfies the attach
 *      and is reported preExisting. A POST refused as already-added is
 *      confirmed against the project list before being believed; any
 *      other refusal still throws and nothing is marked linked.
 *      NEGATIVE PROOF (run at build time): reverting pagesAddDomain to
 *      the raw POST fails cases (a) and (b) → restored, green.
 *
 * The CF HTTP layer is stubbed by patching node:https.request BEFORE
 * cfDomains is required (house pattern). No real network anywhere:
 * Turnstile's siteverify is a stubbed global fetch, platform settings
 * are an in-memory map.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqlite';
process.env.EXPORT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b47-exports-'));

const root = path.resolve(__dirname, '..');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}

/* ---------------- env control ---------------- */
const ENV_KEYS = ['NODE_ENV', 'APP_URL', 'COOKIE_SECURE', 'CSP_REPORT_ONLY', 'CAPTCHA_OPTIONAL'];
const savedEnv = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
function setEnv(map) {
  for (const k of ENV_KEYS) {
    if (map[k] === undefined) delete process.env[k];
    else process.env[k] = map[k];
  }
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

/* ================= (1) security headers ================= */

function rawGet(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, distinct: res.headersDistinct, body: Buffer.concat(chunks).toString('utf8') })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

function buildHeaderApp({ withSecurity }) {
  const express = require('express');
  const helmet = require('helmet');
  const sh = require(path.join(root, 'server/securityHeaders.js'));
  const previewSecurity = require(path.join(root, 'server/previewSecurity.js'));
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet(sh.helmetOptions()));
  if (withSecurity) app.use(sh.securityHeaders());
  const page = (label) => (req, res) => res.type('html').send(`<h1>${label}</h1>`);
  app.get('/', page('public home'));
  app.get('/app', page('staff shell'));
  app.get('/portal', page('portal shell'));
  app.get('/api/v1/ping', (req, res) => res.json({ ok: true }));
  // Mirrors /site-previews: a later middleware replaces the CSP wholesale.
  app.get('/preview-like', previewSecurity.isolateStaticPreview, page('site preview'));
  return app;
}

async function withServer(app, fn) {
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(srv.address().port);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
}

const ACCEPTABLE_REFERRER = new Set(['no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin']);

async function headerSuite() {
  const sh = require(path.join(root, 'server/securityHeaders.js'));

  // Production posture: CSP enforced, APP_URL https so helmet HSTS is on.
  setEnv({ NODE_ENV: 'production', APP_URL: 'https://example.test', COOKIE_SECURE: undefined, CSP_REPORT_ONLY: undefined });
  await withServer(buildHeaderApp({ withSecurity: true }), async (port) => {
    await checkAsync('headers: staff/portal/public/api responses carry the full baseline set', async () => {
      for (const p of ['/', '/app', '/portal', '/api/v1/ping']) {
        const r = await rawGet(port, p);
        assert.equal(r.status, 200, `${p} status`);
        assert.deepEqual(r.distinct['x-content-type-options'], ['nosniff'], `${p} nosniff (single, exact)`);
        const referrer = (r.distinct['referrer-policy'] || [])[0];
        assert.ok(ACCEPTABLE_REFERRER.has(referrer), `${p} referrer-policy present and safe, got ${referrer}`);
        assert.deepEqual(
          r.distinct['permissions-policy'],
          [sh.PERMISSIONS_POLICY],
          `${p} permissions-policy exact, single`
        );
        assert.equal(r.distinct['x-frame-options'], undefined, `${p} X-Frame-Options absent (CSP is the framing control)`);
        const csp = (r.distinct['content-security-policy'] || [])[0] || '';
        assert.ok(csp.includes("frame-ancestors 'self'"), `${p} CSP carries frame-ancestors 'self'`);
        assert.ok((r.distinct['strict-transport-security'] || [])[0], `${p} HSTS present behind https APP_URL`);
      }
    });

    await checkAsync('headers: preview CSP is neither duplicated nor clobbered', async () => {
      const r = await rawGet(port, '/preview-like');
      const csp = r.distinct['content-security-policy'] || [];
      assert.equal(csp.length, 1, `preview CSP must appear exactly once, got ${csp.length}`);
      assert.ok(
        csp[0].startsWith('sandbox allow-scripts allow-forms'),
        `preview CSP is isolateStaticPreview's own, got: ${csp[0].slice(0, 60)}`
      );
      assert.deepEqual(r.distinct['permissions-policy'], [sh.PERMISSIONS_POLICY], 'preview still gets Permissions-Policy');
      assert.deepEqual(r.distinct['referrer-policy'], ['no-referrer'], "preview's own Referrer-Policy wins over the fill-in");
    });
  });

  // Helmet HSTS env-off (no APP_URL): the middleware still guarantees STS
  // on requests that actually arrived over HTTPS (X-Forwarded-Proto via
  // trust proxy, the Cloudflare shape) — and stays silent on plain HTTP.
  setEnv({ NODE_ENV: 'production', APP_URL: undefined, COOKIE_SECURE: undefined, CSP_REPORT_ONLY: undefined });
  await withServer(buildHeaderApp({ withSecurity: true }), async (port) => {
    await checkAsync('headers: HSTS guaranteed on HTTPS requests even when helmet HSTS is env-off', async () => {
      const httpsReq = await rawGet(port, '/api/v1/ping', { 'X-Forwarded-Proto': 'https' });
      assert.deepEqual(httpsReq.distinct['strict-transport-security'], [sh.HSTS_VALUE]);
      const httpReq = await rawGet(port, '/api/v1/ping');
      assert.equal(httpReq.distinct['strict-transport-security'], undefined, 'no HSTS blessed onto plain HTTP');
    });
  });

  // FALSIFIABLE CONTROL: same helmet, middleware removed → the batch's
  // headers must be gone (Permissions-Policy always; HSTS under env-off).
  await withServer(buildHeaderApp({ withSecurity: false }), async (port) => {
    await checkAsync('headers: control app without the middleware lacks the new headers (falsifiable)', async () => {
      const r = await rawGet(port, '/api/v1/ping', { 'X-Forwarded-Proto': 'https' });
      assert.equal(r.distinct['permissions-policy'], undefined, 'Permissions-Policy must come from the middleware');
      assert.equal(
        r.distinct['strict-transport-security'],
        undefined,
        'with helmet HSTS env-off and no middleware, no STS may appear'
      );
      assert.deepEqual(r.distinct['x-content-type-options'], ['nosniff'], 'control sanity: helmet baseline still present');
    });
  });

  check('headers: server.js wires helmet + middleware from server/securityHeaders', () => {
    const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(src.includes("require('./server/securityHeaders')"), 'server.js requires the module');
    assert.ok(src.includes('helmet(securityHeaders.helmetOptions())'), 'helmet uses helmetOptions()');
    assert.ok(src.includes('app.use(securityHeaders.securityHeaders())'), 'middleware mounted');
  });
}

/* ================= (2) Turnstile honesty ================= */

async function captchaSuite() {
  const platform = require(path.join(root, 'server/platform.js'));
  let settingMap = {};
  const realGetSetting = platform.getPlatformSetting;
  platform.getPlatformSetting = async (key, fallback = '') =>
    Object.prototype.hasOwnProperty.call(settingMap, key) ? settingMap[key] : fallback;

  const realFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), body: String((opts && opts.body) || '') });
    const token = new URLSearchParams(String((opts && opts.body) || '')).get('response');
    return { json: async () => ({ success: token === 'good-token' }) };
  };

  const captcha = require(path.join(root, 'server/captcha.js'));

  function mockRes() {
    return {
      statusCode: null,
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
  async function runRequireCaptcha(body) {
    const req = { body, ip: '203.0.113.9' };
    const res = mockRes();
    let nexted = false;
    await captcha.requireCaptcha()(req, res, () => {
      nexted = true;
    });
    return { res, nexted };
  }

  try {
    await checkAsync('captcha: configured + production — good token passes, bad/missing rejected', async () => {
      setEnv({ NODE_ENV: 'production', CAPTCHA_OPTIONAL: undefined });
      settingMap = { 'captcha.enabled': '1', 'captcha.site_key': 'site-key-fixture', 'captcha.secret_key': 'secret-fixture' };
      fetchCalls.length = 0;
      const cfg = await captcha.getCaptchaConfig();
      assert.equal(cfg.state, 'enforcing');
      assert.equal(cfg.keysPresent, true);
      assert.deepEqual(await captcha.getCaptchaStatus(), {
        configured: true,
        enabled: true,
        misconfigured: false,
        forceOff: false,
        state: 'enforcing',
      });
      assert.deepEqual(await captcha.verifyCaptchaToken('good-token', '203.0.113.9'), { ok: true });
      assert.ok(
        fetchCalls.some((c) => c.url.includes('challenges.cloudflare.com/turnstile/v0/siteverify')),
        'verify hit the (stubbed) siteverify endpoint'
      );
      await assert.rejects(captcha.verifyCaptchaToken('bad-token'), (e) => e.code === 'CAPTCHA_FAILED');
      await assert.rejects(captcha.verifyCaptchaToken(''), (e) => e.code === 'CAPTCHA_REQUIRED');
      const bad = await runRequireCaptcha({ captchaToken: 'bad-token' });
      assert.equal(bad.nexted, false);
      assert.equal(bad.res.statusCode, 400);
      const good = await runRequireCaptcha({ captchaToken: 'good-token' });
      assert.equal(good.nexted, true);
    });

    await checkAsync('captcha: production without keys FAILS CLOSED and reports configured:false', async () => {
      setEnv({ NODE_ENV: 'production', CAPTCHA_OPTIONAL: undefined });
      settingMap = {};
      const cfg = await captcha.getCaptchaConfig();
      assert.equal(cfg.state, 'misconfigured');
      assert.equal(cfg.misconfigured, true);
      const status = await captcha.getCaptchaStatus();
      assert.equal(status.configured, false, 'the admin surface must say configured:false');
      assert.equal(status.state, 'misconfigured');
      await assert.rejects(captcha.verifyCaptchaToken('anything'), (e) => e.code === 'CAPTCHA_NOT_CONFIGURED');
      const r = await runRequireCaptcha({ captchaToken: 'anything' });
      assert.equal(r.nexted, false);
      assert.equal(r.res.statusCode, 503, 'unconfigured production captcha answers 503, never a silent pass');
    });

    await checkAsync('captcha: skipping is explicit states (optional / force-off), never silent', async () => {
      setEnv({ NODE_ENV: 'production', CAPTCHA_OPTIONAL: '1' });
      settingMap = {};
      let cfg = await captcha.getCaptchaConfig();
      assert.equal(cfg.state, 'skipped');
      assert.deepEqual(await captcha.verifyCaptchaToken('anything'), { ok: true, skipped: true });
      assert.equal((await captcha.getCaptchaStatus()).configured, false);

      setEnv({ NODE_ENV: 'production', CAPTCHA_OPTIONAL: undefined });
      settingMap = { 'captcha.enabled': '0', 'captcha.site_key': 'k', 'captcha.secret_key': 's' };
      cfg = await captcha.getCaptchaConfig();
      assert.equal(cfg.state, 'off');
      assert.equal(cfg.forceOff, true);
      assert.deepEqual(await captcha.verifyCaptchaToken('anything'), { ok: true, skipped: true });
    });

    await checkAsync('captcha: boot guard refuses production without keys, boots fine with them', async () => {
      setEnv({ NODE_ENV: 'production', CAPTCHA_OPTIONAL: undefined });
      settingMap = {};
      const realExit = process.exit;
      const realError = console.error;
      let exitCode = null;
      console.error = () => {};
      process.exit = (code) => {
        exitCode = code;
        throw new Error(`exit:${code}`);
      };
      try {
        await assert.rejects(captcha.assertProductionReady(), /exit:1/);
        assert.equal(exitCode, 1);
      } finally {
        process.exit = realExit;
        console.error = realError;
      }
      settingMap = { 'captcha.site_key': 'k', 'captcha.secret_key': 's' };
      await captcha.assertProductionReady(); // must resolve, no exit
    });

    check('captcha: admin settings route + UI carry the status (structural)', () => {
      const adminSrc = fs.readFileSync(path.join(root, 'server/routes/admin.js'), 'utf8');
      assert.ok(
        adminSrc.includes("captcha = await require('../captcha').getCaptchaStatus()"),
        'GET /admin/settings embeds getCaptchaStatus()'
      );
      const appSrc = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
      assert.ok(appSrc.includes('captchaStatusHtml'), 'settings page renders the captcha banner');
      assert.ok(appSrc.includes('res.data.captcha'), 'banner is driven by the settings response');
    });
  } finally {
    platform.getPlatformSetting = realGetSetting;
    globalThis.fetch = realFetch;
  }
}

/* ================= (3) leads:list ORDER BY allowlist ================= */

async function leadsSortSuite() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  const handlers = {};
  require(path.join(root, 'src/ipc/leads.js')).register(
    {
      handle: (name, fn) => {
        handlers[name] = fn;
      },
    },
    db
  );
  const ins = db.prepare(
    `INSERT INTO leads (business_name, category, score, status, source, lead_group, created_at, updated_at)
     VALUES (?, 'Plumbing', ?, 'new', 'manual', 'g1', '2026-01-01 00:00:00', ?)`
  );
  ins.run('Zeta Co', 10, '2026-01-03 00:00:00');
  ins.run('Alpha Co', 90, '2026-01-01 00:00:00');
  ins.run('Mid Co', 50, '2026-01-02 00:00:00');

  const list = (filters) => handlers['leads:list'](null, filters);
  const names = (res) => res.rows.map((r) => r.business_name);
  const DEFAULT_ORDER = ['Zeta Co', 'Mid Co', 'Alpha Co']; // updated_at DESC

  await checkAsync('leads sort: default + legitimate caller sorts order correctly', async () => {
    const def = await list({});
    assert.equal(def.ok, true);
    assert.deepEqual(names(def), DEFAULT_ORDER, 'default sort is updated desc');
    assert.deepEqual(names(await list({ sort: 'score', order: 'desc' })), ['Alpha Co', 'Mid Co', 'Zeta Co']);
    assert.deepEqual(names(await list({ sort: 'score', order: 'asc' })), ['Zeta Co', 'Mid Co', 'Alpha Co']);
    assert.deepEqual(names(await list({ sort: 'name', order: 'asc' })), ['Alpha Co', 'Mid Co', 'Zeta Co']);
    for (const key of ['name', 'category', 'score', 'status', 'source', 'updated', 'group']) {
      const r = await list({ sort: key, order: 'desc' });
      assert.equal(r.ok, true, `sort key ${key} must be accepted`);
      assert.equal(r.rows.length, 3);
    }
  });

  await checkAsync('leads sort: injection-shaped + prototype-key sorts fall back to the default', async () => {
    const badSorts = [
      'id; DROP TABLE leads--',
      '(CASE WHEN 1=1 THEN id END)',
      'updated_at DESC; DELETE FROM leads',
      'constructor',
      'hasOwnProperty',
      '__proto__',
      'toString',
      'valueOf',
    ];
    for (const sort of badSorts) {
      const r = await list({ sort, order: 'desc' });
      assert.equal(r.ok, true, `sort=${JSON.stringify(sort)} must not error the query`);
      assert.deepEqual(names(r), DEFAULT_ORDER, `sort=${JSON.stringify(sort)} must fall back to updated desc`);
    }
    const count = db.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
    assert.equal(count, 3, 'leads table untouched by every malicious sort');
  });

  await checkAsync('leads sort: injection-shaped directions collapse to DESC, asc still works', async () => {
    const scoreDesc = ['Alpha Co', 'Mid Co', 'Zeta Co'];
    for (const order of ['(CASE WHEN 1=1 THEN id END)', 'asc; DROP TABLE leads--', 'descending', 'ASC, (SELECT 1)', '']) {
      const r = await list({ sort: 'score', order });
      assert.equal(r.ok, true, `order=${JSON.stringify(order)} must not error`);
      assert.deepEqual(names(r), scoreDesc, `order=${JSON.stringify(order)} must behave as DESC`);
    }
    assert.deepEqual(names(await list({ sort: 'score', order: 'ASC' })), ['Zeta Co', 'Mid Co', 'Alpha Co']);
    const count = db.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
    assert.equal(count, 3);
  });
}

/* ================= (4) pagesAddDomain tolerance ================= */

const CF_ACCOUNT = '0123456789abcdef0123456789abcdef';
const LINK_DOMAIN = 'batch47-fixture.com';
const LINK_PROJECT = 'bp-w1-s47';
const CF_ZONE_ID = 'zone47fixture00000000000000000abcd';

let httpsPatch;
const httpCalls = [];
let pagesDomains = [];
let pagesPostMode = 'ok'; // 'ok' | 'already' | 'fail'
{
  const https = require('node:https');
  const realRequest = https.request;
  httpsPatch = { restore: () => (https.request = realRequest) };
  https.request = (options, cb) => {
    const chunks = [];
    const req = new EventEmitter();
    req.write = (c) => chunks.push(Buffer.from(c));
    req.destroy = () => {};
    req.end = () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {
        body = null;
      }
      httpCalls.push({ method: options.method, path: options.path, body });
      const p = options.path;
      let status = 200;
      let payload;
      if (p.includes('/dns_records') && options.method === 'GET') {
        payload = {
          success: true,
          result: [
            { id: 'rec1', type: 'CNAME', name: LINK_DOMAIN, content: `${LINK_PROJECT}.pages.dev`, proxied: true },
          ],
        };
      } else if (p.includes('/dns_records') && options.method === 'POST') {
        payload = { success: true, result: { id: 'rec2', ...(body || {}) } };
      } else if (p.startsWith('/client/v4/zones')) {
        const name = new URLSearchParams(p.split('?')[1] || '').get('name');
        payload = { success: true, result: [{ id: CF_ZONE_ID, name }] };
      } else if (p.includes('/pages/projects/') && p.endsWith('/domains')) {
        if (options.method === 'GET') {
          payload = { success: true, result: pagesDomains };
        } else if (options.method === 'POST' && pagesPostMode === 'ok') {
          pagesDomains = [...pagesDomains, { name: body && body.name, status: 'pending' }];
          payload = { success: true, result: { name: body && body.name, status: 'pending' } };
        } else if (options.method === 'POST' && pagesPostMode === 'already') {
          // The domain IS on the project (the list raced) — CF refuses the
          // duplicate POST with the exact live error text.
          pagesDomains = [{ name: body && body.name, status: 'active' }];
          status = 400;
          payload = {
            success: false,
            errors: [{ code: 8000017, message: 'You have already added this custom domain' }],
          };
        } else {
          status = 400;
          payload = {
            success: false,
            errors: [{ code: 8000000, message: 'Invalid domain configuration for this project' }],
          };
        }
      } else {
        payload = { success: true, result: {} };
      }
      const res = new EventEmitter();
      res.statusCode = status;
      process.nextTick(() => {
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify(payload)));
        res.emit('end');
      });
    };
    return req;
  };
}

const engine = require(path.join(root, 'src/websiteEngine.js'));
const cfDomains = require(path.join(root, 'src/cfDomains.js'));

function makeLinkDb(id) {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  engine.ensureTables(db);
  cfDomains.ensureTables(db);
  const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  put.run('cf.api_token', 'fixture-token-not-a-real-secret');
  put.run('cf.account_id', CF_ACCOUNT);
  db.prepare(
    `INSERT INTO leads (id, business_name, category, phone, email, city, state)
     VALUES (?, 'Fixture Co', 'Dumpster rental', '(610) 555-0142', 'hello@fixture.example', 'Reading', 'PA')`
  ).run(id);
  db.prepare(
    `INSERT INTO websites (id, lead_id, name, industry, theme, pages, status, preview_url, custom_domain, updated_at)
     VALUES (?, ?, 'Fixture Co', 'dumpster rental', '{}', '[]', 'draft', ?, NULL, '2026-10-01 00:00:00')`
  ).run(id, id, `https://${LINK_PROJECT}.pages.dev`);
  return db;
}

const attachPosts = () =>
  httpCalls.filter((c) => c.method === 'POST' && c.path.includes('/pages/projects/') && c.path.endsWith('/domains'));

async function linkCase(mode, initialDomains) {
  httpCalls.length = 0;
  pagesDomains = initialDomains;
  pagesPostMode = mode;
  const db = makeLinkDb(4701);
  const args = {
    domain: LINK_DOMAIN,
    websiteId: 4701,
    leadId: 4701,
    project: LINK_PROJECT,
    workspaceId: 1,
    source: 'batch47-test',
  };
  let result = null;
  let error = null;
  try {
    result = await cfDomains.linkDomainToWebsite(db, args);
  } catch (e) {
    error = e;
  }
  const site = db.prepare('SELECT custom_domain FROM websites WHERE id = 4701').get();
  const linked = db
    .prepare("SELECT COUNT(*) AS c FROM site_domains WHERE domain_name = ? AND status = 'linked'")
    .get(LINK_DOMAIN).c;
  return { result, error, site, linked };
}

async function pagesSuite() {
  await checkAsync('pages: (a) already attached — link completes via list, NO attach POST, marked pre-existing', async () => {
    const { result, error, site, linked } = await linkCase('ok', [{ name: LINK_DOMAIN, status: 'active' }]);
    assert.equal(error, null, `link must not throw: ${error && error.message}`);
    assert.equal(attachPosts().length, 0, 'no POST may be issued when the domain is already attached');
    assert.equal(result.pages.preExisting, true, 'attach info must say it was pre-existing');
    assert.equal(site.custom_domain, LINK_DOMAIN);
    assert.equal(linked, 1);
  });

  await checkAsync('pages: (b) POST refused as already-added — confirm-list rescues the link', async () => {
    const { result, error, site, linked } = await linkCase('already', []);
    assert.equal(error, null, `link must not throw: ${error && error.message}`);
    assert.equal(attachPosts().length, 1, 'exactly one attach POST was attempted');
    assert.equal(result.pages.preExisting, true);
    assert.equal(site.custom_domain, LINK_DOMAIN);
    assert.equal(linked, 1);
  });

  await checkAsync('pages: (c) genuine attach failure — link throws, nothing is marked linked', async () => {
    const { result, error, site, linked } = await linkCase('fail', []);
    assert.equal(result, null);
    assert.ok(error, 'link must throw');
    assert.equal(error.code, 'CF_ERROR');
    assert.ok(/Invalid domain configuration/.test(error.message), `original CF error surfaces: ${error.message}`);
    assert.equal(site.custom_domain, null, 'custom_domain must stay unset on a failed attach');
    assert.equal(linked, 0, 'no site_domains row may be marked linked');
  });

  await checkAsync('pages: (d) fresh attach still works and is not flagged pre-existing', async () => {
    const { result, error, site, linked } = await linkCase('ok', []);
    assert.equal(error, null, `link must not throw: ${error && error.message}`);
    assert.equal(attachPosts().length, 1);
    assert.ok(!result.pages.preExisting, 'a fresh attach must not claim pre-existing');
    assert.equal(result.pages.status, 'pending');
    assert.equal(site.custom_domain, LINK_DOMAIN);
    assert.equal(linked, 1);
  });
}

/* ================= runner ================= */

(async () => {
  try {
    await headerSuite();
    restoreEnv();
    await captchaSuite();
    restoreEnv();
    await leadsSortSuite();
    await pagesSuite();
  } finally {
    restoreEnv();
    if (httpsPatch) httpsPatch.restore();
  }
  console.log(`batch47-hardening-regressions: ${results.length} checks passed`);
  for (const name of results) console.log(`  ok - ${name}`);
  console.log(JSON.stringify({ file: 'batch47-hardening-regressions', checks: results.length, passed: true }));
})().catch((e) => {
  console.error('batch47-hardening-regressions FAILED:', e);
  process.exit(1);
});
