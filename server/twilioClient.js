'use strict';

/**
 * Twilio Voice client for the Call Tracking module (Batch 21).
 *
 * ONE place talks to Twilio: number search/purchase (staff "Buy a
 * number"), recording media fetches (authenticated playback proxy +
 * transcription), and webhook signature validation. Platform
 * credentials live in platform settings (twilio.account_sid /
 * twilio.auth_token) — when they are empty every entry point reports
 * "not configured" and the feature stays dormant; nothing here throws
 * just because Twilio is not connected.
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

async function getCredentials() {
  const [sid, token] = await Promise.all([
    platform.getPlatformSetting('twilio.account_sid', ''),
    platform.getPlatformSetting('twilio.auth_token', ''),
  ]);
  return {
    accountSid: String(sid || '').trim(),
    authToken: String(token || '').trim(),
  };
}

async function isConfigured() {
  const c = await getCredentials();
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
  const res = await fetch(url, { method, headers, body });
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
async function searchNumbers({ areaCode, limit = 20 } = {}) {
  const creds = await getCredentials();
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
async function purchaseNumber({ phoneNumber, voiceUrl } = {}) {
  const creds = await getCredentials();
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
 * Fetch a recording's media bytes with the platform credentials
 * (Twilio recording URLs require account auth). Asks for MP3.
 */
async function fetchRecordingMedia(recordingUrl) {
  const creds = await getCredentials();
  if (!creds.accountSid || !creds.authToken) return { configured: false };
  let url = String(recordingUrl || '');
  if (!url) return { configured: true, ok: false, reason: 'no_url' };
  if (!/\.(mp3|wav)$/i.test(url)) url += '.mp3';
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
async function transcribeRecording(recordingUrl) {
  try {
    const apiKey = String((await platform.getPlatformSetting('ai.api_key', '')) || '').trim();
    if (!apiKey) return { ok: false, reason: 'no_stt_key' };
    const baseUrl =
      String((await platform.getPlatformSetting('ai.base_url', '')) || '').trim() || 'https://api.openai.com/v1';
    const media = await fetchRecordingMedia(recordingUrl);
    if (!media.configured) return { ok: false, reason: 'no_twilio' };
    if (!media.ok) return { ok: false, reason: 'download_failed' };
    const form = new FormData();
    form.append('file', new Blob([media.buffer], { type: media.contentType || 'audio/mpeg' }), 'recording.mp3');
    form.append('model', 'whisper-1');
    form.append('response_format', 'json');
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
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
  fetchRecordingMedia,
  validateSignature,
  transcribeRecording,
};
