'use strict';
/**
 * Batch 45 — pagination (audit items 10–14). The engines already spoke
 * limit/offset in places; the batch threads offset through the surfaces
 * that hard-capped (portal submissions newest-50, calls newest-200 with
 * no way past them, contacts past the fetch ceiling invisible) and adds
 * the missing engine support (call offset, blog limit/offset + COUNT).
 *
 *   10. Form submissions: 60 rows — offset page 2 returns the older 10,
 *       total is stable, pages never overlap.
 *   11. Call logs: 250 rows — listAllCalls pages of 50 walk the whole
 *       history (page 3 = rows 101–150), ordering stable, no gaps or
 *       repeats; listCalls (per-lead) honors offset the same way.
 *   12. LeadScout contacts: 120 contacts all reachable via offset.
 *   13. Blog: listBlogPosts limit/offset pages; the no-limit call still
 *       returns everything (exports depend on it); moduleItemCount now
 *       equals a real COUNT and matches the list length.
 *   14. Members + domain transactions: listSiteMembers offset walks
 *       past the first page; domainFlow.adminList reports total and
 *       pages by offset without repeats.
 *
 * Pure engine tests on in-memory sqlite. Run via
 * tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqlite';

const root = path.resolve(__dirname, '..');
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

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  websiteEngine.ensureTables(db);
  contactForms.ensureTables(db);
  siteModules.ensureTables(db);
  portalContacts.ensureTables(db);
  return db;
}

function addLead(db, id) {
  db.prepare(
    `INSERT INTO leads (id, business_name, category, phone, email, city, state)
     VALUES (?, ?, 'Services', '(610) 555-0100', ?, 'Reading', 'PA')`
  ).run(id, `Biz ${id}`, `biz${id}@example.com`);
}

const idsOf = (rows) => rows.map((r) => Number(r.id));
function assertDisjointUnion(pages, expectedTotal, label) {
  const all = pages.flatMap(idsOf);
  assert.equal(all.length, expectedTotal, `${label}: walked ${all.length}, expected ${expectedTotal}`);
  assert.equal(new Set(all).size, all.length, `${label}: pages overlap`);
}

/* ---------------- 10. submissions ---------------- */
check('10 submissions: 60 rows — page 2 holds the older 10, total stable', () => {
  const db = makeDb();
  addLead(db, 1);
  const form = contactForms.createForm(db, 1, { name: 'Inbox' });
  const ins = db.prepare(
    `INSERT INTO form_submissions (form_id, lead_id, payload_json, routing) VALUES (?, 1, '{}', 'inbox')`
  );
  for (let i = 0; i < 60; i++) ins.run(form.id);
  const p1 = contactForms.listSubmissions(db, 1, { limit: 50, offset: 0, formId: form.id });
  const p2 = contactForms.listSubmissions(db, 1, { limit: 50, offset: 50, formId: form.id });
  assert.equal(p1.total, 60);
  assert.equal(p2.total, 60);
  assert.equal(p1.submissions.length, 50);
  assert.equal(p2.submissions.length, 10);
  assertDisjointUnion([p1.submissions, p2.submissions], 60, 'submissions');
  // Newest first: page 1 holds the highest ids.
  assert.ok(Math.min(...idsOf(p1.submissions)) > Math.max(...idsOf(p2.submissions)));
});

/* ---------------- 11. call logs ---------------- */
check('11 calls: 250 rows — page 3 reachable, full walk has no gaps/repeats', () => {
  const db = makeDb();
  addLead(db, 1);
  addLead(db, 2);
  const ins = db.prepare(
    `INSERT INTO call_logs (lead_id, call_sid, from_number, to_number, status) VALUES (?, ?, '+16105550100', '+12763659195', 'completed')`
  );
  for (let i = 0; i < 250; i++) ins.run(1, `CA-page-${i}`);
  for (let i = 0; i < 5; i++) ins.run(2, `CA-other-${i}`);

  const pages = [];
  for (let off = 0; off < 250; off += 50) {
    pages.push(siteModules.listAllCalls(db, { limit: 50, offset: off, leadId: 1 }));
  }
  assert.equal(pages.length, 5);
  assert.equal(pages[2].length, 50, 'page 3 (offset 100) must return rows 101–150');
  assertDisjointUnion(pages, 250, 'listAllCalls');
  // Ordering is stable newest-first across pages.
  const flat = pages.flatMap(idsOf);
  assert.deepEqual(flat, [...flat].sort((a, b) => b - a));

  const mine = siteModules.listCalls(db, 1, { limit: 100, offset: 200 });
  assert.equal(mine.length, 50);
  assert.ok(idsOf(mine).every((id) => !pages[0].some((r) => Number(r.id) === id)));
});

/* ---------------- 12. contacts ---------------- */
check('12 contacts: 120 rows all reachable via offset (staff + portal ceilings lifted)', () => {
  const db = makeDb();
  addLead(db, 1);
  for (let i = 0; i < 120; i++) {
    const c = portalContacts.upsertContact(db, {
      name: `Contact ${i}`,
      email: `contact${i}@example.com`,
    });
    db.prepare(`INSERT INTO leadscout_events (contact_id, lead_id, kind) VALUES (?, 1, 'submission')`).run(c.id);
  }
  const staff1 = portalContacts.listContacts(db, { limit: 100, offset: 0 });
  const staff2 = portalContacts.listContacts(db, { limit: 100, offset: 100 });
  assert.equal(staff1.length, 100);
  assert.equal(staff2.length, 20);
  assertDisjointUnion([staff1, staff2], 120, 'staff contacts');
  const portal1 = portalContacts.listContacts(db, { leadId: 1, limit: 80, offset: 0 });
  const portal2 = portalContacts.listContacts(db, { leadId: 1, limit: 80, offset: 80 });
  assert.equal(portal1.length, 80);
  assert.equal(portal2.length, 40);
  assertDisjointUnion([portal1, portal2], 120, 'portal contacts');
});

/* ---------------- 13. blog ---------------- */
check('13 blog: limit/offset pages, no-limit returns all, count parity', () => {
  const db = makeDb();
  addLead(db, 1);
  const ins = db.prepare(
    `INSERT INTO blog_posts (lead_id, title, slug, status) VALUES (1, ?, ?, 'published')`
  );
  for (let i = 0; i < 14; i++) ins.run(`Post ${i}`, `post-${i}`);
  const all = siteModules.listBlogPosts(db, 1, {});
  assert.equal(all.length, 14, 'no-limit list must stay whole for exports');
  const p1 = siteModules.listBlogPosts(db, 1, { limit: 6, offset: 0 });
  const p2 = siteModules.listBlogPosts(db, 1, { limit: 6, offset: 6 });
  const p3 = siteModules.listBlogPosts(db, 1, { limit: 6, offset: 12 });
  assert.deepEqual([p1.length, p2.length, p3.length], [6, 6, 2]);
  assertDisjointUnion([p1, p2, p3], 14, 'blog pages');
  assert.equal(siteModules.countBlogPosts(db, 1), 14);
  assert.equal(siteModules.moduleItemCount(db, 1, 'blog'), 14);
});

/* ---------------- 14. members + domain transactions ---------------- */
check('14a members: offset walks past page 1', () => {
  const db = makeDb();
  addLead(db, 1);
  const ins = db.prepare(
    `INSERT INTO site_members (lead_id, email, name, password_hash, status) VALUES (1, ?, ?, 'x', 'active')`
  );
  for (let i = 0; i < 70; i++) ins.run(`member${i}@example.com`, `Member ${i}`);
  const p1 = siteModules.listSiteMembers(db, 1, { limit: 50, offset: 0 });
  const p2 = siteModules.listSiteMembers(db, 1, { limit: 50, offset: 50 });
  assert.equal(p1.length, 50);
  assert.equal(p2.length, 20);
  assert.equal(siteModules.countSiteMembers(db, 1).total, 70);
  assertDisjointUnion([p1, p2], 70, 'members');
});

check('14b domain transactions: adminList total + offset pages', () => {
  const db = makeDb();
  addLead(db, 1);
  for (let i = 0; i < 5; i++) {
    domainFlow.createTransaction(db, {
      leadId: 1,
      domain: `page-${i}.com`,
      registrarPriceCents: 1046,
      registrarCurrency: 'USD',
      planId: 'standard',
    });
  }
  const p1 = domainFlow.adminList(db, { limit: 2, offset: 0 });
  const p2 = domainFlow.adminList(db, { limit: 2, offset: 2 });
  const p3 = domainFlow.adminList(db, { limit: 2, offset: 4 });
  assert.equal(p1.total, 5);
  assert.equal(p2.total, 5);
  assert.deepEqual(
    [p1.transactions.length, p2.transactions.length, p3.transactions.length],
    [2, 2, 1]
  );
  assertDisjointUnion([p1.transactions, p2.transactions, p3.transactions], 5, 'txns');
});

console.log(JSON.stringify({ file: 'batch45-pagination-regressions', passed: results.length, checks: results }, null, 2));
