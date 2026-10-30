'use strict';
/**
 * Batch 81 — Lead page top spacing (Ely, 2026-10-30: "in leads detail
 * page the buttons at the top are touching the card, add a margin").
 *
 * The Batch 78 lead page (#/leads/<id>) renders its action row
 * (Score / Qualify / Research / Find duplicates / Record intent /
 * Queue SMS / Rent a site / Delete) directly above the first card
 * (Details). The row carried only an inline `margin:10px 0 0` — no
 * bottom margin — and .lead-page sections carry no top margin, so
 * the buttons sat flush against the card.
 *
 * Fix: the row is now `.inline.lead-actions` and styles.css carries
 *   .lead-page .lead-actions { margin: 10px 0 18px; }
 * — the same 18px rhythm the cards use between each other.
 *
 * Sibling audit (Batch 78's other two pages): the form submissions
 * page (#/forms/<id>) and the LeadScout contact page
 * (#/leadscout/<id>) do NOT share the defect — neither places an
 * in-body button row above its first card; their separation is the
 * shared .page-head margin-bottom (20px), pinned here so it cannot
 * silently vanish either.
 *
 *   Part A — source pins (class, CSS rule + value, no flush inline
 *     style left, sibling separation intact).
 *   Part B — Puppeteer on the real server: open a fixture lead page
 *     and MEASURE the rendered gap between the action row and the
 *     first card (>= 16px) at desktop width and at 390px, and
 *     confirm nothing overflows the phone viewport.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b81-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch81', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');

const PORT = 31481;
const BASE = `http://127.0.0.1:${PORT}`;

const STAFF_EMAIL = 'admin81@fixture.test';
const STAFF_PW = 'Batch81!staffpw';

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
/* Part A — source pins                                                   */
/* ===================================================================== */

function partA() {
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');

  check('A1 lead action row uses the .lead-actions class (flush inline style gone)', () => {
    assert.ok(appJs.includes('<div class="inline lead-actions">'), 'row carries the lead-actions class');
    assert.ok(
      !appJs.includes('<div class="inline" style="margin:10px 0 0">'),
      'the old flush inline style (margin:10px 0 0, no bottom margin) is removed'
    );
  });

  check('A2 styles.css separates the action row from the first card (>= 16px)', () => {
    const m = css.match(/\.lead-page \.lead-actions\s*\{\s*margin:\s*(\d+)px\s+0\s+(\d+)px\s*;?\s*\}/);
    assert.ok(m, '.lead-page .lead-actions rule exists with a 3-value margin');
    const bottom = Number(m[2]);
    assert.ok(bottom >= 16 && bottom <= 24, `bottom margin ${bottom}px is in the 16-24px house range`);
  });

  check('A3 sibling pages keep their separation: .page-head margin-bottom intact', () => {
    const head = css.match(/\.page-head\s*\{[^}]*margin-bottom:\s*(\d+)px/);
    assert.ok(head, '.page-head rule carries a margin-bottom');
    assert.ok(Number(head[1]) >= 16, `.page-head margin-bottom ${head[1]}px >= 16px`);
    // The siblings place no in-body action row above the first card:
    // form submissions render cards straight into #fs-body and the
    // LeadScout contact renders .card blocks straight into #lc-body.
    assert.ok(appJs.includes('async function pageFormSubmissions(formId)'));
    assert.ok(appJs.includes('async function pageLeadScoutContact(id)'));
    assert.ok(!appJs.includes('class="inline lead-actions fs-') && !appJs.includes('lc-actions'),
      'no sibling-specific action-row hack was introduced');
  });
}

/* ===================================================================== */
/* Seed (staff fixture only — pattern from the Batch 78 suite)           */
/* ===================================================================== */

const fixture = {};

async function seed() {
  const bcrypt = require('bcryptjs');
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  const platform = require(path.join(root, 'server/platform.js'));
  await platform.setPlatformSetting('general.public_url', 'https://bitpype.test');
  await db.query("INSERT INTO workspaces (id, name, slug) VALUES (1, 'Batch 81 Fixture', 'batch81-fixture')");
  const hash = (pw) => bcrypt.hashSync(pw, 12);
  await db.query(
    'INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)',
    { e: STAFF_EMAIL, h: hash(STAFF_PW), n: 'Fixture Admin 81', s: 'active' }
  );
  const memberRows = await db.query('SELECT id, email FROM users');
  for (const u of memberRows) {
    await db.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (1, :u, :r)', {
      u: u.id,
      r: 'owner',
    });
  }
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  fixture.wdb = wdb;
  wdb
    .prepare(
      "INSERT INTO leads (id, business_name, email, phone, status, category, city) VALUES (1, 'Fixture Lead Biz 81', 'lead81@fixture.test', '555-010-8100', 'new', 'Plumbing', 'Reading')"
    )
    .run();
}

/* ===================================================================== */
/* HTTP helpers (jar pattern from the Batch 78 suite)                     */
/* ===================================================================== */

function makeJar() {
  const cookies = new Map();
  return {
    cookies,
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
const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
const json = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

async function staffLogin(jar) {
  const totp = require(path.join(root, 'src/totp.js'));
  const body = await json(await post(jar, '/api/v1/auth/login', { email: STAFF_EMAIL, password: STAFF_PW }));
  assert.ok(body && body.data, 'staff login responded');
  if (body.data.mfaRequired) {
    if (body.data.mfaStage === 'enroll') {
      const start = await json(await post(jar, '/api/v1/auth/mfa/enroll/start', {}));
      fixture.staffTotpSecret = start.data.secret;
      const done = await post(jar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(start.data.secret) });
      assert.equal(done.status, 200, 'MFA enrollment completed');
    } else {
      const done = await post(jar, '/api/v1/auth/mfa/verify', { code: totp.totp(fixture.staffTotpSecret) });
      assert.equal(done.status, 200, 'MFA verify completed');
    }
  }
  const ws = await post(jar, '/api/v1/auth/workspace', { workspaceId: 1 });
  assert.equal(ws.status, 200, 'workspace selection completed');
}

/* ===================================================================== */
/* Main                                                                   */
/* ===================================================================== */

(async () => {
  partA();
  await seed();

  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (b) => (output += b));
  child.stderr.on('data', (b) => (output += b));
  const closed = new Promise((resolve) => child.once('close', resolve));

  const puppeteer = require('puppeteer');
  let browser = null;
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

    const staffJar = makeJar();
    await staffLogin(staffJar);

    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    for (const [name, value] of staffJar.cookies.entries()) {
      await page.setCookie({ name, value, url: BASE });
    }

    const measureGap = () =>
      page.evaluate(() => {
        const row = document.querySelector('.lead-page .lead-actions');
        const card = document.querySelector('.lead-page section');
        if (!row || !card) return null;
        const r = row.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        return {
          gap: c.top - r.bottom,
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
        };
      });

    await checkAsync('B1 desktop: action row clears the first card by >= 16px', async () => {
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${BASE}/app#/leads/1`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.lead-page .lead-actions', { timeout: 20000 });
      await page.waitForSelector('.lead-page section', { timeout: 20000 });
      const m = await measureGap();
      assert.ok(m, 'row + first card both rendered');
      assert.ok(m.gap >= 16, `rendered gap ${m.gap.toFixed(1)}px >= 16px (buttons must not touch the card)`);
    });

    await checkAsync('B2 phone (390px): gap holds and nothing overflows the viewport', async () => {
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(`${BASE}/app#/leads/1`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.lead-page .lead-actions', { timeout: 20000 });
      await page.waitForSelector('.lead-page section', { timeout: 20000 });
      // The SPA re-renders on hash navigation only; force a fresh load
      // at the phone width so layout is measured honestly.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.lead-page .lead-actions', { timeout: 20000 });
      await page.waitForSelector('.lead-page section', { timeout: 20000 });
      const m = await measureGap();
      assert.ok(m, 'row + first card both rendered at 390px');
      assert.ok(m.gap >= 16, `rendered gap at 390px ${m.gap.toFixed(1)}px >= 16px`);
      assert.ok(m.scrollW <= m.innerW + 1, `no horizontal overflow at 390px (scrollW ${m.scrollW} vs innerW ${m.innerW})`);
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGTERM');
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }

  console.log(JSON.stringify({ file: 'batch81-lead-page-spacing-regressions', passed: true, checks: results }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
