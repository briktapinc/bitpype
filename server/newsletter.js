'use strict';

/**
 * Batch 118 — Client Newsletter module (per-site, portal-owned).
 *
 * Ely's build order (2026-11-02): Batch 71 gave BitPype its OWN staff
 * mailing list (server/mailingList.js, platform-level). This module is
 * the client-facing counterpart: every portal site owner gets a
 * newsletter on THEIR site — a signup block on the public site, a
 * subscriber list in their portal, and preview-gated sends — with the
 * From identity customizable per site (Ely's explicit addition).
 *
 * What is deliberately reused from Batch 71 (same discipline, new
 * scope): subject/body cleaning (no scripts), {{name}} / {{email}} /
 * {{unsubscribe_url}} placeholders, HMAC unsubscribe tokens in the
 * outreach interest-link family, the preview-before-send hard gate
 * (token + content hash + exact confirmCount), per-recipient failure
 * isolation, a send-history row for every send, and the rule that an
 * unsubscribed address is NEVER silently re-subscribed — only the
 * owner's explicit portal action flips one back.
 *
 * What is different, by design:
 *   - Everything is scoped per workspace + lead: subscribers, sends
 *     and configs live in the WORKSPACE database (newsletter_* tables,
 *     created by siteModules.ensureTables via ensureTables below),
 *     never at platform level, and an unsubscribe token names its
 *     workspace + lead + subscriber — a token minted for one client
 *     cannot act on another's list.
 *   - Signups also land in LeadScout as deduped portal contacts
 *     (portalContacts.captureFromNewsletter), like every other capture
 *     kind.
 *   - Sending rides server/mailer.sendPlatformMail (the Batch 48
 *     provider layer; Mailjet by default per Ely's standing mail
 *     preference) extended with a per-message From / Reply-To.
 *
 * From honesty (the core of Ely's ask): the owner sets a From NAME
 * (always honoured) and a From EMAIL. Before any send the effective
 * From is resolved against what the platform's sending account can
 * actually send as (resolveFrom):
 *   - no custom email        → the platform default sender;
 *   - custom email whose sending is authenticated for the platform
 *     account (Mailjet: an Active sender entry covers the address —
 *     src/mailjetSender.senderIsAuthenticated; other providers: the
 *     address sits on the platform sender's own domain, the only
 *     domain the configured account is known to send as)
 *                            → mail goes out From the owner's address;
 *   - anything else          → mail goes out From the platform default
 *     WITH the owner's address as Reply-To, and the portal shows that
 *     state in plain words. The send NEVER silently pretends.
 * The resolved identity is part of the preview hash: change the From
 * settings after previewing and the send gate demands a fresh preview.
 */

const crypto = require('crypto');
// domain is required LAZILY (the codebase convention — domain.js does
// the same for outreach): domain registers process-level hooks at
// module load, and a top-level require here would fire them in any
// process that merely opens a workspace DB (siteModules.ensureTables
// lazy-loads this module), which breaks load-order invariants other
// suites pin.
const domain = () => require('./domain');
const ml = require('./mailingList');

const MAX_SEND_RECIPIENTS = 5000; // mirrors Batch 71's import cap discipline
const PREVIEW_TTL_MS = 3600000;

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
function validation(message) {
  return coded('VALIDATION', message);
}
function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/* Tables (workspace DB — created from siteModules.ensureTables)       */
/* ------------------------------------------------------------------ */

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS newsletter_configs (
      lead_id INTEGER PRIMARY KEY,
      heading TEXT NOT NULL DEFAULT '',
      blurb TEXT NOT NULL DEFAULT '',
      button_label TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      from_email TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'embed',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      unsubscribed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_sub_email
      ON newsletter_subscribers(lead_id, email);
    CREATE INDEX IF NOT EXISTS idx_newsletter_sub_lead
      ON newsletter_subscribers(lead_id, status, id);
    CREATE TABLE IF NOT EXISTS newsletter_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      recipient_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      from_email TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      reply_to TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_newsletter_sends_lead
      ON newsletter_sends(lead_id, id DESC);
  `);
}

/* ------------------------------------------------------------------ */
/* Config (signup block copy + From identity)                          */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  heading: 'Join our newsletter',
  blurb: 'Occasional updates, offers and news — straight to your inbox. No spam, ever.',
  button_label: 'Subscribe',
  from_name: '',
  from_email: '',
};

function getConfig(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM newsletter_configs WHERE lead_id = ?').get(Number(leadId));
  if (!row) return { lead_id: Number(leadId), ...DEFAULT_CONFIG };
  return {
    lead_id: Number(leadId),
    heading: row.heading || DEFAULT_CONFIG.heading,
    blurb: row.blurb != null && row.blurb !== '' ? row.blurb : DEFAULT_CONFIG.blurb,
    button_label: row.button_label || DEFAULT_CONFIG.button_label,
    from_name: row.from_name || '',
    from_email: row.from_email || '',
    updated_at: row.updated_at || null,
  };
}

/** The public signup block only ever sees the block copy — never the
 *  From settings. */
function publicConfig(db, leadId) {
  const cfg = getConfig(db, leadId);
  return { heading: cfg.heading, blurb: cfg.blurb, button_label: cfg.button_label };
}

function saveConfig(db, leadId, patch = {}) {
  ensureTables(db);
  const cur = getConfig(db, leadId);
  const next = {
    heading: patch.heading != null ? cleanText(patch.heading, 120) : cur.heading,
    blurb: patch.blurb != null ? String(patch.blurb).trim().slice(0, 400) : cur.blurb,
    button_label: patch.button_label != null ? cleanText(patch.button_label, 40) : cur.button_label,
    from_name: patch.from_name != null ? cleanText(patch.from_name, 80) : cur.from_name,
    from_email: patch.from_email != null ? ml.normalizeEmail(patch.from_email) : cur.from_email,
  };
  if (next.from_email && !ml.isValidEmail(next.from_email)) {
    throw validation('The From email address is not a valid email address');
  }
  db.prepare(
    `INSERT INTO newsletter_configs (lead_id, heading, blurb, button_label, from_name, from_email, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET heading = excluded.heading, blurb = excluded.blurb,
       button_label = excluded.button_label, from_name = excluded.from_name,
       from_email = excluded.from_email, updated_at = datetime('now')`
  ).run(Number(leadId), next.heading, next.blurb, next.button_label, next.from_name, next.from_email);
  return getConfig(db, leadId);
}

/* ------------------------------------------------------------------ */
/* Subscribers                                                         */
/* ------------------------------------------------------------------ */

function publicSubscriber(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email || '',
    name: row.name || '',
    source: row.source || 'embed',
    status: row.status || 'active',
    created_at: row.created_at || null,
    unsubscribed_at: row.unsubscribed_at || null,
  };
}

function getSubscriberById(db, leadId, id) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM newsletter_subscribers WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  return row ? publicSubscriber(row) : null;
}

function getSubscriberByEmail(db, leadId, email) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM newsletter_subscribers WHERE lead_id = ? AND email = ?')
    .get(Number(leadId), ml.normalizeEmail(email));
  return row ? publicSubscriber(row) : null;
}

/**
 * Batch 71 discipline, per lead: a duplicate signup by an ACTIVE
 * subscriber is a no-op success; a signup by an UNSUBSCRIBED address
 * does NOT flip it back — it is reported as blocked and only the
 * owner's explicit portal re-subscribe restores it.
 */
function addSubscriber(db, leadId, input = {}) {
  ensureTables(db);
  const email = ml.normalizeEmail(input.email);
  if (!ml.isValidEmail(email)) throw validation('A valid email address is required');
  const name = ml.cleanName(input.name);
  const source = input.source === 'portal' ? 'portal' : 'embed';
  const existing = getSubscriberByEmail(db, leadId, email);
  if (existing) {
    if (existing.status === 'unsubscribed') {
      return { added: false, blocked: true, subscriber: existing };
    }
    return { added: false, duplicate: true, subscriber: existing };
  }
  const info = db
    .prepare(
      `INSERT INTO newsletter_subscribers (lead_id, email, name, source, status)
       VALUES (?, ?, ?, ?, 'active')`
    )
    .run(Number(leadId), email, name, source);
  return { added: true, subscriber: getSubscriberById(db, leadId, Number(info.lastInsertRowid)) };
}

function listSubscribers(db, leadId, opts = {}) {
  ensureTables(db);
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const status = opts.status === 'active' || opts.status === 'unsubscribed' ? opts.status : null;
  const rows = status
    ? db
        .prepare(
          'SELECT * FROM newsletter_subscribers WHERE lead_id = ? AND status = ? ORDER BY id DESC LIMIT ? OFFSET ?'
        )
        .all(Number(leadId), status, limit, offset)
    : db
        .prepare('SELECT * FROM newsletter_subscribers WHERE lead_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(Number(leadId), limit, offset);
  return rows.map(publicSubscriber);
}

function countSubscribers(db, leadId) {
  ensureTables(db);
  const rows = db
    .prepare('SELECT status, COUNT(*) AS c FROM newsletter_subscribers WHERE lead_id = ? GROUP BY status')
    .all(Number(leadId));
  let active = 0;
  let unsubscribed = 0;
  for (const r of rows) {
    if (r.status === 'active') active = Number(r.c);
    else if (r.status === 'unsubscribed') unsubscribed = Number(r.c);
  }
  return { active, unsubscribed, total: active + unsubscribed };
}

/** Owner-only explicit status flip (the ONLY way back from
 *  unsubscribed) + hard remove, mirroring Batch 71's admin actions. */
function setSubscriberStatus(db, leadId, id, status) {
  ensureTables(db);
  if (status !== 'active' && status !== 'unsubscribed') throw validation('Unknown subscriber status');
  const row = getSubscriberById(db, leadId, id);
  if (!row) throw coded('NOT_FOUND', 'Subscriber not found');
  db.prepare(
    `UPDATE newsletter_subscribers
     SET status = ?, updated_at = datetime('now'),
         unsubscribed_at = CASE WHEN ? = 'unsubscribed' THEN datetime('now') ELSE NULL END
     WHERE lead_id = ? AND id = ?`
  ).run(status, status, Number(leadId), row.id);
  return getSubscriberById(db, leadId, row.id);
}

function removeSubscriber(db, leadId, id) {
  ensureTables(db);
  const row = getSubscriberById(db, leadId, id);
  if (!row) throw coded('NOT_FOUND', 'Subscriber not found');
  db.prepare('DELETE FROM newsletter_subscribers WHERE lead_id = ? AND id = ?').run(Number(leadId), row.id);
  return { removed: true, email: row.email };
}

function eligibleRecipients(db, leadId) {
  ensureTables(db);
  return db
    .prepare("SELECT * FROM newsletter_subscribers WHERE lead_id = ? AND status = 'active' ORDER BY id ASC")
    .all(Number(leadId))
    .map(publicSubscriber);
}

function listSends(db, leadId, opts = {}) {
  ensureTables(db);
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 20));
  return db
    .prepare('SELECT * FROM newsletter_sends WHERE lead_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(leadId), limit)
    .map((r) => ({
      id: Number(r.id),
      subject: r.subject || '',
      recipient_count: Number(r.recipient_count) || 0,
      sent_count: Number(r.sent_count) || 0,
      failed_count: Number(r.failed_count) || 0,
      from_email: r.from_email || '',
      from_name: r.from_name || '',
      reply_to: r.reply_to || '',
      created_by: r.created_by || '',
      created_at: r.created_at || null,
    }));
}

/* ------------------------------------------------------------------ */
/* Unsubscribe tokens — HMAC family shared with outreach interest      */
/* links, but the payload names workspace + lead + subscriber, so a    */
/* token minted for one client can never act on another's list.        */
/* ------------------------------------------------------------------ */

function signUnsubscribeToken(workspaceId, leadId, subscriberId) {
  const outreach = require('../src/outreach');
  const w = Number(workspaceId);
  const l = Number(leadId);
  const s = Number(subscriberId);
  if (![w, l, s].every((v) => Number.isInteger(v) && v > 0)) {
    throw validation('Workspace, lead and subscriber ids are required to sign an unsubscribe link');
  }
  const body = Buffer.from(JSON.stringify({ w, l, s, a: 'nl-unsub', v: 1 })).toString('base64url');
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
  const w = Number(payload.w);
  const l = Number(payload.l);
  const s = Number(payload.s);
  if (payload.a !== 'nl-unsub' || ![w, l, s].every((v) => Number.isInteger(v) && v > 0)) {
    throw coded('INVALID_TOKEN', 'Invalid unsubscribe link');
  }
  return { workspaceId: w, leadId: l, subscriberId: s };
}

function unsubscribeUrl(workspaceId, leadId, subscriberId) {
  const base = require('./stripeClient').appUrl();
  return `${base}/api/v1/newsletter/unsubscribe/${encodeURIComponent(
    signUnsubscribeToken(workspaceId, leadId, subscriberId)
  )}`;
}

/** Public-link handler logic: verify, scope-check, flip. Never throws.
 *  The subscriber lookup is scoped to the token's own lead, so a
 *  foreign subscriber id inside an otherwise valid token matches
 *  nothing and changes nothing. */
async function applyUnsubscribe(token) {
  let parsed;
  try {
    parsed = verifyUnsubscribeToken(token);
  } catch (e) {
    return { ok: false, code: e.code || 'INVALID_TOKEN', message: e.message };
  }
  const platformDb = require('./db');
  const ws = await platformDb.query('SELECT id FROM workspaces WHERE id = :id', { id: parsed.workspaceId });
  if (!ws.length) return { ok: false, code: 'NOT_FOUND', message: 'This subscription was not found.' };
  return domain().withDb(parsed.workspaceId, (db) => {
    const row = getSubscriberById(db, parsed.leadId, parsed.subscriberId);
    if (!row) return { ok: false, code: 'NOT_FOUND', message: 'This subscription was not found.' };
    const lead = db.prepare('SELECT business_name FROM leads WHERE id = ?').get(parsed.leadId);
    const businessName = (lead && lead.business_name) || '';
    if (row.status === 'unsubscribed') return { ok: true, already: true, email: row.email, businessName };
    setSubscriberStatus(db, parsed.leadId, row.id, 'unsubscribed');
    return { ok: true, already: false, email: row.email, businessName };
  });
}

/* ------------------------------------------------------------------ */
/* Public signup (site embed)                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve the public embed token and record a signup. The response is
 * deliberately state-blind (created / duplicate / blocked-unsubscribed
 * all read the same) so the public endpoint cannot be used to probe
 * who is on a client's list. Only a genuinely NEW subscriber is
 * captured into LeadScout.
 */
function subscribeByToken(db, token, input = {}) {
  ensureTables(db);
  // Same public-surface gate as every other module flow (the payload
  // query and membersEmbedByToken): the block must be live on the
  // site (published) before it can collect signups.
  const embed = db
    .prepare('SELECT * FROM site_module_embeds WHERE public_token = ? AND published = 1')
    .get(String(token || ''));
  if (!embed || embed.module_type !== 'newsletter') throw coded('NOT_FOUND', 'Newsletter not found');
  const leadId = Number(embed.lead_id);
  let site = null;
  try {
    site = db.prepare('SELECT archived_at FROM websites WHERE lead_id = ?').get(leadId);
  } catch {
    site = null; // minimal db without a websites table — nothing to gate on
  }
  if (site && site.archived_at) throw coded('SITE_ARCHIVED', 'This site is no longer available');
  const email = ml.normalizeEmail(input.email);
  if (!ml.isValidEmail(email)) throw validation('Please enter a valid email address');
  const result = addSubscriber(db, leadId, { email, name: input.name, source: 'embed' });
  if (result.added) {
    try {
      require('./portalContacts').captureFromNewsletter(db, {
        leadId,
        subscriber: result.subscriber,
      });
    } catch (e) {
      console.warn('[newsletter] LeadScout capture failed:', e && e.message);
    }
  }
  // `added`/`subscriberId` are for the route layer (owner notify) —
  // the public response built from this stays state-blind.
  return {
    ok: true,
    message: 'Thanks — your signup was received.',
    added: !!result.added,
    subscriberId: result.subscriber ? result.subscriber.id : null,
    leadId,
  };
}

/* ------------------------------------------------------------------ */
/* Effective From resolution                                           */
/* ------------------------------------------------------------------ */

function emailDomain(email) {
  const s = String(email || '')
    .trim()
    .toLowerCase();
  const at = s.lastIndexOf('@');
  return at > 0 ? s.slice(at + 1) : '';
}

/**
 * Decide the From an issue will actually use. See the header comment
 * for the three states. `deps.senderIsAuthenticated` is injectable for
 * tests; production uses the Mailjet sender list when the platform
 * sends through Mailjet, and the platform-sender-domain rule for the
 * other providers.
 */
async function resolveFrom(workspaceId, leadId, deps = {}) {
  const mailer = require('./mailer');
  const settings = deps.settings || (await mailer.platformSmtpSettings());
  const defaultEmail = ml.normalizeEmail(settings['smtp.from_email']);
  const defaultName = String(settings['smtp.from_name'] || '').trim();
  const cfg = deps.config || domain().withDb(workspaceId, (db) => getConfig(db, leadId));
  const fromName = cfg.from_name || defaultName;
  const custom = cfg.from_email;
  if (!custom) {
    return {
      state: 'default',
      fromEmail: defaultEmail,
      fromName,
      replyTo: '',
      customEmail: '',
      note: 'Issues send from the BitPype platform address. Set your own From email below to use your business address instead.',
    };
  }
  let authenticated = false;
  const check =
    deps.senderIsAuthenticated ||
    (async (email) => {
      const provider = String(settings['mail.provider'] || '')
        .trim()
        .toLowerCase();
      const host = String(settings['smtp.host'] || '').toLowerCase();
      if (provider !== 'cloudflare' && host.includes('mailjet.com')) {
        return require('../src/mailjetSender').senderIsAuthenticated(settings, email);
      }
      // Cloudflare / plain SMTP: the configured account is only known
      // to send as its own domain, so an address on that domain is the
      // authenticated case; anything else cannot be claimed.
      return !!defaultEmail && emailDomain(email) === emailDomain(defaultEmail);
    });
  try {
    authenticated = !!(await check(custom));
  } catch {
    authenticated = false;
  }
  if (authenticated) {
    return {
      state: 'custom',
      fromEmail: custom,
      fromName,
      replyTo: '',
      customEmail: custom,
      note: 'Your From address is verified for sending — issues go out from your address.',
    };
  }
  return {
    state: 'fallback',
    fromEmail: defaultEmail,
    fromName,
    replyTo: custom,
    customEmail: custom,
    note: "Your domain isn't verified for sending yet, so issues send from BitPype's address with replies going to yours.",
  };
}

/** Stable signature of everything a send depends on besides the
 *  subject/body: the resolved From identity. Part of the preview hash
 *  so a From-settings change after preview forces a fresh preview. */
function fromSignature(fromState) {
  return [fromState.state, fromState.fromEmail, fromState.fromName, fromState.replyTo].join('|');
}

/* ------------------------------------------------------------------ */
/* Issue rendering                                                     */
/* ------------------------------------------------------------------ */

function renderIssue(input, subscriber, businessName, unsub) {
  const subject = ml.substitute(ml.cleanSubject(input.subject), subscriber, '');
  const subjectFinal = ml.substitute(subject, subscriber, unsub);
  const bodyHtml = ml.substitute(ml.cleanBody(input.bodyHtml), subscriber, unsub);
  const biz = esc(businessName || 'us');
  const footerHtml =
    `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0" />` +
    `<p style="font-size:12px;color:#777">You are receiving this because you subscribed to the ${biz} newsletter. ` +
    `<a href="${unsub}">Unsubscribe</a></p>`;
  const html = bodyHtml + footerHtml;
  const text = `${ml.htmlToText(bodyHtml)}\n\n—\nYou are receiving this because you subscribed to the ${
    businessName || 'us'
  } newsletter. Unsubscribe: ${unsub}`;
  return { to: subscriber.email, subject: subjectFinal, html, text };
}

function leadBusinessName(db, leadId) {
  const lead = db.prepare('SELECT business_name FROM leads WHERE id = ?').get(Number(leadId));
  return (lead && lead.business_name) || '';
}

/* ------------------------------------------------------------------ */
/* Preview gate + send (portal)                                        */
/* ------------------------------------------------------------------ */

const previewTokens = new Map();

function previewHash(subject, bodyHtml, fromState) {
  return crypto
    .createHash('sha256')
    .update(`${subject}\n${bodyHtml}\n${fromSignature(fromState)}`)
    .digest('hex');
}

/**
 * Preview renders a sample issue (first active subscriber, else a
 * clearly-labelled sample), exactly like Batch 71 — a render preview,
 * no email is sent — and mints the token the send gate demands. The
 * preview also pins the effective From it showed, so the portal can
 * display the exact From the send will use.
 */
async function previewIssue(workspaceId, leadId, input = {}, deps = {}) {
  const subject = ml.cleanSubject(input.subject);
  const bodyHtml = ml.cleanBody(input.bodyHtml);
  const fromState = await resolveFrom(workspaceId, leadId, deps);
  const { sample, recipients, businessName } = domain().withDb(workspaceId, (db) => {
    const eligible = eligibleRecipients(db, leadId);
    return {
      sample: eligible[0] || null,
      recipients: eligible.length,
      businessName: leadBusinessName(db, leadId),
    };
  });
  const shown = sample || {
    id: 0,
    email: 'you@example.com',
    name: 'Sample Subscriber',
    status: 'active',
    source: 'embed',
  };
  // A sample with no real subscriber cannot carry a real unsubscribe
  // link; render it with an inert placeholder href instead (Batch 71).
  const unsub = sample ? unsubscribeUrl(workspaceId, leadId, sample.id) : '#unsubscribe-preview';
  const rendered = renderIssue({ subject, bodyHtml }, shown, businessName, unsub);
  const token = crypto.randomBytes(16).toString('hex');
  previewTokens.set(token, {
    key: `${Number(workspaceId)}:${Number(leadId)}`,
    hash: previewHash(subject, bodyHtml, fromState),
    at: Date.now(),
  });
  for (const [k, v] of previewTokens) if (Date.now() - v.at > PREVIEW_TTL_MS) previewTokens.delete(k);
  return {
    previewToken: token,
    rendered: { subject: rendered.subject, html: rendered.html, text: rendered.text },
    sampleSubscriber: { email: shown.email, name: shown.name, real: !!sample },
    recipientCount: recipients,
    from: fromState,
  };
}

function assertPreviewed(workspaceId, leadId, input, fromState) {
  const token = String(input.previewToken || '');
  const rec = token && previewTokens.get(token);
  const hash = previewHash(ml.cleanSubject(input.subject), ml.cleanBody(input.bodyHtml), fromState);
  if (!rec || rec.key !== `${Number(workspaceId)}:${Number(leadId)}` || rec.hash !== hash) {
    throw coded(
      'PREVIEW_REQUIRED',
      'Preview this exact newsletter before sending — the subject, body or From settings changed since the last preview.'
    );
  }
  return token;
}

function consumePreview(token) {
  if (token) previewTokens.delete(token);
}

/**
 * Send one issue to the lead's ACTIVE subscribers. confirmCount must
 * equal the eligible count at send time. One recipient's failure never
 * aborts the rest; every send (even a zero-send outcome) lands in
 * newsletter_sends with honest totals and the effective From used.
 */
async function sendIssue(workspaceId, leadId, input = {}, deps = {}) {
  const subject = ml.cleanSubject(input.subject);
  const bodyHtml = ml.cleanBody(input.bodyHtml);
  const fromState = await resolveFrom(workspaceId, leadId, deps);
  const previewToken = assertPreviewed(workspaceId, leadId, { ...input, subject, bodyHtml }, fromState);
  const snapshot = domain().withDb(workspaceId, (db) => ({
    eligible: eligibleRecipients(db, leadId),
    businessName: leadBusinessName(db, leadId),
  }));
  const eligible = snapshot.eligible;
  if (eligible.length > MAX_SEND_RECIPIENTS) {
    throw coded(
      'VALIDATION',
      `This list has ${eligible.length} active subscribers; one issue can go to at most ${MAX_SEND_RECIPIENTS}. Split the list before sending.`
    );
  }
  const confirmCount = Number(input.confirmCount);
  if (!Number.isInteger(confirmCount) || confirmCount !== eligible.length) {
    throw coded(
      'CONFIRM_MISMATCH',
      `Confirm the exact recipient count to send: ${eligible.length} active subscriber(s) will be emailed.`
    );
  }
  // The preview token is consumed only once the send actually
  // proceeds — a mistyped confirm count must not burn the preview.
  consumePreview(previewToken);
  const sendMail = deps.sendMail || (async (m) => require('./mailer').sendPlatformMail(m));
  let sent = 0;
  let failed = 0;
  let firstError = '';
  for (const row of eligible) {
    try {
      const mail = renderIssue(
        { subject, bodyHtml },
        row,
        snapshot.businessName,
        unsubscribeUrl(workspaceId, leadId, row.id)
      );
      await sendMail({
        ...mail,
        from: { email: fromState.fromEmail, name: fromState.fromName },
        ...(fromState.replyTo ? { replyTo: fromState.replyTo } : {}),
      });
      sent++;
    } catch (e) {
      failed++;
      if (!firstError) firstError = e.message || String(e);
    }
  }
  const record = domain().withDb(workspaceId, (db) => {
    ensureTables(db);
    const info = db
      .prepare(
        `INSERT INTO newsletter_sends
           (lead_id, subject, recipient_count, sent_count, failed_count, from_email, from_name, reply_to, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        Number(leadId),
        subject,
        eligible.length,
        sent,
        failed,
        fromState.fromEmail,
        fromState.fromName,
        fromState.replyTo || '',
        String(input.createdBy || '').slice(0, 160)
      );
    return listSends(db, leadId, { limit: 1 })[0] || { id: Number(info.lastInsertRowid) };
  });
  return {
    ok: failed === 0,
    partial: failed > 0 && sent > 0,
    send: record,
    recipients: eligible.length,
    sent,
    failed,
    ...(firstError ? { firstError } : {}),
    from: fromState,
  };
}

/* ------------------------------------------------------------------ */
/* Portal panel aggregate                                              */
/* ------------------------------------------------------------------ */

/** Everything the portal Newsletter pane needs in one read. */
async function panelData(workspaceId, leadId, deps = {}) {
  const fromState = await resolveFrom(workspaceId, leadId, deps);
  return domain().withDb(workspaceId, (db) => ({
    config: getConfig(db, leadId),
    counts: countSubscribers(db, leadId),
    from: fromState,
    sends: listSends(db, leadId, { limit: 20 }),
    businessName: leadBusinessName(db, leadId),
  }));
}

module.exports = {
  MAX_SEND_RECIPIENTS,
  ensureTables,
  getConfig,
  publicConfig,
  saveConfig,
  addSubscriber,
  getSubscriberById,
  getSubscriberByEmail,
  listSubscribers,
  countSubscribers,
  setSubscriberStatus,
  removeSubscriber,
  eligibleRecipients,
  listSends,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
  applyUnsubscribe,
  subscribeByToken,
  resolveFrom,
  renderIssue,
  previewIssue,
  sendIssue,
  panelData,
  _previewTokens: previewTokens,
};
