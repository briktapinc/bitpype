'use strict';
/**
 * Batch 74 — per-lead onboarding checklist in the staff admin.
 *
 * The onboarding pack's internal run sheet ("For the BitPype team —
 * running this onboarding", 12 items) as a working checklist on the
 * lead record:
 *
 *   - server/onboardingChecklist.js — the SINGLE SOURCE for the item
 *     definition; state in lead_onboarding_items (a row exists only
 *     while the item is ticked; who/when/via rides on the row; every
 *     change lands in lead_events). ALL items are OPTIONAL — nothing
 *     gates on completion anywhere.
 *   - Facade: domain.leadOnboardingGet / Set / Run / Confirm. Run is
 *     read-only and returns per-item verdicts (pass | fail | manual)
 *     derived from real tables; Confirm RE-RUNS the engine server-
 *     side and applies only fresh passes as the confirming staffer
 *     (via='autorun', event detail "via Run checklist (confirmed)").
 *   - Routes GET/PUT/POST under /leads/:id/onboarding* carry the
 *     admin-area guard chain (owner/admin session, lead-scoped tokens
 *     denied); the real server refuses anonymous callers (401).
 *   - UI: an "Onboarding checklist" panel in the lead drawer with
 *     plain ticks, a neutral "n of 12" count, the Run checklist
 *     button, per-item verdict hints and the Confirm apply button.
 *
 * Harness: facade tests on temp on-disk workspaces (ws1 + ws2, so
 * isolation is proven against real separate stores), an in-process
 * mount of the real domainApi router for the guard chain, a real
 * server boot for the anonymous 401, and source-shape wiring checks.
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b74-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch74', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');

const PORT = 31474;
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
function throwsCode(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, code, `expected code ${code}, got ${e.code || e.message}`);
    return e;
  }
  assert.fail(`expected throw with code ${code}`);
}

const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
const domain = require(path.join(root, 'server/domain.js'));
const platformDb = require(path.join(root, 'server/db.js'));
const oc = require(path.join(root, 'server/onboardingChecklist.js'));

const STAFF = { id: 999, email: 'staffer74@fixture.test' };
const EXPECTED_KEYS = [
  'lead_record',
  'client_checklist',
  'site_built',
  'portal_account',
  'call_tracking',
  'forms_verified',
  'domain_live',
  'renewal_mode',
  'google_pieces',
  'billing_checked',
  'pack_delivered',
  'checkin_scheduled',
];
const verdictOf = (run, key) => {
  const r = run.results.find((x) => x.key === key);
  assert.ok(r, `verdict present for ${key}`);
  return r;
};

const wdb1 = openWorkspaceDb(1);
const wdb2 = openWorkspaceDb(2);
let bareId;
let bare2Id;

function testDefinitionAndDefaults() {
  check('A1 the shared definition is exactly the 12 run-sheet items, in order', () => {
    assert.deepEqual(
      oc.ITEMS.map((i) => i.key),
      EXPECTED_KEYS
    );
    assert.ok(oc.ITEMS[0].label.startsWith('Lead record complete'));
    assert.ok(oc.ITEMS[11].label.startsWith('Two-week check-in scheduled'));
  });

  bareId = domain.leadsCreate(1, { business_name: 'Bare Fixture Co', email: 'bare74@fixture.test' }).id;

  check('A2 a fresh lead defaults to 12 items, 0 done, progress 0', () => {
    const st = domain.leadOnboardingGet(1, bareId);
    assert.equal(st.total, 12);
    assert.equal(st.doneCount, 0);
    assert.equal(st.items.length, 12);
    assert.ok(st.items.every((i) => i.done === false && i.doneBy === null && i.doneAt === null));
    assert.deepEqual(
      st.items.map((i) => i.key),
      EXPECTED_KEYS
    );
  });

  check('A3 workspace isolation: the same lead id does not exist in ws2 yet', () => {
    throwsCode(() => domain.leadOnboardingGet(2, bareId), 'NOT_FOUND');
    throwsCode(() => domain.leadOnboardingSet(2, bareId, 'site_built', true, STAFF), 'NOT_FOUND');
  });
}

function testToggleFlow() {
  check('B1 staff ticks an item: persists with actor + timestamp + via=manual', () => {
    const st = domain.leadOnboardingSet(1, bareId, 'site_built', true, STAFF);
    const item = st.items.find((i) => i.key === 'site_built');
    assert.equal(item.done, true);
    assert.equal(item.doneBy, STAFF.email);
    assert.equal(item.doneById, STAFF.id);
    assert.ok(item.doneAt, 'doneAt recorded');
    assert.equal(item.via, 'manual');
    assert.equal(st.doneCount, 1);
    // re-read from a fresh call — really persisted
    const again = domain.leadOnboardingGet(1, bareId);
    assert.equal(again.items.find((i) => i.key === 'site_built').done, true);
  });

  check('B2 the tick lands in the lead event trail', () => {
    const events = wdb1
      .prepare("SELECT type, detail FROM lead_events WHERE lead_id = ? AND type = 'onboarding'")
      .all(bareId);
    assert.equal(events.length, 1);
    assert.match(events[0].detail, /Site built staged/);
    assert.match(events[0].detail, /staffer74@fixture\.test/);
  });

  check('B3 un-tick clears the item (and records the un-tick)', () => {
    const st = domain.leadOnboardingSet(1, bareId, 'site_built', false, STAFF);
    assert.equal(st.items.find((i) => i.key === 'site_built').done, false);
    assert.equal(st.doneCount, 0);
    const events = wdb1
      .prepare("SELECT COUNT(*) AS c FROM lead_events WHERE lead_id = ? AND type = 'onboarding'")
      .get(bareId);
    assert.equal(events.c, 2);
  });

  check('B4 re-ticking the same state is idempotent (no duplicate event)', () => {
    domain.leadOnboardingSet(1, bareId, 'site_built', true, STAFF);
    domain.leadOnboardingSet(1, bareId, 'site_built', true, STAFF);
    const events = wdb1
      .prepare("SELECT COUNT(*) AS c FROM lead_events WHERE lead_id = ? AND type = 'onboarding'")
      .get(bareId);
    assert.equal(events.c, 3);
    domain.leadOnboardingSet(1, bareId, 'site_built', false, STAFF);
  });

  check('B5 unknown item key is rejected with a coded VALIDATION error', () => {
    throwsCode(() => domain.leadOnboardingSet(1, bareId, 'not_a_real_item', true, STAFF), 'VALIDATION');
    assert.equal(domain.leadOnboardingGet(1, bareId).doneCount, 0);
  });

  check('B6 ws2 has its own independent checklist for its own lead', () => {
    bare2Id = domain.leadsCreate(2, { business_name: 'Ws2 Fixture Co', email: 'ws2-74@fixture.test' }).id;
    domain.leadOnboardingSet(2, bare2Id, 'lead_record', true, STAFF);
    assert.equal(domain.leadOnboardingGet(2, bare2Id).doneCount, 1);
    assert.equal(domain.leadOnboardingGet(1, bareId).doneCount, 0);
  });
}

async function testAutoRunBare() {
  await platformDb.migrate();
  await checkAsync('C1 auto-run on a bare lead: fails and manuals, NEVER a fake pass', async () => {
    const run = await domain.leadOnboardingRun(1, bareId);
    assert.equal(run.results.length, 12);
    const expect = {
      lead_record: 'fail', // name+email only: no phone, no facts
      client_checklist: 'manual',
      site_built: 'fail',
      portal_account: 'fail', // no portal user in the platform db
      call_tracking: 'fail',
      forms_verified: 'fail',
      domain_live: 'fail',
      renewal_mode: 'manual',
      google_pieces: 'fail',
      billing_checked: 'manual',
      pack_delivered: 'manual',
      checkin_scheduled: 'manual',
    };
    for (const [key, verdict] of Object.entries(expect)) {
      assert.equal(verdictOf(run, key).verdict, verdict, `${key} should be ${verdict}`);
      assert.ok(verdictOf(run, key).detail.length > 10, `${key} carries a human detail`);
    }
    assert.equal(run.results.filter((r) => r.verdict === 'pass').length, 0);
  });

  await checkAsync('C2 the run itself writes NOTHING', async () => {
    const st = domain.leadOnboardingGet(1, bareId);
    assert.equal(st.doneCount, 0);
    const rows = wdb1.prepare('SELECT COUNT(*) AS c FROM lead_onboarding_items WHERE lead_id = ?').get(bareId);
    assert.equal(rows.c, 0);
  });

  await checkAsync('C3 confirm on a bare lead applies zero items', async () => {
    const out = await domain.leadOnboardingConfirm(1, bareId, STAFF);
    assert.equal(out.appliedCount, 0);
    assert.deepEqual(out.applied, []);
    assert.equal(out.state.doneCount, 0);
  });
}

/** Build the fully-wired fixture lead in ws1 and return its id. */
async function buildWiredFixture() {
  const lead = domain.leadsCreate(1, {
    business_name: 'Wired Fixture Co',
    email: 'wired74@fixture.test',
    phone: '(610) 555-0147',
  });
  const id = lead.id;
  wdb1
    .prepare(
      "INSERT INTO business_facts (lead_id, fact_key, value, source, claim_class) VALUES (?, 'phone', '(610) 555-0147', 'manual', 'VERIFIED')"
    )
    .run(id);

  // module tables the engine reads (real ensure functions)
  require(path.join(root, 'server/siteModules.js')).ensureTables(wdb1);
  require(path.join(root, 'server/contactForms.js')).ensureTables(wdb1);
  require(path.join(root, 'server/portalContacts.js')).ensureTables(wdb1);
  require(path.join(root, 'src/cfDomains.js')).ensureTables(wdb1);
  require(path.join(root, 'server/domainFlow.js')).ensureTables(wdb1);

  // website: published, custom domain set
  const site = wdb1
    .prepare(
      "INSERT INTO websites (lead_id, name, theme, pages, status, custom_domain) VALUES (?, 'Wired Fixture Site', '{}', '[]', 'published', 'wiredfixture.com')"
    )
    .run(id);
  // call tracking: number assigned + a logged call
  wdb1.prepare("INSERT INTO calltracking_configs (lead_id, display_number) VALUES (?, '+16105550100')").run(id);
  wdb1
    .prepare(
      "INSERT INTO call_logs (lead_id, call_sid, from_number, to_number, status) VALUES (?, 'CA74fixture', '+16105559999', '+16105550100', 'completed')"
    )
    .run(id);
  // forms: published form + submission + LeadScout capture
  const form = wdb1
    .prepare("INSERT INTO contact_forms (lead_id, name, published, status) VALUES (?, 'Contact form', 1, 'published')")
    .run(id);
  wdb1.prepare('INSERT INTO form_submissions (form_id, lead_id, payload_json) VALUES (?, ?, ?)').run(
    form.lastInsertRowid,
    id,
    '{"name":"Fixture Person"}'
  );
  const contact = wdb1
    .prepare("INSERT INTO leadscout_contacts (name, email, email_norm) VALUES ('Fixture Person', 'person@fixture.test', 'person@fixture.test')")
    .run();
  wdb1
    .prepare("INSERT INTO leadscout_events (contact_id, lead_id, kind) VALUES (?, ?, 'form_submission')")
    .run(contact.lastInsertRowid, id);
  // domain: linked with a recorded renewal mode
  wdb1
    .prepare(
      "INSERT INTO site_domains (website_id, lead_id, domain_name, status, renewal_mode) VALUES (?, ?, 'wiredfixture.com', 'active', 'auto')"
    )
    .run(site.lastInsertRowid, id);
  // google: Place ID set
  wdb1.prepare("INSERT INTO googlereviews_configs (lead_id, place_id) VALUES (?, 'ChIJfixture74')").run(id);
  // billing: paid domain transaction + the payment email step recorded
  wdb1
    .prepare(
      `INSERT INTO domain_transactions (lead_id, website_id, domain, plan_id, status, paid_at, steps_json)
       VALUES (?, ?, 'wiredfixture.com', 'standard', 'paid', '2026-10-29 12:00:00', ?)`
    )
    .run(
      id,
      site.lastInsertRowid,
      JSON.stringify([{ step: 'client_payment_email', ok: true, detail: 'Client payment email sent', at: '2026-10-29T12:00:00Z' }])
    );
  // portal account (platform db) with a real sign-in on record
  await platformDb.query(
    `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, last_login_at)
     VALUES (:e, 'fixture-hash', 1, :l, 'Wired Fixture Co', 'active', '2026-10-30 09:15:00')`,
    { e: 'wired74@fixture.test', l: id }
  );
  return id;
}

const WIRED_PASS = [
  'lead_record',
  'site_built',
  'portal_account',
  'call_tracking',
  'forms_verified',
  'domain_live',
  'renewal_mode',
  'google_pieces',
  'billing_checked',
  'pack_delivered',
];

async function testAutoRunWiredAndConfirm() {
  const wiredId = await buildWiredFixture();

  await checkAsync('D1 auto-run on a fully-wired lead passes the 10 data-provable items', async () => {
    const run = await domain.leadOnboardingRun(1, wiredId);
    for (const key of WIRED_PASS) {
      assert.equal(verdictOf(run, key).verdict, 'pass', `${key} should pass: ${verdictOf(run, key).detail}`);
    }
    assert.equal(verdictOf(run, 'client_checklist').verdict, 'manual');
    assert.equal(verdictOf(run, 'checkin_scheduled').verdict, 'manual');
    assert.equal(run.results.filter((r) => r.verdict === 'fail').length, 0);
    // honest-basis details ride along
    assert.match(verdictOf(run, 'site_built').detail, /audit itself is on you/);
    assert.match(verdictOf(run, 'domain_live').detail, /wiredfixture\.com/);
    assert.match(verdictOf(run, 'portal_account').detail, /signed in 2026-10-30/);
    assert.match(verdictOf(run, 'pack_delivered').detail, /go-live checks are still yours/);
  });

  await checkAsync('D2 confirm applies ONLY the passes, as the confirmer, via autorun', async () => {
    const out = await domain.leadOnboardingConfirm(1, wiredId, STAFF);
    assert.equal(out.appliedCount, 10);
    assert.deepEqual([...out.applied].sort(), [...WIRED_PASS].sort());
    assert.equal(out.state.doneCount, 10);
    for (const item of out.state.items) {
      if (WIRED_PASS.includes(item.key)) {
        assert.equal(item.done, true);
        assert.equal(item.via, 'autorun');
        assert.equal(item.doneBy, STAFF.email);
      } else {
        assert.equal(item.done, false, `${item.key} must stay unticked`);
      }
    }
    const events = wdb1
      .prepare("SELECT detail FROM lead_events WHERE lead_id = ? AND type = 'onboarding'")
      .all(wiredId);
    assert.equal(events.length, 10);
    assert.ok(events.every((e) => /via Run checklist \(confirmed\)/.test(e.detail)), 'provenance on every applied tick');
  });

  await checkAsync('D3 a second confirm applies nothing (idempotent, no duplicate events)', async () => {
    const out = await domain.leadOnboardingConfirm(1, wiredId, STAFF);
    assert.equal(out.appliedCount, 0);
    const events = wdb1
      .prepare("SELECT COUNT(*) AS c FROM lead_events WHERE lead_id = ? AND type = 'onboarding'")
      .get(wiredId);
    assert.equal(events.c, 10);
  });

  await checkAsync('D4 manual ticks still work after an auto-confirm (both directions)', async () => {
    let st = domain.leadOnboardingSet(1, wiredId, 'client_checklist', true, STAFF);
    assert.equal(st.doneCount, 11);
    assert.equal(st.items.find((i) => i.key === 'client_checklist').via, 'manual');
    st = domain.leadOnboardingSet(1, wiredId, 'lead_record', false, STAFF);
    assert.equal(st.items.find((i) => i.key === 'lead_record').done, false);
    assert.equal(st.doneCount, 10);
  });
}

async function testRoutes() {
  const express = require('express');
  const router = require(path.join(root, 'server/routes/domainApi.js'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = {
      via: req.get('x-test-via') || 'session',
      userId: 999,
      workspaceId: 1,
      role: req.get('x-test-role') || 'owner',
      leadId: req.get('x-test-lead') ? Number(req.get('x-test-lead')) : null,
    };
    req.sessionUser = { email: STAFF.email };
    next();
  });
  app.use(router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, headers = {}, body) =>
    fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  try {
    await checkAsync('E1 owner session reads the checklist over HTTP', async () => {
      const res = await call('GET', `/leads/${bareId}/onboarding`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.total, 12);
    });

    await checkAsync('E2 non-staff role (member) is denied the write, state unchanged', async () => {
      const res = await call('PUT', `/leads/${bareId}/onboarding/site_built`, { 'x-test-role': 'member' }, { done: true });
      assert.equal(res.status, 403);
      assert.equal(domain.leadOnboardingGet(1, bareId).doneCount, 0);
    });

    await checkAsync('E3 a lead-scoped (portal) token is denied the write', async () => {
      const res = await call(
        'PUT',
        `/leads/${bareId}/onboarding/site_built`,
        { 'x-test-via': 'token', 'x-test-role': 'token', 'x-test-lead': String(bareId) },
        { done: true }
      );
      assert.equal(res.status, 403);
      assert.equal(domain.leadOnboardingGet(1, bareId).doneCount, 0);
    });

    await checkAsync('E4 an unscoped workspace token is denied too (role is not owner/admin)', async () => {
      const res = await call('POST', `/leads/${bareId}/onboarding/run`, { 'x-test-via': 'token', 'x-test-role': 'token' }, {});
      assert.equal(res.status, 403);
    });

    await checkAsync('E5 owner session ticks, runs and confirms over HTTP', async () => {
      let res = await call('PUT', `/leads/${bareId}/onboarding/checkin_scheduled`, {}, { done: true });
      assert.equal(res.status, 200);
      let body = await res.json();
      assert.equal(body.data.doneCount, 1);
      assert.equal(body.data.items.find((i) => i.key === 'checkin_scheduled').doneBy, STAFF.email);
      res = await call('POST', `/leads/${bareId}/onboarding/run`, {}, {});
      assert.equal(res.status, 200);
      body = await res.json();
      assert.equal(body.data.results.length, 12);
      res = await call('POST', `/leads/${bareId}/onboarding/confirm`, {}, {});
      assert.equal(res.status, 200);
      body = await res.json();
      assert.equal(body.data.appliedCount, 0, 'bare lead: confirm applies nothing');
      assert.equal(body.data.state.doneCount, 1, 'the manual tick survives confirm');
    });

    await checkAsync('E6 unknown item key over HTTP → 422 VALIDATION', async () => {
      const res = await call('PUT', `/leads/${bareId}/onboarding/bogus_key`, {}, { done: true });
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.equal(body.error && body.error.code, 'VALIDATION');
    });

    await checkAsync('E7 unknown lead over HTTP → 404 NOT_FOUND', async () => {
      const res = await call('GET', '/leads/987654/onboarding');
      assert.equal(res.status, 404);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testAnonymousRealServer() {
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

    await checkAsync('F1 anonymous callers are refused the checklist (401, real server)', async () => {
      for (const [method, p] of [
        ['GET', '/api/v1/leads/1/onboarding'],
        ['PUT', '/api/v1/leads/1/onboarding/site_built'],
        ['POST', '/api/v1/leads/1/onboarding/run'],
        ['POST', '/api/v1/leads/1/onboarding/confirm'],
      ]) {
        const res = await fetch(BASE + p, { method });
        assert.equal(res.status, 401, `${method} ${p} should be 401, got ${res.status}`);
      }
    });

    await checkAsync('F2 /onboarding (the public pack page) is untouched and still serves', async () => {
      const res = await fetch(`${BASE}/onboarding`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes('For the BitPype team'), 'no staff run sheet on the public page');
    });
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
}

function testWiring() {
  const domainApi = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
  const apiJs = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const leadEngine = fs.readFileSync(path.join(root, 'src/leadEngine.js'), 'utf8');
  const schema = fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8');

  check('W1 all four routes carry the staff guard chain', () => {
    for (const frag of [
      "router.get(\n  '/leads/:id/onboarding',\n  requireRole('owner', 'admin'),\n  denyLeadScopedToken,",
      "router.put(\n  '/leads/:id/onboarding/:key',\n  requireRole('owner', 'admin'),\n  denyLeadScopedToken,",
      "router.post(\n  '/leads/:id/onboarding/run',\n  requireRole('owner', 'admin'),\n  denyLeadScopedToken,",
      "router.post(\n  '/leads/:id/onboarding/confirm',\n  requireRole('owner', 'admin'),\n  denyLeadScopedToken,",
    ]) {
      assert.ok(domainApi.includes(frag), `guarded route missing: ${frag.split('\n')[0]}`);
    }
  });

  check('W2 api client exposes the four checklist calls on the same paths', () => {
    assert.ok(apiJs.includes("leadOnboarding: (id) => get('/leads/' + id + '/onboarding')"));
    assert.ok(apiJs.includes("leadOnboardingSet: (id, key, done) => put('/leads/' + id + '/onboarding/' + key, { done })"));
    assert.ok(apiJs.includes("leadOnboardingRun: (id) => post('/leads/' + id + '/onboarding/run', {})"));
    assert.ok(apiJs.includes("leadOnboardingConfirm: (id) => post('/leads/' + id + '/onboarding/confirm', {})"));
  });

  check('W3 the lead drawer renders the panel: ticks, neutral count, Run + Confirm', () => {
    assert.ok(appJs.includes('<h3>Onboarding checklist</h3>'), 'panel heading missing');
    assert.ok(appJs.includes('id="ld-onboarding"'), 'panel mount missing');
    assert.ok(appJs.includes('loadLeadOnboarding(dr, id);'), 'panel loader not wired into the drawer');
    assert.ok(appJs.includes('data-onb-run'), 'Run checklist button missing');
    assert.ok(appJs.includes('Run checklist'), 'Run checklist label missing');
    assert.ok(appJs.includes('data-onb-confirm'), 'Confirm button missing');
    assert.ok(appJs.includes('Confirm — apply'), 'Confirm label missing');
    assert.ok(appJs.includes('data-onb-key'), 'tick checkboxes missing');
    assert.ok(appJs.includes('Every item is optional'), 'optional framing missing');
  });

  check('W4 lead delete sweeps the checklist rows; schema creates the table fresh', () => {
    assert.ok(leadEngine.includes("drop('lead_onboarding_items')"), 'deleteLead sweep missing');
    assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS lead_onboarding_items'), 'schema table missing');
  });

  check('W5 the confirm facade re-runs the engine (no client pass list is trusted)', () => {
    const domainSrc = fs.readFileSync(path.join(root, 'server/domain.js'), 'utf8');
    const fn = domainSrc.slice(domainSrc.indexOf('async function leadOnboardingConfirm'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    assert.ok(body.includes('await leadOnboardingRun(workspaceId, leadId)'), 'confirm must re-run the engine');
    assert.ok(body.includes('applyPasses'), 'confirm must apply via applyPasses');
  });
}

(async () => {
  testDefinitionAndDefaults();
  testToggleFlow();
  await testAutoRunBare();
  await testAutoRunWiredAndConfirm();
  await testRoutes();
  await testAnonymousRealServer();
  testWiring();
  console.log(
    JSON.stringify({ file: 'batch74-onboarding-checklist-regressions', passed: results.length, checks: results }, null, 2)
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
