'use strict';

/**
 * Batch 89 — image attachments for the portal "Improve with AI" design chat
 * (Ely 2026-10-30: "Add a file attachment functionality to the website
 * designing chat. So the image can be used for analysis. And improvements.
 * During the design process.").
 *
 * The surface is the client portal Website editor's agent chat
 * (public/portal.html #agent-chat → POST /api/v1/portal/site/agent-chat →
 * clientPortal.runSiteAgentChat → museAgent.runPortalImproveLoop). That
 * chat IS the website designing chat: the owner describes changes, the AI
 * design loop applies them to the site and republishes the preview.
 *
 * Storage follows the website-promo brochure convention: files live under
 * EXPORT_ROOT (default <cwd>/exports) in a per-workspace/per-lead folder
 * with SERVER-GENERATED names (the client filename is kept only as a
 * sanitized display label), and a row in the per-workspace SQLite DB links
 * attachment → lead → website → chat turn (message_ref).
 *
 * Access model: there are NO public URLs for these files. Bytes are served
 * only through authorized routes that re-check the caller's lead on every
 * fetch (portal session for the client; workspace-scoped MCP tools
 * site.chatAttachments / site.chatAttachment for staff / the design agent).
 * Every read in this module is scoped by lead_id — see getAttachmentRow,
 * the single scoping predicate (the Batch 89 negative proof shims it).
 *
 * Validation: content-sniffed by magic bytes (same sniffer contract as the
 * portal logo upload in clientPortal.js). PNG/JPEG/WebP/GIF only — SVG is
 * refused (script risk). Decoded size cap 10 MB.
 *
 * Deletion: chat history itself is browser-held (never persisted), so
 * there is no server-side conversation to delete. Attachments follow the
 * lead: leadEngine.deleteLead drops the rows in its sweep and unlinks the
 * files after the transaction (Batch 67/85 pattern).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PER_MESSAGE = 4;
const MODEL_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Magic-byte image sniff — identical contract to clientPortal.sniffImageMime. */
function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function storageRoot() {
  return process.env.EXPORT_ROOT || path.join(process.cwd(), 'exports');
}

function relDir(workspaceId, leadId) {
  return path.join('site-chat', `ws-${Number(workspaceId)}`, `lead-${Number(leadId)}`);
}

/** Resolve a stored relative path, refusing anything outside the storage root. */
function absFromRel(rel) {
  const root = path.resolve(storageRoot());
  const abs = path.resolve(root, String(rel || ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_chat_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      website_id INTEGER,
      message_ref TEXT,
      original_name TEXT,
      stored_name TEXT NOT NULL,
      stored_rel TEXT NOT NULL,
      thumb_rel TEXT,
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_site_chat_att_lead ON site_chat_attachments(lead_id, id);
  `);
}

/** Display label only — never used as a filesystem path. */
function sanitizeFileName(name) {
  let s = path
    .basename(String(name || ''))
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  if (!s) s = 'image';
  return s;
}

function publicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.lead_id,
    websiteId: row.website_id || null,
    name: row.original_name || 'image',
    mime: row.mime,
    sizeBytes: row.size_bytes,
    messageRef: row.message_ref || null,
    createdAt: row.created_at,
    url: `/api/v1/portal/site/agent-chat/attachments/${row.id}`,
    thumbUrl: row.thumb_rel ? `/api/v1/portal/site/agent-chat/attachments/${row.id}?variant=thumb` : null,
  };
}

/**
 * @param {any} db
 * @param {{ workspaceId?: any, leadId?: any, websiteId?: any, buffer?: any, originalName?: any }} [opts]
 */
async function saveAttachment(db, { workspaceId, leadId, websiteId = null, buffer, originalName } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw coded('INVALID', 'Choose an image to attach.');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw coded('TOO_LARGE', 'That image is too large — the limit is 10 MB.');
  }
  const mime = sniffImageMime(buffer);
  if (!mime) {
    throw coded('INVALID_IMAGE', 'That file is not a supported image. Use a PNG, JPG, WebP or GIF.');
  }
  ensureTable(db);
  const ext = MIME_EXT[mime];
  const base = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const storedName = `${base}.${ext}`;
  const dirRel = relDir(workspaceId, leadId);
  const storedRel = path.join(dirRel, storedName);
  const dirAbs = absFromRel(dirRel);
  if (!dirAbs) throw coded('INVALID', 'Attachment storage is unavailable.');
  fs.mkdirSync(dirAbs, { recursive: true });
  fs.writeFileSync(path.join(dirAbs, storedName), buffer);

  // Thumbnail is best-effort: the chat renders the full image scaled by
  // CSS when no thumb exists.
  let thumbRel = null;
  try {
    const sharp = require('sharp');
    const thumbName = `${base}-thumb.jpg`;
    await sharp(buffer)
      .resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toFile(path.join(dirAbs, thumbName));
    thumbRel = path.join(dirRel, thumbName);
  } catch {
    thumbRel = null;
  }

  const info = db
    .prepare(
      `INSERT INTO site_chat_attachments
         (lead_id, website_id, original_name, stored_name, stored_rel, thumb_rel, mime, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(leadId),
      websiteId != null ? Number(websiteId) : null,
      sanitizeFileName(originalName),
      storedName,
      storedRel,
      thumbRel,
      mime,
      buffer.length
    );
  const row = db.prepare('SELECT * FROM site_chat_attachments WHERE id = ?').get(info.lastInsertRowid);
  return publicRow(row);
}

/**
 * THE scoping predicate: an attachment is visible only to its own lead.
 * Every read path in this module goes through here.
 */
function getAttachmentRow(db, leadId, id) {
  ensureTable(db);
  return (
    db
      .prepare('SELECT * FROM site_chat_attachments WHERE id = ? AND lead_id = ?')
      .get(Number(id), Number(leadId)) || null
  );
}

function readAttachment(db, { leadId, id, variant } = {}) {
  const row = getAttachmentRow(db, leadId, id);
  if (!row) return null;
  const wantThumb = String(variant || '') === 'thumb' && row.thumb_rel;
  const rel = wantThumb ? row.thumb_rel : row.stored_rel;
  const abs = absFromRel(rel);
  if (!abs || !fs.existsSync(abs)) return null;
  return {
    row,
    buffer: fs.readFileSync(abs),
    mime: wantThumb ? 'image/jpeg' : row.mime,
    fileName: sanitizeFileName(row.original_name),
  };
}

function listAttachments(db, { leadId, limit } = {}) {
  ensureTable(db);
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  return db
    .prepare('SELECT * FROM site_chat_attachments WHERE lead_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(leadId), lim)
    .map(publicRow);
}

/** Validate a client-supplied attachment id list for one chat turn. */
function normalizeAttachmentIds(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw coded('INVALID', 'Attachments must be a list.');
  const ids = [];
  for (const v of raw) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }
  if (ids.length > MAX_PER_MESSAGE) {
    throw coded('TOO_MANY', `Up to ${MAX_PER_MESSAGE} images per message.`);
  }
  return ids;
}

/** Load the rows for a chat turn — every id must belong to this lead. */
function loadForChat(db, { leadId, ids } = {}) {
  const rows = [];
  for (const id of ids || []) {
    const row = getAttachmentRow(db, leadId, id);
    if (!row) {
      throw coded('INVALID', 'An attached image could not be found for this conversation.');
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Stamp the rows with the website + turn they were sent with.
 * @param {any} db
 * @param {{ leadId?: any, ids?: any[], websiteId?: any, messageRef?: any }} [opts]
 */
function linkToTurn(db, { leadId, ids, websiteId = null, messageRef = null } = {}) {
  if (!ids || !ids.length) return;
  ensureTable(db);
  const stmt = db.prepare(
    'UPDATE site_chat_attachments SET website_id = COALESCE(?, website_id), message_ref = ? WHERE id = ? AND lead_id = ?'
  );
  for (const id of ids) {
    stmt.run(websiteId != null ? Number(websiteId) : null, messageRef ? String(messageRef).slice(0, 80) : null, Number(id), Number(leadId));
  }
}

/**
 * Build the model-bound copies of attached images: downscaled data URLs
 * (long edge ≤1280, JPEG) so the design loop's vision input stays lean.
 * Falls back to the raw bytes when small enough; skips an image entirely
 * only when it can neither be downscaled nor sent raw.
 */
async function buildModelImages(rows) {
  const out = [];
  for (const row of rows || []) {
    const abs = absFromRel(row.stored_rel);
    if (!abs || !fs.existsSync(abs)) continue;
    const buffer = fs.readFileSync(abs);
    let dataUrl = null;
    let mime = row.mime;
    try {
      const sharp = require('sharp');
      const resized = await sharp(buffer)
        .rotate()
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      dataUrl = `data:image/jpeg;base64,${resized.toString('base64')}`;
      mime = 'image/jpeg';
    } catch {
      if (buffer.length <= MODEL_IMAGE_MAX_BYTES) {
        dataUrl = `data:${row.mime};base64,${buffer.toString('base64')}`;
      }
    }
    if (dataUrl) out.push({ name: row.original_name || 'image', mime, dataUrl });
  }
  return out;
}

/** Best-effort file removal for rows about to be / just deleted (lead sweep). */
function deleteFilesForRows(rows) {
  for (const row of rows || []) {
    for (const rel of [row.stored_rel, row.thumb_rel]) {
      if (!rel) continue;
      const abs = absFromRel(rel);
      if (abs) {
        try {
          fs.unlinkSync(abs);
        } catch {
          /* best-effort */
        }
      }
    }
  }
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_PER_MESSAGE,
  sniffImageMime,
  sanitizeFileName,
  ensureTable,
  saveAttachment,
  getAttachmentRow,
  readAttachment,
  listAttachments,
  normalizeAttachmentIds,
  loadForChat,
  linkToTurn,
  buildModelImages,
  deleteFilesForRows,
  publicRow,
};
