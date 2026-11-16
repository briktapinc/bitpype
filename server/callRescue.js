'use strict';

/**
 * Missed-Call Rescue (Batch 76) — Ely's approved spec
 * (~/workspace/website-scout/missed-call-rescue-spec-2026-10-30.md).
 *
 * When an inbound call to a call-tracking site's Twilio number is
 * MISSED, the platform answers it automatically:
 *   1. SMS text-back from the tracking number within ~1 minute,
 *   2. an automated voice callback if the caller never replies,
 * and books the job FIRMLY into the site's own bookings module (real
 * published services + real availability only — the module's own
 * create path, createPublicBooking; if nothing fits, a callback
 * request is taken instead of inventing a slot). A second track runs
 * a 24h / 3d / 7d SMS nudge sequence on OPEN estimate requests.
 *
 * Ely's locked decisions:
 *   - Channel: BOTH (text first, voice on no-reply).
 *   - Booking authority: FIRM (a real appointment row, outright).
 *   - Eligibility: call-tracking-configured sites ONLY, per-site
 *     owner opt-in (portal toggle; engine settings admin-side).
 *
 * Guardrails (build requirements from the spec):
 *   - Exactly-once rescue per call (UNIQUE(call_log_id)) and per
 *     estimate (UNIQUE(estimate_request_id)); exactly-once per
 *     estimate nudge step.
 *   - Quiet hours (default 21:00–08:00 in the site's booking
 *     timezone): texts AND calls defer to the next morning.
 *   - STOP/opt-out (leadscout_contacts.sms_opted_out_at) and the
 *     Outreach suppression list are honored on both channels.
 *   - The owner's forward-to number, the tracking numbers themselves
 *     and test numbers never trigger a rescue.
 *   - Every send, reply and outcome is written to
 *     call_rescue_messages + a LeadScout timeline event — nothing
 *     acts invisibly.
 *
 * Transport seam: all Twilio sends go through `transport()`, which
 * defaults to server/twilioClient.js (sendSms / createCall). Tests
 * and the live proof substitute a capturing stub via
 * setTransportForTests — with the stub installed, ZERO real SMS or
 * calls can leave the process through this module. Owner email
 * notification goes through `notifier()` (default:
 * ownerNotify.notifyOwnerOfBooking + a callback-request email built
 * on callNotify's recipient chain), substitutable the same way.
 */

const modules = require('./siteModules');
const portalContacts = require('./portalContacts');
const twilioClient = require('./twilioClient');

const QUALIFIED_MIN_SECONDS = 15; // the Batch 21 counted-call threshold
const DEFAULT_REPLY_WINDOW_MINUTES = 10;
const DEFAULT_QUIET_START = '21:00';
const DEFAULT_QUIET_END = '08:00';
const TEXT_BACK_DELAY_SECONDS = 0; // the 60s sweep cadence IS the ~1-minute SLA
const CONVERSATION_TTL_MS = 72 * 60 * 60 * 1000;
const ESTIMATE_STEP_OFFSETS_MS = [24 * 3600e3, 72 * 3600e3, 168 * 3600e3]; // 24h / 3d / 7d
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);

function fail(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

/* ------------------------------ time ------------------------------ */

/** SQLite UTC string for a Date ('YYYY-MM-DD HH:MM:SS'). */
function utcStr(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

function parseUtc(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const t = Date.parse(s.replace(' ', 'T') + (s.includes('T') ? '' : '') + (s.endsWith('Z') ? '' : 'Z'));
  return Number.isFinite(t) ? new Date(t) : null;
}

function parseHm(text) {
  const m = String(text || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes since local midnight in `timeZone` at instant `date`. */
function localMinutes(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);
    let h = 0;
    let m = 0;
    for (const p of parts) {
      if (p.type === 'hour') h = Number(p.value) % 24;
      if (p.type === 'minute') m = Number(p.value);
    }
    return h * 60 + m;
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

/**
 * Quiet-hours state for a config at instant `now` in the site's
 * timezone. Returns { quiet, until } — `until` is the Date the quiet
 * window ends (the next quiet_end) when quiet, else null. A window
 * with start <= end is same-day; start > end wraps midnight.
 */
function quietState(config, timeZone, now) {
  const start = parseHm(config && config.quiet_start) != null ? parseHm(config.quiet_start) : parseHm(DEFAULT_QUIET_START);
  const end = parseHm(config && config.quiet_end) != null ? parseHm(config.quiet_end) : parseHm(DEFAULT_QUIET_END);
  if (start == null || end == null || start === end) return { quiet: false, until: null };
  const cur = localMinutes(now, timeZone);
  let quiet = false;
  if (start > end) quiet = cur >= start || cur < end;
  else quiet = cur >= start && cur < end;
  if (!quiet) return { quiet: false, until: null };
  // Minutes until the window ends, in local terms.
  let delta = end - cur;
  if (delta <= 0) delta += 24 * 60;
  return { quiet: true, until: new Date(now.getTime() + delta * 60000) };
}

/* ----------------------------- tables ----------------------------- */

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS call_rescue_configs (
      lead_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      reply_window_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_REPLY_WINDOW_MINUTES},
      quiet_start TEXT NOT NULL DEFAULT '${DEFAULT_QUIET_START}',
      quiet_end TEXT NOT NULL DEFAULT '${DEFAULT_QUIET_END}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS call_rescues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'call',
      call_log_id INTEGER,
      estimate_request_id INTEGER,
      contact_id INTEGER,
      from_number TEXT NOT NULL DEFAULT '',
      to_number TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL DEFAULT 'pending_text',
      state_json TEXT NOT NULL DEFAULT '{}',
      text_sent_at TEXT,
      voice_due_at TEXT,
      next_action_at TEXT,
      voice_call_sid TEXT NOT NULL DEFAULT '',
      booking_id INTEGER,
      nudge_step INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_call_rescues_call
      ON call_rescues(call_log_id) WHERE call_log_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_call_rescues_estimate
      ON call_rescues(estimate_request_id) WHERE estimate_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_call_rescues_lead_stage
      ON call_rescues(lead_id, stage, id DESC);

    CREATE TABLE IF NOT EXISTS call_rescue_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rescue_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      direction TEXT NOT NULL DEFAULT 'out',
      channel TEXT NOT NULL DEFAULT 'sms',
      body TEXT NOT NULL DEFAULT '',
      provider_sid TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_call_rescue_messages_rescue
      ON call_rescue_messages(rescue_id, id ASC);
  `);
}

/* ----------------------------- config ----------------------------- */

function shapeRescueConfig(row, leadId) {
  if (!row) {
    return {
      lead_id: Number(leadId),
      enabled: false,
      reply_window_minutes: DEFAULT_REPLY_WINDOW_MINUTES,
      quiet_start: DEFAULT_QUIET_START,
      quiet_end: DEFAULT_QUIET_END,
      updated_at: null,
    };
  }
  return {
    lead_id: Number(row.lead_id),
    enabled: !!row.enabled,
    reply_window_minutes:
      Number(row.reply_window_minutes) > 0 ? Number(row.reply_window_minutes) : DEFAULT_REPLY_WINDOW_MINUTES,
    quiet_start: String(row.quiet_start || DEFAULT_QUIET_START),
    quiet_end: String(row.quiet_end || DEFAULT_QUIET_END),
    updated_at: row.updated_at || null,
  };
}

function getRescueConfig(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM call_rescue_configs WHERE lead_id = ?').get(Number(leadId));
  return shapeRescueConfig(row, leadId);
}

/**
 * Whitelisted config write (owner toggle writes `enabled` only from
 * the portal; window + quiet hours are admin-side). Unknown keys are
 * ignored by construction.
 */
function setRescueConfig(db, leadId, data = {}) {
  ensureTables(db);
  const id = Number(leadId);
  const cur = getRescueConfig(db, id);
  const next = { ...cur };
  if (data.enabled != null) next.enabled = !!data.enabled;
  if (data.reply_window_minutes != null || data.replyWindowMinutes != null) {
    const v = Number(data.reply_window_minutes != null ? data.reply_window_minutes : data.replyWindowMinutes);
    if (!Number.isFinite(v) || v < 1 || v > 240) {
      throw fail('VALIDATION', 'reply_window_minutes must be between 1 and 240');
    }
    next.reply_window_minutes = Math.round(v);
  }
  for (const key of ['quiet_start', 'quiet_end']) {
    const camel = key === 'quiet_start' ? 'quietStart' : 'quietEnd';
    const raw = data[key] != null ? data[key] : data[camel];
    if (raw != null) {
      if (parseHm(raw) == null) throw fail('VALIDATION', `${key} must be HH:MM`);
      next[key] = String(raw).trim();
    }
  }
  db.prepare(
    `INSERT INTO call_rescue_configs (lead_id, enabled, reply_window_minutes, quiet_start, quiet_end, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET
       enabled = excluded.enabled,
       reply_window_minutes = excluded.reply_window_minutes,
       quiet_start = excluded.quiet_start,
       quiet_end = excluded.quiet_end,
       updated_at = datetime('now')`
  ).run(id, next.enabled ? 1 : 0, next.reply_window_minutes, next.quiet_start, next.quiet_end);
  return getRescueConfig(db, id);
}

/* -------------------------- miss detection ------------------------- */

/**
 * Was this call_logs row a MISS for rescue purposes?
 *   - a voicemail was left (the caller never reached a person), or
 *   - the business leg ended busy / no-answer / failed, or
 *   - it "completed" with less than the 15s qualified-talk threshold
 *     (picked up and dropped, or straight to voicemail).
 * 'canceled' is NOT a miss: the caller hung up on their own before
 * the business could answer (same line the voicemail flow draws).
 */
function isMissedCall(row) {
  if (!row) return false;
  if (Number(row.is_voicemail || 0) === 1) return true;
  const status = String(row.status || '').trim().toLowerCase();
  if (status === 'busy' || status === 'no-answer' || status === 'failed') return true;
  if (status === 'completed') {
    const dur = row.duration_seconds == null ? 0 : Number(row.duration_seconds);
    return !(dur >= QUALIFIED_MIN_SECONDS);
  }
  return false;
}

/** A site is rescue-eligible when call tracking is configured (a
 *  tracking number is assigned) AND the owner opted in. */
function rescueEligible(db, leadId) {
  const ct = modules.getCallTrackingConfig(db, Number(leadId));
  if (!String(ct.display_number || '').trim()) return { ok: false, reason: 'no_tracking_number', config: null, ct };
  const config = getRescueConfig(db, leadId);
  if (!config.enabled) return { ok: false, reason: 'not_enabled', config, ct };
  return { ok: true, config, ct };
}

function normDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/** Phone-level suppression: LeadScout opt-out on the contact, or the
 *  number sitting on the Outreach suppression list. Batch 192 (#15):
 *  the implementation moved to server/phoneSuppression.js so the
 *  outreach SMS paths consult the SAME check; this re-export keeps
 *  the rescue paths (and their tests) on the identical function. */
const { phoneBlocked } = require('./phoneSuppression');

/** Numbers that must never be rescued: the business's own lines. */
function isOwnNumber(db, leadId, phone, ct) {
  const digits = normDigits(phone);
  if (!digits) return true;
  const config = ct || modules.getCallTrackingConfig(db, Number(leadId));
  const own = new Set(
    [config.display_number, config.redirect_number, ...(config.rotation_numbers || [])]
      .map(normDigits)
      .filter(Boolean)
  );
  return own.has(digits);
}

/* ------------------------- transport seam -------------------------- */

let transportOverride = null;
let notifierOverride = null;

function setTransportForTests(t) {
  transportOverride = t || null;
}
function setNotifierForTests(n) {
  notifierOverride = n || null;
}

function transport() {
  if (transportOverride) return transportOverride;
  return {
    sendSms: (args) => twilioClient.sendSms(args),
    createCall: (args) => twilioClient.createCall(args),
  };
}

function notifier() {
  if (notifierOverride) return notifierOverride;
  return {
    // EXACTLY the Batch 21b booking path (owner email + rental routing).
    notifyBooking: (workspaceId, bookingId) =>
      require('./ownerNotify').notifyOwnerOfBooking(workspaceId, bookingId),
    notifyCallback: (workspaceId, info) => sendCallbackEmail(workspaceId, info),
  };
}

/** Callback-request owner email — same recipient chain + mail helper
 *  as server/ownerNotify.js (Batch 21b pattern). Never throws. */
async function sendCallbackEmail(workspaceId, { leadId, callerPhone, note, businessName } = {}) {
  try {
    const domain = require('./domain');
    const mailer = require('./mailer');
    const { resolveNotifyRecipient } = require('./callNotify');
    const recipient = domain.withDb(workspaceId, (db) => resolveNotifyRecipient(db, Number(leadId)));
    if (!recipient) return { sent: false, reason: 'no_recipient' };
    const res = await mailer.sendPlatformMail({
      to: recipient,
      subject: 'Callback request from a missed call',
      text: [
        `A caller whose call was missed asked ${businessName || 'your business'} to call them back.`,
        `Caller: ${callerPhone || ''}`,
        note ? `They said: ${note}` : '',
        'This request was taken automatically by Missed-Call Rescue. The full conversation is in your portal under Call Tracking.',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    return { sent: !!(res && (res.ok || res.sent || res.messageId)), reason: res && res.reason };
  } catch (e) {
    console.warn('[callRescue] callback email failed:', e && e.message);
    return { sent: false, reason: 'error' };
  }
}

/* --------------------------- row helpers --------------------------- */

function getRescue(db, id) {
  ensureTables(db);
  return db.prepare('SELECT * FROM call_rescues WHERE id = ?').get(Number(id)) || null;
}

function saveRescue(db, rescue) {
  db.prepare(
    `UPDATE call_rescues SET
       stage = ?, state_json = ?, contact_id = COALESCE(?, contact_id),
       text_sent_at = COALESCE(?, text_sent_at), voice_due_at = ?, next_action_at = ?,
       voice_call_sid = ?, booking_id = COALESCE(?, booking_id),
       nudge_step = ?, outcome = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    rescue.stage,
    JSON.stringify(rescue.state || {}),
    rescue.contact_id != null ? Number(rescue.contact_id) : null,
    rescue.text_sent_at || null,
    rescue.voice_due_at || null,
    rescue.next_action_at || null,
    rescue.voice_call_sid || '',
    rescue.booking_id != null ? Number(rescue.booking_id) : null,
    Number(rescue.nudge_step || 0),
    rescue.outcome || '',
    Number(rescue.id)
  );
  return getRescue(db, rescue.id);
}

function rowToRescue(row) {
  if (!row) return null;
  let state = {};
  try {
    state = JSON.parse(String(row.state_json || '{}')) || {};
  } catch {
    state = {};
  }
  return { ...row, state };
}

function logMessage(db, rescue, { direction, channel, body, providerSid }) {
  db.prepare(
    `INSERT INTO call_rescue_messages (rescue_id, lead_id, direction, channel, body, provider_sid)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    Number(rescue.id),
    Number(rescue.lead_id),
    String(direction || 'out'),
    String(channel || 'sms'),
    String(body || '').slice(0, 2000),
    String(providerSid || '').slice(0, 80)
  );
}

/** LeadScout timeline entry — owner-visible record of the rescue. */
function logTimeline(db, rescue, status, extra = {}) {
  try {
    if (rescue.contact_id == null) return; // no contact → the messages table still records it
    portalContacts.ensureTables(db);
    db.prepare(
      `INSERT INTO leadscout_events
         (contact_id, lead_id, kind, source_label, page_slug, status, payload_json)
       VALUES (?, ?, 'call_rescue', 'Missed-Call Rescue', '', ?, ?)`
    ).run(
      rescue.contact_id != null ? Number(rescue.contact_id) : 0,
      Number(rescue.lead_id),
      String(status || ''),
      JSON.stringify({
        rescue_id: Number(rescue.id),
        kind: rescue.kind,
        call_log_id: rescue.call_log_id != null ? Number(rescue.call_log_id) : null,
        estimate_request_id: rescue.estimate_request_id != null ? Number(rescue.estimate_request_id) : null,
        phone: rescue.from_number || '',
        stage: rescue.stage,
        outcome: rescue.outcome || '',
        ...extra,
      }).slice(0, 8000)
    );
  } catch (e) {
    console.warn('[callRescue] timeline log failed:', e && e.message);
  }
}

function businessName(db, leadId) {
  try {
    const lead = db.prepare('SELECT business_name FROM leads WHERE id = ?').get(Number(leadId));
    return lead && lead.business_name ? String(lead.business_name) : 'us';
  } catch {
    return 'us';
  }
}

function siteTimezone(db, leadId) {
  try {
    const s = modules.getBookingSettings(db, Number(leadId));
    return s && s.timezone ? String(s.timezone) : 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}

/* --------------------------- slot offers --------------------------- */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function slotLabel(startsAt) {
  const m = String(startsAt || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return String(startsAt || '');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  let h = Number(m[4]);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 === 0 ? 12 : h % 12;
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} at ${h}:${m[5]} ${ampm}`;
}

function ymdOf(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/**
 * The next `count` REAL openings for a service, scanning the coming
 * week through the bookings module's own availability computation.
 * `offset` skips earlier slots (the MORE reply). Returns
 * [{ starts_at, label }].
 */
function offerSlots(db, leadId, serviceId, { count = 3, offset = 0 } = {}) {
  const out = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let day = 0; day < 7 && out.length < offset + count; day++) {
    const d = new Date(today);
    d.setDate(d.getDate() + day);
    let res;
    try {
      res = modules.listAvailableSlots(db, Number(leadId), { date: ymdOf(d), serviceId: Number(serviceId) });
    } catch {
      continue;
    }
    for (const s of res.slots || []) {
      out.push({ starts_at: s.starts_at, label: slotLabel(s.starts_at) });
    }
  }
  return out.slice(offset, offset + count);
}

function publishedServices(db, leadId) {
  return modules
    .listBookingServices(db, Number(leadId), { includeDrafts: false })
    .filter((s) => s.status === 'published');
}

/* ------------------------ conversation core ------------------------ */

function servicePrompt(biz, services) {
  const lines = services.slice(0, 6).map((s, i) => `${i + 1}) ${s.name}`);
  return (
    `Which service do you need? Reply with a number:\n${lines.join('\n')}` +
    (services.length > 6 ? '\n…or reply with the name of the service.' : '')
  );
}

function slotPrompt(serviceName, slots) {
  const lines = slots.map((s, i) => `${i + 1}) ${s.label}`);
  return (
    `For ${serviceName}, here are the next openings:\n${lines.join('\n')}\n` +
    'Reply with a number to book that time, or reply MORE for later options.'
  );
}

function greetingText(biz) {
  return `Hi, this is ${biz} — sorry we missed your call! I can book you in right now.`;
}

/**
 * Move a rescue into the slot-offering stage for a chosen service and
 * produce the outgoing prompt. Shared by the first text-back and by
 * mid-conversation service picks. Returns the messages to deliver.
 */
function enterSlotStage(db, rescue, service) {
  rescue.state.service_id = Number(service.id);
  rescue.state.service_name = String(service.name);
  rescue.state.slot_offset = 0;
  const slots = offerSlots(db, rescue.lead_id, service.id, { count: 3, offset: 0 });
  if (!slots.length) {
    rescue.stage = 'awaiting_callback';
    return [
      `We're fully booked online for ${service.name} this week — but we can call you back. ` +
        'Reply with your name and the best time to reach you, and we will call you back.',
    ];
  }
  rescue.state.offered = slots;
  rescue.stage = 'awaiting_slot';
  return [slotPrompt(service.name, slots)];
}

function enterServiceStage(db, rescue, { withGreeting = false } = {}) {
  const biz = businessName(db, rescue.lead_id);
  const services = publishedServices(db, rescue.lead_id);
  const head = withGreeting ? [greetingText(biz)] : [];
  if (!services.length) {
    rescue.stage = 'awaiting_callback';
    return [
      ...head,
      'Reply with your name and what you need, and we will call you back shortly.',
    ];
  }
  if (services.length === 1) {
    return [...head, ...enterSlotStage(db, rescue, services[0])];
  }
  rescue.state.service_options = services.slice(0, 6).map((s) => Number(s.id));
  rescue.stage = 'awaiting_service';
  return [...head, servicePrompt(biz, services)];
}

/**
 * Complete the firm booking through the bookings module's own create
 * path (which re-validates the slot against real availability and
 * captures the LeadScout booking event). Returns the booking row.
 * Throws the module's coded error when the slot is gone.
 */
function completeBooking(db, rescue) {
  const appt = modules.createPublicBooking(db, Number(rescue.lead_id), {
    service_id: Number(rescue.state.service_id),
    customer_name: String(rescue.state.name || '').trim(),
    customer_phone: String(rescue.from_number || ''),
    starts_at: String(rescue.state.slot_starts_at || ''),
    notes:
      rescue.kind === 'estimate'
        ? 'Booked by Missed-Call Rescue (estimate follow-up).'
        : 'Booked by Missed-Call Rescue after a missed call.',
  });
  rescue.booking_id = Number(appt.id);
  rescue.stage = 'booked';
  rescue.outcome = 'booked';
  rescue.voice_due_at = null;
  rescue.next_action_at = null;
  return appt;
}

function finishCallback(db, rescue, note) {
  rescue.state.callback_note = String(note || '').slice(0, 500);
  rescue.stage = 'callback_requested';
  rescue.outcome = 'callback_requested';
  rescue.voice_due_at = null;
  rescue.next_action_at = null;
}

/**
 * One step of the booking conversation. `input` is the caller's text
 * (an SMS body, or a voice Gather result already mapped to text).
 * Mutates + persists the rescue; returns { messages, finished } —
 * delivery of the messages is the caller's job (SMS send, or spoken
 * TwiML on the voice channel).
 */
function stepConversation(db, rescue, input) {
  const text = String(input || '').trim();
  const messages = [];
  const lower = text.toLowerCase();

  if (rescue.stage === 'awaiting_service') {
    const services = publishedServices(db, rescue.lead_id);
    let chosen = null;
    const num = Number(text);
    const options = Array.isArray(rescue.state.service_options) ? rescue.state.service_options : [];
    if (Number.isInteger(num) && num >= 1 && num <= options.length) {
      chosen = services.find((s) => Number(s.id) === Number(options[num - 1])) || null;
    }
    if (!chosen && text) {
      chosen =
        services.find((s) => String(s.name).toLowerCase() === lower) ||
        services.find((s) => String(s.name).toLowerCase().includes(lower) || lower.includes(String(s.name).toLowerCase())) ||
        null;
    }
    if (!chosen) {
      messages.push(`Sorry, I didn't catch that. ${servicePrompt('', services)}`);
      return { messages, finished: false };
    }
    messages.push(...enterSlotStage(db, rescue, chosen));
    saveRescue(db, rescue);
    return { messages, finished: false };
  }

  if (rescue.stage === 'awaiting_slot') {
    if (/^more$/i.test(text)) {
      const offset = Number(rescue.state.slot_offset || 0) + 3;
      const slots = offerSlots(db, rescue.lead_id, rescue.state.service_id, { count: 3, offset });
      if (!slots.length) {
        messages.push('Those are all the openings this week. ' + slotPrompt(rescue.state.service_name, rescue.state.offered || []));
        saveRescue(db, rescue);
        return { messages, finished: false };
      }
      rescue.state.slot_offset = offset;
      rescue.state.offered = slots;
      messages.push(slotPrompt(rescue.state.service_name, slots));
      saveRescue(db, rescue);
      return { messages, finished: false };
    }
    const offered = Array.isArray(rescue.state.offered) ? rescue.state.offered : [];
    const num = Number(text);
    let picked = null;
    if (Number.isInteger(num) && num >= 1 && num <= offered.length) picked = offered[num - 1];
    if (!picked && text) {
      picked = offered.find((s) => s.label.toLowerCase().includes(lower)) || null;
    }
    if (!picked) {
      messages.push(`Sorry, I didn't catch that. ${slotPrompt(rescue.state.service_name, offered)}`);
      saveRescue(db, rescue);
      return { messages, finished: false };
    }
    rescue.state.slot_starts_at = picked.starts_at;
    rescue.state.slot_label = picked.label;
    if (rescue.state.name) {
      return finishBookingStep(db, rescue, messages);
    }
    rescue.stage = 'awaiting_name';
    messages.push(`Great — ${picked.label} it is. What's your name for the booking?`);
    saveRescue(db, rescue);
    return { messages, finished: false };
  }

  if (rescue.stage === 'awaiting_name') {
    const name = text.replace(/\s+/g, ' ').slice(0, 80);
    if (name.length < 2) {
      messages.push("What's your name for the booking?");
      saveRescue(db, rescue);
      return { messages, finished: false };
    }
    rescue.state.name = name;
    return finishBookingStep(db, rescue, messages);
  }

  if (rescue.stage === 'awaiting_callback') {
    if (text) rescue.state.callback_note = text.slice(0, 500);
    finishCallback(db, rescue);
    saveRescue(db, rescue);
    logTimeline(db, rescue, 'callback_requested');
    messages.push(
      `Thanks — we've passed your request to ${businessName(db, rescue.lead_id)} and they'll call you back shortly.`
    );
    return { messages, finished: true, callback: true };
  }

  return { messages, finished: true };
}

/** Book now (state carries service + slot + name). On a lost slot,
 *  re-offer fresh openings instead of failing the caller. */
function finishBookingStep(db, rescue, messages) {
  try {
    const appt = completeBooking(db, rescue);
    saveRescue(db, rescue);
    logTimeline(db, rescue, 'booked', { booking_id: Number(appt.id), starts_at: appt.starts_at });
    messages.push(
      `You're booked, ${rescue.state.name}! ${rescue.state.service_name} on ${rescue.state.slot_label} ` +
        `with ${businessName(db, rescue.lead_id)}. We've saved your spot — see you then.`
    );
    return { messages, finished: true, booked: true, booking: appt };
  } catch (e) {
    if (e && (e.status === 409 || /no longer available/i.test(e.message || ''))) {
      const service = modules.getBookingService(db, Number(rescue.lead_id), Number(rescue.state.service_id));
      rescue.state.slot_starts_at = null;
      if (service) {
        const msgs = enterSlotStage(db, rescue, service);
        messages.push('Sorry — that time was just taken. Here are the next openings:', ...msgs);
      } else {
        rescue.stage = 'awaiting_callback';
        messages.push('Sorry — that time was just taken. Reply with your name and the best time to reach you, and we will call you back.');
      }
      saveRescue(db, rescue);
      return { messages, finished: false };
    }
    throw e;
  }
}

/* ------------------------------ sending ---------------------------- */

async function sendSms(db, workspaceId, rescue, body, channel = 'sms') {
  const res = await transport().sendSms({
    from: String(rescue.to_number || ''),
    to: String(rescue.from_number || ''),
    body: String(body || ''),
    workspaceId: Number(workspaceId),
  });
  if (!res || !res.configured) {
    const err = new Error('Twilio is not configured for this workspace');
    err.code = 'TWILIO_NOT_CONFIGURED';
    throw err;
  }
  logMessage(db, rescue, { direction: 'out', channel, body, providerSid: res.sid });
  return res;
}

/* ------------------------------ trigger ---------------------------- */

/**
 * Called (background) from the call-status webhook when a call
 * reaches a terminal state. Creates the rescue row exactly once when
 * every gate passes. Returns { created, reason? , rescue? }.
 */
async function maybeCreateRescue(workspaceId, leadId, callSid) {
  const domain = require('./domain');
  return domain.withDb(workspaceId, (db) => {
    ensureTables(db);
    const call = modules.getCallLogBySid(db, String(callSid || ''));
    if (!call) return { created: false, reason: 'no_call' };
    if (!modules.isTerminalCallStatus(call.status)) return { created: false, reason: 'not_terminal' };
    if (!isMissedCall(call)) return { created: false, reason: 'not_missed' };
    const elig = rescueEligible(db, leadId);
    if (!elig.ok) return { created: false, reason: elig.reason };
    const from = String(call.from_number || '');
    if (!from) return { created: false, reason: 'no_caller' };
    if (isOwnNumber(db, leadId, from, elig.ct)) return { created: false, reason: 'own_number' };
    if (phoneBlocked(db, from)) return { created: false, reason: 'suppressed' };
    const contact = portalContacts.upsertContact(db, { name: '', email: '', phone: from });
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO call_rescues
           (lead_id, kind, call_log_id, contact_id, from_number, to_number, stage, next_action_at)
         VALUES (?, 'call', ?, ?, ?, ?, 'pending_text', datetime('now'))`
      )
      .run(
        Number(leadId),
        Number(call.id),
        contact ? Number(contact.id) : null,
        from.slice(0, 40),
        String(call.to_number || elig.ct.display_number || '').slice(0, 40)
      );
    if (!info.changes) return { created: false, reason: 'already_exists' };
    const rescue = rowToRescue(getRescue(db, info.lastInsertRowid));
    logTimeline(db, rescue, 'missed_call');
    return { created: true, rescue };
  });
}

/** Send the initial text-back for a pending rescue (sweep step). */
async function sendTextBack(db, workspaceId, rescue, now) {
  const prompts = enterServiceStage(db, rescue, { withGreeting: true });
  // If enterServiceStage landed on a callback ask, the greeting still
  // goes out as the first text — the caller can simply reply.
  const body = prompts.join('\n');
  await sendSms(db, workspaceId, rescue, body);
  const config = getRescueConfig(db, rescue.lead_id);
  rescue.text_sent_at = utcStr(now);
  rescue.voice_due_at = utcStr(new Date(now.getTime() + config.reply_window_minutes * 60000));
  rescue.next_action_at = null;
  saveRescue(db, rescue);
  logTimeline(db, rescue, 'text_back_sent');
  return rescue;
}

/* --------------------------- inbound SMS --------------------------- */

function isStopText(text) {
  return STOP_WORDS.has(String(text || '').trim().toUpperCase());
}

function markOptedOut(db, phone) {
  portalContacts.ensureTables(db);
  const contact = portalContacts.upsertContact(db, { name: '', email: '', phone });
  db.prepare(
    `UPDATE leadscout_contacts SET sms_opted_out_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(Number(contact.id));
  return contact;
}

/** Stop every active rescue/follow-up for (lead, phone). */
function stopAllForPhone(db, leadId, phone, outcome) {
  const rows = db
    .prepare(
      `SELECT * FROM call_rescues
        WHERE lead_id = ? AND from_number = ?
          AND stage NOT IN ('booked','callback_requested','stopped','expired','failed','converted')`
    )
    .all(Number(leadId), String(phone || ''));
  for (const row of rows) {
    const rescue = rowToRescue(row);
    rescue.stage = 'stopped';
    rescue.outcome = outcome;
    rescue.voice_due_at = null;
    rescue.next_action_at = null;
    saveRescue(db, rescue);
    logTimeline(db, rescue, 'stopped', { reason: outcome });
  }
  return rows.length;
}

/** Resolve the lead a tracking number belongs to (primary or rotation). */
function leadForTrackingNumber(db, toNumber) {
  const digits = normDigits(toNumber);
  if (!digits) return null;
  modules.ensureTables(db);
  const configs = db.prepare('SELECT lead_id, display_number FROM calltracking_configs').all();
  for (const c of configs) {
    if (normDigits(c.display_number) === digits) return Number(c.lead_id);
  }
  try {
    const rot = db
      .prepare('SELECT lead_id, phone_number FROM calltracking_rotation_numbers')
      .all()
      .find((r) => normDigits(r.phone_number) === digits);
    if (rot) return Number(rot.lead_id);
  } catch {
    /* rotation table absent */
  }
  return null;
}

function activeRescueFor(db, leadId, phone) {
  const row = db
    .prepare(
      `SELECT * FROM call_rescues
        WHERE lead_id = ? AND from_number = ?
          AND stage NOT IN ('booked','callback_requested','stopped','expired','failed','converted')
        ORDER BY id DESC LIMIT 1`
    )
    .get(Number(leadId), String(phone || ''));
  return rowToRescue(row);
}

/**
 * One inbound SMS on a tracking number. Returns a summary for the
 * route/tests. Delivery of conversation replies happens here (SMS
 * channel); voice replies go through handleVoiceInput.
 */
async function handleInboundSms(workspaceId, { from, to, body, messageSid } = {}, opts = {}) {
  const domain = require('./domain');
  const now = opts.now instanceof Date ? opts.now : new Date();
  const prep = domain.withDb(workspaceId, (db) => {
    ensureTables(db);
    const leadId = leadForTrackingNumber(db, to);
    if (!leadId) return null;
    return { leadId };
  });
  if (!prep) return { handled: false, reason: 'unknown_number' };
  const { leadId } = prep;

  // STOP — honored before anything else, on every path.
  if (isStopText(body)) {
    domain.withDb(workspaceId, (db) => {
      const contact = markOptedOut(db, from);
      const rescue = activeRescueFor(db, leadId, from);
      if (rescue) {
        rescue.contact_id = Number(contact.id);
        logMessage(db, rescue, { direction: 'in', channel: 'sms', body, providerSid: messageSid });
      }
      stopAllForPhone(db, leadId, from, 'opt_out');
    });
    return { handled: true, action: 'opt_out', leadId };
  }
  const work = domain.withDb(workspaceId, (db) => {
    if (phoneBlocked(db, from)) return { handled: true, action: 'suppressed' };
    const rescue = activeRescueFor(db, leadId, from);
    if (!rescue) return { handled: false, reason: 'no_active_rescue' };
    logMessage(db, rescue, { direction: 'in', channel: 'sms', body, providerSid: messageSid });
    // Any reply kills the pending voice escalation: the caller is
    // talking to us by text now.
    rescue.voice_due_at = null;
    if (rescue.stage === 'estimate_nudge') {
      // The nudge sequence stops on ANY reply (spec) — and the reply
      // itself opens the booking conversation the nudge offered.
      rescue.outcome = 'replied';
      logTimeline(db, rescue, 'estimate_reply');
      const prompts = enterServiceStage(db, rescue, { withGreeting: false });
      saveRescue(db, rescue);
      return { handled: true, action: 'estimate_reply', rescue, messages: prompts };
    }
    if (rescue.stage === 'pending_text') {
      // Caller replied before the sweep texted (rare race): treat the
      // reply as the conversation start.
      const prompts = enterServiceStage(db, rescue, { withGreeting: false });
      rescue.text_sent_at = utcStr(now);
      saveRescue(db, rescue);
      return { handled: true, action: 'conversation', rescue, messages: prompts };
    }
    const result = stepConversation(db, rescue, body);
    return { handled: true, action: 'conversation', rescue, messages: result.messages, result };
  });
  if (!work.handled || !work.rescue) return { ...work, leadId };
  // Deliver replies outside the DB closure.
  const rescueRow = work.rescue;
  await domain.withDb(workspaceId, async (db) => {
    for (const m of work.messages || []) {
      await sendSms(db, workspaceId, rescueRow, m);
    }
  });
  if (work.result && work.result.booked) {
    Promise.resolve(notifier().notifyBooking(workspaceId, Number(work.result.booking.id))).catch(() => {});
    if (rescueRow.kind === 'estimate' && rescueRow.estimate_request_id) {
      domain.withDb(workspaceId, (db) => {
        const r = getRescue(db, rescueRow.id);
        if (r) {
          const rr = rowToRescue(r);
          rr.outcome = 'booked_from_estimate';
          saveRescue(db, rr);
        }
      });
    }
  }
  if (work.result && work.result.callback) {
    Promise.resolve(
      notifier().notifyCallback(workspaceId, {
        leadId,
        callerPhone: from,
        note: rescueRow.state ? rescueRow.state.callback_note : '',
        businessName: null,
      })
    ).catch(() => {});
  }
  return { handled: true, action: work.action, leadId, rescueId: Number(rescueRow.id) };
}


/* ------------------------------ voice ------------------------------ */

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function publicBase() {
  try {
    return String(require('./stripeClient').appUrl() || '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

function voiceActionUrl(workspaceId, rescueId) {
  return `${publicBase()}/api/v1/calls/rescue-voice/${Number(workspaceId)}/${Number(rescueId)}`;
}

function stageSpeech(db, rescue) {
  const biz = businessName(db, rescue.lead_id);
  if (rescue.stage === 'awaiting_service') {
    const services = publishedServices(db, rescue.lead_id);
    const opts = (rescue.state.service_options || [])
      .map((id, i) => {
        const s = services.find((x) => Number(x.id) === Number(id));
        return s ? `Press ${i + 1} for ${s.name}.` : '';
      })
      .filter(Boolean)
      .join(' ');
    return `Hi, this is ${biz}. Sorry we missed your call earlier. We can book your appointment right now. ${opts}`;
  }
  if (rescue.stage === 'awaiting_slot') {
    const offered = rescue.state.offered || [];
    const opts = offered.map((s, i) => `Press ${i + 1} for ${s.label}.`).join(' ');
    return `For ${rescue.state.service_name || 'your appointment'}, the next openings are: ${opts}`;
  }
  if (rescue.stage === 'awaiting_name') {
    return 'Great. Please say your first and last name for the booking.';
  }
  if (rescue.stage === 'awaiting_callback') {
    return 'Please tell us your name and what you need, and we will call you back.';
  }
  return `Hi, this is ${biz}.`;
}

const TERMINAL_STAGES = ['booked', 'callback_requested', 'stopped', 'expired', 'failed', 'converted'];

/** TwiML for the rescue voice call at the rescue's current stage. */
function buildVoiceTwiml(db, workspaceId, rescue, preface = '') {
  const biz = businessName(db, rescue.lead_id);
  if (TERMINAL_STAGES.includes(rescue.stage)) {
    const closing =
      rescue.stage === 'booked'
        ? `You're booked for ${rescue.state.service_name || 'your appointment'} on ${rescue.state.slot_label || ''}. You'll get a text confirmation. Thank you!`
        : `Thanks — we've passed your request to ${biz} and they'll call you back shortly. Goodbye.`;
    return (
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      (preface ? `<Say>${xmlEscape(preface)}</Say>` : '') +
      `<Say>${xmlEscape(closing)}</Say><Hangup/></Response>`
    );
  }
  const speech = preface || stageSpeech(db, rescue);
  const gatherInput = rescue.stage === 'awaiting_name' || rescue.stage === 'awaiting_callback' ? 'speech' : 'dtmf speech';
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Gather input="${gatherInput}" numDigits="1" timeout="8" speechTimeout="auto" ` +
    `action="${xmlEscape(voiceActionUrl(workspaceId, rescue.id))}" method="POST">` +
    `<Say>${xmlEscape(speech)}</Say></Gather>` +
    `<Say>We didn't catch that. Let's try again.</Say>` +
    `<Redirect method="POST">${xmlEscape(voiceActionUrl(workspaceId, rescue.id))}</Redirect></Response>`
  );
}

/**
 * One voice Gather result. Digits map exactly like SMS numbers;
 * speech goes through the same matcher. Returns the next TwiML.
 * A completed booking ALSO sends the written confirmation by SMS
 * (the spec's confirmation text) from inside this flow.
 */
async function handleVoiceInput(workspaceId, rescueId, { digits, speech } = {}) {
  const domain = require('./domain');
  const input = String(digits || '').trim() || String(speech || '').trim();
  const work = domain.withDb(workspaceId, (db) => {
    ensureTables(db);
    const row = getRescue(db, Number(rescueId));
    if (!row) return null;
    const rescue = rowToRescue(row);
    if (input) {
      logMessage(db, rescue, { direction: 'in', channel: 'voice', body: input });
      if (!TERMINAL_STAGES.includes(rescue.stage) && rescue.stage !== 'pending_text' && rescue.stage !== 'estimate_nudge') {
        const result = stepConversation(db, rescue, input);
        return { rescue, result };
      }
    }
    return { rescue, result: null };
  });
  if (!work) return null;
  const { rescue, result } = work;
  if (result && result.booked) {
    // Written confirmation by text as well as the spoken one.
    await domain.withDb(workspaceId, async (db) => {
      for (const m of result.messages || []) {
        await sendSms(db, workspaceId, rescue, m, 'sms');
      }
    });
    Promise.resolve(notifier().notifyBooking(workspaceId, Number(result.booking.id))).catch(() => {});
  }
  if (result && result.callback) {
    Promise.resolve(
      notifier().notifyCallback(workspaceId, {
        leadId: Number(rescue.lead_id),
        callerPhone: rescue.from_number,
        note: rescue.state ? rescue.state.callback_note : '',
        businessName: null,
      })
    ).catch(() => {});
  }
  return domain.withDb(workspaceId, (db) => {
    const fresh = rowToRescue(getRescue(db, Number(rescueId)));
    const preface = result && result.messages && result.messages.length && !TERMINAL_STAGES.includes(fresh.stage)
      ? result.messages.join(' ')
      : '';
    return buildVoiceTwiml(db, workspaceId, fresh, preface);
  });
}

/** Place the escalation call for a rescue whose reply window expired. */
async function placeVoiceCall(db, workspaceId, rescue) {
  const url = voiceActionUrl(workspaceId, rescue.id);
  const res = await transport().createCall({
    from: String(rescue.to_number || ''),
    to: String(rescue.from_number || ''),
    url,
    workspaceId: Number(workspaceId),
  });
  if (!res || !res.configured) {
    const err = new Error('Twilio is not configured for this workspace');
    err.code = 'TWILIO_NOT_CONFIGURED';
    throw err;
  }
  rescue.voice_call_sid = String(res.sid || '');
  rescue.state.voice_attempted = true;
  rescue.voice_due_at = null;
  saveRescue(db, rescue);
  logMessage(db, rescue, { direction: 'out', channel: 'voice', body: '(voice callback placed)', providerSid: res.sid });
  logTimeline(db, rescue, 'voice_callback');
  return rescue;
}

/* ------------------------- estimate follow-up ---------------------- */

/** "Open" per the estimates module's own statuses
 *  (ESTIMATE_REQUEST_STATUSES = new | contacted | closed): an
 *  estimate is open while it is neither closed by the owner nor
 *  converted. There is no payment state on estimate_requests —
 *  payment happens on bookings/invoices downstream, so the payment
 *  stop-condition is covered by the booking-conversion check. */
const OPEN_ESTIMATE_STATUSES = ['new', 'contacted'];

function estimateBookedSince(db, leadId, phone, sinceStr) {
  const digits = normDigits(phone);
  if (!digits) return false;
  const rows = db
    .prepare('SELECT customer_phone FROM bookings WHERE lead_id = ? AND created_at >= ?')
    .all(Number(leadId), sinceStr);
  return rows.some((r) => normDigits(r.customer_phone) === digits);
}

function enrollEstimates(db, now) {
  const leads = db
    .prepare('SELECT lead_id FROM call_rescue_configs WHERE enabled = 1')
    .all()
    .map((r) => Number(r.lead_id));
  let enrolled = 0;
  for (const leadId of leads) {
    const elig = rescueEligible(db, leadId);
    if (!elig.ok) continue;
    const open = db
      .prepare(
        `SELECT * FROM estimate_requests
          WHERE lead_id = ? AND status IN ('new','contacted') AND phone <> ''`
      )
      .all(leadId);
    for (const est of open) {
      const created = parseUtc(est.created_at);
      if (!created) continue;
      if (now.getTime() - created.getTime() < ESTIMATE_STEP_OFFSETS_MS[0]) continue; // step 1 not due yet
      if (phoneBlocked(db, est.phone)) continue;
      if (isOwnNumber(db, leadId, est.phone, elig.ct)) continue;
      const contact = portalContacts.upsertContact(db, {
        name: est.name || '',
        email: est.email || '',
        phone: est.phone || '',
      });
      // Late enrollment (rescue switched on for an old estimate):
      // start at the CURRENT due step instead of replaying the whole
      // sequence back-to-back — nudge_step pretends the earlier steps
      // already went, so the next send is the step that is due now.
      const elapsedSteps = ESTIMATE_STEP_OFFSETS_MS.filter(
        (off) => now.getTime() - created.getTime() >= off
      ).length;
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO call_rescues
             (lead_id, kind, estimate_request_id, contact_id, from_number, to_number, stage, state_json, nudge_step, next_action_at)
           VALUES (?, 'estimate', ?, ?, ?, ?, 'estimate_nudge', ?, ?, ?)`
        )
        .run(
          leadId,
          Number(est.id),
          contact ? Number(contact.id) : null,
          String(est.phone || '').slice(0, 40),
          String(elig.ct.display_number || '').slice(0, 40),
          JSON.stringify({ name: String(est.name || ''), estimate_cents: Number(est.estimate_cents || 0) }),
          Math.max(0, elapsedSteps - 1),
          utcStr(new Date(created.getTime() + ESTIMATE_STEP_OFFSETS_MS[Math.max(0, elapsedSteps - 1)]))
        );
      if (info.changes) enrolled++;
    }
  }
  return enrolled;
}

function estimateNudgeText(db, rescue, step) {
  const biz = businessName(db, rescue.lead_id);
  const name = String(rescue.state.name || '').split(' ')[0];
  const hi = name ? `Hi ${name}, ` : 'Hi, ';
  if (step === 1) {
    return (
      `${hi}this is ${biz} following up on the estimate you requested. ` +
      'Want me to get you on the schedule? Just reply and I can book you in right here.'
    );
  }
  if (step === 2) {
    return (
      `${hi}${biz} again — your estimate is still open and we'd love to get you booked. ` +
      'Reply and I can offer you the next available times right away.'
    );
  }
  return (
    `${hi}last note from ${biz} about your estimate — no pressure at all. ` +
    "If you'd like to go ahead, reply and I'll book you in. Otherwise we'll close it out. Thanks!"
  );
}

/** Advance one due estimate nudge (stop conditions checked first). */
async function runEstimateStep(db, workspaceId, rescue, now) {
  const est = db
    .prepare('SELECT * FROM estimate_requests WHERE id = ? AND lead_id = ?')
    .get(Number(rescue.estimate_request_id), Number(rescue.lead_id));
  const stop = (outcome) => {
    rescue.stage = outcome === 'booked_elsewhere' ? 'converted' : 'stopped';
    rescue.outcome = outcome;
    rescue.next_action_at = null;
    saveRescue(db, rescue);
    logTimeline(db, rescue, 'estimate_followup_stopped', { reason: outcome });
  };
  if (!est) return stop('estimate_gone');
  if (!OPEN_ESTIMATE_STATUSES.includes(String(est.status))) return stop('estimate_closed');
  if (phoneBlocked(db, rescue.from_number)) return stop('opt_out');
  if (estimateBookedSince(db, rescue.lead_id, rescue.from_number, est.created_at)) {
    return stop('booked_elsewhere');
  }
  const step = Number(rescue.nudge_step || 0) + 1;
  if (step > ESTIMATE_STEP_OFFSETS_MS.length) {
    rescue.stage = 'expired';
    rescue.outcome = 'no_reply';
    rescue.next_action_at = null;
    saveRescue(db, rescue);
    return;
  }
  const config = getRescueConfig(db, rescue.lead_id);
  const q = quietState(config, siteTimezone(db, rescue.lead_id), now);
  if (q.quiet) {
    rescue.next_action_at = utcStr(q.until);
    saveRescue(db, rescue);
    return;
  }
  await sendSms(db, workspaceId, rescue, estimateNudgeText(db, rescue, step));
  rescue.nudge_step = step;
  const created = parseUtc(est.created_at);
  rescue.next_action_at =
    step < ESTIMATE_STEP_OFFSETS_MS.length && created
      ? utcStr(new Date(created.getTime() + ESTIMATE_STEP_OFFSETS_MS[step]))
      : utcStr(new Date(now.getTime() + 3 * 24 * 3600e3)); // final expiry check
  saveRescue(db, rescue);
  logTimeline(db, rescue, 'estimate_nudge_sent', { step });
}

/* ------------------------------- sweep ----------------------------- */

async function sweepWorkspace(workspaceId, now) {
  const domain = require('./domain');
  const stats = { texts: 0, voices: 0, nudges: 0, enrolled: 0, expired: 0 };

  // Phase 1 (sync): enroll estimates + collect due work.
  const due = domain.withDb(workspaceId, (db) => {
    ensureTables(db);
    stats.enrolled = enrollEstimates(db, now);
    const nowStr = utcStr(now);
    const pendingTexts = db
      .prepare(
        `SELECT * FROM call_rescues WHERE stage = 'pending_text'
           AND (next_action_at IS NULL OR next_action_at <= ?) ORDER BY id ASC LIMIT 50`
      )
      .all(nowStr)
      .map(rowToRescue);
    const voiceDue = db
      .prepare(
        `SELECT * FROM call_rescues WHERE voice_due_at IS NOT NULL AND voice_due_at <= ?
           AND stage IN ('awaiting_service','awaiting_slot','awaiting_name','awaiting_callback')
         ORDER BY id ASC LIMIT 50`
      )
      .all(nowStr)
      .map(rowToRescue);
    const nudgesDue = db
      .prepare(
        `SELECT * FROM call_rescues WHERE stage = 'estimate_nudge'
           AND next_action_at IS NOT NULL AND next_action_at <= ? ORDER BY id ASC LIMIT 50`
      )
      .all(nowStr)
      .map(rowToRescue);
    // Expiry: stale conversations + finished nudges sequences.
    const stale = db
      .prepare(
        `SELECT * FROM call_rescues
          WHERE stage IN ('pending_text','awaiting_service','awaiting_slot','awaiting_name','awaiting_callback','estimate_nudge')
            AND created_at <= ? ORDER BY id ASC LIMIT 50`
      )
      .all(utcStr(new Date(now.getTime() - CONVERSATION_TTL_MS)))
      .map(rowToRescue);
    for (const r of stale) {
      if (r.stage === 'estimate_nudge' && Number(r.nudge_step || 0) < 3) continue; // sequence still running
      r.stage = 'expired';
      r.outcome = r.outcome || 'no_reply';
      r.voice_due_at = null;
      r.next_action_at = null;
      saveRescue(db, r);
      stats.expired++;
    }
    return { pendingTexts, voiceDue, nudgesDue };
  });

  // Phase 2: sends (async transport), one rescue at a time.
  for (const rescue of due.pendingTexts) {
    await domain.withDb(workspaceId, async (db) => {
      const fresh = rowToRescue(getRescue(db, rescue.id));
      if (!fresh || fresh.stage !== 'pending_text') return;
      const config = getRescueConfig(db, fresh.lead_id);
      if (!config.enabled) {
        fresh.stage = 'stopped';
        fresh.outcome = 'disabled';
        saveRescue(db, fresh);
        return;
      }
      const q = quietState(config, siteTimezone(db, fresh.lead_id), now);
      if (q.quiet) {
        fresh.next_action_at = utcStr(q.until);
        saveRescue(db, fresh);
        return;
      }
      if (phoneBlocked(db, fresh.from_number)) {
        fresh.stage = 'stopped';
        fresh.outcome = 'opt_out';
        saveRescue(db, fresh);
        return;
      }
      try {
        await sendTextBack(db, workspaceId, fresh, now);
        stats.texts++;
      } catch (e) {
        fresh.stage = 'failed';
        fresh.outcome = e.code === 'TWILIO_NOT_CONFIGURED' ? 'twilio_not_configured' : 'send_failed';
        saveRescue(db, fresh);
        console.warn('[callRescue] text-back failed for rescue', fresh.id, e.message || e);
      }
    });
  }

  for (const rescue of due.voiceDue) {
    await domain.withDb(workspaceId, async (db) => {
      const fresh = rowToRescue(getRescue(db, rescue.id));
      if (!fresh || !fresh.voice_due_at) return;
      if (fresh.state.voice_attempted) {
        fresh.voice_due_at = null;
        saveRescue(db, fresh);
        return;
      }
      const config = getRescueConfig(db, fresh.lead_id);
      const q = quietState(config, siteTimezone(db, fresh.lead_id), now);
      if (q.quiet) {
        fresh.voice_due_at = utcStr(q.until);
        saveRescue(db, fresh);
        return;
      }
      if (phoneBlocked(db, fresh.from_number)) {
        fresh.stage = 'stopped';
        fresh.outcome = 'opt_out';
        fresh.voice_due_at = null;
        saveRescue(db, fresh);
        return;
      }
      try {
        await placeVoiceCall(db, workspaceId, fresh);
        stats.voices++;
      } catch (e) {
        fresh.state.voice_attempted = true;
        fresh.voice_due_at = null;
        fresh.outcome = e.code === 'TWILIO_NOT_CONFIGURED' ? 'twilio_not_configured' : 'voice_failed';
        saveRescue(db, fresh);
        console.warn('[callRescue] voice callback failed for rescue', fresh.id, e.message || e);
      }
    });
  }

  for (const rescue of due.nudgesDue) {
    await domain.withDb(workspaceId, async (db) => {
      const fresh = rowToRescue(getRescue(db, rescue.id));
      if (!fresh || fresh.stage !== 'estimate_nudge') return;
      try {
        await runEstimateStep(db, workspaceId, fresh, now);
        if (Number(fresh.nudge_step || 0) > Number(rescue.nudge_step || 0)) stats.nudges++;
      } catch (e) {
        console.warn('[callRescue] estimate nudge failed for rescue', fresh.id, e.message || e);
      }
    });
  }

  return stats;
}

async function listWorkspaceIds() {
  try {
    const { query } = require('./db');
    const rows = await query('SELECT id FROM workspaces ORDER BY id ASC');
    const ids = (rows || []).map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length) return ids;
  } catch {
    /* fall through */
  }
  return [1];
}

async function runRescueSweep(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const ids = Array.isArray(opts.workspaceIds) && opts.workspaceIds.length ? opts.workspaceIds : await listWorkspaceIds();
  const out = { workspaces: 0, texts: 0, voices: 0, nudges: 0, enrolled: 0, expired: 0 };
  for (const ws of ids) {
    try {
      const s = await sweepWorkspace(Number(ws), now);
      out.workspaces++;
      out.texts += s.texts;
      out.voices += s.voices;
      out.nudges += s.nudges;
      out.enrolled += s.enrolled;
      out.expired += s.expired;
    } catch (e) {
      console.warn('[callRescue] sweep workspace', ws, 'failed:', e && e.message);
    }
  }
  return out;
}

/* ------------------------------ ticker ----------------------------- */

let tickerStarted = false;
function startRescueTicker() {
  if (tickerStarted) return;
  tickerStarted = true;
  const ms = Math.max(15000, Number(process.env.RESCUE_SWEEP_MS || 60000));
  const run = () => runRescueSweep().catch((e) => console.warn('[callRescue] sweep:', e && e.message));
  const first = setTimeout(run, Math.max(10000, Number(process.env.RESCUE_FIRST_SWEEP_MS || 45000)));
  if (first.unref) first.unref();
  const timer = setInterval(run, ms);
  if (timer.unref) timer.unref();
  console.log('[callRescue] rescue ticker started (60s cadence; text-back SLA ~1 min)');
}

module.exports = {
  ensureTables,
  getRescueConfig,
  setRescueConfig,
  isMissedCall,
  rescueEligible,
  phoneBlocked,
  isOwnNumber,
  maybeCreateRescue,
  handleInboundSms,
  handleVoiceInput,
  buildVoiceTwiml,
  runRescueSweep,
  startRescueTicker,
  setTransportForTests,
  setNotifierForTests,
  // exported for regression tests / proofs
  offerSlots,
  slotLabel,
  quietState,
  getRescue,
  leadForTrackingNumber,
  TERMINAL_STAGES,
};
