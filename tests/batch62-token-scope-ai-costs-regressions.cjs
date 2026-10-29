'use strict';
/**
 * Batch 62 — token read-scope fix (expert review E-3, the last open
 * item) + per-workspace AI cost view.
 *
 *   READ-SCOPE — the ws_ workspace bearer token could READ staff money
 *   and PII surfaces. Closed here with the Batch 53 gate
 *   (requireRole('owner','admin') → token actors get 403
 *   TOKEN_ROLE_DENIED):
 *     GET /admin-area/finance/summary | ledger | export.csv
 *     GET /admin-area/domain-transactions (+ /:id)
 *     GET /admin-area/leadscout/contacts (+ /:id)
 *     GET /admin-area/calls | calls/pool | calls/numbers/available
 *     GET /admin-area/forms/:id/submissions
 *     GET /admin-area/bookings, /admin-area/shop,
 *     GET /admin-area/memberships, /admin-area/rentals (+ /:id)
 *   And GET /settings is SPLIT: the domain.registrant_* block (name,
 *   organisation, email, phone, street address) returns only to
 *   sessions; token callers keep every other setting.
 *
 *   DELIBERATELY LEFT token-readable (operational contract — the MCP
 *   facade and the lead-hunt/site-build jobs run on this token):
 *   leads/design/websites/campaigns/templates/suppression reads,
 *   /dashboard/stats (aggregates), /activity, /prompts, /providers,
 *   /hands-off status, /cloudflare (masked config), /domains reads,
 *   /ai/usage + /ai/status (the workspace's OWN usage — budget checks
 *   read it), admin-area list surfaces with no money/PII (forms list,
 *   modules, courses, analytics, seo). The MCP facade itself calls the
 *   domain layer in-process, never these REST routes (pinned below).
 *
 *   AI COST VIEW — GET /admin-area/finance/ai-by-workspace: owner/admin
 *   session AND super-admin only; finance.aiUsageByWorkspace sums each
 *   tenant DB's ai_usage with the same aiSpend math as the Batch 49
 *   summary; zero-usage workspaces render as 0 rows. The Finance page
 *   renders the section when the endpoint answers (super-admins).
 *
 *   NEGATIVE PROOF: B62_NEGATIVE=1 un-guards the finance/ledger route
 *   on disk before booting; the token then reads it (200) — the gate
 *   is load-bearing. The file is restored in a finally.
 *
 * Harness: engine checks on an in-process platform DB + HTTP against
 * the real server booted on the same temp DB (batch53 pattern).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b62-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch62', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 11).toString('base64');

const NEGATIVE = process.env.B62_NEGATIVE === '1';
const PORT = 31462;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = ['batch62', 'fixture', 'password'].join('-');
const OCT = { preset: 'custom', from: '2026-10-01', to: '2026-10-31' };

const results = [];
function check(name, fn) {
  if (typeof fn === 'function') fn();
  else assert(fn, name);
  results.push(name);
}
async function acheck(name, fn) {
  await fn();
  results.push(name);
}

const platformDb = require(path.join(root, 'server/db.js'));
const q = platformDb.query;

function seedAiUsage(wsId, rows) {
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const db = openWorkspaceDb(wsId);
  const ins = db.prepare(
    'INSERT INTO ai_usage (task, model, prompt_tokens, completion_tokens, cost_usd, at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) ins.run(r.task || 'copy', r.model || 'gpt-x', r.pt, r.ct, r.usd, r.at);
}

/* ==================================================================== */
/* Part A — AI cost view, engine level                                   */
/* ==================================================================== */

let WS_A, WS_B, WS_C;
async function partA() {
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const finance = require(path.join(root, 'server/finance.js'));
  const domain = require(path.join(root, 'server/domain.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));

  const a = await workspace.createUserWithWorkspace({ email: 'a62@example.invalid', password: PW, name: 'A62', workspaceName: 'Alpha AI' });
  const b = await workspace.createUserWithWorkspace({ email: 'b62@example.invalid', password: PW, name: 'B62', workspaceName: 'Beta AI' });
  const c = await workspace.createUserWithWorkspace({ email: 'c62@example.invalid', password: PW, name: 'C62', workspaceName: 'Gamma AI' });
  WS_A = Number(a.workspaceId); WS_B = Number(b.workspaceId); WS_C = Number(c.workspaceId);

  seedAiUsage(WS_A, [
    { pt: 100, ct: 50, usd: 0.10, at: '2026-10-10 10:00:00' },
    { pt: 200, ct: 100, usd: 0.25, at: '2026-10-20 10:00:00' },
    { pt: 999, ct: 999, usd: 9.99, at: '2026-09-15 10:00:00' }, // out of period
  ]);
  seedAiUsage(WS_B, [{ pt: 1000, ct: 500, usd: 1.0, at: '2026-10-05 09:00:00' }]);

  await acheck('A1: aiUsageByWorkspace sums match seeded rows per workspace; zero-usage workspace shows 0', async () => {
    const period = finance.resolvePeriod(OCT);
    const out = finance.aiUsageByWorkspace(
      period,
      [
        { id: WS_A, name: 'Alpha AI' },
        { id: WS_B, name: 'Beta AI' },
        { id: WS_C, name: 'Gamma AI' },
      ],
      (id) => openWorkspaceDb(id)
    );
    const byId = Object.fromEntries(out.rows.map((r) => [r.workspaceId, r]));
    assert.equal(byId[WS_A].cents, 35);
    assert.equal(byId[WS_A].calls, 2);
    assert.equal(byId[WS_A].tokens, 450);
    assert.equal(byId[WS_B].cents, 100);
    assert.equal(byId[WS_B].calls, 1);
    assert.equal(byId[WS_B].tokens, 1500);
    assert.equal(byId[WS_C].cents, 0);
    assert.equal(byId[WS_C].calls, 0);
    assert.equal(byId[WS_C].estimated, true);
    assert.equal(out.totals.cents, 135);
    assert.equal(out.totals.calls, 3);
    assert.equal(out.totals.tokens, 1950);
  });

  await acheck('A2: period filter is load-bearing (September sees only the September row)', async () => {
    const period = finance.resolvePeriod({ preset: 'custom', from: '2026-09-01', to: '2026-09-30' });
    const out = finance.aiUsageByWorkspace(period, [{ id: WS_A, name: 'Alpha AI' }], (id) => openWorkspaceDb(id));
    assert.equal(out.rows[0].cents, 999);
    assert.equal(out.rows[0].calls, 1);
  });

  await acheck('A3: domain.financeAiByWorkspace enumerates ALL server-DB workspaces', async () => {
    const out = await domain.financeAiByWorkspace(OCT);
    const ids = out.rows.map((r) => r.workspaceId);
    assert(ids.includes(WS_A) && ids.includes(WS_B) && ids.includes(WS_C), `rows: ${ids}`);
    const byId = Object.fromEntries(out.rows.map((r) => [r.workspaceId, r]));
    assert.equal(byId[WS_A].cents, 35);
    assert.equal(byId[WS_B].cents, 100);
    assert.equal(byId[WS_C].cents, 0);
    assert.equal(out.period.from, '2026-10-01');
    assert.equal(out.period.to, '2026-10-31');
  });
}

/* ==================================================================== */
/* Part B — structural pins                                              */
/* ==================================================================== */

const CLOSED_ROUTES = [
  '/admin-area/finance/summary',
  '/admin-area/finance/ledger',
  '/admin-area/finance/export.csv',
  '/admin-area/finance/ai-by-workspace',
  '/admin-area/domain-transactions',
  '/admin-area/domain-transactions/:id',
  '/admin-area/leadscout/contacts',
  '/admin-area/leadscout/contacts/:id',
  '/admin-area/calls',
  '/admin-area/calls/numbers/available',
  '/admin-area/calls/pool',
  '/admin-area/forms/:id/submissions',
  '/admin-area/bookings',
  '/admin-area/shop',
  '/admin-area/memberships',
  '/admin-area/rentals',
  '/admin-area/rentals/:id',
];

function partB() {
  const api = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
  check('B1: every closed route carries requireRole(owner, admin) on its GET line', () => {
    const lines = api.split('\n');
    for (const route of CLOSED_ROUTES) {
      const line = lines.find((l) => l.includes(`router.get('${route}'`));
      assert(line, `route not found: ${route}`);
      assert(line.includes("requireRole('owner', 'admin')"), `route not gated: ${route} → ${line.trim()}`);
    }
  });
  check('B2: settings split strips domain.registrant_* for token actors only', () => {
    assert(api.includes("req.auth.via === 'token'"));
    assert(api.includes("k.startsWith('domain.registrant_')"));
  });
  check('B3: ai-by-workspace is super-admin gated in the route', () => {
    assert(api.includes('SUPER_ADMIN_REQUIRED'));
    assert(api.includes('domain.financeAiByWorkspace(req.query)'));
  });
  check('B4: engine + facade exports exist; MCP facade never rides the REST admin-area', () => {
    const finance = require(path.join(root, 'server/finance.js'));
    assert.equal(typeof finance.aiUsageByWorkspace, 'function');
    const domain = require(path.join(root, 'server/domain.js'));
    assert.equal(typeof domain.financeAiByWorkspace, 'function');
    const mcp = fs.readFileSync(path.join(root, 'server/mcp.js'), 'utf8');
    assert(!mcp.includes('admin-area'), 'MCP facade must stay on the domain layer');
  });
  check('B5: Finance page renders the by-workspace section from the new endpoint', () => {
    const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert(app.includes('AI usage by workspace'));
    assert(app.includes('api.financeAiByWorkspace(periodQ)'));
    const apiJs = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    assert(apiJs.includes("financeAiByWorkspace: (q) => get('/admin-area/finance/ai-by-workspace', q)"));
  });
}

/* ==================================================================== */
/* Part C — HTTP against the booted server                               */
/* ==================================================================== */

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
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function partC() {
  const workspace = require(path.join(root, 'server/workspace.js'));
  const domain = require(path.join(root, 'server/domain.js'));
  const bcrypt = require('bcryptjs');
  const totp = require(path.join(root, 'src/totp.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));

  // Super-admin owner of WS_A (Part A workspace), plain owner of WS_B,
  // member of WS_A, tokens, registrant + usage fixtures.
  const aUser = await workspace.findUserByEmail('a62@example.invalid');
  await q('UPDATE users SET is_super_admin = 1 WHERE id = :id', { id: aUser.id });
  const { token: WS_TOKEN } = await workspace.createWorkspaceToken(WS_A, 'batch62-test');
  const memberIns = await q(
    'INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 0, :s)',
    { e: 'member62@example.invalid', h: bcrypt.hashSync(PW, 12), n: 'Member62', s: 'active' }
  );
  await q('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (:w, :u, :r)', {
    w: WS_A, u: Number(memberIns.insertId), r: 'member',
  });
  try {
    domain.settingsSet(WS_A, 'domain.registrant_email', 'registrant62@example.invalid');
    domain.settingsSet(WS_A, 'domain.registrant_first_name', 'Reggie');
  } catch {
    const db = openWorkspaceDb(WS_A);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('domain.registrant_email', 'registrant62@example.invalid');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('domain.registrant_first_name', 'Reggie');
  }

  // NEGATIVE: un-guard the ledger route on disk before the child boots.
  const apiPath = path.join(root, 'server/routes/domainApi.js');
  const apiOrig = fs.readFileSync(apiPath, 'utf8');
  if (NEGATIVE) {
    const guarded = "router.get('/admin-area/finance/ledger', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {";
    assert(apiOrig.includes(guarded), 'negative shim marker not found');
    fs.writeFileSync(apiPath, apiOrig.replace(guarded, "router.get('/admin-area/finance/ledger', denyLeadScopedToken, (req, res) => {"));
  }

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

    const asToken = (p) => fetch(BASE + p, { headers: { authorization: `Bearer ${WS_TOKEN}` } });
    const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
    async function enrollSession(email) {
      const jar = makeJar();
      let res = await post(jar, '/api/v1/auth/login', { email, password: PW });
      let body = await json(res);
      assert(res.status === 200 && body.data.mfaRequired === true, `login challenge for ${email}`);
      res = await post(jar, '/api/v1/auth/mfa/enroll/start', {});
      body = await json(res);
      const secret = body.data.secret;
      assert(secret, 'enroll start returns a secret');
      res = await post(jar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(secret) });
      body = await json(res);
      assert(res.status === 200 && body.data.user, `session for ${email}`);
      return jar;
    }
    const superJar = await enrollSession('a62@example.invalid');
    const plainJar = await enrollSession('b62@example.invalid');
    const memberJar = await enrollSession('member62@example.invalid');
    const get = (jar, p) => jar.fetch(BASE + p);
    check('C0: sessions established (super owner / plain owner / member)', () => {});

    await acheck(
      NEGATIVE
        ? 'C1 (NEGATIVE PROOF): un-guarded ledger route → token reads it (200)'
        : 'C1: token 403 matrix on every closed route',
      async () => {
        const paths = [
          '/api/v1/admin-area/finance/summary',
          '/api/v1/admin-area/finance/ledger',
          '/api/v1/admin-area/finance/export.csv',
          '/api/v1/admin-area/finance/ai-by-workspace',
          '/api/v1/admin-area/domain-transactions',
          '/api/v1/admin-area/domain-transactions/1',
          '/api/v1/admin-area/leadscout/contacts',
          '/api/v1/admin-area/leadscout/contacts/1',
          '/api/v1/admin-area/calls',
          '/api/v1/admin-area/calls/pool',
          '/api/v1/admin-area/calls/numbers/available',
          '/api/v1/admin-area/forms/1/submissions',
          '/api/v1/admin-area/bookings',
          '/api/v1/admin-area/shop',
          '/api/v1/admin-area/memberships',
          '/api/v1/admin-area/rentals',
          '/api/v1/admin-area/rentals/1',
        ];
        for (const p of paths) {
          const res = await asToken(p);
          const body = await json(res);
          if (NEGATIVE && p.endsWith('/finance/ledger')) {
            assert.equal(res.status, 200, `negative proof expects the un-guarded ledger to answer 200, got ${res.status}`);
            continue;
          }
          assert.equal(res.status, 403, `${p} → ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
          assert.equal(body.code, 'TOKEN_ROLE_DENIED', `${p} code`);
        }
      }
    );

    await acheck('C2: owner/admin sessions read the closed surfaces (200s)', async () => {
      for (const p of [
        '/api/v1/admin-area/finance/summary',
        '/api/v1/admin-area/finance/ledger',
        '/api/v1/admin-area/domain-transactions',
        '/api/v1/admin-area/leadscout/contacts',
        '/api/v1/admin-area/calls',
        '/api/v1/admin-area/bookings',
        '/api/v1/admin-area/rentals',
      ]) {
        const res = await get(superJar, p);
        assert.equal(res.status, 200, `${p} → ${res.status}`);
      }
      const csv = await get(superJar, '/api/v1/admin-area/finance/export.csv');
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get('content-type') || '', /text\/csv/);
    });

    await acheck('C3: member session is refused the finance reads (role gate, not token gate)', async () => {
      const res = await get(memberJar, '/api/v1/admin-area/finance/summary');
      const body = await json(res);
      assert.equal(res.status, 403);
      assert.equal(body.error, 'FORBIDDEN');
      assert(!body.code, 'session role denial carries no token code');
    });

    await acheck('C4: AI cost view — super-admin 200 with the seeded sums; plain owner 403 SUPER_ADMIN_REQUIRED', async () => {
      const res = await get(superJar, '/api/v1/admin-area/finance/ai-by-workspace?preset=custom&from=2026-10-01&to=2026-10-31');
      const body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body).slice(0, 200));
      const byId = Object.fromEntries(body.data.rows.map((r) => [r.workspaceId, r]));
      assert.equal(byId[WS_A].cents, 35);
      assert.equal(byId[WS_B].cents, 100);
      assert.equal(byId[WS_C].cents, 0);
      assert.equal(body.data.totals.cents, 135);
      const res2 = await get(plainJar, '/api/v1/admin-area/finance/ai-by-workspace');
      const body2 = await json(res2);
      assert.equal(res2.status, 403);
      assert.equal(body2.code, 'SUPER_ADMIN_REQUIRED');
    });

    await acheck('C5: settings split — token loses the registrant block, session keeps it', async () => {
      const tRes = await asToken('/api/v1/settings');
      const tBody = await json(tRes);
      assert.equal(tRes.status, 200);
      const tKeys = Object.keys(tBody.data.settings || {});
      assert(tKeys.length > 10, 'token still receives the operational settings');
      assert(!tKeys.some((k) => k.startsWith('domain.registrant_')), `registrant leaked: ${tKeys.filter((k) => k.startsWith('domain.registrant_'))}`);
      const sRes = await get(superJar, '/api/v1/settings');
      const sBody = await json(sRes);
      assert.equal(sRes.status, 200);
      assert.equal(sBody.data.settings['domain.registrant_email'], 'registrant62@example.invalid');
    });

    await acheck('C6: control routes the token SHOULD read still read (no over-blocking)', async () => {
      for (const p of ['/api/v1/leads', '/api/v1/dashboard/stats', '/api/v1/ai/usage', '/api/v1/websites']) {
        const res = await asToken(p);
        assert.equal(res.status, 200, `${p} → ${res.status}`);
      }
    });

    await acheck('C7: MCP facade path (domain layer, in-process) is unaffected by the route gates', async () => {
      const sum = domain.financeSummary(WS_A, OCT);
      assert(sum && sum.categories && sum.categories.ai, 'facade financeSummary still works');
      const settings = domain.settingsGetAll(WS_A);
      assert.equal(settings['domain.registrant_email'], 'registrant62@example.invalid', 'engine read keeps the registrant block — the split is route-only');
      const contacts = domain.adminLeadScoutContacts(WS_A, {});
      assert(contacts != null, 'facade LeadScout contacts still work');
    });
  } finally {
    child.kill('SIGKILL');
    await closed;
    if (NEGATIVE) fs.writeFileSync(apiPath, apiOrig);
  }
}

(async () => {
  try {
    await partA();
    partB();
    await partC();
    console.log(JSON.stringify({ file: 'batch62-token-scope-ai-costs-regressions', checks: results.length, passed: true }));
    for (const r of results) console.log('  ok -', r);
  } catch (e) {
    console.error('BATCH62 FAILED:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
