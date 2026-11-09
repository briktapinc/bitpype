'use strict';

/**
 * Lead calling (Batch 162) — outbound staff calls from the pipeline
 * Contact page, on the SAME Twilio account/credentials and the SAME
 * Whisper transcription path as inbound call tracking (Batch 21).
 *
 * Shape of a call (two legs, one conference):
 *   1. Staff clicks Call → POST contact-call/start creates the
 *      call_logs row (direction 'outbound', call_sid = our ref) and
 *      the browser fetches a capability token (below).
 *   2. The browser softphone (Twilio Client JS) connects; its TwiML
 *      (the Voice app's URL, /api/v1/calls/softphone) parks the staff
 *      leg in a conference room, startConferenceOnEnter=false.
 *   3. The browser then asks the server to dial the lead leg
 *      (contact-call/:ref/dial): a REST call from the workspace's
 *      Twilio number to the lead. When the lead answers, Twilio
 *      fetches the lead-leg TwiML: a <Say> speaks the recording
 *      disclosure to the LEAD, and only then a <Dial><Conference
 *      record="record-from-answer"> joins the room — recording
 *      starts at the join, after the disclosure, exactly the
 *      sequence Pennsylvania all-party consent wants: the lead
 *      hears the disclosure before anyone is bridged in and before
 *      any recording exists.
 *   4. The conference recording callback stores the recording on the
 *      call row and the EXISTING billing-aware Whisper flow
 *      (callBilling.transcribeCallRecording → twilioClient
 *      .transcribeRecording) produces the transcript.
 *
 * Capability token: the classic Twilio capability JWT (HS256, signed
 * with the account auth token), scoped client:incoming + client:
 * outgoing against a TwiML Voice app. The app is provisioned lazily
 * per credential source through the Twilio REST Applications API and
 * its SID cached (platform setting for platform creds, workspace
 * setting for workspace SMS creds) — no console trip, no new keys.
 *
 * Caller ID rule: the lead's own call-tracking display number when
 * the lead has one configured; otherwise the workspace SMS
 * from-number; otherwise no caller ID exists and calls cannot start.
 */

const crypto = require('crypto');
const domain = require('./domain');
const modules = require('./siteModules');
const twilioClient = require('./twilioClient');
const platform = require('./platform');
const { appUrl } = require('./stripeClient');

const DEFAULT_DISCLOSURE = 'This call may be recorded for quality and note-taking.';
const DISCLOSURE_SETTING_KEY = 'calls.recording_disclosure';
const VOICE_APP_SETTING_KEY = 'calls.voice_app_sid';
const VOICE_APP_NAME = 'BitPype Lead Calling';

function coded(code, message, status) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function publicBase() {
  try {
    return String(appUrl() || '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

/* ------------------------- test seams ----------------------------- */
/* Same pattern as callRescue.setTransportForTests: production code   */
/* paths are the defaults; suites swap in stubs so no real Twilio     */
/* call or Whisper request ever leaves a test.                        */
const hooks = { credentials: null, createCall: null, transcribe: null, ensureAppSid: null };
function setTransportForTests(t) {
  if (!t) return;
  if (t.credentials !== undefined) hooks.credentials = t.credentials;
  if (t.createCall !== undefined) hooks.createCall = t.createCall;
  if (t.transcribe !== undefined) hooks.transcribe = t.transcribe;
  if (t.ensureAppSid !== undefined) hooks.ensureAppSid = t.ensureAppSid;
}
function clearTransportForTests() {
  hooks.credentials = null;
  hooks.createCall = null;
  hooks.transcribe = null;
  hooks.ensureAppSid = null;
}

async function credentialsFor(workspaceId) {
  if (hooks.credentials) return hooks.credentials;
  return twilioClient.getCredentials({ workspaceId });
}

/* --------------------------- settings ----------------------------- */

function getDisclosure(db) {
  const raw = String(domain.getSetting(db, DISCLOSURE_SETTING_KEY, '') || '').trim();
  return raw || DEFAULT_DISCLOSURE;
}

function setDisclosure(workspaceId, text) {
  const value = String(text || '').trim().slice(0, 300);
  return domain.withDb(workspaceId, (db) => {
    domain.setSetting(db, DISCLOSURE_SETTING_KEY, value);
    return { disclosure: getDisclosure(db), isDefault: !value };
  });
}

/**
 * Caller ID for an outbound call to this lead: its call-tracking
 * display number first (the number its own site shows — the lead
 * recognises it), else the workspace SMS from-number.
 */
function resolveCallerId(db, leadId) {
  try {
    const cfg = modules.getCallTrackingConfig(db, Number(leadId));
    if (cfg && cfg.display_number) return { number: String(cfg.display_number), source: 'calltracking' };
  } catch {
    /* config unreadable → fall through to the SMS number */
  }
  try {
    const sms = require('../src/sms');
    const cfg = sms.readSmsConfig(sms.readWorkspaceSettings(db));
    if (cfg.fromNumber) return { number: String(cfg.fromNumber), source: 'sms' };
  } catch {
    /* settings unreadable → no caller id */
  }
  return { number: '', source: 'none' };
}

/* --------------------- capability token --------------------------- */

function buildCapabilityToken({ accountSid, authToken, identity, appSid, ttlSeconds = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (v) => encodeURIComponent(String(v || ''));
  const scopes = [
    `scope:client:incoming?clientName=${enc(identity)}`,
    `scope:client:outgoing?appSid=${enc(appSid)}&clientName=${enc(identity)}`,
  ];
  const header = { typ: 'JWT', alg: 'HS256' };
  const payload = {
    jti: `${accountSid}-${now}`,
    iss: String(accountSid || ''),
    exp: now + Math.max(60, Number(ttlSeconds) || 3600),
    scope: scopes.join(' '),
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.createHmac('sha256', String(authToken || '')).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}

async function twilioApi(creds, path, form) {
  const headers = {
    Authorization:
      'Basic ' + Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64'),
  };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01${path}`, {
    method: form ? 'POST' : 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(
      (data && (data.message || data.error_message)) || `Twilio request failed (HTTP ${res.status})`
    );
    err.code = 'TWILIO_ERROR';
    err.status = 502;
    err.twilioStatus = res.status;
    throw err;
  }
  return data;
}

/**
 * The TwiML Voice app the capability token dials out through. One
 * app per credential source: its VoiceUrl is the workspace-agnostic
 * softphone endpoint (the browser passes workspace/lead/call params
 * on connect, so a single app serves every workspace on the account).
 */
async function ensureVoiceAppSid(workspaceId, creds) {
  if (hooks.ensureAppSid) return hooks.ensureAppSid(workspaceId, creds);
  const voiceUrl = `${publicBase()}/api/v1/calls/softphone`;
  const readCached = async () => {
    if (creds.source === 'platform') {
      return String((await platform.getPlatformSetting('twilio.voice_app_sid', '')) || '').trim();
    }
    return domain.withDb(workspaceId, (db) =>
      String(domain.getSetting(db, VOICE_APP_SETTING_KEY, '') || '').trim()
    );
  };
  const saveCached = async (sid) => {
    if (creds.source === 'platform') {
      await platform.setPlatformSetting('twilio.voice_app_sid', sid);
    } else {
      domain.withDb(workspaceId, (db) => domain.setSetting(db, VOICE_APP_SETTING_KEY, sid));
    }
  };
  let sid = await readCached();
  if (sid) {
    try {
      const app = await twilioApi(
        creds,
        `/Accounts/${encodeURIComponent(creds.accountSid)}/Applications/${encodeURIComponent(sid)}.json`
      );
      if (app && String(app.voice_url || '') !== voiceUrl) {
        await twilioApi(
          creds,
          `/Accounts/${encodeURIComponent(creds.accountSid)}/Applications/${encodeURIComponent(sid)}.json`,
          { VoiceUrl: voiceUrl, VoiceMethod: 'POST' }
        );
      }
      return sid;
    } catch (e) {
      if (!e || e.twilioStatus !== 404) throw e;
      sid = '';
    }
  }
  const created = await twilioApi(creds, `/Accounts/${encodeURIComponent(creds.accountSid)}/Applications.json`, {
    FriendlyName: VOICE_APP_NAME,
    VoiceUrl: voiceUrl,
    VoiceMethod: 'POST',
  });
  sid = String((created && created.sid) || '');
  if (!sid) throw coded('TWILIO_ERROR', 'Twilio did not return a Voice app SID.', 502);
  await saveCached(sid);
  return sid;
}

async function mintSoftphoneToken(workspaceId, staffUserId) {
  const creds = await credentialsFor(workspaceId);
  if (!creds.accountSid || !creds.authToken) return { configured: false };
  const appSid = await ensureVoiceAppSid(workspaceId, creds);
  if (!appSid) return { configured: false, reason: 'no_voice_app' };
  const identity = `staff-${Number(staffUserId) || 0}-ws${Number(workspaceId)}`;
  return {
    configured: true,
    token: buildCapabilityToken({ accountSid: creds.accountSid, authToken: creds.authToken, identity, appSid }),
    identity,
  };
}

/* --------------------------- call flow ---------------------------- */

function leadRowOr404(db, leadId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId));
  if (!lead) throw coded('NOT_FOUND', 'Lead not found', 404);
  return lead;
}

/** Step 1 (staff click): create the outbound call record. */
function startOutboundCall(workspaceId, leadId, staff = {}) {
  return domain.withDb(workspaceId, (db) => {
    const lead = leadRowOr404(db, leadId);
    const phone = String(lead.phone || '').trim();
    if (!phone) {
      throw coded('NO_PHONE', 'This lead has no phone number to call.', 400);
    }
    const caller = resolveCallerId(db, leadId);
    if (!caller.number) {
      throw coded(
        'NO_CALLER_ID',
        'No Twilio number is available to call from — set up call tracking for this business or add the workspace SMS number first.',
        400
      );
    }
    const callRef = `outbound-${crypto.randomUUID()}`;
    const room = `leadcall-${crypto.randomUUID()}`;
    const row = modules.createOutboundCall(db, leadId, {
      callRef,
      fromNumber: caller.number,
      toNumber: phone,
      staffUserId: staff.userId,
      staffName: staff.name,
      room,
    });
    return {
      callRef,
      room,
      from: caller.number,
      fromSource: caller.source,
      to: phone,
      disclosure: getDisclosure(db),
      call: shapeCall(row),
    };
  });
}

/**
 * Step 3 (browser connected): originate the lead leg. The claim
 * makes a double-click / double-connect dial exactly once.
 */
async function dialLeadLeg(workspaceId, leadId, callRef) {
  const row = domain.withDb(workspaceId, (db) => modules.getCallLogBySid(db, String(callRef || '')));
  if (!row || row.direction !== 'outbound' || Number(row.lead_id) !== Number(leadId)) {
    throw coded('NOT_FOUND', 'Call not found', 404);
  }
  if (row.provider_call_sid) return { ok: true, alreadyDialed: true, call: shapeCall(row) };
  const claimed = domain.withDb(workspaceId, (db) => modules.claimOutboundDial(db, callRef));
  if (!claimed) {
    const again = domain.withDb(workspaceId, (db) => modules.getCallLogBySid(db, String(callRef || '')));
    if (again && again.provider_call_sid) return { ok: true, alreadyDialed: true, call: shapeCall(again) };
    throw coded('CONFLICT', 'This call is no longer in a state that can be dialed.', 409);
  }
  let to = String(row.to_number || '');
  try {
    to = modules.normalizeE164(to, 'Lead phone') || to;
  } catch {
    /* keep the stored value — Twilio will report the failure on the row */
  }
  const base = publicBase();
  const qs = `?ref=${encodeURIComponent(String(callRef))}`;
  const create = hooks.createCall || ((args) => twilioClient.createCall(args));
  let res;
  try {
    res = await create({
      from: row.from_number,
      to,
      url: `${base}/api/v1/calls/outbound-lead/${Number(workspaceId)}/${Number(leadId)}${qs}`,
      statusCallback: `${base}/api/v1/calls/outbound-status/${Number(workspaceId)}/${Number(leadId)}${qs}`,
      workspaceId,
    });
  } catch (e) {
    domain.withDb(workspaceId, (db) =>
      modules.updateOutboundCallStatus(db, callRef, { status: 'failed' })
    );
    throw e;
  }
  if (!res || !res.configured) {
    domain.withDb(workspaceId, (db) =>
      modules.updateOutboundCallStatus(db, callRef, { status: 'failed' })
    );
    return { configured: false };
  }
  const saved = domain.withDb(workspaceId, (db) =>
    modules.setOutboundProviderSid(db, callRef, res.sid)
  );
  return { ok: true, providerCallSid: String(res.sid || ''), call: shapeCall(saved) };
}

/** Staff leg: park the caller in the conference room. */
function buildStaffLegTwiml({ room } = {}) {
  const head = '<?xml version="1.0" encoding="UTF-8"?>';
  const name = String(room || '').trim();
  if (!name) return `${head}<Response><Hangup/></Response>`;
  return (
    `${head}<Response><Dial><Conference startConferenceOnEnter="false" ` +
    `endConferenceOnExit="true" maxParticipants="2">${xmlEscape(name)}</Conference></Dial></Response>`
  );
}

/**
 * Lead leg: the disclosure is spoken to the lead FIRST (their own
 * leg, before any Dial), then the conference join starts the
 * recording — record="record-from-answer" on the Conference starts
 * when the conference starts, i.e. when this participant joins,
 * after the <Say> has completed.
 */
function buildLeadLegTwiml({ workspaceId, leadId, callRef, room, disclosure, baseUrl } = {}) {
  const head = '<?xml version="1.0" encoding="UTF-8"?>';
  const base = String(baseUrl || '').replace(/\/$/, '');
  const name = String(room || '').trim();
  if (!name) return `${head}<Response><Hangup/></Response>`;
  const recordingUrl =
    `${base}/api/v1/calls/outbound-recording/${Number(workspaceId)}/${Number(leadId)}` +
    `?ref=${encodeURIComponent(String(callRef || ''))}`;
  return (
    `${head}<Response>` +
    `<Say>${xmlEscape(String(disclosure || DEFAULT_DISCLOSURE))}</Say>` +
    `<Dial><Conference record="record-from-answer" ` +
    `recordingStatusCallback="${xmlEscape(recordingUrl)}" recordingStatusCallbackMethod="POST" ` +
    `startConferenceOnEnter="true" endConferenceOnExit="true" maxParticipants="2">` +
    `${xmlEscape(name)}</Conference></Dial></Response>`
  );
}

function handleLeadStatus(workspaceId, leadId, callRef, params = {}) {
  return domain.withDb(workspaceId, (db) => {
    const row = modules.getCallLogBySid(db, String(callRef || ''));
    if (!row || row.direction !== 'outbound' || Number(row.lead_id) !== Number(leadId)) return null;
    return modules.updateOutboundCallStatus(db, callRef, {
      status: params.CallStatus,
      durationSeconds: params.CallDuration,
    });
  });
}

/**
 * Recording landed: store it on the call row (sid-keyed helpers work
 * unchanged because call_sid is our ref), then run the EXISTING
 * Whisper flow. 'pending' is stamped first so a duplicate callback
 * never double-fires it.
 */
async function handleRecording(workspaceId, leadId, callRef, params = {}) {
  const row = domain.withDb(workspaceId, (db) => {
    const existing = modules.getCallLogBySid(db, String(callRef || ''));
    if (!existing || existing.direction !== 'outbound' || Number(existing.lead_id) !== Number(leadId)) {
      return null;
    }
    return modules.storeCallRecording(db, String(callRef), {
      recordingSid: params.RecordingSid,
      recordingUrl: params.RecordingUrl,
      recordingDuration: params.RecordingDuration,
    });
  });
  if (row && row.recording_url) maybeTranscribeOutbound(workspaceId, leadId, row);
  return row;
}

function maybeTranscribeOutbound(workspaceId, leadId, row) {
  try {
    if (!row || !row.recording_url) return;
    if (row.transcript_status === 'done' || row.transcript_status === 'pending') return;
    domain.withDb(workspaceId, (db) => modules.setCallTranscript(db, row.call_sid, { status: 'pending' }));
    const run = hooks.transcribe
      ? hooks.transcribe(workspaceId, leadId, row.call_sid)
      : (async () => {
          const callBilling = require('./callBilling');
          const r = await callBilling.transcribeCallRecording(workspaceId, leadId, row.call_sid);
          try {
            domain.withDb(workspaceId, (db) => modules.stampTranscriptOriginal(db, row.call_sid));
          } catch {
            /* original stamp is best-effort */
          }
          return r;
        })();
    Promise.resolve(run).catch(() => {});
  } catch {
    /* transcription never breaks a webhook */
  }
}

/* ------------------------- contact page --------------------------- */

function shapeCall(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    callRef: String(row.call_sid || ''),
    direction: 'outbound',
    from: String(row.from_number || ''),
    to: String(row.to_number || ''),
    status: String(row.status || ''),
    durationSeconds: row.duration_seconds != null ? Number(row.duration_seconds) : null,
    staffUserId: row.staff_user_id != null ? Number(row.staff_user_id) : null,
    staffName: String(row.staff_name || ''),
    hasRecording: !!row.recording_url,
    recordingDuration: row.recording_duration != null ? Number(row.recording_duration) : null,
    transcript: String(row.transcript || ''),
    transcriptStatus: String(row.transcript_status || 'none'),
    transcriptEdited: !!Number(row.transcript_edited || 0),
    transcriptOriginal: String(row.transcript_original || ''),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  };
}

function shapeNote(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    leadId: Number(row.lead_id),
    staffUserId: row.staff_user_id != null ? Number(row.staff_user_id) : null,
    staffName: String(row.staff_name || ''),
    body: String(row.body || ''),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  };
}

/** One chronological follow-up timeline: calls + notes interleaved. */
function buildTimeline(calls, notes) {
  const items = [];
  for (const c of calls || []) {
    items.push({ kind: 'call', at: c.createdAt, id: c.id, call: c });
  }
  for (const n of notes || []) {
    items.push({ kind: 'note', at: n.createdAt, id: n.id, note: n });
  }
  items.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'call' ? -1 : 1;
    return a.id - b.id;
  });
  return items;
}

async function getContactData(workspaceId, leadId) {
  const creds = await credentialsFor(workspaceId);
  const twilioConfigured = !!(creds.accountSid && creds.authToken);
  return domain.withDb(workspaceId, (db) => {
    const lead = leadRowOr404(db, leadId);
    const calls = modules.listOutboundCalls(db, leadId).map(shapeCall);
    const notes = modules.listLeadContactNotes(db, leadId).map(shapeNote);
    const caller = resolveCallerId(db, leadId);
    let intent = null;
    try {
      intent = require('../src/outreach').getIntent(db, Number(leadId));
    } catch {
      intent = null;
    }
    return {
      lead: {
        id: Number(lead.id),
        businessName: String(lead.business_name || ''),
        contactName: String(lead.contact_name || lead.owner_name || ''),
        email: String(lead.email || ''),
        phone: String(lead.phone || ''),
        city: String(lead.city || ''),
        state: String(lead.state || ''),
        category: String(lead.category || ''),
        status: String(lead.status || ''),
        score: lead.score != null ? Number(lead.score) : null,
        website: String(lead.website || ''),
        notes: String(lead.notes || ''),
      },
      intent: intent ? { score: intent.score, label: intent.label } : null,
      hasPhone: !!String(lead.phone || '').trim(),
      callerId: caller.number,
      callerIdSource: caller.source,
      twilioConfigured,
      disclosure: getDisclosure(db),
      calls,
      notes,
      timeline: buildTimeline(calls, notes),
    };
  });
}

function getOutboundCall(workspaceId, leadId, callRef) {
  return domain.withDb(workspaceId, (db) => {
    const row = modules.getCallLogBySid(db, String(callRef || ''));
    if (!row || row.direction !== 'outbound' || Number(row.lead_id) !== Number(leadId)) return null;
    return shapeCall(row);
  });
}

function saveTranscriptEdit(workspaceId, leadId, callRef, text) {
  return domain.withDb(workspaceId, (db) => {
    const row = modules.getCallLogBySid(db, String(callRef || ''));
    if (!row || row.direction !== 'outbound' || Number(row.lead_id) !== Number(leadId)) {
      throw coded('NOT_FOUND', 'Call not found', 404);
    }
    return shapeCall(modules.editCallTranscript(db, String(callRef), String(text || '')));
  });
}

/* Notes: author-or-manager rule (owner/admin roles manage others'
 * notes, matching the staff permission pattern used across the app). */
function canManageNote(note, viewer = {}) {
  if (!note) return false;
  if (viewer.role === 'owner' || viewer.role === 'admin') return true;
  return note.staff_user_id != null && Number(note.staff_user_id) === Number(viewer.userId);
}

function addNote(workspaceId, leadId, staff = {}, body) {
  return domain.withDb(workspaceId, (db) => {
    leadRowOr404(db, leadId);
    return shapeNote(
      modules.addLeadContactNote(db, leadId, {
        staffUserId: staff.userId,
        staffName: staff.name,
        body,
      })
    );
  });
}

function editNote(workspaceId, leadId, noteId, viewer = {}, body) {
  return domain.withDb(workspaceId, (db) => {
    const note = modules.getLeadContactNote(db, Number(noteId));
    if (!note || Number(note.lead_id) !== Number(leadId)) {
      throw coded('NOT_FOUND', 'Note not found', 404);
    }
    if (!canManageNote(note, viewer)) {
      throw coded('FORBIDDEN', 'Only the note author or a manager can change this note.', 403);
    }
    return shapeNote(modules.updateLeadContactNote(db, Number(noteId), body));
  });
}

function removeNote(workspaceId, leadId, noteId, viewer = {}) {
  return domain.withDb(workspaceId, (db) => {
    const note = modules.getLeadContactNote(db, Number(noteId));
    if (!note || Number(note.lead_id) !== Number(leadId)) {
      throw coded('NOT_FOUND', 'Note not found', 404);
    }
    if (!canManageNote(note, viewer)) {
      throw coded('FORBIDDEN', 'Only the note author or a manager can delete this note.', 403);
    }
    modules.deleteLeadContactNote(db, Number(noteId));
    return { deleted: true, id: Number(noteId) };
  });
}

module.exports = {
  DEFAULT_DISCLOSURE,
  DISCLOSURE_SETTING_KEY,
  getDisclosure,
  setDisclosure,
  resolveCallerId,
  buildCapabilityToken,
  ensureVoiceAppSid,
  mintSoftphoneToken,
  startOutboundCall,
  dialLeadLeg,
  buildStaffLegTwiml,
  buildLeadLegTwiml,
  handleLeadStatus,
  handleRecording,
  maybeTranscribeOutbound,
  getContactData,
  getOutboundCall,
  saveTranscriptEdit,
  addNote,
  editNote,
  removeNote,
  canManageNote,
  shapeCall,
  shapeNote,
  buildTimeline,
  setTransportForTests,
  clearTransportForTests,
};
