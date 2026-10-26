'use strict';

/**
 * Call Tracking (Batch 21) — Twilio voice webhooks + recording playback.
 *
 * Public (Twilio-facing) endpoints, mounted at /api/v1/calls:
 *   POST /voice/:workspaceId/:leadId      → TwiML for an inbound call
 *   POST /status/:workspaceId/:leadId     → Dial action / status callback
 *   POST /recording/:workspaceId/:leadId  → recording status callback
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
const { appUrl } = require('../stripeClient');
const clientPortal = require('../clientPortal');
const { getMembership, findWorkspaceByToken } = require('../workspace');

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
  const { authToken } = await twilioClient.getCredentials();
  if (!authToken) return { ok: true, verified: false };
  const url = `${publicBaseUrl(req)}${String(req.originalUrl || req.url || '').split('?')[0]}`;
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
      // One notification email per call (addendum #4): background too.
      Promise.resolve(callNotify.notifyCallByEmail(ids.workspaceId, ids.leadId, row.call_sid)).catch(() => {});
    }
    if (row && row.recording_url) maybeTranscribe(ids.workspaceId, ids.leadId, row);
  } catch (e) {
    console.warn('[calls] status webhook failed:', e.message || e);
  }
  return res.type('text/xml').send(EMPTY_TWIML);
});

router.post('/recording/:workspaceId/:leadId', async (req, res) => {
  const ids = parseIds(req);
  if (!ids) return res.type('text/xml').send(EMPTY_TWIML);
  const sig = await checkSignature(req);
  if (!sig.ok) return res.status(403).type('text/plain').send('Invalid Twilio signature');
  if (!(await workspaceExists(ids.workspaceId))) return res.type('text/xml').send(EMPTY_TWIML);
  try {
    const body = req.body || {};
    const row = await domain.withDb(ids.workspaceId, (db) => {
      if (!leadExists(db, ids.leadId)) return null;
      if (body.CallSid) modules.upsertCallStatus(db, ids.leadId, { CallSid: body.CallSid }, { verified: sig.verified });
      return modules.storeCallRecording(db, body.CallSid, {
        recordingSid: body.RecordingSid,
        recordingUrl: body.RecordingUrl,
        recordingDuration: body.RecordingDuration,
      });
    });
    if (row) maybeTranscribe(ids.workspaceId, ids.leadId, row);
  } catch (e) {
    console.warn('[calls] recording webhook failed:', e.message || e);
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
  const staffSession = req.staffSession || req.session;
  if (staffSession && staffSession.userId) {
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
  if (caller.leadId != null && Number(row.lead_id) !== caller.leadId) {
    return res.status(404).json({ ok: false, error: 'Recording not found' });
  }
  const media = await twilioClient.fetchRecordingMedia(row.recording_url);
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
