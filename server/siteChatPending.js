'use strict';

/**
 * Batch 93 — pending clarification state for the portal site-builder
 * chat (server/clientPortal.js runSiteAgentChat → server/museAgent.js).
 *
 * When the owner asks for a change that is too underspecified to
 * implement ("make it pop"), the chat asks clarification questions
 * instead of editing. The pending change — the original request, the
 * questions asked, and the owner's answers so far — is stored HERE,
 * server-side, one row per lead, so it survives page reloads and is
 * never lost while the conversation clarifies. The row is cleared
 * when the change is implemented in-chat, queued to the design
 * agent, cancelled, or (for an either/or check) resolved as a plain
 * question.
 */

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_chat_pending (
      lead_id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'clarify',
      request_text TEXT NOT NULL,
      questions_text TEXT,
      answers_json TEXT NOT NULL DEFAULT '[]',
      page_slug TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function rowToPending(row) {
  if (!row) return null;
  let answers = [];
  try {
    const parsed = JSON.parse(row.answers_json || '[]');
    if (Array.isArray(parsed)) answers = parsed.map((a) => String(a)).slice(0, 20);
  } catch {
    answers = [];
  }
  return {
    leadId: Number(row.lead_id),
    kind: row.kind === 'either_or' ? 'either_or' : 'clarify',
    requestText: String(row.request_text || ''),
    questionsText: row.questions_text ? String(row.questions_text) : '',
    answers,
    pageSlug: row.page_slug ? String(row.page_slug) : null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function getPending(db, leadId) {
  ensureTable(db);
  const row = db.prepare('SELECT * FROM site_chat_pending WHERE lead_id = ?').get(Number(leadId));
  return rowToPending(row);
}

function savePending(db, { leadId, kind, requestText, questionsText, answers, pageSlug } = {}) {
  ensureTable(db);
  const lid = Number(leadId);
  const ans = (Array.isArray(answers) ? answers : []).map((a) => String(a).slice(0, 4000)).slice(0, 20);
  db.prepare(
    `INSERT INTO site_chat_pending (lead_id, kind, request_text, questions_text, answers_json, page_slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET
       kind = excluded.kind,
       request_text = excluded.request_text,
       questions_text = excluded.questions_text,
       answers_json = excluded.answers_json,
       page_slug = excluded.page_slug,
       updated_at = datetime('now')`
  ).run(
    lid,
    kind === 'either_or' ? 'either_or' : 'clarify',
    String(requestText || '').slice(0, 4000),
    questionsText ? String(questionsText).slice(0, 4000) : null,
    JSON.stringify(ans),
    pageSlug ? String(pageSlug).slice(0, 120) : null
  );
  return getPending(db, lid);
}

function clearPending(db, leadId) {
  ensureTable(db);
  db.prepare('DELETE FROM site_chat_pending WHERE lead_id = ?').run(Number(leadId));
}

module.exports = {
  ensureTable,
  getPending,
  savePending,
  clearPending,
};
