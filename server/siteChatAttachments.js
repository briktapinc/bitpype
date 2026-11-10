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
 * Batch 174 — attachment KINDS reach Assistant-chat parity (Ely
 * 2026-11-09: "improve with AI chat should work exactly like the
 * assistant chat"). The design chat now accepts the Assistant
 * chat's full set — images, videos (MP4/MOV/WebM), PDFs and text
 * files (TXT/MD/CSV/JSON) — validated by the Assistant chat's own
 * sniffer (assistantChat.sniffAttachment, which itself reuses this
 * module's image sniff) with the Assistant chat's caps per kind
 * (image 10 MB, video 50 MB, file 10 MB) and its refusal messages.
 * Storage, the lead-scoping predicate and the serving route are
 * unchanged: kind is derived from the stored mime, so no schema
 * change was needed. Images still go to the model as vision input
 * (buildModelImages); text files are inlined and other kinds are
 * described to the model by name/kind/size — the Assistant chat's
 * exact treatment (buildTurnAttachments below).
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
// Batch 174: the Assistant chat's per-kind caps, verbatim.
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const TEXT_INLINE_CAP = 8000;
const MAX_PER_MESSAGE = 4;
const MODEL_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const VIDEO_MIME_EXT = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };

/** Attachment kind from the stored mime (Batch 174 — no kind column needed). */
function kindForMime(mime) {
  const m = String(mime || '');
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'file';
}

function capForKind(kind) {
  return kind === 'video' ? MAX_VIDEO_BYTES : kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
}

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
/* Batch 168 (external review F10): attachment files are PRIVATE —
 * they used to be written under EXPORT_ROOT, which server.js mounts
 * anonymously at /site-previews, so any leaked path was a permanent
 * unauthenticated URL. New writes go to a private root on the
 * workspaces volume (never statically mounted); reads resolve
 * there first and fall back to the legacy exports location so
 * pre-168 files keep working through the ownership-checked
 * handlers (the /site-previews mount itself now denies these
 * directory shapes outright). */
function privateRoot() {
  if (process.env.PRIVATE_FILES_ROOT) return process.env.PRIVATE_FILES_ROOT;
  if (process.env.WORKSPACE_DATA_DIR) return path.join(process.env.WORKSPACE_DATA_DIR, 'private-attachments');
  return path.join(process.cwd(), 'private-attachments');
}


function relDir(workspaceId, leadId) {
  return path.join('site-chat', `ws-${Number(workspaceId)}`, `lead-${Number(leadId)}`);
}

/** Resolve a stored relative path, refusing anything outside the storage root. */
function absFromRel(rel) {
  const relStr = String(rel || '');
  const resolveIn = (base) => {
    const root = path.resolve(base);
    const abs = path.resolve(root, relStr);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
  };
  const priv = resolveIn(privateRoot());
  if (!priv) return null;
  if (fs.existsSync(priv)) return priv;
  const legacy = resolveIn(storageRoot());
  if (legacy && fs.existsSync(legacy)) return legacy;
  return priv;
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
    name: row.original_name || 'file',
    kind: kindForMime(row.mime),
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
    throw coded('INVALID', 'Choose a file to attach.');
  }
  // Batch 174: the Assistant chat's sniffer + caps + refusal copy,
  // verbatim — an unsupported type is refused the Assistant chat's
  // way because it IS the Assistant chat's validation.
  const sniff = require('./assistantChat').sniffAttachment(buffer, originalName);
  if (!sniff) {
    throw coded(
      'INVALID_FILE',
      'That file type is not supported. Attach images (PNG, JPG, WebP, GIF), videos (MP4, MOV, WebM), PDFs, or text files (TXT, MD, CSV, JSON).'
    );
  }
  const cap = capForKind(sniff.kind);
  if (buffer.length > cap) {
    throw coded('TOO_LARGE', `That ${sniff.kind} is too large — the limit is ${Math.round(cap / (1024 * 1024))} MB.`);
  }
  const mime = sniff.mime;
  ensureTable(db);
  const displayName = sanitizeFileName(originalName);
  const ext =
    sniff.kind === 'image'
      ? MIME_EXT[mime] || 'bin'
      : sniff.kind === 'video'
        ? VIDEO_MIME_EXT[mime] || 'bin'
        : mime === 'application/pdf'
          ? 'pdf'
          : displayName.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'txt';
  const base = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const storedName = `${base}.${ext}`;
  const dirRel = relDir(workspaceId, leadId);
  const storedRel = path.join(dirRel, storedName);
  const dirAbs = absFromRel(dirRel);
  if (!dirAbs) throw coded('INVALID', 'Attachment storage is unavailable.');
  fs.mkdirSync(dirAbs, { recursive: true });
  fs.writeFileSync(path.join(dirAbs, storedName), buffer);

  // Thumbnail is best-effort (images only): the chat renders the
  // full image scaled by CSS when no thumb exists.
  let thumbRel = null;
  if (sniff.kind === 'image') {
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
    throw coded('TOO_MANY', `Up to ${MAX_PER_MESSAGE} attachments per message.`);
  }
  return ids;
}

/** Load the rows for a chat turn — every id must belong to this lead. */
function loadForChat(db, { leadId, ids } = {}) {
  const rows = [];
  for (const id of ids || []) {
    const row = getAttachmentRow(db, leadId, id);
    if (!row) {
      throw coded('INVALID', 'An attached file could not be found for this conversation.');
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

/**
 * Batch 174 — a chat turn's attachments, prepared for the model
 * exactly the way the Assistant chat prepares them
 * (assistantChat.buildTurnAttachments): images become vision input
 * (buildModelImages), text files are inlined (capped), and every
 * other kind is described by name/kind/size — the runtime carries
 * no ffmpeg and no PDF parser, so no frame or PDF text extraction
 * is claimed anywhere, same as the Assistant chat.
 */
async function buildTurnAttachments(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const imageRows = list.filter((r) => kindForMime(r.mime) === 'image');
  const modelImages = imageRows.length ? await buildModelImages(imageRows) : [];
  const texts = [];
  const notes = [];
  for (const row of list) {
    const kind = kindForMime(row.mime);
    if (kind === 'image') continue;
    const abs = absFromRel(row.stored_rel);
    if (row.mime === 'text/plain' || row.mime === 'text/csv' || row.mime === 'application/json') {
      try {
        const text = fs.readFileSync(abs, 'utf8').slice(0, TEXT_INLINE_CAP);
        texts.push(`--- attached file "${row.original_name}" ---\n${text}`);
        continue;
      } catch {
        /* fall through to the metadata note */
      }
    }
    notes.push(
      `[Attached ${kind === 'video' ? 'video' : 'file'}: "${row.original_name}" (${row.mime}, ${Math.max(1, Math.round(Number(row.size_bytes) / 1024))} KB) — stored with this conversation. You cannot play or read its contents directly; work from the user's description and the file's name/metadata.]`
    );
  }
  return { modelImages, texts, notes };
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
  MAX_VIDEO_BYTES,
  MAX_FILE_BYTES,
  TEXT_INLINE_CAP,
  MAX_PER_MESSAGE,
  kindForMime,
  capForKind,
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
  buildTurnAttachments,
  deleteFilesForRows,
  publicRow,
  // Batch 168: exported for the regression suite (F10 storage pin).
  absFromRel,
};
