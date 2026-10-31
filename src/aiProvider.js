'use strict';

/**
 * Batch 106 — AI provider attribution for the ai_usage ledger.
 *
 * Every AI call is logged to ai_usage (task, model, tokens, cost).
 * This module answers "which API actually served the call" so Admin
 * Finance can split spend by provider (Muse API, OpenAI, fal, …):
 *
 *   providerFromBaseUrl(url) — the provider that served a call is
 *     the host the call was actually sent to. Call sites derive the
 *     slug from the base URL they used, never from a configured
 *     default that a per-task/per-workspace route may have replaced.
 *
 *   providerFromModel(model) — BACKFILL ONLY. Derives a provider
 *     from a model name where the family is unambiguous (muse-* →
 *     muse, OpenAI families → openai, fal-ai/* → fal). Anything else
 *     returns 'unknown' — a row we cannot attribute honestly stays
 *     unknown; we never guess.
 *
 *   ensureAiUsageProvider(db) — idempotent column migration for a
 *     workspace (better-sqlite3) ai_usage table, following the
 *     codebase's PRAGMA-check + ALTER pattern. The backfill runs
 *     ONLY when the column was just added, so it can only ever touch
 *     rows that predate provider tracking — a row logged afterwards
 *     with provider 'unknown' (an unidentifiable route) is never
 *     rewritten by a later boot.
 */

const KNOWN_HOSTS = [
  [/^api\.openai\.com$/, 'openai'],
  [/^api\.meta\.ai$/, 'muse'],
  [/^api\.anthropic\.com$/, 'anthropic'],
  [/^api\.mistral\.ai$/, 'mistral'],
  [/^generativelanguage\.googleapis\.com$/, 'google'],
  [/^openrouter\.ai$/, 'openrouter'],
  [/(^|\.)fal\.ai$/, 'fal'],
  [/(^|\.)fal\.run$/, 'fal'],
];

function providerFromBaseUrl(baseUrl) {
  let host = '';
  try {
    host = new URL(String(baseUrl || '')).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  if (!host) return 'unknown';
  if (host === 'localhost' || host === '::1' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'local';
  for (const [re, slug] of KNOWN_HOSTS) {
    if (re.test(host)) return slug;
  }
  // Unknown public host: attribute to the host's own name (strip a
  // leading api./www. and take the first label) — e.g.
  // api.deepseek.com → 'deepseek', openrouter.ai → 'openrouter'.
  const bare = host.replace(/^(api|www)\./, '');
  const label = bare.split('.')[0].replace(/[^a-z0-9-]/g, '');
  return label || 'unknown';
}

function providerFromModel(model) {
  const m = String(model || '').trim().toLowerCase();
  if (!m) return 'unknown';
  if (m === 'muse' || m.startsWith('muse-') || m.startsWith('muse_')) return 'muse';
  if (m.startsWith('fal-ai/') || m.startsWith('fal-')) return 'fal';
  if (
    m.startsWith('gpt-') ||
    m.startsWith('gpt') ||
    m.startsWith('dall-e') ||
    m.startsWith('text-embedding-') ||
    m.startsWith('text-davinci') ||
    m.startsWith('text-moderation') ||
    m.startsWith('whisper-') ||
    m.startsWith('tts-') ||
    m.startsWith('chatgpt-') ||
    m.startsWith('codex-') ||
    /^o[134](-|$)/.test(m)
  ) {
    return 'openai';
  }
  return 'unknown';
}

/**
 * One-time, idempotent backfill: attribute every row in a DB whose
 * provider column has JUST been added (all such rows predate
 * tracking). Returns counts by outcome for proofs/reports.
 */
function backfillAiUsageProviders(db) {
  const rows = db.prepare('SELECT id, model FROM ai_usage').all();
  const byProvider = {};
  const upd = db.prepare('UPDATE ai_usage SET provider = ? WHERE id = ?');
  const tx = db.transaction((items) => {
    for (const r of items) {
      const p = providerFromModel(r.model);
      upd.run(p, r.id);
      byProvider[p] = (byProvider[p] || 0) + 1;
    }
  });
  tx(rows);
  return { total: rows.length, byProvider };
}

/**
 * Ensure ai_usage.provider exists on a better-sqlite3 handle.
 * Returns { added, backfill } — backfill is non-null only when the
 * column was added by this call (see header: backfill-on-add only).
 */
function ensureAiUsageProvider(db) {
  const out = { added: false, backfill: null };
  if (!db || typeof db.prepare !== 'function') return out;
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_usage'")
    .get();
  if (!hasTable) return out;
  const cols = db.prepare('PRAGMA table_info(ai_usage)').all().map((c) => c.name);
  if (cols.includes('provider')) return out;
  db.exec("ALTER TABLE ai_usage ADD COLUMN provider TEXT NOT NULL DEFAULT 'unknown'");
  out.added = true;
  out.backfill = backfillAiUsageProviders(db);
  return out;
}

module.exports = { providerFromBaseUrl, providerFromModel, backfillAiUsageProviders, ensureAiUsageProvider };
