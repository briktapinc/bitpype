'use strict';

/**
 * Batch 93 — server-side assistant messages for the portal
 * site-builder chat thread.
 *
 * A BIG change queued to the design agent finishes asynchronously
 * — long after the chat turn that queued it. When a
 * chat-originated design job is delivered (src/designJobs.js
 * deliverJob hook), its completion summary is written HERE as an
 * assistant message. The portal fetches undelivered messages via
 * GET /api/v1/portal/site/agent-chat/updates when the chat opens and
 * after each send, appends them to the thread, and they are marked
 * delivered so each one surfaces exactly once.
 *
 * Batch 94 — completed chat turns are persisted here too
 * (recordSiteChatTurn), so the thread survives reloads and the
 * panel can show the site's recent history on open.
 *
 * Batch 96 — this store is now the conversation's source of
 * truth (§12.4): the chat pipeline loads its own context tail
 * from here (listContextTail) instead of trusting a history
 * array sent by the browser, and operators can look a site's
 * transcript up (MCP site.chatTranscript) instead of asking the
 * owner to paste it.
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

/**
 * Batch 94 — how many saved messages the chat window shows on
 * open (Ely: "display x amount of chat history in chat window").
 * One named constant; the panel's initial load asks the history
 * route for exactly this many of THIS site's latest messages.
 */
const CHAT_HISTORY_LIMIT = 50;

/**
 * Batch 96 — how much of the saved transcript the chat pipeline
 * itself loads as conversation context. The transcript is the
 * source of truth (§12.4): runSiteAgentChat loads THIS tail
 * server-side for the classifier and the improve loop, and the
 * history array the browser used to send is retired — ignored
 * if a client still sends one. 10 matches the window the loop
 * always worked with (it sliced the client array to the last
 * 10); the classifier slices its own last 6 from the same tail.
 */
const CHAT_CONTEXT_LIMIT = 10;

/**
 * @param {any} db
 * @param {{ leadId?: any, content?: string, source?: any, jobId?: any, role?: string, delivered?: boolean }} [opts]
 */
function addMessage(db, { leadId, content, source = null, jobId = null, role = 'assistant', delivered = false } = {}) {
  ensureTable(db);
  const info = db
    .prepare(
      `INSERT INTO site_chat_messages (lead_id, role, content, source, job_id, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(leadId),
      role === 'user' ? 'user' : 'assistant',
      String(content || '').slice(0, 4000),
      source ? String(source).slice(0, 60) : null,
      jobId != null ? Number(jobId) : null,
      // Turn rows are already on the owner's screen — they are
      // history, not updates, so they must never resurface through
      // takeUndelivered. Write-backs (delivered=false) still do.
      delivered ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null
    );
  return Number(info.lastInsertRowid);
}

function rowToMessage(r) {
  return {
    id: Number(r.id),
    role: r.role === 'user' ? 'user' : 'assistant',
    content: String(r.content || ''),
    source: r.source || null,
    jobId: r.job_id != null ? Number(r.job_id) : null,
    createdAt: r.created_at || null,
  };
}

/**
 * This site's most recent messages (chat turns + agent
 * write-backs interleaved), oldest-first, capped at `limit`.
 * Strictly per lead — a site only ever reads its own thread.
 */
function listRecent(db, leadId, limit = CHAT_HISTORY_LIMIT) {
  ensureTable(db);
  const lid = Number(leadId);
  const cap = Math.max(1, Math.min(CHAT_HISTORY_LIMIT, Number(limit) || CHAT_HISTORY_LIMIT));
  const rows = db
    .prepare('SELECT * FROM site_chat_messages WHERE lead_id = ? ORDER BY id DESC LIMIT ?')
    .all(lid, cap);
  return rows.reverse().map(rowToMessage);
}

/**
 * The conversation-context tail for the chat pipeline: this
 * site's most recent messages as plain { role, content } pairs,
 * oldest-first — exactly the shape the classifier and the
 * improve loop consume. Includes agent write-backs (a queued
 * job's completion is part of the conversation the owner had).
 * Strictly per lead, like every read of this store.
 */
function listContextTail(db, leadId, limit = CHAT_CONTEXT_LIMIT) {
  const cap = Math.max(1, Math.min(CHAT_HISTORY_LIMIT, Number(limit) || CHAT_CONTEXT_LIMIT));
  return listRecent(db, leadId, cap).map((m) => ({ role: m.role, content: m.content }));
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
  return rows.map(rowToMessage);
}

module.exports = {
  CHAT_HISTORY_LIMIT,
  CHAT_CONTEXT_LIMIT,
  ensureTable,
  addMessage,
  takeUndelivered,
  listRecent,
  listContextTail,
};
