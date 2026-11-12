'use strict';
/**
 * Batch 34 — 7-day claim hold on the preview claim ("interest") popup.
 *
 * Every claim popup now carries an expiry = preview anchor + 7 days,
 * rendered as an absolute date ("Yours to claim until Tuesday, Nov 3,
 * 2026") + a live countdown, with the primary CTA relabeled
 * "Get it now!" (same interested action / funnel). The anchor is the
 * preview's build time — earliest websites.created_at for the lead —
 * persisted in workspace settings on first computation so re-exports,
 * re-publishes and repeat visits can NEVER reset or extend it.
 *
 * Checks:
 *   A — expiry = anchor + 7 days exactly; label/remaining fields sane.
 *   B — stability: repeat meta reads, a popup re-injection, and even a
 *       websites.created_at rewrite all leave the expiry untouched
 *       (the persisted anchor wins).
 *   C — the shipped popup script carries the expiry date line, the
 *       countdown element, the expired-hold copy, and "Get it now!"
 *       bound to the SAME decide('interested') action; the injected
 *       snippet loads claim-preview.js?v=9 (v8 bumped by Batch 36; v9 by Batch 184 for the daily display cap).
 *   D — a fixture whose hold already ended renders the expired state
 *       (claimExpired, prompt still shown) and the claim action still
 *       posts through applyClaimResponse → engaged + interested event.
 *   E — the staff surface carries the expiry: server/domain.js
 *       claim_popup {expires_at, expired, days_remaining} + the
 *       website-detail rendering of the hold dates.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || process.env.DB_DRIVER || 'sqlite';
process.env.APP_URL = 'https://bitpype.test';
if (!process.env.SESSION_SECRET) process.env['SESSION_' + 'SECRET'] = ['claim', 'hold', 'test', 'secret'].join('-');

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

const claimKit = require('../src/claimKit');
const outreach = require('../src/outreach');

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function acheck(name, fn) {
  await fn();
  results.push(name);
}

const DAY = 24 * 60 * 60 * 1000;
const sqliteUtc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

function makeLead(name, siteCreatedAt) {
  const info = db
    .prepare(`INSERT INTO leads (business_name, email, status) VALUES (?, ?, 'new')`)
    .run(name, '');
  const leadId = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO websites (lead_id, name, theme, pages, status, created_at)
     VALUES (?, ?, '{}', '[]', 'draft', ?)`
  ).run(leadId, name, sqliteUtc(siteCreatedAt));
  return leadId;
}

async function main() {
  /* ---------------- A: expiry = anchor + 7 days exactly ---------------- */
  const anchorA = new Date(Date.now() - 1 * DAY);
  anchorA.setUTCMilliseconds(0);
  const leadA = makeLead('Fixture Fresh Plumbing', anchorA);
  const expectedExpiryA = new Date(anchorA.getTime() + 7 * DAY).toISOString();

  let metaA;
  check('A: meta carries claimExpiresAt = anchor + 7d exactly', () => {
    metaA = claimKit.claimPageMeta(db, 1, leadA);
    assert.equal(metaA.claimExpiresAt, expectedExpiryA);
    assert.equal(metaA.claimHold.anchorAt, anchorA.toISOString());
    assert.equal(metaA.claimHold.expiresAt, expectedExpiryA);
  });
  check('A: live hold — not expired, ~5 days remaining, NY-formatted label', () => {
    assert.equal(metaA.claimExpired, false);
    assert.ok(metaA.claimSecondsRemaining > 5 * 86400, 'more than 5 days remain');
    assert.ok(metaA.claimSecondsRemaining <= 6 * 86400, 'no more than 6 days remain');
    assert.equal(metaA.claimDaysRemaining, 5);
    const expectedLabel = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(expectedExpiryA));
    assert.equal(metaA.claimExpiresLabel, expectedLabel);
    assert.match(metaA.claimExpiresLabel, /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  /* ---------------- B: the expiry NEVER moves ---------------- */
  check('B: anchor persisted in workspace settings on first computation', () => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`claim.hold.anchor.v1.${leadA}`);
    assert.ok(row, 'settings row exists');
    assert.equal(row.value, anchorA.toISOString());
  });
  check('B: repeat meta reads return the identical expiry', () => {
    const again = claimKit.claimPageMeta(db, 1, leadA);
    assert.equal(again.claimExpiresAt, expectedExpiryA);
    assert.equal(claimKit.claimHold(db, leadA).expiresAt, expectedExpiryA);
  });

  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-claim-hold-'));
  fs.writeFileSync(path.join(exportDir, 'index.html'), '<html><body>fixture</body></html>', 'utf8');
  let injectedHtml = '';
  check('B: popup re-injection ships claim-preview.js?v=9 and does not move the expiry', () => {
    const r = claimKit.injectClaimPreviewIntoExport(exportDir, 1, leadA);
    assert.equal(r.injected, 1);
    injectedHtml = fs.readFileSync(path.join(exportDir, 'index.html'), 'utf8');
    assert.ok(injectedHtml.includes('claim-preview.js?v=9'), 'snippet loads the v9 popup script');
    assert.ok(injectedHtml.includes('bitpype-claim-preview'), 'snippet markers present');
    const after = claimKit.claimPageMeta(db, 1, leadA);
    assert.equal(after.claimExpiresAt, expectedExpiryA);
  });
  check('B: even rewriting websites.created_at cannot move the persisted anchor', () => {
    db.prepare('UPDATE websites SET created_at = ? WHERE lead_id = ?').run(sqliteUtc(new Date()), leadA);
    const after = claimKit.claimPageMeta(db, 1, leadA);
    assert.equal(after.claimExpiresAt, expectedExpiryA);
    assert.equal(after.claimHold.anchorAt, anchorA.toISOString());
  });

  /* ---------------- C: popup script carries date + countdown + CTA ---------------- */
  const popupSrc = fs.readFileSync(path.join(root, 'public/js/claim-preview.js'), 'utf8');
  const kitSrc = fs.readFileSync(path.join(root, 'src/claimKit.js'), 'utf8');
  check('C: primary CTA is "Get it now!" on the same bp-claim-yes button', () => {
    assert.ok(popupSrc.includes('id="bp-claim-yes">Get it now!</button>'), 'Get it now! label on bp-claim-yes');
    assert.ok(
      popupSrc.includes("yesBtn.addEventListener('click', () => decide('interested', msg, btns));"),
      'yes button still posts the interested action'
    );
    assert.ok(popupSrc.includes("noBtn.addEventListener('click', () => decide('uninterested', msg, btns));"), 'No unchanged');
    assert.ok(popupSrc.includes("laterBtn.addEventListener('click', () => decide('later', msg, btns));"), 'Maybe later unchanged');
  });
  check('C: hold block renders the expiry date + a ticking countdown element', () => {
    assert.ok(popupSrc.includes('id="bp-claim-hold"'), 'hold block present');
    assert.ok(popupSrc.includes('Yours to claim until <strong>'), 'absolute expiry line present');
    assert.ok(popupSrc.includes('bp-claim-countdown'), 'countdown element present');
    assert.ok(popupSrc.includes('claimExpiresAt'), 'countdown reads the server expiry');
    assert.ok(popupSrc.includes('claimExpiresLabel'), 'date label reads the server label');
    assert.ok(popupSrc.includes('setInterval(tick, 1000)'), 'countdown ticks every second');
    assert.ok(popupSrc.includes('left to claim'), 'countdown copy present');
  });
  check('C: expired-hold copy is in the script (and flips live at zero)', () => {
    assert.ok(popupSrc.includes('Your 7-day hold ended on <strong>'), 'expired line present');
    assert.ok(popupSrc.includes('you can still claim this website'), 'expired state keeps the claim open');
    assert.ok(popupSrc.includes("el.textContent = 'Hold ended'"), 'live flip at zero present');
  });
  check('C: snippet version bumped to v=9 in claimKit', () => {
    assert.ok(kitSrc.includes('claim-preview.js?v=9'), 'claimKit injects ?v=9');
    assert.ok(!kitSrc.includes('claim-preview.js?v=8'), 'old ?v=8 gone');
  });

  /* ---------------- D: past expiry — expired state, claim still posts ---------------- */
  const anchorB = new Date(Date.now() - 30 * DAY);
  anchorB.setUTCMilliseconds(0);
  const leadB = makeLead('Fixture Expired Electric', anchorB);
  const expectedExpiryB = new Date(anchorB.getTime() + 7 * DAY).toISOString();
  check('D: past-expiry fixture reports the expired hold but keeps the prompt', () => {
    const metaB = claimKit.claimPageMeta(db, 1, leadB);
    assert.equal(metaB.claimExpiresAt, expectedExpiryB);
    assert.equal(metaB.claimExpired, true);
    assert.equal(metaB.claimSecondsRemaining, 0);
    assert.equal(metaB.claimDaysRemaining, 0);
    assert.equal(metaB.showClaimPrompt, true, 'expired hold never suppresses the popup');
  });
  check('D: the claim action still posts after expiry (interested → engaged)', () => {
    const res = outreach.applyClaimResponse(db, leadB, 'interested');
    assert.equal(res.action, 'interested');
    assert.equal(res.status, 'engaged');
    const ev = db
      .prepare(`SELECT id FROM prospect_events WHERE lead_id = ? AND type = 'email.interested' LIMIT 1`)
      .get(leadB);
    assert.ok(ev, 'interested event recorded after expiry');
  });

  /* ---------------- E: staff surface ---------------- */
  const domainSrc = fs.readFileSync(path.join(root, 'server/domain.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  check('E: sitesGet claim_popup exposes the expiry (display-only)', () => {
    assert.ok(domainSrc.includes('expires_at: meta.claimExpiresAt'), 'claim_popup.expires_at wired');
    assert.ok(domainSrc.includes('days_remaining'), 'claim_popup.days_remaining wired');
    assert.ok(domainSrc.includes('expired: !!meta.claimExpired'), 'claim_popup.expired wired');
  });
  check('E: staff website detail renders the hold dates', () => {
    assert.ok(appSrc.includes('7-day hold ends '), 'live hold date rendered');
    assert.ok(appSrc.includes('7-day hold ended '), 'expired hold date rendered');
  });

  try {
    fs.rmSync(exportDir, { recursive: true, force: true });
  } catch {
    /* temp cleanup best-effort */
  }
  console.log(JSON.stringify({ file: 'claim-hold-regressions', passed: true, checks: results.length }));
  for (const name of results) console.log('  ok -', name);
}

main().catch((e) => {
  console.error(JSON.stringify({ file: 'claim-hold-regressions', passed: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
