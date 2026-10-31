'use strict';

/**
 * Batch 93 — server-side assistant messages for the portal
 * site-builder chat thread.
 *
 * The chat thread itself lives in the portal page (client-side
 * history), but a BIG change queued to the design agent finishes
 * asynchronously — long after the chat turn that queued it. When a
 * chat-originated design job is delivered (src/designJobs.js
 * deliverJob hook), its completion summary is written HERE as an
 * assistant message. The portal fetches undelivered messages via
 * GET /api/v1/portal/site/agent-chat/updates when the chat opens and
 * after each send, appends them to the thread, and they are marked
 * delivered so each one surfaces exactly once.
 */

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'assistant',
      content TEXT NOT NULL,
      source TEXT,
      job_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_site_chat_msg_lead ON site_chat_messages(lead_id, delivered_at, id);
  `);
}

function addMessage(db, { leadId, content, source = null, jobId = null, role = 'assistant' } = {}) {
  ensureTable(db);
  const info = db
    .prepare(
      `INSERT INTO site_chat_messages (lead_id, role, content, source, job_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      Number(leadId),
      role === 'user' ? 'user' : 'assistant',
      String(content || '').slice(0, 4000),
      source ? String(source).slice(0, 60) : null,
      jobId != null ? Number(jobId) : null
    );
  return Number(info.lastInsertRowid);
}

/** Fetch this lead's undelivered messages and mark them delivered. */
function takeUndelivered(db, leadId, limit = 10) {
  ensureTable(db);
  const lid = Number(leadId);
  const rows = db
    .prepare(
      `SELECT * FROM site_chat_messages
       WHERE lead_id = ? AND delivered_at IS NULL
       ORDER BY id ASC LIMIT ?`
    )
    .all(lid, Math.max(1, Math.min(50, Number(limit) || 10)));
  if (rows.length) {
    const ids = rows.map((r) => Number(r.id));
    db.prepare(
      `UPDATE site_chat_messages SET delivered_at = datetime('now') WHERE id IN (${ids
        .map(() => '?')
        .join(',')})`
    ).run(...ids);
  }
  return rows.map((r) => ({
    id: Number(r.id),
    role: r.role === 'user' ? 'user' : 'assistant',
    content: String(r.content || ''),
    source: r.source || null,
    jobId: r.job_id != null ? Number(r.job_id) : null,
    createdAt: r.created_at || null,
  }));
}

module.exports = {
  ensureTable,
  addMessage,
  takeUndelivered,
};
