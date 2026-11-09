// @ts-check
'use strict';

/**
 * Batch 161 — the Assistant chat (Ely's order, 2026-11-08): a
 * full-page, Muse-style chat linked BEFORE Dashboard in both the
 * client portal and the staff app, as an alternative to the Muse
 * app. One implementation serves both surfaces; the surface decides
 * whose context, whose tools and whose bill it is.
 *
 * BRAIN — the routed function `assistant_chat` (server/aiRouting.js,
 * Batch 120/123 matrix): primary + fallback selectable in Admin →
 * API keys, failover/cooldown semantics identical to every other
 * row, served through museAgentCore.chatCompletionsRouted so a
 * failover can never double-execute a tool step. Context: the
 * caller's own workspace/site (Tier-1 compact site map + Tier-2
 * read tools — the design chat's two-tier doctrine). Tools: the
 * portal design chat's client-scoped catalog in build mode
 * (museAgentTools.portalModeAllowsTool), dispatched through
 * mcp.callTool pinned to the conversation's lead — the assistant
 * can never see or touch another workspace (the workspace DB is
 * the fence) and never exceeds the signed-in user's permissions
 * (portal: own lead only; staff: their workspace + chosen lead).
 *
 * METERING — every model call lands in ai_usage (task
 * 'assistant_chat') extended with surface / actor_user_id /
 * conversation_id / margin_pct / raw_cost_usd / billed_usd. Raw
 * cost comes from an ADMIN-EDITABLE price table (platform setting
 * ai.assistant.price_table — per provider|model per-1k rates,
 * seeded from the platform's long-standing flat cost rates).
 * Portal calls are billed to the workspace at raw × (1 + margin);
 * the margin is the platform setting ai.assistant.margin_pct
 * (seeded 20 — Ely's figure, adjustable by him in Admin) and is
 * STORED ON EACH ROW, so a later margin change never rewrites
 * history. Staff calls are internal platform cost: margin 0,
 * billed 0, surface 'admin'. Monthly rollups + the Stripe landing
 * live in server/assistantBilling.js.
 *
 * ATTACHMENTS — files, images, videos; camera capture is a
 * client-side input attribute over the same upload route. Uploads
 * are base64-in-JSON (codebase convention), magic-byte sniffed,
 * stored under EXPORT_ROOT/assistant-chat/ws-<id>/ with
 * server-generated names, and served only through authorized
 * routes that re-check the owner on every fetch. Images go to the
 * model as vision input (downscaled, Batch 89 pattern); text
 * files are inlined as text (capped); PDFs and videos are stored
 * and referenced to the model by name/kind/size — the runtime
 * image carries no ffmpeg and no PDF parser, so no frame or PDF
 * text extraction is claimed anywhere.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FN_KEY = 'assistant_chat';
const MAX_STEPS = 10;
const MAX_MESSAGE_CHARS = 8000;
const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const TEXT_INLINE_CAP = 8000;
const HISTORY_TURNS = 12;

const SETTING_MARGIN = 'ai.assistant.margin_pct';
const SETTING_CAP = 'ai.assistant.monthly_cap_usd';
const SETTING_PRICES = 'ai.assistant.price_table';
const DEFAULT_MARGIN_PCT = 20;
// Seeded from the platform's existing flat AI cost rates — the
// cost.per_1k_prompt / cost.per_1k_completion defaults (0.0015 /
// 0.002 USD per 1k tokens) both AI stacks have always used for
// ai_usage costing. Admins can refine per provider/model in the
// price table; the fallback 'default' entry is these rates.
const DEFAULT_PRICE_TABLE = { default: { promptPer1k: 0.0015, completionPer1k: 0.002 } };

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

// ------------------------------------------------------------ settings
async function getMarginPct() {
  try {
    const raw = await require('./platform').getPlatformSetting(SETTING_MARGIN, '');
    const n = parseFloat(String(raw || ''));
    if (Number.isFinite(n) && n >= 0 && n <= 1000) return n;
  } catch {
    /* platform DB hiccup — fall through to Ely's seeded figure */
  }
  return DEFAULT_MARGIN_PCT;
}

async function getMonthlyCapUsd() {
  try {
    const raw = await require('./platform').getPlatformSetting(SETTING_CAP, '');
    const n = parseFloat(String(raw || ''));
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* unset = no cap */
  }
  return null;
}

/** Parse + validate a price-table payload. Throws VALIDATION. */
function parsePriceTable(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return structuredClone(DEFAULT_PRICE_TABLE);
    try {
      obj = JSON.parse(raw);
    } catch {
      throw coded('VALIDATION', 'Price table must be valid JSON');
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw coded('VALIDATION', 'Price table must be a JSON object keyed by "provider|model", "model", "provider|*" or "default"');
  }
  /** @type {Record<string, { promptPer1k: number, completionPer1k: number }>} */
  const out = {};
  for (const [key, v] of Object.entries(obj)) {
    const k = String(key).trim().slice(0, 120);
    if (!k || !v || typeof v !== 'object') throw coded('VALIDATION', `Price table entry "${k}" must be an object`);
    const p = Number(/** @type {any} */ (v).promptPer1k);
    const c = Number(/** @type {any} */ (v).completionPer1k);
    if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0 || p > 100 || c > 100) {
      throw coded('VALIDATION', `Price table entry "${k}" needs promptPer1k / completionPer1k between 0 and 100`);
    }
    out[k] = { promptPer1k: p, completionPer1k: c };
  }
  if (!out.default) throw coded('VALIDATION', 'Price table needs a "default" entry');
  return out;
}

async function getPriceTable() {
  try {
    const raw = await require('./platform').getPlatformSetting(SETTING_PRICES, '');
    if (String(raw || '').trim()) return parsePriceTable(String(raw));
  } catch {
    /* corrupt/unset — the seeded defaults keep metering honest */
  }
  return structuredClone(DEFAULT_PRICE_TABLE);
}

/** Rate lookup order: provider|model → model → provider|* → default. */
function rateFor(table, provider, model) {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '');
  return (
    table[`${p}|${m}`] ||
    table[m] ||
    table[`${p}|*`] ||
    table.default || { promptPer1k: 0.0015, completionPer1k: 0.002 }
  );
}

function rawCostUsd(table, provider, model, promptTokens, completionTokens) {
  const r = rateFor(table, provider, model);
  return (Number(promptTokens) / 1000) * r.promptPer1k + (Number(completionTokens) / 1000) * r.completionPer1k;
}

async function getAssistantSettings() {
  const [marginPct, monthlyCapUsd, priceTable] = await Promise.all([
    getMarginPct(),
    getMonthlyCapUsd(),
    getPriceTable(),
  ]);
  return { marginPct, monthlyCapUsd, priceTable };
}

/** Validate an admin settings payload → platform-setting entries. */
async function validateAssistantSettings(body) {
  /** @type {Record<string, string>} */
  const entries = {};
  const b = body && typeof body === 'object' ? body : {};
  if (b.marginPct !== undefined) {
    const n = Number(b.marginPct);
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw coded('VALIDATION', 'Margin must be a number between 0 and 1000 (percent)');
    entries[SETTING_MARGIN] = String(n);
  }
  if (b.monthlyCapUsd !== undefined) {
    if (b.monthlyCapUsd === null || b.monthlyCapUsd === '') {
      entries[SETTING_CAP] = '';
    } else {
      const n = Number(b.monthlyCapUsd);
      if (!Number.isFinite(n) || n <= 0) throw coded('VALIDATION', 'Monthly cap must be a positive USD amount, or empty for no cap');
      entries[SETTING_CAP] = String(n);
    }
  }
  if (b.priceTable !== undefined) {
    const table = parsePriceTable(b.priceTable);
    entries[SETTING_PRICES] = JSON.stringify(table);
  }
  if (!Object.keys(entries).length) throw coded('VALIDATION', 'Nothing to save');
  return entries;
}

// ------------------------------------------------------------ tables
function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface TEXT NOT NULL,
      actor_id INTEGER NOT NULL,
      lead_id INTEGER,
      title TEXT NOT NULL DEFAULT 'New conversation',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_asst_conv_actor ON assistant_conversations(surface, actor_id, id);
    CREATE TABLE IF NOT EXISTS assistant_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      attachments TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_asst_msg_conv ON assistant_messages(conversation_id, id);
    CREATE TABLE IF NOT EXISTS assistant_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface TEXT NOT NULL,
      actor_id INTEGER NOT NULL,
      lead_id INTEGER,
      conversation_id INTEGER,
      original_name TEXT,
      stored_name TEXT NOT NULL,
      stored_rel TEXT NOT NULL,
      mime TEXT NOT NULL,
      kind TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_asst_att_actor ON assistant_attachments(surface, actor_id, id);
    CREATE TABLE IF NOT EXISTS assistant_usage_rollups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL UNIQUE,
      raw_usd REAL NOT NULL DEFAULT 0,
      billed_usd REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'accrued',
      stripe_invoice_item_id TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ensureUsageColumns(db);
}

/** ai_usage metering extension — PRAGMA-check + ALTER, house pattern. */
function ensureUsageColumns(db) {
  try {
    const has = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_usage'")
      .get();
    if (!has) return;
    const cols = db.prepare('PRAGMA table_info(ai_usage)').all().map((c) => c.name);
    const add = (name, ddl) => {
      if (!cols.includes(name)) db.exec(`ALTER TABLE ai_usage ADD COLUMN ${ddl}`);
    };
    add('surface', "surface TEXT NOT NULL DEFAULT ''");
    add('actor_user_id', 'actor_user_id INTEGER');
    add('conversation_id', 'conversation_id INTEGER');
    add('margin_pct', 'margin_pct REAL NOT NULL DEFAULT 0');
    add('raw_cost_usd', 'raw_cost_usd REAL NOT NULL DEFAULT 0');
    add('billed_usd', 'billed_usd REAL NOT NULL DEFAULT 0');
  } catch {
    /* metering must never break a chat turn */
  }
}

// ------------------------------------------------------------ conversations
function rowToConversation(r) {
  return {
    id: Number(r.id),
    surface: r.surface,
    actorId: Number(r.actor_id),
    leadId: r.lead_id != null ? Number(r.lead_id) : null,
    title: r.title || 'New conversation',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function createConversation(db, { surface, actorId, leadId = null, title = '' }) {
  ensureTables(db);
  const info = db
    .prepare('INSERT INTO assistant_conversations (surface, actor_id, lead_id, title) VALUES (?, ?, ?, ?)')
    .run(
      String(surface),
      Number(actorId),
      leadId != null ? Number(leadId) : null,
      String(title || 'New conversation').slice(0, 120)
    );
  return getConversation(db, { surface, actorId, id: Number(info.lastInsertRowid) });
}

/** THE scoping predicate: a conversation is visible only to its owner. */
function getConversation(db, { surface, actorId, id }) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM assistant_conversations WHERE id = ? AND surface = ? AND actor_id = ?')
    .get(Number(id), String(surface), Number(actorId));
  return row ? rowToConversation(row) : null;
}

function listConversations(db, { surface, actorId, limit = 50 }) {
  ensureTables(db);
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM assistant_messages m WHERE m.conversation_id = c.id) AS msg_count,
              (SELECT m2.content FROM assistant_messages m2 WHERE m2.conversation_id = c.id ORDER BY m2.id DESC LIMIT 1) AS last_text
       FROM assistant_conversations c
       WHERE c.surface = ? AND c.actor_id = ?
       ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`
    )
    .all(String(surface), Number(actorId), Math.max(1, Math.min(100, Number(limit) || 50)));
  return rows.map((r) => ({
    ...rowToConversation(r),
    messageCount: Number(r.msg_count) || 0,
    lastText: r.last_text ? String(r.last_text).slice(0, 140) : '',
  }));
}

function appendMessage(db, { conversationId, role, content, attachments = null }) {
  ensureTables(db);
  const info = db
    .prepare('INSERT INTO assistant_messages (conversation_id, role, content, attachments) VALUES (?, ?, ?, ?)')
    .run(
      Number(conversationId),
      role === 'user' ? 'user' : 'assistant',
      String(content || '').slice(0, 20000),
      attachments ? JSON.stringify(attachments).slice(0, 8000) : null
    );
  db.prepare("UPDATE assistant_conversations SET updated_at = datetime('now') WHERE id = ?").run(Number(conversationId));
  return Number(info.lastInsertRowid);
}

function listMessages(db, { conversationId, limit = 200 }) {
  ensureTables(db);
  const rows = db
    .prepare('SELECT * FROM assistant_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(conversationId), Math.max(1, Math.min(500, Number(limit) || 200)));
  return rows.reverse().map((r) => {
    let atts = null;
    try {
      atts = r.attachments ? JSON.parse(r.attachments) : null;
    } catch {
      atts = null;
    }
    return {
      id: Number(r.id),
      role: r.role === 'user' ? 'user' : 'assistant',
      content: String(r.content || ''),
      attachments: Array.isArray(atts) ? atts : null,
      createdAt: r.created_at,
    };
  });
}

// ------------------------------------------------------------ attachments
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const VIDEO_EXT_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const TEXT_EXTS = new Set(['txt', 'md', 'csv', 'json', 'log']);

function storageRoot() {
  return process.env.EXPORT_ROOT || path.join(process.cwd(), 'exports');
}

function absFromRel(rel) {
  const root = path.resolve(storageRoot());
  const abs = path.resolve(root, String(rel || ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/* Batch 168 (S8#F1): unlink the stored files for attachment rows
 * whose DB rows are being dropped by a cascade the assistant module
 * doesn't own (lead delete in src/leadEngine.js — the Batch 89
 * site-chat pattern: rows collected before the transaction, files
 * unlinked after it). Best-effort per file; absFromRel's traversal
 * guard means a corrupt stored_rel can never unlink outside the
 * storage root. */
function deleteAttachmentFilesForRows(rows) {
  for (const row of rows || []) {
    if (!row || !row.stored_rel) continue;
    const abs = absFromRel(row.stored_rel);
    if (!abs) continue;
    try {
      fs.unlinkSync(abs);
    } catch {
      /* best-effort */
    }
  }
}

/** Content sniff: returns { kind, mime } or null when not allowed. */
function sniffAttachment(buf, originalName) {
  const chatAtt = require('./siteChatAttachments');
  const img = chatAtt.sniffImageMime(buf);
  if (img) return { kind: 'image', mime: img };
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { kind: 'file', mime: 'application/pdf' };
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    return { kind: 'video', mime: brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4' };
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { kind: 'video', mime: 'video/webm' };
  }
  const ext = String(originalName || '').split('.').pop().toLowerCase();
  if (TEXT_EXTS.has(ext)) {
    const sample = buf.subarray(0, 2048);
    if (!sample.includes(0)) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(sample);
        return { kind: 'file', mime: ext === 'json' ? 'application/json' : ext === 'csv' ? 'text/csv' : 'text/plain' };
      } catch {
        return null;
      }
    }
  }
  if (VIDEO_EXT_MIME[ext] && buf.length >= 8) return null; // claimed video, wrong bytes — refuse, never trust the name
  return null;
}

function capFor(kind) {
  return kind === 'video' ? MAX_VIDEO_BYTES : kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
}

function publicAttachment(row, surface) {
  if (!row) return null;
  const base = surface === 'admin' ? '/api/v1/assistant/attachments' : '/api/v1/portal/assistant/attachments';
  return {
    id: Number(row.id),
    name: row.original_name || 'file',
    mime: row.mime,
    kind: row.kind,
    sizeBytes: Number(row.size_bytes) || 0,
    url: `${base}/${Number(row.id)}`,
    createdAt: row.created_at,
  };
}

/**
 * Save one uploaded attachment (buffer already decoded by the route).
 * Scoped to (surface, actor) at birth; every later read re-checks.
 */
function saveAttachment(db, { workspaceId, surface, actorId, leadId = null, conversationId = null, buffer, originalName }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw coded('INVALID', 'Choose a file to attach.');
  const sniff = sniffAttachment(buffer, originalName);
  if (!sniff) {
    throw coded(
      'INVALID_FILE',
      'That file type is not supported. Attach images (PNG, JPG, WebP, GIF), videos (MP4, MOV, WebM), PDFs, or text files (TXT, MD, CSV, JSON).'
    );
  }
  const cap = capFor(sniff.kind);
  if (buffer.length > cap) {
    throw coded('TOO_LARGE', `That ${sniff.kind} is too large — the limit is ${Math.round(cap / (1024 * 1024))} MB.`);
  }
  ensureTables(db);
  const chatAtt = require('./siteChatAttachments');
  const name = chatAtt.sanitizeFileName(originalName || 'file');
  const ext =
    sniff.kind === 'image'
      ? { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[sniff.mime] || 'bin'
      : sniff.kind === 'video'
        ? { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }[sniff.mime] || 'bin'
        : sniff.mime === 'application/pdf'
          ? 'pdf'
          : name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'txt';
  const storedName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const dirRel = path.join('assistant-chat', `ws-${Number(workspaceId)}`);
  const storedRel = path.join(dirRel, storedName);
  const dirAbs = absFromRel(dirRel);
  if (!dirAbs) throw coded('INVALID', 'Attachment storage is unavailable.');
  fs.mkdirSync(dirAbs, { recursive: true });
  fs.writeFileSync(path.join(dirAbs, storedName), buffer);
  const info = db
    .prepare(
      `INSERT INTO assistant_attachments (surface, actor_id, lead_id, conversation_id, original_name, stored_name, stored_rel, mime, kind, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(surface),
      Number(actorId),
      leadId != null ? Number(leadId) : null,
      conversationId != null ? Number(conversationId) : null,
      name,
      storedName,
      storedRel,
      sniff.mime,
      sniff.kind,
      buffer.length
    );
  const row = db.prepare('SELECT * FROM assistant_attachments WHERE id = ?').get(Number(info.lastInsertRowid));
  return publicAttachment(row, surface);
}

/** THE attachment scoping predicate — owner-only reads. */
function getAttachmentRow(db, { surface, actorId, id }) {
  ensureTables(db);
  return (
    db
      .prepare('SELECT * FROM assistant_attachments WHERE id = ? AND surface = ? AND actor_id = ?')
      .get(Number(id), String(surface), Number(actorId)) || null
  );
}

function readAttachment(db, { surface, actorId, id }) {
  const row = getAttachmentRow(db, { surface, actorId, id });
  if (!row) return null;
  const abs = absFromRel(row.stored_rel);
  if (!abs || !fs.existsSync(abs)) return null;
  return { row, buffer: fs.readFileSync(abs), mime: row.mime, fileName: row.original_name || 'file' };
}

function normalizeAttachmentIds(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw coded('INVALID', 'Attachments must be a list.');
  const ids = [];
  for (const v of raw) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw coded('TOO_MANY', `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`);
  }
  return ids;
}

/** Load + describe a turn's attachments for the model. */
async function buildTurnAttachments(db, { surface, actorId, ids }) {
  const rows = [];
  for (const id of ids || []) {
    const row = getAttachmentRow(db, { surface, actorId, id });
    if (!row) throw coded('INVALID', 'An attached file could not be found for this conversation.');
    rows.push(row);
  }
  const images = rows.filter((r) => r.kind === 'image');
  let modelImages = [];
  if (images.length) {
    try {
      modelImages = await require('./siteChatAttachments').buildModelImages(images);
    } catch {
      modelImages = [];
    }
  }
  const notes = [];
  const texts = [];
  for (const row of rows) {
    if (row.kind === 'image') continue;
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
      `[Attached ${row.kind === 'video' ? 'video' : 'file'}: "${row.original_name}" (${row.mime}, ${Math.max(1, Math.round(Number(row.size_bytes) / 1024))} KB) — stored with this conversation. You cannot play or read its contents directly; work from the user's description and the file's name/metadata.]`
    );
  }
  return { rows, modelImages, notes, texts };
}

// ------------------------------------------------------------ metering
function recordUsage(db, { surface, actorId, conversationId, leadId, provider, model, promptTokens, completionTokens, priceTable, marginPct, note }) {
  ensureUsageColumns(db);
  const raw = rawCostUsd(priceTable, provider, model, promptTokens, completionTokens);
  const billed = surface === 'portal' ? raw * (1 + marginPct / 100) : 0;
  const appliedMargin = surface === 'portal' ? marginPct : 0;
  try {
    db.prepare(
      `INSERT INTO ai_usage (task, provider, model, prompt_tokens, completion_tokens, cost_usd, lead_id, note, surface, actor_user_id, conversation_id, margin_pct, raw_cost_usd, billed_usd)
       VALUES ('assistant_chat', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      provider || 'unknown',
      model || '',
      Number(promptTokens) || 0,
      Number(completionTokens) || 0,
      raw,
      leadId != null ? Number(leadId) : null,
      note ? String(note).slice(0, 500) : null,
      String(surface),
      Number(actorId),
      conversationId != null ? Number(conversationId) : null,
      appliedMargin,
      raw,
      billed
    );
  } catch (e) {
    console.warn('[assistantChat] ai_usage log failed:', e.message);
  }
  return { rawUsd: raw, billedUsd: billed, marginPct: appliedMargin };
}

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Billed-usage sum for one surface in one month ('YYYY-MM', UTC). */
function monthBilledUsd(db, { surface, month }) {
  ensureUsageColumns(db);
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(billed_usd), 0) AS b, COALESCE(SUM(raw_cost_usd), 0) AS r, COUNT(*) AS calls
         FROM ai_usage WHERE task = 'assistant_chat' AND surface = ? AND substr(at, 1, 7) = ?`
      )
      .get(String(surface), String(month));
    return { billedUsd: Number(row.b) || 0, rawUsd: Number(row.r) || 0, calls: Number(row.calls) || 0 };
  } catch {
    return { billedUsd: 0, rawUsd: 0, calls: 0 };
  }
}

/** Usage view model for one workspace DB. */
function usageSummary(db, { month, actorId = null }) {
  ensureUsageColumns(db);
  const portal = monthBilledUsd(db, { surface: 'portal', month });
  const admin = monthBilledUsd(db, { surface: 'admin', month });
  let byConversation = [];
  let byUser = [];
  try {
    byUser = db
      .prepare(
        `SELECT surface, actor_user_id AS actorId, COUNT(*) AS calls,
                COALESCE(SUM(prompt_tokens), 0) AS promptTokens, COALESCE(SUM(completion_tokens), 0) AS completionTokens,
                COALESCE(SUM(raw_cost_usd), 0) AS rawUsd, COALESCE(SUM(billed_usd), 0) AS billedUsd
         FROM ai_usage WHERE task = 'assistant_chat' AND substr(at, 1, 7) = ?
         GROUP BY surface, actor_user_id ORDER BY surface, actor_user_id`
      )
      .all(String(month))
      .map((r) => ({ ...r, internal: r.surface === 'admin' }));
    const convSql = actorId != null ? ' AND conversation_id IN (SELECT id FROM assistant_conversations WHERE actor_id = ?)' : '';
    const stmt = db.prepare(
      `SELECT conversation_id AS conversationId, COUNT(*) AS calls,
              COALESCE(SUM(raw_cost_usd), 0) AS rawUsd, COALESCE(SUM(billed_usd), 0) AS billedUsd
       FROM ai_usage WHERE task = 'assistant_chat' AND surface = 'portal' AND substr(at, 1, 7) = ? ${convSql}
       GROUP BY conversation_id ORDER BY billedUsd DESC`
    );
    byConversation = (actorId != null ? stmt.all(String(month), Number(actorId)) : stmt.all(String(month))).map((r) => {
      let title = null;
      if (r.conversationId != null) {
        try {
          const c = db.prepare('SELECT title FROM assistant_conversations WHERE id = ?').get(Number(r.conversationId));
          title = c ? c.title : null;
        } catch {
          title = null;
        }
      }
      return { ...r, title };
    });
  } catch {
    /* empty views on a fresh workspace */
  }
  let rollup = null;
  try {
    ensureTables(db);
    rollup = db.prepare('SELECT * FROM assistant_usage_rollups WHERE month = ?').get(String(month)) || null;
    if (rollup) {
      rollup = {
        month: rollup.month,
        rawUsd: Number(rollup.raw_usd) || 0,
        billedUsd: Number(rollup.billed_usd) || 0,
        status: rollup.status,
        stripeInvoiceItemId: rollup.stripe_invoice_item_id || null,
        note: rollup.note || null,
      };
    }
  } catch {
    rollup = null;
  }
  return { month, portal, admin, byUser, byConversation, rollup };
}

// ------------------------------------------------------------ context
/** Tier-1 compact site map (the design chat's two-tier doctrine, summary form). */
function buildSiteContext(db, leadId) {
  const clip = (v, n) =>
    String(v == null ? '' : v)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, n);
  const lines = [];
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId)) || {};
    const basics = [
      lead.business_name ? `Business: ${clip(lead.business_name, 90)}` : '',
      lead.category ? `Category: ${clip(lead.category, 60)}` : '',
      lead.phone ? `Phone: ${clip(lead.phone, 30)}` : '',
      lead.email ? `Email: ${clip(lead.email, 60)}` : '',
      lead.city || lead.state ? `Location: ${clip([lead.city, lead.state].filter(Boolean).join(', '), 60)}` : '',
    ].filter(Boolean);
    if (basics.length) lines.push(basics.join(' · '));
    const { resolveClientSite } = require('./portalShared');
    const site = resolveClientSite(db, Number(leadId));
    if (site) {
      lines.push(`Website: ${clip(site.name, 90) || 'Untitled'} (status ${clip(site.status, 20) || 'draft'})`);
      for (const page of site.pages || []) {
        if (!page || typeof page !== 'object') continue;
        const types = (Array.isArray(page.sections) ? page.sections : []).map((s) => (s && (s.type || s.kind)) || 'section');
        lines.push(`- /${clip(page.slug || page.id || 'index', 40)}${page.title ? ` — ${clip(page.title, 60)}` : ''}: ${types.join(', ')}`);
      }
    }
    try {
      const embeds = db
        .prepare('SELECT module_type FROM site_module_embeds WHERE lead_id = ? ORDER BY module_type')
        .all(Number(leadId));
      if (embeds.length) lines.push(`Modules on the site: ${embeds.map((e) => e.module_type).join(', ')}`);
    } catch {
      /* best-effort */
    }
  } catch {
    /* context is best-effort */
  }
  return lines.join('\n').slice(0, 6000);
}

// ------------------------------------------------------------ the turn
/**
 * Run one assistant turn. `onEvent(type, payload)` receives
 * 'status' (tool activity), 'delta' (reply chunks — SSE streaming
 * to the browser), 'done' and 'error' events.
 */
async function runAssistantTurn({ workspaceId, surface, actorId, conversationId, message, attachmentIds = [], onEvent = () => {} }) {
  const domain = require('./domain');
  const core = require('./museAgentCore');
  const toolsMod = require('./museAgentTools');
  const mcp = require('./mcp');
  const text = String(message || '').trim();
  if (!text && !(attachmentIds && attachmentIds.length)) throw coded('EMPTY', 'Message is required');
  if (text.length > MAX_MESSAGE_CHARS) throw coded('TOO_LONG', `Message is too long (max ${MAX_MESSAGE_CHARS} characters)`);
  const ids = normalizeAttachmentIds(attachmentIds);

  return domain.withDb(workspaceId, async (db) => {
    const conv = getConversation(db, { surface, actorId, id: conversationId });
    if (!conv) throw coded('NOT_FOUND', 'Conversation not found');
    const leadId = conv.leadId;
    const settings = await getAssistantSettings();

    // Monthly soft cap (portal billing protection): refuse BEFORE
    // any model call when this workspace's billed assistant usage
    // for the month has reached the admin-set cap.
    if (surface === 'portal' && settings.monthlyCapUsd != null) {
      const used = monthBilledUsd(db, { surface: 'portal', month: monthKey() });
      if (used.billedUsd >= settings.monthlyCapUsd) {
        const reply =
          `Your AI assistant usage for this month has reached the $${settings.monthlyCapUsd.toFixed(2)} monthly cap, so I can't run more assistant calls until next month. ` +
          'Your website and everything else in the portal keep working as normal.';
        appendMessage(db, { conversationId, role: 'user', content: text || '[Attachment]' });
        appendMessage(db, { conversationId, role: 'assistant', content: reply });
        onEvent('delta', { text: reply });
        return { ok: false, capped: true, reply, conversationId, usage: used };
      }
    }

    const config = await core.resolveAgentConfig(db, FN_KEY);
    if (!core.museConfigured(config)) {
      throw coded('AI_NOT_CONFIGURED', 'The assistant is not configured yet — an admin needs to add an AI provider key.');
    }
    const budget = parseFloat(core.getDbSetting(db, 'cost.daily_budget_usd', '10')) || 0;
    if (budget > 0 && core.todaySpendUsd(db) >= budget) {
      throw coded('BUDGET_EXCEEDED', "Today's AI budget for this workspace has been reached. Try again tomorrow.");
    }

    const turnAtt = await buildTurnAttachments(db, { surface, actorId, ids });
    const attPublic = turnAtt.rows.map((r) => publicAttachment(r, surface));

    // Persist the user turn first (save-everything: the transcript
    // is the source of truth, loaded back below as context).
    appendMessage(db, {
      conversationId,
      role: 'user',
      content: text || '[Attachment]',
      attachments: attPublic.length ? attPublic : null,
    });
    if (conv.title === 'New conversation' && text) {
      db.prepare('UPDATE assistant_conversations SET title = ? WHERE id = ?').run(text.slice(0, 80), conversationId);
    }

    const history = listMessages(db, { conversationId, limit: HISTORY_TURNS + 1 })
      .slice(0, -1)
      .map((m) => ({ role: m.role, content: m.content }));

    const siteContext = leadId != null ? buildSiteContext(db, leadId) : '';
    const capabilities = leadId != null
      ? mcp.toolDefs({ clientScoped: true }).filter((t) => t && toolsMod.portalModeAllowsTool('build', t.name)).map((t) => t.name)
      : [];
    const system = [
      surface === 'portal'
        ? 'You are the BitPype Assistant inside this business owner\'s client portal — a general AI assistant for their business and website, in the style of a chat assistant app. Answer questions, help with writing and planning, and when the owner asks for a change to their website, use your tools to make it and publish the preview.'
        : 'You are the BitPype Assistant inside the staff admin — a general AI assistant for the BitPype team member signed in. Answer questions, help with the work, and when a site is selected and a change is asked for, use your tools on that site only.',
      'Be direct, practical and concise. Never invent business details, prices or content that are not in the site context or tool results — fetch with the read tools or say you do not see it.',
      capabilities.length
        ? `Tools available to you on this conversation's site (lead ${leadId}): ${capabilities.join(', ')}. After any change, call site.publish so the preview updates.`
        : 'This conversation has no site selected, so you have no site tools this turn — chat, advise and work from the conversation and attachments.',
      siteContext ? `SITE CONTEXT (Tier-1 map of the site — your standing knowledge; use the read tools for full detail):\n${siteContext}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    /** @type {Array<any>} */
    const messages = [{ role: 'system', content: system }, ...history];
    const userParts = [];
    const fullText = [text, ...turnAtt.texts, ...turnAtt.notes].filter(Boolean).join('\n\n');
    if (turnAtt.modelImages.length) {
      userParts.push({ type: 'text', text: fullText || 'Please look at the attached image(s).' });
      for (const im of turnAtt.modelImages) userParts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
      messages.push({ role: 'user', content: userParts });
    } else {
      messages.push({ role: 'user', content: fullText || 'Please look at the attached file(s).' });
    }

    let tools = [];
    let toolNames = new Map();
    if (leadId != null) {
      const scoped = mcp.toolDefs({ clientScoped: true }).filter((t) => t && toolsMod.portalModeAllowsTool('build', t.name));
      const conv2 = core.mcpToolsToOpenAi(scoped);
      tools = conv2.tools;
      toolNames = conv2.toolNames;
    }

    let steps = 0;
    let toolCalls = 0;
    let mutated = false;
    let published = false;
    let lastError = null;
    let finalReply = '';
    let visionDropped = false;
    const meter = { rawUsd: 0, billedUsd: 0, calls: 0 };

    const logStep = (data, step) => {
      const usage = (data && data.usage) || {};
      const r = recordUsage(db, {
        surface,
        actorId,
        conversationId,
        leadId,
        provider: core.servedProviderFor(config),
        model: core.servedModelFor(config),
        promptTokens: Number(usage.prompt_tokens) || 0,
        completionTokens: Number(usage.completion_tokens) || 0,
        priceTable: settings.priceTable,
        marginPct: settings.marginPct,
        note: core.withFailoverNote(config, `assistant ${surface} step ${step}`),
      });
      meter.rawUsd += r.rawUsd;
      meter.billedUsd += r.billedUsd;
      meter.calls += 1;
    };

    const stripImages = () => {
      const m = messages[messages.length - 1];
      if (m && Array.isArray(m.content)) {
        const t = m.content.find((p) => p && p.type === 'text');
        m.content =
          (t ? String(t.text) : '') +
          '\n\n[Note: the attached image(s) could not be shown to you directly. They are saved with this conversation — work from the written description.]';
      }
    };

    while (steps < MAX_STEPS) {
      steps++;
      let data;
      try {
        data = await core.chatCompletionsRouted(config, {
          model: config.model,
          messages,
          ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
          max_tokens: 4096,
        });
      } catch (e) {
        if (turnAtt.modelImages.length && !visionDropped) {
          visionDropped = true;
          stripImages();
          try {
            data = await core.chatCompletionsRouted(config, {
              model: config.model,
              messages,
              ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
              max_tokens: 4096,
            });
          } catch (e2) {
            lastError = e2.code || 'MUSE_REQUEST_FAILED';
            break;
          }
        } else {
          lastError = e.code || 'MUSE_REQUEST_FAILED';
          break;
        }
      }
      logStep(data, steps);
      const choice = data.choices && data.choices[0];
      const msg = (choice && choice.message) || {};
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!calls.length) {
        finalReply = msg.content != null ? String(msg.content).trim() : '';
        break;
      }
      messages.push({ role: 'assistant', content: msg.content != null ? msg.content : null, tool_calls: calls });
      for (const tc of calls) {
        const wireName = String((tc.function && tc.function.name) || '').trim();
        const name = toolNames.get(wireName);
        let args = {};
        try {
          args = JSON.parse((tc.function && tc.function.arguments) || '{}');
        } catch {
          args = {};
        }
        if (leadId != null) args.leadId = leadId;
        if (!name || toolsMod.DENY_TOOLS.has(name) || !toolsMod.portalModeAllowsTool('build', name)) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, error: `Tool ${name || wireName} is not available in the assistant.` }),
          });
          continue;
        }
        toolCalls++;
        onEvent('status', { text: `Using ${name}…` });
        let outcome;
        try {
          outcome = await mcp.callTool(workspaceId, name, args, { leadId });
        } catch (e) {
          outcome = { ok: false, error: e.message || String(e) };
        }
        if (outcome && outcome.ok !== false) {
          if (toolsMod.PORTAL_MUTATE_TOOLS.has(name)) mutated = true;
          if (name === 'site.publish') published = true;
        }
        const compact = JSON.stringify(outcome);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: compact.length > 24000 ? compact.slice(0, 24000) + '…[truncated]' : compact,
        });
      }
    }

    if (mutated && !published && leadId != null) {
      try {
        const pub = await mcp.callTool(workspaceId, 'site.publish', { leadId }, { leadId });
        if (pub && pub.ok !== false) published = true;
      } catch {
        /* best-effort, like the design loop */
      }
    }
    if (!finalReply) {
      finalReply = lastError
        ? 'I could not finish that just now — please try again.'
        : mutated
          ? 'Done — I updated the site and published the preview.'
          : 'I looked into that but could not form a reply — try asking a different way.';
    }
    appendMessage(db, { conversationId, role: 'assistant', content: finalReply });
    // Stream the reply to the browser in word-sized chunks (SSE).
    const chunks = finalReply.match(/\S+\s*/g) || [finalReply];
    let acc = '';
    for (const c of chunks) {
      acc += c;
      if (acc.length >= 48 || c === chunks[chunks.length - 1]) {
        onEvent('delta', { text: acc });
        acc = '';
      }
    }
    if (acc) onEvent('delta', { text: acc });
    return {
      ok: !lastError,
      reply: finalReply,
      conversationId,
      steps,
      toolCalls,
      mutated,
      published,
      imagesSent: turnAtt.modelImages.length > 0 && !visionDropped,
      imagesDropped: visionDropped,
      usage: meter,
      error: lastError,
    };
  });
}

module.exports = {
  FN_KEY,
  MAX_STEPS,
  MAX_MESSAGE_CHARS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MAX_FILE_BYTES,
  SETTING_MARGIN,
  SETTING_CAP,
  SETTING_PRICES,
  DEFAULT_MARGIN_PCT,
  DEFAULT_PRICE_TABLE,
  getMarginPct,
  getMonthlyCapUsd,
  getPriceTable,
  parsePriceTable,
  rateFor,
  rawCostUsd,
  getAssistantSettings,
  validateAssistantSettings,
  ensureTables,
  ensureUsageColumns,
  deleteAttachmentFilesForRows,
  createConversation,
  getConversation,
  listConversations,
  appendMessage,
  listMessages,
  sniffAttachment,
  saveAttachment,
  getAttachmentRow,
  readAttachment,
  normalizeAttachmentIds,
  publicAttachment,
  recordUsage,
  monthKey,
  monthBilledUsd,
  usageSummary,
  buildSiteContext,
  runAssistantTurn,
};
