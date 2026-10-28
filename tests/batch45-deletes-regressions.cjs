'use strict';
/**
 * Batch 45 — deletes + B1 hardening + retention prunes + B5 logging
 * (audit: batch45-audit-2026-10-28.md). Every check is independently
 * falsifiable against the pre-batch code:
 *
 *   1. Form submissions: per-row + bulk hard delete (portal/staff share
 *      the contactForms engine). The LeadScout event is unlinked, the
 *      CONTACT survives, and another lead's submission id is NOT_FOUND
 *      (never deleted cross-lead). Pre-batch: no delete functions exist.
 *   2. deleteAppointment / deleteEstimateRequest remove the row AND its
 *      LeadScout event (pre-batch they were dead exports; the event
 *      cleanup did not exist).
 *   3. Domain transactions: staff void for pending_payment/failed only;
 *      a voided txn leaves pickerMeta (claim/picker), markPaid cannot
 *      resurrect it, and voiding paid/live throws TXN_NOT_VOIDABLE 409.
 *   4. LeadScout contacts: hard delete cascades events via FK, refuses
 *      a contact with a charged rental event (CONTACT_CHARGED), refuses
 *      a lead-scoped delete of a shared contact (CONTACT_SHARED), and
 *      clear-resolved drops only resolved capture failures.
 *   5. Archives purge (domain.sitesPurgeSite): non-archived → 409
 *      NOT_ARCHIVED; wrong confirm name → CONFIRM_REQUIRED; exact name
 *      hard-deletes the archived site via destroyWebsite.
 *   6. B1 (HIGH): leadEngine.deleteLead archive-first hardening —
 *      reference summary, in-transaction site_domains cleanup, and the
 *      freed email is immediately reusable. Pre-batch code returns no
 *      summary and leaves the site_domains row 'linked' at a dead site.
 *      NEGATIVE PROOF: run with B45_NEGATIVE=1 to use a cascade-reliant
 *      deleteLead shim — the B1 checks MUST fail (verified manually).
 *   7. Call logs: staff delete only when counted=0, unbilled and
 *      uncharged; counted/billed/charged all refuse with stable codes.
 *   8. Portal users: super-admin deletePortalUser removes the row
 *      (findById → null); a second delete is NOT_FOUND.
 *   9. Retention prunes: activity_log >180d dropped, website versions
 *      keep newest 50 (restore of a kept version still works), the
 *      sweep logs ONE 'retention' row only when it pruned something.
 *  15. B5: a throwing rental charge/stamp now logs a contextual
 *      console.warn (lead id + error) while the capture still succeeds
 *      uncharged. Pre-batch: the catch was silent.
 *
 * No network, no Stripe, no Cloudflare: pure engine tests on in-memory
 * sqlite (foreign_keys=ON, matching server/workspaceDb.js) plus a temp
 * on-disk workspace/platform pair for the domain + portal-user paths.
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b45-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'b45-fixture-secret';
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 9).toString('base64');

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}

const leadEngine = require(path.join(root, 'src/leadEngine.js'));
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

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  websiteEngine.ensureTables(db);
  require(path.join(root, 'src/cfDomains.js')).ensureTables(db);
  require(path.join(root, 'src/designJobs.js')).ensureTables(db);
  contactForms.ensureTables(db);
  siteModules.ensureTables(db);
  portalContacts.ensureTables(db);
  rentals.ensureRentals(db);
  return db;
}

function addLead(db, id, email) {
  db.prepare(
    `INSERT INTO leads (id, business_name, category, phone, email, city, state)
     VALUES (?, ?, 'Services', '(610) 555-0100', ?, 'Reading', 'PA')`
  ).run(id, `Biz ${id}`, email || `biz${id}@example.com`);
  return id;
}

function addSite(db, id, leadId, name) {
  db.prepare(
    `INSERT INTO websites (id, lead_id, name, industry, theme, pages, status, preview_url, updated_at)
     VALUES (?, ?, ?, 'services', '{}', '[]', 'draft', NULL, '2026-10-01 00:00:00')`
  ).run(id, leadId, name);
  return websiteEngine.getWebsite(db, id);
}

function throwsCode(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, code, `expected code ${code}, got ${e.code || e.message}`);
    return e;
  }
  assert.fail(`expected ${code} to be thrown`);
}

/* ---------------- 1. form submissions ---------------- */
function testSubmissions() {
  const db = makeDb();
  addLead(db, 1, 'subs-a@example.com');
  addLead(db, 2, 'subs-b@example.com');
  const form = contactForms.createForm(db, 1, { name: 'Contact' });
  const insSub = db.prepare(
    `INSERT INTO form_submissions (form_id, lead_id, payload_json, routing) VALUES (?, ?, ?, 'inbox')`
  );
  const s1 = Number(insSub.run(form.id, 1, JSON.stringify({ name: 'Ann', email: 'ann@example.com' })).lastInsertRowid);
  const s2 = Number(insSub.run(form.id, 1, JSON.stringify({ name: 'Bob', email: 'bob@example.com' })).lastInsertRowid);
  const s3 = Number(insSub.run(form.id, 1, JSON.stringify({ name: 'Cat', email: 'cat@example.com' })).lastInsertRowid);
  const contact = portalContacts.upsertContact(db, { name: 'Ann', email: 'ann@example.com' });
  db.prepare(
    `INSERT INTO leadscout_events (contact_id, lead_id, kind, source_label, form_id, submission_id)
     VALUES (?, 1, 'submission', 'Contact', ?, ?)`
  ).run(contact.id, form.id, s1);

  check('1a listSubmissions reports a total', () => {
    const out = contactForms.listSubmissions(db, 1, { limit: 50, offset: 0, formId: form.id });
    assert.equal(out.total, 3);
    assert.equal(out.submissions.length, 3);
  });

  check('1b deleteSubmission removes row + LeadScout event, keeps contact', () => {
    const out = contactForms.deleteSubmission(db, 1, s1);
    assert.equal(out.deleted, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM form_submissions WHERE id = ?').get(s1).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM leadscout_events WHERE submission_id = ?').get(s1).c, 0);
    assert.ok(db.prepare('SELECT id FROM leadscout_contacts WHERE id = ?').get(contact.id), 'contact must survive');
  });

  check('1c cross-lead delete is NOT_FOUND and deletes nothing', () => {
    throwsCode(() => contactForms.deleteSubmission(db, 2, s2), 'NOT_FOUND');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM form_submissions WHERE id = ?').get(s2).c, 1);
  });

  check('1d bulk delete removes the listed rows only', () => {
    const out = contactForms.deleteSubmissions(db, 1, [s2, s3]);
    assert.equal(out.deletedCount, 2);
    assert.deepEqual(out.missing, []);
    assert.equal(contactForms.listSubmissions(db, 1, { formId: form.id }).total, 0);
  });

  check('1e bulk delete skips foreign ids (reported missing, never deleted)', () => {
    const s4 = Number(insSub.run(form.id, 1, JSON.stringify({ name: 'Dan' })).lastInsertRowid);
    const form2 = contactForms.createForm(db, 2, { name: 'Other' });
    const foreign = Number(insSub.run(form2.id, 2, JSON.stringify({ name: 'Eve' })).lastInsertRowid);
    const out = contactForms.deleteSubmissions(db, 1, [s4, foreign]);
    assert.equal(out.deletedCount, 1);
    assert.deepEqual(out.missing, [foreign]);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM form_submissions WHERE id = ?').get(s4).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM form_submissions WHERE id = ?').get(foreign).c, 1);
  });
}

/* ---------------- 2. appointments + estimate requests ---------------- */
function testModuleDeletes() {
  const db = makeDb();
  addLead(db, 1);
  const contact = portalContacts.upsertContact(db, { name: 'Appt Ann', email: 'appt@example.com' });
  const svc = db
    .prepare(`INSERT INTO booking_services (lead_id, name, slug) VALUES (1, 'Consult', 'consult')`)
    .run();
  const appt = db
    .prepare(
      `INSERT INTO bookings (lead_id, service_id, customer_name, customer_email, starts_at, ends_at, status)
       VALUES (1, ?, 'Appt Ann', 'appt@example.com', '2026-11-01T10:00', '2026-11-01T10:30', 'confirmed')`
    )
    .run(Number(svc.lastInsertRowid));
  const apptId = Number(appt.lastInsertRowid);
  db.prepare(
    `INSERT INTO leadscout_events (contact_id, lead_id, kind, source_label, booking_id) VALUES (?, 1, 'appointment', 'Booking', ?)`
  ).run(contact.id, apptId);
  const est = db
    .prepare(
      `INSERT INTO estimate_requests (lead_id, name, email, status) VALUES (1, 'Est Ed', 'ed@example.com', 'new')`
    )
    .run();
  const estId = Number(est.lastInsertRowid);
  db.prepare(
    `INSERT INTO leadscout_events (contact_id, lead_id, kind, source_label, estimate_request_id) VALUES (?, 1, 'estimate', 'Estimate', ?)`
  ).run(contact.id, estId);

  check('2a deleteAppointment removes the booking and its LeadScout event', () => {
    siteModules.deleteAppointment(db, 1, apptId);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bookings WHERE id = ?').get(apptId).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM leadscout_events WHERE booking_id = ?').get(apptId).c, 0);
    assert.ok(db.prepare('SELECT id FROM leadscout_contacts WHERE id = ?').get(contact.id));
  });
  check('2b deleteAppointment on a missing id is NOT_FOUND', () => {
    throwsCode(() => siteModules.deleteAppointment(db, 1, apptId), 'NOT_FOUND');
  });
  check('2c deleteEstimateRequest removes the request and its LeadScout event', () => {
    siteModules.deleteEstimateRequest(db, 1, estId);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM estimate_requests WHERE id = ?').get(estId).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM leadscout_events WHERE estimate_request_id = ?').get(estId).c, 0);
  });
  check('2d deleteEstimateRequest on a missing id is NOT_FOUND', () => {
    throwsCode(() => siteModules.deleteEstimateRequest(db, 1, 99999), 'NOT_FOUND');
  });
}

/* ---------------- 3. domain transaction void ---------------- */
function testVoid() {
  const db = makeDb();
  addLead(db, 1);
  const t1 = domainFlow.createTransaction(db, {
    leadId: 1, domain: 'void-one.com', registrarPriceCents: 1046, registrarCurrency: 'USD', planId: 'standard',
  });
  check('3a a pending txn is the picker open transaction', () => {
    const meta = domainFlow.pickerMeta(db, 1, 1);
    assert.ok(meta.openTransaction && Number(meta.openTransaction.id) === Number(t1.id));
  });
  check('3b void flips status, appends the step, and leaves the picker', () => {
    const out = domainFlow.voidTransaction(db, t1.id);
    assert.equal(out.transaction.status, 'voided');
    assert.ok(out.transaction.steps.some((s) => s.step === 'voided'));
    const meta = domainFlow.pickerMeta(db, 1, 1);
    assert.equal(meta.openTransaction, null);
  });
  check('3c markPaid cannot resurrect a voided txn', () => {
    const out = domainFlow.markPaid(db, t1.id, { amountCents: 9900 });
    assert.equal(out.changed, false);
    assert.equal(domainFlow.getTransaction(db, t1.id).status, 'voided');
  });
  check('3d voiding a paid txn is TXN_NOT_VOIDABLE (409)', () => {
    const t2 = domainFlow.createTransaction(db, {
      leadId: 1, domain: 'void-two.com', registrarPriceCents: 1046, registrarCurrency: 'USD', planId: 'pro',
    });
    domainFlow.markPaid(db, t2.id, { amountCents: 16900 });
    const e = throwsCode(() => domainFlow.voidTransaction(db, t2.id), 'TXN_NOT_VOIDABLE');
    assert.equal(e.status, 409);
    assert.equal(domainFlow.getTransaction(db, t2.id).status, 'paid');
  });
  check('3e voiding a live txn and re-voiding both refuse', () => {
    const t3 = domainFlow.createTransaction(db, {
      leadId: 1, domain: 'void-three.com', registrarPriceCents: 1046, registrarCurrency: 'USD', planId: 'standard',
    });
    domainFlow.patchTransaction(db, t3.id, { status: 'live' });
    throwsCode(() => domainFlow.voidTransaction(db, t3.id), 'TXN_NOT_VOIDABLE');
    throwsCode(() => domainFlow.voidTransaction(db, t1.id), 'TXN_NOT_VOIDABLE');
  });
  check('3f voiding a failed txn is allowed', () => {
    const t4 = domainFlow.createTransaction(db, {
      leadId: 1, domain: 'void-four.com', registrarPriceCents: 1046, registrarCurrency: 'USD', planId: 'standard',
    });
    domainFlow.patchTransaction(db, t4.id, { status: 'failed' });
    assert.equal(domainFlow.voidTransaction(db, t4.id).transaction.status, 'voided');
  });
}

/* ---------------- 4. LeadScout contacts ---------------- */
function testContacts() {
  const db = makeDb();
  addLead(db, 1);
  addLead(db, 2);
  const plain = portalContacts.upsertContact(db, { name: 'Plain Pam', email: 'pam@example.com' });
  db.prepare(`INSERT INTO leadscout_events (contact_id, lead_id, kind) VALUES (?, 1, 'submission')`).run(plain.id);
  db.prepare(`INSERT INTO leadscout_events (contact_id, lead_id, kind) VALUES (?, 1, 'call')`).run(plain.id);

  check('4a contact delete cascades its events (FK)', () => {
    const out = portalContacts.deleteContact(db, plain.id, {});
    assert.equal(out.eventsRemoved, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM leadscout_contacts WHERE id = ?').get(plain.id).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM leadscout_events WHERE contact_id = ?').get(plain.id).c, 0);
  });

  check('4b a charged rental event blocks the delete (CONTACT_CHARGED)', () => {
    const charged = portalContacts.upsertContact(db, { name: 'Charged Chad', email: 'chad@example.com' });
    const ev = db
      .prepare(`INSERT INTO leadscout_events (contact_id, lead_id, kind) VALUES (?, 1, 'submission')`)
      .run(charged.id);
    db.prepare(
      `INSERT INTO site_rentals (website_id, tenant_lead_id, owner_lead_id, status) VALUES (1, 2, 1, 'active')`
    ).run();
    const rental = db.prepare('SELECT id FROM site_rentals LIMIT 1').get();
    db.prepare(
      `INSERT INTO site_rental_charges (rental_id, website_id, tenant_lead_id, event_id) VALUES (?, 1, 2, ?)`
    ).run(rental.id, Number(ev.lastInsertRowid));
    const e = throwsCode(() => portalContacts.deleteContact(db, charged.id, {}), 'CONTACT_CHARGED');
    assert.equal(e.status, 409);
    assert.ok(db.prepare('SELECT id FROM leadscout_contacts WHERE id = ?').get(charged.id));
  });

  check('4c a shared contact refuses a lead-scoped delete but not a staff delete', () => {
    const shared = portalContacts.upsertContact(db, { name: 'Shared Sue', email: 'sue@example.com' });
    db.prepare(`INSERT INTO leadscout_events (contact_id, lead_id, kind) VALUES (?, 1, 'submission')`).run(shared.id);
    db.prepare(`INSERT INTO leadscout_events (contact_id, lead_id, kind) VALUES (?, 2, 'submission')`).run(shared.id);
    const e = throwsCode(() => portalContacts.deleteContact(db, shared.id, { leadId: 1 }), 'CONTACT_SHARED');
    assert.equal(e.status, 409);
    const out = portalContacts.deleteContact(db, shared.id, {});
    assert.equal(out.eventsRemoved, 2);
  });

  check('4d clear-resolved removes only resolved failures (lead scope honored)', () => {
    const ins = db.prepare(
      `INSERT INTO leadscout_capture_failures (kind, lead_id, error, resolved_at) VALUES ('submission', ?, 'x', ?)`
    );
    ins.run(1, '2026-10-01 00:00:00');
    ins.run(1, '2026-10-02 00:00:00');
    ins.run(2, '2026-10-01 00:00:00');
    db.prepare(`INSERT INTO leadscout_capture_failures (kind, lead_id, error) VALUES ('submission', 1, 'open')`).run();
    const out = portalContacts.clearResolvedFailures(db, { leadId: 1 });
    assert.equal(out.cleared, 2);
    const left = db.prepare('SELECT lead_id, resolved_at FROM leadscout_capture_failures ORDER BY id').all();
    assert.equal(left.length, 2);
    assert.ok(left.some((r) => r.lead_id === 2 && r.resolved_at));
    assert.ok(left.some((r) => r.lead_id === 1 && !r.resolved_at));
    const all = portalContacts.clearResolvedFailures(db, {});
    assert.equal(all.cleared, 1);
  });
}

/* ---------------- 6. B1 lead delete hardening ---------------- */
function testLeadDelete() {
  const db = makeDb();
  // Lead WITH a website + linked domain row + design job + txn.
  const lead = leadEngine.createLead(db, {
    business_name: 'Site Owner Co', category: 'Dumpster rental', phone: '(610) 555-0111',
    email: 'owner45@example.com', city: 'Reading', state: 'PA',
  });
  const lid = Number(lead.id);
  const site = addSite(db, 4501, lid, 'Site Owner Co');
  db.prepare(
    `INSERT INTO site_domains (lead_id, website_id, domain_name, status) VALUES (?, ?, 'owner45.com', 'linked')`
  ).run(lid, site.id);
  db.prepare(`INSERT INTO design_jobs (type, title, instructions, lead_id, status) VALUES ('website', 'Fixture job', 'Build it', ?, 'delivered')`).run(lid);
  domainFlow.createTransaction(db, {
    leadId: lid, domain: 'owner45.com', registrarPriceCents: 1046, registrarCurrency: 'USD', planId: 'standard',
  });

  check('6a duplicate email is refused before the delete (uniqueness live)', () => {
    throwsCode(
      () => leadEngine.createLead(db, { business_name: 'Copycat', email: 'OWNER45@example.com' }),
      'DUPLICATE_EMAIL'
    );
  });

  check('6b reference summary counts every surface', () => {
    const s = leadEngine.leadReferenceSummary(db, lid);
    assert.equal(s.websites, 1);
    assert.equal(s.websitesActive, 1);
    assert.equal(s.siteDomains, 1);
    assert.equal(s.designJobs, 1);
    assert.equal(s.domainTransactions, 1);
  });

  if (process.env.B45_NEGATIVE === '1') {
    // Negative-proof shim: the PRE-BATCH behavior — plain lead delete,
    // schema cascades do the rest, site_domains left dangling.
    db.prepare('DELETE FROM leads WHERE id = ?').run(lid);
    check('6c NEGATIVE SHIM: site_domains cleaned + summary returned', () => {
      const left = db.prepare('SELECT COUNT(*) AS c FROM site_domains WHERE lead_id = ?').get(lid).c;
      assert.equal(left, 0, 'site_domains rows must be cleaned by deleteLead');
    });
    return;
  }

  let delResult;
  check('6c deleteLead archives the site first and cleans site_domains in-tx', () => {
    delResult = leadEngine.deleteLead(db, lid);
    assert.equal(delResult.summary.websites, 1);
    assert.deepEqual(delResult.archivedWebsiteIds, [Number(site.id)]);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM site_domains WHERE lead_id = ?').get(lid).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM leads WHERE id = ?').get(lid).c, 0);
  });

  check('6d history survives: design job + domain txn rows are kept', () => {
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM design_jobs WHERE lead_id = ?').get(lid).c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM domain_transactions WHERE lead_id = ?').get(lid).c, 1);
  });

  check('6e the freed email is immediately reusable', () => {
    const again = leadEngine.createLead(db, { business_name: 'New Owner', email: 'owner45@example.com' });
    assert.ok(Number(again.id) > 0);
  });

  check('6f design-jobs-only lead deletes cleanly with a truthful summary', () => {
    const db2 = makeDb();
    const l2 = leadEngine.createLead(db2, { business_name: 'Jobs Only', email: 'jobs45@example.com' });
    db2.prepare(`INSERT INTO design_jobs (type, title, instructions, lead_id, status) VALUES ('website', 'Fixture job', 'Build it', ?, 'waiting_on_agent')`).run(Number(l2.id));
    const out = leadEngine.deleteLead(db2, Number(l2.id));
    assert.equal(out.summary.websites, 0);
    assert.equal(out.summary.designJobs, 1);
    assert.deepEqual(out.archivedWebsiteIds, []);
  });

  check('6g plain lead deletes cleanly', () => {
    const db3 = makeDb();
    const l3 = leadEngine.createLead(db3, { business_name: 'Plain', email: 'plain45@example.com' });
    const out = leadEngine.deleteLead(db3, Number(l3.id));
    assert.equal(out.summary.websites, 0);
    assert.equal(db3.prepare('SELECT COUNT(*) AS c FROM leads').get().c, 0);
  });

  check('6h an already-archived site is not re-archived but its domain rows still clean', () => {
    const db4 = makeDb();
    const l4 = leadEngine.createLead(db4, { business_name: 'Archived Co', email: 'arch45@example.com' });
    const s4 = addSite(db4, 4504, Number(l4.id), 'Archived Co');
    websiteEngine.deleteWebsite(db4, s4.id);
    db4.prepare(
      `INSERT INTO site_domains (lead_id, website_id, domain_name, status) VALUES (?, ?, 'arch45.com', 'linked')`
    ).run(Number(l4.id), s4.id);
    const out = leadEngine.deleteLead(db4, Number(l4.id));
    assert.equal(out.summary.websitesArchived, 1);
    assert.deepEqual(out.archivedWebsiteIds, []);
    assert.equal(db4.prepare('SELECT COUNT(*) AS c FROM site_domains WHERE lead_id = ?').get(Number(l4.id)).c, 0);
  });
}

/* ---------------- 7. call logs ---------------- */
function testCallLogs() {
  const db = makeDb();
  addLead(db, 1);
  const contact = portalContacts.upsertContact(db, { name: 'Caller Cal', phone: '+16105550199' });
  const insCall = db.prepare(
    `INSERT INTO call_logs (lead_id, call_sid, from_number, to_number, status, counted, transcription_billed)
     VALUES (1, ?, '+16105550199', '+12763659195', 'completed', ?, ?)`
  );
  const clean = Number(insCall.run('CA-clean', 0, 0).lastInsertRowid);
  db.prepare(`INSERT INTO leadscout_events (contact_id, lead_id, kind, call_log_id) VALUES (?, 1, 'call', ?)`).run(contact.id, clean);
  const counted = Number(insCall.run('CA-counted', 1, 0).lastInsertRowid);
  const billed = Number(insCall.run('CA-billed', 0, 1).lastInsertRowid);
  const charged = Number(insCall.run('CA-charged', 0, 0).lastInsertRowid);
  db.prepare(`INSERT INTO site_rentals (website_id, tenant_lead_id, owner_lead_id, status) VALUES (1, 2, 1, 'active')`).run();
  const rental = db.prepare('SELECT id FROM site_rentals LIMIT 1').get();
  db.prepare(
    `INSERT INTO site_rental_charges (rental_id, website_id, tenant_lead_id, call_log_id) VALUES (?, 1, 2, ?)`
  ).run(rental.id, charged);

  check('7a a clean test-call log deletes and unlinks its LeadScout event', () => {
    siteModules.deleteCallLog(db, clean);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM call_logs WHERE id = ?').get(clean).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM leadscout_events WHERE call_log_id = ?').get(clean).c, 0);
    assert.ok(db.prepare('SELECT id FROM leadscout_contacts WHERE id = ?').get(contact.id));
  });
  check('7b counted / billed / charged logs all refuse', () => {
    throwsCode(() => siteModules.deleteCallLog(db, counted), 'CALL_COUNTED');
    throwsCode(() => siteModules.deleteCallLog(db, billed), 'CALL_BILLED');
    throwsCode(() => siteModules.deleteCallLog(db, charged), 'CALL_CHARGED');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM call_logs').get().c, 3);
  });
  check('7c a missing call log is NOT_FOUND', () => {
    throwsCode(() => siteModules.deleteCallLog(db, 424242), 'NOT_FOUND');
  });
}

/* ---------------- 9. retention prunes ---------------- */
function testPrunes() {
  const db = makeDb();
  addLead(db, 1);
  const site = addSite(db, 4509, 1, 'Prune Co');
  const insVer = db.prepare(
    `INSERT INTO website_versions (website_id, version_no, pages, theme, note) VALUES (?, ?, '[]', '{}', 'v')`
  );
  for (let i = 1; i <= 55; i++) insVer.run(site.id, i);
  db.prepare(`INSERT INTO activity_log (area, message, at) VALUES ('test', 'ancient', datetime('now', '-200 days'))`).run();
  db.prepare(`INSERT INTO activity_log (area, message, at) VALUES ('test', 'fresh', datetime('now'))`).run();

  check('9a prune keeps newest 50 versions + drops >180d activity, logs once', () => {
    const out = websiteEngine.runRetentionPrunes(db);
    assert.equal(out.versionsPruned, 5);
    assert.equal(out.activityPruned, 1);
    const vers = db.prepare('SELECT MIN(version_no) AS mn, MAX(version_no) AS mx, COUNT(*) AS c FROM website_versions WHERE website_id = ?').get(site.id);
    assert.equal(vers.c, 50);
    assert.equal(vers.mn, 6);
    assert.equal(vers.mx, 55);
    const acts = db.prepare(`SELECT message FROM activity_log WHERE area = 'test'`).all();
    assert.deepEqual(acts.map((a) => a.message), ['fresh']);
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM activity_log WHERE area = 'retention'`).get().c, 1);
  });
  check('9b a kept version still restores', () => {
    const kept = db.prepare('SELECT id FROM website_versions WHERE website_id = ? AND version_no = 55').get(site.id);
    const out = websiteEngine.restoreVersion(db, kept.id);
    assert.ok(out && Number(out.id) === Number(site.id));
  });
  check('9c a second sweep prunes nothing and writes no retention row', () => {
    const out = websiteEngine.runRetentionPrunes(db);
    assert.equal(out.versionsPruned, 0);
    assert.equal(out.activityPruned, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM activity_log WHERE area = 'retention'`).get().c, 1);
  });
}

/* ---------------- 15. B5 rental failure logging ---------------- */
function testB5() {
  const db = makeDb();
  addLead(db, 7);
  const form45 = contactForms.createForm(db, 7, { name: 'Rental Form' });
  const sub = db
    .prepare(`INSERT INTO form_submissions (form_id, lead_id, payload_json, routing) VALUES (?, 7, '{}', 'inbox')`)
    .run(form45.id);
  const warnings = [];
  const realWarn = console.warn;
  const realStamp = rentals.resolveStamp;
  const realCharge = rentals.recordCaptureCharge;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    rentals.resolveStamp = () => ({ websiteId: 1, tenantLeadId: 2, rentalId: 99 });
    rentals.recordCaptureCharge = () => {
      throw new Error('boom-charge-45');
    };
    const out = portalContacts.captureFromSubmission(db, {
      leadId: 7,
      submissionId: Number(sub.lastInsertRowid),
      payload: { name: 'Rita Renter', email: 'rita@example.com' },
    });
    check('15a capture succeeds uncharged when the charge throws', () => {
      assert.ok(out && out.eventId, JSON.stringify(out));
    });
    check('15b the charge failure is logged with lead + error context', () => {
      assert.ok(
        warnings.some((w) => w.includes('rentalCharge failed') && w.includes('boom-charge-45') && w.includes('7')),
        `warnings: ${JSON.stringify(warnings)}`
      );
    });
    warnings.length = 0;
    rentals.recordCaptureCharge = realCharge;
    rentals.resolveStamp = () => {
      throw new Error('boom-stamp-45');
    };
    const sub2 = db
      .prepare(`INSERT INTO form_submissions (form_id, lead_id, payload_json, routing) VALUES (?, 7, '{}', 'inbox')`)
      .run(form45.id);
    const out2 = portalContacts.captureFromSubmission(db, {
      leadId: 7,
      submissionId: Number(sub2.lastInsertRowid),
      payload: { name: 'Stan Stamp', email: 'stan@example.com' },
    });
    check('15c capture succeeds when the stamp throws, and the stamp failure is logged', () => {
      assert.ok(out2 && out2.eventId, JSON.stringify(out2));
      assert.ok(
        warnings.some((w) => w.includes('rentalStamp failed') && w.includes('boom-stamp-45')),
        `warnings: ${JSON.stringify(warnings)}`
      );
    });
  } finally {
    console.warn = realWarn;
    rentals.resolveStamp = realStamp;
    rentals.recordCaptureCharge = realCharge;
  }
}

/* ---------------- 5. archives purge (real workspace path) ---------------- */
async function testPurge() {
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const domain = require(path.join(root, 'server/domain.js'));
  const wdb = openWorkspaceDb(1);
  wdb
    .prepare(
      `INSERT INTO leads (id, business_name, category, phone, email, city, state)
       VALUES (45, 'Purge Co', 'Services', '(610) 555-0145', 'purge45@example.com', 'Reading', 'PA')`
    )
    .run();
  const site = addSite(wdb, 4510, 45, 'Purge Co');

  await checkAsync('5a purging a live (non-archived) site refuses NOT_ARCHIVED 409', async () => {
    const e = await Promise.resolve()
      .then(() => domain.sitesPurgeSite(1, site.id, 'Purge Co'))
      .then(
        () => null,
        (err) => err
      );
    assert.ok(e && e.code === 'NOT_ARCHIVED' && e.status === 409, `got ${e && (e.code || e.message)}`);
  });
  websiteEngine.deleteWebsite(wdb, site.id); // archive it
  await checkAsync('5b a wrong confirm name refuses CONFIRM_REQUIRED and keeps the site', async () => {
    const e = await Promise.resolve()
      .then(() => domain.sitesPurgeSite(1, site.id, 'Not The Name'))
      .then(
        () => null,
        (err) => err
      );
    assert.ok(e && e.code === 'CONFIRM_REQUIRED', `got ${e && (e.code || e.message)}`);
    assert.ok(websiteEngine.getWebsite(wdb, site.id));
  });
  await checkAsync('5c the exact name purges the archived site for good', async () => {
    const out = domain.sitesPurgeSite(1, site.id, 'Purge Co');
    assert.equal(out.deleted, true);
    throwsCode(() => websiteEngine.getWebsite(wdb, site.id), 'SITE_NOT_FOUND');
  });
}

/* ---------------- 8. portal user delete (platform db) ---------------- */
async function testPortalUserDelete() {
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const clientPortal = require(path.join(root, 'server/clientPortal.js'));
  const ins = await platformDb.query(
    `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status)
     VALUES (:e, 'x', 1, 45, 'Portal Fixture', 'active')`,
    { e: 'portal45@example.com' }
  );
  const uid = Number(ins.insertId);
  await checkAsync('8a deletePortalUser removes the sign-in row', async () => {
    const out = await clientPortal.deletePortalUser(uid);
    assert.equal(out.deleted, true);
    assert.equal(await clientPortal.findById(uid), null);
  });
  await checkAsync('8b deleting again is NOT_FOUND', async () => {
    const e = await clientPortal.deletePortalUser(uid).then(
      () => null,
      (err) => err
    );
    assert.ok(e && e.code === 'NOT_FOUND', `got ${e && (e.code || e.message)}`);
  });
}

/* ---------------- wiring pins (static) ---------------- */
function testWiring() {
  const portalRoutes = fs.readFileSync(path.join(root, 'server/routes/portal.js'), 'utf8');
  const domainApi = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
  const adminRoutes = fs.readFileSync(path.join(root, 'server/routes/admin.js'), 'utf8');
  const mcp = fs.readFileSync(path.join(root, 'server/mcp.js'), 'utf8');
  check('W1 portal routes wire every new delete + pager params', () => {
    for (const needle of [
      "delete('/forms/submissions/:id'",
      "post('/forms/submissions/delete-bulk'",
      "delete('/modules/bookings/appointments/:id'",
      "delete('/modules/estimate/requests/:id'",
      "delete('/leadscout/contacts/:id'",
      "post('/leadscout/failures/clear-resolved'",
      'req.query.offset',
    ]) {
      assert.ok(portalRoutes.includes(needle), `portal.js missing: ${needle}`);
    }
  });
  check('W2 staff routes wire submission/contact/call/txn-void/purge deletes', () => {
    for (const needle of [
      "post('/admin-area/forms/:id/submissions/delete-bulk'",
      "delete('/admin-area/forms/:id/submissions/:submissionId'",
      "delete('/admin-area/leadscout/contacts/:id'",
      "delete('/admin-area/calls/:id'",
      "post('/admin-area/domain-transactions/:id/void'",
    ]) {
      assert.ok(domainApi.includes(needle), `domainApi.js missing: ${needle}`);
    }
    assert.ok(domainApi.includes("delete('/websites/:id/purge'"), 'purge route missing');
  });
  check('W3 admin router wires the portal-user delete; MCP wires both module deletes', () => {
    assert.ok(adminRoutes.includes("delete('/portal-users/:id'"), 'admin portal-user delete missing');
    assert.ok(mcp.includes("name: 'estimate.deleteRequest'"), 'MCP estimate.deleteRequest missing');
    assert.ok(mcp.includes("name: 'bookings.deleteAppointment'"), 'MCP bookings.deleteAppointment missing');
  });
  check('W4 UIs carry the new affordances', () => {
    const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    const portalJs = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
    for (const needle of ['del-contact', 'txn-void', 'data-cl-del', 'data-portal-delete', 'leadReferences', 'websitePurge', 'data-act="purge"']) {
      assert.ok(appJs.includes(needle), `app.js missing: ${needle}`);
    }
    for (const needle of ['data-sub-delete', 'subs-load-more', 'data-appt-delete', 'data-est-req-delete', 'leadscout-delete-contact', 'data-blog-next', 'members-next', 'calls-next']) {
      assert.ok(portalJs.includes(needle), `portal.js missing: ${needle}`);
    }
  });
}

(async () => {
  testSubmissions();
  testModuleDeletes();
  testVoid();
  testContacts();
  testLeadDelete();
  testCallLogs();
  testPrunes();
  testB5();
  testWiring();
  await testPurge();
  await testPortalUserDelete();
  console.log(JSON.stringify({ file: 'batch45-deletes-regressions', passed: results.length, checks: results }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
