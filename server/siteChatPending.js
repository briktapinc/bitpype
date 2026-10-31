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
 *
 * Batch 94 — two more pieces of state, added after Ely's "too many
 * silly questions" complaint: SETTLED dimensions (settled_json) —
 * short facts the owner has already decided, by stating them
 * outright or by answering a question ("scope: entire site",
 * "H3 colour: black #000000"). Settled dimensions are binding:
 * they are passed to the classifier and the clarification prompt
 * as decided, and are never asked about again. ROUNDS (rounds) —
 * how many clarification rounds this change has already used.
 * The routing layer caps clarification at ONE round by default:
 * once rounds >= 1, a further answer implements the change with
 * design defaults instead of asking again (see runSiteAgentChat).
 *
 * Batch 96 — pending state EXPIRES (review finding H7): a
 * clarification the owner walks away from must not steer the
 * conversation forever. A row untouched for PENDING_TTL_DAYS is
 * stale: reads sweep it (the row is deleted, never resurrected),
 * the next owner message starts fresh, and runSiteAgentChat
 * tells the owner plainly that the old request was let go
 * (getPendingWithExpiry hands it the swept row for that note).
 */

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_chat_pending (
      lead_id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'clarify',
      request_text TEXT NOT NULL,
      questions_text TEXT,
      answers_json TEXT NOT NULL DEFAULT '[]',
      settled_json TEXT NOT NULL DEFAULT '[]',
      rounds INTEGER NOT NULL DEFAULT 0,
      page_slug TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Batch 94 migration for tables created by Batch 93. Defensive:
  // partial db stubs in unit harnesses cannot answer PRAGMA — the
  // CREATE TABLE above already carries the new columns there.
  try {
    const stmt = db.prepare('PRAGMA table_info(site_chat_pending)');
    const cols = (stmt && typeof stmt.all === 'function' ? stmt.all() : []).map((c) => c.name);
    if (cols.length && !cols.includes('settled_json')) {
      db.exec("ALTER TABLE site_chat_pending ADD COLUMN settled_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (cols.length && !cols.includes('rounds')) {
      db.exec('ALTER TABLE site_chat_pending ADD COLUMN rounds INTEGER NOT NULL DEFAULT 0');
    }
  } catch {
    /* schema probe unavailable — fresh tables already have the columns */
  }
}

/**
 * Merge settled-dimension facts: an exact restatement (same fact,
 * any casing) is a no-op — the original stands. A fact that
 * re-states the same "key:" dimension with a DIFFERENT value
 * replaces the old one — the owner's latest word on a dimension
 * is the settled one. Anything else appends.
 */
function mergeSettledFacts(existing, additions) {
  const out = [];
  const push = (fact) => {
    const f = String(fact || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!f) return;
    const key = f.includes(':') ? f.split(':')[0].trim().toLowerCase() : null;
    const dup = out.findIndex((o) => {
      if (o.toLowerCase() === f.toLowerCase()) return true;
      if (key && o.includes(':') && o.split(':')[0].trim().toLowerCase() === key) return true;
      return false;
    });
    if (dup >= 0) {
      if (out[dup].toLowerCase() === f.toLowerCase()) return;
      out.splice(dup, 1);
    }
    out.push(f);
  };
  (Array.isArray(existing) ? existing : []).forEach(push);
  (Array.isArray(additions) ? additions : []).forEach(push);
  return out.slice(-20);
}

function parseSettled(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (Array.isArray(parsed)) return mergeSettledFacts([], parsed);
  } catch {
    /* fall through to empty */
  }
  return [];
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
    settled: parseSettled(row.settled_json),
    rounds: Number.isFinite(Number(row.rounds)) && Number(row.rounds) > 0 ? Math.floor(Number(row.rounds)) : 0,
    pageSlug: row.page_slug ? String(row.page_slug) : null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

/**
 * Batch 96 — the pending TTL. "Untouched" is measured from
 * updated_at: every save (a new question round, an answer, fresh
 * settled facts) refreshes it, so an actively-clarifying thread
 * stays alive; a thread abandoned for the full TTL expires.
 */
const PENDING_TTL_DAYS = 7;
const PENDING_TTL_MS = PENDING_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Milliseconds since epoch for a stored datetime('now') value
 * (UTC, 'YYYY-MM-DD HH:MM:SS'). NaN when unparseable — callers
 * treat an unparseable timestamp as NOT expired: never sweep on
 * data we cannot read. */
function pendingTimestampMs(value) {
  if (!value) return NaN;
  return Date.parse(`${String(value).replace(' ', 'T')}Z`);
}

function isPendingExpired(row, nowMs = Date.now()) {
  if (!row) return false;
  const ts = pendingTimestampMs(row.updated_at) || pendingTimestampMs(row.created_at);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts > PENDING_TTL_MS;
}

/**
 * Read this lead's pending clarification, sweeping it first if
 * it has expired. Returns { pending, expired }: `pending` is the
 * live row (or null); `expired` is the swept row in pending
 * shape (or null) so the caller can tell the owner honestly
 * what was let go. The sweep is a DELETE — an expired pending
 * is never resurrected by a later reply; the conversation
 * starts fresh.
 */
function getPendingWithExpiry(db, leadId, nowMs = Date.now()) {
  ensureTable(db);
  const lid = Number(leadId);
  const row = db.prepare('SELECT * FROM site_chat_pending WHERE lead_id = ?').get(lid);
  if (row && isPendingExpired(row, nowMs)) {
    db.prepare('DELETE FROM site_chat_pending WHERE lead_id = ?').run(lid);
    return { pending: null, expired: rowToPending(row) };
  }
  return { pending: rowToPending(row), expired: null };
}

function getPending(db, leadId) {
  return getPendingWithExpiry(db, leadId).pending;
}

function savePending(db, { leadId, kind, requestText, questionsText, answers, settled, rounds, pageSlug } = {}) {
  ensureTable(db);
  const lid = Number(leadId);
  const ans = (Array.isArray(answers) ? answers : []).map((a) => String(a).slice(0, 4000)).slice(0, 20);
  const set = mergeSettledFacts([], Array.isArray(settled) ? settled : []);
  const rnd = Number.isFinite(Number(rounds)) && Number(rounds) > 0 ? Math.floor(Number(rounds)) : 0;
  db.prepare(
    `INSERT INTO site_chat_pending (lead_id, kind, request_text, questions_text, answers_json, settled_json, rounds, page_slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET
       kind = excluded.kind,
       request_text = excluded.request_text,
       questions_text = excluded.questions_text,
       answers_json = excluded.answers_json,
       settled_json = excluded.settled_json,
       rounds = excluded.rounds,
       page_slug = excluded.page_slug,
       updated_at = datetime('now')`
  ).run(
    lid,
    kind === 'either_or' ? 'either_or' : 'clarify',
    String(requestText || '').slice(0, 4000),
    questionsText ? String(questionsText).slice(0, 4000) : null,
    JSON.stringify(ans),
    JSON.stringify(set),
    rnd,
    pageSlug ? String(pageSlug).slice(0, 120) : null
  );
  return getPending(db, lid);
}

function clearPending(db, leadId) {
  ensureTable(db);
  db.prepare('DELETE FROM site_chat_pending WHERE lead_id = ?').run(Number(leadId));
}

module.exports = {
  PENDING_TTL_DAYS,
  PENDING_TTL_MS,
  ensureTable,
  getPending,
  getPendingWithExpiry,
  isPendingExpired,
  savePending,
  clearPending,
  mergeSettledFacts,
};
