'use strict';

/**
 * Batch 163 — Webinars (platform level, staff-admin only creation).
 *
 * Ely's ask (2026-11-08): an admin page to create webinars, each with
 * an auto-generated access code and a shareable public link
 * (https://bitpype.com/webinar/<slug>). The public page is a GATE:
 * full name + email + phone + the webinar code. Passing the gate
 *   1. registers the person for that webinar (webinar_registrations,
 *      deduped per webinar by normalized email),
 *   2. captures them into LeadScout's shared contact store for the
 *      platform/agency workspace (workspace 1) via portalContacts —
 *      the gate IS the lead capture; that is the point of running
 *      webinars to promote the agency app,
 *   3. sets a signed, webinar-scoped cookie and lands them in the
 *      room: YouTube embed (ID parsed by server/landingVideos.js, the
 *      pasted markup is never stored or rendered) + live chat.
 *
 * Chat: messages persist in webinar_messages. The room receives them
 * over SSE (an in-process hub — the app is a single container; the
 * persisted rows are the source of truth and the stream replays the
 * backlog on connect). Chat is effectively open when the host's
 * chat_open override is set, else exactly while status = 'live'.
 * Host messages are badged; staff can hide a message (visitors stop
 * seeing it, admin still sees it marked hidden).
 *
 * The access code is NOT in the shareable link — the link opens the
 * gate and the code is typed there. One code per webinar; regenerating
 * it invalidates the old one immediately. Gate attempts are
 * rate-limited in the route (server/routes/webinarsPublic.js).
 */

const crypto = require('crypto');
const { query } = require('./db');
const { extractYouTubeVideoId } = require('./landingVideos');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const CODE_LENGTH = 7;
const STATUSES = ['scheduled', 'live', 'ended'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 8000;
const MAX_NAME = 200;
const MAX_MESSAGE = 2000;
const CHAT_BACKLOG = 200;
const NY_TZ = 'America/New_York';

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
function validation(message) {
  return coded('VALIDATION', message);
}
function notFound(message) {
  return coded('NOT_FOUND', message || 'Webinar not found');
}

function generateAccessCode() {
  let out = '';
  const bytes = crypto.randomBytes(CODE_LENGTH);
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function slugify(title) {
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'webinar';
}

function normalizeEmail(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
}
function isValidEmail(email) {
  return !!email && email.length <= 254 && EMAIL_RE.test(email);
}
function cleanName(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[<>"\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}
function cleanPhone(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[^\d+]/g, '')
    .slice(0, 32);
}
function isValidPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 20;
}

/**
 * Interpret a `datetime-local` value ('YYYY-MM-DDTHH:MM') as wall time
 * in America/New_York and return the UTC instant as an ISO string.
 * Also accepts a full ISO string (with Z/offset) and passes it through.
 */
function nyLocalToUtcIso(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  // Guess UTC, read back what NY shows for that instant, correct by
  // the difference; two passes settle DST edges.
  let guess = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: NY_TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(guess));
    const p = {};
    for (const part of parts) p[part.type] = Number(part.value);
    const shownAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
    const targetAsUtc = Date.UTC(y, mo - 1, d, h, mi, s || 0);
    guess += targetAsUtc - shownAsUtc;
  }
  return new Date(guess).toISOString();
}

/** Stored instants render for humans in America/New_York. */
function formatNyTime(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

/* ------------------------------------------------------------------ */
/* Webinars                                                            */
/* ------------------------------------------------------------------ */

function rowToWebinar(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    slug: r.slug,
    title: r.title || '',
    description: r.description || '',
    scheduledAt: r.scheduled_at || null,
    scheduledLabel: formatNyTime(r.scheduled_at),
    youtubeId: r.youtube_id || '',
    status: r.status || 'scheduled',
    chatOpen: r.chat_open == null ? null : !!Number(r.chat_open),
    accessCode: r.access_code || '',
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null,
  };
}

function chatEffectivelyOpen(w) {
  if (!w) return false;
  if (w.chatOpen != null) return w.chatOpen;
  return w.status === 'live';
}

async function getWebinarById(id) {
  const rows = await query('SELECT * FROM webinars WHERE id = :id', { id: Number(id) });
  return rowToWebinar(rows[0]);
}
async function getWebinarBySlug(slug) {
  const rows = await query('SELECT * FROM webinars WHERE slug = :slug', { slug: String(slug || '') });
  return rowToWebinar(rows[0]);
}

async function listWebinars() {
  const rows = await query(
    `SELECT w.*,
       (SELECT COUNT(*) FROM webinar_registrations r WHERE r.webinar_id = w.id) AS reg_count,
       (SELECT COUNT(*) FROM webinar_registrations r WHERE r.webinar_id = w.id AND r.joined_at IS NOT NULL) AS joined_count,
       (SELECT COUNT(*) FROM webinar_messages m WHERE m.webinar_id = w.id) AS msg_count
     FROM webinars w ORDER BY w.id DESC`
  );
  return rows.map((r) => ({
    ...rowToWebinar(r),
    registrantCount: Number(r.reg_count || 0),
    joinedCount: Number(r.joined_count || 0),
    messageCount: Number(r.msg_count || 0),
  }));
}

async function uniqueSlug(title, excludeId) {
  const base = slugify(title);
  let slug = base;
  let n = 1;
  for (;;) {
    const rows = await query('SELECT id FROM webinars WHERE slug = :slug', { slug });
    if (!rows.length || (excludeId && Number(rows[0].id) === Number(excludeId))) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

function cleanWebinarInput(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) {
    const title = String(body.title || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TITLE);
    if (!title) throw validation('A webinar title is required');
    out.title = title;
  }
  if (body.description !== undefined) {
    out.description = String(body.description || '').slice(0, MAX_DESCRIPTION);
  }
  if (body.scheduledAt !== undefined) {
    out.scheduledAt = nyLocalToUtcIso(body.scheduledAt);
    if (body.scheduledAt && !out.scheduledAt) throw validation('Scheduled time is not a valid date/time');
  }
  if (body.youtube !== undefined || body.youtubeId !== undefined) {
    const ref = body.youtube !== undefined ? body.youtube : body.youtubeId;
    if (ref === '' || ref == null) out.youtubeId = '';
    else {
      const id = extractYouTubeVideoId(ref);
      if (!id) throw validation('That does not look like a YouTube video link or ID');
      out.youtubeId = id;
    }
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw validation('Status must be scheduled, live or ended');
    out.status = body.status;
  }
  if (body.chatOpen !== undefined) {
    out.chatOpen = body.chatOpen === null ? null : !!body.chatOpen;
  }
  return out;
}

async function createWebinar(body, createdBy) {
  const data = cleanWebinarInput(body || {});
  const slug = await uniqueSlug(data.title);
  const code = generateAccessCode();
  const res = await query(
    `INSERT INTO webinars (slug, title, description, scheduled_at, youtube_id, status, chat_open, access_code, created_by)
     VALUES (:slug, :title, :description, :scheduled_at, :youtube_id, 'scheduled', NULL, :access_code, :created_by)`,
    {
      slug,
      title: data.title,
      description: data.description || '',
      scheduled_at: data.scheduledAt || null,
      youtube_id: data.youtubeId || '',
      access_code: code,
      created_by: createdBy == null ? null : Number(createdBy),
    }
  );
  return getWebinarById(res.insertId);
}

async function updateWebinar(id, body) {
  const existing = await getWebinarById(id);
  if (!existing) throw notFound();
  const data = cleanWebinarInput(body || {}, { partial: true });
  const sets = [];
  const params = { id: existing.id };
  if (data.title !== undefined) {
    sets.push('title = :title');
    params.title = data.title;
  }
  if (data.description !== undefined) {
    sets.push('description = :description');
    params.description = data.description;
  }
  if (data.scheduledAt !== undefined) {
    sets.push('scheduled_at = :scheduled_at');
    params.scheduled_at = data.scheduledAt;
  }
  if (data.youtubeId !== undefined) {
    sets.push('youtube_id = :youtube_id');
    params.youtube_id = data.youtubeId;
  }
  if (data.status !== undefined) {
    sets.push('status = :status');
    params.status = data.status;
  }
  if (data.chatOpen !== undefined) {
    sets.push('chat_open = :chat_open');
    params.chat_open = data.chatOpen === null ? null : data.chatOpen ? 1 : 0;
  }
  if (sets.length) {
    sets.push('updated_at = UTC_TIMESTAMP()');
    await query(`UPDATE webinars SET ${sets.join(', ')} WHERE id = :id`, params);
  }
  return getWebinarById(existing.id);
}

async function regenerateCode(id) {
  const existing = await getWebinarById(id);
  if (!existing) throw notFound();
  const code = generateAccessCode();
  await query('UPDATE webinars SET access_code = :code, updated_at = UTC_TIMESTAMP() WHERE id = :id', {
    code,
    id: existing.id,
  });
  return getWebinarById(existing.id);
}

async function deleteWebinar(id) {
  const existing = await getWebinarById(id);
  if (!existing) throw notFound();
  await query('DELETE FROM webinar_messages WHERE webinar_id = :id', { id: existing.id });
  await query('DELETE FROM webinar_registrations WHERE webinar_id = :id', { id: existing.id });
  await query('DELETE FROM webinars WHERE id = :id', { id: existing.id });
  return { deleted: true, id: existing.id, slug: existing.slug };
}

function sharePath(webinar) {
  return `/webinar/${webinar.slug}`;
}

/* ------------------------------------------------------------------ */
/* Registrations + lead capture                                        */
/* ------------------------------------------------------------------ */

function rowToRegistration(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    webinarId: Number(r.webinar_id),
    name: r.name || '',
    email: r.email || '',
    phone: r.phone || '',
    contactId: r.contact_id == null ? null : Number(r.contact_id),
    registeredAt: r.registered_at || null,
    joinedAt: r.joined_at || null,
  };
}

async function getRegistration(webinarId, emailNorm) {
  const rows = await query('SELECT * FROM webinar_registrations WHERE webinar_id = :w AND email_norm = :e', {
    w: Number(webinarId),
    e: emailNorm,
  });
  return rowToRegistration(rows[0]);
}

async function listRegistrations(webinarId) {
  const rows = await query('SELECT * FROM webinar_registrations WHERE webinar_id = :w ORDER BY id ASC', {
    w: Number(webinarId),
  });
  return rows.map(rowToRegistration);
}

/**
 * Capture the registrant into LeadScout (workspace 1 tenant DB) via
 * portalContacts. Best-effort by design (the capture functions record
 * their own failures); returns the contact id when known.
 */
function captureRegistrantAsContact(registration, webinarTitle) {
  try {
    const { openWorkspaceDb } = require('./workspaceDb');
    const portalContacts = require('./portalContacts');
    const wdb = openWorkspaceDb(1);
    const result = portalContacts.captureFromWebinar(wdb, {
      registration: {
        id: registration.id,
        name: registration.name,
        email: registration.email,
        phone: registration.phone,
      },
      webinarTitle,
    });
    if (result && result.contact && result.contact.id) return Number(result.contact.id);
  } catch (e) {
    console.warn(
      `[webinars] lead capture failed for registration ${registration && registration.id}: ${(e && e.message) || e}`
    );
  }
  return null;
}

/**
 * The gate submission. Validates identity + code, upserts the
 * registration (one per webinar+email — re-entry never duplicates),
 * captures the LeadScout contact, and returns the registration.
 * Throws coded errors: VALIDATION (fields), INVALID_CODE (generic —
 * never reveals more than "check the code").
 */
async function registerWithCode(webinar, input) {
  const name = cleanName(input && input.name);
  const email = normalizeEmail(input && input.email);
  const phone = cleanPhone(input && input.phone);
  const code = String((input && input.code) || '')
    .trim()
    .toUpperCase();
  if (!name) throw validation('Please enter your full name');
  if (!isValidEmail(email)) throw validation('Please enter a valid email address');
  if (!isValidPhone(phone)) throw validation('Please enter a valid phone number');
  if (!code || code !== String(webinar.accessCode || '').toUpperCase()) {
    throw coded('INVALID_CODE', 'That code does not match this webinar — check it and try again');
  }
  let reg = await getRegistration(webinar.id, email);
  if (reg) {
    await query('UPDATE webinar_registrations SET name = :name, phone = :phone WHERE id = :id', {
      name,
      phone,
      id: reg.id,
    });
    reg = { ...reg, name, phone };
  } else {
    const res = await query(
      `INSERT INTO webinar_registrations (webinar_id, name, email, email_norm, phone)
       VALUES (:w, :name, :email, :email_norm, :phone)`,
      { w: webinar.id, name, email, email_norm: email, phone }
    );
    reg = await getRegistration(webinar.id, email);
    if (!reg) reg = { id: Number(res.insertId), webinarId: webinar.id, name, email, phone, contactId: null };
  }
  if (!reg.contactId) {
    const contactId = captureRegistrantAsContact(reg, webinar.title);
    if (contactId) {
      await query('UPDATE webinar_registrations SET contact_id = :c WHERE id = :id', { c: contactId, id: reg.id });
      reg = { ...reg, contactId };
    }
  }
  return reg;
}

async function markJoined(registrationId) {
  await query('UPDATE webinar_registrations SET joined_at = UTC_TIMESTAMP() WHERE id = :id AND joined_at IS NULL', {
    id: Number(registrationId),
  });
}

/* ------------------------------------------------------------------ */
/* Chat messages + live hub                                            */
/* ------------------------------------------------------------------ */

function rowToMessage(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    webinarId: Number(r.webinar_id),
    registrationId: r.registration_id == null ? null : Number(r.registration_id),
    authorName: r.author_name || '',
    isHost: !!Number(r.is_host || 0),
    body: r.body || '',
    hidden: !!Number(r.hidden || 0),
    createdAt: r.created_at || null,
  };
}

/** Messages for the room (hidden excluded) or the admin console (all). */
async function listMessages(webinarId, { afterId = 0, includeHidden = false, limit = CHAT_BACKLOG } = {}) {
  const rows = await query(
    `SELECT * FROM webinar_messages
      WHERE webinar_id = :w AND id > :after ${includeHidden ? '' : 'AND hidden = 0'}
      ORDER BY id ASC LIMIT :lim`,
    { w: Number(webinarId), after: Number(afterId) || 0, lim: Math.min(Number(limit) || CHAT_BACKLOG, 500) }
  );
  return rows.map(rowToMessage);
}

const hub = new Map(); // webinarId -> Set<res>
function hubSubscribe(webinarId, res) {
  const key = Number(webinarId);
  if (!hub.has(key)) hub.set(key, new Set());
  hub.get(key).add(res);
  res.on('close', () => {
    const set = hub.get(key);
    if (set) {
      set.delete(res);
      if (!set.size) hub.delete(key);
    }
  });
}
function hubPublish(webinarId, message) {
  const set = hub.get(Number(webinarId));
  if (!set) return;
  const payload = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      /* closing socket */
    }
  }
}

async function postMessage(webinar, { registration = null, hostName = null, body }) {
  const text = String(body || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE);
  if (!text) throw validation('Message is empty');
  const isHost = !!hostName;
  const authorName = isHost ? String(hostName).slice(0, MAX_NAME) : registration.name;
  const res = await query(
    `INSERT INTO webinar_messages (webinar_id, registration_id, author_name, is_host, body)
     VALUES (:w, :r, :author, :host, :body)`,
    {
      w: webinar.id,
      r: registration ? Number(registration.id) : null,
      author: authorName,
      host: isHost ? 1 : 0,
      body: text,
    }
  );
  const rows = await query('SELECT * FROM webinar_messages WHERE id = :id', { id: Number(res.insertId) });
  const message = rowToMessage(rows[0]);
  if (message) hubPublish(webinar.id, message);
  return message;
}

async function setMessageHidden(webinarId, messageId, hidden) {
  const rows = await query('SELECT * FROM webinar_messages WHERE id = :id AND webinar_id = :w', {
    id: Number(messageId),
    w: Number(webinarId),
  });
  if (!rows.length) throw notFound('Message not found');
  await query('UPDATE webinar_messages SET hidden = :h WHERE id = :id', {
    h: hidden ? 1 : 0,
    id: Number(messageId),
  });
  const after = await query('SELECT * FROM webinar_messages WHERE id = :id', { id: Number(messageId) });
  const message = rowToMessage(after[0]);
  if (message && !hidden) hubPublish(webinarId, message);
  if (message && hidden) hubPublish(webinarId, { ...message, body: '', redacted: true });
  return message;
}

/* ------------------------------------------------------------------ */
/* Gate session cookie (signed, webinar-scoped)                        */
/* ------------------------------------------------------------------ */

function cookieSecret() {
  return String(process.env.SESSION_SECRET || '');
}
function cookieName(webinarId) {
  return `bp_webinar_${Number(webinarId)}`;
}
function signGateCookie(webinarId, registrationId) {
  const body = Buffer.from(
    JSON.stringify({ w: Number(webinarId), r: Number(registrationId), v: 1, exp: Date.now() + 30 * 24 * 3600 * 1000 })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', cookieSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyGateCookie(webinarId, raw) {
  const value = String(raw || '').trim();
  const [body, sig] = value.split('.');
  if (!body || !sig || !cookieSecret()) return null;
  const expect = crypto.createHmac('sha256', cookieSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.v !== 1 || Number(payload.w) !== Number(webinarId)) return null;
  if (!Number.isInteger(Number(payload.r)) || Number(payload.r) <= 0) return null;
  if (payload.exp && Date.now() > Number(payload.exp)) return null;
  return { registrationId: Number(payload.r) };
}

module.exports = {
  CODE_LENGTH,
  STATUSES,
  CHAT_BACKLOG,
  generateAccessCode,
  slugify,
  normalizeEmail,
  isValidEmail,
  cleanName,
  cleanPhone,
  isValidPhone,
  nyLocalToUtcIso,
  formatNyTime,
  chatEffectivelyOpen,
  getWebinarById,
  getWebinarBySlug,
  listWebinars,
  createWebinar,
  updateWebinar,
  regenerateCode,
  deleteWebinar,
  sharePath,
  getRegistration,
  listRegistrations,
  registerWithCode,
  markJoined,
  listMessages,
  postMessage,
  setMessageHidden,
  hubSubscribe,
  cookieName,
  signGateCookie,
  verifyGateCookie,
};
