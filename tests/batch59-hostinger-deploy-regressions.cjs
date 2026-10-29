'use strict';
/**
 * Batch 59 — one-click Hostinger deployment for /landing software
 * signups (Ely's order, 2026-10-29).
 *
 * What shipped:
 *   - Platform settings hostinger.api_token (secret,
 *     secretBox-encrypted), hostinger.default_price_id /
 *     data_center_id / template_id — registered in PLATFORM_SETTING_DEFS
 *     + PLATFORM_SECRET_KEYS + settingsKeys SETTABLE_KEYS with
 *     validators at BOTH save choke points (Batch 24b invariant).
 *     Admin → Settings → Hostinger renders the group + a status /
 *     test-connection panel (the test pings payment-methods + catalog;
 *     coded errors, Batch 54 discipline).
 *   - A deployments table in the PLATFORM store + server/
 *     hostingerDeploy.js: a software-interest lead (source
 *     'landing-software' / lead_group 'Software interest' / tags) gets
 *     a "Deploy on Hostinger" panel in the lead drawer: live catalog
 *     preview → typed-DEPLOY confirmation → purchase via the
 *     Hostinger API (POST /api/vps/v1/virtual-machines, doc-verified
 *     against developers.hostinger.com + OpenAPI v2.6.1) with the
 *     per-deployment post-install script attached → poll until the VM
 *     runs → the VM's script installs a STANDARD-edition BitPype
 *     (Docker + this app's source bundle + per-install secrets + Caddy
 *     HTTPS on the Hostinger hostname), sets general.public_url,
 *     mints a one-time password-setup token and phones home →
 *     ready + setup email to the customer (send recorded; a mail
 *     failure is a warning, never a failed deployment).
 *   - Exactly-once money safety: an active_lead_key UNIQUE column
 *     (`ws:lead`) held while queued/provisioning/installing/ready +
 *     the purchase step runs only from 'queued' and stamps
 *     purchase_started_at BEFORE the API call; a purchase whose
 *     outcome was never recorded fails PURCHASE_OUTCOME_UNKNOWN on
 *     resume instead of re-buying. Prices are re-read from the live
 *     catalog at start and must match the confirmation
 *     (PRICE_CHANGED 409 otherwise). Retries only from 'failed'.
 *
 * NEGATIVE PROOF (B59_NEGATIVE=1): loads a scratch sibling copy of
 * server/hostingerDeploy.js whose advanceDeployment ALSO routes
 * 'provisioning' rows into the purchase step (the double-buy bug).
 * Part C's "advancing a provisioning deployment makes ZERO purchase
 * calls" check MUST go red; with the real module it is green.
 *
 * Harness: the Hostinger API is FULLY MOCKED — HTTP parts run against
 * a local stub API (HOSTINGER_API_BASE) that counts purchases; no
 * real Hostinger account, token, or money is involved. Server parts
 * boot the real server on temp platform/workspace DBs (batch53/58
 * pattern). Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b59-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch59', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 11).toString('base64');
process.env.BOOTSTRAP_EMAIL = 'owner-b59@example.invalid';
process.env.BOOTSTRAP_PASSWORD = 'Batch59!Passw0rd';
process.env.BOOTSTRAP_WORKSPACE = 'B59 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';
process.env.HOSTINGER_DEPLOY_TICK_MS = '1200';

const PORT = 31459;
const STUB_PORT = 31460;
const BASE = `http://127.0.0.1:${PORT}`;
const PRICE_ID = 'hostingercom-vps-kvm2-usd-1m';
const NEGATIVE = process.env.B59_NEGATIVE === '1';

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const errCode = (j) => (j && j.error && j.error.code) || (j && j.code) || '';
async function waitFor(label, fn, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out: ' + label);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/* ================================================================== */
/* The Hostinger API stub — full purchase surface, zero real money.    */
/* ================================================================== */

const stub = {
  purchases: 0,
  setups: 0,
  scripts: [],
  vmState: 'running',
  price: 1399,
  firstPrice: 699,
};
function stubVm(id) {
  return {
    id,
    subscription_id: 'sub-' + id,
    data_center_id: 5,
    plan: 'KVM 2',
    hostname: `srv${id}.hstgr.cloud`,
    state: stub.vmState,
    ipv4: [{ address: '203.0.113.10' }],
    created_at: '2026-10-29T00:00:00Z',
  };
}
const stubServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://stub');
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    if (req.headers.authorization !== 'Bearer test-token-123') {
      return send(401, { error: 'Unauthenticated.', correlation_id: 'stub-auth' });
    }
    if (u.pathname === '/api/billing/v1/catalog') {
      return send(200, [
        {
          id: 'hostingercom-vps-kvm2',
          name: 'KVM 2',
          category: 'VPS',
          prices: [
            {
              id: PRICE_ID,
              name: '1 month',
              currency: 'USD',
              price: stub.price,
              first_period_price: stub.firstPrice,
              period: 1,
              period_unit: 'month',
            },
          ],
        },
      ]);
    }
    if (u.pathname === '/api/billing/v1/payment-methods') {
      return send(200, [{ id: 7, name: 'Visa •• 4242', is_default: true }]);
    }
    if (u.pathname === '/api/vps/v1/post-install-scripts' && req.method === 'POST') {
      const id = 555 + stub.scripts.length;
      stub.scripts.push({ id, name: body && body.name, content: (body && body.content) || '' });
      return send(201, { id, name: body && body.name });
    }
    if (u.pathname === '/api/vps/v1/virtual-machines' && req.method === 'POST') {
      stub.purchases += 1;
      const id = 4200 + stub.purchases;
      const vm = { ...stubVm(id), state: 'initial' };
      return send(200, {
        order: { id: 9000 + stub.purchases, subscription_id: 'sub-' + id, status: 'completed' },
        virtual_machine: vm,
      });
    }
    const setupMatch = u.pathname.match(/^\/api\/vps\/v1\/virtual-machines\/(\d+)\/setup$/);
    if (setupMatch && req.method === 'POST') {
      stub.setups += 1;
      return send(202, stubVm(Number(setupMatch[1])));
    }
    const vmMatch = u.pathname.match(/^\/api\/vps\/v1\/virtual-machines\/(\d+)$/);
    if (vmMatch && req.method === 'GET') return send(200, stubVm(Number(vmMatch[1])));
    if (u.pathname === '/api/vps/v1/virtual-machines' && req.method === 'GET') {
      return send(200, [stubVm(4201)]);
    }
    return send(404, { error: 'not found', correlation_id: 'stub-404' });
  });
});

/* ================================================================== */
/* Part A — units: client mapping, markers, script pins, settings,     */
/* census + wiring (no server boot)                                    */
/* ================================================================== */

function partA() {
  const client = require(path.join(root, 'server/hostingerClient.js'));

  check('client: findCatalogPrice flattens the catalog price (cents stay cents)', () => {
    const items = [
      {
        id: 'hostingercom-vps-kvm2',
        name: 'KVM 2',
        prices: [
          { id: PRICE_ID, name: '1 month', currency: 'USD', price: 1399, first_period_price: 699, period: 1, period_unit: 'month' },
        ],
      },
    ];
    const p = client.findCatalogPrice(items, PRICE_ID);
    assert.equal(p.priceCents, 1399);
    assert.equal(p.firstPeriodPriceCents, 699);
    assert.equal(p.currency, 'USD');
    assert.equal(client.findCatalogPrice(items, 'nope'), null);
  });

  check('client: firstIpv4 accepts object, string-entry and plain-string shapes', () => {
    assert.equal(client.firstIpv4({ ipv4: [{ address: '1.2.3.4' }] }), '1.2.3.4');
    assert.equal(client.firstIpv4({ ipv4: [{ ip_address: '5.6.7.8' }] }), '5.6.7.8');
    assert.equal(client.firstIpv4({ ipv4: ['9.10.11.12'] }), '9.10.11.12');
    assert.equal(client.firstIpv4({ ipv4: '13.14.15.16' }), '13.14.15.16');
    assert.equal(client.firstIpv4({}), '');
    assert.equal(client.firstIpv4(null), '');
  });

  const deploy = require(path.join(root, 'server/hostingerDeploy.js'));

  check('markers: software-interest detection (stored group casing, source, tags) + ordinary lead excluded', () => {
    assert.equal(deploy.isSoftwareInterestLead({ lead_group: 'Software interest' }), true);
    assert.equal(deploy.isSoftwareInterestLead({ lead_group: 'Software Interest' }), true);
    assert.equal(deploy.isSoftwareInterestLead({ source: 'landing-software' }), true);
    assert.equal(deploy.isSoftwareInterestLead({ tags: ['landing-software'] }), true);
    assert.equal(deploy.isSoftwareInterestLead({ tags: ['software-interest'] }), true);
    assert.equal(deploy.isSoftwareInterestLead({ lead_group: 'Home services', source: 'manual', tags: [] }), false);
    assert.equal(deploy.isSoftwareInterestLead({}), false);
    assert.equal(deploy.isSoftwareInterestLead(null), false);
  });

  check('bootstrap script pins: standard install, callback + bundle, public_url step, under the 48 KB API limit', () => {
    const s = deploy.buildBootstrapScript({
      deploymentId: 7,
      leadEmail: 'buyer@example.com',
      workspaceName: "Bob's Shop",
      callbackUrl: 'https://bitpype.test/api/v1/hostinger-deploy/callback',
      callbackSecret: 'a'.repeat(64),
      bundleUrl: 'https://bitpype.test/api/v1/hostinger-deploy/bundle?token=' + 'b'.repeat(64),
    });
    assert.ok(s.startsWith('#!/bin/bash'));
    assert.ok(s.includes('BOOTSTRAP_SUPER_ADMIN=1'), 'bootstrap admin for the customer');
    assert.ok(s.includes('BOOTSTRAP_EMAIL=buyer@example.com'), 'customer email baked in');
    assert.ok(s.includes('APP_URL=$INSTANCE_URL'), 'public URL computed on the VM from its own hostname/IP');
    assert.ok(s.includes('general.public_url'), 'bootstrap sets the public URL through the settings writer');
    assert.ok(s.includes('/api/v1/hostinger-deploy/callback'), 'phones home');
    assert.ok(s.includes('/api/v1/hostinger-deploy/bundle?token='), 'downloads the bundle');
    assert.ok(s.includes('docker compose up -d --build'), 'installs the stack');
    assert.ok(s.includes('password_reset_tokens'), 'one-time setup token via the reset-token table');
    assert.ok(!/bitpype\.com/.test(s), 'no production-domain literal in the generated script');
    assert.ok(!/vendor/i.test(s), 'no elevated edition role anywhere in the install');
    assert.ok(!s.includes('INSTALL_ROLE'), 'no role stamp of any kind');
    assert.ok(Buffer.byteLength(s, 'utf8') < 48 * 1024, 'under the Hostinger post-install size limit');
  });

  check('settings: four hostinger defs exist; token is a platform secret; group is hostinger', () => {
    const platform = require(path.join(root, 'server/platform.js'));
    for (const key of ['hostinger.api_token', 'hostinger.default_price_id', 'hostinger.data_center_id', 'hostinger.template_id']) {
      const def = platform.PLATFORM_SETTING_DEFS.find((d) => d.key === key);
      assert.ok(def, key);
      assert.equal(def.group, 'hostinger', key);
    }
    const tok = platform.PLATFORM_SETTING_DEFS.find((d) => d.key === 'hostinger.api_token');
    assert.equal(tok.secret, true);
    assert.ok(platform.PLATFORM_SECRET_KEYS.includes('hostinger.api_token'));
  });

  check('settingsKeys: all four keys settable; validators accept catalog ids and reject junk', () => {
    const sk = require(path.join(root, 'server/settingsKeys.js'));
    for (const key of ['hostinger.api_token', 'hostinger.default_price_id', 'hostinger.data_center_id', 'hostinger.template_id']) {
      assert.ok(sk.SETTABLE_KEYS.includes(key), key);
    }
    assert.equal(sk.validateSetting('hostinger.default_price_id', PRICE_ID).ok, true);
    assert.equal(sk.validateSetting('hostinger.default_price_id', 'bad id!').ok, false);
    assert.equal(sk.validateSetting('hostinger.default_price_id', '').ok, true);
    assert.equal(sk.validateSetting('hostinger.data_center_id', '5').ok, true);
    assert.equal(sk.validateSetting('hostinger.data_center_id', 'abc').ok, false);
    assert.equal(sk.validateSetting('hostinger.template_id', '9').ok, true);
    assert.equal(sk.validateSetting('hostinger.template_id', 'x9').ok, false);
    assert.equal(sk.validateSetting('hostinger.api_token', 'tok').ok, true);
  });

  check('census: still exactly one production-domain literal in shipped code (Batch 56 pin holds)', () => {
    const walk = (dir, out = []) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p, out);
        else if (/\.(js|html)$/.test(ent.name)) out.push(p);
      }
      return out;
    };
    let total = 0;
    for (const tree of ['src', 'server', 'public']) {
      for (const file of walk(path.join(root, tree))) {
        const m = fs.readFileSync(file, 'utf8').match(/bitpype\.com/g);
        if (m) total += m.length;
      }
    }
    assert.equal(total, 1, `expected exactly 1 literal, found ${total}`);
  });

  check('wiring: callback router + ticker + admin routes + drawer + settings tab all present', () => {
    const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(serverSrc.includes("require('./server/routes/hostingerCallback')"), 'callback router required');
    assert.ok(serverSrc.includes("'/api/v1/hostinger-deploy'"), 'callback mount');
    assert.ok(serverSrc.includes('startDeploymentTicker'), 'ticker started at boot');
    const adminSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'admin.js'), 'utf8');
    assert.ok(adminSrc.includes('/settings/hostinger'), 'settings status route');
    assert.ok(adminSrc.includes('/leads/:leadId/hostinger-deployment'), 'lead deployment routes');
    const cbSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'hostingerCallback.js'), 'utf8');
    assert.ok(cbSrc.includes("'/callback'") && cbSrc.includes("'/bundle'"), 'callback + bundle endpoints');
    const appSrc = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
    assert.ok(appSrc.includes('ld-hostinger'), 'drawer section');
    assert.ok(appSrc.includes('Deploy on Hostinger'), 'deploy button');
    assert.ok(appSrc.includes("['hostinger', 'Hostinger']"), 'admin settings tab');
    assert.ok(appSrc.includes('hostingerPanelHtml'), 'settings panel');
    const apiSrc = fs.readFileSync(path.join(root, 'public', 'js', 'api.js'), 'utf8');
    assert.ok(apiSrc.includes('leadHostingerStart') && apiSrc.includes('adminHostingerTest'), 'api helpers');
  });
}

async function partAClient() {
  const client = require(path.join(root, 'server/hostingerClient.js'));
  const platform = require(path.join(root, 'server/platform.js'));
  await platform.setPlatformSetting('hostinger.api_token', 'tok-for-client-tests');
  const fakeRes = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body || {})),
  });
  await checkAsync('client: 401 → HOSTINGER_AUTH, 429 → HOSTINGER_RATE_LIMIT, network → HOSTINGER_UNREACHABLE', async () => {
    client.__setFetchForTests(async () => fakeRes(401, { error: 'Unauthenticated.' }));
    await assert.rejects(() => client.getCatalog(), (e) => e.code === 'HOSTINGER_AUTH');
    client.__setFetchForTests(async () => fakeRes(429, { error: 'slow down' }));
    await assert.rejects(() => client.getCatalog(), (e) => e.code === 'HOSTINGER_RATE_LIMIT');
    client.__setFetchForTests(async () => {
      throw new Error('socket hangup');
    });
    await assert.rejects(() => client.getCatalog(), (e) => e.code === 'HOSTINGER_UNREACHABLE');
    client.__setFetchForTests(null);
  });
  await checkAsync('client: purchase 202 → paymentProcessing (poll, never resend); 200 → order + VM', async () => {
    client.__setFetchForTests(async () => fakeRes(202, { id: 42, subscription_id: 'sub-42', status: 'payment_initiated' }));
    const pending = await client.purchaseVirtualMachine({ item_id: PRICE_ID, setup: {} });
    assert.equal(pending.paymentProcessing, true);
    assert.equal(pending.raw.subscription_id, 'sub-42');
    client.__setFetchForTests(async () =>
      fakeRes(200, { order: { id: 7, subscription_id: 'sub-7' }, virtual_machine: { id: 8, state: 'initial' } })
    );
    const done = await client.purchaseVirtualMachine({ item_id: PRICE_ID, setup: {} });
    assert.equal(done.paymentProcessing, false);
    assert.equal(done.virtualMachine.id, 8);
    client.__setFetchForTests(null);
  });
  // Leave the platform store tokenless again — Part B's dormant
  // checks boot against this same temp DB and must see no token.
  await platform.setPlatformSetting('hostinger.api_token', '');
}

/* ================================================================== */
/* Part B — HTTP: dormant honesty, settings, then the whole deploy     */
/* flow against the stub Hostinger API (purchase counted).             */
/* ================================================================== */

function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      // x-forwarded-proto: the app sits behind a TLS proxy in
      // production (proxy:true sessions + Secure cookie) — without
      // this header the harness's http requests never get a session
      // cookie issued (batch53 jar pattern).
      const headers = { 'x-forwarded-proto': 'https', 'content-type': 'application/json', ...(opts.headers || {}) };
      if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(url, { ...opts, headers });
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const sc of setCookies) {
        const pair = String(sc).split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return res;
    },
  };
}
async function json(res) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
}

async function partB() {
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  const deployCount = async () => {
    const rows = await db.query('SELECT COUNT(*) AS c FROM deployments');
    return Number(rows[0].c);
  };

  await new Promise((resolve) => stubServer.listen(STUB_PORT, '127.0.0.1', resolve));
  process.env.HOSTINGER_API_BASE = `http://127.0.0.1:${STUB_PORT}`;

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

    const totp = require(path.join(root, 'src/totp.js'));
    const jar = makeJar();
    const post = (p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
    const put = (p, body) => jar.fetch(BASE + p, { method: 'PUT', body: JSON.stringify(body || {}) });
    const get = (p) => jar.fetch(BASE + p);
    const pub = async (method, p, body) => {
      const res = await fetch(BASE + p, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await json(res) };
    };

    // Bootstrap super-admin session (Batch 40 flow: login → enroll → confirm).
    {
      let res = await post('/api/v1/auth/login', { email: process.env.BOOTSTRAP_EMAIL, password: process.env.BOOTSTRAP_PASSWORD });
      let body = await json(res);
      assert(res.status === 200 && body.data.mfaRequired === true && body.data.mfaStage === 'enroll', 'login parks at MFA enroll: ' + JSON.stringify(body));
      res = await post('/api/v1/auth/mfa/enroll/start', {});
      body = await json(res);
      const secret = body.data.secret;
      assert(secret, 'enroll secret issued');
      res = await post('/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(secret) });
      body = await json(res);
      assert(res.status === 200 && body.data.user, 'session issued');
    }
    check('staff session established for the bootstrap super admin', () => {});

    /* ---- dormant honesty: no token saved yet ---- */
    let L1 = null;
    await checkAsync('dormant: status reports unconfigured; test-connection refuses coded; nothing is bought', async () => {
      let res = await get('/api/v1/admin/settings/hostinger');
      let body = await json(res);
      assert.equal(res.status, 200);
      assert.equal(body.data.configured, false);
      assert.equal(body.data.tokenSet, false);
      assert.ok(body.data.missing.includes('hostinger.api_token'));
      assert.ok(!JSON.stringify(body).includes('test-token'), 'no token value anywhere in the status payload');
      res = await post('/api/v1/admin/settings/hostinger/test', {});
      body = await json(res);
      assert.equal(res.status, 400);
      assert.equal(errCode(body), 'HOSTINGER_NOT_CONFIGURED');
    });

    await checkAsync('landing submit creates the software-interest lead (the deploy target)', async () => {
      const r = await pub('POST', '/api/v1/landing/submit', {
        fullName: 'Grace Hopper',
        email: 'grace@example.invalid',
        phone: '+1 610-555-0117',
      });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      L1 = r.json.data.id;
      assert.ok(Number.isInteger(L1) && L1 > 0);
    });

    await checkAsync('dormant: the lead view is eligible-but-unconfigured and a start attempt is a coded no-op', async () => {
      let res = await get(`/api/v1/admin/leads/${L1}/hostinger-deployment?workspaceId=1`);
      let body = await json(res);
      assert.equal(res.status, 200);
      assert.equal(body.data.eligible, true);
      assert.equal(body.data.configured, false);
      assert.equal(body.data.deployment, null);
      res = await post(`/api/v1/admin/leads/${L1}/hostinger-deployment`, { workspaceId: 1 });
      body = await json(res);
      assert.equal(res.status, 400);
      assert.equal(errCode(body), 'HOSTINGER_NOT_CONFIGURED');
      assert.equal(await deployCount(), 0, 'no deployment row created');
      assert.equal(stub.purchases, 0, 'no purchase attempted');
    });

    /* ---- settings ---- */
    await checkAsync('settings: token + catalog defaults save; the status never echoes the token', async () => {
      let res = await put('/api/v1/admin/settings/secret', { key: 'hostinger.api_token', value: 'test-token-123' });
      assert.equal(res.status, 200, JSON.stringify(await json(res)));
      res = await put('/api/v1/admin/settings', {
        settings: { 'hostinger.default_price_id': PRICE_ID, 'hostinger.data_center_id': '5', 'hostinger.template_id': '9' },
      });
      let body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      res = await get('/api/v1/admin/settings/hostinger');
      body = await json(res);
      assert.equal(body.data.configured, true);
      assert.equal(body.data.tokenSet, true);
      assert.equal(body.data.defaultPriceId, PRICE_ID);
      assert.ok(!JSON.stringify(body).includes('test-token-123'), 'token never echoed');
    });

    await checkAsync('settings validation: bad data-center id and bad price id are coded 400s and change nothing', async () => {
      let res = await put('/api/v1/admin/settings', { settings: { 'hostinger.data_center_id': 'abc' } });
      let body = await json(res);
      assert.equal(res.status, 400);
      assert.equal(errCode(body), 'VALIDATION');
      res = await put('/api/v1/admin/settings', { settings: { 'hostinger.default_price_id': 'bad id!' } });
      body = await json(res);
      assert.equal(res.status, 400);
      assert.equal(errCode(body), 'VALIDATION');
      res = await get('/api/v1/admin/settings/hostinger');
      body = await json(res);
      assert.equal(body.data.dataCenterId, 5, 'previous good value kept');
      assert.equal(body.data.defaultPriceId, PRICE_ID);
    });

    await checkAsync('test connection: pings payment methods + catalog and reports the account shape', async () => {
      const res = await post('/api/v1/admin/settings/hostinger/test', {});
      const body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.ok, true);
      assert.equal(body.data.paymentMethods, 1);
      assert.equal(body.data.hasDefaultPaymentMethod, true);
      assert.equal(body.data.catalogPrices, 1);
    });

    /* ---- button-visibility rule ---- */
    await checkAsync('ordinary lead: not eligible, start refuses NOT_SOFTWARE_LEAD, nothing bought', async () => {
      const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
      const wdb = openWorkspaceDb(1);
      const info = wdb
        .prepare(
          "INSERT INTO leads (business_name, email, category, lead_group, source, tags) VALUES ('Ordinary Plumber', 'ord@example.invalid', 'Plumbing', 'Home services', 'manual', '[]')"
        )
        .run();
      const L2 = Number(info.lastInsertRowid);
      let res = await get(`/api/v1/admin/leads/${L2}/hostinger-deployment?workspaceId=1`);
      let body = await json(res);
      assert.equal(body.data.eligible, false);
      res = await post(`/api/v1/admin/leads/${L2}/hostinger-deployment`, { workspaceId: 1 });
      body = await json(res);
      assert.equal(res.status, 400);
      assert.equal(errCode(body), 'NOT_SOFTWARE_LEAD');
      assert.equal(stub.purchases, 0);
    });

    /* ---- confirm flow: price guard, exactly-once ---- */
    await checkAsync('preview shows the LIVE catalog price, data center and template', async () => {
      const res = await post(`/api/v1/admin/leads/${L1}/hostinger-deployment/preview`, { workspaceId: 1 });
      const body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.plan.priceCents, 1399);
      assert.equal(body.data.plan.firstPeriodPriceCents, 699);
      assert.equal(body.data.plan.currency, 'USD');
      assert.equal(body.data.plan.dataCenterId, 5);
      assert.equal(body.data.plan.templateId, 9);
      assert.equal(body.data.lead.email, 'grace@example.invalid');
    });

    await checkAsync('price moved since the confirmation → PRICE_CHANGED 409, zero purchases, zero rows', async () => {
      stub.price = 1499;
      stub.firstPrice = 799;
      const res = await post(`/api/v1/admin/leads/${L1}/hostinger-deployment`, {
        workspaceId: 1,
        confirmPriceCents: 1399,
        confirmFirstPeriodCents: 699,
      });
      const body = await json(res);
      assert.equal(res.status, 409, JSON.stringify(body));
      assert.equal(errCode(body), 'PRICE_CHANGED');
      assert.equal(stub.purchases, 0);
      assert.equal(await deployCount(), 0);
    });

    let dep1 = null;
    await checkAsync('confirm at the current price starts exactly one deployment (one script, one purchase)', async () => {
      stub.vmState = 'running';
      const res = await post(`/api/v1/admin/leads/${L1}/hostinger-deployment`, {
        workspaceId: 1,
        confirmPriceCents: 1499,
        confirmFirstPeriodCents: 799,
      });
      const body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      dep1 = body.data.deployment;
      assert.equal(dep1.status, 'queued');
      assert.equal(dep1.priceCents, 1499, 'the price actually confirmed is recorded');
      assert.equal(dep1.firstPeriodPriceCents, 799);
      const view = await waitFor('deployment reaches installing', async () => {
        const r = await get(`/api/v1/admin/leads/${L1}/hostinger-deployment?workspaceId=1`);
        const b = await json(r);
        return b.data.deployment && b.data.deployment.status === 'installing' ? b.data.deployment : null;
      });
      assert.equal(view.vmId, '4201');
      assert.equal(view.hostname, 'srv4201.hstgr.cloud');
      assert.equal(stub.purchases, 1, 'exactly one purchase');
      assert.equal(stub.scripts.length, 1, 'exactly one post-install script created');
      assert.ok(stub.setups >= 1, 'setup call ran for the initial VM');
    });

    await checkAsync('double-click / replay while active → 409 DEPLOYMENT_ACTIVE, still exactly one purchase', async () => {
      const res = await post(`/api/v1/admin/leads/${L1}/hostinger-deployment`, {
        workspaceId: 1,
        confirmPriceCents: 1499,
        confirmFirstPeriodCents: 799,
      });
      const body = await json(res);
      assert.equal(res.status, 409);
      assert.equal(errCode(body), 'DEPLOYMENT_ACTIVE');
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(stub.purchases, 1, 'no second purchase');
      assert.equal(await deployCount(), 1, 'no second deployment row');
    });

    /* ---- bundle + callback ---- */
    const scriptContent = () => stub.scripts[0].content;
    await checkAsync('bundle: the VM token downloads a gzip of the app source; a wrong token is a plain 404', async () => {
      const m = scriptContent().match(/bundle\?token=([0-9a-f]{64})/);
      assert.ok(m, 'bundle token present in the install script');
      const res = await fetch(`${BASE}/api/v1/hostinger-deploy/bundle?token=${m[1]}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /gzip/);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.ok(buf.length > 10000, 'bundle carries the source tree');
      assert.equal(buf[0], 0x1f);
      assert.equal(buf[1], 0x8b);
      const bad = await fetch(`${BASE}/api/v1/hostinger-deploy/bundle?token=${'0'.repeat(64)}`);
      assert.equal(bad.status, 404);
    });

    await checkAsync('callback: a wrong secret is refused and changes nothing', async () => {
      const r = await pub('POST', '/api/v1/hostinger-deploy/callback', {
        deploymentId: dep1.id,
        secret: 'f'.repeat(64),
        status: 'ready',
        instance_url: 'https://srv4201.hstgr.cloud',
        setup_token: 'cd'.repeat(24),
      });
      assert.equal(r.status, 403);
      assert.equal(errCode(r.json), 'CALLBACK_AUTH');
      const res = await get(`/api/v1/admin/leads/${L1}/hostinger-deployment?workspaceId=1`);
      const body = await json(res);
      assert.equal(body.data.deployment.status, 'installing', 'still installing');
    });

    const SETUP_TOKEN = 'cd'.repeat(24);
    await checkAsync('callback ready: deployment flips ready; only the token HASH is stored; mail failure is a warning, not a failure', async () => {
      const m = scriptContent().match(/"secret":"([0-9a-f]{64})"/);
      assert.ok(m, 'callback secret present in the install script');
      const r = await pub('POST', '/api/v1/hostinger-deploy/callback', {
        deploymentId: dep1.id,
        secret: m[1],
        status: 'ready',
        instance_url: 'https://srv4201.hstgr.cloud',
        setup_token: SETUP_TOKEN,
      });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.ok, true);
      const res = await get(`/api/v1/admin/leads/${L1}/hostinger-deployment?workspaceId=1`);
      const body = await json(res);
      const dep = body.data.deployment;
      assert.equal(dep.status, 'ready');
      assert.equal(dep.instanceUrl, 'https://srv4201.hstgr.cloud');
      assert.equal(dep.emailSentAt, null, 'no SMTP configured in the fixture — no send recorded');
      assert.ok(String(dep.warning).includes('Setup email could not be sent'), 'mail failure recorded as a warning: ' + dep.warning);
      const rows = await db.query('SELECT * FROM deployments WHERE id = :id', { id: dep1.id });
      assert.equal(rows[0].setup_token_hash, sha256(SETUP_TOKEN), 'hash stored');
      assert.ok(!JSON.stringify(rows[0]).includes(SETUP_TOKEN), 'raw setup token nowhere in the row');
      assert.ok(rows[0].setup_expires_at, 'setup expiry recorded');
      assert.ok(!JSON.stringify(rows[0]).includes(m[1]), 'raw callback secret nowhere in the row');
    });

    await checkAsync('callback replay after ready: idempotent, no state change', async () => {
      const m = scriptContent().match(/"secret":"([0-9a-f]{64})"/);
      const r = await pub('POST', '/api/v1/hostinger-deploy/callback', {
        deploymentId: dep1.id,
        secret: m[1],
        status: 'ready',
        instance_url: 'https://srv4201.hstgr.cloud',
        setup_token: SETUP_TOKEN,
      });
      assert.equal(r.status, 200);
      assert.equal(r.json.already, true);
    });

    await checkAsync('retry is refused unless the latest deployment failed', async () => {
      const res = await post(`/api/v1/admin/leads/${L1}/hostinger-deployment/retry`, { workspaceId: 1 });
      const body = await json(res);
      assert.equal(res.status, 400);
      assert.equal(errCode(body), 'NOT_RETRYABLE');
    });

    /* ---- provisioning timeout + retry ---- */
    await checkAsync('provisioning timeout: fails coded with the VM id preserved; retry from failed buys exactly once more', async () => {
      const sub = await pub('POST', '/api/v1/landing/submit', {
        fullName: 'Alan Turing',
        email: 'alan@example.invalid',
        phone: '+1 610-555-0142',
      });
      const L3 = sub.json.data.id;
      stub.vmState = 'creating';
      let res = await post(`/api/v1/admin/leads/${L3}/hostinger-deployment/preview`, { workspaceId: 1 });
      let body = await json(res);
      const price = body.data.plan;
      res = await post(`/api/v1/admin/leads/${L3}/hostinger-deployment`, {
        workspaceId: 1,
        confirmPriceCents: price.priceCents,
        confirmFirstPeriodCents: price.firstPeriodPriceCents,
      });
      body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      const depId = body.data.deployment.id;
      const prov = await waitFor('deployment reaches provisioning with its VM id recorded', async () => {
        const r = await get(`/api/v1/admin/leads/${L3}/hostinger-deployment?workspaceId=1`);
        const b = await json(r);
        return b.data.deployment && b.data.deployment.status === 'provisioning' && b.data.deployment.vmId ? b.data.deployment : null;
      });
      assert.equal(prov.vmId, '4202');
      assert.equal(stub.purchases, 2);
      // Age the deployment past the provisioning deadline; the ticker
      // must fail it honestly, VM id intact.
      await db.query("UPDATE deployments SET created_at = datetime('now', '-26 minutes') WHERE id = :id", { id: depId });
      const failed = await waitFor('deployment fails with PROVISION_TIMEOUT', async () => {
        const r = await get(`/api/v1/admin/leads/${L3}/hostinger-deployment?workspaceId=1`);
        const b = await json(r);
        return b.data.deployment && b.data.deployment.status === 'failed' ? b.data.deployment : null;
      });
      assert.equal(failed.errorCode, 'PROVISION_TIMEOUT');
      assert.equal(failed.vmId, '4202', 'VM id preserved for hPanel cleanup');
      assert.ok(String(failed.errorDetail).includes('4202'), 'detail names the VM');
      // Retry from failed: a NEW deployment, exactly one more purchase.
      stub.vmState = 'running';
      res = await post(`/api/v1/admin/leads/${L3}/hostinger-deployment/preview`, { workspaceId: 1 });
      body = await json(res);
      const price2 = body.data.plan;
      res = await post(`/api/v1/admin/leads/${L3}/hostinger-deployment/retry`, {
        workspaceId: 1,
        confirmPriceCents: price2.priceCents,
        confirmFirstPeriodCents: price2.firstPeriodPriceCents,
      });
      body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.notEqual(body.data.deployment.id, depId, 'retry is a new deployment row');
      const inst = await waitFor('retry reaches installing', async () => {
        const r = await get(`/api/v1/admin/leads/${L3}/hostinger-deployment?workspaceId=1`);
        const b = await json(r);
        return b.data.deployment && b.data.deployment.status === 'installing' ? b.data.deployment : null;
      });
      assert.equal(inst.vmId, '4203');
      assert.equal(stub.purchases, 3, 'exactly one purchase per attempt');
      const oldRows = await db.query('SELECT status FROM deployments WHERE id = :id', { id: depId });
      assert.equal(oldRows[0].status, 'failed', 'the failed attempt stays on record');
    });
  } finally {
    if (process.env.B59_DEBUG_CHILD === '1') {
      console.error('--- child output tail ---\n' + output.split('\n').slice(-40).join('\n'));
    }
    child.kill('SIGTERM');
    await closed;
    stubServer.close();
  }
}

/* ================================================================== */
/* Part C — state machine units in-process (client + mailer stubbed   */
/* at the module seam; the same temp platform DB Part B populated).    */
/* ================================================================== */

let negativeShimPath = null;
function loadDeploy() {
  if (!NEGATIVE) return require(path.join(root, 'server/hostingerDeploy.js'));
  // Pre-fix shim: the purchase step is reachable from 'provisioning'
  // as well as 'queued', so a re-advance buys AGAIN — the exact
  // double-purchase bug the guard exists to prevent. Written as a
  // sibling of the real module so its relative requires resolve
  // identically; removed in main()'s finally.
  const src = fs.readFileSync(path.join(root, 'server/hostingerDeploy.js'), 'utf8');
  const marker = "if (dep.status === 'queued') return stepPurchase(dep);";
  assert(src.includes(marker), 'shim marker not found in server/hostingerDeploy.js');
  const shimmed = src.replace(
    marker,
    "if (dep.status === 'queued' || dep.status === 'provisioning') return stepPurchase(dep); // B59_NEGATIVE pre-fix shim"
  );
  negativeShimPath = path.join(root, 'server/.b59-negative-hostingerDeploy.js');
  fs.writeFileSync(negativeShimPath, shimmed);
  return require(negativeShimPath);
}

async function partC() {
  const db = require(path.join(root, 'server/db.js'));
  const realClient = require(path.join(root, 'server/hostingerClient.js'));
  const deploy = loadDeploy();

  const stubClient = {
    purchases: 0,
    getCatalog: async () => [
      {
        id: 'hostingercom-vps-kvm2',
        name: 'KVM 2',
        prices: [
          { id: PRICE_ID, name: '1 month', currency: 'USD', price: 1499, first_period_price: 799, period: 1, period_unit: 'month' },
        ],
      },
    ],
    findCatalogPrice: (items, id) => realClient.findCatalogPrice(items, id),
    listPaymentMethods: async () => [{ id: 7, name: 'Visa •• 4242', is_default: true }],
    listVirtualMachines: async () => [],
    getVirtualMachine: async (id) => ({
      id: Number(id),
      subscription_id: 'sub-' + id,
      plan: 'KVM 2',
      hostname: `srv${id}.hstgr.cloud`,
      state: 'running',
      ipv4: [{ address: '203.0.113.10' }],
    }),
    purchaseVirtualMachine: async () => {
      stubClient.purchases += 1;
      const id = 4300 + stubClient.purchases;
      return {
        status: 200,
        paymentProcessing: false,
        order: { id: 9500 + stubClient.purchases, subscription_id: 'sub-' + id },
        virtualMachine: {
          id,
          subscription_id: 'sub-' + id,
          plan: 'KVM 2',
          hostname: `srv${id}.hstgr.cloud`,
          state: 'running',
          ipv4: [{ address: '203.0.113.10' }],
        },
        raw: {},
      };
    },
    setupVirtualMachine: async () => ({}),
    createPostInstallScript: async () => ({ id: 777 }),
    firstIpv4: (vm) => realClient.firstIpv4(vm),
  };
  deploy.__setClientForTests(stubClient);

  const sentMail = [];
  let mailerThrows = false;
  deploy.__setMailerForTests(async (args) => {
    if (mailerThrows) {
      const e = new Error('No SMTP server is configured — set an SMTP host first.');
      e.code = 'SMTP_NOT_CONFIGURED';
      throw e;
    }
    sentMail.push(args);
    return { messageId: 'unit-1' };
  });

  async function insertDeployment(patch) {
    const base = {
      ws: 1,
      lead: 9001,
      email: 'unit@example.invalid',
      status: 'installing',
      priceId: PRICE_ID,
      planName: 'KVM 2',
      priceCents: 1499,
      firstPeriod: 799,
      currency: 'USD',
      cbHash: sha256('unit-secret'),
      bundleHash: sha256('unit-bundle'),
      activeKey: null,
      actor: null,
    };
    const v = { ...base, ...(patch || {}) };
    const r = await db.query(
      `INSERT INTO deployments
        (workspace_id, lead_id, lead_email, status, plan_item_id, plan_name, price_cents,
         first_period_price_cents, currency, admin_email, callback_secret_hash,
         bundle_token_hash, active_lead_key, created_by, hostinger_vm_id, hostname)
       VALUES (:ws, :lead, :email, :status, :priceId, :planName, :priceCents,
         :firstPeriod, :currency, :email, :cbHash, :bundleHash, :activeKey, :actor,
         :vmId, :hostname)`,
      {
        ws: v.ws,
        lead: v.lead,
        email: v.email,
        status: v.status,
        priceId: v.priceId,
        planName: v.planName,
        priceCents: v.priceCents,
        firstPeriod: v.firstPeriod,
        currency: v.currency,
        cbHash: v.cbHash,
        bundleHash: v.bundleHash,
        activeKey: v.activeKey,
        actor: v.actor,
        vmId: v.vmId || null,
        hostname: v.hostname || null,
      }
    );
    return Number(r.insertId);
  }
  const rowOf = async (id) => (await db.query('SELECT * FROM deployments WHERE id = :id', { id }))[0];

  await checkAsync('state machine: a queued deployment purchases once; re-advancing NEVER re-buys', async () => {
    const id = await insertDeployment({ status: 'queued', lead: 9002 });
    await deploy.advanceDeployment(id);
    assert.equal(stubClient.purchases, 1, 'one purchase from queued');
    let row = await rowOf(id);
    assert.equal(row.status, 'installing', 'stub VM runs → installing');
    await deploy.advanceDeployment(id);
    await deploy.advanceDeployment(id);
    assert.equal(stubClient.purchases, 1, 'ZERO further purchases on re-advance');
    row = await rowOf(id);
    assert.equal(row.status, 'installing');
  });

  await checkAsync('resume honesty: provisioning with a lost purchase outcome fails PURCHASE_OUTCOME_UNKNOWN, never re-buys', async () => {
    const id = await insertDeployment({ status: 'provisioning', lead: 9003 });
    await db.query("UPDATE deployments SET purchase_started_at = datetime('now', '-10 minutes') WHERE id = :id", { id });
    const before = stubClient.purchases;
    await deploy.advanceDeployment(id);
    const row = await rowOf(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.error_code, 'PURCHASE_OUTCOME_UNKNOWN');
    assert.equal(stubClient.purchases, before, 'no blind re-purchase');
  });

  await checkAsync('ready callback: setup email fires exactly once with the one-time link; replay sends nothing', async () => {
    const id = await insertDeployment({ status: 'installing', lead: 9004, vmId: '4401', hostname: 'srv4401.hstgr.cloud' });
    const token = 'ef'.repeat(24);
    const out = await deploy.handleCallback({
      deploymentId: id,
      secret: 'unit-secret',
      status: 'ready',
      instance_url: 'https://srv4401.hstgr.cloud',
      setup_token: token,
    });
    assert.equal(out.already, false);
    assert.equal(sentMail.length, 1, 'exactly one email');
    assert.equal(sentMail[0].to, 'unit@example.invalid');
    assert.equal(sentMail[0].cta.url, `https://srv4401.hstgr.cloud/app#/reset/${token}`, 'setup link = instance + reset path + raw token, once');
    let row = await rowOf(id);
    assert.equal(row.status, 'ready');
    assert.ok(row.email_sent_at, 'send recorded on the deployment');
    assert.equal(row.setup_token_hash, sha256(token));
    const replay = await deploy.handleCallback({
      deploymentId: id,
      secret: 'unit-secret',
      status: 'ready',
      instance_url: 'https://srv4401.hstgr.cloud',
      setup_token: token,
    });
    assert.equal(replay.already, true);
    assert.equal(sentMail.length, 1, 'no second email on replay');
    row = await rowOf(id);
    assert.equal(row.status, 'ready');
  });

  await checkAsync('ready callback with a failing mailer: deployment stays ready, warning recorded', async () => {
    mailerThrows = true;
    try {
      const id = await insertDeployment({ status: 'installing', lead: 9005, vmId: '4402', hostname: 'srv4402.hstgr.cloud' });
      await deploy.handleCallback({
        deploymentId: id,
        secret: 'unit-secret',
        status: 'ready',
        instance_url: 'https://srv4402.hstgr.cloud',
        setup_token: 'ab'.repeat(24),
      });
      const row = await rowOf(id);
      assert.equal(row.status, 'ready', 'mail failure never marks the deployment failed');
      assert.equal(row.email_sent_at, null);
      assert.ok(String(row.warning).includes('Setup email could not be sent'), 'warning: ' + row.warning);
    } finally {
      mailerThrows = false;
    }
  });

  await checkAsync('failed callback from the install script lands INSTALL_FAILED with the stage named', async () => {
    const id = await insertDeployment({ status: 'installing', lead: 9006, vmId: '4403', hostname: 'srv4403.hstgr.cloud' });
    await deploy.handleCallback({ deploymentId: id, secret: 'unit-secret', status: 'failed', error: 'compose-up' });
    const row = await rowOf(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.error_code, 'INSTALL_FAILED');
    assert.ok(String(row.error_detail).includes('compose-up'));
    assert.ok(String(row.error_detail).includes('4403'), 'VM id in the detail for cleanup');
  });

  await checkAsync('token-missing start: coded HOSTINGER_NOT_CONFIGURED, no row, no purchase', async () => {
    const platform = require(path.join(root, 'server/platform.js'));
    const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
    const wdb = openWorkspaceDb(1);
    const leadRow = wdb.prepare("SELECT id FROM leads WHERE email = 'grace@example.invalid'").get();
    assert.ok(leadRow, 'the Part B software lead exists');
    await platform.setPlatformSetting('hostinger.api_token', '');
    const countRows = async () => Number((await db.query('SELECT COUNT(*) AS c FROM deployments'))[0].c);
    const rowsBefore = await countRows();
    const purchasesBefore = stubClient.purchases;
    await assert.rejects(
      () =>
        deploy.startDeployment({
          workspaceId: 1,
          leadId: Number(leadRow.id),
          actorUserId: null,
          confirmPriceCents: null,
          confirmFirstPeriodCents: null,
        }),
      (e) => e.code === 'HOSTINGER_NOT_CONFIGURED'
    );
    assert.equal(await countRows(), rowsBefore, 'no deployment row created');
    assert.equal(stubClient.purchases, purchasesBefore, 'no purchase');
  });

  deploy.__setClientForTests(null);
  deploy.__setMailerForTests(null);
}

/* ================================================================== */

async function main() {
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  try {
    partA();
    await partAClient();
    await partB();
    await partC();
  } finally {
    if (negativeShimPath) {
      try {
        fs.unlinkSync(negativeShimPath);
      } catch {}
    }
  }
  console.log(JSON.stringify({ batch59: true, checks: results.length, passed: true }));
  for (const name of results) console.log('  ✓ ' + name);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
