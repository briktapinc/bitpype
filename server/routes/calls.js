'use strict';

/**
 * Call Tracking (Batch 21) — Twilio voice webhooks + recording playback.
 *
 * Public (Twilio-facing) endpoints, mounted at /api/v1/calls:
 *   POST /voice/:workspaceId/:leadId      → TwiML for an inbound call
 *   POST /status/:workspaceId/:leadId     → Dial action / status callback;
 *     an unanswered Dial outcome returns the voicemail greeting TwiML
 *     (Batch 26c) instead of ending the call, when voicemail is enabled
 *   POST /recording/:workspaceId/:leadId  → recording status callback;
 *     ?vm=1 marks a voicemail recording (transcribe + owner email flow)
 *   GET  /recording-file/:workspaceId/:callSid → authenticated playback
 *
 * Dormant-safe: with no platform Twilio credentials configured the
 * signature check is skipped (test mode) and rows record verified=0;
 * with credentials, an invalid X-Twilio-Signature is a hard 403.
 * The playback proxy is NOT public: portal clients hear only their own
 * lead's recordings; staff (workspace session members, or a workspace
 * bearer token — lead-scoped tokens stay pinned to their lead) hear any
 * lead in the workspace. server.js stashes req.portalSession /
 * req.staffSession for this router.
 */

const express = require('express');
const modules = require('../siteModules');
const portalContacts = require('../portalContacts');
const domain = require('../domain');
const { assertWorkspaceExists } = require('../workspaceExists');
const twilioClient = require('../twilioClient');
const callBilling = require('../callBilling');
const callNotify = require('../callNotify');
const { rateLimit } = require('../rateLimit');
// Missed-Call Rescue (Batch 76) is required lazily at the call sites,
// same pattern as the voicemail flow below.
const smsWebhookLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, name: 'twilio-sms-webhook' });
const rescueVoiceLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, name: 'twilio-rescue-voice' });
// Voicemail flow (Batch 26c) is required lazily at the recording
// branch — same pattern as the rentals settle below — so this router
// keeps loading in contexts that stub only the original seams.
const { appUrl } = require('../stripeClient');
const clientPortal = require('../clientPortal');
const { getMembership, findWorkspaceByToken } = require('../workspace');
/* Batch 168 (S1#4 residual): LAZY accessor, same discipline as
 * outboundCalls below — VM-loading suites stub this file's relative
 * requires, and a top-level '../middleware' require breaks them.
 * In production the sibling module always loads; the null fallback
 * exists only so a stubbed harness keeps its pre-168 behaviour. */
const sessionCaps = () => {
  try {
    const mw = require('../middleware');
    return { staff: mw.staffSessionAbsoluteExpired, portal: mw.portalSessionAbsoluteExpired };
  } catch {
    return null;
  }
};

const router = express.Router();

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const HANGUP_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';

function publicBaseUrl(req) {
  try {
    return String(appUrl() || '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

function parseIds(req) {
  const workspaceId = Number(req.params.workspaceId);
  const leadId = Number(req.params.leadId);
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) return null;
  if (!Number.isInteger(leadId) || leadId <= 0) return null;
  return { workspaceId, leadId };
}

async function workspaceExists(workspaceId) {
  try {
    await assertWorkspaceExists(workspaceId);
    return true;
  } catch {
    return false;
  }
}

function leadExists(db, leadId) {
  try {
    return !!db.prepare('SELECT 1 FROM leads WHERE id = ?').get(Number(leadId));
  } catch {
    return false;
  }
}

/**
 * Twilio signature gate. Returns { ok, verified }:
 * - no platform auth token → ok, verified=false (dormant/test mode)
 * - token set + valid signature → ok, verified=true
 * - token set + bad/missing signature → not ok (caller 403s)
 */
async function checkSignature(req) {
  // Workspace context from the route params: when the platform pair is
  // unset, the signature token resolves from this workspace's SMS
  // settings (Batch 25b credential fallback).
  const workspaceId = Number(req.params && req.params.workspaceId);
  return checkSignatureFor(req, workspaceId);
}

async function checkSignatureFor(req, workspaceIdRaw) {
  const workspaceId = Number(workspaceIdRaw);
  const { authToken } = await twilioClient.getCredentials(
    Number.isInteger(workspaceId) && workspaceId > 0 ? { workspaceId } : {}
  );
  if (!authToken) return { ok: true, verified: false };
  // Twilio signs the full request URL INCLUDING any query string (the
  // voicemail <Record> callbacks carry ?vm=1) — never strip it.
  const url = `${publicBaseUrl(req)}${String(req.originalUrl || req.url || '')}`;
  const valid = twilioClient.validateSignature(authToken, url, req.body || {}, req.headers['x-twilio-signature']);
  return valid ? { ok: true, verified: true } : { ok: false, verified: false };
}

/**
 * Fire-and-forget transcription; never throws into a webhook. The
 * billing-aware flow (plan check, zero-balance skip, per-transcript
 * credit) lives in server/callBilling.js — 'pending' is set here first
 * so simultaneous status + recording callbacks don't double-fire it.
 */
function maybeTranscribe(workspaceId, leadId, row) {
  try {
    if (!row || !row.recording_url || !row.call_sid) return;
    if (row.transcript_status === 'done' || row.transcript_status === 'pending') return;
    domain.withDb(workspaceId, (db) => modules.setCallTranscript(db, row.call_sid, { status: 'pending' }));
    Promise.resolve(callBilling.transcribeCallRecording(workspaceId, leadId, row.call_sid)).catch(() => {});
  } catch {
    /* ignore */
  }
}

router.post('/voice/:workspaceId/:leadId', async (req, res) => {
  const ids = parseIds(req);
  if (!ids) return res.type('text/xml').send(HANGUP_TWIML);
  const sig = await checkSignature(req);
  if (!sig.ok) return res.status(403).type('text/plain').send('Invalid Twilio signature');
  if (!(await workspaceExists(ids.workspaceId))) return res.type('text/xml').send(HANGUP_TWIML);
  try {
    const twiml = await domain.withDb(ids.workspaceId, (db) => {
      if (!leadExists(db, ids.leadId)) return HANGUP_TWIML;
      const config = modules.getCallTrackingConfig(db, ids.leadId);
      if (config.display_number && req.body && req.body.CallSid) {
        modules.logCallInitiated(db, ids.leadId, {
          callSid: req.body.CallSid,
          from: req.body.From,
          to: req.body.To,
          verified: sig.verified,
        });
      }
      return modules.buildCallTrackingVoiceTwiml(config, {
        workspaceId: ids.workspaceId,
        leadId: ids.leadId,
        baseUrl: publicBaseUrl(req),
      });
    });
    return res.type('text/xml').send(twiml);
  } catch (e) {
    console.warn('[calls] voice webhook failed:', e.message || e);
    return res.type('text/xml').send(HANGUP_TWIML);
  }
});

router.post('/status/:workspaceId/:leadId', async (req, res) => {
  const ids = parseIds(req);
  if (!ids) return res.type('text/xml').send(EMPTY_TWIML);
  const sig = await checkSignature(req);
  if (!sig.ok) return res.status(403).type('text/plain').send('Invalid Twilio signature');
  if (!(await workspaceExists(ids.workspaceId))) return res.type('text/xml').send(EMPTY_TWIML);
  let responseTwiml = EMPTY_TWIML;
  try {
    const row = await domain.withDb(ids.workspaceId, (db) => {
      if (!leadExists(db, ids.leadId)) return null;
      const r = modules.upsertCallStatus(db, ids.leadId, req.body || {}, { verified: sig.verified });
      if (r && modules.isTerminalCallStatus(r.status) && r.from_number) {
        try {
          portalContacts.captureFromCall(db, { leadId: ids.leadId, call: r });
        } catch (e) {
          console.warn('[calls] LeadScout call capture failed:', e.message || e);
        }
      }
      return r;
    });
    if (row && modules.isTerminalCallStatus(row.status)) {
      // Soft-cap settlement (addendum #3): background, never blocking.
      Promise.resolve(callBilling.settleCallBilling(ids.workspaceId, ids.leadId, row.call_sid)).catch(() => {});
      // Site Rentals (Batch 26): a counted call on a rented site is a
      // qualified site lead for the tenant — background, soft billing.
      try {
        Promise.resolve(require('../rentals').settleCallCharge(ids.workspaceId, row.call_sid)).catch(() => {});
      } catch {
        /* rentals unavailable — call flow unaffected */
      }
      // One notification email per call (addendum #4): background too.
      Promise.resolve(callNotify.notifyCallByEmail(ids.workspaceId, ids.leadId, row.call_sid)).catch(() => {});
      // Missed-Call Rescue (Batch 76): a terminal MISSED call on a
      // rescue-enabled call-tracking site opens exactly one rescue
      // (the engine re-checks miss + eligibility + suppression).
      try {
        Promise.resolve(
          require('../callRescue').maybeCreateRescue(ids.workspaceId, ids.leadId, row.call_sid)
        ).catch(() => {});
      } catch {
        /* rescue unavailable — call flow unaffected */
      }
    }
    if (row && row.recording_url) maybeTranscribe(ids.workspaceId, ids.leadId, row);
    // Voicemail (Batch 26c): this route is the <Dial> action callback.
    // When the business leg ended unanswered (no-answer / busy /
    // failed — the caller hung up on their own is 'canceled' and gets
    // no greeting), hand the still-live caller leg the greeting +
    // <Record> TwiML instead of ending the call. The greeting names
    // the business whose site the number belongs to (the config's
    // lead — for a rented site that is the site owner the site
    // presents as; delivery of the message resolves to the tenant).
    const dialStatus = String((req.body && req.body.DialCallStatus) || '').trim().toLowerCase();
    if (row && (dialStatus === 'no-answer' || dialStatus === 'busy' || dialStatus === 'failed')) {
      const vmTwiml = await domain.withDb(ids.workspaceId, (db) => {
        const config = modules.getCallTrackingConfig(db, ids.leadId);
        if (!config.display_number || !config.voicemail_enabled) return null;
        const lead = db.prepare('SELECT business_name FROM leads WHERE id = ?').get(ids.leadId);
        return modules.buildVoicemailTwiml(config, {
          workspaceId: ids.workspaceId,
          leadId: ids.leadId,
          baseUrl: publicBaseUrl(req),
          businessName: lead ? lead.business_name : '',
        });
      });
      if (vmTwiml) responseTwiml = vmTwiml;
    }
  } catch (e) {
    console.warn('[calls] status webhook failed:', e.message || e);
  }
  return res.type('text/xml').send(responseTwiml);
});

router.post('/recording/:workspaceId/:leadId', async (req, res) => {
  const ids = parseIds(req);
  if (!ids) return res.type('text/xml').send(EMPTY_TWIML);
  const sig = await checkSignature(req);
  if (!sig.ok) return res.status(403).type('text/plain').send('Invalid Twilio signature');
  if (!(await workspaceExists(ids.workspaceId))) return res.type('text/xml').send(EMPTY_TWIML);
  try {
    const body = req.body || {};
    // Voicemail recordings (Batch 26c) post to this same route with
    // ?vm=1 baked into the <Record> callback/action URLs: the message
    // is flagged on the call and routed to the voicemail flow
    // (transcribe → owner email) instead of the generic transcription
    // trigger, so the transcript can ride along in the email. Both the
    // <Record> action post and the recording status callback can land
    // — the voicemail flow claims its email exactly once.
    const isVoicemail = String((req.query && req.query.vm) || '') === '1';
    const row = await domain.withDb(ids.workspaceId, (db) => {
      if (!leadExists(db, ids.leadId)) return null;
      if (body.CallSid) modules.upsertCallStatus(db, ids.leadId, { CallSid: body.CallSid }, { verified: sig.verified });
      return modules.storeCallRecording(db, body.CallSid, {
        recordingSid: body.RecordingSid,
        recordingUrl: body.RecordingUrl,
        recordingDuration: body.RecordingDuration,
        voicemail: isVoicemail,
      });
    });
    if (row && isVoicemail && row.is_voicemail && row.recording_url) {
      try {
        Promise.resolve(
          require('../voicemailNotify').notifyVoicemailByEmail(ids.workspaceId, ids.leadId, row.call_sid)
        ).catch(() => {});
      } catch {
        /* voicemail flow unavailable — recording is still stored */
      }
    } else if (row) {
      maybeTranscribe(ids.workspaceId, ids.leadId, row);
    }
  } catch (e) {
    console.warn('[calls] recording webhook failed:', e.message || e);
  }
  return res.type('text/xml').send(EMPTY_TWIML);
});

/**
 * Missed-Call Rescue (Batch 76) — inbound SMS on a tracking number.
 * Twilio posts { From, To, Body, MessageSid }; the engine resolves
 * the lead from the dialed tracking number, honors STOP before
 * anything else, and advances the rescue conversation. Replies are
 * delivered by the engine over the same number. Signature rules are
 * identical to the voice webhooks (dormant mode skips, configured
 * mode hard-403s a bad signature).
 */
router.post('/sms/:workspaceId', smsWebhookLimit, async (req, res) => {
  const workspaceId = Number(req.params.workspaceId);
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) return res.type('text/xml').send(EMPTY_TWIML);
  const sig = await checkSignature(req);
  if (!sig.ok) return res.status(403).type('text/plain').send('Invalid Twilio signature');
  if (!(await workspaceExists(workspaceId))) return res.type('text/xml').send(EMPTY_TWIML);
  try {
    await require('../callRescue').handleInboundSms(workspaceId, {
      from: req.body && req.body.From,
      to: req.body && req.body.To,
      body: req.body && req.body.Body,
      messageSid: req.body && req.body.MessageSid,
    });
  } catch (e) {
    console.warn('[calls] rescue sms webhook failed:', e.message || e);
  }
  return res.type('text/xml').send(EMPTY_TWIML);
});

/**
 * Missed-Call Rescue (Batch 76) — the voice callback's TwiML route.
 * Twilio fetches this when the callee answers (no input → prompt for
 * the conversation's current stage) and posts each Gather result
 * back here. The engine carries the conversation state, so the call
 * never re-asks what the texts already collected.
 */
router.post('/rescue-voice/:workspaceId/:rescueId', rescueVoiceLimit, async (req, res) => {
  const workspaceId = Number(req.params.workspaceId);
  const rescueId = Number(req.params.rescueId);
  if (!Number.isInteger(workspaceId) || workspaceId <= 0 || !Number.isInteger(rescueId) || rescueId <= 0) {
    return res.type('text/xml').send(HANGUP_TWIML);
  }
  const sig = await checkSignature(req);
  if (!sig.ok) return res.status(403).type('text/plain').send('Invalid Twilio signature');
  if (!(await workspaceExists(workspaceId))) return res.type('text/xml').send(HANGUP_TWIML);
  try {
    const twiml = await require('../callRescue').handleVoiceInput(workspaceId, rescueId, {
      digits: req.body && req.body.Digits,
      speech: req.body && req.body.SpeechResult,
    });
    return res.type('text/xml').send(twiml || HANGUP_TWIML);
  } catch (e) {
    console.warn('[calls] rescue voice failed:', e.message || e);
    return res.type('text/xml').send(HANGUP_TWIML);
  }
});

/* ------------------------------------------------------------------ */
/* Lead calling (Batch 162) — outbound staff calls. The staff leg is   */
/* the Twilio Voice app's URL (one app per account, workspace-        */
/* agnostic: the browser passes workspaceId/leadId/ref/room as        */
/* Device.connect params, which arrive as POST fields). The lead leg, */
/* its status callback and the conference recording callback carry    */
/* the workspace/lead in the path and our call ref in the query,      */
/* exactly like the inbound routes above.                             */
/* ------------------------------------------------------------------ */
const outboundCalls = () => require('../outboundCalls'); // lazy accessor (Batch 162 finisher): VM-loading suites (production) stub relative requires — same fix as domainApi.js
const softphoneLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, name: 'twilio-softphone' });
const outboundLegLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, name: 'twilio-outbound-leg' });

function outboundRef(req) {
  return String((req.query && req.query.ref) || (req.body && req.body.ref) || '').trim();
}

router.post('/softphone', softphoneLimit, async (req, res) => {
  const body = req.body || {};
  const workspaceId = Number(body.workspaceId);
  const leadId = Number(body.leadId);
  const ref = String(body.ref || '').trim();
  const room = String(body.room || '').trim();
  if (
    !Number.isInteger(workspaceId) ||
    workspaceId <= 0 ||
    !Number.isInteger(leadId) ||
    leadId <= 0 ||
    !ref ||
    !room
  ) {
    return res.type('text/xml').send(HANGUP_TWIML);
  }
  const sig = await checkSignatureFor(req, workspaceId);
  if (!sig.ok) return res.status(403).type('text/plain').send('Invalid Twilio signature');
  if (!(await workspaceExists(workspaceId))) return res.type('text/xml').send(HANGUP_TWIML);
  try {
    const twiml = await domain.withDb(workspaceId, (db) => {
      const row = modules.getCallLogBySid(db, ref);
      if (
        !row ||
        row.direction !== 'outbound' ||
        Number(row.lead_id) !== leadId ||
        String(row.conference_name || '') !== room
      ) {
        return HANGUP_TWIML;
      }
      return outboundCalls().buildStaffLegTwiml({ room });
    });
    return res.type('text/xml').send(twiml);
  } catch (e) {
    console.warn('[calls] softphone twiml failed:', e.message || e);
    return res.type('text/xml').send(HANGUP_TWIML);
  }
});

router.post('/outbound-lead/:workspaceId/:leadId', outboundLegLimit, async (req, res) => {
  const ids = parseIds(req);
  const ref = outboundRef(req);
  if (!ids || !ref) return res.type('text/xml').send(HANGUP_TWIML);
  const sig = await checkSignature(req);
  if (!sig.ok) return res.status(403).type('text/plain').send('Invalid Twilio signature');
  if (!(await workspaceExists(ids.workspaceId))) return res.type('text/xml').send(HANGUP_TWIML);
  try {
    const twiml = await domain.withDb(ids.workspaceId, (db) => {
      const row = modules.getCallLogBySid(db, ref);
      if (!row || row.direction !== 'outbound' || Number(row.lead_id) !== ids.leadId) {
        return HANGUP_TWIML;
      }
      return outboundCalls().buildLeadLegTwiml({
        workspaceId: ids.workspaceId,
        leadId: ids.leadId,
        callRef: ref,
        room: row.conference_name,
        disclosure: outboundCalls().getDisclosure(db),
        baseUrl: publicBaseUrl(req),
      });
    });
    return res.type('text/xml').send(twiml);
  } catch (e) {
    console.warn('[calls] outbound lead twiml failed:', e.message || e);
    return res.type('text/xml').send(HANGUP_TWIML);
  }
});

router.post('/outbound-status/:workspaceId/:leadId', outboundLegLimit, async (req, res) => {
  const ids = parseIds(req);
  const ref = outboundRef(req);
  if (!ids || !ref) return res.type('text/xml').send(EMPTY_TWIML);
  const sig = await checkSignature(req);
  if (!sig.ok) return res.status(403).type('text/plain').send('Invalid Twilio signature');
  if (!(await workspaceExists(ids.workspaceId))) return res.type('text/xml').send(EMPTY_TWIML);
  try {
    await outboundCalls().handleLeadStatus(ids.workspaceId, ids.leadId, ref, req.body || {});
  } catch (e) {
    console.warn('[calls] outbound status failed:', e.message || e);
  }
  return res.type('text/xml').send(EMPTY_TWIML);
});

router.post('/outbound-recording/:workspaceId/:leadId', outboundLegLimit, async (req, res) => {
  const ids = parseIds(req);
  const ref = outboundRef(req);
  if (!ids || !ref) return res.type('text/xml').send(EMPTY_TWIML);
  const sig = await checkSignature(req);
  if (!sig.ok) return res.status(403).type('text/plain').send('Invalid Twilio signature');
  if (!(await workspaceExists(ids.workspaceId))) return res.type('text/xml').send(EMPTY_TWIML);
  try {
    await outboundCalls().handleRecording(ids.workspaceId, ids.leadId, ref, req.body || {});
  } catch (e) {
    console.warn('[calls] outbound recording failed:', e.message || e);
  }
  return res.type('text/xml').send(EMPTY_TWIML);
});

/**
 * Who may hear a recording in this workspace?
 * → { leadId: null } = any lead (staff member); { leadId: N } = pinned
 * to one lead (portal client, or lead-scoped bearer token); null = deny.
 */
async function resolveRecordingCaller(req, workspaceId) {
  const portalSession = req.portalSession || (req.session && req.session.clientPortalId ? req.session : null);
  if (portalSession && portalSession.clientPortalId) {
    /* Batch 168 (S1#4 residual): this proxy hand-rolls session auth,
     * so the session LIFETIME rules requireClient enforces (30h idle
     * + the Batch 168 absolute cap) and the staff absolute cap
     * (Batch 154) must be applied here too — before this, a session
     * the real gates had already expired still played recordings. */
    const caps = sessionCaps();
    const idleMs = Number(req.app && req.app.locals && req.app.locals.portalIdleMs) || 30 * 60 * 60 * 1000;
    const lastActive = Number(portalSession.clientLastActiveAt) || 0;
    const idleDead = lastActive > 0 && Date.now() - lastActive > idleMs;
    if (!idleDead && !(caps && caps.portal(portalSession))) {
      try {
        const client = await clientPortal.findById(portalSession.clientPortalId);
        if (
          client &&
          String(client.status) === 'active' &&
          Number(client.workspace_id) === workspaceId &&
          Number(client.lead_id) > 0
        ) {
          return { via: 'portal', leadId: Number(client.lead_id) };
        }
      } catch {
        /* fall through to staff/token */
      }
    }
  }
  const staffSession = req.staffSession || req.session;
  const capsForStaff = sessionCaps();
  if (staffSession && staffSession.userId && !(capsForStaff && capsForStaff.staff({ session: staffSession }))) {
    try {
      const membership = await getMembership(staffSession.userId, workspaceId);
      if (membership) return { via: 'staff', leadId: null };
    } catch {
      /* fall through */
    }
  }
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    try {
      const ws = await findWorkspaceByToken(auth.slice(7).trim());
      if (ws && Number(ws.workspace_id) === workspaceId) {
        return {
          via: 'token',
          leadId: ws.lead_id != null && Number(ws.lead_id) > 0 ? Number(ws.lead_id) : null,
        };
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

router.get('/recording-file/:workspaceId/:callSid', async (req, res) => {
  const workspaceId = Number(req.params.workspaceId);
  const callSid = String(req.params.callSid || '').trim();
  if (!Number.isInteger(workspaceId) || workspaceId <= 0 || !callSid) {
    return res.status(400).json({ ok: false, error: 'Invalid recording reference' });
  }
  const caller = await resolveRecordingCaller(req, workspaceId);
  if (!caller) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
  if (!(await workspaceExists(workspaceId))) {
    return res.status(404).json({ ok: false, error: 'Workspace not found' });
  }
  const row = await domain.withDb(workspaceId, (db) => modules.getCallLogBySid(db, callSid));
  if (!row || !row.recording_url) {
    return res.status(404).json({ ok: false, error: 'Recording not found' });
  }
  // Owner OR stamped tenant (Batch 26 rentals): a rented site's calls
  // live on the owner's row but are the tenant's leads — the tenant's
  // portal must hear them too. Anyone else stays a 404.
  if (
    caller.leadId != null &&
    Number(row.lead_id) !== caller.leadId &&
    Number(row.tenant_lead_id || 0) !== caller.leadId
  ) {
    return res.status(404).json({ ok: false, error: 'Recording not found' });
  }
  const media = await twilioClient.fetchRecordingMedia(row.recording_url, { workspaceId });
  if (!media.configured) {
    return res.status(503).json({ ok: false, error: 'Call recording playback is not configured' });
  }
  if (!media.ok) {
    return res.status(502).json({ ok: false, error: 'Recording could not be fetched' });
  }
  res.setHeader('Content-Type', media.contentType || 'audio/mpeg');
  res.setHeader('Content-Length', String(media.buffer.length));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(media.buffer);
});

module.exports = router;
