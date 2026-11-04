'use strict';
/**
 * Batch 84 — "Agent SOUL.md" page in the client portal (Ely, 2026-10-30:
 * "Write out your soul.md only for the bitpype app. People will need to
 * add this to their agent before using bitpype. Add it as a page to the
 * user portal.").
 *
 * The document ships VERBATIM as one server-side source file
 * (server/agent-soul.md — sha256 pinned below so the served bytes can
 * never drift from the approved copy). The portal gains a 'soul' tab
 * (Batch 29 registry): owner + partner factory defaults include it,
 * renters keep exactly [website, modules, rentals] and the API guard
 * 403s them. Routes: GET /agent-soul (rendered HTML + raw markdown)
 * and GET /agent-soul/download (attachment), both behind requireClient
 * + portalTabGuard via PORTAL_ROUTE_TABS ['/agent-soul' → 'soul'].
 *
 *   Part A — source pins (tab registry, routes, portal chrome, MCP
 *     cross-link) + document hash/headings + renderer unit checks
 *     (escaping, code/bold/italic/list rendering).
 *   Part B — HTTP against the real server: owner + partner read the
 *     page and download the exact bytes; renter is 403 TAB_FORBIDDEN
 *     on both routes and never sees the tab in /me; anonymous is 401.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b84-soul-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch84', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 14).toString('base64');

const PORT = 31484;
const BASE = `http://127.0.0.1:${PORT}`;

// The approved document, byte for byte (~/workspace/your_files/
// bitpype-agent-soul.md as shipped). A content edit must update this
// pin deliberately — that is the point of pinning it.
const SOUL_SHA256 = 'bd301e77d76ea84dd9bb00a02538a4c8eb5582327c5b59cb5ae16017497dca5c';
const SOUL_HEADINGS = [
  '## 1. Who you are here',
  '## 2. The work',
  '## 3. Brief before build',
  '## 4. Copy and facts — never invent',
  '## 5. How to deliver on this platform',
  '## 6. Native modules, never hand-rolled',
  '## 7. Design standards that never bend',
  '## 8. SEO foundations (built in — feed them correctly)',
  '## 9. Publishing and verification',
  '## 10. Conduct',
  '## 11. Watch the queue',
];

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}

const OWNER_EMAIL = 'owner84@fixture.test';
const PARTNER_EMAIL = 'partner84@fixture.test';
const RENTER_EMAIL = 'renter84@fixture.test';
const PASSWORD = ['Soul', 'Fixture', '84', '!'].join('');

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

/* ===================================================================== */
/* Part A — source pins + renderer units                                  */
/* ===================================================================== */

function partA() {
  const soulPath = path.join(root, 'server/agent-soul.md');
  const soulMd = fs.readFileSync(soulPath, 'utf8');

  check('A: shipped document is byte-identical to the approved copy (sha256 pin)', () => {
    const hash = crypto.createHash('sha256').update(soulMd, 'utf8').digest('hex');
    assert.equal(hash, SOUL_SHA256);
    assert.ok(soulMd.startsWith('# SOUL.md — BitPype Agent\n'), 'title line');
    for (const h of SOUL_HEADINGS) assert.ok(soulMd.includes('\n' + h + '\n'), 'heading: ' + h);
  });

  check('A: tab registry — soul tab exists, owner-tier only', () => {
    const tabs = require(path.join(root, 'server/portalTabs.js'));
    assert.ok(tabs.PORTAL_TABS.includes('soul'), 'PORTAL_TABS includes soul');
    assert.equal(tabs.TAB_LABELS.soul, 'Agent SOUL.md');
    assert.ok(tabs.effectiveTabs('owner', null).includes('soul'), 'owner has soul');
    assert.ok(tabs.effectiveTabs('partner', null).includes('soul'), 'partner has soul');
    assert.deepEqual(tabs.effectiveTabs('renter', null), ['website', 'modules', 'rentals']);
  });

  check('A: portal routes — tab mapping, read + download routes', () => {
    const routes = fs.readFileSync(path.join(root, 'server/routes/portal.js'), 'utf8');
    assert.ok(routes.includes("['/agent-soul', 'soul']"), 'route→tab mapping for the guard');
    assert.ok(routes.includes("router.get('/agent-soul', requireClient"), 'read route');
    assert.ok(routes.includes("router.get('/agent-soul/download', requireClient"), 'download route');
    assert.ok(routes.includes('Content-Disposition'), 'download disposition set');
    assert.ok(routes.includes('attachment; filename='), 'attachment filename');
    assert.ok(routes.includes("require('../agentSoul')"), 'routes use the single source module');
  });

  check('A: portal chrome — nav entry, panel, actions, MCP cross-link', () => {
    const html = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');
    assert.ok(html.includes('id="nav-soul" data-panel="soul"'), 'nav button');
    assert.ok(html.includes('id="sec-soul"'), 'panel section');
    assert.ok(html.includes('data-panel="soul"'), 'panel data hook');
    assert.ok(html.includes('id="btn-soul-copy"'), 'copy button');
    assert.ok(html.includes('id="btn-soul-download"'), 'download button');
    assert.ok(html.includes('/api/v1/portal/agent-soul/download'), 'download href');
    const mcpAt = html.indexOf('id="sec-mcp"');
    const linkAt = html.indexOf('Add the BitPype SOUL.md to your agent first');
    const referralsAt = html.indexOf('id="sec-referrals"');
    assert.ok(mcpAt > -1 && linkAt > mcpAt && linkAt < referralsAt, 'cross-link lives inside the MCP panel');
    assert.ok(html.includes('href="#/soul"'), 'cross-link targets the soul panel');
    const js = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
    assert.ok(js.includes("'soul',"), 'PORTAL_PANELS includes soul');
    assert.ok(js.includes('function loadAgentSoul('), 'panel loader defined');
    assert.ok(js.includes("api('/agent-soul')"), 'loader fetches the document route');
  });

  check('A: renderer — escaping + subset formatting', () => {
    const { renderSoulHtml, loadSoul } = require(path.join(root, 'server/agentSoul.js'));
    const sample = [
      '# Title',
      '',
      'Intro with <script>alert(1)</script> and `a<b` code.',
      '',
      '- **bold** item',
      '- _italic_ item',
      '',
      '1. one',
      '2. two',
      '',
      '---',
      '',
      '## Section',
    ].join('\n');
    const html = renderSoulHtml(sample);
    assert.ok(html.includes('<h1>Title</h1>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'raw HTML is escaped');
    assert.ok(!html.includes('<script>alert'), 'no live script tag in output');
    assert.ok(html.includes('<code>a&lt;b</code>'), 'code span escaped + wrapped');
    assert.ok(html.includes('<li><strong>bold</strong> item</li>'));
    assert.ok(html.includes('<li><em>italic</em> item</li>'));
    assert.ok(html.includes('<ol><li>one</li><li>two</li></ol>'));
    assert.ok(html.includes('<hr>'));
    assert.ok(html.includes('<h2>Section</h2>'));
    const doc = loadSoul();
    assert.equal(doc.markdown, soulMd, 'loadSoul serves the source file verbatim');
    assert.ok(doc.html.includes('<h1>SOUL.md — BitPype Agent</h1>'), 'rendered title');
    for (const h of SOUL_HEADINGS) {
      assert.ok(doc.html.includes('<h2>' + h.slice(3) + '</h2>'), 'rendered heading: ' + h);
    }
  });
}

/* ===================================================================== */
/* Part B — HTTP: owner/partner read + download, renter denied            */
/* ===================================================================== */

async function partB() {
  const bcrypt = require('bcryptjs');
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();

  const hash = bcrypt.hashSync(PASSWORD, 12);
  const ins = async (email, leadId, type) =>
    db.query(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, 1, :l, :b, 'active', :t)`,
      { e: email, h: hash, l: leadId, b: 'Soul Fixture Biz', t: type }
    );
  await ins(OWNER_EMAIL, 501, 'owner');
  await ins(PARTNER_EMAIL, 502, 'partner');
  await ins(RENTER_EMAIL, 777, 'renter');

  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  wdb
    .prepare('INSERT OR IGNORE INTO leads (id, business_name, email, status) VALUES (501, ?, ?, ?)')
    .run('Soul Fixture Biz', OWNER_EMAIL, 'customer');
  wdb
    .prepare('INSERT OR IGNORE INTO leads (id, business_name, email, status) VALUES (502, ?, ?, ?)')
    .run('Soul Partner Biz', PARTNER_EMAIL, 'customer');
  wdb
    .prepare('INSERT OR IGNORE INTO leads (id, business_name, email, status) VALUES (777, ?, ?, ?)')
    .run('Soul Tenant Biz', RENTER_EMAIL, 'customer');

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

    const soulMd = fs.readFileSync(path.join(root, 'server/agent-soul.md'), 'utf8');
    const login = async (email) => {
      const jar = makeJar();
      const res = await jar.fetch(BASE + '/api/v1/portal/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      assert.equal(res.status, 200, 'login ' + email);
      return jar;
    };

    await checkAsync('B: anonymous read is 401', async () => {
      const res = await fetch(BASE + '/api/v1/portal/agent-soul');
      assert.equal(res.status, 401);
    });

    const ownerJar = await login(OWNER_EMAIL);
    await checkAsync('B: owner /me lists the soul tab', async () => {
      const me = (await json(await ownerJar.fetch(BASE + '/api/v1/portal/me'))).data;
      assert.ok(me.client.visibleTabs.includes('soul'));
    });
    await checkAsync('B: owner reads the page — exact markdown + rendered HTML', async () => {
      const body = await json(await ownerJar.fetch(BASE + '/api/v1/portal/agent-soul'));
      assert.equal(body.data.markdown, soulMd, 'served markdown is the source, byte for byte');
      assert.ok(body.data.html.includes('<h1>SOUL.md — BitPype Agent</h1>'));
      assert.ok(body.data.html.includes('<h2>10. Conduct</h2>'));
      assert.equal(body.data.filename, 'SOUL.md');
    });
    await checkAsync('B: owner download returns the exact bytes as an attachment', async () => {
      const res = await ownerJar.fetch(BASE + '/api/v1/portal/agent-soul/download');
      assert.equal(res.status, 200);
      const disp = res.headers.get('content-disposition') || '';
      assert.ok(disp.includes('attachment'), 'disposition: ' + disp);
      assert.ok(disp.includes('SOUL.md'), 'filename in disposition: ' + disp);
      assert.equal(await res.text(), soulMd, 'download body is the source, byte for byte');
    });

    const partnerJar = await login(PARTNER_EMAIL);
    await checkAsync('B: partner reads the page too (owner-tier)', async () => {
      const res = await partnerJar.fetch(BASE + '/api/v1/portal/agent-soul');
      assert.equal(res.status, 200);
    });

    const renterJar = await login(RENTER_EMAIL);
    await checkAsync('B: renter /me excludes the soul tab', async () => {
      const me = (await json(await renterJar.fetch(BASE + '/api/v1/portal/me'))).data;
      assert.deepEqual(me.client.visibleTabs, ['website', 'modules', 'rentals']);
    });
    await checkAsync('B: renter read is 403 TAB_FORBIDDEN (server-side, not hidden UI)', async () => {
      const res = await renterJar.fetch(BASE + '/api/v1/portal/agent-soul');
      assert.equal(res.status, 403);
      assert.equal((await json(res)).code, 'TAB_FORBIDDEN');
    });
    await checkAsync('B: renter download is 403 TAB_FORBIDDEN', async () => {
      const res = await renterJar.fetch(BASE + '/api/v1/portal/agent-soul/download');
      assert.equal(res.status, 403);
      assert.equal((await json(res)).code, 'TAB_FORBIDDEN');
    });
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

(async () => {
  partA();
  await partB();
  console.log(JSON.stringify({ passed: true, checks: results.length, names: results }));
  fs.rmSync(temp, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
