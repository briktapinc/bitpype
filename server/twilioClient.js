'use strict';

/**
 * Twilio Voice client for the Call Tracking module (Batch 21).
 *
 * ONE place talks to Twilio: number search/purchase (staff "Buy a
 * number"), recording media fetches (authenticated playback proxy +
 * transcription), and webhook signature validation.
 *
 * Credential resolution (Batch 25b), first complete pair wins:
 *   1. Platform settings twilio.account_sid / twilio.auth_token.
 *   2. The workspace's SMS settings (sms.account_sid + sms.auth_token /
 *      sms.api_key), read DECRYPTED via src/sms.js — this is where the
 *      owner actually manages Twilio keys (Admin → SMS), so that one
 *      entry point now feeds both SMS and call tracking. Needs a
 *      workspace context: callers pass { workspaceId }.
 *   3. Neither → every entry point reports "not configured" and the
 *      feature stays dormant; nothing here throws just because Twilio
 *      is not connected.
 *
 * Transcription reuses the platform's existing AI key (ai.api_key /
 * ai.base_url — the OpenAI-compatible key other features use) against
 * the Whisper-style /audio/transcriptions endpoint. No key → the
 * caller records transcript_status 'unavailable'; transcription
 * failures NEVER fail the webhook that triggered them.
 */

const crypto = require('crypto');
const platform = require('./platform');

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

async function getCredentials(opts = {}) {
  const [sid, token] = await Promise.all([
    platform.getPlatformSetting('twilio.account_sid', ''),
    platform.getPlatformSetting('twilio.auth_token', ''),
  ]);
  const platformPair = {
    accountSid: String(sid || '').trim(),
    authToken: String(token || '').trim(),
  };
  if (platformPair.accountSid && platformPair.authToken) {
    return { ...platformPair, source: 'platform' };
  }
  // Fallback: the workspace's SMS settings. The pair is taken whole —
  // never mix a SID from one account with a token from another.
  const workspaceId = Number(opts && opts.workspaceId);
  if (Number.isInteger(workspaceId) && workspaceId > 0) {
    try {
      const { openWorkspaceDb } = require('./workspaceDb');
      const sms = require('../src/sms');
      const cfg = sms.readSmsConfig(sms.readWorkspaceSettings(openWorkspaceDb(workspaceId)));
      if (cfg.accountSid && cfg.authToken) {
        return { accountSid: cfg.accountSid, authToken: cfg.authToken, source: 'workspace' };
      }
    } catch {
      /* workspace unreadable → stay dormant */
    }
  }
  return { ...platformPair, source: 'none' };
}

async function isConfigured(opts = {}) {
  const c = await getCredentials(opts);
  return !!(c.accountSid && c.authToken);
}

function basicAuthHeader({ accountSid, authToken }) {
  return 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
}

async function twilioFetch(creds, pathOrUrl, { method = 'GET', form } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${TWILIO_API_BASE}${pathOrUrl}`;
  const headers = { Authorization: basicAuthHeader(creds) };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30000) });
  return res;
}

async function twilioJson(creds, pathOrUrl, opts) {
  const res = await twilioFetch(creds, pathOrUrl, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.error_message)) || `Twilio request failed (HTTP ${res.status})`;
    const err = new Error(msg);
    err.code = 'TWILIO_ERROR';
    err.status = 502;
    err.twilioStatus = res.status;
    throw err;
  }
  return data;
}

/** Available US local numbers (voice-capable) for an area code. */
async function searchNumbers({ areaCode, limit = 20, workspaceId } = {}) {
  const creds = await getCredentials({ workspaceId });
  if (!creds.accountSid || !creds.authToken) return { configured: false, numbers: [] };
  const ac = String(areaCode || '')
    .replace(/\D/g, '')
    .slice(0, 3);
  const params = new URLSearchParams({
    VoiceEnabled: 'true',
    PageSize: String(Math.min(30, Math.max(1, Number(limit) || 20))),
  });
  if (ac.length === 3) params.set('AreaCode', ac);
  const data = await twilioJson(
    creds,
    `/Accounts/${encodeURIComponent(creds.accountSid)}/AvailablePhoneNumbers/US/Local.json?${params.toString()}`
  );
  const numbers = (Array.isArray(data && data.available_phone_numbers) ? data.available_phone_numbers : []).map(
    (n) => ({
      phoneNumber: String(n.phone_number || ''),
      friendlyName: String(n.friendly_name || ''),
      locality: String(n.locality || ''),
      region: String(n.region || ''),
    })
  );
  return { configured: true, numbers };
}

/**
 * Buy a number and point its voice webhook at the Call Tracking voice
 * URL for one lead. Throws (TWILIO_ERROR) on Twilio failure — callers
 * must persist NOTHING until this resolves.
 */
async function purchaseNumber({ phoneNumber, voiceUrl, workspaceId } = {}) {
  const creds = await getCredentials({ workspaceId });
  if (!creds.accountSid || !creds.authToken) return { configured: false };
  const data = await twilioJson(creds, `/Accounts/${encodeURIComponent(creds.accountSid)}/IncomingPhoneNumbers.json`, {
    method: 'POST',
    form: {
      PhoneNumber: String(phoneNumber || ''),
      VoiceUrl: String(voiceUrl || ''),
      VoiceMethod: 'POST',
    },
  });
  return {
    configured: true,
    phoneNumber: String((data && data.phone_number) || phoneNumber || ''),
    sid: String((data && data.sid) || ''),
  };
}

/**
 * Numbers the connected account already owns (Batch 26d pool source).
 * Returns { configured:false } when no credentials resolve, like the
 * other read helpers.
 */
async function listOwnedNumbers({ workspaceId, limit = 100 } = {}) {
  const creds = await getCredentials({ workspaceId });
  if (!creds.accountSid || !creds.authToken) return { configured: false, numbers: [] };
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 100));
  const data = await twilioJson(
    creds,
    `/Accounts/${encodeURIComponent(creds.accountSid)}/IncomingPhoneNumbers.json?PageSize=${pageSize}`
  );
  const numbers = (Array.isArray(data && data.incoming_phone_numbers) ? data.incoming_phone_numbers : []).map(
    (n) => ({
      phoneNumber: String(n.phone_number || ''),
      sid: String(n.sid || ''),
      friendlyName: String(n.friendly_name || ''),
      voiceUrl: String(n.voice_url || ''),
    })
  );
  return { configured: true, numbers };
}

/**
 * Point an owned number's voice webhook at a URL (Batch 26d: when a
 * pool number is assigned to a forwarding setup, its VoiceUrl goes to
 * that lead's voice route). Throws (TWILIO_ERROR) on Twilio failure —
 * callers decide whether that is fatal (the pool save flow reports it
 * per-number instead of rolling back the assignment).
 */
async function setNumberVoiceUrl({ sid, voiceUrl, workspaceId } = {}) {
  const creds = await getCredentials({ workspaceId });
  if (!creds.accountSid || !creds.authToken) return { configured: false };
  const numberSid = String(sid || '').trim();
  if (!numberSid) {
    const err = new Error('A Twilio number SID is required to set its voice webhook.');
    err.code = 'VALIDATION';
    err.status = 400;
    throw err;
  }
  const data = await twilioJson(
    creds,
    `/Accounts/${encodeURIComponent(creds.accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`,
    {
      method: 'POST',
      form: { VoiceUrl: String(voiceUrl || ''), VoiceMethod: 'POST' },
    }
  );
  return {
    configured: true,
    phoneNumber: String((data && data.phone_number) || ''),
    sid: String((data && data.sid) || numberSid),
    voiceUrl: String((data && data.voice_url) || voiceUrl || ''),
  };
}

/**
 * Send an SMS from an arbitrary account number (Batch 76 — Missed-Call
 * Rescue texts come FROM the site's tracking number, not the workspace
 * SMS from-number, so src/sms.js's provider cannot be used). Returns
 * { configured:false } when no credentials resolve; throws TWILIO_ERROR
 * on a Twilio failure so callers can record the failed attempt.
 */
async function sendSms({ from, to, body, workspaceId } = {}) {
  const creds = await getCredentials({ workspaceId });
  if (!creds.accountSid || !creds.authToken) return { configured: false };
  const data = await twilioJson(creds, `/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`, {
    method: 'POST',
    form: { From: String(from || ''), To: String(to || ''), Body: String(body || '') },
  });
  return { configured: true, sid: String((data && data.sid) || ''), status: String((data && data.status) || '') };
}

/**
 * Originate an outbound voice call (Batch 76 — the rescue voice
 * callback). `url` is the TwiML URL Twilio fetches when the callee
 * answers. Returns { configured:false } when dormant; throws
 * TWILIO_ERROR on failure.
 */
async function createCall({ from, to, url, statusCallback, workspaceId } = {}) {
  const creds = await getCredentials({ workspaceId });
  if (!creds.accountSid || !creds.authToken) return { configured: false };
  const form = {
    From: String(from || ''),
    To: String(to || ''),
    Url: String(url || ''),
    Method: 'POST',
  };
  if (statusCallback) {
    form.StatusCallback = String(statusCallback);
    form.StatusCallbackMethod = 'POST';
  }
  const data = await twilioJson(creds, `/Accounts/${encodeURIComponent(creds.accountSid)}/Calls.json`, {
    method: 'POST',
    form,
  });
  return { configured: true, sid: String((data && data.sid) || ''), status: String((data && data.status) || '') };
}

/**
 * Point an owned number's SMS webhook at a URL (Batch 76: when rescue
 * is enabled for a lead, the tracking number's SmsUrl goes to the
 * rescue inbound-SMS route so caller replies reach the conversation).
 * Throws (TWILIO_ERROR) on Twilio failure — callers treat it as
 * best-effort and report, never roll back the opt-in.
 */
async function setNumberSmsUrl({ sid, smsUrl, workspaceId } = {}) {
  const creds = await getCredentials({ workspaceId });
  if (!creds.accountSid || !creds.authToken) return { configured: false };
  const numberSid = String(sid || '').trim();
  if (!numberSid) {
    const err = new Error('A Twilio number SID is required to set its SMS webhook.');
    err.code = 'VALIDATION';
    err.status = 400;
    throw err;
  }
  const data = await twilioJson(
    creds,
    `/Accounts/${encodeURIComponent(creds.accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`,
    {
      method: 'POST',
      form: { SmsUrl: String(smsUrl || ''), SmsMethod: 'POST' },
    }
  );
  return {
    configured: true,
    phoneNumber: String((data && data.phone_number) || ''),
    sid: String((data && data.sid) || numberSid),
    smsUrl: String((data && data.sms_url) || smsUrl || ''),
  };
}

/**
 * Fetch a recording's media bytes with the platform credentials
 * (Twilio recording URLs require account auth). Asks for MP3.
 */
async function fetchRecordingMedia(recordingUrl, opts = {}) {
  const creds = await getCredentials(opts);
  if (!creds.accountSid || !creds.authToken) return { configured: false };
  let url = String(recordingUrl || '');
  if (!url) return { configured: true, ok: false, reason: 'no_url' };
  if (!/\.(mp3|wav)$/i.test(url)) url += '.mp3';
  // SSRF guard (review fix): the fetch carries the account's Basic-auth
  // header, and the URL comes from a stored webhook field — only ever
  // fetch Twilio's own API host over https, or a hostile RecordingUrl
  // leaks the credentials to that host and pulls arbitrary content
  // into playback / transcription.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { configured: true, ok: false, reason: 'untrusted_url' };
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.twilio.com') {
    return { configured: true, ok: false, reason: 'untrusted_url' };
  }
  const res = await twilioFetch(creds, url);
  if (!res.ok) return { configured: true, ok: false, reason: `http_${res.status}` };
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    configured: true,
    ok: true,
    buffer,
    contentType: res.headers.get('content-type') || 'audio/mpeg',
  };
}

/**
 * Standard Twilio request-signature validation: HMAC-SHA1 over the
 * full request URL followed by each POST parameter (sorted by key,
 * key+value concatenated), base64-encoded, keyed with the auth token.
 */
function validateSignature(authToken, url, params, signature) {
  const token = String(authToken || '');
  if (!token || !signature) return false;
  let data = String(url || '');
  const keys = Object.keys(params || {}).sort();
  for (const k of keys) data += k + String(params[k] == null ? '' : params[k]);
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Transcribe a Twilio recording with the platform AI key (Whisper-style
 * endpoint). Returns { ok:true, text } | { ok:false, reason } — never
 * throws: 'no_stt_key' when ai.api_key is unset, 'download_failed' /
 * 'stt_failed' on errors.
 */
async function transcribeRecording(recordingUrl, opts = {}) {
  try {
    const apiKey = String((await platform.getPlatformSetting('ai.api_key', '')) || '').trim();
    if (!apiKey) return { ok: false, reason: 'no_stt_key' };
    const baseUrl =
      String((await platform.getPlatformSetting('ai.base_url', '')) || '').trim() || 'https://api.openai.com/v1';
    const media = await fetchRecordingMedia(recordingUrl, opts);
    if (!media.configured) return { ok: false, reason: 'no_twilio' };
    if (!media.ok) return { ok: false, reason: 'download_failed' };
    /* Batch 168 (S5#6): the platform key rides this request as a
     * Bearer — the base URL (an Admin-set platform setting) gets the
     * same guard every other key transport runs: https + public
     * resolution via assertAiBaseUrl, and no redirects (a redirect
     * would carry the key to an unvalidated target). */
    try {
      await require('./urlSafety').assertAiBaseUrl(baseUrl);
    } catch {
      return { ok: false, reason: 'stt_failed' };
    }
    const form = new FormData();
    form.append('file', new Blob([media.buffer], { type: media.contentType || 'audio/mpeg' }), 'recording.mp3');
    form.append('model', 'whisper-1');
    form.append('response_format', 'json');
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(300000),
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) return { ok: false, reason: 'stt_failed' };
    const data = await res.json().catch(() => null);
    const text = data && typeof data.text === 'string' ? data.text.trim() : '';
    if (!text) return { ok: false, reason: 'stt_empty' };
    return { ok: true, text };
  } catch {
    return { ok: false, reason: 'stt_failed' };
  }
}

module.exports = {
  getCredentials,
  isConfigured,
  searchNumbers,
  purchaseNumber,
  listOwnedNumbers,
  setNumberVoiceUrl,
  sendSms,
  createCall,
  setNumberSmsUrl,
  fetchRecordingMedia,
  validateSignature,
  transcribeRecording,
};
