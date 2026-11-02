// @ts-check
'use strict';

/**
 * Batch 117 — WordPress design editing v1: platform storage.
 *
 * Everything here is keyed by ONE wp_site_links registration (and
 * double-checked against its workspace): a site's census,
 * proposals, chat transcript and cap counter can never be read or
 * written through another registration — the hard per-site
 * isolation rule, applied to WordPress sites exactly as to
 * BitPype-hosted ones.
 *
 * Proposal lifecycle (approve-first, Ely's decision 2026-11-02):
 *   staged ──owner approves──▶ approved ──plugin applies+reports──▶ applied
 *     │                          │                                    │
 *     └──owner rejects──▶ rejected └──plugin reports failure──▶ apply_failed
 *   applied ──owner asks undo──▶ undo_requested ──plugin restores──▶ undone
 * A newer staged proposal supersedes an older still-staged one.
 * Nothing in this module ever writes to a WordPress site directly:
 * the plugin pulls work via /design/sync and reports results via
 * /design/report; the platform only records state.
 */

const crypto = require('node:crypto');

const db = require('./db');
const wpPlugin = require('./wpPlugin');
const ops = require('./wpDesignOps');
const chatUsage = require('./siteChatUsage');

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const CENSUS_MAX_BYTES = 120000;

function fail(code, message, status) {
  const e = /** @type {Error & { code?: string, status?: number }} */ (new Error(message));
  e.code = code;
  if (status) e.status = status;
  return e;
}

function sha256hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** 'YYYY-MM-DD HH:MM:SS' in UTC — sortable in both dialects. */
function utcStamp(when) {
  const d = when instanceof Date ? when : new Date(when);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    const v = JSON.parse(String(raw));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------------
// Census (the chat's site map, pushed by the plugin)
// ------------------------------------------------------------------

function sanitizeCensus(input) {
  if (!input || typeof input !== 'object') throw fail('INVALID', 'A census object is required', 400);
  for (const key of ['theme', 'site', 'design']) {
    if (
      input[key] !== undefined &&
      input[key] !== null &&
      (typeof input[key] !== 'object' || Array.isArray(input[key]))
    ) {
      throw fail('INVALID', `Census field ${key} must be an object`, 400);
    }
  }
  for (const key of ['pages', 'menus']) {
    if (input[key] !== undefined && !Array.isArray(input[key])) {
      throw fail('INVALID', `Census field ${key} must be a list`, 400);
    }
  }
  const clip = (v, n) =>
    String(v == null ? '' : v)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, n);
  const census = {
    wp_version: clip(input.wp_version, 20),
    generated_by: clip(input.generated_by, 40),
    theme: {
      name: clip(input.theme && input.theme.name, 120),
      version: clip(input.theme && input.theme.version, 30),
      stylesheet: clip(input.theme && input.theme.stylesheet, 80),
    },
    site: {
      title: clip(input.site && input.site.title, 160),
      tagline: clip(input.site && input.site.tagline, 200),
      logo_url: clip(input.site && input.site.logo_url, 500),
      timezone: clip(input.site && input.site.timezone, 60),
      home_url: clip(input.site && input.site.home_url, 500),
    },
    pages: [],
    menus: [],
    design: {
      version: Number(input.design && input.design.version) || 0,
      tokens: input.design && typeof input.design.tokens === 'object' && input.design.tokens ? input.design.tokens : {},
      zones: input.design && typeof input.design.zones === 'object' && input.design.zones ? input.design.zones : {},
    },
  };
  const builders = new Set(['gutenberg', 'elementor', 'divi', 'other', 'none']);
  for (const p of Array.isArray(input.pages) ? input.pages.slice(0, 120) : []) {
    if (!p || typeof p !== 'object') continue;
    census.pages.push({
      id: Number(p.id) || 0,
      title: clip(p.title, 140),
      url: clip(p.url, 500),
      builder: builders.has(String(p.builder || '')) ? String(p.builder) : 'none',
    });
  }
  for (const m of Array.isArray(input.menus) ? input.menus.slice(0, 20) : []) {
    if (!m || typeof m !== 'object') continue;
    census.menus.push({
      name: clip(m.name, 100),
      locations: (Array.isArray(m.locations) ? m.locations : []).map((l) => clip(l, 60)).slice(0, 8),
    });
  }
  // The design state rides along but is re-validated op by op when
  // a proposal is staged; here it only needs to be plain data.
  const json = JSON.stringify(census);
  if (json.length > CENSUS_MAX_BYTES) throw fail('INVALID', 'Census is too large', 413);
  return census;
}

async function storeCensus(row, input) {
  const census = sanitizeCensus(input);
  await db.query('UPDATE wp_site_links SET census_json = :json, census_at = UTC_TIMESTAMP() WHERE id = :id', {
    json: JSON.stringify(census),
    id: Number(row.id),
  });
  row.census_json = JSON.stringify(census);
  return census;
}

function censusOf(row) {
  return parseJson(row && row.census_json, null);
}

function censusStale(row) {
  if (!row || !row.census_at) return true;
  const at = Date.parse(String(row.census_at).replace(' ', 'T') + 'Z');
  return !Number.isFinite(at) || Date.now() - at > 10 * 60 * 1000;
}

// ------------------------------------------------------------------
// Proposals
// ------------------------------------------------------------------

async function findProposal(workspaceId, linkId, proposalId) {
  const rows = await db.query(
    'SELECT * FROM wp_design_proposals WHERE id = :id AND link_id = :link AND workspace_id = :ws LIMIT 1',
    { id: Number(proposalId), link: Number(linkId), ws: Number(workspaceId) }
  );
  return rows && rows[0] ? rows[0] : null;
}

function proposalView(row) {
  const opsList = parseJson(row.ops_json, []);
  return {
    id: Number(row.id),
    status: row.status,
    summary: row.summary || '',
    changes: (Array.isArray(opsList) ? opsList : []).map((op) => ops.describeOp(op)),
    verify: parseJson(row.verify_json, null),
    snapshotVersion: row.snapshot_version == null ? null : Number(row.snapshot_version),
    error: row.error || null,
    createdAt: row.created_at || null,
    decidedAt: row.decided_at || null,
    appliedAt: row.applied_at || null,
    undoneAt: row.undone_at || null,
  };
}

async function listProposals(workspaceId, linkId, limit = 50) {
  const rows = await db.query(
    `SELECT * FROM wp_design_proposals
      WHERE link_id = :link AND workspace_id = :ws ORDER BY id DESC LIMIT ${Math.min(100, Math.max(1, Number(limit) || 50))}`,
    { link: Number(linkId), ws: Number(workspaceId) }
  );
  return (rows || []).map(proposalView);
}

/**
 * Stage a proposal: the chat's validated result state + compiled
 * CSS are frozen on the row, a fresh preview token is minted, and
 * any older still-staged proposal for this registration is
 * superseded (its preview token dies with it).
 */
async function stageProposal(row, { opsList, tokens, zones, summary, verify }) {
  await db.query(
    `UPDATE wp_design_proposals SET status = 'superseded'
      WHERE link_id = :link AND status IN ('staged', 'apply_failed')`,
    { link: Number(row.id) }
  );
  const token = 'bpprev_' + crypto.randomBytes(24).toString('base64url');
  const info = await db.query(
    `INSERT INTO wp_design_proposals
       (link_id, workspace_id, status, ops_json, tokens_json, zones_json, css_text, summary, verify_json,
        preview_token_hash, preview_expires_at)
     VALUES (:link, :ws, 'staged', :ops, :tokens, :zones, :css, :summary, :verify, :thash, :texp)`,
    {
      link: Number(row.id),
      ws: Number(row.workspace_id),
      ops: JSON.stringify(opsList || []),
      tokens: JSON.stringify(tokens || {}),
      zones: JSON.stringify(zones || {}),
      css: ops.compileCss(tokens || {}),
      summary: String(summary || '').slice(0, 500),
      verify: verify ? JSON.stringify(verify) : null,
      thash: sha256hex(token),
      texp: utcStamp(new Date(Date.now() + PREVIEW_TTL_MS)),
    }
  );
  const id = Number(info && info.insertId ? info.insertId : 0);
  return { id, previewToken: token, previewUrl: previewUrlFor(row, token) };
}

function previewUrlFor(row, token) {
  const base = String(row.site_url || '').replace(/\/+$/, '');
  return base ? `${base}/?bitpype_preview=${encodeURIComponent(token)}` : null;
}

/** Refresh a staged/approved proposal's preview token (portal Preview click). */
async function mintPreview(row, proposalId) {
  const p = await findProposal(row.workspace_id, row.id, proposalId);
  if (!p) throw fail('NOT_FOUND', 'That proposal was not found', 404);
  if (!['staged', 'approved'].includes(p.status)) {
    throw fail('INVALID', 'Only a pending proposal can be previewed', 409);
  }
  const token = 'bpprev_' + crypto.randomBytes(24).toString('base64url');
  await db.query(
    'UPDATE wp_design_proposals SET preview_token_hash = :thash, preview_expires_at = :texp WHERE id = :id',
    { thash: sha256hex(token), texp: utcStamp(new Date(Date.now() + PREVIEW_TTL_MS)), id: Number(p.id) }
  );
  return { url: previewUrlFor(row, token), expiresAt: utcStamp(new Date(Date.now() + PREVIEW_TTL_MS)) };
}

/**
 * Plugin-side preview validation: the token must belong to THIS
 * registration, be unexpired, and point at a pending proposal.
 * Returns the staged state the plugin should render for this one
 * request; the live state is never touched.
 */
async function validatePreview(row, token) {
  const t = String(token || '').trim();
  if (!/^bpprev_[A-Za-z0-9_-]{16,64}$/.test(t)) return null;
  const rows = await db.query(
    'SELECT * FROM wp_design_proposals WHERE link_id = :link AND preview_token_hash = :thash LIMIT 1',
    { link: Number(row.id), thash: sha256hex(t) }
  );
  const p = rows && rows[0] ? rows[0] : null;
  if (!p) return null;
  if (!['staged', 'approved'].includes(p.status)) return null;
  const exp = Date.parse(String(p.preview_expires_at || '').replace(' ', 'T') + 'Z');
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return {
    proposalId: Number(p.id),
    tokens: parseJson(p.tokens_json, {}),
    zones: parseJson(p.zones_json, {}),
    css: p.css_text || '',
  };
}

async function decideProposal(workspaceId, linkId, proposalId, decision) {
  const p = await findProposal(workspaceId, linkId, proposalId);
  if (!p) throw fail('NOT_FOUND', 'That proposal was not found', 404);
  if (decision === 'approve') {
    if (p.status !== 'staged' && p.status !== 'apply_failed') {
      throw fail('INVALID', 'Only a pending proposal can be approved', 409);
    }
    await db.query(
      `UPDATE wp_design_proposals SET status = 'approved', decided_at = UTC_TIMESTAMP(), error = NULL WHERE id = :id`,
      { id: Number(p.id) }
    );
  } else if (decision === 'reject') {
    if (!['staged', 'approved', 'apply_failed'].includes(p.status)) {
      throw fail('INVALID', 'That proposal can no longer be rejected', 409);
    }
    await db.query(
      `UPDATE wp_design_proposals SET status = 'rejected', decided_at = UTC_TIMESTAMP(), preview_token_hash = NULL WHERE id = :id`,
      { id: Number(p.id) }
    );
  } else if (decision === 'undo') {
    if (p.status !== 'applied') throw fail('INVALID', 'Only an applied change can be undone', 409);
    await db.query(`UPDATE wp_design_proposals SET status = 'undo_requested' WHERE id = :id`, { id: Number(p.id) });
  }
  return findProposal(workspaceId, linkId, proposalId);
}

/** Record the critic's verdict on a proposal (chat path). */
async function updateProposalVerify(workspaceId, linkId, proposalId, verify) {
  await db.query(
    'UPDATE wp_design_proposals SET verify_json = :v WHERE id = :id AND link_id = :link AND workspace_id = :ws',
    {
      v: verify ? JSON.stringify(verify) : null,
      id: Number(proposalId),
      link: Number(linkId),
      ws: Number(workspaceId),
    }
  );
}

// ------------------------------------------------------------------
// Plugin sync + report (the plugin pulls work, reports results)
// ------------------------------------------------------------------

async function syncForSite(row) {
  const applyRows = await db.query(
    `SELECT * FROM wp_design_proposals WHERE link_id = :link AND status = 'approved' ORDER BY id ASC LIMIT 10`,
    { link: Number(row.id) }
  );
  const undoRows = await db.query(
    `SELECT id FROM wp_design_proposals WHERE link_id = :link AND status = 'undo_requested' ORDER BY id ASC LIMIT 10`,
    { link: Number(row.id) }
  );
  return {
    apply: (applyRows || []).map((p) => ({
      proposal_id: Number(p.id),
      ops: parseJson(p.ops_json, []),
      tokens: parseJson(p.tokens_json, {}),
      zones: parseJson(p.zones_json, {}),
      css: p.css_text || '',
    })),
    undo: (undoRows || []).map((p) => ({ proposal_id: Number(p.id) })),
    want_census: censusStale(row),
  };
}

async function reportFromSite(row, results) {
  const out = [];
  for (const r of Array.isArray(results) ? results.slice(0, 20) : []) {
    const id = Number(r && r.proposal_id) || 0;
    if (!id) continue;
    const p = await findProposal(row.workspace_id, row.id, id);
    if (!p) continue;
    const okFlag = !!(r && r.ok);
    const err = r && r.error ? String(r.error).slice(0, 500) : null;
    if (r.action === 'apply') {
      if (okFlag && p.status === 'approved') {
        await db.query(
          `UPDATE wp_design_proposals
              SET status = 'applied', applied_at = UTC_TIMESTAMP(),
                  snapshot_version = :sv, error = NULL, preview_token_hash = NULL
            WHERE id = :id`,
          { sv: r.snapshot_version == null ? null : Number(r.snapshot_version), id }
        );
      } else if (!okFlag && p.status === 'approved') {
        await db.query(`UPDATE wp_design_proposals SET status = 'apply_failed', error = :err WHERE id = :id`, {
          err: err || 'The plugin could not apply this change',
          id,
        });
      }
    } else if (r.action === 'undo') {
      if (okFlag && p.status === 'undo_requested') {
        await db.query(
          `UPDATE wp_design_proposals SET status = 'undone', undone_at = UTC_TIMESTAMP(), error = NULL WHERE id = :id`,
          { id }
        );
      } else if (!okFlag && p.status === 'undo_requested') {
        await db.query(`UPDATE wp_design_proposals SET status = 'applied', error = :err WHERE id = :id`, {
          err: err || 'The plugin could not undo this change',
          id,
        });
      }
    }
    const after = await findProposal(row.workspace_id, row.id, id);
    out.push({ proposal_id: id, status: after ? after.status : p.status });
  }
  return out;
}

// ------------------------------------------------------------------
// Per-registration chat store + daily cap counter
// ------------------------------------------------------------------

async function getChat(workspaceId, linkId) {
  const rows = await db.query('SELECT * FROM wp_design_chats WHERE link_id = :link AND workspace_id = :ws LIMIT 1', {
    link: Number(linkId),
    ws: Number(workspaceId),
  });
  const row = rows && rows[0] ? rows[0] : null;
  if (!row) return { transcript: [], summary: '', pending: null };
  return {
    transcript: parseJson(row.transcript_json, []),
    summary: row.summary || '',
    pending: parseJson(row.pending_json, null),
  };
}

async function saveChat(workspaceId, linkId, { transcript, summary, pending }) {
  const trimmed = (Array.isArray(transcript) ? transcript : []).slice(-200);
  const existing = await db.query('SELECT link_id FROM wp_design_chats WHERE link_id = :link LIMIT 1', {
    link: Number(linkId),
  });
  if (existing && existing[0]) {
    await db.query(
      `UPDATE wp_design_chats
          SET transcript_json = :t, summary = :s, pending_json = :p, updated_at = UTC_TIMESTAMP()
        WHERE link_id = :link AND workspace_id = :ws`,
      {
        t: JSON.stringify(trimmed),
        s: summary == null ? null : String(summary).slice(0, 4000),
        p: pending == null ? null : JSON.stringify(pending),
        link: Number(linkId),
        ws: Number(workspaceId),
      }
    );
  } else {
    await db.query(
      `INSERT INTO wp_design_chats (link_id, workspace_id, transcript_json, summary, pending_json)
       VALUES (:link, :ws, :t, :s, :p)`,
      {
        link: Number(linkId),
        ws: Number(workspaceId),
        t: JSON.stringify(trimmed),
        s: summary == null ? null : String(summary).slice(0, 4000),
        p: pending == null ? null : JSON.stringify(pending),
      }
    );
  }
}

/**
 * The Batch 97 cap, keyed by registration: same plan limit, same
 * count-first/refuse-without-counting semantics, per-site pool.
 * Day boundary uses the WP site's own timezone when the census
 * reported a valid one, else UTC (the Batch 97 fallback rule).
 *
 * @param {number} linkId
 * @param {{ limit?: number | null, timezone?: string | null }} [options]
 */
async function checkAndRecordUsage(linkId, { limit, timezone } = {}) {
  const tz = chatUsage.isValidTimezone(timezone) ? timezone : null;
  const day = chatUsage.dayKey(tz);
  if (limit == null) return { allowed: true, used: null, limit: null, day, timezone: tz };
  const rows = await db.query(
    'SELECT requests FROM wp_design_chat_usage WHERE link_id = :link AND day = :day LIMIT 1',
    {
      link: Number(linkId),
      day,
    }
  );
  const used = rows && rows[0] ? Number(rows[0].requests) || 0 : 0;
  if (used >= limit) return { allowed: false, used, limit, day, timezone: tz };
  await db.query(
    `INSERT INTO wp_design_chat_usage (link_id, day, requests) VALUES (:link, :day, 1)
     ON DUPLICATE KEY UPDATE requests = requests + 1, updated_at = UTC_TIMESTAMP()`,
    { link: Number(linkId), day }
  );
  return { allowed: true, used: used + 1, limit, day, timezone: tz };
}

/**
 * @param {number} linkId
 * @param {{ limit?: number | null, timezone?: string | null }} [options]
 */
async function getUsage(linkId, { limit, timezone } = {}) {
  const tz = chatUsage.isValidTimezone(timezone) ? timezone : null;
  const day = chatUsage.dayKey(tz);
  const rows = await db.query(
    'SELECT requests FROM wp_design_chat_usage WHERE link_id = :link AND day = :day LIMIT 1',
    {
      link: Number(linkId),
      day,
    }
  );
  return {
    used: limit == null ? null : rows && rows[0] ? Number(rows[0].requests) || 0 : 0,
    limit,
    day,
    timezone: tz || 'UTC',
  };
}

// ------------------------------------------------------------------
// Portal state view
// ------------------------------------------------------------------

/**
 * @param {number} workspaceId
 * @param {number} linkId
 * @param {{ limit?: number | null }} [options]
 */
async function designStateForPortal(workspaceId, linkId, { limit } = {}) {
  const link = await wpPlugin.findById(workspaceId, linkId);
  if (!link) throw fail('NOT_FOUND', 'That WordPress connection was not found', 404);
  const view = {
    id: Number(link.id),
    status: link.status,
    siteUrl: link.site_url || null,
    siteName: link.site_name || null,
    pluginVersion: link.plugin_version || null,
    designCapable: wpPlugin.designCapable(link),
    updateNeeded: link.status === 'connected' && !wpPlugin.designCapable(link),
    censusAt: link.census_at || null,
    census: null,
    proposals: [],
    chat: { messages: [], summary: '' },
    usage: null,
  };
  if (link.status !== 'connected' || !view.designCapable) return view;
  const census = censusOf(link);
  if (census) {
    view.census = {
      wpVersion: census.wp_version || '',
      theme: census.theme || {},
      site: census.site || {},
      pages: (census.pages || []).slice(0, 30),
      pageCount: (census.pages || []).length,
      builders: [...new Set((census.pages || []).map((p) => p.builder))],
      designVersion: census.design ? census.design.version || 0 : 0,
      tokens: census.design ? census.design.tokens || {} : {},
      zones: census.design ? Object.keys(census.design.zones || {}) : [],
    };
  }
  view.proposals = await listProposals(workspaceId, linkId, 50);
  const chat = await getChat(workspaceId, linkId);
  view.chat = {
    messages: chat.transcript.slice(-50),
    summary: chat.summary || '',
  };
  view.usage = await getUsage(linkId, {
    limit,
    timezone: census && census.site ? census.site.timezone : null,
  });
  return view;
}

module.exports = {
  PREVIEW_TTL_MS,
  sanitizeCensus,
  storeCensus,
  censusOf,
  censusStale,
  stageProposal,
  updateProposalVerify,
  mintPreview,
  validatePreview,
  decideProposal,
  listProposals,
  proposalView,
  findProposal,
  syncForSite,
  reportFromSite,
  getChat,
  saveChat,
  checkAndRecordUsage,
  getUsage,
  designStateForPortal,
  _internals: { utcStamp, sha256hex },
};
