'use strict';
/**
 * email.js — mail provider abstraction for Website Scout (single-user desktop app).
 *
 * Providers:
 *   - SmtpProvider : minimal SMTP client over node:net / node:tls
 *                    (EHLO, STARTTLS, AUTH LOGIN, MAIL FROM, RCPT TO, DATA).
 *                    No third-party mail dependencies. Batch 55: TLS is
 *                    REQUIRED by default (smtp.require_tls) — credentials
 *                    are never sent over an unencrypted connection unless
 *                    the admin explicitly opts out.
 *   - StubProvider  : used when smtp.host is empty. Logs to activity_log and
 *                    reports the message as "sent" without touching the network.
 *
 * Also: personalize() — template variable substitution restricted to verified
 * business facts and lead columns. Unknown variables become an empty string;
 * facts are NEVER invented.
 *
 * No secrets live in this file. Credentials come from the settings store.
 */

const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const crypto = require('node:crypto');
const { ensureBrandedEmail, stripHtml: stripHtmlBranded } = require('./emailTemplate');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CONNECT_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 30000;

/** True when value is a syntactically plausible email address. */
function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

/**
 * Pull the smtp.* / mail.* settings out of a flat settings object
 * (keys like 'smtp.host', 'smtp.port', ...).
 */
function readSmtpConfig(settings) {
  const get = (k, dflt = '') => {
    const v = settings && settings[k];
    return v === undefined || v === null ? dflt : String(v).trim();
  };
  const portRaw = get('smtp.port', '');
  const secureRaw = get('smtp.secure', '').toLowerCase();
  const secure = secureRaw === '1' || secureRaw === 'true' || secureRaw === 'yes';
  // Batch 55 (review C-2): require-TLS is the DEFAULT posture. Only an
  // explicit opt-out value ('0'/'false'/'no'/'off') restores the legacy
  // opportunistic behaviour; an unset key — every workspace predating
  // this batch — means require TLS.
  const requireTlsRaw = get('smtp.require_tls', '').toLowerCase();
  const requireTls = !['0', 'false', 'no', 'off'].includes(requireTlsRaw);
  return {
    host: get('smtp.host'),
    port: portRaw ? parseInt(portRaw, 10) : secure ? 465 : 587,
    secure,
    requireTls,
    user: get('smtp.user'),
    pass: get('smtp.pass'),
    fromName: get('smtp.from_name'),
    fromEmail: get('smtp.from_email'),
  };
}

/** Returns an array of human-readable config problems (empty = OK). */
function validateSmtpConfig(cfg) {
  const errors = [];
  if (!cfg.host) errors.push('smtp.host is empty');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    errors.push('smtp.port must be 1-65535');
  }
  if (!isValidEmail(cfg.fromEmail)) errors.push('smtp.from_email is not a valid email address');
  if (cfg.user && !cfg.pass) errors.push('smtp.user is set but smtp.pass is empty');
  return errors;
}

/**
 * Batch 48 — selectable mail provider. `mail.provider` is 'custom' (the
 * default; today's SMTP behaviour, byte-identical) or 'cloudflare'
 * (Cloudflare Email Sending REST API). Anything other than the exact
 * value 'cloudflare' means custom, so an unset key — every workspace
 * predating this batch — keeps today's behaviour.
 *
 * The from identity stays shared with SMTP (smtp.from_email/from_name).
 * The Cloudflare account id prefers the dedicated mail.cf_account_id
 * and falls back to the workspace's Cloudflare-settings account id
 * (cf.account_id), mirroring how the token lives in its own key while
 * the account is a property of the Cloudflare connection.
 */
function readMailConfig(settings) {
  const s = settings || {};
  const provider =
    String(s['mail.provider'] || '').trim().toLowerCase() === 'cloudflare' ? 'cloudflare' : 'custom';
  return {
    provider,
    cfToken: String(s['mail.cf_token'] || '').trim(),
    cfAccountId:
      String(s['mail.cf_account_id'] || '').trim() || String(s['cf.account_id'] || '').trim(),
  };
}

/**
 * Field-specific validation for the SELECTED provider.
 * - cloudflare: token + account id + a valid shared from address are
 *   required. Errors name the settings fields so the admin UI (and any
 *   caller) can point at exactly what is missing. Native selected but
 *   unconfigured is a hard error — never a silent fallback.
 * - custom: today's SMTP validation, except that an empty smtp.host is
 *   the legitimate fully-unconfigured state (the stub provider), not an
 *   error — so the host error is dropped in that case only.
 */
function validateMailSettings(settings) {
  const mail = readMailConfig(settings);
  if (mail.provider === 'cloudflare') {
    const errors = [];
    if (!mail.cfToken) errors.push('mail.cf_token is empty');
    if (!mail.cfAccountId) errors.push('mail.cf_account_id / cf.account_id is empty');
    const smtpCfg = readSmtpConfig(settings);
    if (!isValidEmail(smtpCfg.fromEmail)) {
      errors.push('smtp.from_email is not a valid email address');
    }
    return errors;
  }
  const smtpCfg = readSmtpConfig(settings);
  if (!smtpCfg.host) return [];
  const errors = validateSmtpConfig(smtpCfg);
  // Batch 55 (review B-1 companion): a host with NO username at all is
  // the half-configured state the old Mailjet seed produced — the
  // provider would open a real connection that can only fail. Name it
  // here so the settings surface can warn before a send is attempted.
  // (User set + pass empty is already covered by validateSmtpConfig.)
  if (!smtpCfg.user) {
    errors.push('smtp.host is set but smtp.user/smtp.pass are empty — mail will fail: credentials missing');
  }
  return errors;
}

/** Build a multipart/alternative MIME message. Handles dot-stuffing. */
function buildMime({ fromName, fromEmail, to, subject, html, text, replyTo }) {
  const boundary = 'ws_' + crypto.randomBytes(12).toString('hex');
  const date = new Date().toUTCString();
  const msgId = `<${crypto.randomBytes(16).toString('hex')}@${fromEmail.split('@')[1] || 'localhost'}>`;
  const from = fromName ? `"${fromName.replace(/["\\]/g, '')}" <${fromEmail}>` : fromEmail;
  const plain = text && text.trim() ? text : stripHtml(html || '');
  const htmlPart = html && html.trim() ? html : `<pre>${escapeHtml(plain)}</pre>`;

  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    ...(replyTo ? [`Reply-To: ${String(replyTo).replace(/[\r\n]+/g, ' ').trim()}`] : []),
    `Subject: ${encodeSubject(subject || '')}`,
    `Date: ${date}`,
    `Message-ID: ${msgId}`,
    // One-click / mailto unsubscribe helps inbox placement for bulk-ish mail.
    `List-Unsubscribe: <mailto:${fromEmail}?subject=unsubscribe>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    plain,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    htmlPart,
    '',
    `--${boundary}--`,
    '',
  ];
  // SMTP dot-stuffing: lines starting with '.' get an extra dot.
  return lines.join('\r\n').replace(/^\./gm, '..');
}

function encodeSubject(s) {
  // RFC 2047 for non-ASCII subjects.
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

function stripHtml(html) {
  return stripHtmlBranded(html);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Minimal line-oriented SMTP conversation driver. */
class SmtpClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.socket = null;
    this.buffer = '';
    this.pending = null; // {resolve, reject, timer}
    this.encrypted = false; // true once the wire is TLS (implicit or STARTTLS)
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this._onLine(line);
    }
  }

  _onLine(line) {
    if (!this.pending) return; // unsolicited greeting handled by initial read
    this.pending.lines.push(line);
    const m = /^(\d{3})([ -])/.exec(line);
    if (!m) return;
    if (m[2] === ' ') {
      const { resolve, timer } = this.pending;
      const lines = this.pending.lines;
      this.pending = null;
      clearTimeout(timer);
      resolve({ code: parseInt(m[1], 10), lines });
    }
  }

  _readResponse(timeoutMs = COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('SMTP response timeout'));
      }, timeoutMs);
      this.pending = { resolve, reject, timer, lines: [] };
      if (this.buffer.includes('\r\n')) this._onData(''); // drain buffered lines
    });
  }

  async _command(cmd, expect) {
    const want = Array.isArray(expect) ? expect : [expect];
    const sendLine = cmd === null ? null : cmd + '\r\n';
    const respP = this._readResponse();
    if (sendLine) this.socket.write(sendLine, 'utf8');
    const resp = await respP;
    if (!want.includes(resp.code)) {
      throw new Error(`SMTP error: expected ${want.join('/')} but got ${resp.code} (${resp.lines.join(' | ')})`);
    }
    return resp;
  }

  async connect() {
    const { host, port, secure } = this.cfg;
    const socket = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SMTP connect timeout (${host}:${port})`)), CONNECT_TIMEOUT_MS);
      const s = (secure ? tls : net).connect({ host, port, servername: host }, () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    this.socket = socket;
    this.encrypted = !!secure; // implicit TLS (port 465 style) is encrypted from byte one
    socket.setTimeout(COMMAND_TIMEOUT_MS, () => socket.destroy(new Error('SMTP socket timeout')));
    socket.on('data', (c) => this._onData(c));
    socket.on('error', () => {
      if (this.pending) {
        const { reject, timer } = this.pending;
        this.pending = null;
        clearTimeout(timer);
        reject(new Error('SMTP socket error'));
      }
    });

    const greet = await this._readResponse();
    if (greet.code !== 220) throw new Error(`SMTP greeting failed: ${greet.lines.join(' | ')}`);

    const ehlo = await this._command(`EHLO ${host}`, 250);
    const extensions = ehlo.lines.join('\n').toUpperCase();

    if (!secure && extensions.includes('STARTTLS')) {
      await this._command('STARTTLS', 220);
      await new Promise((resolve, reject) => {
        const upgraded = tls.connect({ socket: this.socket, servername: host }, () => resolve(upgraded));
        upgraded.once('error', reject);
        this.socket.removeAllListeners('data');
        this.socket = upgraded;
        upgraded.setTimeout(COMMAND_TIMEOUT_MS, () => upgraded.destroy(new Error('SMTP socket timeout')));
        upgraded.on('data', (c) => this._onData(c));
      });
      this.encrypted = true;
      await this._command(`EHLO ${host}`, 250); // re-EHLO after TLS
    }

    // Batch 55 (review C-2): never let credentials cross an unencrypted
    // wire. Under the default require-TLS posture an unencrypted
    // connection (no implicit TLS, no STARTTLS on offer) fails the send
    // BEFORE AUTH with a coded error — the password is never written to
    // the socket. With smtp.require_tls explicitly off, the legacy
    // behaviour remains as a deliberate opt-out, but sending credentials
    // in plaintext logs a loud warning. B55_NEGATIVE=1 is a test-only
    // shim that restores the pre-fix fall-through so the regression
    // suite can prove this gate is what stops the leak.
    if (!this.encrypted && process.env.B55_NEGATIVE !== '1') {
      if (this.cfg.requireTls) {
        const err = new Error(
          'SMTP_TLS_REQUIRED: The mail server did not offer an encrypted connection, so no password was sent.'
        );
        err.code = 'SMTP_TLS_REQUIRED';
        throw err;
      }
      if (this.cfg.user) {
        try {
          console.warn(
            '[smtp] WARNING: sending SMTP credentials over an UNENCRYPTED connection (smtp.require_tls is off) — the password is readable on the wire.'
          );
        } catch {
          /* warning must never break a send */
        }
      }
    }

    const { user, pass } = this.cfg;
    if (user) {
      await this._command('AUTH LOGIN', 334);
      await this._command(Buffer.from(user, 'utf8').toString('base64'), 334);
      await this._command(Buffer.from(pass || '', 'utf8').toString('base64'), 235);
    }
  }

  async sendMail({ fromEmail, to, data }) {
    await this._command(`MAIL FROM:<${fromEmail}>`, 250);
    await this._command(`RCPT TO:<${to}>`, [250, 251]);
    await this._command('DATA', 354);
    const resp = await this._command(data + '\r\n.', 250);
    return resp.lines.join(' ');
  }

  async quit() {
    try {
      await this._command('QUIT', 221);
    } catch {
      /* best effort */
    }
    if (this.socket) this.socket.destroy();
    this.socket = null;
  }
}

/** Real SMTP provider. */
class SmtpProvider {
  constructor(cfg) {
    const errors = validateSmtpConfig(cfg);
    if (errors.length) throw new Error('Invalid SMTP config: ' + errors.join('; '));
    this.cfg = cfg;
    this.name = 'smtp';
  }

  async send({ to, subject, html, text, title, cta, ctaLabel, preheader, footerNote, skipBrand, fromEmail, fromName, replyTo }) {
    if (!isValidEmail(to)) throw new Error(`Invalid recipient email: ${to}`);
    let outHtml = html;
    let outText = text;
    if (!skipBrand) {
      const branded = ensureBrandedEmail({
        subject,
        title,
        html,
        text,
        cta,
        ctaLabel,
        preheader,
        footerNote,
      });
      outHtml = branded.html;
      outText = branded.text;
    }
    // Batch 118: a per-message From (client newsletter with an
    // authenticated sender domain) overrides the configured identity;
    // anything else keeps the configured From exactly as before.
    const effFromEmail = fromEmail && isValidEmail(String(fromEmail).trim()) ? String(fromEmail).trim() : this.cfg.fromEmail;
    const effFromName = fromEmail ? (fromName != null ? String(fromName) : this.cfg.fromName) : this.cfg.fromName;
    const data = buildMime({
      fromName: effFromName,
      fromEmail: effFromEmail,
      to: to.trim(),
      subject,
      html: outHtml,
      text: outText,
      replyTo: replyTo && isValidEmail(String(replyTo).trim()) ? String(replyTo).trim() : undefined,
    });
    const msgIdMatch = /Message-ID:\s*(<[^>]+>)/i.exec(data);
    const client = new SmtpClient(this.cfg);
    try {
      await client.connect();
      const response = await client.sendMail({ fromEmail: effFromEmail, to: to.trim(), data });
      return {
        ok: true,
        provider: 'smtp',
        response,
        messageId: msgIdMatch ? msgIdMatch[1] : undefined,
      };
    } finally {
      await client.quit();
    }
  }
}

/**
 * Batch 48 — Cloudflare Email Sending provider (native). Same send
 * interface and result shape as SmtpProvider, via the Cloudflare Email
 * Sending REST API:
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send
 *   Authorization: Bearer <API_TOKEN>  (token needs Email Sending: Edit;
 *   the sender domain must be onboarded for Email Sending)
 *   Body: { to, from, subject, html, text } — from may be a named
 *   address object { email, name }. Success envelope:
 *   { success: true, result: { delivered, permanent_bounces, queued } }.
 *   Failures use the standard Cloudflare envelope
 *   { success: false, errors: [{ code, message }] }.
 * Docs: https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
 *
 * Failures surface exactly like SMTP failures: send() throws with the
 * provider's message in the error — no silent swallow, no fake success.
 */
function cfEmailPost(accountId, token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'api.cloudflare.com',
        path: `/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            /* non-JSON body — handled by the caller as a failure */
          }
          resolve({ status: res.statusCode || 0, json, raw });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Cloudflare email request timed out')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

class CloudflareProvider {
  constructor(mailCfg, smtpCfg) {
    const errors = [];
    if (!mailCfg.cfToken) errors.push('mail.cf_token is empty');
    if (!mailCfg.cfAccountId) errors.push('mail.cf_account_id / cf.account_id is empty');
    if (!isValidEmail(smtpCfg.fromEmail)) {
      errors.push('smtp.from_email is not a valid email address');
    }
    if (errors.length) throw new Error('Invalid Cloudflare mail config: ' + errors.join('; '));
    this.mail = mailCfg;
    this.fromName = smtpCfg.fromName;
    this.fromEmail = smtpCfg.fromEmail;
    this.name = 'cloudflare';
  }

  async send({ to, subject, html, text, title, cta, ctaLabel, preheader, footerNote, skipBrand, fromEmail, fromName, replyTo }) {
    if (!isValidEmail(to)) throw new Error(`Invalid recipient email: ${to}`);
    let outHtml = html;
    let outText = text;
    if (!skipBrand) {
      const branded = ensureBrandedEmail({
        subject,
        title,
        html,
        text,
        cta,
        ctaLabel,
        preheader,
        footerNote,
      });
      outHtml = branded.html;
      outText = branded.text;
    }
    // Batch 118: per-message From override (see SmtpProvider).
    const effFromEmail = fromEmail && isValidEmail(String(fromEmail).trim()) ? String(fromEmail).trim() : this.fromEmail;
    const effFromName = fromEmail ? (fromName != null ? String(fromName) : this.fromName) : this.fromName;
    const effReplyTo = replyTo && isValidEmail(String(replyTo).trim()) ? String(replyTo).trim() : null;
    const recipient = to.trim();
    const body = {
      to: recipient,
      from: effFromName ? { email: effFromEmail, name: effFromName } : effFromEmail,
      ...(effReplyTo ? { reply_to: effReplyTo } : {}),
      subject,
      html: outHtml,
      text: outText,
      // Mirror the one-click unsubscribe headers the SMTP MIME carries.
      headers: {
        'List-Unsubscribe': `<mailto:${effFromEmail}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
    const { status, json, raw } = await cfEmailPost(this.mail.cfAccountId, this.mail.cfToken, body);
    if (status >= 400 || !json || json.success !== true) {
      const errs = json && Array.isArray(json.errors) ? json.errors : [];
      const detail = errs.length
        ? errs.map((e) => `${e.code} ${e.message}`).join('; ')
        : String(raw || '').slice(0, 200) || 'no response body';
      const err = new Error(`Cloudflare email send failed (HTTP ${status}): ${detail}`);
      err.code = 'CF_EMAIL_SEND_FAILED';
      err.cfErrors = errs;
      throw err;
    }
    const result = json.result || {};
    const bounced = Array.isArray(result.permanent_bounces) ? result.permanent_bounces : [];
    if (bounced.includes(recipient)) {
      const err = new Error(
        `Cloudflare email send failed: permanent bounce for ${recipient}`
      );
      err.code = 'CF_EMAIL_BOUNCED';
      throw err;
    }
    const delivered = Array.isArray(result.delivered) ? result.delivered : [];
    const queued = Array.isArray(result.queued) ? result.queued : [];
    return {
      ok: true,
      provider: 'cloudflare',
      messageId: result.message_id || 'cf-' + crypto.randomBytes(8).toString('hex'),
      response: `delivered: ${delivered.join(', ') || '-'}; queued: ${queued.join(', ') || '-'}`,
    };
  }
}

/** No-op provider for when SMTP is not configured. Records activity only. */
class StubProvider {
  constructor(db) {
    this.db = db || null;
    this.name = 'stub';
  }

  async send({ to, subject }) {
    const messageId = 'stub-' + crypto.randomBytes(8).toString('hex');
    if (this.db) {
      try {
        this.db
          .prepare(`INSERT INTO activity_log (area, message) VALUES ('outreach', ?)`)
          .run(`[stub] email to ${to} — "${subject || ''}" (SMTP not configured; marked sent)`);
      } catch {
        /* activity_log must never break a send */
      }
    }
    return { ok: true, provider: 'stub', messageId };
  }
}

/**
 * Choose a provider from flat settings.
 *
 * Batch 48: when `mail.provider` is 'cloudflare' the CloudflareProvider
 * is returned and its constructor throws a loud, field-specific config
 * error if the token/account/from are incomplete — Native explicitly
 * selected NEVER silently falls back to SMTP or the stub. Otherwise the
 * behaviour is exactly the pre-Batch-48 one: StubProvider when smtp.host
 * is empty so the rest of the pipeline keeps working in dev / tests,
 * else SmtpProvider. `db` is optional and only used by the stub for
 * activity logging.
 */
function getProvider(settings, db) {
  const mail = readMailConfig(settings || {});
  if (mail.provider === 'cloudflare') {
    return new CloudflareProvider(mail, readSmtpConfig(settings || {}));
  }
  const cfg = readSmtpConfig(settings || {});
  if (!cfg.host) return new StubProvider(db);
  return new SmtpProvider(cfg);
}

/* ------------------------------------------------------------------ */
/* Email HTML sanitizer (templates / outbound fragments)                 */
/* ------------------------------------------------------------------ */

const EMAIL_ALLOWED_TAGS = new Set([
  'a',
  'b',
  'strong',
  'i',
  'em',
  'u',
  'p',
  'br',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'div',
  'span',
  'img',
  'blockquote',
  'hr',
]);

/**
 * Strip unsafe markup from staff email templates before save/send.
 * Allows a small HTML subset suitable for multipart HTML mail.
 */
function sanitizeEmailHtml(html) {
  let s = String(html == null ? '' : html);
  if (s.length > 200000) s = s.slice(0, 200000);
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<\/?script\b[^>]*>/gi, '');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<\/?(iframe|object|embed|base|form|input|button|textarea|select|meta|link)[\s\S]*?>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (full, tag, attrs) => {
    const name = String(tag).toLowerCase();
    const closing = full.startsWith('</');
    if (!EMAIL_ALLOWED_TAGS.has(name)) return '';
    if (closing) return `</${name}>`;
    if (name === 'br' || name === 'hr') return `<${name}>`;
    if (name === 'img') {
      const srcM = /\bsrc\s*=\s*(['"])(https?:\/\/[^'"]+)\1/i.exec(attrs);
      if (!srcM) return '';
      const altM = /\balt\s*=\s*(['"])([^'"]*)\1/i.exec(attrs);
      const wM = /\bwidth\s*=\s*(['"]?)(\d+)\1/i.exec(attrs);
      const hM = /\bheight\s*=\s*(['"]?)(\d+)\1/i.exec(attrs);
      let out = `<img src="${srcM[2]}"`;
      if (altM) out += ` alt="${altM[2].replace(/"/g, '')}"`;
      if (wM) out += ` width="${wM[2]}"`;
      if (hM) out += ` height="${hM[2]}"`;
      out += ' style="max-width:100%;height:auto;">';
      return out;
    }
    if (name === 'a') {
      const hrefM = /\bhref\s*=\s*(['"])(https?:\/\/[^'"]+|mailto:[^'"]+|tel:[^'"]+)\1/i.exec(attrs);
      if (!hrefM) return '<a>';
      return `<a href="${hrefM[2]}" style="color:#0b5442;text-decoration:underline;">`;
    }
    return `<${name}>`;
  });
  s = s.replace(/\s(href|src|action)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, ' $1="#"');
  return s;
}

/** True when a string looks like an HTML fragment (not plain text). */
function looksLikeHtml(s) {
  return typeof s === 'string' && /<\/?[a-z][\s\S]*>/i.test(s);
}

/* ------------------------------------------------------------------ */
/* Template personalization (anti-hallucination)                        */
/* ------------------------------------------------------------------ */

// Variables that may come straight from lead columns.
// Extra vars (website_link, preview_url, from_name, interested, uninterested) via `extra`.
const LEAD_VARS = [
  'business_name',
  'category',
  'phone',
  'email',
  'website',
  'address',
  'city',
  'state',
  'postal_code',
  'country',
  'rating',
  'review_count',
  'description',
  'preview_path',
  'source',
];

// business_facts.fact_key values that are safe to expose as {{var}}.
// Only facts with claim_class VERIFIED or OWNER_PROVIDED are used.
const FACT_VAR_MAP = {
  phone: 'phone',
  email: 'email',
  website: 'website',
  address: 'address',
  city: 'city',
  state: 'state',
  hours: 'hours',
  services: 'services',
  description: 'description',
  category: 'category',
};

/**
 * Substitute {{variables}} in a template's subject/body.
 *
 * @param {{subject:string, body:string}} template
 * @param {object} lead            lead row (columns used as variables)
 * @param {Array}  facts           business_facts rows [{fact_key, value, claim_class}]
 * @param {object} extra           optional extra vars (e.g. {from_name})
 * @returns {{subject:string, body:string, used:string[], missing:string[]}}
 *
 * Rules: only VERIFIED / OWNER_PROVIDED facts are substituted; anything
 * unknown renders as an empty string — never invented copy.
 */
function personalize(template, lead, facts, extra) {
  const vars = {};
  const src = lead || {};
  for (const k of LEAD_VARS) {
    const v = src[k];
    vars[k] = v === null || v === undefined ? '' : String(v);
  }
  for (const f of facts || []) {
    if (!f || (f.claim_class !== 'VERIFIED' && f.claim_class !== 'OWNER_PROVIDED')) continue;
    const target = FACT_VAR_MAP[f.fact_key];
    if (target && !vars[target]) vars[target] = String(f.value);
  }
  for (const [k, v] of Object.entries(extra || {})) {
    vars[String(k).toLowerCase()] = v === null || v === undefined ? '' : String(v);
  }

  const used = new Set();
  const missing = new Set();
  const fill = (text) =>
    String(text || '').replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, name) => {
      const key = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== '') {
        used.add(key);
        return vars[key];
      }
      missing.add(key);
      return '';
    });

  return {
    subject: fill(template.subject),
    body: fill(template.body),
    used: [...used],
    missing: [...missing],
  };
}

module.exports = {
  isValidEmail,
  readSmtpConfig,
  validateSmtpConfig,
  readMailConfig,
  validateMailSettings,
  buildMime,
  SmtpProvider,
  CloudflareProvider,
  StubProvider,
  getProvider,
  personalize,
  sanitizeEmailHtml,
  looksLikeHtml,
  LEAD_VARS,
};
