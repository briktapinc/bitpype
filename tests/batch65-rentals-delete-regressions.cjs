'use strict';
/**
 * Batch 65 — Rentals admin: Clear-all placement + per-record delete.
 *
 *   D1 engine happy path: an ENDED rental with only settled charges
 *      ('charged'/'trial') deletes — rental row + ALL its charge rows
 *      go, charges_removed is reported; the website row and the tenant
 *      lead are untouched; capture rows STAMPED with the rental id in
 *      other tables (leadscout_events, call_logs) are the tenant's
 *      lead history (a snapshot by design, rentals module header) and
 *      survive — the only tables the rental owns are site_rentals +
 *      site_rental_charges.
 *   D2 engine refusals: trial/active → RENTAL_ACTIVE; paused →
 *      RENTAL_NOT_ENDED; missing → NOT_FOUND. Nothing is deleted by a
 *      refusal.
 *   D3 money guard: an ended rental with a 'due' charge refuses with
 *      RENTAL_CHARGES_OPEN — the message names the amount owed and
 *      error.details carries the breakdown; 'pending' and 'charging'
 *      charges refuse too. Rental + charges survive every refusal.
 *   D4 facade: domain.adminDeleteRental returns the snapshot, writes
 *      ONE activity_log row (area 'rentals', actor + site/tenant +
 *      amounts), and a refused delete writes NO activity row.
 *   D5 agreement: clear-all (Batch 51) and the per-record delete apply
 *      the same guard to identical fixtures — what one blocks, the
 *      other blocks; what one deletes, the other deletes.
 *   D6 roles (real middleware): requireRole('owner','admin') refuses
 *      member + token roles; denyLeadScopedToken refuses a lead-scoped
 *      token and passes sessions/unscoped tokens.
 *   D7 placement + UI pins (static): Clear all… now lives in the
 *      page-head .page-actions (the Forms/Bookings sibling pattern),
 *      NOT inside the "All rentals" card header; the filter input stays
 *      in the card header; rows render a Delete button only for ended
 *      rentals; the detail panel renders Delete for ended rentals;
 *      api.js exposes adminRentalDelete.
 *   D8 MCP pins: rentals.delete tool is defined, allow-listed and
 *      dispatched to domain.adminDeleteRental.
 *
 *   NEGATIVE PROOF: B65_NEGATIVE=1 replaces rentals.deleteEndedRental
 *   with a guard-free raw delete — the refusal checks (D2/D3/D5) MUST
 *   fail (verified: the run dies at D2's RENTAL_ACTIVE expectation).
 *
 * Engine tests on in-memory sqlite + facade tests on a temp on-disk
 * workspace (openWorkspaceDb), following the Batch 51 harness.
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b65-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
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
const rentals = require(path.join(root, 'server/rentals.js'));

if (process.env.B65_NEGATIVE === '1') {
  // NEGATIVE PROOF shim: a guard-free rental delete (raw row deletes,
  // no status check, no open-charge check). The D3/D5 refusal checks
  // MUST fail under this shim — run manually to verify, then unset.
  rentals.deleteEndedRental = (db, rentalId) => {
    rentals.ensureRentals(db);
    const rental = rentals.getRental(db, rentalId);
    if (!rental) {
      const e = new Error('Rental not found');
      e.code = 'NOT_FOUND';
      e.status = 404;
      throw e;
    }
    const n = db.prepare('SELECT COUNT(*) AS c FROM site_rental_charges WHERE rental_id = ?').get(Number(rentalId)).c;
    db.prepare('DELETE FROM site_rental_charges WHERE rental_id = ?').run(Number(rentalId));
    db.prepare('DELETE FROM site_rentals WHERE id = ?').run(Number(rentalId));
    return { deleted: true, id: Number(rentalId), charges_removed: Number(n) };
  };
}

const results = [];
function check(name, fn) {
  fn();
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

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  websiteEngine.ensureTables(db);
  require(path.join(root, 'src/cfDomains.js')).ensureTables(db);
  contactForms.ensureTables(db);
  siteModules.ensureTables(db);
  portalContacts.ensureTables(db);
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
function addWebsite(db, id, leadId) {
  db.prepare(
    `INSERT INTO websites (id, lead_id, name, industry, theme, pages, status, preview_url, updated_at)
     VALUES (?, ?, ?, 'Services', '{}', '[]', 'published', '', datetime('now'))`
  ).run(id, leadId, `Site ${id}`);
  return id;
}
function addRental(db, { websiteId, tenantId, ownerId = 1, status = 'ended', model = 'per_lead', priceCents = 2500 }) {
  return Number(
    db
      .prepare(
        `INSERT INTO site_rentals (website_id, tenant_lead_id, owner_lead_id, model, price_cents, status, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(websiteId, tenantId, ownerId, model, priceCents, status, status === 'ended' ? '2026-10-01 00:00:00' : null)
      .lastInsertRowid
  );
}
function addCharge(db, rentalId, { websiteId, tenantId, status, amountDueCents = 0, credits = 0 }) {
  return Number(
    db
      .prepare(
        `INSERT INTO site_rental_charges (rental_id, website_id, tenant_lead_id, status, amount_due_cents, credits_debited)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(rentalId, websiteId, tenantId, status, amountDueCents, credits).lastInsertRowid
  );
}
const rentalRow = (db, id) => db.prepare('SELECT * FROM site_rentals WHERE id = ?').get(id);
const chargeCount = (db, rentalId) =>
  db.prepare('SELECT COUNT(*) AS c FROM site_rental_charges WHERE rental_id = ?').get(rentalId).c;

/* ---------------- D1–D3. engine ---------------- */
function testEngine() {
  const db = makeDb();
  addLead(db, 1);
  addLead(db, 65);
  addWebsite(db, 6500, 1);

  // D1 — ended + settled charges only.
  const clean = addRental(db, { websiteId: 6500, tenantId: 65 });
  addCharge(db, clean, { websiteId: 6500, tenantId: 65, status: 'charged', credits: 25 });
  addCharge(db, clean, { websiteId: 6500, tenantId: 65, status: 'trial' });
  // Capture rows stamped with the rental id (tenant history snapshots).
  const contactId = Number(
    db.prepare(`INSERT INTO leadscout_contacts (name, email, phone) VALUES ('C', 'stamp65@example.com', '')`).run()
      .lastInsertRowid
  );
  const evId = Number(
    db
      .prepare(
        `INSERT INTO leadscout_events (contact_id, lead_id, kind, website_id, tenant_lead_id, rental_id)
         VALUES (?, 65, 'submission', 6500, 65, ?)`
      )
      .run(contactId, clean).lastInsertRowid
  );
  const callId = Number(
    db
      .prepare(`INSERT INTO call_logs (lead_id, call_sid, counted, website_id, tenant_lead_id, rental_id) VALUES (65, 'CA65-clean', 1, 6500, 65, ?)`)
      .run(clean).lastInsertRowid
  );
  check('D1 ended rental deletes: record + charges go; site, lead and stamped history stay', () => {
    const out = rentals.deleteEndedRental(db, clean);
    assert.equal(out.deleted, true);
    assert.equal(out.id, clean);
    assert.equal(out.charges_removed, 2);
    assert.equal(rentalRow(db, clean), undefined);
    assert.equal(chargeCount(db, clean), 0);
    assert.ok(db.prepare('SELECT id FROM websites WHERE id = 6500').get(), 'website row must survive');
    assert.ok(db.prepare('SELECT id FROM leads WHERE id = 65').get(), 'tenant lead must survive');
    assert.ok(db.prepare('SELECT id FROM leadscout_events WHERE id = ? AND rental_id = ?').get(evId, clean), 'stamped leadscout event is tenant history — survives');
    assert.ok(db.prepare('SELECT id FROM call_logs WHERE id = ? AND rental_id = ?').get(callId, clean), 'stamped call log is tenant history — survives');
  });

  // D2 — status refusals.
  const active = addRental(db, { websiteId: 6500, tenantId: 65, status: 'active' });
  const trial = addRental(db, { websiteId: 6501, tenantId: 65, status: 'trial' });
  const paused = addRental(db, { websiteId: 6502, tenantId: 65, status: 'paused' });
  check('D2 live/paused/missing rentals refuse with the model codes and delete nothing', () => {
    throwsCode(() => rentals.deleteEndedRental(db, active), 'RENTAL_ACTIVE');
    throwsCode(() => rentals.deleteEndedRental(db, trial), 'RENTAL_ACTIVE');
    throwsCode(() => rentals.deleteEndedRental(db, paused), 'RENTAL_NOT_ENDED');
    throwsCode(() => rentals.deleteEndedRental(db, 999999), 'NOT_FOUND');
    assert.ok(rentalRow(db, active) && rentalRow(db, trial) && rentalRow(db, paused));
  });

  // D3 — money guard, one charge state at a time.
  const dueRental = addRental(db, { websiteId: 6500, tenantId: 65 });
  addCharge(db, dueRental, { websiteId: 6500, tenantId: 65, status: 'due', amountDueCents: 2500 });
  const pendRental = addRental(db, { websiteId: 6500, tenantId: 65 });
  addCharge(db, pendRental, { websiteId: 6500, tenantId: 65, status: 'pending' });
  const chargingRental = addRental(db, { websiteId: 6500, tenantId: 65 });
  addCharge(db, chargingRental, { websiteId: 6500, tenantId: 65, status: 'charging' });
  check('D3 open charges block with amounts named; nothing is deleted', () => {
    const eDue = throwsCode(() => rentals.deleteEndedRental(db, dueRental), 'RENTAL_CHARGES_OPEN');
    assert.match(eDue.message, /unsettled charges/i);
    assert.match(eDue.message, /\$25\.00/);
    assert.equal(eDue.details.amountDueCents, 2500);
    assert.equal(eDue.details.due, 1);
    assert.equal(eDue.status, 409);
    const ePend = throwsCode(() => rentals.deleteEndedRental(db, pendRental), 'RENTAL_CHARGES_OPEN');
    assert.equal(ePend.details.pending, 1);
    assert.equal(ePend.details.openCharges, 1);
    const eChg = throwsCode(() => rentals.deleteEndedRental(db, chargingRental), 'RENTAL_CHARGES_OPEN');
    assert.equal(eChg.details.charging, 1);
    for (const id of [dueRental, pendRental, chargingRental]) {
      assert.ok(rentalRow(db, id), `rental ${id} must survive its refusal`);
    assert.equal(chargeCount(db, id), 1);
    }
  });
}

/* ---------------- D4–D5. facade (temp on-disk workspace) ---------------- */
let wdb;
let domain;
function wsFixtures() {
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  domain = require(path.join(root, 'server/domain.js'));
  wdb = openWorkspaceDb(1);
  contactForms.ensureTables(wdb);
  siteModules.ensureTables(wdb);
  portalContacts.ensureTables(wdb);
  rentals.ensureRentals(wdb);
  addLead(wdb, 1);
  addLead(wdb, 651);
  addWebsite(wdb, 65100, 1);
}

function testFacade() {
  const clean = addRental(wdb, { websiteId: 65100, tenantId: 651 });
  addCharge(wdb, clean, { websiteId: 65100, tenantId: 651, status: 'charged', credits: 25 });
  addCharge(wdb, clean, { websiteId: 65100, tenantId: 651, status: 'trial' });
  check('D4 facade delete: snapshot + audit row + rows gone', () => {
    const out = domain.adminDeleteRental(1, clean, { actor: 'qa@example.com' });
    assert.equal(out.deleted, true);
    assert.equal(out.charges_removed, 2);
    assert.equal(out.snapshot.rental_id, clean);
    assert.equal(out.snapshot.site_name, 'Site 65100');
    assert.equal(out.snapshot.tenant_name, 'Biz 651');
    assert.equal(out.snapshot.status, 'ended');
    assert.equal(out.snapshot.charged_credits, 25);
    assert.equal(out.snapshot.amount_due_cents, 0);
    assert.equal(rentalRow(wdb, clean), undefined);
    assert.equal(chargeCount(wdb, clean), 0);
    assert.ok(wdb.prepare('SELECT id FROM leads WHERE id = 651').get(), 'tenant lead intact');
    const log = wdb
      .prepare(`SELECT message FROM activity_log WHERE area = 'rentals' AND message LIKE ?`)
      .get(`%deleted rental #${clean}%`);
    assert.ok(log, 'activity_log audit row missing');
    assert.match(log.message, /qa@example\.com/);
    assert.match(log.message, /Site 65100 → Biz 651/);
  });
  check('D4b facade: missing rental is NOT_FOUND; refused delete writes no audit row', () => {
    throwsCode(() => domain.adminDeleteRental(1, 999999, { actor: 'qa@example.com' }), 'NOT_FOUND');
    const blocked = addRental(wdb, { websiteId: 65100, tenantId: 651 });
    addCharge(wdb, blocked, { websiteId: 65100, tenantId: 651, status: 'due', amountDueCents: 1000 });
    throwsCode(() => domain.adminDeleteRental(1, blocked, { actor: 'qa@example.com' }), 'RENTAL_CHARGES_OPEN');
    assert.ok(rentalRow(wdb, blocked), 'blocked rental survives the facade refusal');
    const log = wdb
      .prepare(`SELECT message FROM activity_log WHERE area = 'rentals' AND message LIKE ?`)
      .get(`%deleted rental #${blocked}%`);
    assert.equal(log, undefined, 'a refused delete must not write an audit row');
    // Leave the blocked fixture in place for D5's clear-all agreement.
    testFacade.blockedId = blocked;
  });
}

function testAgreement() {
  const blockedId = testFacade.blockedId;
  const clean2 = addRental(wdb, { websiteId: 65100, tenantId: 651 });
  addCharge(wdb, clean2, { websiteId: 65100, tenantId: 651, status: 'charged', credits: 10 });
  check('D5 clear-all and per-record delete agree on identical money states', () => {
    const out = domain.adminClearAllRentals(1, { confirm: 'DELETE' });
    // clean2 is deleted by clear-all; the due-blocked rental is skipped
    // with the same reason the per-record facade refused it with.
    assert.equal(rentalRow(wdb, clean2), undefined, 'clear-all deletes the clean ended rental');
    assert.ok(rentalRow(wdb, blockedId), 'clear-all keeps the due-blocked rental');
    const skip = (out.skipped || []).find((s) => Number(s.id) === Number(blockedId));
    assert.ok(skip, 'clear-all must report the blocked rental as skipped');
    assert.match(skip.reason, /unsettled charges/i);
    assert.match(skip.reason, /\$10\.00/);
  });
}

/* ---------------- D6. roles (real middleware) ---------------- */
function fakeRes() {
  return {
    statusCode: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json() {
      return this;
    },
  };
}
function testRoles() {
  const { requireRole, denyLeadScopedToken } = require(path.join(root, 'server/middleware.js'));
  check('D6 requireRole(owner, admin): member + token refused, owner/admin pass', () => {
    const mw = requireRole('owner', 'admin');
    for (const role of ['member', 'token']) {
      const res = fakeRes();
      let nexted = false;
      mw({ auth: { role } }, res, () => {
        nexted = true;
      });
      assert.equal(nexted, false, `role ${role} must not pass`);
      assert.equal(res.statusCode, 403);
    }
    for (const role of ['owner', 'admin']) {
      const res = fakeRes();
      let nexted = false;
      mw({ auth: { role } }, res, () => {
        nexted = true;
      });
      assert.equal(nexted, true, `role ${role} must pass`);
    }
  });
  check('D6b denyLeadScopedToken: lead-scoped token refused, session + unscoped token pass', () => {
    let res = fakeRes();
    let nexted = false;
    denyLeadScopedToken({ auth: { via: 'token', leadId: 651 } }, res, () => {
      nexted = true;
    });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
    for (const auth of [{ via: 'session', userId: 1 }, { via: 'token', leadId: null }]) {
      res = fakeRes();
      nexted = false;
      denyLeadScopedToken({ auth }, res, () => {
        nexted = true;
      });
      assert.equal(nexted, true);
    }
  });
}

/* ---------------- D7–D8. static pins ---------------- */
function testPins() {
  const domainApi = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const apiJs = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
  const mcpJs = fs.readFileSync(path.join(root, 'server/mcp.js'), 'utf8');
  check('D7 route pin: DELETE /admin-area/rentals/:id is owner/admin + denyLeadScopedToken', () => {
    assert.ok(
      domainApi.includes("router.delete('/admin-area/rentals/:id', requireRole('owner', 'admin'), denyLeadScopedToken"),
      'guarded rental DELETE route missing'
    );
    assert.ok(domainApi.includes('domain.adminDeleteRental(req.auth.workspaceId'), 'route must call the facade');
  });
  check('D7b placement pin: Clear all lives in page-actions, not the card header', () => {
    const headIdx = appJs.indexOf('<h1>Rentals</h1>');
    const actionsIdx = appJs.indexOf('page-actions', headIdx);
    const clearIdx = appJs.indexOf('id="rent-clear-all"', headIdx);
    const cardIdx = appJs.indexOf('All rentals', headIdx);
    assert.ok(headIdx > -1 && actionsIdx > headIdx, 'Rentals page-head must carry .page-actions (sibling pattern)');
    assert.ok(clearIdx > actionsIdx && clearIdx < cardIdx, 'rent-clear-all must sit inside page-actions, before the All rentals card');
    const headerBlock = appJs.slice(cardIdx, appJs.indexOf('rent-rows', cardIdx));
    assert.ok(!headerBlock.includes('rent-clear-all'), 'the card header must no longer carry the Clear all button');
    assert.ok(headerBlock.includes('id="rent-filter"'), 'the filter input stays in the card header');
  });
  check('D7c row + detail pins: Delete renders for ended rentals only, with confirm copy', () => {
    assert.ok(appJs.includes('data-rent-del'), 'row Delete button missing');
    assert.ok(appJs.includes("r.status === 'ended' ? ` <button class=\"btn small danger\" data-rent-del="), 'row Delete must be gated on ended status');
    assert.ok(appJs.includes('id="rent-delete"'), 'detail Delete button missing');
    assert.ok(appJs.includes('permanently removes the ended rental and its charge history'), 'confirm copy missing');
    assert.ok(apiJs.includes("adminRentalDelete: (id) => del('/admin-area/rentals/' + id)"), 'api.js adminRentalDelete missing');
  });
  check('D8 MCP pins: rentals.delete defined, allow-listed, dispatched', () => {
    assert.ok(mcpJs.includes("name: 'rentals.delete'"), 'rentals.delete tool definition missing');
    assert.ok(mcpJs.includes("'rentals.delete',"), 'rentals.delete missing from the tool allow-list');
    assert.ok(mcpJs.includes("if (name === 'rentals.delete')"), 'rentals.delete dispatch missing');
    assert.ok(mcpJs.includes('domain.adminDeleteRental(ws, rentalId'), 'dispatch must call the facade');
  });
}

(async () => {
  testEngine();
  wsFixtures();
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  testFacade();
  testAgreement();
  testRoles();
  testPins();
  console.log(`batch65-rentals-delete-regressions: ${results.length} checks passed`);
  for (const r of results) console.log('  ✓', r);
})().catch((e) => {
  console.error('batch65 FAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
