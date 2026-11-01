// @ts-check
'use strict';

/**
 * Batch 114 — WordPress connector plugin: registration links, site
 * credentials, and the per-download plugin zip factory.
 *
 * Model (Ely's order 2026-11-01): the plugin is FREE and unlicensed.
 * The portal mints ONE download per click; each download's plugin
 * code carries a unique registration token that works like a
 * registration link — it connects exactly ONE WordPress site to the
 * downloading workspace, then it is spent. Registration derives a
 * separate SCOPED site credential (the token itself never becomes a
 * standing credential, and nothing here is derived from — or can
 * reach — the workspace ws_ bearer token):
 *
 *   site credential may ONLY
 *     (i)  fetch this workspace's published form list + the public
 *          embed tokens for its own registered site, and
 *     (ii) learn its own connection status (ping / disconnect).
 *   Form submissions never use the credential: visitors' browsers
 *   post to the existing public form endpoints, exactly like forms
 *   on BitPype-hosted sites.
 *
 * Lifecycle (platform table wp_site_links):
 *   minted ──register──▶ connected ──deactivate──▶ disconnected
 *      ▲                     │  ▲                        │
 *      │                     │  └──── reactivate ────────┘
 *      └──── (a link registers one site; a spent link can never
 *             register again — the owner downloads a fresh copy)
 *   any state ──portal Revoke──▶ revoked (credential dead at once)
 *
 * Storage is the PLATFORM layer (server/db.js facade) because the
 * registration endpoint must resolve a token to its workspace
 * before any workspace DB is opened.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const db = require('./db');
const domain = require('./domain');
const contactForms = require('./contactForms');

const PLUGIN_SRC_DIR = path.join(__dirname, '..', 'integrations', 'wordpress', 'bitpype-connector');
const PLUGIN_SLUG = 'bitpype-connector';
const CONFIG_FILE = 'bitpype-config.php';
const TOKEN_PLACEHOLDER = '%%BITPYPE_REGISTRATION_TOKEN%%';
const APP_URL_PLACEHOLDER = '%%BITPYPE_APP_URL%%';

const TOKEN_PREFIX = 'bpreg_';
const SITE_KEY_PREFIX = 'bpsk_';
const TOKEN_RE = /^bpreg_[A-Za-z0-9_-]{32,64}$/;
const SITE_KEY_RE = /^bpsk_[A-Za-z0-9_-]{32,64}$/;

function fail(code, message, status) {
  const e = /** @type {Error & { code?: string, status?: number }} */ (new Error(message));
  e.code = code;
  if (status) e.status = status;
  return e;
}

function sha256hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function newSecret(prefix) {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

/** Canonical public app URL (same resolver the form embeds use). */
function appBaseUrl() {
  try {
    return String(require('./stripeClient').appUrl() || '').replace(/\/+$/, '');
  } catch {
    return String(process.env.APP_URL || '').replace(/\/+$/, '');
  }
}

function normalizeSiteUrl(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 500) throw fail('INVALID', 'A valid WordPress site URL is required', 400);
  let u;
  try {
    u = new URL(s);
  } catch {
    throw fail('INVALID', 'A valid WordPress site URL is required', 400);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw fail('INVALID', 'The WordPress site URL must start with http:// or https://', 400);
  }
  // Bind to the site's origin + install path (WP may live in a subdir).
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

function clampText(v, max) {
  return String(v == null ? '' : v)
    .trim()
    .slice(0, max);
}

// ------------------------------------------------------------------
// Downloads (portal side)
// ------------------------------------------------------------------

async function mintDownload(workspaceId, portalUserId) {
  const token = newSecret(TOKEN_PREFIX);
  const info = await db.query(
    `INSERT INTO wp_site_links (workspace_id, portal_user_id, token_hash, token_prefix, status)
     VALUES (:ws, :uid, :hash, :prefix, 'minted')`,
    {
      ws: Number(workspaceId),
      uid: portalUserId == null ? null : Number(portalUserId),
      hash: sha256hex(token),
      prefix: token.slice(0, 12),
    }
  );
  const id = Number(info && info.insertId ? info.insertId : 0);
  return { id, token };
}

async function findById(workspaceId, id) {
  const rows = await db.query('SELECT * FROM wp_site_links WHERE id = :id AND workspace_id = :ws LIMIT 1', {
    id: Number(id),
    ws: Number(workspaceId),
  });
  return rows && rows[0] ? rows[0] : null;
}

function publicView(row, downloaderEmail) {
  return {
    id: Number(row.id),
    tokenPrefix: row.token_prefix || '',
    status: row.status,
    siteUrl: row.site_url || null,
    siteName: row.site_name || null,
    adminEmail: row.admin_email || null,
    disconnectReason: row.disconnect_reason || null,
    downloadedBy: downloaderEmail || null,
    createdAt: row.created_at || null,
    registeredAt: row.registered_at || null,
    lastSeenAt: row.last_seen_at || null,
    revokedAt: row.revoked_at || null,
  };
}

async function listDownloads(workspaceId) {
  const rows = await db.query('SELECT * FROM wp_site_links WHERE workspace_id = :ws ORDER BY id DESC LIMIT 100', {
    ws: Number(workspaceId),
  });
  const out = [];
  for (const row of rows || []) {
    let email = null;
    if (row.portal_user_id) {
      try {
        const u = await db.query('SELECT email FROM client_portal_users WHERE id = :id LIMIT 1', {
          id: Number(row.portal_user_id),
        });
        email = (u && u[0] && u[0].email) || null;
      } catch {
        email = null;
      }
    }
    out.push(publicView(row, email));
  }
  return out;
}

async function revokeDownload(workspaceId, id) {
  const row = await findById(workspaceId, id);
  if (!row) throw fail('NOT_FOUND', 'That download was not found', 404);
  if (row.status !== 'revoked') {
    await db.query(
      `UPDATE wp_site_links SET status = 'revoked', revoked_at = UTC_TIMESTAMP() WHERE id = :id AND workspace_id = :ws`,
      { id: Number(id), ws: Number(workspaceId) }
    );
  }
  return findById(workspaceId, id);
}

// ------------------------------------------------------------------
// Registration (plugin side, token-gated)
// ------------------------------------------------------------------

async function findByTokenHash(hash) {
  const rows = await db.query('SELECT * FROM wp_site_links WHERE token_hash = :hash LIMIT 1', { hash });
  return rows && rows[0] ? rows[0] : null;
}

/**
 * Spend a registration token: bind it to exactly one WordPress site
 * and derive that site's scoped credential. Any later registration
 * attempt with the same token is refused (TOKEN_SPENT), whichever
 * site asks — a reinstalled-after-delete copy can never re-register.
 */
async function registerSite(input = {}) {
  const token = String(input.token || '').trim();
  if (!TOKEN_RE.test(token)) throw fail('INVALID_LINK', 'This registration link is not valid', 400);
  const row = await findByTokenHash(sha256hex(token));
  if (!row) throw fail('INVALID_LINK', 'This registration link is not valid', 404);
  if (row.status === 'revoked') {
    throw fail(
      'LINK_REVOKED',
      'This download was revoked in the BitPype portal. Download a fresh copy from your BitPype portal (WordPress tab) to connect a site.',
      410
    );
  }
  if (row.status !== 'minted') {
    throw fail(
      'TOKEN_SPENT',
      'This plugin copy has already connected a WordPress site. Each download connects one site — download a fresh copy from your BitPype portal (WordPress tab) and install that one instead.',
      409
    );
  }
  const siteUrl = normalizeSiteUrl(input.siteUrl);
  const siteName = clampText(input.siteName, 300);
  const adminEmail = clampText(input.adminEmail, 320);
  const siteKey = newSecret(SITE_KEY_PREFIX);
  await db.query(
    `UPDATE wp_site_links
        SET status = 'connected', site_url = :url, site_name = :name, admin_email = :email,
            site_key_hash = :khash, site_key_prefix = :kprefix, disconnect_reason = NULL,
            registered_at = UTC_TIMESTAMP(), last_seen_at = UTC_TIMESTAMP()
      WHERE id = :id AND status = 'minted'`,
    {
      url: siteUrl,
      name: siteName || null,
      email: adminEmail || null,
      khash: sha256hex(siteKey),
      kprefix: siteKey.slice(0, 12),
      id: Number(row.id),
    }
  );
  const after = await db.query('SELECT status, site_key_hash FROM wp_site_links WHERE id = :id LIMIT 1', {
    id: Number(row.id),
  });
  if (!after || !after[0] || after[0].site_key_hash !== sha256hex(siteKey)) {
    // Lost a concurrent race for the same token: someone else bound it.
    throw fail(
      'TOKEN_SPENT',
      'This plugin copy has already connected a WordPress site. Each download connects one site — download a fresh copy from your BitPype portal (WordPress tab) and install that one instead.',
      409
    );
  }
  return { linkId: Number(row.id), workspaceId: Number(row.workspace_id), siteKey, siteUrl };
}

// ------------------------------------------------------------------
// Site credential (plugin side, after registration)
// ------------------------------------------------------------------

async function findBySiteKey(rawKey) {
  const key = String(rawKey || '').trim();
  if (!SITE_KEY_RE.test(key)) return null;
  const rows = await db.query('SELECT * FROM wp_site_links WHERE site_key_hash = :hash LIMIT 1', {
    hash: sha256hex(key),
  });
  return rows && rows[0] ? rows[0] : null;
}

/** Resolve a request's site credential or throw a fail-closed error. */
async function requireSite(rawKey) {
  const row = await findBySiteKey(rawKey);
  if (!row) throw fail('INVALID_SITE_KEY', 'This site credential is not recognized', 401);
  if (row.status === 'revoked') {
    throw fail('SITE_REVOKED', 'This site was disconnected in the BitPype portal.', 410);
  }
  return row;
}

async function touchSite(row) {
  await db.query('UPDATE wp_site_links SET last_seen_at = UTC_TIMESTAMP() WHERE id = :id', { id: Number(row.id) });
}

/**
 * Plugin heartbeat + lifecycle signal. state:
 *   'active'      — the plugin was (re)activated with a stored
 *                   credential, or the owner pressed Reconnect in WP
 *                   admin. A disconnected registration reconnects:
 *                   deactivation is a pause, not the end of the
 *                   registration, and the link stays spent.
 *   'status'      — read-only status refresh (admin loads, form
 *                   renders). Never changes the stored status; this
 *                   is how a portal Revoke reaches the plugin: the
 *                   credential check itself already failed closed.
 *   'deactivated' — WP deactivation hook: portal shows DISCONNECTED.
 *   'uninstalled' — uninstall handler (best effort before the local
 *                   credential is wiped): portal shows DISCONNECTED.
 */
async function pingSite(row, state) {
  const s = String(state || 'active').toLowerCase();
  if (s === 'status') {
    await touchSite(row);
    return { status: row.status, siteUrl: row.site_url || null };
  }
  if (s === 'deactivated' || s === 'uninstalled') {
    if (row.status === 'connected') {
      await db.query(
        `UPDATE wp_site_links SET status = 'disconnected', disconnect_reason = :reason, last_seen_at = UTC_TIMESTAMP() WHERE id = :id`,
        { reason: s, id: Number(row.id) }
      );
      row.status = 'disconnected';
      row.disconnect_reason = s;
    }
  } else {
    if (row.status === 'disconnected') {
      await db.query(
        `UPDATE wp_site_links SET status = 'connected', disconnect_reason = NULL, last_seen_at = UTC_TIMESTAMP() WHERE id = :id`,
        { id: Number(row.id) }
      );
      row.status = 'connected';
      row.disconnect_reason = null;
    } else {
      await touchSite(row);
    }
  }
  return { status: row.status, siteUrl: row.site_url || null };
}

/** Owner-initiated disconnect from inside WP admin (credential kept). */
async function disconnectSite(row, reason) {
  const r = ['deactivated', 'uninstalled', 'manual'].includes(String(reason || '').toLowerCase())
    ? String(reason).toLowerCase()
    : 'manual';
  if (row.status === 'connected') {
    await db.query(
      `UPDATE wp_site_links SET status = 'disconnected', disconnect_reason = :reason, last_seen_at = UTC_TIMESTAMP() WHERE id = :id`,
      { reason: r, id: Number(row.id) }
    );
    row.status = 'disconnected';
    row.disconnect_reason = r;
  }
  return { status: row.status };
}

/**
 * The workspace's forms this site may render: published, embed-enabled
 * forms that carry a public embed token. The public token is the only
 * per-form value handed out — it is the same token BitPype-hosted
 * pages print in their HTML, and submissions post to the public form
 * endpoints with it, never with the site credential.
 */
async function siteForms(row) {
  const forms = domain.withDb(Number(row.workspace_id), (wdb) => {
    contactForms.ensureTables(wdb);
    const rows = wdb
      .prepare(
        `SELECT id, lead_id, title, name, public_token
           FROM contact_forms
          WHERE public_token IS NOT NULL AND public_token != ''
            AND COALESCE(embed_enabled, 1) = 1
          ORDER BY lead_id ASC, sort_order ASC, id ASC`
      )
      .all();
    return rows.map((f) => ({
      id: Number(f.id),
      leadId: Number(f.lead_id),
      name: String(f.title || f.name || 'Form').slice(0, 160),
      token: String(f.public_token),
      shortcode: `[bitpype_form id="${Number(f.id)}"]`,
    }));
  });
  return { forms, appUrl: appBaseUrl() };
}

// ------------------------------------------------------------------
// Plugin zip factory (deterministic apart from the config lines)
// ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed DOS timestamp (1980-01-01 00:00:00) for every entry: the zip
// bytes are a pure function of the plugin sources + the config lines.
const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01

function zipStore(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, ...central, eocd]);
}

function listPluginFiles(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...listPluginFiles(full, base));
    else if (st.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * Render one download's zip: the pristine plugin sources with ONLY
 * the config file's token + app-URL placeholders substituted. Two
 * downloads therefore differ byte-for-byte only on those config
 * lines (proven in the Batch 114 regression suite).
 */
function buildPluginZip({ token, appUrl }) {
  const files = listPluginFiles(PLUGIN_SRC_DIR);
  const entries = files.map((rel) => {
    let data = fs.readFileSync(path.join(PLUGIN_SRC_DIR, rel));
    if (rel === CONFIG_FILE) {
      const text = data.toString('utf8');
      if (!text.includes(TOKEN_PLACEHOLDER) || !text.includes(APP_URL_PLACEHOLDER)) {
        throw fail('CONFIG', 'Plugin config template is missing its placeholders', 500);
      }
      data = Buffer.from(
        text
          .split(TOKEN_PLACEHOLDER)
          .join(String(token))
          .split(APP_URL_PLACEHOLDER)
          .join(String(appUrl || '')),
        'utf8'
      );
    }
    return { name: `${PLUGIN_SLUG}/${rel}`, data };
  });
  return zipStore(entries);
}

module.exports = {
  PLUGIN_SLUG,
  CONFIG_FILE,
  TOKEN_PLACEHOLDER,
  APP_URL_PLACEHOLDER,
  appBaseUrl,
  mintDownload,
  listDownloads,
  revokeDownload,
  registerSite,
  requireSite,
  pingSite,
  disconnectSite,
  siteForms,
  buildPluginZip,
  zipStore,
  crc32,
  _internals: { sha256hex, normalizeSiteUrl, TOKEN_RE, SITE_KEY_RE },
};
