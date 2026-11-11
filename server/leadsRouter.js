'use strict';

/**
 * Batch 178 — Leads Router module engine (Phase 1).
 *
 * The Router turns public "looking for …" posts on social platforms
 * into structured leads and routes them to the BitPype businesses
 * (Lead records) who follow that lead type + location. It is a
 * standard module in every mechanical respect (Ely's order): the
 * `leads_router` type is registered in server/siteModules.js like
 * every other type, this engine owns only its own tables, and all
 * cross-module flow rides the Batch 122 shared layer (see the
 * declaration in server/moduleShare.js).
 *
 * SHARED LAYER (spec §7):
 *   Shares    — published router leads as AGGREGATE demand counts
 *               (moduleShare declaration; never poster-level data),
 *               and, on claim, a LeadScout contact in the claiming
 *               lead's portal store via portalContacts'
 *               captureFromRouterClaim (stamped router_lead_id +
 *               platform + source_url).
 *   Consumes  — Lead records (a follow belongs to a Lead; no new
 *               account type), the module catalog/category labels as
 *               a suggestion seed for the select-or-type fields, and
 *               the portal feed + module badge as the in-app
 *               notification surface (no generic in-app notification
 *               store exists in the app; email/SMS prefs are STORED
 *               on the follow and sending rides the existing
 *               owner-notify plumbing only — no new sender here).
 *
 * INGESTION BOUNDARY (brief, hard): this file contains NO social
 * platform browsing, scraping or posting of any kind. Leads enter
 * only through publishLead() — called by the staff review queue,
 * the REST API and the MCP family, i.e. by Muse-app sweeps and
 * staff — and nothing reaches a subscriber feed until a candidate
 * passes the review queue (review_state 'published').
 *
 * REQUIRES MUSE (spec §15–16): the hunt runs in the Muse app.
 * Hunting status is DERIVED from router_sweeps records: no sweep
 * ever, or none within the settings window, reads as inactive and
 * follows stay 'waiting_on_muse'. Recording a sweep (the console /
 * router_sweeps.run check-in) is the only thing that flips them
 * active. Feed and management work regardless.
 */

const crypto = require('node:crypto');

const PLATFORMS = ['facebook', 'x', 'linkedin', 'tiktok', 'instagram'];
const PLATFORM_LABELS = {
  facebook: 'Facebook',
  x: 'X',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  instagram: 'Instagram',
};
const REQUEST_KINDS = ['service_request', 'recommendation_request', 'hiring', 'wanted_item', 'other'];
const SCORES = ['hot', 'warm', 'cold'];
const ACCESS_STATES = ['member', 'public', 'no_access', 'planned'];
const LIVE_ACCESS = ['member', 'public'];

function fail(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

/* ------------------------------------------------------------------ */
/* Normalization — select-or-type (spec §4/§5). Typed variants land   */
/* on one key; the as-typed label is always preserved on the row.     */
/* ------------------------------------------------------------------ */

const TYPE_ALIASES = {
  roofing: 'roofer',
  roof: 'roofer',
  roofer: 'roofer',
  roofers: 'roofer',
  plumbing: 'plumber',
  plumber: 'plumber',
  plumbers: 'plumber',
  electrical: 'electrician',
  electrician: 'electrician',
  electricians: 'electrician',
  cleaning: 'cleaner',
  cleaner: 'cleaner',
  cleaners: 'cleaner',
  painting: 'painter',
  painter: 'painter',
  painters: 'painter',
  landscaping: 'landscaper',
  landscaper: 'landscaper',
  landscapers: 'landscaper',
  photography: 'photographer',
  photographers: 'photographer',
  handyman: 'handyman',
  handymen: 'handyman',
  'general contractor': 'general contractor',
};

function singularWord(w) {
  if (w.length > 3 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 2 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function normalizeTypeKey(label) {
  const base = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  if (TYPE_ALIASES[base]) return TYPE_ALIASES[base];
  const sing = base.split(' ').map(singularWord).join(' ');
  return TYPE_ALIASES[sing] || sing;
}

function normalizeLocation(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(pa|pennsylvania)$/, '')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Tables (per-workspace, lazy-create like every batch table)          */
/* ------------------------------------------------------------------ */

const BERKS_FACEBOOK_SEED = [
  // Proven 2026-11-11 (spec §3): posts visible, sweeping account is a
  // member; 31 of the 85 genuine posts came from this one group.
  { name: 'Berks County PA Contractors Connections', access: 'member' },
  // Named public in the spec §3 survey list.
  { name: 'The Unofficial Berks County Business and Employment Forum', access: 'public' },
  // Surfaced 2026-11-11 but could not be opened by exact-name search —
  // seeded honestly as no_access; staff flip the state after joining.
  { name: 'Berks County Ask Us Anything', access: 'no_access' },
  { name: 'Berks County Pa Buy Sell Trade', access: 'no_access' },
  { name: 'Berks County Pa Jobs', access: 'no_access' },
  { name: 'Berks County Best Buys and Sells', access: 'no_access' },
  { name: 'Berks County Yard Sale', access: 'no_access' },
  { name: 'Berks County PA Employment: JOBS HIRING', access: 'no_access' },
  { name: 'Berks County Area Real Estate & Rentals', access: 'no_access' },
];

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS router_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      stale_service_hours INTEGER NOT NULL DEFAULT 48,
      stale_hiring_hours INTEGER NOT NULL DEFAULT 168,
      hunting_window_hours INTEGER NOT NULL DEFAULT 72,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS router_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      location_label TEXT NOT NULL DEFAULT '',
      location_norm TEXT NOT NULL DEFAULT '',
      query_text TEXT NOT NULL DEFAULT 'looking for',
      lead_types_json TEXT NOT NULL DEFAULT '[]',
      access_state TEXT NOT NULL DEFAULT 'planned',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS router_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      post_id TEXT NOT NULL DEFAULT '',
      dedupe_key TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_context TEXT NOT NULL DEFAULT '',
      poster_name TEXT NOT NULL DEFAULT '',
      posted_at TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      lead_type_key TEXT NOT NULL DEFAULT '',
      lead_type_label TEXT NOT NULL DEFAULT '',
      request_kind TEXT NOT NULL DEFAULT 'service_request',
      town TEXT NOT NULL DEFAULT '',
      town_norm TEXT NOT NULL DEFAULT '',
      area TEXT NOT NULL DEFAULT '',
      area_norm TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      score TEXT NOT NULL DEFAULT 'warm',
      score_reason TEXT NOT NULL DEFAULT '',
      review_state TEXT NOT NULL DEFAULT 'candidate',
      status TEXT NOT NULL DEFAULT 'new',
      claimed_by_lead_id INTEGER,
      claimed_at TEXT,
      sources_json TEXT NOT NULL DEFAULT '[]',
      sweep_run_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_router_leads_dedupe ON router_leads(dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_router_leads_feed ON router_leads(review_state, status, posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_router_leads_type ON router_leads(lead_type_key);
    CREATE TABLE IF NOT EXISTS router_follows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      lead_type_key TEXT NOT NULL DEFAULT '',
      lead_type_label TEXT NOT NULL DEFAULT '',
      location_label TEXT NOT NULL DEFAULT '',
      location_norm TEXT NOT NULL DEFAULT '',
      radius_miles INTEGER,
      platforms_json TEXT NOT NULL DEFAULT '["all"]',
      request_kinds_json TEXT NOT NULL DEFAULT '[]',
      notify_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'waiting_on_muse',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_router_follows_uniq
      ON router_follows(lead_id, lead_type_key, location_norm);
    CREATE INDEX IF NOT EXISTS idx_router_follows_lead ON router_follows(lead_id);
    CREATE TABLE IF NOT EXISTS router_sweeps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_arg TEXT NOT NULL,
      platforms_json TEXT NOT NULL DEFAULT '[]',
      scope_type_key TEXT NOT NULL DEFAULT '',
      scope_location_norm TEXT NOT NULL DEFAULT '',
      scope_lead_id INTEGER,
      run_by TEXT NOT NULL DEFAULT '',
      queries_json TEXT NOT NULL DEFAULT '[]',
      leads_found INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT OR IGNORE INTO router_settings (id) VALUES (1)').run();
  seedSources(db);
}

function seedSources(db) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM router_sources').get();
  if (row && row.c > 0) return;
  const ins = db.prepare(
    `INSERT INTO router_sources (platform, name, location_label, location_norm, query_text, lead_types_json, access_state, enabled)
     VALUES (?, ?, 'Berks County', 'berks county', 'looking for', '[]', ?, ?)`
  );
  for (const s of BERKS_FACEBOOK_SEED) ins.run('facebook', s.name, s.access, 1);
  // Spec §6 enablement rule: every other platform starts 'planned'
  // (visible as coming soon, never selectable alone, excluded from
  // ALL) until its own proof sweep flips a source live.
  for (const p of PLATFORMS) {
    if (p === 'facebook') continue;
    ins.run(p, `${PLATFORM_LABELS[p]} — Berks County (proof sweep pending)`, 'planned', 0);
  }
}

/* ------------------------------------------------------------------ */
/* Settings — stale windows are DATA, never hard-coded (brief §2).     */
/* ------------------------------------------------------------------ */

function getSettings(db) {
  ensureTables(db);
  const r = db.prepare('SELECT * FROM router_settings WHERE id = 1').get();
  return {
    stale_service_hours: Number(r.stale_service_hours) || 48,
    stale_hiring_hours: Number(r.stale_hiring_hours) || 168,
    hunting_window_hours: Number(r.hunting_window_hours) || 72,
  };
}

function updateSettings(db, patch = {}) {
  ensureTables(db);
  const cur = getSettings(db);
  const next = {
    stale_service_hours:
      patch.stale_service_hours != null ? Number(patch.stale_service_hours) : cur.stale_service_hours,
    stale_hiring_hours: patch.stale_hiring_hours != null ? Number(patch.stale_hiring_hours) : cur.stale_hiring_hours,
    hunting_window_hours:
      patch.hunting_window_hours != null ? Number(patch.hunting_window_hours) : cur.hunting_window_hours,
  };
  for (const [k, v] of Object.entries(next)) {
    if (!Number.isFinite(v) || v < 1 || v > 24 * 365)
      throw fail('VALIDATION', `${k} must be a positive number of hours`);
  }
  db.prepare(
    `UPDATE router_settings SET stale_service_hours = ?, stale_hiring_hours = ?, hunting_window_hours = ?, updated_at = datetime('now') WHERE id = 1`
  ).run(next.stale_service_hours, next.stale_hiring_hours, next.hunting_window_hours);
  return getSettings(db);
}

/* ------------------------------------------------------------------ */
/* Sources + platform liveness (spec §6)                               */
/* ------------------------------------------------------------------ */

function sourceShape(r) {
  if (!r) return null;
  let types = [];
  try {
    types = JSON.parse(r.lead_types_json || '[]');
  } catch {
    types = [];
  }
  return {
    id: Number(r.id),
    platform: r.platform,
    platform_label: PLATFORM_LABELS[r.platform] || r.platform,
    name: r.name || '',
    location_label: r.location_label || '',
    location_norm: r.location_norm || '',
    query_text: r.query_text || '',
    lead_types: Array.isArray(types) ? types : [],
    access_state: r.access_state,
    live: LIVE_ACCESS.includes(r.access_state) && Number(r.enabled) === 1,
    enabled: Number(r.enabled) === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function listSources(db, opts = {}) {
  ensureTables(db);
  let rows = db.prepare('SELECT * FROM router_sources ORDER BY platform ASC, id ASC').all();
  if (opts.platform) rows = rows.filter((r) => r.platform === opts.platform);
  return rows.map(sourceShape);
}

function updateSource(db, id, patch = {}) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM router_sources WHERE id = ?').get(Number(id));
  if (!row) throw fail('NOT_FOUND', 'Router source not found', 404);
  const next = {
    name: patch.name != null ? String(patch.name).slice(0, 200) : row.name,
    location_label: patch.location_label != null ? String(patch.location_label).slice(0, 120) : row.location_label,
    query_text: patch.query_text != null ? String(patch.query_text).slice(0, 200) : row.query_text,
    access_state: patch.access_state != null ? String(patch.access_state) : row.access_state,
    enabled: patch.enabled != null ? (patch.enabled ? 1 : 0) : row.enabled,
    lead_types_json:
      patch.lead_types != null
        ? JSON.stringify(
            (Array.isArray(patch.lead_types) ? patch.lead_types : []).map((t) => normalizeTypeKey(t)).filter(Boolean)
          )
        : row.lead_types_json,
  };
  if (!ACCESS_STATES.includes(next.access_state)) {
    throw fail('VALIDATION', `access_state must be one of ${ACCESS_STATES.join('|')}`);
  }
  const locNorm = patch.location_label != null ? normalizeLocation(next.location_label) : row.location_norm;
  db.prepare(
    `UPDATE router_sources SET name = ?, location_label = ?, location_norm = ?, query_text = ?, lead_types_json = ?, access_state = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    next.name,
    next.location_label,
    locNorm,
    next.query_text,
    next.lead_types_json,
    next.access_state,
    next.enabled,
    Number(id)
  );
  return sourceShape(db.prepare('SELECT * FROM router_sources WHERE id = ?').get(Number(id)));
}

/** A platform is LIVE only when an enabled source the sweeping
 *  account can actually read exists (member|public). 'planned' and
 *  'no_access' platforms never match, never get swept (spec §6). */
function livePlatforms(db) {
  ensureTables(db);
  const rows = db
    .prepare("SELECT DISTINCT platform FROM router_sources WHERE enabled = 1 AND access_state IN ('member', 'public')")
    .all();
  const live = new Set(rows.map((r) => r.platform));
  return PLATFORMS.filter((p) => live.has(p));
}

function platformStates(db) {
  const live = new Set(livePlatforms(db));
  return PLATFORMS.map((p) => ({ platform: p, label: PLATFORM_LABELS[p], live: live.has(p) }));
}

/* ------------------------------------------------------------------ */
/* Follows (spec §4 step 3 / §5) — select-or-type. A follow is a plan  */
/* add-on record (brief D2): bookkeeping only, NO charging code.       */
/* ------------------------------------------------------------------ */

function parseJsonArr(v, fallback) {
  try {
    const a = JSON.parse(v || '');
    return Array.isArray(a) ? a : fallback;
  } catch {
    return fallback;
  }
}

function followShape(db, r) {
  if (!r) return null;
  const platforms = parseJsonArr(r.platforms_json, ['all']);
  return {
    id: Number(r.id),
    lead_id: Number(r.lead_id),
    lead_type_key: r.lead_type_key,
    lead_type_label: r.lead_type_label,
    location_label: r.location_label,
    location_norm: r.location_norm,
    radius_miles: r.radius_miles != null ? Number(r.radius_miles) : null,
    platforms,
    platforms_all: platforms.includes('all'),
    request_kinds: parseJsonArr(r.request_kinds_json, []),
    notify: (() => {
      try {
        return JSON.parse(r.notify_json || '{}') || {};
      } catch {
        return {};
      }
    })(),
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function validatePlatformSelection(db, platforms) {
  const live = new Set(livePlatforms(db));
  const specific = platforms.filter((p) => p !== 'all');
  for (const p of specific) {
    if (!PLATFORMS.includes(p)) throw fail('VALIDATION', `unknown platform: ${p}`);
  }
  // Spec §6: a planned platform "cannot be selected alone" — a follow
  // naming ONLY not-yet-live platforms could never match anything.
  if (specific.length && specific.every((p) => !live.has(p))) {
    throw fail(
      'VALIDATION',
      `None of those platforms is live yet (${specific.map((p) => PLATFORM_LABELS[p]).join(', ')} is coming soon) — follow ALL or a live platform.`
    );
  }
  return specific.length ? specific : ['all'];
}

function setFollow(db, leadId, input = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  if (!lid) throw fail('VALIDATION', 'leadId is required');
  const typeLabel = String(input.lead_type_label || input.lead_type || '')
    .trim()
    .slice(0, 120);
  const typeKey = normalizeTypeKey(input.lead_type_key || typeLabel);
  if (!typeKey) throw fail('VALIDATION', 'a lead type is required (select one or type your own)');
  const locLabel = String(input.location_label || input.location || '')
    .trim()
    .slice(0, 120);
  const locNorm = normalizeLocation(input.location_norm || locLabel);
  if (!locNorm) throw fail('VALIDATION', 'a location is required (select one or type your own)');
  let platforms = ['all'];
  if (Array.isArray(input.platforms) && input.platforms.length) {
    platforms = validatePlatformSelection(
      db,
      input.platforms.map((p) => String(p).toLowerCase())
    );
  } else if (input.platforms === 'all' || input.platform == null) {
    platforms = ['all'];
  }
  const kinds = Array.isArray(input.request_kinds)
    ? input.request_kinds.map((k) => String(k)).filter((k) => REQUEST_KINDS.includes(k))
    : [];
  const radius =
    input.radius_miles != null && Number(input.radius_miles) > 0 ? Math.min(500, Number(input.radius_miles)) : null;
  const notify = input.notify && typeof input.notify === 'object' ? input.notify : {};
  const hunting = huntingStatus(db);
  const status = hunting.active ? 'active' : 'waiting_on_muse';
  const existing = db
    .prepare('SELECT * FROM router_follows WHERE lead_id = ? AND lead_type_key = ? AND location_norm = ?')
    .get(lid, typeKey, locNorm);
  if (existing) {
    db.prepare(
      `UPDATE router_follows SET lead_type_label = ?, location_label = ?, radius_miles = ?, platforms_json = ?, request_kinds_json = ?, notify_json = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      typeLabel || existing.lead_type_label,
      locLabel || existing.location_label,
      radius,
      JSON.stringify(platforms),
      JSON.stringify(kinds),
      JSON.stringify(notify),
      status,
      existing.id
    );
    return {
      follow: followShape(db, db.prepare('SELECT * FROM router_follows WHERE id = ?').get(existing.id)),
      created: false,
    };
  }
  const info = db
    .prepare(
      `INSERT INTO router_follows (lead_id, lead_type_key, lead_type_label, location_label, location_norm, radius_miles, platforms_json, request_kinds_json, notify_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lid,
      typeKey,
      typeLabel,
      locLabel,
      locNorm,
      radius,
      JSON.stringify(platforms),
      JSON.stringify(kinds),
      JSON.stringify(notify),
      status
    );
  return {
    follow: followShape(db, db.prepare('SELECT * FROM router_follows WHERE id = ?').get(info.lastInsertRowid)),
    created: true,
  };
}

function listFollows(db, leadId) {
  ensureTables(db);
  return db
    .prepare('SELECT * FROM router_follows WHERE lead_id = ? ORDER BY id ASC')
    .all(Number(leadId))
    .map((r) => followShape(db, r));
}

function deleteFollow(db, leadId, followId) {
  ensureTables(db);
  const info = db
    .prepare('DELETE FROM router_follows WHERE id = ? AND lead_id = ?')
    .run(Number(followId), Number(leadId));
  if (!info.changes) throw fail('NOT_FOUND', 'Follow not found', 404);
  return { deleted: true, id: Number(followId) };
}

/** Known types/locations for the select-or-type pickers: built from
 *  real leads + real follows, never a fixed taxonomy (spec §5). The
 *  app category list only SEEDS suggestions (consumed, §7) — callers
 *  may merge their own seed labels; matching never depends on it. */
function knownTypes(db) {
  ensureTables(db);
  const map = new Map();
  for (const r of db.prepare('SELECT lead_type_key, lead_type_label FROM router_leads').all()) {
    if (r.lead_type_key && !map.has(r.lead_type_key)) map.set(r.lead_type_key, r.lead_type_label || r.lead_type_key);
  }
  for (const r of db.prepare('SELECT lead_type_key, lead_type_label FROM router_follows').all()) {
    if (r.lead_type_key && !map.has(r.lead_type_key)) map.set(r.lead_type_key, r.lead_type_label || r.lead_type_key);
  }
  return [...map.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function knownLocations(db) {
  ensureTables(db);
  const map = new Map();
  const add = (norm, label) => {
    if (norm && !map.has(norm)) map.set(norm, label || norm);
  };
  for (const r of db.prepare('SELECT town, town_norm, area, area_norm FROM router_leads').all()) {
    add(r.town_norm, r.town);
    add(r.area_norm, r.area);
  }
  for (const r of db.prepare('SELECT location_label, location_norm FROM router_follows').all())
    add(r.location_norm, r.location_label);
  for (const r of db.prepare('SELECT location_label, location_norm FROM router_sources').all())
    add(r.location_norm, r.location_label);
  return [...map.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/* ------------------------------------------------------------------ */
/* Sweeps + hunting status (spec §4 step 1, §15–16). A sweep record   */
/* is a CHECK-IN: Muse (or staff) records that a hunt ran, on which  */
/* platform(s), with what scope. This module never browses anything.  */
/* ------------------------------------------------------------------ */

function sweepQueriesFor(db, { typeKey = '', locationNorm = '' } = {}) {
  // Queries are driven by what users actually follow (spec §4): each
  // active follow generates its per-platform sweep queries, plus one
  // general pass per covered location to discover new types.
  const follows = db
    .prepare("SELECT * FROM router_follows WHERE status IN ('active', 'waiting_on_muse') ORDER BY id ASC")
    .all();
  const seen = new Set();
  const queries = [];
  const push = (q) => {
    const key = `${q.platform}|${q.query}|${q.location_norm}`;
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(q);
  };
  const live = livePlatforms(db);
  for (const f of follows) {
    if (typeKey && f.lead_type_key !== typeKey) continue;
    if (locationNorm && f.location_norm !== locationNorm) continue;
    const wanted = parseJsonArr(f.platforms_json, ['all']);
    const plats = wanted.includes('all') ? live : wanted.filter((p) => live.includes(p));
    for (const p of plats) {
      push({
        platform: p,
        query: `looking for ${f.lead_type_label || f.lead_type_key}`,
        lead_type_key: f.lead_type_key,
        location_norm: f.location_norm,
        follow_id: Number(f.id),
      });
      push({
        platform: p,
        query: `looking for recommendations ${f.lead_type_label || f.lead_type_key} ${f.location_label || ''}`.trim(),
        lead_type_key: f.lead_type_key,
        location_norm: f.location_norm,
        follow_id: Number(f.id),
      });
    }
  }
  return queries;
}

function recordSweep(db, input = {}) {
  ensureTables(db);
  const arg = String(input.platform || '')
    .toLowerCase()
    .trim();
  if (![...PLATFORMS, 'all'].includes(arg)) {
    throw fail('VALIDATION', `platform is required and must be one of ${[...PLATFORMS, 'all'].join('|')}`);
  }
  const live = livePlatforms(db);
  // A specific-platform sweep touches only that platform, and only
  // when it is live; ALL covers every live platform, never a planned
  // one (spec §13 platform scope).
  let covered;
  if (arg === 'all') covered = live;
  else {
    if (!live.includes(arg)) {
      throw fail(
        'VALIDATION',
        `${PLATFORM_LABELS[arg]} is not live yet (no readable source) — a sweep cannot cover it.`
      );
    }
    covered = [arg];
  }
  const typeKey =
    input.lead_type_key || input.lead_type ? normalizeTypeKey(input.lead_type_key || input.lead_type) : '';
  const locNorm = input.location
    ? normalizeLocation(input.location)
    : input.location_norm
      ? normalizeLocation(input.location_norm)
      : '';
  const queries = sweepQueriesFor(db, { typeKey, locationNorm: locNorm }).filter((q) => covered.includes(q.platform));
  const info = db
    .prepare(
      `INSERT INTO router_sweeps (platform_arg, platforms_json, scope_type_key, scope_location_norm, scope_lead_id, run_by, queries_json, leads_found)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      arg,
      JSON.stringify(covered),
      typeKey,
      locNorm,
      input.lead_id != null ? Number(input.lead_id) : null,
      String(input.run_by || 'muse').slice(0, 120),
      JSON.stringify(queries),
      Number(input.leads_found) || 0
    );
  const sweep = sweepShape(db.prepare('SELECT * FROM router_sweeps WHERE id = ?').get(info.lastInsertRowid));
  // The first recorded sweep wakes every waiting follow (spec §16:
  // follows are 'waiting_on_muse' UNTIL the first sweep runs).
  db.prepare(
    "UPDATE router_follows SET status = 'active', updated_at = datetime('now') WHERE status = 'waiting_on_muse'"
  ).run();
  return { sweep, queries };
}

function sweepShape(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    platform_arg: r.platform_arg,
    platforms: parseJsonArr(r.platforms_json, []),
    scope_type_key: r.scope_type_key || '',
    scope_location_norm: r.scope_location_norm || '',
    scope_lead_id: r.scope_lead_id != null ? Number(r.scope_lead_id) : null,
    run_by: r.run_by || '',
    queries: parseJsonArr(r.queries_json, []),
    leads_found: Number(r.leads_found) || 0,
    created_at: r.created_at,
  };
}

function listSweeps(db, opts = {}) {
  ensureTables(db);
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
  return db.prepare('SELECT * FROM router_sweeps ORDER BY id DESC LIMIT ?').all(limit).map(sweepShape);
}

function huntingStatus(db, now = new Date()) {
  ensureTables(db);
  const settings = getSettings(db);
  const last = db.prepare('SELECT * FROM router_sweeps ORDER BY id DESC LIMIT 1').get();
  if (!last) {
    return {
      active: false,
      state: 'never',
      label: 'Hunting inactive — connect Muse to start finding leads',
      last_sweep_at: null,
      last_sweep: null,
      window_hours: settings.hunting_window_hours,
    };
  }
  const lastAt = new Date(String(last.created_at).replace(' ', 'T') + 'Z');
  const ageH = (now.getTime() - lastAt.getTime()) / 36e5;
  const active = ageH <= settings.hunting_window_hours;
  return {
    active,
    state: active ? 'active' : 'stale',
    label: active ? 'Hunting active' : 'Hunting inactive — connect Muse to start finding leads',
    last_sweep_at: last.created_at,
    last_sweep: sweepShape(last),
    window_hours: settings.hunting_window_hours,
  };
}

/** Spec §16 activation checklist — step 1 of activation, in the open. */
function activationChecklist(db) {
  const hunting = huntingStatus(db);
  const sources = listSources(db);
  const memberSources = sources.filter((s) => s.access_state === 'member' || s.access_state === 'public');
  return {
    requires_claude: true,
    badge: 'Requires Muse',
    disclosure:
      'Leads Router finds leads by having Muse search social media for you, signed in as you. Without Muse connected, the module can show and manage leads, but no new leads are hunted.',
    steps: [
      { key: 'connect_claude', label: 'Connect Muse', done: hunting.state !== 'never' },
      { key: 'sign_in', label: 'Sign Muse into the platforms you will hunt', done: memberSources.length > 0 },
      {
        key: 'join_groups',
        label: 'Join the groups you want covered',
        done: sources.some((s) => s.access_state === 'member'),
      },
    ],
    hunting,
  };
}

/* ------------------------------------------------------------------ */
/* Leads (spec §5). Dedupe: platform + post id, falling back to       */
/* poster + normalized-text hash. The same request cross-posted to a  */
/* second platform MERGES into the one lead, sources carrying both.   */
/* ------------------------------------------------------------------ */

function textHash(s) {
  return crypto
    .createHash('sha256')
    .update(String(s || ''))
    .digest('hex')
    .slice(0, 24);
}

function dedupeKeyFor(input) {
  const platform = String(input.platform || '').toLowerCase();
  const postId = String(input.post_id || input.postId || '').trim();
  if (postId) return `${platform}:${postId}`;
  const poster = String(input.poster_name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const text = String(input.detail || input.text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `hash:${textHash(`${poster}|${text}`)}`;
}

function leadShape(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    platform: r.platform,
    platform_label: PLATFORM_LABELS[r.platform] || r.platform,
    post_id: r.post_id || '',
    dedupe_key: r.dedupe_key,
    source_url: r.source_url,
    source_context: r.source_context || '',
    sources: parseJsonArr(r.sources_json, []),
    poster_name: r.poster_name || '',
    posted_at: r.posted_at,
    first_seen_at: r.first_seen_at,
    lead_type_key: r.lead_type_key,
    lead_type_label: r.lead_type_label || '',
    request_kind: r.request_kind,
    town: r.town || '',
    area: r.area || '',
    detail: r.detail || '',
    score: r.score,
    score_reason: r.score_reason || '',
    review_state: r.review_state,
    status: r.status,
    claimed_by_lead_id: r.claimed_by_lead_id != null ? Number(r.claimed_by_lead_id) : null,
    claimed_at: r.claimed_at,
    sweep_run_id: r.sweep_run_id != null ? Number(r.sweep_run_id) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function getLead(db, id) {
  ensureTables(db);
  return leadShape(db.prepare('SELECT * FROM router_leads WHERE id = ?').get(Number(id)));
}

/**
 * Ingest one found post. Default lands as a review CANDIDATE —
 * nothing reaches a feed until the queue publishes it (spec §4).
 * Callers with `publish: true` (the queue's own publish action, the
 * MCP publish tool) skip the candidate stage deliberately.
 * Returns { lead, created, merged } — a repeat of the same post is
 * the same lead, forever (the dedupe UNIQUE index is the guarantee).
 */
function publishLead(db, input = {}, opts = {}) {
  ensureTables(db);
  const platform = String(input.platform || '').toLowerCase();
  if (!PLATFORMS.includes(platform)) throw fail('VALIDATION', `platform must be one of ${PLATFORMS.join('|')}`);
  const sourceUrl = String(input.source_url || input.sourceUrl || '').trim();
  if (!sourceUrl)
    throw fail('VALIDATION', 'source_url is required — a lead never exists without its original post link');
  const typeLabel = String(input.lead_type_label || input.lead_type || '')
    .trim()
    .slice(0, 120);
  const typeKey = normalizeTypeKey(input.lead_type_key || typeLabel);
  if (!typeKey) throw fail('VALIDATION', 'a lead type is required');
  const kind = REQUEST_KINDS.includes(input.request_kind) ? input.request_kind : 'service_request';
  const score = SCORES.includes(input.score) ? input.score : 'warm';
  const key = dedupeKeyFor({ ...input, platform });
  const sourceEntry = {
    platform,
    source_url: sourceUrl,
    source_context: String(input.source_context || '').slice(0, 200),
    post_id: String(input.post_id || input.postId || ''),
  };

  const existing = db.prepare('SELECT * FROM router_leads WHERE dedupe_key = ?').get(key);
  if (existing) {
    // A REMOVED lead never re-enters (spec §9): the dedupe key is
    // kept precisely so a later sweep of the same post is a no-op.
    if (existing.status === 'removed') {
      return { lead: leadShape(existing), created: false, merged: false, blocked_removed: true };
    }
    // Cross-platform merge (spec §5): the fallback dedupe key is
    // poster + normalized text with NO platform in it, so the same
    // request cross-posted to a second platform lands HERE — one
    // lead, and the sources list gains the second platform's link.
    if (existing.platform !== platform) {
      const sources = parseJsonArr(existing.sources_json, []);
      if (!sources.some((s) => s.source_url === sourceUrl)) {
        sources.push(sourceEntry);
        db.prepare("UPDATE router_leads SET sources_json = ?, updated_at = datetime('now') WHERE id = ?").run(
          JSON.stringify(sources),
          existing.id
        );
      }
      return { lead: getLead(db, existing.id), created: false, merged: true };
    }
    return { lead: leadShape(existing), created: false, merged: false };
  }

  const town = String(input.town || '').slice(0, 120);
  const area = String(input.area || '').slice(0, 120);
  const reviewState = opts.publish || input.publish ? 'published' : 'candidate';
  const info = db
    .prepare(
      `INSERT INTO router_leads (platform, post_id, dedupe_key, source_url, source_context, poster_name, posted_at,
        lead_type_key, lead_type_label, request_kind, town, town_norm, area, area_norm, detail, score, score_reason,
        review_state, sources_json, sweep_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      platform,
      String(input.post_id || input.postId || ''),
      key,
      sourceUrl,
      String(input.source_context || '').slice(0, 200),
      String(input.poster_name || '').slice(0, 200),
      input.posted_at ? String(input.posted_at) : null,
      typeKey,
      typeLabel,
      kind,
      town,
      normalizeLocation(town),
      area,
      normalizeLocation(area),
      String(input.detail || input.text || '').slice(0, 4000),
      score,
      String(input.score_reason || '').slice(0, 500),
      reviewState,
      JSON.stringify([sourceEntry]),
      input.sweep_run_id != null ? Number(input.sweep_run_id) : null
    );
  return { lead: getLead(db, info.lastInsertRowid), created: true, merged: false };
}

/* ------------------------- review queue --------------------------- */

function listCandidates(db, opts = {}) {
  ensureTables(db);
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
  return db
    .prepare("SELECT * FROM router_leads WHERE review_state = 'candidate' ORDER BY first_seen_at DESC, id DESC LIMIT ?")
    .all(limit)
    .map(leadShape);
}

/** Queue decision: publish (optionally with edits) or reject. Only a
 *  published lead can ever match a follow (the §4 gate). */
function reviewLead(db, id, decision = {}) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM router_leads WHERE id = ?').get(Number(id));
  if (!row) throw fail('NOT_FOUND', 'Router lead not found', 404);
  const action = String(decision.action || '').toLowerCase();
  if (action === 'reject') {
    db.prepare("UPDATE router_leads SET review_state = 'rejected', updated_at = datetime('now') WHERE id = ?").run(
      row.id
    );
    return { lead: getLead(db, row.id), published: false };
  }
  if (action !== 'publish') throw fail('VALIDATION', "action must be 'publish' or 'reject'");
  const patch = decision.patch || decision;
  const sets = ["review_state = 'published'", "updated_at = datetime('now')"];
  const params = [];
  const setIf = (col, val) => {
    sets.push(`${col} = ?`);
    params.push(val);
  };
  if (patch.lead_type_label || patch.lead_type) {
    setIf('lead_type_label', String(patch.lead_type_label || patch.lead_type).slice(0, 120));
    setIf('lead_type_key', normalizeTypeKey(patch.lead_type_label || patch.lead_type));
  }
  if (patch.request_kind && REQUEST_KINDS.includes(patch.request_kind)) setIf('request_kind', patch.request_kind);
  if (patch.town != null) {
    setIf('town', String(patch.town).slice(0, 120));
    setIf('town_norm', normalizeLocation(patch.town));
  }
  if (patch.area != null) {
    setIf('area', String(patch.area).slice(0, 120));
    setIf('area_norm', normalizeLocation(patch.area));
  }
  if (patch.detail != null) setIf('detail', String(patch.detail).slice(0, 4000));
  if (patch.score && SCORES.includes(patch.score)) setIf('score', patch.score);
  if (patch.score_reason != null) setIf('score_reason', String(patch.score_reason).slice(0, 500));
  params.push(row.id);
  db.prepare(`UPDATE router_leads SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return { lead: getLead(db, row.id), published: true };
}

/** Removal (spec §9): one action, out of every feed, and the dedupe
 *  key is KEPT so the same post can never re-enter. */
function removeLead(db, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM router_leads WHERE id = ?').get(Number(id));
  if (!row) throw fail('NOT_FOUND', 'Router lead not found', 404);
  db.prepare("UPDATE router_leads SET status = 'removed', updated_at = datetime('now') WHERE id = ?").run(row.id);
  return { lead: getLead(db, row.id), removed: true };
}

function listLeads(db, opts = {}) {
  ensureTables(db);
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
  let rows = db.prepare('SELECT * FROM router_leads ORDER BY COALESCE(posted_at, first_seen_at) DESC, id DESC').all();
  if (opts.review_state) rows = rows.filter((r) => r.review_state === opts.review_state);
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  if (opts.request_kind) rows = rows.filter((r) => r.request_kind === opts.request_kind);
  if (opts.platform) rows = rows.filter((r) => r.platform === opts.platform);
  return rows.slice(0, limit).map((r) => withFreshness(db, r));
}

/* ------------------------- freshness ------------------------------ */

/** Freshness runs on posted_at, NEVER first_seen_at (spec §5): an
 *  old post found by a new sweep is already stale. */
function freshnessOf(db, row, now = new Date()) {
  const settings = getSettings(db);
  const windowH = row.request_kind === 'hiring' ? settings.stale_hiring_hours : settings.stale_service_hours;
  const posted = row.posted_at ? new Date(String(row.posted_at).replace(' ', 'T')) : null;
  const ageH = posted && !Number.isNaN(posted.getTime()) ? (now.getTime() - posted.getTime()) / 36e5 : null;
  const stale = ageH != null && ageH > windowH;
  return { age_hours: ageH != null ? Math.round(ageH * 10) / 10 : null, stale, window_hours: windowH };
}

function withFreshness(db, row, now) {
  const lead = leadShape(row);
  const f = freshnessOf(db, row, now);
  lead.age_hours = f.age_hours;
  lead.effective_status = row.status === 'new' && f.stale ? 'stale' : row.status;
  lead.stale_window_hours = f.window_hours;
  return lead;
}

/** Persist stale markings (status new → stale past the window). */
function markStale(db, now = new Date()) {
  ensureTables(db);
  let marked = 0;
  for (const r of db.prepare("SELECT * FROM router_leads WHERE status = 'new' AND review_state = 'published'").all()) {
    if (freshnessOf(db, r, now).stale) {
      db.prepare("UPDATE router_leads SET status = 'stale', updated_at = datetime('now') WHERE id = ?").run(r.id);
      marked++;
    }
  }
  return { marked };
}

/* ------------------------------------------------------------------ */
/* Routing + feed (spec §4 step 4). A published lead matches a follow */
/* when: lead type keys equal, the follow's location covers the      */
/* lead's town OR area, the follow's platform option includes the    */
/* lead's platform (ALL = every LIVE platform — a planned platform   */
/* never matches), and the follow's kind filter (empty = all)        */
/* includes the lead's request kind.                                  */
/* ------------------------------------------------------------------ */

function followMatchesLead(db, follow, lead) {
  if (follow.lead_type_key !== lead.lead_type_key) return false;
  const locs = [lead.town_norm, lead.area_norm].filter(Boolean);
  if (!locs.includes(follow.location_norm)) return false;
  const platforms = parseJsonArr(follow.platforms_json, ['all']);
  if (platforms.includes('all')) {
    if (!livePlatforms(db).includes(lead.platform)) return false;
  } else if (!platforms.includes(lead.platform)) {
    return false;
  }
  const kinds = parseJsonArr(follow.request_kinds_json, []);
  if (kinds.length && !kinds.includes(lead.request_kind)) return false;
  return true;
}

function matchingFollows(db, leadRow) {
  return db
    .prepare('SELECT * FROM router_follows')
    .all()
    .filter((f) => followMatchesLead(db, f, leadRow));
}

/** One business's feed: published, fresh-or-claimed-by-me leads that
 *  match at least one of its follows. Exclusive-claimed leads leave
 *  every other feed the moment they are claimed (spec §4 step 5). */
function feedForLead(db, leadId, opts = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const follows = db.prepare('SELECT * FROM router_follows WHERE lead_id = ?').all(lid);
  if (!follows.length) return [];
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 100));
  const rows = db
    .prepare(
      "SELECT * FROM router_leads WHERE review_state = 'published' AND status != 'removed' ORDER BY COALESCE(posted_at, first_seen_at) DESC, id DESC"
    )
    .all();
  const out = [];
  for (const r of rows) {
    const mine = r.claimed_by_lead_id != null && Number(r.claimed_by_lead_id) === lid;
    if (r.status === 'claimed' && !mine) continue;
    const shaped = withFreshness(db, r);
    if (shaped.effective_status === 'stale' && !mine) continue;
    if (!follows.some((f) => followMatchesLead(db, f, r))) continue;
    shaped.claimed_by_me = mine;
    out.push(shaped);
    if (out.length >= limit) break;
  }
  return out;
}

function countFeedForLead(db, leadId) {
  try {
    return feedForLead(db, leadId).filter((l) => !l.claimed_by_me).length;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Claim (spec §4 step 5 / §8 model 3, bookkeeping only in Phase 1).  */
/* Exactly-once: the claim is a conditional UPDATE that only lands   */
/* while the lead is unclaimed; a double-tap/retry sees the stamped  */
/* row and records nothing twice. NO charging code (brief D2). On    */
/* claim, the poster lands in the claimer's LeadScout contacts via   */
/* the shared layer, stamped with router_lead_id + platform + URL.   */
/* ------------------------------------------------------------------ */

function claimLead(db, leadId, routerLeadId) {
  ensureTables(db);
  const lid = Number(leadId);
  const row = db.prepare('SELECT * FROM router_leads WHERE id = ?').get(Number(routerLeadId));
  if (!row) throw fail('NOT_FOUND', 'Router lead not found', 404);
  if (row.review_state !== 'published') throw fail('VALIDATION', 'This lead is not published yet');
  if (row.status === 'removed') throw fail('VALIDATION', 'This lead has been removed');
  if (row.claimed_by_lead_id != null) {
    if (Number(row.claimed_by_lead_id) === lid) {
      // Idempotent retry of my own claim — the LeadScout capture is
      // deduped by router_lead_id, so re-running it changes nothing.
      const again = require('./portalContacts').captureFromRouterClaim(db, { leadId: lid, routerLead: leadShape(row) });
      return { lead: leadShape(row), claimed: true, already: true, contact: again };
    }
    throw fail('CONFLICT', 'This lead was already claimed by another business', 409);
  }
  const info = db
    .prepare(
      "UPDATE router_leads SET status = 'claimed', claimed_by_lead_id = ?, claimed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND claimed_by_lead_id IS NULL AND status != 'removed'"
    )
    .run(lid, row.id);
  if (!info.changes) {
    const fresh = db.prepare('SELECT * FROM router_leads WHERE id = ?').get(row.id);
    if (fresh && Number(fresh.claimed_by_lead_id) === lid) {
      return { lead: leadShape(fresh), claimed: true, already: true };
    }
    throw fail('CONFLICT', 'This lead was already claimed by another business', 409);
  }
  const claimed = getLead(db, row.id);
  const capture = require('./portalContacts').captureFromRouterClaim(db, { leadId: lid, routerLead: claimed });
  return { lead: claimed, claimed: true, already: false, contact: capture };
}

/** Staff oversight roll-up (spec §10): every lead with its state,
 *  claims, and the hiring prospects view (kind = hiring, stamped
 *  with platform; never in a subscriber's service feed). */
function oversight(db) {
  ensureTables(db);
  const rows = db.prepare('SELECT * FROM router_leads').all();
  const by = (fn) => rows.filter(fn).length;
  return {
    total: rows.length,
    candidates: by((r) => r.review_state === 'candidate'),
    published: by((r) => r.review_state === 'published'),
    claimed: by((r) => r.status === 'claimed'),
    removed: by((r) => r.status === 'removed'),
    stale: by((r) => r.status === 'stale'),
    hiring_prospects: rows
      .filter((r) => r.request_kind === 'hiring' && r.review_state === 'published' && r.status !== 'removed')
      .map((r) => withFreshness(db, r)),
  };
}

/** Aggregate demand counts — the ONLY lead data the shared layer
 *  exposes to other modules (spec §7): counts, never posters. */
function demandCounts(db, opts = {}) {
  ensureTables(db);
  let rows = db
    .prepare(
      "SELECT lead_type_key, lead_type_label, area_norm, area FROM router_leads WHERE review_state = 'published' AND status != 'removed'"
    )
    .all();
  if (opts.area_norm) rows = rows.filter((r) => r.area_norm === opts.area_norm || r.town_norm === opts.area_norm);
  const map = new Map();
  for (const r of rows) {
    const k = `${r.lead_type_key}|${r.area_norm || ''}`;
    const cur = map.get(k) || {
      lead_type_key: r.lead_type_key,
      lead_type_label: r.lead_type_label || r.lead_type_key,
      area: r.area || '',
      count: 0,
    };
    cur.count++;
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

module.exports = {
  PLATFORMS,
  PLATFORM_LABELS,
  REQUEST_KINDS,
  SCORES,
  ACCESS_STATES,
  ensureTables,
  normalizeTypeKey,
  normalizeLocation,
  getSettings,
  updateSettings,
  listSources,
  updateSource,
  livePlatforms,
  platformStates,
  setFollow,
  listFollows,
  deleteFollow,
  knownTypes,
  knownLocations,
  recordSweep,
  listSweeps,
  sweepQueriesFor,
  huntingStatus,
  activationChecklist,
  publishLead,
  getLead,
  listLeads,
  listCandidates,
  reviewLead,
  removeLead,
  markStale,
  feedForLead,
  countFeedForLead,
  matchingFollows,
  claimLead,
  oversight,
  demandCounts,
  dedupeKeyFor,
};
