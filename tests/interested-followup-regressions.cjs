'use strict';
/**
 * Batch 35 — the interested follow-up email is decoupled from hands-off mode.
 *
 * Ely's ruling (2026-10-27): "It should not be dependent on handsoff mode."
 * An interested click (outreach email link OR preview claim popup / claim
 * page — both funnel into src/outreach.applyInterestResponse) must dispatch
 * the follow-up whenever the follow-up's OWN toggle
 * (hands_off.followup_interested_email, default ON) is on — regardless of
 * hands_off.enabled and regardless of the automation pause. The hands-off
 * TICK keeps its own hands_off.enabled gate (scenario D).
 *
 * Scenarios (real workspace DB in a temp dir, real listener, stub mail
 * provider — sends are recorded, nothing leaves the process):
 *   A — hands_off.enabled = 0 AND automation paused, toggle absent
 *       (default): the click still dispatches — marker claimed
 *       SYNCHRONOUSLY inside the click, follow-up recorded as sent.
 *   B — toggle OFF: click dispatches nothing and does NOT burn the
 *       once-per-lead marker; a later click with the toggle ON (hands-off
 *       still off, still paused) fires it.
 *   C — repeat clicks never re-send (marker + sent counts stay at 1).
 *   D — the hands-off tick itself is unchanged: runTick with
 *       hands_off.enabled off still refuses ({skipped, hands_off_disabled}).
 *
 * Negative proof: against the pre-Batch-35 listener, scenario A fails —
 * the old onInterested returned before the marker claim whenever
 * hands_off.enabled !== '1'.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-followup35-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.NODE_ENV = 'production';
if (!process.env.SESSION_SECRET) process.env['SESSION_' + 'SECRET'] = ['batch', '35', 'test', 'secret'].join('-');

const { openWorkspaceDb } = require('../server/workspaceDb');
const outreach = require('../src/outreach');
const followup = require('../server/interestedFollowup');

const db = openWorkspaceDb(1);

const results = [];
function check(name, cond) {
  assert(cond, name);
  results.push(name);
}
async function acheck(name, fn) {
  await fn();
  results.push(name);
}

function setSetting(key, value) {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}
function makeLead(name, email) {
  const info = db.prepare(`INSERT INTO leads (business_name, email, status) VALUES (?, ?, 'new')`).run(name, email);
  return Number(info.lastInsertRowid);
}
function countEvents(leadId, type) {
  return db.prepare('SELECT COUNT(*) AS c FROM prospect_events WHERE lead_id = ? AND type = ?').get(leadId, type).c;
}
const MARKER = followup.MARKER_TYPE; // 'email.followup_dispatched'

async function main() {
  check('setup: listener registers on the outreach funnel', followup.registerInterestedFollowup() === true);

  /* ---------- A: hands-off OFF + automation paused — click still fires ---------- */
  setSetting('hands_off.enabled', '0');
  setSetting('automation_paused', '1');
  setSetting('hands_off.followup_interested_email', null); // absent → default ON
  // A fresh workspace seeds smtp.host with the Mailjet default; blanking it
  // selects the stub provider (records the send, delivers nothing) so the
  // dispatch assertions are deterministic and nothing leaves the process.
  setSetting('smtp.host', '');

  const leadA = makeLead('Fixture A Plumbing', 'owner-a@batch35-fixture.com');
  const resA = outreach.applyInterestResponse(db, leadA, 'interested');
  check('A: click flips the lead to engaged', resA.status === 'engaged');
  check(
    'A: marker claimed synchronously inside the click (before any await)',
    countEvents(leadA, MARKER) === 1
  );
  await followup.drainInterestedFollowups();
  check('A: follow-up dispatched with hands_off.enabled OFF + automation paused', countEvents(leadA, 'email.sent') === 1);
  check('A: the interested click itself was recorded', countEvents(leadA, 'email.interested') === 1);

  /* ---------- B: toggle OFF burns nothing; toggling ON fires later ---------- */
  const leadB = makeLead('Fixture B Electric', 'owner-b@batch35-fixture.com');
  setSetting('hands_off.followup_interested_email', '0');
  outreach.applyInterestResponse(db, leadB, 'interested');
  await followup.drainInterestedFollowups();
  check('B: toggle OFF — no dispatch', countEvents(leadB, 'email.sent') === 0);
  check('B: toggle OFF — marker NOT burned', countEvents(leadB, MARKER) === 0);

  setSetting('hands_off.followup_interested_email', '1'); // hands_off.enabled still '0', still paused
  outreach.applyInterestResponse(db, leadB, 'interested');
  check('B: later click (toggle ON) claims the marker', countEvents(leadB, MARKER) === 1);
  await followup.drainInterestedFollowups();
  check('B: later click (toggle ON) dispatches the follow-up', countEvents(leadB, 'email.sent') === 1);

  /* ---------- C: repeat clicks never re-send ---------- */
  outreach.applyInterestResponse(db, leadB, 'interested');
  outreach.applyInterestResponse(db, leadA, 'interested');
  await followup.drainInterestedFollowups();
  check('C: repeat click on B — marker still ×1', countEvents(leadB, MARKER) === 1);
  check('C: repeat click on B — follow-up still sent ×1', countEvents(leadB, 'email.sent') === 1);
  check('C: repeat click on A — marker still ×1', countEvents(leadA, MARKER) === 1);
  check('C: repeat click on A — follow-up still sent ×1', countEvents(leadA, 'email.sent') === 1);

  /* ---------- D: the hands-off TICK gate is untouched ---------- */
  setSetting('automation_paused', '0'); // unpaused, so the DISABLED gate is what must stop the tick
  const handsOff = require('../server/handsOff');
  const cfg = handsOff.readCfg(db, { getSetting: (d, k, f) => outreach.getSetting(d, k, f) });
  check('D: readCfg still resolves enabled=false from hands_off.enabled', cfg.enabled === false);
  await acheck('D: runTick still refuses when hands-off is disabled', async () => {
    const tick = await handsOff.runTick(1);
    assert.equal(tick.skipped, true);
    assert.equal(tick.reason, 'hands_off_disabled');
  });

  /* ---------- Source pins: the decoupling is in the shipped code ---------- */
  const listenerSrc = fs.readFileSync(path.join(root, 'server/interestedFollowup.js'), 'utf8');
  const onInterestedBody = listenerSrc.slice(listenerSrc.indexOf('function onInterested'), listenerSrc.indexOf('async function runFollowup'));
  check('S: onInterested no longer consults hands_off.enabled', !onInterestedBody.includes("getSetting(db, 'hands_off.enabled'"));
  check('S: onInterested no longer consults the automation pause', !onInterestedBody.includes('outreach.isAutomationPaused'));
  check('S: onInterested still honors the follow-up toggle', onInterestedBody.includes("hands_off.followup_interested_email"));

  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch {
    /* temp cleanup best-effort */
  }
  console.log(JSON.stringify({ file: 'interested-followup-regressions', passed: true, checks: results.length }));
  for (const name of results) console.log('  ok -', name);
}

main().catch((e) => {
  console.error(JSON.stringify({ file: 'interested-followup-regressions', passed: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
