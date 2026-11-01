'use strict';
/**
 * Batch 78 — Pages, not popups (Ely, 2026-10-30: "I don't like that
 * side popup content can we change those to pages instead?" — scope
 * confirmed: the admin lead drawer, and "Do client portal as well").
 *
 *   Staff app — the slide-over drawer (openDrawer) is REMOVED. Its
 *   three content surfaces are full routed pages now:
 *     lead detail        → #/leads/<id>      (pageLeadDetail)
 *     form submissions   → #/forms/<id>      (pageFormSubmissions)
 *     LeadScout contact  → #/leadscout/<id> (pageLeadScoutContact)
 *   Every former opener (leads list, pipeline cards, website detail,
 *   design detail, Admin GBP table, legacy #/leads?id= links, the GBP
 *   OAuth returnTo) navigates to the lead page route.
 *
 *   Client portal — the one content-bearing modal, the module item
 *   editor, is a routed sub-page (#/module-item) under the Modules
 *   tab, inheriting the tab's Batch 29 visibility. Left as popups on
 *   purpose (tool dialogs / pickers / tips, not content panels): the
 *   AI-image generator, the insert-block picker, the new-page form,
 *   the upsell tip card.
 *
 *   Part A — source pins (routes, dispatch, drawer absence, portal
 *     sub-panel machinery, OAuth return).
 *   Part B — HTTP sanity on the real server (staff session + the
 *     Batch 74 checklist endpoints the page calls).
 *   Part C — Puppeteer, staff app: list click-through lands on the
 *     lead page; every drawer section renders; Run checklist +
 *     Confirm + a manual tick all work through the page's own calls;
 *     no .drawer exists; the page fits a 390px phone; the forms and
 *     LeadScout pages render with working back navigation.
 *   Part D — Puppeteer, portal: Modules → New item lands on the
 *     #/module-item page; saving returns to Modules and the item is
 *     really stored (API read-back); a user whose tabs exclude
 *     Modules is redirected away from the editor page.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b78-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch78', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');

const PORT = 31478;
const BASE = `http://127.0.0.1:${PORT}`;

const STAFF_EMAIL = 'admin78@fixture.test';
const STAFF_PW = 'Batch78!staffpw';
const PORTAL_EMAIL = 'owner78@fixture.test';
const PORTAL_PW = 'Batch78!portalpw';
const DENIED_EMAIL = 'denied78@fixture.test';
const DENIED_PW = 'Batch78!deniedpw';
const LEAD_NAME = 'Fixture Lead Biz 78';

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
  const portalJs = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
  const portalHtml = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');
  const gbpRoutes = fs.readFileSync(path.join(root, 'server/routes/gbp.js'), 'utf8');

  check('A1 lead page: route dispatch + page function exist', () => {
    assert.ok(appJs.includes('if (param) return pageLeadDetail(Number(param), query);'));
    assert.ok(appJs.includes('async function pageLeadDetail(id, query)'));
    assert.ok(appJs.includes('class="lead-page" id="ld-body"'));
    assert.ok(appJs.includes('data-act="back"'), 'page carries a Back to leads control');
  });

  check('A2 the drawer implementation is REMOVED (function, markup, CSS)', () => {
    assert.ok(!appJs.includes('function openDrawer'), 'openDrawer fn gone');
    assert.ok(!appJs.includes('openLeadDrawer'), 'openLeadDrawer gone');
    assert.ok(!appJs.includes("className = 'drawer'"), 'drawer markup gone');
    assert.ok(!appJs.includes('drawer-card') && !appJs.includes('drawer-body'), 'drawer classes gone');
    for (const sel of ['.drawer {', '.drawer-card', '.drawer-header', '.drawer-actions', '.drawer-body']) {
      assert.ok(!css.includes(sel), `styles.css pin: ${sel} removed`);
    }
    assert.ok(css.includes('.lead-page section'), 'lead page sections styled as cards');
  });

  check('A3 every former lead opener navigates to #/leads/<id>', () => {
    assert.ok(appJs.includes("window.location.hash = '#/leads/' + t.dataset.id;"), 'leads list + pipeline openers');
    assert.ok(appJs.includes('href="#/leads/${esc(site.lead_id)}"'), 'website detail link');
    assert.ok(appJs.includes('href="#/leads/${esc(job.lead_id)}"'), 'design detail link');
    assert.ok(appJs.includes('href="#/leads/${esc(r.lead_id)}"'), 'admin GBP table link');
    assert.ok(!appJs.includes('#/leads?id='), 'no stale drawer deep links');
    assert.ok(
      appJs.includes("if (query && query.id) window.location.hash = '#/leads/' + Number(query.id);"),
      'legacy #/leads?id= links redirect to the page'
    );
  });

  check('A4 GBP OAuth returns to the lead page (not the dead drawer link)', () => {
    assert.ok(gbpRoutes.includes('`/app#/leads/${id}?gbp=connected`'));
    assert.ok(!gbpRoutes.includes('#/leads?id='));
  });

  check('A5 lead page keeps every drawer section incl. Batch 74 + Batch 46 wiring', () => {
    for (const pin of [
      '<h3>Details</h3>',
      '<h3>Score &amp; intent</h3>',
      '<h3>Website</h3>',
      '<h3>Onboarding checklist</h3>',
      'id="ld-onboarding"',
      'loadLeadOnboarding(dr, id);',
      '<h3>Google Profile</h3>',
      'id="ld-gbp"',
      'loadLeadGbp(dr, id);',
      '<h3>Facts &amp; provenance',
      '<h3>Timeline</h3>',
      'data-act="delete"',
      'leadReferences',
    ]) {
      assert.ok(appJs.includes(pin), `lead page pin: ${pin}`);
    }
  });

  check('A6 submissions + LeadScout contact are routed pages too', () => {
    assert.ok(appJs.includes('if (param) return pageFormSubmissions(Number(param));'));
    assert.ok(appJs.includes('async function pageFormSubmissions(formId)'));
    assert.ok(appJs.includes("window.location.hash = '#/forms/' + b.dataset.id;"));
    assert.ok(appJs.includes('if (param) return pageLeadScoutContact(Number(param));'));
    assert.ok(appJs.includes('async function pageLeadScoutContact(id)'));
    assert.ok(appJs.includes("window.location.hash = '#/leadscout/' + b.dataset.id;"));
    assert.ok(!appJs.includes('openFormSubmissions') && !appJs.includes('openLeadScoutContact'));
  });

  check('A7 portal: item editor is a routed sub-page under Modules', () => {
    assert.ok(portalHtml.includes('id="sec-module-item"'), 'editor section exists');
    assert.ok(portalHtml.includes('data-panel="module-item"'), 'editor section is a portal panel');
    assert.ok(portalHtml.includes('id="btn-module-item-back"'), 'editor page has Back to modules');
    assert.ok(!portalHtml.includes('modules-item-modal'), 'the modal is gone');
    assert.ok(portalJs.includes("const PORTAL_SUBPANELS = ['module-item'];"));
    assert.ok(portalJs.includes("const PORTAL_SUBPANEL_PARENT = { 'module-item': 'modules' };"));
    assert.ok(portalJs.includes("showPortalPanel('module-item');"), 'openModuleEditor navigates to the page');
    assert.ok(portalJs.includes("showPortalPanel('modules');"), 'close returns to Modules');
    assert.ok(!portalJs.includes('modules-item-modal'), 'no modal references left in portal.js');
  });

  check('A8 portal: tool dialogs left as popups on purpose (pinned present)', () => {
    for (const pin of ['ai-image-modal', 'structure-module-modal', 'structure-page-modal', 'upsell-tip-modal']) {
      assert.ok(portalHtml.includes(pin), `left in place: ${pin}`);
    }
  });
}

/* ===================================================================== */
/* Seed                                                                   */
/* ===================================================================== */

const fixture = {};

async function seed() {
  const bcrypt = require('bcryptjs');
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  const platform = require(path.join(root, 'server/platform.js'));
  await platform.setPlatformSetting('general.public_url', 'https://bitpype.test');
  await db.query("INSERT INTO workspaces (id, name, slug) VALUES (1, 'Batch 78 Fixture', 'batch78-fixture')");
  const hash = (pw) => bcrypt.hashSync(pw, 12);
  // Staff super admin (Batch 40: password login → forced TOTP enroll).
  await db.query(
    'INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)',
    { e: STAFF_EMAIL, h: hash(STAFF_PW), n: 'Fixture Admin 78', s: 'active' }
  );
  // Plan-link row: a platform user sharing the portal owner's email
  // (super admin → premium) unlocks the Modules tab for the client.
  await db.query(
    'INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)',
    { e: PORTAL_EMAIL, h: hash('Unused78!pw'), n: 'Fixture Owner Biz', s: 'active' }
  );
  // Workspace membership: the auth middleware requires a
  // workspace_members row before any workspace-scoped call answers
  // (the SPA's workspace picker enforces the same rule).
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
      "INSERT INTO leads (id, business_name, email, phone, status, category, city) VALUES (1, ?, 'lead@fixture.test', '555-010-7800', 'new', 'Plumbing', 'Reading')"
    )
    .run(LEAD_NAME);
  // One researched fact on file — the Batch 74 lead_record auto-check
  // passes only with name+phone+email AND >= 1 fact.
  wdb
    .prepare(
      "INSERT INTO business_facts (lead_id, fact_key, value, source, claim_class) VALUES (1, 'hours', 'Mon-Fri 8-5', 'fixture', 'VERIFIED')"
    )
    .run();
  wdb
    .prepare("INSERT INTO leads (id, business_name, email, status) VALUES (501, 'Fixture Owner Biz', ?, 'customer')")
    .run(PORTAL_EMAIL);
  wdb
    .prepare("INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (501, 'Fixture Site', '{}', '[]', 'draft')")
    .run();

  // Portal users (post-migration columns: user_type, nav_overrides).
  // Batch 112: seeded through the facade so the MySQL gate pass seeds
  // the same rows (was: a direct better-sqlite3 write to the platform
  // file, which exists only in the SQLite pass).
  if ((process.env.REGRESSION_DB_DRIVER || 'sqlite') === 'mysql') {
    const pdb = require(path.join(root, 'server/db.js'));
    await pdb.migrate();
    const ins =
      'INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type, nav_overrides) VALUES (:e, :h, 1, 501, :b, :s, :t, :n)';
    await pdb.query(ins, { e: PORTAL_EMAIL, h: hash(PORTAL_PW), b: 'Fixture Owner Biz', s: 'active', t: 'owner', n: null });
    await pdb.query(ins, { e: DENIED_EMAIL, h: hash(DENIED_PW), b: 'Fixture Owner Biz', s: 'active', t: 'owner', n: '{"modules": false}' });
  } else {
    const RawDb = require('better-sqlite3');
    const raw = new RawDb(process.env.SQLITE_PATH);
    raw
      .prepare(
        'INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type, nav_overrides) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(PORTAL_EMAIL, hash(PORTAL_PW), 1, 501, 'Fixture Owner Biz', 'active', 'owner', null);
    raw
      .prepare(
        'INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type, nav_overrides) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(DENIED_EMAIL, hash(DENIED_PW), 1, 501, 'Fixture Owner Biz', 'active', 'owner', '{"modules": false}');
    raw.close();
  }

  // A published contact form with a phone field; its public submission
  // (Part B) mints the form submission + LeadScout contact fixtures.
  const contactForms = require(path.join(root, 'server/contactForms.js'));
  const form = contactForms.createForm(wdb, 1, {
    name: 'Contact 78',
    fields: [
      { field_key: 'name', label: 'Name', field_type: 'text', required: 1 },
      { field_key: 'email', label: 'Email', field_type: 'email', required: 1 },
      { field_key: 'phone', label: 'Phone', field_type: 'tel', required: 0 },
      { field_key: 'message', label: 'Message', field_type: 'textarea', required: 1 },
    ],
  });
  contactForms.publishForm(wdb, 1, form.id, { workspaceId: 1 });
  fixture.formId = form.id;
  fixture.formToken = contactForms.getFormById(wdb, 1, form.id).public_token;
  assert.ok(fixture.formToken, 'form token minted');
}

/* ===================================================================== */
/* HTTP helpers (jar pattern from the Batch 29 suite)                     */
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
const get = (jar, p) => jar.fetch(BASE + p);
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
  // Pin the session to workspace 1, exactly like the SPA's picker.
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

    /* ---------------- Part B — HTTP sanity ---------------- */
    const staffJar = makeJar();
    await staffLogin(staffJar);
    await checkAsync('B1 staff session works; the checklist endpoints the page calls answer', async () => {
      const r = await get(staffJar, '/api/v1/leads/1/onboarding');
      const peek = await r.clone().text().catch(() => '');
      assert.equal(r.status, 200, `onboarding GET status ${r.status}: ${peek.slice(0, 300)}`);
      const body = await json(r);
      assert.equal(body.data.items.length, 12, '12 checklist items');
      assert.equal(body.data.doneCount, 0);
    });

    await checkAsync('B2 public form submission mints the submission + LeadScout fixtures', async () => {
      const r = await fetch(`${BASE}/api/v1/forms/public/${fixture.formToken}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({
          values: { name: 'Casey Fixture', email: 'casey78@fixture.test', phone: '+15555550178', message: 'Need a quote' },
        }),
      });
      const submitBody = await r.clone().json().catch(() => null);
      assert.equal(r.status, 200, `submit status ${r.status}: ${JSON.stringify(submitBody)}`);
      const contacts = await json(await get(staffJar, '/api/v1/admin-area/leadscout/contacts?limit=100'));
      const rows = (contacts.data && (contacts.data.contacts || contacts.data.rows)) || [];
      const mine = rows.find((c) => c.email === 'casey78@fixture.test');
      assert.ok(mine, 'leadscout contact minted by the submission');
      fixture.contactId = mine.id;
    });

    /* ---------------- Part C — staff app in the browser ---------------- */
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const setJarCookies = async (page, jar) => {
      for (const [name, value] of jar.cookies.entries()) {
        await page.setCookie({ name, value, url: BASE });
      }
    };

    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await setJarCookies(page, staffJar);

    await checkAsync('C1 leads list click-through lands on the lead PAGE (no drawer)', async () => {
      await page.goto(`${BASE}/app#/leads`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#l-body [data-act="open"][data-id="1"]', { timeout: 20000 });
      await page.click('#l-body [data-act="open"][data-id="1"]');
      await page.waitForFunction(() => location.hash === '#/leads/1', { timeout: 10000, polling: 100 });
      await page.waitForFunction(
        (name) => document.querySelector('#ld-title') && document.querySelector('#ld-title').textContent.includes(name),
        { timeout: 20000 },
        LEAD_NAME
      );
      assert.equal(await page.$('.drawer'), null, 'no .drawer element exists');
      assert.equal(await page.$('.drawer-card'), null, 'no .drawer-card element exists');
    });

    await checkAsync('C2 the lead page renders every former drawer section', async () => {
      const heads = await page.$$eval('#ld-body section > h3', (els) => els.map((e) => e.textContent.trim()));
      for (const want of ['Details', 'Score & intent', 'Website', 'Onboarding checklist', 'Google Profile', 'Timeline']) {
        assert.ok(heads.some((h) => h.startsWith(want)), `section present: ${want} (got: ${heads.join(' | ')})`);
      }
      assert.ok(heads.some((h) => h.startsWith('Facts & provenance')), 'facts section present');
      assert.ok(await page.$('#ld-form'), 'details edit form present');
      assert.ok(await page.$('#ld-onboarding'), 'onboarding mount present');
      assert.ok(await page.$('#ld-gbp'), 'GBP mount present');
    });

    await checkAsync('C3 Batch 74 checklist works through the page: Run → Confirm → manual tick', async () => {
      await page.waitForSelector('#ld-onboarding [data-onb-key]', { timeout: 20000 });
      const boxes = await page.$$eval('#ld-onboarding [data-onb-key]', (els) => els.length);
      assert.equal(boxes, 12, '12 checklist ticks render');
      await page.click('#ld-onboarding [data-onb-run]');
      await page.waitForFunction(
        () => document.querySelector('#ld-onboarding').innerText.includes('auto-pass'),
        { timeout: 20000 }
      );
      // Confirm applies the fresh passes server-side (lead_record passes
      // on a fully-populated fixture lead).
      const confirmBtn = await page.$('#ld-onboarding [data-onb-confirm]');
      assert.ok(confirmBtn, 'Confirm button offered after Run');
      await confirmBtn.click();
      // After Confirm lands, no pass remains unapplied → the Confirm
      // button disappears on the re-render.
      await page.waitForFunction(() => !document.querySelector('#ld-onboarding [data-onb-confirm]'), {
        timeout: 20000,
      });
      const after = await json(await get(staffJar, '/api/v1/leads/1/onboarding'));
      const lr = after.data.items.find((i) => i.key === 'lead_record');
      assert.ok(lr && lr.done, 'lead_record ticked via Confirm');
      assert.equal(lr.via, 'autorun', 'confirm ticks carry via=autorun');
      // Manual tick through the page → leadOnboardingSet.
      // Batch 112 de-flake: await the tick's PUT response before
      // asserting server persistence (was: a fixed 400ms sleep, which
      // loses the race whenever the server is slow under load).
      const tickResponse = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && r.url().includes('/onboarding/client_checklist'),
        { timeout: 20000 }
      );
      await page.click('#ld-onboarding [data-onb-key="client_checklist"]');
      await page.waitForFunction(
        () => document.querySelector('#ld-onboarding [data-onb-key="client_checklist"]').checked,
        { timeout: 10000 }
      );
      assert.equal((await tickResponse).status(), 200, 'manual tick PUT completed');
      const after2 = await json(await get(staffJar, '/api/v1/leads/1/onboarding'));
      const cc = after2.data.items.find((i) => i.key === 'client_checklist');
      assert.ok(cc && cc.done && cc.via === 'manual', 'manual tick persisted via the page call');
    });

    await checkAsync('C4 the lead page fits a phone (390px, no horizontal overflow)', async () => {
      await page.setViewport({ width: 390, height: 844 });
      // Batch 112 de-flake: measure only once the layout has settled —
      // two consecutive identical scrollWidth samples after fonts are
      // ready (was: a fixed 300ms sleep after the viewport change).
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(
        () => {
          const b = document.querySelector('#ld-body');
          if (!b) return false;
          const w = b.scrollWidth;
          if (window.__b78w === w) return true;
          window.__b78w = w;
          return false;
        },
        { timeout: 20000, polling: 150 }
      );
      const w = await page.evaluate(() => {
        const b = document.querySelector('#ld-body');
        return { scroll: b.scrollWidth, client: b.clientWidth };
      });
      assert.ok(w.scroll <= w.client + 2, `ld-body scrollWidth ${w.scroll} <= clientWidth ${w.client}`);
      await page.setViewport({ width: 1280, height: 900 });
    });

    await checkAsync('C5 Back to leads returns to the list', async () => {
      await page.click('[data-act="back"]');
      await page.waitForFunction(() => location.hash === '#/leads', { timeout: 10000, polling: 100 });
      // Wait for the rows, not just the shell: a list render that
      // resolves late would otherwise paint over the NEXT page
      // (every page writes #view when its fetch lands).
      await page.waitForSelector('#l-body [data-act="open"]', { timeout: 20000 });
    });

    await checkAsync('C6 form submissions page renders + back navigates', async () => {
      await page.goto(`${BASE}/app#/forms/${fixture.formId}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.querySelector('#fs-body') && document.querySelector('#fs-body').innerText.includes('Casey Fixture'),
        { timeout: 20000 }
      );
      assert.equal(await page.$('.drawer'), null, 'no drawer on the submissions page');
      await page.click('#fs-back');
      await page.waitForFunction(() => location.hash === '#/forms', { timeout: 10000, polling: 100 });
      await page.waitForFunction(
        () => document.querySelector('#view') && document.querySelector('#view').innerText.includes('Contact 78'),
        { timeout: 20000 }
      );
    });

    await checkAsync('C7 LeadScout contact page renders + back navigates', async () => {
      await page.goto(`${BASE}/app#/leadscout/${fixture.contactId}`, { waitUntil: 'domcontentloaded' });
      try {
        await page.waitForFunction(
          () => document.querySelector('#lc-body') && document.querySelector('#lc-body').innerText.includes('casey78@fixture.test'),
          { timeout: 20000 }
        );
      } catch (e) {
        const dbg = await page.evaluate(() => ({
          hash: location.hash,
          lc: document.querySelector('#lc-body') ? document.querySelector('#lc-body').innerText.slice(0, 400) : '(no #lc-body)',
          view: document.querySelector('#view') ? document.querySelector('#view').innerText.slice(0, 200) : '(no #view)',
        }));
        throw new Error(`C7 debug: ${JSON.stringify(dbg)} errors=${pageErrors.join('; ')}`);
      }
      assert.equal(await page.$('.drawer'), null, 'no drawer on the contact page');
      await page.click('#lc-back');
      await page.waitForFunction(() => location.hash === '#/leadscout', { timeout: 10000, polling: 100 });
      await page.waitForFunction(
        () => document.querySelector('#view') && document.querySelector('#view').innerText.includes('Casey Fixture'),
        { timeout: 20000 }
      );
    });

    await checkAsync('C8 no uncaught page errors in the staff app', async () => {
      assert.deepEqual(pageErrors, [], pageErrors.join('; '));
    });

    /* ---------------- Part D — client portal in the browser ---------------- */
    const portalJar = makeJar();
    const loginRes = await post(portalJar, '/api/v1/portal/login', { email: PORTAL_EMAIL, password: PORTAL_PW });
    assert.equal(loginRes.status, 200, 'portal owner login');

    const ctx = await browser.createBrowserContext();
    const ppage = await ctx.newPage();
    const portalErrors = [];
    ppage.on('pageerror', (e) => portalErrors.push(e.message));
    await setJarCookies(ppage, portalJar);

    await checkAsync('D1 Modules → New item lands on the #/module-item PAGE; save round-trips', async () => {
      try {
        await d1Body();
      } catch (e) {
        const dbg = await ppage
          .evaluate(() => ({
            hash: location.hash,
            modulesAppHidden: document.querySelector('#modules-app')?.hasAttribute('hidden'),
            tabs: document.querySelectorAll('[data-module-type]').length,
            editorHidden: document.querySelector('#sec-module-item')?.hasAttribute('hidden'),
            msg: document.querySelector('#msg-modules')?.textContent || '',
            msgModal: document.querySelector('#msg-modules-modal')?.textContent || '',
          }))
          .catch(() => ({}));
        throw new Error(`D1 debug: ${JSON.stringify(dbg)} errors=${portalErrors.join('; ')} :: ${e.message}`);
      }
    });

    // The modules sidebar re-renders as async loads land, which can
    // detach a node between query and click — retry against a fresh
    // node until the click's effect is visible.
    async function clickUntil(page, selector, verify, tries = 8) {
      for (let i = 0; i < tries; i++) {
        const el = await page.$(selector);
        if (el) {
          try {
            await el.click();
          } catch {}
          if (await verify()) return;
        }
        await new Promise((r) => setTimeout(r, 600));
      }
      throw new Error(`click on ${selector} never took effect`);
    }

    async function d1Body() {
      await ppage.goto(`${BASE}/portal#/modules`, { waitUntil: 'domcontentloaded' });
      await ppage.waitForSelector('#modules-app:not([hidden])', { timeout: 25000 });
      await ppage.waitForSelector('[data-module-type="testimonials"]', { timeout: 20000 });
      await clickUntil(ppage, '[data-module-type="testimonials"]', () =>
        ppage.evaluate(() => {
          const b = document.querySelector('[data-module-type="testimonials"]');
          return !!(b && b.classList.contains('is-active'));
        })
      );
      await ppage.waitForSelector('#btn-modules-new', { timeout: 20000 });
      await clickUntil(ppage, '#btn-modules-new', () =>
        ppage.evaluate(() => location.hash === '#/module-item')
      );
      await ppage.waitForFunction(() => location.hash === '#/module-item', { timeout: 10000, polling: 100 });
      await ppage.waitForSelector('#sec-module-item:not([hidden])', { timeout: 10000 });
      assert.equal(await ppage.$('#modules-item-modal'), null, 'the old modal element is gone');
      await ppage.waitForSelector('#modules-fields [data-mod-field="quote"]', { timeout: 10000 });
      await ppage.type('#modules-fields [data-mod-field="quote"]', 'Fixture quote 78 — the page editor works.');
      await ppage.type('#modules-fields [data-mod-field="author_name"]', 'Fixture Author 78');
      await clickUntil(ppage, '#btn-modules-save', () =>
        ppage.evaluate(() => location.hash === '#/modules')
      );
      await ppage.waitForFunction(() => location.hash === '#/modules', { timeout: 20000, polling: 100 });
      const list = await json(await get(portalJar, '/api/v1/portal/modules/testimonials'));
      const items = (list && list.data && list.data.items) || [];
      assert.ok(Array.isArray(items) && items.length >= 1, 'testimonials list answers');
      assert.ok(
        JSON.stringify(list).includes('Fixture quote 78'),
        'saved testimonial read back through the API'
      );
    }

    await checkAsync('D2 Back button leaves the editor page without saving', async () => {
      await clickUntil(ppage, '#btn-modules-new', () =>
        ppage.evaluate(() => location.hash === '#/module-item')
      );
      await ppage.waitForFunction(() => location.hash === '#/module-item', { timeout: 10000, polling: 100 });
      await ppage.click('#btn-module-item-back');
      await ppage.waitForFunction(() => location.hash === '#/modules', { timeout: 10000, polling: 100 });
      await ppage.waitForSelector('#sec-modules:not([hidden])', { timeout: 10000 });
      const hidden = await ppage.$eval('#sec-module-item', (e) => e.hasAttribute('hidden'));
      assert.ok(hidden, 'editor section hidden after Back');
    });

    const deniedJar = makeJar();
    const deniedRes = await post(deniedJar, '/api/v1/portal/login', { email: DENIED_EMAIL, password: DENIED_PW });
    assert.equal(deniedRes.status, 200, 'portal denied-user login');
    const dctx = await browser.createBrowserContext();
    const dpage = await dctx.newPage();
    await setJarCookies(dpage, deniedJar);
    await checkAsync('D3 a user whose tabs exclude Modules cannot open the editor page', async () => {
      await dpage.goto(`${BASE}/portal#/module-item`, { waitUntil: 'domcontentloaded' });
      await dpage.waitForSelector('#portal-nav', { timeout: 20000 });
      await dpage.waitForFunction(
        () => {
          const sec = document.querySelector('#sec-module-item');
          return sec && sec.hasAttribute('hidden') && location.hash !== '#/module-item';
        },
        { timeout: 20000 }
      );
      const navHidden = await dpage.$eval('#portal-nav [data-panel="modules"]', (e) => e.hidden);
      assert.ok(navHidden, 'modules nav stays hidden for this user (Batch 29 rules intact)');
    });

    await checkAsync('D4 no uncaught page errors in the portal', async () => {
      assert.deepEqual(portalErrors, [], portalErrors.join('; '));
    });

    console.log(JSON.stringify({ passed: true, checks: results.length, groups: results }));
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGTERM');
    await closed.catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
