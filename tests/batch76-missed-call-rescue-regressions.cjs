'use strict';
/**
 * Batch 76 — Missed-Call Rescue (Ely's spec, 2026-10-30).
 *
 *   - A terminal MISSED call (busy / no-answer / failed / voicemail /
 *     answered <15s) on a call-tracking site whose owner opted in
 *     opens exactly ONE rescue (UNIQUE call_log_id).
 *   - SMS text-back from the tracking number (stubbed transport —
 *     zero real sends) → conversation collects service → real slot →
 *     name → FIRM booking via createPublicBooking + owner notified
 *     via the Batch 21b seam (stubbed notifier) + confirmation text.
 *   - No reply inside the window → voice callback (stubbed) carrying
 *     the SAME state; Gather digits/speech complete the booking.
 *   - Guardrails: answered ≥15s, 'canceled', non-call-tracking sites,
 *     rescue-off sites, owner/test numbers, suppressed numbers and
 *     STOP opt-outs never start or continue a rescue; quiet hours
 *     defer both channels.
 *   - Estimate track: open estimates (status new/contacted) on
 *     eligible sites get 24h/3d/7d nudges, exactly once per step,
 *     stopping on reply / owner close / booking / opt-out.
 *   - Twilio webhooks: a bogus signature is a hard 403 once
 *     credentials exist; a correctly signed SMS post is accepted
 *     (proven against a real server boot).
 *
 * Harness: temp on-disk workspace (DB_DRIVER=sqlite), engine driven
 * directly + one real server boot for the signature gate. Run via
 * tests/run-regressions.cjs.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b76-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch76', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');

const PORT = 31476;
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

const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
const domain = require(path.join(root, 'server/domain.js'));
const modules = require(path.join(root, 'server/siteModules.js'));
const rescue = require(path.join(root, 'server/callRescue.js'));
const portalContacts = require(path.join(root, 'server/portalContacts.js'));
const platform = require(path.join(root, 'server/platform.js'));

/* ------------------------- stubbed transport ------------------------ */
const sentSms = [];
const placedCalls = [];
const bookingNotices = [];
const callbackNotices = [];
rescue.setTransportForTests({
  sendSms: async (m) => {
    sentSms.push(m);
    return { configured: true, sid: 'SM-stub-' + sentSms.length, status: 'queued' };
  },
  createCall: async (m) => {
    placedCalls.push(m);
    return { configured: true, sid: 'CA-stub-' + placedCalls.length, status: 'queued' };
  },
});
rescue.setNotifierForTests({
  notifyBooking: async (ws, bookingId) => {
    bookingNotices.push({ ws, bookingId });
    return { sent: true };
  },
  notifyCallback: async (ws, info) => {
    callbackNotices.push({ ws, info });
    return { sent: true };
  },
});

/* ------------------------------ fixtures ---------------------------- */
const db = openWorkspaceDb(1);
const TRACK = '+16105550100';
const OWNER = '+16105550199';

function makeLead(name, email) {
  return domain.leadsCreate(1, { business_name: name, email }).id;
}
function setupBookings(leadId, serviceNames) {
  const ids = serviceNames.map((n) =>
    Number(modules.createBookingService(db, leadId, { name: n, duration_minutes: 60, status: 'published' }).id)
  );
  modules.setBookingHours(
    db,
    leadId,
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: '08:00', end_time: '17:00' }))
  );
  return ids;
}
function fakeCall(leadId, sid, { status, duration, from, voicemail = false }) {
  modules.logCallInitiated(db, leadId, { callSid: sid, from, to: TRACK, verified: 1 });
  const params = { CallSid: sid, From: from, To: TRACK };
  if (status) params.CallStatus = status;
  if (duration != null) params.CallDuration = String(duration);
  modules.upsertCallStatus(db, leadId, params, { verified: 1 });
  if (voicemail) {
    modules.storeCallRecording(db, sid, {
      recordingSid: 'RE-' + sid,
      recordingUrl: 'https://api.twilio.com/rec.mp3',
      recordingDuration: 9,
      voicemail: true,
    });
  }
  return modules.getCallLogBySid(db, sid);
}
const smsTo = (phone) => sentSms.filter((m) => m.to === phone);
const rescueRow = (id) => rescue.getRescue(db, id);

let leadA; // full rescue: tracking + opt-in + 2 services
let leadB; // tracking, rescue OFF
let leadC; // rescue ON but NO tracking number
let leadD; // estimates: tracking + opt-in + 1 service
let leadQ; // quiet hours
let svcA1;

function buildFixtures() {
  leadA = makeLead('Rescue Fixture Co', 'rescue76@fixture.test');
  modules.updateCallTrackingConfig(db, leadA, { display_number: TRACK, redirect_number: OWNER });
  rescue.setRescueConfig(db, leadA, { enabled: true, quiet_start: '00:00', quiet_end: '00:00' });
  svcA1 = setupBookings(leadA, ['Drain Cleaning', 'Water Heater Install'])[0];

  leadB = makeLead('Rescue Off Co', 'rescueoff76@fixture.test');
  modules.updateCallTrackingConfig(db, leadB, { display_number: '+16105550200', redirect_number: OWNER });

  leadC = makeLead('No Tracking Co', 'notrack76@fixture.test');
  rescue.setRescueConfig(db, leadC, { enabled: true });

  leadD = makeLead('Estimate Fixture Co', 'estimate76@fixture.test');
  modules.updateCallTrackingConfig(db, leadD, { display_number: '+16105550300', redirect_number: OWNER });
  rescue.setRescueConfig(db, leadD, { enabled: true, quiet_start: '00:00', quiet_end: '00:00' });
  setupBookings(leadD, ['Septic Pumping']);

  leadQ = makeLead('Quiet Fixture Co', 'quiet76@fixture.test');
  modules.updateCallTrackingConfig(db, leadQ, { display_number: '+16105550400', redirect_number: OWNER });
  rescue.setRescueConfig(db, leadQ, { enabled: true, quiet_start: '00:00', quiet_end: '23:59' });
  modules.getBookingSettings(db, leadQ); // materialize the row before the UPDATE
  db.prepare("UPDATE booking_settings SET timezone = 'UTC' WHERE lead_id = ?").run(leadQ);
}

/* -------------------------------- tests ----------------------------- */

function testConfig() {
  check('A1 rescue config defaults: disabled, 10-minute window, 21:00–08:00 quiet', () => {
    const cfg = rescue.getRescueConfig(db, leadB);
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.reply_window_minutes, 10);
    assert.equal(cfg.quiet_start, '21:00');
    assert.equal(cfg.quiet_end, '08:00');
  });
  check('A2 config validation: bad window and bad quiet time are coded VALIDATION errors', () => {
    assert.throws(() => rescue.setRescueConfig(db, leadB, { reply_window_minutes: 0 }), (e) => e.code === 'VALIDATION');
    assert.throws(() => rescue.setRescueConfig(db, leadB, { quiet_start: '9pm' }), (e) => e.code === 'VALIDATION');
    const cfg = rescue.setRescueConfig(db, leadB, { reply_window_minutes: 25 });
    assert.equal(cfg.reply_window_minutes, 25);
  });
  check('A3 isMissedCall: outcome matrix', () => {
    const M = rescue.isMissedCall;
    assert.equal(M({ status: 'busy', duration_seconds: 0 }), true);
    assert.equal(M({ status: 'no-answer', duration_seconds: 0 }), true);
    assert.equal(M({ status: 'failed', duration_seconds: 0 }), true);
    assert.equal(M({ status: 'completed', duration_seconds: 14 }), true);
    assert.equal(M({ status: 'completed', duration_seconds: 0, is_voicemail: 0 }), true);
    assert.equal(M({ status: 'completed', duration_seconds: 300, is_voicemail: 1 }), true);
    assert.equal(M({ status: 'completed', duration_seconds: 15 }), false);
    assert.equal(M({ status: 'completed', duration_seconds: 300 }), false);
    assert.equal(M({ status: 'canceled', duration_seconds: 0 }), false);
    assert.equal(M({ status: 'in-progress', duration_seconds: 0 }), false);
  });
}

async function testTriggerGates() {
  const CALLER = '+16105551001';
  await checkAsync('B1 answered ≥15s: no rescue', async () => {
    fakeCall(leadA, 'CA-b1', { status: 'completed', duration: 42, from: CALLER });
    const r = await rescue.maybeCreateRescue(1, leadA, 'CA-b1');
    assert.equal(r.created, false);
    assert.equal(r.reason, 'not_missed');
  });
  await checkAsync('B2 canceled (caller hung up): no rescue', async () => {
    fakeCall(leadA, 'CA-b2', { status: 'canceled', duration: 0, from: CALLER });
    const r = await rescue.maybeCreateRescue(1, leadA, 'CA-b2');
    assert.equal(r.created, false);
    assert.equal(r.reason, 'not_missed');
  });
  await checkAsync('B3 missed call on rescue-OFF site: no rescue', async () => {
    fakeCall(leadB, 'CA-b3', { status: 'no-answer', duration: 0, from: CALLER });
    const r = await rescue.maybeCreateRescue(1, leadB, 'CA-b3');
    assert.equal(r.created, false);
    assert.equal(r.reason, 'not_enabled');
  });
  await checkAsync('B4 missed call on non-call-tracking site: no rescue', async () => {
    fakeCall(leadC, 'CA-b4', { status: 'busy', duration: 0, from: CALLER });
    const r = await rescue.maybeCreateRescue(1, leadC, 'CA-b4');
    assert.equal(r.created, false);
    assert.equal(r.reason, 'no_tracking_number');
  });
  await checkAsync("B5 missed call from the owner's own number: no rescue", async () => {
    fakeCall(leadA, 'CA-b5', { status: 'no-answer', duration: 0, from: OWNER });
    const r = await rescue.maybeCreateRescue(1, leadA, 'CA-b5');
    assert.equal(r.created, false);
    assert.equal(r.reason, 'own_number');
  });
  await checkAsync('B6 number on the suppression list: no rescue', async () => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS suppression_list (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, reason TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`
    );
    db.prepare("INSERT OR IGNORE INTO suppression_list (email, reason) VALUES ('+16105551009', 'do-not-contact')").run();
    fakeCall(leadA, 'CA-b6', { status: 'failed', duration: 0, from: '+16105551009' });
    const r = await rescue.maybeCreateRescue(1, leadA, 'CA-b6');
    assert.equal(r.created, false);
    assert.equal(r.reason, 'suppressed');
  });
  await checkAsync('B7 exactly-once: two trigger calls for one missed call → one rescue', async () => {
    fakeCall(leadA, 'CA-b7', { status: 'completed', duration: 6, from: '+16105551002' });
    const r1 = await rescue.maybeCreateRescue(1, leadA, 'CA-b7');
    const r2 = await rescue.maybeCreateRescue(1, leadA, 'CA-b7');
    assert.equal(r1.created, true);
    assert.equal(r2.created, false);
    assert.equal(r2.reason, 'already_exists');
    const rows = db.prepare('SELECT COUNT(*) AS c FROM call_rescues WHERE call_log_id = ?').get(
      db.prepare("SELECT id FROM call_logs WHERE call_sid = 'CA-b7'").get().id
    );
    assert.equal(rows.c, 1);
    // Park it so later sweeps leave it alone.
    db.prepare("UPDATE call_rescues SET stage = 'expired' WHERE id = ?").run(r1.rescue.id);
  });
  await checkAsync('B8 voicemail counts as a miss', async () => {
    fakeCall(leadA, 'CA-b8', { status: 'completed', duration: 0, from: '+16105551003', voicemail: true });
    const r = await rescue.maybeCreateRescue(1, leadA, 'CA-b8');
    assert.equal(r.created, true);
    db.prepare("UPDATE call_rescues SET stage = 'expired' WHERE id = ?").run(r.rescue.id);
  });
}

async function testSmsConversation() {
  const CALLER = '+16105552001';
  let rescueId;
  await checkAsync('C1 text-back goes out on the sweep, from the tracking number, offering services', async () => {
    fakeCall(leadA, 'CA-c1', { status: 'no-answer', duration: 0, from: CALLER });
    const r = await rescue.maybeCreateRescue(1, leadA, 'CA-c1');
    assert.equal(r.created, true);
    rescueId = r.rescue.id;
    await rescue.runRescueSweep({ workspaceIds: [1] });
    const texts = smsTo(CALLER);
    assert.equal(texts.length, 1);
    assert.equal(texts[0].from, TRACK);
    assert.match(texts[0].body, /sorry we missed your call/i);
    assert.match(texts[0].body, /Drain Cleaning/);
    assert.match(texts[0].body, /Water Heater Install/);
    const row = rescueRow(rescueId);
    assert.equal(row.stage, 'awaiting_service');
    assert.ok(row.text_sent_at, 'text_sent_at recorded');
    assert.ok(row.voice_due_at, 'voice escalation armed');
    // Sweep again: no duplicate text.
    await rescue.runRescueSweep({ workspaceIds: [1] });
    assert.equal(smsTo(CALLER).length, 1);
  });
  await checkAsync('C2 reply picks a service → real slots offered', async () => {
    const before = smsTo(CALLER).length;
    const res = await rescue.handleInboundSms(1, { from: CALLER, to: TRACK, body: '1', messageSid: 'SM-in-1' });
    assert.equal(res.handled, true);
    const texts = smsTo(CALLER);
    assert.equal(texts.length, before + 1);
    assert.match(texts[texts.length - 1].body, /next openings/);
    const row = rescueRow(rescueId);
    assert.equal(row.stage, 'awaiting_slot');
    assert.ok(Array.isArray(row.state ? [] : []), 'state readable');
    const st = JSON.parse(row.state_json);
    assert.equal(Number(st.service_id), svcA1);
    assert.ok(Array.isArray(st.offered) && st.offered.length >= 1, 'real slots were offered');
  });
  await checkAsync('C3 slot pick → name ask → FIRM booking + owner notice + confirmation text', async () => {
    await rescue.handleInboundSms(1, { from: CALLER, to: TRACK, body: '1', messageSid: 'SM-in-2' });
    let row = rescueRow(rescueId);
    assert.equal(row.stage, 'awaiting_name');
    const noticesBefore = bookingNotices.length;
    await rescue.handleInboundSms(1, { from: CALLER, to: TRACK, body: 'Pat Smith', messageSid: 'SM-in-3' });
    row = rescueRow(rescueId);
    assert.equal(row.stage, 'booked');
    assert.ok(row.booking_id, 'booking id recorded on the rescue');
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(row.booking_id);
    assert.ok(booking, 'a real bookings row exists');
    assert.equal(Number(booking.service_id), svcA1);
    assert.equal(booking.customer_name, 'Pat Smith');
    assert.equal(booking.customer_phone, CALLER);
    assert.ok(['pending', 'confirmed'].includes(booking.status));
    assert.equal(bookingNotices.length, noticesBefore + 1, 'owner notified via the booking seam');
    assert.equal(bookingNotices[bookingNotices.length - 1].bookingId, Number(booking.id));
    const last = smsTo(CALLER)[smsTo(CALLER).length - 1];
    assert.match(last.body, /You're booked, Pat Smith/);
    // The whole conversation is on the record.
    const msgs = db.prepare('SELECT COUNT(*) AS c FROM call_rescue_messages WHERE rescue_id = ?').get(rescueId);
    assert.ok(msgs.c >= 5, 'messages logged');
    const events = db
      .prepare("SELECT COUNT(*) AS c FROM leadscout_events WHERE lead_id = ? AND kind = 'call_rescue'")
      .get(leadA);
    assert.ok(events.c >= 2, 'LeadScout timeline carries the rescue');
  });
}

async function testStopAndSuppression() {
  const CALLER = '+16105552002';
  await checkAsync('D1 STOP opts the caller out and kills the rescue; later misses are suppressed', async () => {
    fakeCall(leadA, 'CA-d1', { status: 'busy', duration: 0, from: CALLER });
    const r = await rescue.maybeCreateRescue(1, leadA, 'CA-d1');
    assert.equal(r.created, true);
    await rescue.runRescueSweep({ workspaceIds: [1] });
    assert.equal(smsTo(CALLER).length, 1);
    const res = await rescue.handleInboundSms(1, { from: CALLER, to: TRACK, body: 'STOP', messageSid: 'SM-stop' });
    assert.equal(res.action, 'opt_out');
    const row = rescueRow(r.rescue.id);
    assert.equal(row.stage, 'stopped');
    assert.equal(row.outcome, 'opt_out');
    const contact = db
      .prepare('SELECT sms_opted_out_at FROM leadscout_contacts WHERE phone_norm = ?')
      .get(portalContacts.normPhone(CALLER));
    assert.ok(contact && contact.sms_opted_out_at, 'opt-out stamped on the contact');
    fakeCall(leadA, 'CA-d2', { status: 'no-answer', duration: 0, from: CALLER });
    const r2 = await rescue.maybeCreateRescue(1, leadA, 'CA-d2');
    assert.equal(r2.created, false);
    assert.equal(r2.reason, 'suppressed');
  });
}

async function testQuietHours() {
  const CALLER = '+16105552003';
  await checkAsync('E1 quiet hours defer the text-back to the next window end', async () => {
    fakeCall(leadQ, 'CA-e1', { status: 'no-answer', duration: 0, from: CALLER });
    const r = await rescue.maybeCreateRescue(1, leadQ, 'CA-e1');
    assert.equal(r.created, true);
    // Tomorrow noon UTC is inside leadQ's 00:00–23:59 quiet window.
    const t = new Date();
    const noon = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1, 12, 0, 0));
    await rescue.runRescueSweep({ workspaceIds: [1], now: noon });
    assert.equal(smsTo(CALLER).length, 0, 'nothing sent during quiet hours');
    const row = rescueRow(r.rescue.id);
    assert.equal(row.stage, 'pending_text');
    assert.ok(row.next_action_at, 'deferred with a next action time');
    db.prepare("UPDATE call_rescues SET stage = 'expired' WHERE id = ?").run(r.rescue.id);
  });
  check('E2 quietState math: wrap-around window', () => {
    const cfg = { quiet_start: '21:00', quiet_end: '08:00' };
    const at = (iso) => rescue.quietState(cfg, 'UTC', new Date(iso));
    assert.equal(at('2026-11-02T22:30:00Z').quiet, true);
    assert.equal(at('2026-11-02T03:00:00Z').quiet, true);
    assert.equal(at('2026-11-02T12:00:00Z').quiet, false);
    const until = at('2026-11-02T22:30:00Z').until;
    assert.equal(until.toISOString(), '2026-11-03T08:00:00.000Z');
  });
}

async function testVoiceEscalation() {
  const CALLER = '+16105552004';
  let rescueId;
  await checkAsync('F1 no SMS reply → voice callback placed after the window, state carried', async () => {
    fakeCall(leadA, 'CA-f1', { status: 'failed', duration: 0, from: CALLER });
    const r = await rescue.maybeCreateRescue(1, leadA, 'CA-f1');
    rescueId = r.rescue.id;
    await rescue.runRescueSweep({ workspaceIds: [1] });
    assert.equal(smsTo(CALLER).length, 1);
    // Caller picks the service by text, then goes silent.
    await rescue.handleInboundSms(1, { from: CALLER, to: TRACK, body: '2', messageSid: 'SM-f1' });
    let row = rescueRow(rescueId);
    assert.equal(row.stage, 'awaiting_slot');
    // Window passes with no further reply.
    db.prepare("UPDATE call_rescues SET voice_due_at = datetime('now', '-1 minute') WHERE id = ?").run(rescueId);
    const callsBefore = placedCalls.length;
    await rescue.runRescueSweep({ workspaceIds: [1] });
    assert.equal(placedCalls.length, callsBefore + 1, 'exactly one voice callback placed');
    const call = placedCalls[placedCalls.length - 1];
    assert.equal(call.from, TRACK);
    assert.equal(call.to, CALLER);
    assert.match(call.url, new RegExp(`/api/v1/calls/rescue-voice/1/${rescueId}$`));
    row = rescueRow(rescueId);
    assert.equal(row.stage, 'awaiting_slot', 'conversation state carried into the call — nothing re-asked');
  });
  await checkAsync('F2 voice Gather: TwiML prompts the CURRENT stage; digits + speech complete the booking', async () => {
    const opener = await rescue.handleVoiceInput(1, rescueId, {});
    assert.match(opener, /<Gather/);
    assert.match(opener, /next openings are/i);
    const afterSlot = await rescue.handleVoiceInput(1, rescueId, { digits: '1' });
    assert.match(afterSlot, /What's your name/i);
    const done = await rescue.handleVoiceInput(1, rescueId, { speech: 'Sam Caller' });
    assert.match(done, /You're booked/);
    const row = rescueRow(rescueId);
    assert.equal(row.stage, 'booked');
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(row.booking_id);
    assert.ok(booking && booking.customer_name === 'Sam Caller');
    // Written confirmation text went out too.
    assert.match(smsTo(CALLER)[smsTo(CALLER).length - 1].body, /You're booked, Sam Caller/);
  });
}

async function testEstimates() {
  const PHONE1 = '+16105553001';
  const PHONE2 = '+16105553002';
  const PHONE3 = '+16105553003';
  const TRACKD = '+16105550300';
  function makeEstimate(phone, name, backdateHours) {
    const est = modules.createEstimateRequest(db, leadD, {
      name,
      email: '',
      phone,
      notes: 'fixture',
      selections: [],
    });
    db.prepare("UPDATE estimate_requests SET created_at = datetime('now', ?) WHERE id = ?").run(
      `-${backdateHours} hours`,
      est.id
    );
    return modules.getEstimateRequest(db, leadD, est.id);
  }
  await checkAsync('G1 a fresh estimate is NOT nudged before 24h', async () => {
    makeEstimate(PHONE1, 'Fresh Fred', 1);
    await rescue.runRescueSweep({ workspaceIds: [1] });
    assert.equal(smsTo(PHONE1).length, 0);
  });
  await checkAsync('G2 step 1 fires once at 24h; a second sweep does not repeat it', async () => {
    const est = db
      .prepare('SELECT * FROM estimate_requests WHERE lead_id = ? AND phone = ?')
      .get(leadD, PHONE1);
    db.prepare("UPDATE estimate_requests SET created_at = datetime('now', '-25 hours') WHERE id = ?").run(est.id);
    await rescue.runRescueSweep({ workspaceIds: [1] });
    assert.equal(smsTo(PHONE1).length, 1);
    assert.match(smsTo(PHONE1)[0].body, /following up on the estimate/i);
    assert.equal(smsTo(PHONE1)[0].from, TRACKD);
    await rescue.runRescueSweep({ workspaceIds: [1] });
    assert.equal(smsTo(PHONE1).length, 1, 'exactly-once per step');
    const row = db.prepare('SELECT * FROM call_rescues WHERE estimate_request_id = ?').get(est.id);
    assert.equal(Number(row.nudge_step), 1);
  });
  await checkAsync('G3 a reply stops the sequence and opens the booking conversation', async () => {
    const before = smsTo(PHONE1).length;
    const res = await rescue.handleInboundSms(1, { from: PHONE1, to: TRACKD, body: 'Yes please', messageSid: 'SM-g3' });
    assert.equal(res.handled, true);
    assert.equal(res.action, 'estimate_reply');
    const est = db.prepare('SELECT * FROM estimate_requests WHERE lead_id = ? AND phone = ?').get(leadD, PHONE1);
    const row = db.prepare('SELECT * FROM call_rescues WHERE estimate_request_id = ?').get(est.id);
    assert.notEqual(row.stage, 'estimate_nudge');
    assert.ok(smsTo(PHONE1).length > before, 'the caller got the booking conversation opener');
  });
  await checkAsync('G4 owner closing the estimate stops the sequence before step 2', async () => {
    const est = makeEstimate(PHONE2, 'Closer Clara', 25);
    await rescue.runRescueSweep({ workspaceIds: [1] });
    assert.equal(smsTo(PHONE2).length, 1, 'step 1 sent');
    modules.updateEstimateRequestStatus(db, leadD, est.id, 'closed');
    db.prepare("UPDATE call_rescues SET next_action_at = datetime('now', '-1 minute') WHERE estimate_request_id = ?").run(est.id);
    await rescue.runRescueSweep({ workspaceIds: [1] });
    assert.equal(smsTo(PHONE2).length, 1, 'no step 2 after close');
    const row = db.prepare('SELECT * FROM call_rescues WHERE estimate_request_id = ?').get(est.id);
    assert.equal(row.outcome, 'estimate_closed');
  });
  await checkAsync('G5 late enrollment starts at the current step — no back-to-back replay', async () => {
    const est = makeEstimate(PHONE3, 'Late Larry', 73);
    await rescue.runRescueSweep({ workspaceIds: [1] });
    const texts = smsTo(PHONE3);
    assert.equal(texts.length, 1, 'exactly one nudge, not the whole sequence');
    assert.match(texts[0].body, /still open/, 'it is the step-2 wording');
    const row = db.prepare('SELECT * FROM call_rescues WHERE estimate_request_id = ?').get(est.id);
    assert.equal(Number(row.nudge_step), 2);
    void est;
  });
}

async function testSignatureGate() {
  await require(path.join(root, 'server/db.js')).migrate();
  await platform.setPlatformSetting('twilio.account_sid', 'AC-fixture-76');
  await platform.setPlatformSetting('twilio.auth_token', 'fixture-token-76');
  // Pin the public URL so the signature base is deterministic in the
  // spawned server (a seeded general.public_url would otherwise win
  // over APP_URL — Batch 56 resolution order).
  await platform.setPlatformSetting('general.public_url', 'https://bitpype.test');
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

    await checkAsync('H1 bogus Twilio signature on the SMS webhook → 403', async () => {
      const res = await fetch(`${BASE}/api/v1/calls/sms/1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'bogus' },
        body: new URLSearchParams({ From: '+16105559999', To: TRACK, Body: 'hi' }).toString(),
      });
      assert.equal(res.status, 403);
    });
    await checkAsync('H2 correctly signed SMS webhook post → 200', async () => {
      const params = { From: '+16105559999', To: TRACK, Body: 'hello' };
      const url = `https://bitpype.test/api/v1/calls/sms/1`;
      let data = url;
      for (const k of Object.keys(params).sort()) data += k + params[k];
      const sig = crypto.createHmac('sha1', 'fixture-token-76').update(Buffer.from(data, 'utf-8')).digest('base64');
      const res = await fetch(`${BASE}/api/v1/calls/sms/1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig },
        body: new URLSearchParams(params).toString(),
      });
      assert.equal(res.status, 200);
    });
    await checkAsync('H3 bogus signature on the rescue voice route → 403', async () => {
      const res = await fetch(`${BASE}/api/v1/calls/rescue-voice/1/1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'bogus' },
        body: new URLSearchParams({ Digits: '1' }).toString(),
      });
      assert.equal(res.status, 403);
    });
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
}

function testWiring() {
  check('W1 wiring: ticker, routes, portal toggle, transport exports', () => {
    const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.match(serverJs, /callRescue'\)\.startRescueTicker\(\)/);
    const callsJs = fs.readFileSync(path.join(root, 'server/routes/calls.js'), 'utf8');
    assert.match(callsJs, /\/sms\/:workspaceId/);
    assert.match(callsJs, /\/rescue-voice\/:workspaceId\/:rescueId/);
    assert.match(callsJs, /maybeCreateRescue/);
    const portalJs = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
    assert.match(portalJs, /calltracking-rescue-enabled/);
    assert.match(portalJs, /Missed-Call Rescue/);
    const twilio = require(path.join(root, 'server/twilioClient.js'));
    assert.equal(typeof twilio.sendSms, 'function');
    assert.equal(typeof twilio.createCall, 'function');
    assert.equal(typeof twilio.setNumberSmsUrl, 'function');
  });
}

(async () => {
  buildFixtures();
  testConfig();
  await testTriggerGates();
  await testSmsConversation();
  await testStopAndSuppression();
  await testQuietHours();
  await testVoiceEscalation();
  await testEstimates();
  await testSignatureGate();
  testWiring();
  console.log(`batch76-missed-call-rescue-regressions: ${results.length} checks passed`);
  for (const r of results) console.log('  ✓', r);
})().catch((e) => {
  console.error('batch76 FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
