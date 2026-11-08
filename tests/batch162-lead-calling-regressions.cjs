'use strict';
/**
 * Batch 162 — Lead calling from the pipeline (Ely's order 2026-11-08).
 *
 *   - Pipeline card carries a Contact button next to Intent, routing
 *     to a per-lead Contact page (static pins on app.js/api.js).
 *   - Outbound calls share call_logs with the inbound log
 *     (direction='outbound', call_sid = our ref): claim-once dial,
 *     status merges that NEVER mark the call counted toward the
 *     client's inbound allowance.
 *   - Consent sequencing: the lead-leg TwiML speaks the disclosure
 *     BEFORE the <Dial><Conference record="record-from-answer"> —
 *     disclosure first, bridging + recording after. The staff leg
 *     parks in the same room with startConferenceOnEnter=false.
 *   - Capability token: HS256 JWT signed with the account auth
 *     token, incoming + outgoing (Voice app) scopes.
 *   - Recording callback stores the recording and fires the existing
 *     Whisper flow exactly once (transcriber seam stubbed here);
 *     transcript edits preserve the Whisper original.
 *   - Follow-up notes: author-or-manager rule; one chronological
 *     timeline interleaves calls and notes.
 *   - HTTP: anonymous → 401; a staff user from another workspace →
 *     403 on the page AND the token endpoint; Twilio webhooks are
 *     signature-gated (bogus → 403) and return the sequenced TwiML.
 *
 * Harness: temp on-disk workspaces (DB_DRIVER=sqlite locally, the
 * gate's MySQL leg via REGRESSION_DB_DRIVER), engine driven directly
 * + one real server boot. Twilio REST + Whisper are stubbed through
 * outboundCalls.setTransportForTests — zero real calls.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b162-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch162', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');

const PORT = 31462;
const BASE = `http://127.0.0.1:${PORT}`;
const APP_URL = 'https://bitpype.test';
const TWILIO_SID = 'AC162fixture00000000000000000000';
const TWILIO_TOKEN = 'twilio-fixture-token-162';

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
const outbound = require(path.join(root, 'server/outboundCalls.js'));
const platform = require(path.join(root, 'server/platform.js'));

/* --------------------------- stubbed seams ------------------------ */
const placedCalls = [];
let transcribeCalls = 0;
outbound.setTransportForTests({
  credentials: { accountSid: TWILIO_SID, authToken: TWILIO_TOKEN, source: 'workspace' },
  ensureAppSid: async () => 'AP162fixtureapp',
  createCall: async (args) => {
    placedCalls.push(args);
    return { configured: true, sid: 'CA-lead-leg-' + placedCalls.length, status: 'queued' };
  },
  transcribe: async (workspaceId, leadId, callRef) => {
    transcribeCalls += 1;
    domain.withDb(workspaceId, (db) =>
      modules.setCallTranscript(db, callRef, { status: 'done', text: 'Whisper says hello.' })
    );
    domain.withDb(workspaceId, (db) => modules.stampTranscriptOriginal(db, callRef));
    return { ok: true };
  },
});

/* ------------------------------ fixtures -------------------------- */
const db1 = openWorkspaceDb(1);
domain.setSetting(db1, 'sms.from_number', '+16105550100');
domain.setSetting(db1, 'sms.account_sid', TWILIO_SID);
domain.setSetting(db1, 'sms.auth_token', TWILIO_TOKEN);

const leadA = domain.leadsCreate(1, {
  business_name: 'Alpha Plumbing',
  phone: '6105550111',
  email: 'alpha@example.invalid',
  city: 'Reading',
  category: 'Plumber',
}).id;
const leadNoPhone = domain.leadsCreate(1, { business_name: 'No Phone Biz', email: 'np@example.invalid' }).id;

async function main() {
  /* ------------------------- store level -------------------------- */
  check('S1 outbound row lands in call_logs with direction/staff/room', () => {
    const row = modules.createOutboundCall(db1, leadA, {
      callRef: 'outbound-fixture-1',
      fromNumber: '+16105550100',
      toNumber: '+16105550111',
      staffUserId: 10,
      staffName: 'Fixture Fran',
      room: 'leadcall-fixture-1',
    });
    assert.equal(row.direction, 'outbound');
    assert.equal(row.status, 'initiated');
    assert.equal(row.staff_name, 'Fixture Fran');
    assert.equal(row.conference_name, 'leadcall-fixture-1');
    assert.equal(row.counted, 0);
  });

  check('S2 inbound rows stay out of the outbound list (and vice versa)', () => {
    modules.logCallInitiated(db1, leadA, { callSid: 'CA-inbound-1', from: '+16105550199', to: '+16105550100', verified: 1 });
    const out = modules.listOutboundCalls(db1, leadA);
    assert.equal(out.length, 1);
    assert.equal(out[0].call_sid, 'outbound-fixture-1');
    const all = modules.listCalls(db1, leadA);
    assert.equal(all.length, 2);
  });

  check('S3 dial claim fires exactly once', () => {
    assert.equal(modules.claimOutboundDial(db1, 'outbound-fixture-1'), true);
    assert.equal(modules.claimOutboundDial(db1, 'outbound-fixture-1'), false);
    const row = modules.setOutboundProviderSid(db1, 'outbound-fixture-1', 'CA-provider-1');
    assert.equal(row.provider_call_sid, 'CA-provider-1');
    assert.equal(row.status, 'ringing');
  });

  check('S4 outbound completion NEVER counts toward the inbound allowance', () => {
    const row = modules.updateOutboundCallStatus(db1, 'outbound-fixture-1', {
      status: 'completed',
      durationSeconds: 240,
    });
    assert.equal(row.status, 'completed');
    assert.equal(row.duration_seconds, 240);
    assert.equal(Number(row.counted), 0);
  });

  check('S5 transcript edit preserves the Whisper original', () => {
    modules.setCallTranscript(db1, 'outbound-fixture-1', { status: 'done', text: 'Whisper original text.' });
    const edited = modules.editCallTranscript(db1, 'outbound-fixture-1', 'Staff corrected text.');
    assert.equal(edited.transcript, 'Staff corrected text.');
    assert.equal(Number(edited.transcript_edited), 1);
    assert.equal(edited.transcript_original, 'Whisper original text.');
    const again = modules.editCallTranscript(db1, 'outbound-fixture-1', 'Second correction.');
    assert.equal(again.transcript_original, 'Whisper original text.');
  });

  check('S6 notes store CRUD', () => {
    const n = modules.addLeadContactNote(db1, leadA, { staffUserId: 10, staffName: 'Fixture Fran', body: 'First note' });
    assert.ok(n.id > 0);
    assert.equal(modules.listLeadContactNotes(db1, leadA).length, 1);
    const upd = modules.updateLeadContactNote(db1, n.id, 'First note (edited)');
    assert.equal(upd.body, 'First note (edited)');
    assert.equal(modules.deleteLeadContactNote(db1, n.id), true);
    assert.equal(modules.listLeadContactNotes(db1, leadA).length, 0);
    assert.throws(() => modules.addLeadContactNote(db1, leadA, { body: '   ' }), /note needs/i);
  });

  check('S7 timeline interleaves call/note/call in time order', () => {
    const c1 = modules.createOutboundCall(db1, leadA, { callRef: 'outbound-tl-1', fromNumber: '+1', toNumber: '+2', room: 'r1' });
    const n1 = modules.addLeadContactNote(db1, leadA, { staffUserId: 10, staffName: 'F', body: 'middle note' });
    const c2 = modules.createOutboundCall(db1, leadA, { callRef: 'outbound-tl-2', fromNumber: '+1', toNumber: '+2', room: 'r2' });
    db1.prepare('UPDATE call_logs SET created_at = ? WHERE id = ?').run('2026-11-01 09:00:00', c1.id);
    db1.prepare('UPDATE lead_contact_notes SET created_at = ? WHERE id = ?').run('2026-11-02 09:00:00', n1.id);
    db1.prepare('UPDATE call_logs SET created_at = ? WHERE id = ?').run('2026-11-03 09:00:00', c2.id);
    const calls = modules.listOutboundCalls(db1, leadA).map(outbound.shapeCall);
    const notes = modules.listLeadContactNotes(db1, leadA).map(outbound.shapeNote);
    const tl = outbound
      .buildTimeline(calls, notes)
      .filter(
        (i) =>
          (i.kind === 'call' && (i.call.callRef === 'outbound-tl-1' || i.call.callRef === 'outbound-tl-2')) ||
          (i.kind === 'note' && i.note.body === 'middle note')
      );
    assert.deepEqual(
      tl.map((i) => i.kind),
      ['call', 'note', 'call']
    );
    assert.equal(tl[0].call.callRef, 'outbound-tl-1');
    assert.equal(tl[2].call.callRef, 'outbound-tl-2');
  });

  /* --------------------------- TwiML ------------------------------ */
  check('T1 lead-leg TwiML: disclosure Say BEFORE the recording conference', () => {
    const twiml = outbound.buildLeadLegTwiml({
      workspaceId: 1,
      leadId: leadA,
      callRef: 'outbound-x',
      room: 'leadcall-x',
      disclosure: outbound.DEFAULT_DISCLOSURE,
      baseUrl: APP_URL,
    });
    const sayAt = twiml.indexOf('<Say>');
    const dialAt = twiml.indexOf('<Dial>');
    assert.ok(sayAt > -1 && dialAt > sayAt, 'Say must precede Dial');
    assert.ok(twiml.includes(`<Say>${outbound.DEFAULT_DISCLOSURE}</Say>`));
    assert.ok(twiml.includes('record="record-from-answer"'));
    assert.ok(twiml.includes('startConferenceOnEnter="true"'));
    assert.ok(twiml.includes(`/api/v1/calls/outbound-recording/1/${leadA}?ref=outbound-x`));
    assert.ok(twiml.includes('>leadcall-x</Conference>'));
  });

  check('T2 staff-leg TwiML parks the caller in the same room', () => {
    const twiml = outbound.buildStaffLegTwiml({ room: 'leadcall-x' });
    assert.ok(twiml.includes('startConferenceOnEnter="false"'));
    assert.ok(twiml.includes('endConferenceOnExit="true"'));
    assert.ok(twiml.includes('>leadcall-x</Conference>'));
    assert.ok(!twiml.includes('<Say>'), 'staff leg never speaks the disclosure');
  });

  check('T3 capability token is a verifiable HS256 JWT with both scopes', () => {
    const token = outbound.buildCapabilityToken({
      accountSid: TWILIO_SID,
      authToken: TWILIO_TOKEN,
      identity: 'staff-10-ws1',
      appSid: 'AP162fixtureapp',
    });
    const [h, p, s] = token.split('.');
    const expected = crypto.createHmac('sha256', TWILIO_TOKEN).update(`${h}.${p}`).digest('base64url');
    assert.equal(s, expected);
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    assert.equal(payload.iss, TWILIO_SID);
    assert.ok(payload.scope.includes('scope:client:incoming?clientName=staff-10-ws1'));
    assert.ok(payload.scope.includes('scope:client:outgoing?appSid=AP162fixtureapp'));
    assert.ok(payload.exp > Math.floor(Date.now() / 1000));
  });

  /* ------------------------ engine flow --------------------------- */
  check('E1 caller ID: SMS from-number when the lead has no tracking number', () => {
    const caller = outbound.resolveCallerId(db1, leadA);
    assert.equal(caller.number, '+16105550100');
    assert.equal(caller.source, 'sms');
  });

  check('E2 caller ID: the lead tracking display number wins when set', () => {
    const cfg = modules.getCallTrackingConfig(db1, leadA);
    modules.updateCallTrackingConfig(db1, leadA, { ...cfg, display_number: '+16105550177' });
    const caller = outbound.resolveCallerId(db1, leadA);
    assert.equal(caller.number, '+16105550177');
    assert.equal(caller.source, 'calltracking');
  });

  let started;
  await checkAsync('E3 start creates the record and returns room + disclosure', async () => {
    started = await outbound.startOutboundCall(1, leadA, { userId: 10, name: 'Fixture Fran' });
    assert.ok(started.callRef.startsWith('outbound-'));
    assert.ok(started.room.startsWith('leadcall-'));
    assert.equal(started.from, '+16105550177');
    assert.equal(started.to, '6105550111');
    assert.equal(started.disclosure, outbound.DEFAULT_DISCLOSURE);
    const row = modules.getCallLogBySid(db1, started.callRef);
    assert.equal(row.direction, 'outbound');
    assert.equal(Number(row.staff_user_id), 10);
  });

  await checkAsync('E4 dial originates the lead leg exactly once', async () => {
    const r1 = await outbound.dialLeadLeg(1, leadA, started.callRef);
    assert.equal(r1.ok, true);
    assert.equal(placedCalls.length, 1);
    assert.equal(placedCalls[0].from, '+16105550177');
    assert.equal(placedCalls[0].to, '+16105550111');
    assert.ok(placedCalls[0].url.includes(`/api/v1/calls/outbound-lead/1/${leadA}?ref=${started.callRef}`));
    assert.ok(placedCalls[0].statusCallback.includes(`/api/v1/calls/outbound-status/1/${leadA}?ref=${started.callRef}`));
    const row = modules.getCallLogBySid(db1, started.callRef);
    assert.equal(row.provider_call_sid, 'CA-lead-leg-1');
    assert.equal(row.status, 'ringing');
    const r2 = await outbound.dialLeadLeg(1, leadA, started.callRef);
    assert.equal(r2.alreadyDialed, true);
    assert.equal(placedCalls.length, 1);
  });

  await checkAsync('E5 lead status callback completes the record', async () => {
    const row = await outbound.handleLeadStatus(1, leadA, started.callRef, {
      CallStatus: 'completed',
      CallDuration: '95',
    });
    assert.equal(row.status, 'completed');
    assert.equal(row.duration_seconds, 95);
  });

  await checkAsync('E6 recording callback stores + transcribes exactly once', async () => {
    const params = {
      RecordingSid: 'RE162',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_SID + '/Recordings/RE162',
      RecordingDuration: '90',
    };
    const row = await outbound.handleRecording(1, leadA, started.callRef, params);
    assert.ok(row.recording_url.includes('RE162'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(transcribeCalls, 1);
    const after = modules.getCallLogBySid(db1, started.callRef);
    assert.equal(after.transcript, 'Whisper says hello.');
    assert.equal(after.transcript_original, 'Whisper says hello.');
    await outbound.handleRecording(1, leadA, started.callRef, params);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(transcribeCalls, 1);
  });

  await checkAsync('E7 a second call appends — the first is untouched', async () => {
    const second = await outbound.startOutboundCall(1, leadA, { userId: 10, name: 'Fixture Fran' });
    assert.notEqual(second.callRef, started.callRef);
    const calls = modules.listOutboundCalls(db1, leadA).filter((c) => c.call_sid.startsWith('outbound-') && !c.call_sid.includes('fixture') && !c.call_sid.includes('tl-'));
    assert.equal(calls.length, 2);
    const first = modules.getCallLogBySid(db1, started.callRef);
    assert.equal(first.status, 'completed');
    assert.equal(first.transcript, 'Whisper says hello.');
  });

  await checkAsync('E8 no-phone lead cannot start a call', async () => {
    await assert.rejects(async () => outbound.startOutboundCall(1, leadNoPhone, { userId: 10, name: 'F' }), /no phone/i);
  });

  await checkAsync('E9 disclosure is editable and blank restores the default', async () => {
    const custom = await outbound.setDisclosure(1, 'Heads up: we record this call.');
    assert.equal(custom.disclosure, 'Heads up: we record this call.');
    const data = await outbound.getContactData(1, leadA);
    assert.equal(data.disclosure, 'Heads up: we record this call.');
    const back = await outbound.setDisclosure(1, '   ');
    assert.equal(back.disclosure, outbound.DEFAULT_DISCLOSURE);
    assert.equal(back.isDefault, true);
  });

  await checkAsync('E10 contact data shapes lead, calls, notes, timeline', async () => {
    const data = await outbound.getContactData(1, leadA);
    assert.equal(data.lead.businessName, 'Alpha Plumbing');
    assert.equal(data.lead.city, 'Reading');
    assert.equal(data.hasPhone, true);
    assert.equal(data.callerId, '+16105550177');
    assert.equal(data.twilioConfigured, true);
    assert.ok(data.calls.length >= 2);
    assert.ok(Array.isArray(data.timeline) && data.timeline.length >= 2);
    const kinds = data.timeline.map((i) => i.kind);
    assert.ok(kinds.every((k) => k === 'call' || k === 'note'));
  });

  check('E11 note permissions: author or manager only', () => {
    const note = outbound.addNote(1, leadA, { userId: 10, name: 'Fixture Fran' }, 'Permission note');
    assert.throws(
      () => outbound.editNote(1, leadA, note.id, { userId: 11, role: 'member' }, 'hostile edit'),
      /author or a manager/i
    );
    const byAuthor = outbound.editNote(1, leadA, note.id, { userId: 10, role: 'member' }, 'author edit');
    assert.equal(byAuthor.body, 'author edit');
    const byAdmin = outbound.editNote(1, leadA, note.id, { userId: 12, role: 'admin' }, 'manager edit');
    assert.equal(byAdmin.body, 'manager edit');
    assert.throws(() => outbound.removeNote(1, leadA, note.id, { userId: 11, role: 'member' }), /author or a manager/i);
    const gone = outbound.removeNote(1, leadA, note.id, { userId: 10, role: 'member' });
    assert.equal(gone.deleted, true);
  });

  await checkAsync('E12 a lead from another workspace is invisible here', async () => {
    const db2 = openWorkspaceDb(2);
    let other = domain.leadsCreate(2, { business_name: 'Other WS Biz', phone: '6105550199' }).id;
    // Walk ws2 ids past every ws1 id so the lookup is a true miss.
    while (db1.prepare('SELECT 1 FROM leads WHERE id = ?').get(other)) {
      other = domain.leadsCreate(2, { business_name: 'Other WS Biz ' + other, phone: '6105550199' }).id;
    }
    assert.ok(db2.prepare('SELECT 1 FROM leads WHERE id = ?').get(other));
    await assert.rejects(async () => outbound.getContactData(1, other), /not found/i);
    await assert.rejects(async () => outbound.startOutboundCall(1, other, { userId: 10, name: 'F' }), /not found/i);
  });

  /* ------------------------- frontend pins ------------------------ */
  check('F1 pipeline card: Contact button sits next to Intent and routes right', () => {
    const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    const intentBtn = 'data-act="intent" data-id="${l.id}">Intent</button>';
    const contactBtn = 'data-act="contact" data-id="${l.id}">Contact</button>';
    assert.ok(app.includes(intentBtn), 'intent button present');
    assert.ok(app.includes(contactBtn), 'contact button present');
    assert.ok(app.indexOf(contactBtn) > app.indexOf(intentBtn), 'contact after intent in the card');
    assert.ok(app.includes("window.location.hash = '#/contact/' + t.dataset.id"));
    assert.ok(app.includes('contact: pageLeadContact,'));
    assert.ok(app.includes('async function pageLeadContact(param)'));
  });

  check('F2 api client + vendored softphone SDK', () => {
    const api = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    for (const fn of ['contactGet', 'contactToken', 'contactStart', 'contactDial', 'contactNoteAdd', 'adminCallDisclosureSave']) {
      assert.ok(api.includes(fn + ':'), `api.${fn} missing`);
    }
    const sdk = fs.readFileSync(path.join(root, 'public/js/twilio.min.js'), 'utf8');
    assert.ok(sdk.length > 100000, 'twilio sdk vendored');
    assert.ok(sdk.includes('twilio-client.js'), 'twilio sdk header');
  });

  /* ------------------------------ HTTP ---------------------------- */
  await httpChecks();

  outbound.clearTransportForTests();
  console.log(JSON.stringify({ passed: true, groups: results.length, checks: results }));
}

async function httpChecks() {
  const bcrypt = require('bcryptjs');
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  const hash = (pw) => bcrypt.hashSync(pw, 12);
  const q = (sql, params) => db.query(sql, params);
  await q("INSERT INTO workspaces (id, name, slug) VALUES (1, 'B162 One', 'b162-one')");
  await q("INSERT INTO workspaces (id, name, slug) VALUES (2, 'B162 Two', 'b162-two')");
  await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 0, :s)', {
    e: 'owner162@example.invalid',
    h: hash('OwnerPass162!'),
    n: 'Owner One',
    s: 'active',
  });
  await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 0, :s)', {
    e: 'other162@example.invalid',
    h: hash('OtherPass162!'),
    n: 'Owner Two',
    s: 'active',
  });
  const [u1] = await q('SELECT id FROM users WHERE email = :e', { e: 'owner162@example.invalid' });
  const [u2] = await q('SELECT id FROM users WHERE email = :e', { e: 'other162@example.invalid' });
  await q('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (:w, :u, :r)', { w: 1, u: u1.id, r: 'owner' });
  await q('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (:w, :u, :r)', { w: 2, u: u2.id, r: 'owner' });

  // Platform Twilio creds: the webhook signature gate goes live.
  await platform.setPlatformSetting('twilio.account_sid', TWILIO_SID);
  await platform.setPlatformSetting('twilio.auth_token', TWILIO_TOKEN);
  // Pin the public URL so the signature base is deterministic in the
  // spawned server (Batch 56 resolution order — same pin as Batch 76).
  await platform.setPlatformSetting('general.public_url', APP_URL);

  const httpLead = domain.leadsCreate(1, {
    business_name: 'HTTP Biz',
    phone: '6105550123',
    email: 'http@example.invalid',
    city: 'Reading',
  }).id;

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

    function makeJar() {
      const cookies = new Map();
      return {
        async fetch(url, opts = {}) {
          const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
          if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
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
    const jpost = (jar, p, body, headers) =>
      jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}), headers });
    const jget = (jar, p, headers) => jar.fetch(BASE + p, { headers });
    const asJson = async (res) => {
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    };
    const totp = require(path.join(root, 'src/totp.js'));
    const secrets = new Map();
    async function loginFull(jar, email, password) {
      const first = await jpost(jar, '/api/v1/auth/login', { email, password });
      const body = await asJson(first);
      if (body && body.data && body.data.mfaRequired) {
        if (body.data.mfaStage === 'enroll') {
          const start = await asJson(await jpost(jar, '/api/v1/auth/mfa/enroll/start', {}));
          secrets.set(email, start.data.secret);
          await jpost(jar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(start.data.secret) });
        } else {
          await jpost(jar, '/api/v1/auth/mfa/verify', { code: totp.totp(secrets.get(email)) });
        }
      }
      return first.status;
    }

    await checkAsync('H1 anonymous contact page → 401', async () => {
      const res = await fetch(`${BASE}/api/v1/leads/${httpLead}/contact`, {
        headers: { 'x-forwarded-proto': 'https' },
      });
      assert.equal(res.status, 401);
    });

    const jarA = makeJar();
    const jarB = makeJar();
    await checkAsync('H2 workspace owner opens the contact page', async () => {
      const status = await loginFull(jarA, 'owner162@example.invalid', 'OwnerPass162!');
      assert.equal(status, 200);
      const res = await jget(jarA, `/api/v1/leads/${httpLead}/contact`, { 'x-workspace-id': '1' });
      assert.equal(res.status, 200);
      const body = await asJson(res);
      assert.equal(body.data.lead.businessName, 'HTTP Biz');
      assert.equal(body.data.hasPhone, true);
      assert.equal(body.data.disclosure, outbound.DEFAULT_DISCLOSURE);
    });

    await checkAsync('H3 staff from another workspace → 403 page + token', async () => {
      const status = await loginFull(jarB, 'other162@example.invalid', 'OtherPass162!');
      assert.equal(status, 200);
      const res = await jget(jarB, `/api/v1/leads/${httpLead}/contact`, { 'x-workspace-id': '1' });
      assert.equal(res.status, 403);
      const res2 = await jpost(jarB, `/api/v1/leads/${httpLead}/contact/token`, {}, { 'x-workspace-id': '1' });
      assert.equal(res2.status, 403);
    });

    let httpCallRef = '';
    let httpRoom = '';
    await checkAsync('H4 owner starts a call + adds a note over HTTP', async () => {
      const res = await jpost(jarA, `/api/v1/leads/${httpLead}/contact/start`, {}, { 'x-workspace-id': '1' });
      assert.equal(res.status, 200);
      const body = await asJson(res);
      httpCallRef = body.data.callRef;
      httpRoom = body.data.room;
      assert.ok(httpCallRef.startsWith('outbound-'));
      assert.ok(httpRoom.startsWith('leadcall-'));
      const note = await jpost(
        jarA,
        `/api/v1/leads/${httpLead}/contact/notes`,
        { body: 'HTTP follow-up note' },
        { 'x-workspace-id': '1' }
      );
      assert.equal(note.status, 200);
      const page = await asJson(await jget(jarA, `/api/v1/leads/${httpLead}/contact`, { 'x-workspace-id': '1' }));
      const noteItem = page.data.timeline.find((i) => i.kind === 'note');
      assert.ok(noteItem && noteItem.note.body === 'HTTP follow-up note');
    });

    const sign = (url, params) => {
      let data = url;
      for (const k of Object.keys(params).sort()) data += k + params[k];
      return crypto.createHmac('sha1', TWILIO_TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64');
    };
    const twilioPost = async (urlPath, params, signature) => {
      const res = await fetch(BASE + urlPath, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature,
          'x-forwarded-proto': 'https',
        },
        body: new URLSearchParams(params).toString(),
      });
      return { status: res.status, text: await res.text() };
    };

    await checkAsync('H5 softphone webhook returns the staff-leg TwiML (signed)', async () => {
      const params = {
        workspaceId: '1',
        leadId: String(httpLead),
        ref: httpCallRef,
        room: httpRoom,
        CallSid: 'CA-staff-leg',
        From: 'client:staff-1-ws1',
        To: 'AP162fixtureapp',
        AccountSid: TWILIO_SID,
      };
      const url = `${APP_URL}/api/v1/calls/softphone`;
      const r = await twilioPost('/api/v1/calls/softphone', params, sign(url, params));
      assert.equal(r.status, 200);
      assert.ok(r.text.includes(httpRoom));
      assert.ok(r.text.includes('startConferenceOnEnter="false"'));
    });

    await checkAsync('H6 lead-leg webhook: disclosure Say before the recording conference', async () => {
      const params = { CallSid: 'CA-lead-leg-http', From: '+16105550100', To: '+16105550123', AccountSid: TWILIO_SID };
      const urlPath = `/api/v1/calls/outbound-lead/1/${httpLead}?ref=${httpCallRef}`;
      const r = await twilioPost(urlPath, params, sign(APP_URL + urlPath, params));
      assert.equal(r.status, 200);
      const sayAt = r.text.indexOf('<Say>');
      const confAt = r.text.indexOf('<Conference');
      assert.ok(sayAt > -1 && confAt > sayAt, 'disclosure precedes the conference');
      assert.ok(r.text.includes(outbound.DEFAULT_DISCLOSURE));
      assert.ok(r.text.includes('record="record-from-answer"'));
    });

    await checkAsync('H7 bogus Twilio signature → 403', async () => {
      const params = { CallSid: 'CA-x', From: '+1', To: '+2', AccountSid: TWILIO_SID };
      const urlPath = `/api/v1/calls/outbound-lead/1/${httpLead}?ref=${httpCallRef}`;
      const r = await twilioPost(urlPath, params, 'bogus-signature');
      assert.equal(r.status, 403);
    });

    const pollRow = async (fn) => {
      for (let n = 0; n < 40; n++) {
        const row = domain.withDb(1, (db) => modules.getCallLogBySid(db, httpCallRef));
        if (row && fn(row)) return row;
        await new Promise((r) => setTimeout(r, 250));
      }
      return domain.withDb(1, (db) => modules.getCallLogBySid(db, httpCallRef));
    };

    await checkAsync('H8 status + recording callbacks land on the call record', async () => {
      const statusParams = {
        CallSid: 'CA-lead-leg-http',
        CallStatus: 'completed',
        CallDuration: '42',
        AccountSid: TWILIO_SID,
      };
      const statusPath = `/api/v1/calls/outbound-status/1/${httpLead}?ref=${httpCallRef}`;
      const rs = await twilioPost(statusPath, statusParams, sign(APP_URL + statusPath, statusParams));
      assert.equal(rs.status, 200);
      let row = await pollRow((r) => r.status === 'completed' && Number(r.duration_seconds) === 42);
      assert.equal(row.status, 'completed');
      assert.equal(Number(row.duration_seconds), 42);

      const recParams = {
        CallSid: 'CA-lead-leg-http',
        RecordingSid: 'RE-http-162',
        RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Recordings/RE-http-162`,
        RecordingDuration: '40',
        AccountSid: TWILIO_SID,
      };
      const recPath = `/api/v1/calls/outbound-recording/1/${httpLead}?ref=${httpCallRef}`;
      const rr = await twilioPost(recPath, recParams, sign(APP_URL + recPath, recParams));
      assert.equal(rr.status, 200);
      row = await pollRow((r) => !!r.recording_url);
      assert.ok(row.recording_url.includes('RE-http-162'));
      // The existing billing-aware Whisper flow fired and settled
      // honestly: this fixture workspace has no credits and is not
      // Premium, so it ends 'skipped_no_credits' (with credits it
      // would end 'unavailable' — no STT key in the fixture). Either
      // proves the flow ran without inventing text.
      row = await pollRow((r) => r.transcript_status !== 'none' && r.transcript_status !== 'pending');
      assert.ok(
        row.transcript_status === 'unavailable' || row.transcript_status === 'skipped_no_credits',
        'unexpected transcript end state: ' + row.transcript_status
      );
      assert.equal(row.transcript, '');
    });
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {}
  });
