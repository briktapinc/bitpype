'use strict';

/**
 * Batch 100 (four-role rebuild step 3) — the per-site ROLLING
 * SUMMARY of the design-chat conversation.
 *
 * Batch 96 made the server transcript the source of truth, but
 * a transcript tail is not memory: long conversations scroll
 * past the tail, and settled decisions made 40 turns ago fall
 * out of the planner's reach. The rolling summary is the
 * durable, structured digest — one row per site (lead), keyed
 * exactly like every other chat store, so summaries can never
 * cross sites:
 *
 *   decisions      — what the owner decided (from classifier
 *                    settled facts + explicit plan choices)
 *   preferences    — standing owner preferences ("likes ...")
 *   settledStyle   — style dimensions settled (colour, type...)
 *   changesApplied — verified changes that landed, newest last
 *   openItems      — queued jobs + clarifications still open
 *
 * The merge is DETERMINISTIC — built from turn artifacts (the
 * classifier's settled facts, the plan's settled list, the
 * mode/mutation/queue outcome), never from a model's prose —
 * so every entry is traceable to the transcript message ids it
 * cites. A new fact on an already-settled dimension SUPERSEDES
 * the old entry (kept, marked superseded) instead of piling up
 * duplicates. The rendered context text is capped so the
 * summary stays a digest, not a second transcript.
 */

const MAX_RENDER_CHARS = 4000;
const CAPS = { decisions: 20, preferences: 12, settledStyle: 20, changesApplied: 12, openItems: 8 };
const STYLE_DIMENSION = /colou?r|font|typograph|theme|palette|tone|style|logo|layout|background|heading/i;

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS site_chat_summaries (
    lead_id INTEGER PRIMARY KEY,
    summary_json TEXT NOT NULL,
    last_msg_id INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

function emptySummary() {
  return { decisions: [], preferences: [], settledStyle: [], changesApplied: [], openItems: [] };
}

function getSummary(db, leadId) {
  ensureTable(db);
  const row = db.prepare('SELECT summary_json FROM site_chat_summaries WHERE lead_id = ?').get(Number(leadId));
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.summary_json || '');
    if (!parsed || typeof parsed !== 'object') return null;
    const out = emptySummary();
    for (const key of Object.keys(out)) {
      if (Array.isArray(parsed[key])) out[key] = parsed[key];
    }
    return out;
  } catch {
    return null;
  }
}

function saveSummary(db, leadId, summary, lastMsgId) {
  ensureTable(db);
  db.prepare(
    `INSERT INTO site_chat_summaries (lead_id, summary_json, last_msg_id, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET summary_json = excluded.summary_json,
       last_msg_id = excluded.last_msg_id, updated_at = datetime('now')`
  ).run(Number(leadId), JSON.stringify(summary), lastMsgId != null ? Number(lastMsgId) : null);
}

function dimensionOf(fact) {
  const text = String(fact || '');
  const idx = text.indexOf(':');
  return idx > 0 ? text.slice(0, idx).trim().toLowerCase() : null;
}

function upsertFact(list, fact, msgId) {
  const text = String(fact || '').trim();
  if (!text) return;
  const dim = dimensionOf(text);
  if (dim) {
    for (const entry of list) {
      if (entry.status === 'active' && dimensionOf(entry.text) === dim) {
        entry.status = 'superseded';
      }
    }
  }
  list.push({ text, msgId: msgId != null ? Number(msgId) : null, status: 'active' });
}



/**
 * Merge one completed turn into the site's summary.
 *   turn: { userText, userMsgId, assistantMsgId,
 *           settledFacts: [strings],
 *           mode, mutated, queuedJobId, reviewVerdict }
 * Queued-job open items resolve against design_jobs here too:
 * a queued job that has since been delivered moves to
 * changesApplied (checked every turn, cheap indexed read).
 */
function mergeTurn(db, leadId, turn = {}) {
  ensureTable(db);
  const summary = getSummary(db, leadId) || emptySummary();
  const userMsgId = turn.userMsgId != null ? Number(turn.userMsgId) : null;
  const assistantMsgId = turn.assistantMsgId != null ? Number(turn.assistantMsgId) : null;
  const userText = String(turn.userText || '').trim().slice(0, 160);

  for (const fact of Array.isArray(turn.settledFacts) ? turn.settledFacts : []) {
    const dim = dimensionOf(fact);
    if (dim && STYLE_DIMENSION.test(dim)) upsertFact(summary.settledStyle, fact, assistantMsgId || userMsgId);
    else if (dim && /prefer|like|always|never|want/i.test(dim)) upsertFact(summary.preferences, fact, assistantMsgId || userMsgId);
    else upsertFact(summary.decisions, fact, assistantMsgId || userMsgId);
  }
  trimList(summary.decisions, CAPS.decisions);
  trimList(summary.preferences, CAPS.preferences);
  trimList(summary.settledStyle, CAPS.settledStyle);

  // Resolve queued-job open items against their job rows.
  if (summary.openItems.some((e) => e.jobId)) {
    for (const item of summary.openItems) {
      if (!item.jobId || item.status !== 'active') continue;
      let job = null;
      try {
        job = db.prepare('SELECT status FROM design_jobs WHERE id = ?').get(item.jobId);
      } catch {
        job = null;
      }
      if (job && job.status === 'delivered') {
        item.status = 'superseded';
        summary.changesApplied.push({
          text: `Queued design job #${item.jobId} delivered: ${item.text.replace(/^Queued design job #\d+:\s*/, '')}`,
          msgId: item.msgId,
          status: 'active',
        });
      } else if (job && job.status === 'failed') {
        item.status = 'superseded';
      }
    }
  }

  if (turn.mode === 'build' && turn.mutated) {
    summary.changesApplied.push({
      text: `Change applied: ${userText || 'site change'}`,
      msgId: assistantMsgId,
      status: 'active',
      ...(turn.reviewVerdict ? { review: String(turn.reviewVerdict) } : {}),
    });
  }
  if (turn.mode === 'queued' && turn.queuedJobId) {
    summary.openItems.push({
      text: `Queued design job #${Number(turn.queuedJobId)}: ${userText || 'site change'}`,
      msgId: assistantMsgId,
      status: 'active',
      jobId: Number(turn.queuedJobId),
    });
  }
  if (turn.mode === 'clarify') {
    summary.openItems.push({
      text: `Waiting on the owner's answer: ${userText || 'clarification'}`,
      msgId: userMsgId,
      status: 'active',
      kind: 'clarify',
    });
  } else if (turn.mode === 'build' || turn.mode === 'queued' || turn.mode === 'answer') {
    // A resolved clarification closes its open item.
    for (const item of summary.openItems) {
      if (item.kind === 'clarify' && item.status === 'active') item.status = 'superseded';
    }
  }
  trimList(summary.changesApplied, CAPS.changesApplied);
  trimList(summary.openItems, CAPS.openItems);

  const lastMsgId = assistantMsgId || userMsgId;
  saveSummary(db, leadId, summary, lastMsgId);
  return summary;
}

function trimList(list, cap) {
  let active = list.filter((e) => e.status === 'active');
  while (active.length > cap) {
    const oldest = active[0];
    list.splice(list.indexOf(oldest), 1);
    active = list.filter((e) => e.status === 'active');
  }
  // Superseded audit entries: keep only the newest few.
  const superseded = list.filter((e) => e.status !== 'active');
  if (superseded.length > 6) {
    const drop = new Set(superseded.slice(0, superseded.length - 6));
    for (let i = list.length - 1; i >= 0; i--) {
      if (drop.has(list[i])) list.splice(i, 1);
    }
  }
}

const SECTIONS = [
  ['decisions', 'Decisions'],
  ['preferences', 'Preferences'],
  ['settledStyle', 'Settled style choices'],
  ['changesApplied', 'Changes applied'],
  ['openItems', 'Open items'],
];

/** The context block fed to classifier/planner/loop. '' when empty. */
function renderSummaryText(summary) {
  if (!summary) return '';
  const lines = [];
  for (const [key, label] of SECTIONS) {
    const active = (summary[key] || []).filter((e) => e.status === 'active');
    if (!active.length) continue;
    lines.push(`${label}:`);
    for (const entry of active) {
      lines.push(`- ${entry.text}${entry.msgId ? ` (msg #${entry.msgId})` : ''}`);
    }
  }
  if (!lines.length) return '';
  let text = lines.join('\n');
  if (text.length > MAX_RENDER_CHARS) {
    text = text.slice(0, MAX_RENDER_CHARS) + '\n…(summary trimmed)';
  }
  return text;
}

module.exports = {
  ensureTable,
  emptySummary,
  getSummary,
  saveSummary,
  mergeTurn,
  renderSummaryText,
  dimensionOf,
  MAX_RENDER_CHARS,
};
