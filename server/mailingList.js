'use strict';

/**
 * Batch 71 — Admin-only Mailing List + Newsletter (BitPype's OWN list).
 *
 * Ely's ask (2026-10-29, corrected scope): "a mailing list to manage
 * and a newsletter to send messages to the mailing list" — for HIM,
 * Admin only. NO client-site module, NO portal panel, NO per-workspace
 * lists. Only staff (super admin, via server/routes/admin.js) can see
 * or touch any of this.
 *
 * Design rules:
 *   - Subscribers live at PLATFORM level (server/db.js tables
 *     mailing_list_subscribers / mailing_list_sends, created in
 *     db.migrate for both drivers) — deliberately NOT in any workspace
 *     database and NOT the workspace lead tables. The outreach campaign
 *     system (src/outreach.js + Outreach → Campaigns) sends to LEADS
 *     and is a different thing; nothing here wires into it.
 *   - The list is populated ONLY by the admin (add / paste / CSV
 *     import). Nobody is seeded or auto-imported from leads.
 *   - Sends ride server/mailer.sendPlatformMail (the Batch 48 provider
 *     selector) and honor BOTH this list's own unsubscribes AND the
 *     existing Outreach suppression list (checked in BitPype's own
 *     workspace, id 1 — the LANDING_WORKSPACE_ID convention).
 *   - Every send carries a signed per-recipient unsubscribe link
 *     (HMAC-SHA256 over a base64url JSON payload — the exact family
 *     src/outreach.js uses for interest links, sharing its secret via
 *     interestLinkSecret). The public GET flips the subscriber to
 *     unsubscribed and needs no sign-in.
 *   - Unsubscribed addresses are never silently re-subscribed: add /
 *     import report them as blocked; only the explicit re-subscribe
 *     action flips one back.
 *   - A send requires an explicit confirmCount equal to the number of
 *     recipients that will actually be mailed (subscribed and not
 *     suppression-listed) — the UI names that exact count in its
 *     confirm step, and the server refuses a stale count.
 *   - Per-recipient failures never abort the rest of a send; the send
 *     is logged with attempted / sent / failed / skipped totals and a
 *     partially failed send is reported as exactly that.
 *   - Placeholders: {{name}}, {{email}}, {{unsubscribe_url}}.
 *     Anything else renders literally, never as a blank.
 */

const crypto = require('crypto');
const { query } = require('./db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECT = 255;
const MAX_BODY = 200000;
const MAX_IMPORT = 5000;

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
function validation(message) {
  return coded('VALIDATION', message);
}

function normalizeEmail(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}
function isValidEmail(email) {
  return !!email && email.length <= 254 && EMAIL_RE.test(email);
}
function cleanName(raw) {
  return String(raw == null ? '' : raw).replace(/[<>"\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* Subscribers                                                         */
/* ------------------------------------------------------------------ */

async function getSubscriberByEmail(email) {
  const rows = await query('SELECT * FROM mailing_list_subscribers WHERE email = :e', { e: email });
  return rows[0] || null;
}
async function getSubscriberById(id) {
  const rows = await query('SELECT * FROM mailing_list_subscribers WHERE id = :id', { id: Number(id) });
  return rows[0] || null;
}

function publicRow(r) {
  return {
    id: Number(r.id),
    email: r.email,
    name: r.name || '',
    status: r.status,
    source: r.source || 'manual',
    created_at: r.created_at,
    unsubscribed_at: r.unsubscribed_at || null,
  };
}

/**
 * Add one subscriber. Duplicate handling is explicit, never silent:
 *   already subscribed   → { added:false, reason:'duplicate' }
 *   currently unsubscribed → { added:false, reason:'unsubscribed' }
 *     (an explicit re-subscribe is required — see resubscribe())
 */
async function addSubscriber(input = {}, opts = {}) {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw validation('A valid email address is required');
  const name = cleanName(input.name);
  const source = ['manual', 'import', 'admin'].includes(opts.source) ? opts.source : 'admin';
  const existing = await getSubscriberByEmail(email);
  if (existing) {
    if (existing.status === 'unsubscribed') {
      return { added: false, reason: 'unsubscribed', subscriber: publicRow(existing) };
    }
    return { added: false, reason: 'duplicate', subscriber: publicRow(existing) };
  }
  const res = await query(
    'INSERT INTO mailing_list_subscribers (email, name, status, source) VALUES (:e, :n, :s, :src)',
    { e: email, n: name, s: 'subscribed', src: source }
  );
  const row = await getSubscriberById(res.insertId);
  return { added: true, subscriber: publicRow(row) };
}

/** Split one import line into { email, name } however it is shaped. */
function parseImportLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  // CSV-ish: split on commas not inside quotes.
  const parts = raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((p) => p.replace(/^"|"$/g, '').trim());
  let email = '';
  const nameParts = [];
  for (const p of parts) {
    const candidate = normalizeEmail(p.replace(/^<|>$/g, ''));
    if (!email && isValidEmail(candidate)) email = candidate;
    else if (p) nameParts.push(p);
  }
  if (!email) {
    // Maybe "Name <email>" on one field.
    const m = raw.match(/<([^>]+)>/);
    if (m && isValidEmail(normalizeEmail(m[1]))) {
      return { email: normalizeEmail(m[1]), name: cleanName(raw.replace(m[0], '')) };
    }
    return { invalid: raw };
  }
  return { email, name: cleanName(nameParts.join(' ')) };
}

/**
 * Paste / CSV import. Reports exactly what happened — added,
 * duplicates (already subscribed), blocked (unsubscribed, NOT flipped),
 * invalid (with the offending lines) — never a partial silent import.
 */
async function importSubscribers(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw validation('Paste at least one email address (one per line, or CSV)');
  if (lines.length > MAX_IMPORT) throw validation(`Import is limited to ${MAX_IMPORT} lines at a time`);
  // A CSV header row is skipped, not counted as invalid.
  const body = lines.filter((l, i) => !(i === 0 && /email/i.test(l) && !/@/.test(l)));
  const out = { added: 0, duplicates: 0, blockedUnsubscribed: 0, invalid: [], totalLines: body.length };
  const seen = new Set();
  for (const line of body) {
    const parsed = parseImportLine(line);
    if (!parsed || parsed.invalid || !parsed.email) {
      out.invalid.push(line.slice(0, 200));
      continue;
    }
    if (seen.has(parsed.email)) {
      out.duplicates++;
      continue;
    }
    seen.add(parsed.email);
    const r = await addSubscriber({ email: parsed.email, name: parsed.name }, { source: 'import' });
    if (r.added) out.added++;
    else if (r.reason === 'unsubscribed') out.blockedUnsubscribed++;
    else out.duplicates++;
  }
  return out;
}

async function listSubscribers(args = {}) {
  const pageSize = Math.min(200, Math.max(1, Number(args.pageSize) || 50));
  const page = Math.max(1, Number(args.page) || 1);
  const search = String(args.search || '').trim().toLowerCase();
  const status = ['subscribed', 'unsubscribed'].includes(args.status) ? args.status : '';
  const where = [];
  const params = {};
  if (search) {
    where.push('(email LIKE :q OR name LIKE :q)');
    params.q = `%${search}%`;
  }
  if (status) {
    where.push('status = :st');
    params.st = status;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRows = await query(`SELECT COUNT(*) AS c FROM mailing_list_subscribers ${clause}`, params);
  const total = Number(totalRows[0].c);
  // LIMIT/OFFSET interpolated as clamped integers (the admin.js
  // convention — MySQL prepared statements reject LIMIT placeholders).
  const rows = await query(
    `SELECT * FROM mailing_list_subscribers ${clause} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params
  );
  const countsRows = await query(
    `SELECT status, COUNT(*) AS c FROM mailing_list_subscribers GROUP BY status`
  );
  const counts = { total: 0, subscribed: 0, unsubscribed: 0 };
  for (const r of countsRows) {
    counts.total += Number(r.c);
    if (r.status === 'subscribed') counts.subscribed = Number(r.c);
    if (r.status === 'unsubscribed') counts.unsubscribed = Number(r.c);
  }
  return { rows: rows.map(publicRow), total, page, pageSize, counts };
}

async function setSubscriberStatus(id, status) {
  const row = await getSubscriberById(id);
  if (!row) throw coded('NOT_FOUND', 'Subscriber not found');
  if (status === 'unsubscribed') {
    await query(
      'UPDATE mailing_list_subscribers SET status = :s, unsubscribed_at = UTC_TIMESTAMP() WHERE id = :id',
      { s: 'unsubscribed', id: row.id }
    );
  } else {
    await query(
      'UPDATE mailing_list_subscribers SET status = :s, unsubscribed_at = NULL WHERE id = :id',
      { s: 'subscribed', id: row.id }
    );
  }
  return publicRow(await getSubscriberById(row.id));
}

async function removeSubscriber(id) {
  const row = await getSubscriberById(id);
  if (!row) throw coded('NOT_FOUND', 'Subscriber not found');
  await query('DELETE FROM mailing_list_subscribers WHERE id = :id', { id: row.id });
  return { removed: true, email: row.email };
}

/* ------------------------------------------------------------------ */
/* Unsubscribe tokens (HMAC — same family as outreach interest links)  */
/* ------------------------------------------------------------------ */

function signUnsubscribeToken(subscriberId) {
  const outreach = require('../src/outreach');
  const id = Number(subscriberId);
  if (!Number.isInteger(id) || id <= 0) throw validation('A subscriber id is required to sign an unsubscribe link');
  const body = Buffer.from(JSON.stringify({ s: id, a: 'ml-unsub', v: 1 })).toString('base64url');
  const sig = crypto.createHmac('sha256', outreach.interestLinkSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyUnsubscribeToken(token) {
  const outreach = require('../src/outreach');
  const raw = String(token || '').trim();
  const [body, sig] = raw.split('.');
  if (!body || !sig) throw coded('INVALID_TOKEN', 'Invalid unsubscribe link');
  const expect = crypto.createHmac('sha256', outreach.interestLinkSecret()).update(body).digest('base64url');
  const aBuf = Buffer.from(sig);
  const bBuf = Buffer.from(expect);
  if (aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) {
    throw coded('INVALID_TOKEN', 'Invalid or forged unsubscribe link');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw coded('INVALID_TOKEN', 'Invalid unsubscribe link');
  }
  const id = Number(payload.s);
  if (payload.a !== 'ml-unsub' || !Number.isInteger(id) || id <= 0) {
    throw coded('INVALID_TOKEN', 'Invalid unsubscribe link');
  }
  return { subscriberId: id };
}

function unsubscribeUrl(subscriberId) {
  const base = require('./stripeClient').appUrl();
  return `${base}/api/v1/mailing-list/unsubscribe/${encodeURIComponent(signUnsubscribeToken(subscriberId))}`;
}

/** Public-link handler logic: verify, flip, report. Never throws. */
async function applyUnsubscribe(token) {
  let parsed;
  try {
    parsed = verifyUnsubscribeToken(token);
  } catch (e) {
    return { ok: false, code: e.code || 'INVALID_TOKEN', message: e.message };
  }
  const row = await getSubscriberById(parsed.subscriberId);
  if (!row) return { ok: false, code: 'NOT_FOUND', message: 'This subscription was not found.' };
  if (row.status === 'unsubscribed') return { ok: true, already: true, email: row.email };
  await setSubscriberStatus(row.id, 'unsubscribed');
  return { ok: true, already: false, email: row.email };
}

/* ------------------------------------------------------------------ */
/* Newsletter compose / preview / send                                 */
/* ------------------------------------------------------------------ */

function cleanSubject(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_SUBJECT);
  if (!s) throw validation('A subject is required');
  return s;
}
function cleanBody(raw) {
  const b = String(raw == null ? '' : raw).trim();
  if (!b) throw validation('Newsletter body is required');
  if (b.length > MAX_BODY) throw validation('Newsletter body is too large');
  if (/<script\b/i.test(b)) throw validation('Scripts are not allowed in the newsletter body');
  return b;
}

/** Substitute the supported placeholders; unknown ones stay literal. */
function substitute(text, subscriber, unsubUrl) {
  const map = {
    name: subscriber.name || '',
    email: subscriber.email || '',
    unsubscribe_url: unsubUrl || '',
  };
  return String(text == null ? '' : text).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, key) => {
    const k = String(key).toLowerCase();
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m;
  });
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Render one recipient's email. The unsubscribe footer is part of the
 * render (not bolted on at send), so the admin preview shows exactly
 * what a recipient gets. The mailer wraps it in the branded template.
 */
function renderNewsletter(input, subscriber, unsubOverride) {
  const subject = substitute(cleanSubject(input.subject), subscriber, '');
  const unsub =
    unsubOverride || (Number(subscriber.id) > 0 ? unsubscribeUrl(subscriber.id) : '#unsubscribe-preview');
  const subjectFinal = substitute(subject, subscriber, unsub);
  const bodyHtml = substitute(cleanBody(input.bodyHtml), subscriber, unsub);
  const footerHtml =
    `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0" />` +
    `<p style="font-size:12px;color:#777">You are receiving this because you subscribed to the BitPype newsletter. ` +
    `<a href="${unsub}">Unsubscribe</a></p>`;
  const html = bodyHtml + footerHtml;
  const text = `${htmlToText(bodyHtml)}\n\n—\nYou are receiving this because you subscribed to the BitPype newsletter. Unsubscribe: ${unsub}`;
  return { to: subscriber.email, subject: subjectFinal, html, text };
}

/** The default suppression check: the Outreach suppression list in
 *  BitPype's own workspace (id 1). Injectable for tests. */
function defaultIsSuppressed(email) {
  try {
    const domain = require('./domain');
    const outreach = require('../src/outreach');
    return domain.withDb(1, (db) => !!outreach.isSuppressed(db, email));
  } catch (e) {
    console.warn('[mailingList] suppression check failed (treating as not suppressed):', e && e.message);
    return false;
  }
}

async function listSubscribed() {
  return query('SELECT * FROM mailing_list_subscribers WHERE status = :s ORDER BY id ASC', { s: 'subscribed' });
}

/** Who would actually be mailed right now (subscribed + not suppressed). */
async function eligibleRecipients(deps = {}) {
  const isSuppressed = deps.isSuppressed || defaultIsSuppressed;
  const rows = await listSubscribed();
  const eligible = [];
  let suppressed = 0;
  for (const r of rows) {
    if (await isSuppressed(r.email)) suppressed++;
    else eligible.push(r);
  }
  return { eligible, subscribedCount: rows.length, suppressed };
}

/**
 * Preview renders one real subscriber (the requested one, else the
 * first subscribed, else a clearly-labelled sample) — and is a hard
 * gate: the send route refuses any subject/body pair that has not
 * been previewed in this process via previewNewsletter (the token it
 * returns must come back with the send).
 */
const previewTokens = new Map();
async function previewNewsletter(input = {}, deps = {}) {
  const subject = cleanSubject(input.subject);
  const bodyHtml = cleanBody(input.bodyHtml);
  let subscriber = null;
  if (input.subscriberId) subscriber = await getSubscriberById(input.subscriberId);
  if (!subscriber) {
    const rows = await listSubscribed();
    subscriber = rows[0] || null;
  }
  const sample = subscriber
    ? publicRow(subscriber)
    : { id: 0, email: 'you@example.com', name: 'Sample Subscriber', status: 'subscribed', source: 'manual' };
  // A sample with id 0 cannot carry a real unsubscribe link; render it
  // with an inert placeholder href instead of a signed link.
  const rendered = renderNewsletter({ subject, bodyHtml }, sample);
  const token = crypto.randomBytes(16).toString('hex');
  previewTokens.set(token, {
    hash: crypto.createHash('sha256').update(`${subject}\n${bodyHtml}`).digest('hex'),
    at: Date.now(),
  });
  // Keep the map small: drop tokens older than an hour.
  for (const [k, v] of previewTokens) if (Date.now() - v.at > 3600000) previewTokens.delete(k);
  const { eligible, subscribedCount, suppressed } = await eligibleRecipients(deps);
  return {
    previewToken: token,
    rendered,
    sampleSubscriber: { email: sample.email, name: sample.name, real: !!subscriber },
    recipientCount: eligible.length,
    subscribedCount,
    suppressedCount: suppressed,
  };
}

function assertPreviewed(input) {
  const token = String(input.previewToken || '');
  const rec = token && previewTokens.get(token);
  const hash = crypto.createHash('sha256').update(`${cleanSubject(input.subject)}\n${cleanBody(input.bodyHtml)}`).digest('hex');
  if (!rec || rec.hash !== hash) {
    throw coded('PREVIEW_REQUIRED', 'Preview this exact newsletter before sending — the subject or body changed since the last preview.');
  }
  previewTokens.delete(token);
}

/**
 * Send to all currently subscribed, non-suppressed subscribers.
 * confirmCount must equal the eligible recipient count at send time.
 * One recipient's failure never aborts the rest. Always logs a
 * mailing_list_sends history row (even for a zero-send outcome).
 */
async function sendNewsletter(input = {}, deps = {}) {
  const subject = cleanSubject(input.subject);
  const bodyHtml = cleanBody(input.bodyHtml);
  assertPreviewed({ ...input, subject, bodyHtml });
  const sendMail = deps.sendMail || (async (m) => require('./mailer').sendPlatformMail(m));
  const { eligible, subscribedCount, suppressed } = await eligibleRecipients(deps);
  const confirmCount = Number(input.confirmCount);
  if (!Number.isInteger(confirmCount) || confirmCount !== eligible.length) {
    throw coded(
      'CONFIRM_MISMATCH',
      `Confirm the exact recipient count to send: ${eligible.length} subscriber(s) will be emailed (${subscribedCount} subscribed, ${suppressed} on the suppression list).`
    );
  }
  let sent = 0;
  let failed = 0;
  let firstError = '';
  for (const row of eligible) {
    try {
      const mail = renderNewsletter({ subject, bodyHtml }, publicRow(row));
      await sendMail(mail);
      sent++;
    } catch (e) {
      failed++;
      if (!firstError) firstError = (e && e.message) || String(e);
      console.warn(`[mailingList] send to ${row.email} failed:`, (e && e.code) || '', (e && e.message) || e);
    }
  }
  const attempted = sent + failed;
  const res = await query(
    `INSERT INTO mailing_list_sends (subject, recipients_attempted, recipients_sent, recipients_failed, recipients_skipped, created_by)
     VALUES (:s, :a, :se, :f, :sk, :by)`,
    { s: subject, a: attempted, se: sent, f: failed, sk: suppressed, by: input.createdBy != null ? Number(input.createdBy) : null }
  );
  return {
    sendId: Number(res.insertId),
    subject,
    attempted,
    sent,
    failed,
    skippedSuppressed: suppressed,
    subscribedCount,
    firstError: firstError || undefined,
  };
}

async function listSends(args = {}) {
  const pageSize = Math.min(200, Math.max(1, Number(args.pageSize) || 50));
  const page = Math.max(1, Number(args.page) || 1);
  const totalRows = await query('SELECT COUNT(*) AS c FROM mailing_list_sends');
  const rows = await query(
    `SELECT * FROM mailing_list_sends ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
  );
  return {
    rows: rows.map((r) => ({
      id: Number(r.id),
      subject: r.subject,
      attempted: Number(r.recipients_attempted),
      sent: Number(r.recipients_sent),
      failed: Number(r.recipients_failed),
      skipped: Number(r.recipients_skipped),
      created_by: r.created_by != null ? Number(r.created_by) : null,
      created_at: r.created_at,
    })),
    total: Number(totalRows[0].c),
    page,
    pageSize,
  };
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  cleanName,
  addSubscriber,
  importSubscribers,
  parseImportLine,
  listSubscribers,
  getSubscriberById,
  getSubscriberByEmail,
  setSubscriberStatus,
  removeSubscriber,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
  applyUnsubscribe,
  substitute,
  htmlToText,
  cleanSubject,
  cleanBody,
  renderNewsletter,
  previewNewsletter,
  sendNewsletter,
  listSends,
  eligibleRecipients,
  _previewTokens: previewTokens,
};
