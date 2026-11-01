'use strict';
/**
 * Batch 51 — admin cleanup: voided-domain removal, searchable business
 * pickers, clear-all on list surfaces.
 *
 *   A. domainFlow.deleteTransaction: voided + failed rows hard-delete;
 *      pending_payment → 409 TXN_NOT_DELETABLE ("void it first");
 *      paid/registering/live → 409 always; the facade writes an
 *      activity_log row and the row is actually gone.
 *   B. Calls overview picker: `businesses` stays module-attached-only
 *      (the pre-51 rule: site_module_embeds WHERE module_type =
 *      'calltracking'), while the NEW `pickerBusinesses` offers EVERY
 *      lead with a default config for never-configured leads — and a
 *      config save for such a lead succeeds (setup is how a business
 *      enters call tracking). Search helpers from app.js are executed
 *      from source: bizOptionMatches + filterSelectOptions (the
 *      "All businesses" empty option is never hidden).
 *   C. Clear-all facades: confirm !== 'DELETE' refuses everything;
 *      per-item single-delete semantics decide deleted vs skipped
 *      (forms keep the last form per lead; charged LeadScout contacts
 *      skip; live/paused/open-charge rentals skip; counted call logs
 *      skip); scope by leadId is honored; one summary activity row.
 *      NEGATIVE PROOF: B51_NEGATIVE=1 swaps portalContacts.deleteContact
 *      for a guard-free version — the charged-contact check MUST fail.
 *
 * Pure engine tests on in-memory sqlite + facade tests on a temp
 * on-disk workspace (openWorkspaceDb), following the Batch 45 harness.
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b51-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
// Hermetic env: stripeClient.appUrl() throws APP_URL_REQUIRED when
// NODE_ENV=production and APP_URL is unset — and the app image bakes
// NODE_ENV=production in, so the regression-gate container hits that
// throw where a dev shell does not. adminCallsOverview's per-business
// voice_url build then fails inside its catch-all and `businesses`
// comes back [] (gate failure 2026-10-28, B1). Production sets APP_URL
// via compose env; this test must not depend on ambient env, so pin it
// unconditionally (B3 asserts the exact voice_url built from it).
process.env.APP_URL = 'http://localhost:3000';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || ['dev', 'test', 'only'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 9).toString('base64');

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}

const websiteEngine = require(path.join(root, 'src/websiteEngine.js'));
const contactForms = require(path.join(root, 'server/contactForms.js'));
const siteModules = require(path.join(root, 'server/siteModules.js'));
const portalContacts = require(path.join(root, 'server/portalContacts.js'));
const domainFlow = require(path.join(root, 'server/domainFlow.js'));
const rentals = require(path.join(root, 'server/rentals.js'));

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
async function throwsCodeAsync(fn, code) {
  try {
    await fn();
  } catch (e) {
    assert.equal(e.code, code, `expected code ${code}, got ${e.code || e.message}`);
    return e;
  }
  assert.fail(`expected throw with code ${code}`);
}

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  websiteEngine.ensureTables(db);
  require(path.join(root, 'src/cfDomains.js')).ensureTables(db);
  contactForms.ensureTables(db);
  siteModules.ensureTables(db);
  portalContacts.ensureTables(db);
  domainFlow.ensureTables(db);
  rentals.ensureRentals(db);
  return db;
}
function addLead(db, id) {
  db.prepare(
    `INSERT INTO leads (id, business_name, category, phone, email, city, state)
     VALUES (?, ?, 'Services', '(610) 555-0100', ?, 'Reading', 'PA')`
  ).run(id, `Biz ${id}`, `biz${id}@example.com`);
  return id;
}

/* ---------------- A. engine: deleteTransaction ---------------- */
function testDeleteTransactionEngine() {
  const db = makeDb();
  addLead(db, 1);
  const ins = (domain, status) =>
    Number(
      db
        .prepare(
          `INSERT INTO domain_transactions (lead_id, domain, plan_id, status, registrar_price_cents)
           VALUES (1, ?, 'standard', ?, 1046)`
        )
        .run(domain, status).lastInsertRowid
    );
  const voided = ins('gone1.example.com', 'voided');
  const failed = ins('gone2.example.com', 'failed');
  const pending = ins('pend.example.com', 'pending_payment');
  const paid = ins('paid.example.com', 'paid');
  const registering = ins('reg.example.com', 'registering');
  const live = ins('live.example.com', 'live');

  check('A1 a voided transaction hard-deletes', () => {
    const out = domainFlow.deleteTransaction(db, voided);
    assert.equal(out.deleted, true);
    assert.equal(out.domain, 'gone1.example.com');
    assert.equal(db.prepare('SELECT id FROM domain_transactions WHERE id = ?').get(voided), undefined);
  });
  check('A2 a failed transaction hard-deletes', () => {
    assert.equal(domainFlow.deleteTransaction(db, failed).deleted, true);
    assert.equal(db.prepare('SELECT id FROM domain_transactions WHERE id = ?').get(failed), undefined);
  });
  check('A3 pending_payment refuses TXN_NOT_DELETABLE 409 (void first)', () => {
    const e = throwsCode(() => domainFlow.deleteTransaction(db, pending), 'TXN_NOT_DELETABLE');
    assert.equal(e.status, 409);
    assert.match(e.message, /void it first/i);
    assert.ok(db.prepare('SELECT id FROM domain_transactions WHERE id = ?').get(pending));
  });
  check('A4 paid / registering / live refuse TXN_NOT_DELETABLE 409, always', () => {
    for (const id of [paid, registering, live]) {
      const e = throwsCode(() => domainFlow.deleteTransaction(db, id), 'TXN_NOT_DELETABLE');
      assert.equal(e.status, 409);
      assert.ok(db.prepare('SELECT id FROM domain_transactions WHERE id = ?').get(id));
    }
  });
  check('A5 a missing transaction is NOT_FOUND', () => {
    throwsCode(() => domainFlow.deleteTransaction(db, 999999), 'NOT_FOUND');
  });
}

/* ------------- workspace fixtures (facade-level A/B/C) ------------- */
let wdb;
let domain;
function wsFixtures() {
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  domain = require(path.join(root, 'server/domain.js'));
  wdb = openWorkspaceDb(1);
  // Make sure every engine table exists in the workspace DB.
  contactForms.ensureTables(wdb);
  siteModules.ensureTables(wdb);
  portalContacts.ensureTables(wdb);
  domainFlow.ensureTables(wdb);
  rentals.ensureRentals(wdb);
  for (const id of [1, 2, 3, 11, 12, 21, 22, 31, 32, 41, 51, 61, 71, 72, 81]) addLead(wdb, id);
}

/* ---------------- A. facade: removal + activity ---------------- */
function testDeleteTransactionFacade() {
  const id = Number(
    wdb
      .prepare(
        `INSERT INTO domain_transactions (lead_id, domain, plan_id, status, registrar_price_cents)
         VALUES (1, 'facade-gone.example.com', 'standard', 'voided', 1046)`
      )
      .run().lastInsertRowid
  );
  check('A6 facade removal deletes the row and logs activity', () => {
    const out = domain.adminDeleteDomainTransaction(1, id);
    assert.equal(out.deleted, true);
    assert.equal(wdb.prepare('SELECT id FROM domain_transactions WHERE id = ?').get(id), undefined);
    const log = wdb
      .prepare(`SELECT message FROM activity_log WHERE area = 'domains' AND message LIKE ?`)
      .get(`%removed domain transaction #${id}%`);
    assert.ok(log, 'activity_log entry missing');
    assert.match(log.message, /facade-gone\.example\.com/);
  });
}

/* ---------------- B. calls picker ---------------- */
async function testCallsPicker() {
  // Lead 1 has the calltracking module attached; leads 2 and 3 do not.
  wdb
    .prepare(
      `INSERT INTO site_module_embeds (lead_id, module_type, title, published, embed_enabled)
       VALUES (1, 'calltracking', '', 1, 1)`
    )
    .run();
  const data = await domain.adminCallsOverview(1, {});
  check('B1 businesses stays module-attached-only (the pre-51 rule)', () => {
    assert.deepEqual(
      data.businesses.map((b) => Number(b.lead_id)),
      [1]
    );
  });
  check('B2 pickerBusinesses offers EVERY lead', () => {
    const ids = data.pickerBusinesses.map((b) => Number(b.lead_id)).sort((a, b) => a - b);
    assert.deepEqual(ids, [1, 2, 3, 11, 12, 21, 22, 31, 32, 41, 51, 61, 71, 72, 81]);
  });
  check('B3 a never-configured lead gets default config + flags', () => {
    const p = data.pickerBusinesses.find((b) => Number(b.lead_id) === 2);
    assert.ok(p);
    assert.equal(p.configured, false);
    assert.equal(p.has_module, false);
    assert.equal(p.config.cta_text, 'Call us');
    assert.equal(p.config.redirect_enabled, true);
    assert.equal(p.config.display_number, '');
    assert.equal(p.voice_url, 'http://localhost:3000/api/v1/calls/voice/1/2');
    const p1 = data.pickerBusinesses.find((b) => Number(b.lead_id) === 1);
    assert.equal(p1.has_module, true);
  });
  await checkAsync('B4 saving a config for a never-configured lead works', async () => {
    const out = await domain.adminSaveCallTrackingConfig(1, {
      leadId: 2,
      display_number: '',
      cta_text: 'Call Biz 2',
      redirect_enabled: true,
      redirect_number: '',
      record_calls: false,
      notify_email: true,
      voicemail_enabled: true,
      rotate_enabled: false,
      rotation_numbers: [],
    });
    assert.ok(out && out.config);
    const data2 = await domain.adminCallsOverview(1, {});
    const p2 = data2.pickerBusinesses.find((b) => Number(b.lead_id) === 2);
    assert.equal(p2.configured, true);
    assert.equal(p2.config.cta_text, 'Call Biz 2');
    // The billing strip list is unchanged: still only module-attached.
    assert.deepEqual(
      data2.businesses.map((b) => Number(b.lead_id)),
      [1]
    );
  });
}

/* ------------- B. search helpers executed from app.js ------------- */
function testSearchHelpers() {
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const extract = (name) => {
    const m = appJs.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(m, `${name} not found in app.js`);
    return m[0];
  };
  const bizOptionMatches = new Function(`${extract('bizOptionMatches')}; return bizOptionMatches;`)();
  const filterSelectOptions = new Function(
    `${extract('bizOptionMatches')}\n${extract('filterSelectOptions')}; return filterSelectOptions;`
  )();
  check('B5 bizOptionMatches: substring, case-insensitive, empty = all', () => {
    assert.equal(bizOptionMatches('Delle Donne Electric LLC', 'donne'), true);
    assert.equal(bizOptionMatches('Delle Donne Electric LLC', 'DONNE'), true);
    assert.equal(bizOptionMatches('Berks Roll-Off Co.', 'donne'), false);
    assert.equal(bizOptionMatches('Anything', ''), true);
    assert.equal(bizOptionMatches('Anything', '   '), true);
  });
  check('B6 filterSelectOptions hides non-matches but NEVER the empty "All" option', () => {
    const fake = {
      options: [
        { value: '', textContent: 'All businesses', hidden: false },
        { value: '1', textContent: 'Delle Donne Electric LLC', hidden: false },
        { value: '2', textContent: 'Berks Roll-Off Co.', hidden: false },
      ],
    };
    filterSelectOptions(fake, 'roll');
    assert.equal(fake.options[0].hidden, false);
    assert.equal(fake.options[1].hidden, true);
    assert.equal(fake.options[2].hidden, false);
    filterSelectOptions(fake, '');
    assert.ok(fake.options.every((o) => o.hidden === false));
  });
  check('B7 filter bar keeps the "All businesses" empty-value semantics', () => {
    assert.ok(appJs.includes('<option value="">All businesses</option>'), 'All businesses option changed');
    assert.ok(appJs.includes("id + '-search'"), 'filter bar search input missing');
  });
}

/* ---------------- C. clear-all facades ---------------- */
function testClearAllConfirmGate() {
  check('C0 clear-all without confirm=DELETE is refused and deletes nothing', () => {
    wdb.prepare(`INSERT INTO courses (lead_id, title, slug) VALUES (61, 'Keep Me', 'keep-me')`).run();
    throwsCode(() => domain.adminClearAllCourses(1, {}), 'CONFIRM_REQUIRED');
    throwsCode(() => domain.adminClearAllCourses(1, { confirm: 'delete' }), 'CONFIRM_REQUIRED');
    assert.equal(wdb.prepare(`SELECT COUNT(*) AS c FROM courses WHERE slug = 'keep-me'`).get().c, 1);
    wdb.prepare(`DELETE FROM courses WHERE slug = 'keep-me'`).run();
  });
}
function testClearAllForms() {
  const addForm = (leadId, name) =>
    Number(
      wdb.prepare(`INSERT INTO contact_forms (lead_id, name, title) VALUES (?, ?, ?)`).run(leadId, name, name)
        .lastInsertRowid
    );
  addForm(11, 'F1');
  addForm(11, 'F2');
  addForm(11, 'F3');
  addForm(12, 'Other Biz Form');
  check('C1 forms clear-all scoped: deletes all but the protected last form', () => {
    const out = domain.adminClearAllForms(1, { leadId: 11, confirm: 'DELETE' });
    assert.equal(out.deleted, 2);
    assert.equal(out.skippedCount, 1);
    assert.match(out.skipped[0].reason, /at least one form/i);
    assert.equal(wdb.prepare('SELECT COUNT(*) AS c FROM contact_forms WHERE lead_id = 11').get().c, 1);
    assert.equal(wdb.prepare('SELECT COUNT(*) AS c FROM contact_forms WHERE lead_id = 12').get().c, 1);
    const log = wdb
      .prepare(`SELECT message FROM activity_log WHERE area = 'forms' AND message LIKE 'Staff cleared forms%'`)
      .get();
    assert.ok(log && /deleted 2, skipped 1/.test(log.message), 'summary activity row missing');
  });
}
function testClearAllBookings() {
  const addAppt = (leadId, name) =>
    wdb
      .prepare(
        `INSERT INTO bookings (lead_id, service_id, customer_name, starts_at, ends_at, status)
         VALUES (?, 0, ?, '2026-11-01 10:00:00', '2026-11-01 11:00:00', 'confirmed')`
      )
      .run(leadId, name);
  addAppt(21, 'Cust A');
  addAppt(21, 'Cust B');
  addAppt(22, 'Cust C');
  check('C2 bookings clear-all scoped by business', () => {
    const out = domain.adminClearAllBookings(1, { leadId: 21, confirm: 'DELETE' });
    assert.equal(out.deleted, 2);
    assert.equal(out.skippedCount, 0);
    assert.equal(wdb.prepare('SELECT COUNT(*) AS c FROM bookings WHERE lead_id = 21').get().c, 0);
    assert.equal(wdb.prepare('SELECT COUNT(*) AS c FROM bookings WHERE lead_id = 22').get().c, 1);
  });
}
function testClearAllLeadScout() {
  const addContact = (email) =>
    Number(
      wdb.prepare(`INSERT INTO leadscout_contacts (name, email, phone) VALUES ('C', ?, '')`).run(email)
        .lastInsertRowid
    );
  const addEvent = (contactId, leadId) =>
    Number(
      wdb
        .prepare(`INSERT INTO leadscout_events (contact_id, lead_id, kind) VALUES (?, ?, 'submission')`)
        .run(contactId, leadId).lastInsertRowid
    );
  const plain = addContact('plain51@example.com');
  addEvent(plain, 31);
  const charged = addContact('charged51@example.com');
  const chargedEvent = addEvent(charged, 31);
  const other = addContact('other51@example.com');
  addEvent(other, 32);
  // A rental charge pointing at the charged contact's event.
  const rentalId = Number(
    wdb
      .prepare(
        `INSERT INTO site_rentals (website_id, tenant_lead_id, owner_lead_id, status)
         VALUES (5100, 31, 51, 'ended')`
      )
      .run().lastInsertRowid
  );
  wdb
    .prepare(
      `INSERT INTO site_rental_charges (rental_id, website_id, tenant_lead_id, event_id, status)
       VALUES (?, 5100, 31, ?, 'charged')`
    )
    .run(rentalId, chargedEvent);
  check('C3 leadscout clear-all: plain deleted, charged skipped, other business untouched', () => {
    const out = domain.adminClearAllLeadScoutContacts(1, { leadId: 31, confirm: 'DELETE' });
    if (process.env.B51_NEGATIVE === '1') {
      // Guard-bypass shim (installed in main): the charged contact is
      // gone, so these assertions MUST fail — that is the proof.
    }
    assert.equal(out.deleted, 1);
    assert.equal(out.skippedCount, 1);
    assert.match(out.skipped[0].reason, /rental-charged/i);
    assert.equal(wdb.prepare('SELECT id FROM leadscout_contacts WHERE id = ?').get(plain), undefined);
    assert.ok(wdb.prepare('SELECT id FROM leadscout_contacts WHERE id = ?').get(charged));
    assert.ok(wdb.prepare('SELECT id FROM leadscout_contacts WHERE id = ?').get(other));
  });
}
function testClearAllMembers() {
  const addMember = (email) =>
    wdb.prepare(`INSERT INTO site_members (lead_id, email, password_hash) VALUES (41, ?, 'x')`).run(email);
  addMember('m1-51@example.com');
  addMember('m2-51@example.com');
  check('C4 members clear-all requires a business scope', () => {
    throwsCode(() => domain.adminClearAllMembers(1, { confirm: 'DELETE' }), 'VALIDATION');
    assert.equal(wdb.prepare('SELECT COUNT(*) AS c FROM site_members WHERE lead_id = 41').get().c, 2);
  });
  check('C5 members clear-all deletes the site members', () => {
    const out = domain.adminClearAllMembers(1, { leadId: 41, confirm: 'DELETE' });
    assert.equal(out.deleted, 2);
    assert.equal(wdb.prepare('SELECT COUNT(*) AS c FROM site_members WHERE lead_id = 41').get().c, 0);
  });
}
function testClearAllRentals() {
  const addRental = (status) =>
    Number(
      wdb
        .prepare(
          `INSERT INTO site_rentals (website_id, tenant_lead_id, owner_lead_id, status, ended_at)
           VALUES (5100, 51, 1, ?, ?)`
        )
        .run(status, status === 'ended' ? '2026-10-01 00:00:00' : null).lastInsertRowid
    );
  // Fixture from C3: an ended rental with only a settled ('charged')
  // charge is deletable too — count it in expectations below.
  const settledRental = Number(
    wdb.prepare(`SELECT id FROM site_rentals WHERE tenant_lead_id = 31 AND status = 'ended'`).get().id
  );
  const endedClean = addRental('ended');
  const active = addRental('active');
  const paused = addRental('paused');
  const endedDue = addRental('ended');
  wdb
    .prepare(
      `INSERT INTO site_rental_charges (rental_id, website_id, tenant_lead_id, status, amount_due_cents)
       VALUES (?, 5100, 51, 'due', 2500)`
    )
    .run(endedDue);
  check('C6 rentals clear-all: ended delete; active/paused/open-charge skip', () => {
    const out = domain.adminClearAllRentals(1, { confirm: 'DELETE' });
    assert.equal(out.deleted, 2); // settledRental + endedClean
    assert.equal(out.skippedCount, 3);
    const reasons = out.skipped.map((s) => s.reason).join(' | ');
    assert.match(reasons, /Active rental/i);
    assert.match(reasons, /Only an ended rental/i);
    assert.match(reasons, /unsettled charges/i);
    assert.equal(wdb.prepare('SELECT id FROM site_rentals WHERE id = ?').get(endedClean), undefined);
    assert.equal(wdb.prepare('SELECT id FROM site_rentals WHERE id = ?').get(settledRental), undefined);
    assert.ok(wdb.prepare('SELECT id FROM site_rentals WHERE id = ?').get(active));
    assert.ok(wdb.prepare('SELECT id FROM site_rentals WHERE id = ?').get(paused));
    assert.ok(wdb.prepare('SELECT id FROM site_rentals WHERE id = ?').get(endedDue));
  });
}
function testClearAllModulesCoursesCalls() {
  const addEmbed = (leadId, type) =>
    wdb
      .prepare(
        `INSERT INTO site_module_embeds (lead_id, module_type, published, embed_enabled) VALUES (?, ?, 1, 1)`
      )
      .run(leadId, type);
  addEmbed(71, 'faq');
  addEmbed(71, 'blog');
  addEmbed(72, 'faq');
  check('C7 modules clear-all detaches the scoped business only', () => {
    const out = domain.adminClearAllModules(1, { leadId: 71, confirm: 'DELETE' });
    assert.equal(out.deleted, 2);
    const rows = wdb.prepare('SELECT published, embed_enabled FROM site_module_embeds WHERE lead_id = 71').all();
    assert.ok(rows.every((r) => r.published === 0 && r.embed_enabled === 0));
    const other = wdb.prepare('SELECT published FROM site_module_embeds WHERE lead_id = 72').get();
    assert.equal(other.published, 1);
  });
  const c1 = Number(
    wdb.prepare(`INSERT INTO courses (lead_id, title, slug) VALUES (61, 'Course One', 'course-one')`).run()
      .lastInsertRowid
  );
  wdb.prepare(`INSERT INTO course_lessons (course_id, title) VALUES (?, 'Lesson 1')`).run(c1);
  wdb.prepare(`INSERT INTO courses (lead_id, title, slug) VALUES (61, 'Course Two', 'course-two')`).run();
  check('C8 courses clear-all deletes courses with their lessons', () => {
    const out = domain.adminClearAllCourses(1, { leadId: 61, confirm: 'DELETE' });
    assert.equal(out.deleted, 2);
    assert.equal(wdb.prepare('SELECT COUNT(*) AS c FROM courses WHERE lead_id = 61').get().c, 0);
    assert.equal(wdb.prepare('SELECT COUNT(*) AS c FROM course_lessons WHERE course_id = ?').get(c1).c, 0);
  });
  const addCall = (sid, counted) =>
    wdb
      .prepare(`INSERT INTO call_logs (lead_id, call_sid, counted) VALUES (81, ?, ?)`)
      .run(sid, counted);
  addCall('CA51-clean', 0);
  addCall('CA51-counted', 1);
  check('C9 calls clear-all deletes clean logs, skips counted ones', () => {
    const out = domain.adminClearAllCalls(1, { leadId: 81, confirm: 'DELETE' });
    assert.equal(out.deleted, 1);
    assert.equal(out.skippedCount, 1);
    assert.match(out.skipped[0].reason, /billing history/i);
    assert.equal(wdb.prepare(`SELECT COUNT(*) AS c FROM call_logs WHERE lead_id = 81`).get().c, 1);
  });
}

/* ---------------- wiring pins (static) ---------------- */
function testWiring() {
  const domainApi = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const apiJs = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
  check('W1 routes: txn DELETE + all clear-alls are role-guarded', () => {
    assert.ok(domainApi.includes("router.delete('/admin-area/domain-transactions/:id', requireRole('owner', 'admin')"));
    for (const p of [
      '/admin-area/forms/clear-all',
      '/admin-area/bookings/clear-all',
      '/admin-area/leadscout/contacts/clear-all',
      '/admin-area/memberships/clear-all',
      '/admin-area/rentals/clear-all',
      '/admin-area/modules/clear-all',
      '/admin-area/courses/clear-all',
      '/admin-area/calls/clear-all',
    ]) {
      assert.ok(domainApi.includes(`clearAllRoute('${p}'`), `missing clear-all route: ${p}`);
    }
    assert.ok(domainApi.includes("router.post(path, requireRole('owner', 'admin'), denyLeadScopedToken"), 'clear-all guard missing');
  });
  check('W2 UI affordances: txn Remove, picker search, clear-all buttons', () => {
    for (const needle of [
      'data-act="txn-remove"',
      'cl-cfg-search',
      'pickerBusinesses',
      'bizOptionMatches',
      'runClearAllFlow',
      'rent-tenant-search',
      'soc-lead-search',
      'ls-biz-search',
      'data-act="clear-members"',
    ]) {
      assert.ok(appJs.includes(needle), `app.js missing: ${needle}`);
    }
    for (const needle of ['adminDomainTransactionRemove', 'adminClearAllForms', 'adminClearAllRentals']) {
      assert.ok(apiJs.includes(needle), `api.js missing: ${needle}`);
    }
  });
  check('W3 requireRole refuses a non-staff role (real middleware)', () => {
    const { requireRole } = require(path.join(root, 'server/middleware.js'));
    const mw = requireRole('owner', 'admin');
    let status = null;
    const res = {
      status(c) {
        status = c;
        return this;
      },
      json() {
        return this;
      },
    };
    let nexted = false;
    mw({ auth: { role: 'member' } }, res, () => {
      nexted = true;
    });
    assert.equal(nexted, false);
    assert.equal(status, 403);
    mw({ auth: { role: 'admin' } }, res, () => {
      nexted = true;
    });
    assert.equal(nexted, true);
  });
}

(async () => {
  if (process.env.B51_NEGATIVE === '1') {
    // NEGATIVE PROOF shim: a guard-free contact delete (raw row delete,
    // no rental-charge check). The C3 charged-contact assertions MUST
    // fail under this shim — run manually to verify, then unset.
    portalContacts.deleteContact = (db, id) => {
      db.prepare('DELETE FROM leadscout_contacts WHERE id = ?').run(Number(id));
      return { deleted: true, id: Number(id), eventsRemoved: 0 };
    };
  }
  testDeleteTransactionEngine();
  wsFixtures();
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  testDeleteTransactionFacade();
  await testCallsPicker();
  testSearchHelpers();
  testClearAllConfirmGate();
  testClearAllForms();
  testClearAllBookings();
  testClearAllLeadScout();
  testClearAllMembers();
  testClearAllRentals();
  testClearAllModulesCoursesCalls();
  testWiring();
  console.log(JSON.stringify({ file: 'batch51-admin-cleanup-regressions', passed: results.length, checks: results }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
