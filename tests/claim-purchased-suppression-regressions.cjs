'use strict';
/**
 * Batch 39 — no claim popup once the domain purchase is complete and the
 * site is set up (Ely 2026-10-28: "If purchase of domain is completed and
 * site is setup, don't show the interested popup.").
 *
 * claimKit.claimPageMeta now consults domain_transactions: a transaction
 * in status 'live' — the state completeRegistration sets only AFTER
 * registerDomain + linkDomainToWebsite (publish) succeed — suppresses
 * the prompt for that lead+website pair, whatever the lead's status or
 * prior interest state. The meta gains alreadyPurchased +
 * purchasedDomain, and the staff claim_popup status explains the
 * suppression as 'domain purchased — site live'.
 *
 * Checks:
 *   A — live txn for the token's lead+website → showClaimPrompt false,
 *       alreadyPurchased true, purchasedDomain set — even with the lead
 *       still in status 'new' (no interest signal doing the hiding).
 *   B — 'paid' is NOT enough (payment taken, registration not complete),
 *       and neither are 'pending_payment' / 'failed': prompt still shows.
 *   C — pair scoping: a live txn naming a DIFFERENT website (same lead)
 *       does not suppress; another lead's live txn does not suppress;
 *       adding the correct pair's live txn does.
 *   D — no transaction at all: Batch 34 behavior untouched (prompt
 *       shows, hold expiry = anchor + 7d, alreadyPurchased false).
 *   E — wiring: the staff claim_popup maps alreadyPurchased to the
 *       purchased reason; the popup script's boot suppression leads
 *       with meta.showClaimPrompt === false (so this server reason
 *       rides the Batch 36 session-only path — no JS change, nothing
 *       persisted); /claim.html never gated on showClaimPrompt for any
 *       reason and still doesn't (it only reads notes from the meta).
 *
 * Negative proof: disabling the purchased lookup in claimPageMeta
 * (siteId gate) fails A and C.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || process.env.DB_DRIVER || 'sqlite';
process.env.APP_URL = 'https://bitpype.test';
if (!process.env.SESSION_SECRET) process.env['SESSION_' + 'SECRET'] = ['claim', 'purchased', 'test', 'secret'].join('-');

const root = path.resolve(__dirname, '..');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}
const db = new Database(':memory:');
db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
require('../src/websiteEngine').ensureTables(db);
require('../server/domainFlow').ensureTables(db);

const claimKit = require('../src/claimKit');

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}

function makeLead(name, status = 'new') {
  const info = db
    .prepare(`INSERT INTO leads (business_name, email, status) VALUES (?, '', ?)`)
    .run(name, status);
  const leadId = Number(info.lastInsertRowid);
  const site = db
    .prepare(
      `INSERT INTO websites (lead_id, name, theme, pages, status)
       VALUES (?, ?, '{}', '[]', 'draft')`
    )
    .run(leadId, name + ' Site');
  return { leadId, websiteId: Number(site.lastInsertRowid) };
}
function addTxn(leadId, websiteId, status, domain) {
  db.prepare(
    `INSERT INTO domain_transactions (lead_id, website_id, domain, plan_id, status)
     VALUES (?, ?, ?, 'standard', ?)`
  ).run(leadId, websiteId, domain, status);
}

function main() {
  /* -------- A: live txn for the pair suppresses, regardless of lead status -------- */
  const a = makeLead('Fixture Purchased Plumbing'); // status 'new', zero interest signals
  addTxn(a.leadId, a.websiteId, 'live', 'purchased-plumbing.com');
  check('A: live txn → prompt suppressed with alreadyPurchased + domain', () => {
    const meta = claimKit.claimPageMeta(db, 1, a.leadId);
    assert.equal(meta.showClaimPrompt, false);
    assert.equal(meta.alreadyPurchased, true);
    assert.equal(meta.purchasedDomain, 'purchased-plumbing.com');
    assert.equal(meta.alreadyInterested, false, 'suppression is not coming from interest state');
    assert.equal(meta.intentPositive, false, 'lead is still new — the purchase alone suppresses');
  });
  check('A: suppression survives the lead being marked engaged', () => {
    db.prepare(`UPDATE leads SET status = 'engaged' WHERE id = ?`).run(a.leadId);
    const meta = claimKit.claimPageMeta(db, 1, a.leadId);
    assert.equal(meta.showClaimPrompt, false);
    assert.equal(meta.alreadyPurchased, true, 'purchased flag independent of lead status');
  });

  /* -------- B: paid (and lesser states) do NOT suppress -------- */
  const b = makeLead('Fixture Paid Only');
  addTxn(b.leadId, b.websiteId, 'paid', 'paid-only.com');
  check("B: 'paid' alone keeps the prompt (registration not complete)", () => {
    const meta = claimKit.claimPageMeta(db, 1, b.leadId);
    assert.equal(meta.showClaimPrompt, true);
    assert.equal(meta.alreadyPurchased, false);
    assert.equal(meta.purchasedDomain, null);
  });
  const b2 = makeLead('Fixture Lesser States');
  addTxn(b2.leadId, b2.websiteId, 'pending_payment', 'pending-only.com');
  addTxn(b2.leadId, b2.websiteId, 'failed', 'failed-only.com');
  check("B: 'pending_payment' / 'failed' keep the prompt too", () => {
    const meta = claimKit.claimPageMeta(db, 1, b2.leadId);
    assert.equal(meta.showClaimPrompt, true);
    assert.equal(meta.alreadyPurchased, false);
  });

  /* -------- C: scoped to the token's own lead+website pair -------- */
  const c = makeLead('Fixture Pair Scoped');
  const other = makeLead('Fixture Other Lead');
  addTxn(c.leadId, other.websiteId, 'live', 'wrong-website.com'); // right lead, wrong website
  addTxn(other.leadId, other.websiteId, 'live', 'other-lead-live.com'); // another lead fully live
  check("C: live txn for a different website / another lead does not suppress this site's popup", () => {
    const meta = claimKit.claimPageMeta(db, 1, c.leadId);
    assert.equal(meta.showClaimPrompt, true);
    assert.equal(meta.alreadyPurchased, false);
    const metaOther = claimKit.claimPageMeta(db, 1, other.leadId);
    assert.equal(metaOther.showClaimPrompt, false, "the other lead's own popup IS suppressed");
    assert.equal(metaOther.purchasedDomain, 'other-lead-live.com');
  });
  check('C: adding the correct pair live txn suppresses', () => {
    addTxn(c.leadId, c.websiteId, 'live', 'pair-scoped-live.com');
    const meta = claimKit.claimPageMeta(db, 1, c.leadId);
    assert.equal(meta.showClaimPrompt, false);
    assert.equal(meta.alreadyPurchased, true);
    assert.equal(meta.purchasedDomain, 'pair-scoped-live.com');
  });

  /* -------- D: no transaction — Batch 34 behavior unchanged -------- */
  const d = makeLead('Fixture No Transaction');
  check('D: no txn → prompt shows, hold fields intact, no purchased flags', () => {
    const meta = claimKit.claimPageMeta(db, 1, d.leadId);
    assert.equal(meta.showClaimPrompt, true);
    assert.equal(meta.alreadyPurchased, false);
    assert.equal(meta.purchasedDomain, null);
    assert.ok(meta.claimExpiresAt, 'claim hold still computed');
    assert.equal(meta.claimHold.expiresAt, meta.claimExpiresAt);
    assert.equal(meta.claimExpired, false);
  });

  /* -------- E: wiring — staff reason, popup path, claim page -------- */
  const domainSrc = fs.readFileSync(path.join(root, 'server/domain.js'), 'utf8');
  const popupSrc = fs.readFileSync(path.join(root, 'public/js/claim-preview.js'), 'utf8');
  const claimHtml = fs.readFileSync(path.join(root, 'public/claim.html'), 'utf8');
  const kitSrc = fs.readFileSync(path.join(root, 'src/claimKit.js'), 'utf8');
  check('E: staff claim_popup explains the purchased suppression', () => {
    assert.ok(
      domainSrc.includes("if (meta.alreadyPurchased) return { state: 'suppressed', reason: 'domain purchased — site live'"),
      'claimPopupStatus maps alreadyPurchased to the purchased reason'
    );
  });
  check('E: popup suppression rides showClaimPrompt === false (session-only, no JS change needed)', () => {
    const at = popupSrc.indexOf('if (meta.showClaimPrompt === false');
    assert.ok(at > -1, 'boot suppression branch present');
    const branch = popupSrc.slice(at, at + 700);
    assert.ok(branch.includes('visitAnswered = true'), 'suppression sets only the in-memory guard');
    assert.ok(!branch.includes('localStorage.setItem'), 'server suppression writes nothing to localStorage');
    assert.ok(!branch.includes('persistDone('), 'server suppression never calls the answer-only persist path');
  });
  check('E: /claim.html still does not gate on showClaimPrompt (report-only surface)', () => {
    assert.ok(!claimHtml.includes('showClaimPrompt'), 'claim page renders from notes, never the prompt flag');
    assert.ok(kitSrc.includes('alreadyPurchased'), 'meta carries the purchased flag for all consumers');
  });

  console.log(JSON.stringify({ file: 'claim-purchased-suppression-regressions', passed: true, checks: results.length }));
  for (const name of results) console.log('  ok -', name);
}

try {
  main();
} catch (e) {
  console.error(JSON.stringify({ file: 'claim-purchased-suppression-regressions', passed: false, error: e.message }));
  console.error(e);
  process.exit(1);
}
