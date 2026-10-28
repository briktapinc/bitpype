'use strict';

/**
 * Batch 46 — Google Business Profile manager, Phase 1.
 * Spec: ~/workspace/website-scout/gbp-manager-spec-2026-10-28.md (§4 data
 * model, §5 prefill, §7 write path, §9 Phase 1). Checklist:
 * gbp-google-clock-checklist-2026-10-28.md.
 *
 * Phase 1 = everything buildable BEFORE Google approves the Business
 * Profile API application: the data model, connection plumbing (OAuth
 * flow complete, tokens secretBox-encrypted), prefill from the lead
 * record + Places API (New) + the lead's BitPype site, the snapshot /
 * diff engine, and the change-set lifecycle.
 *
 * The write path STOPS at 'ready' while the platform approval flag
 * (gbp.api_approval_state) is 'pending': validate → diff → ready, and a
 * push attempt returns the §7.6 state — "Google API access still
 * pending — nothing was sent" — never a fake send. With approval on,
 * push runs ONLY through an injected google client (Phase 2 wires the
 * real Business Profile API client); with no client injected it
 * reports PUSH_NOT_WIRED, again sending nothing.
 *
 * This module works on a workspace SQLite db (better-sqlite3 style,
 * like src/cfDomains). Platform configuration (OAuth client, project
 * number, approval state) is resolved by the route layer from
 * server/platform.js and passed in as `cfg` — engines never read the
 * platform DB directly. NO live Google calls happen here except
 * through an injected fetchImpl / googleClient (tests stub both).
 */

const crypto = require('crypto');
const secretBox = require('./secretBox');
const { pageArgs, pageResult } = require('./paginate');

const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';
const API_PENDING_MESSAGE = 'Google API access still pending — nothing was sent.';
const PUSH_NOT_WIRED_MESSAGE =
  'Google API access is approved, but the live Google connection is not wired yet — nothing was sent.';
const OAUTH_NOT_CONFIGURED_MESSAGE =
  'Google sign-in is not configured yet — the BitPype Google OAuth client still needs to be created (Admin → Settings → Google Business).';
const NAME_MAX = 100; // Google location name limit
const DESCRIPTION_MAX = 750; // Google profile description limit (spec §6)
const ADDITIONAL_CATEGORIES_MAX = 9; // Google allows 9 additional categories
const PLACES_FIELD_MASK =
  'displayName,primaryTypeDisplayName,types,formattedAddress,addressComponents,nationalPhoneNumber,internationalPhoneNumber,websiteUri,regularOpeningHours,rating,userRatingCount,googleMapsUri';

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_SHORT = {
  sunday: 'Sun',
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
};

const PROFILE_FIELDS = [
  { key: 'name', label: 'Business name' },
  { key: 'primary_category', label: 'Primary category' },
  { key: 'additional_categories', label: 'Additional categories' },
  { key: 'description', label: 'Description' },
  { key: 'phone', label: 'Primary phone' },
  { key: 'website', label: 'Website' },
  { key: 'location_mode', label: 'Location type' },
  { key: 'address', label: 'Address' },
  { key: 'service_areas', label: 'Service areas' },
  { key: 'hours', label: 'Opening hours' },
  { key: 'attributes', label: 'Attributes' },
  { key: 'photos', label: 'Photos' },
];

/** Internal profile field → Google updateMask path (Phase 2 payload
 * shape; photos travel via media endpoints, never the location mask). */
const GBP_FIELD_PATHS = {
  name: 'name',
  primary_category: 'categories.primaryCategory',
  additional_categories: 'categories.additionalCategories',
  description: 'profile.description',
  phone: 'primaryPhone',
  website: 'websiteUri',
  location_mode: 'serviceArea',
  address: 'storefrontAddress',
  service_areas: 'serviceArea',
  hours: 'regularHours',
  attributes: 'attributes',
  photos: null,
};

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function parseJsonLoose(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return fallback;
  }
}

function logActivity(db, message) {
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'gbp',
      String(message).slice(0, 2000)
    );
  } catch {
    /* activity log is best-effort */
  }
}

function tableExists(db, name) {
  try {
    return !!db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Schema (spec §4) — ensureTables pattern, like the other engines.
// ---------------------------------------------------------------------------

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gbp_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
      method TEXT NOT NULL DEFAULT 'oauth',
      google_account_id TEXT,
      location_name TEXT,
      place_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'none',
      token_enc TEXT,
      scopes TEXT,
      connected_at TEXT,
      last_sync_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS gbp_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'oauth',
      state_json TEXT NOT NULL DEFAULT '{}',
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gbp_snapshots_lead ON gbp_snapshots(lead_id, id DESC);

    CREATE TABLE IF NOT EXISTS gbp_change_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      author TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      state_json TEXT NOT NULL DEFAULT '{}',
      changes_json TEXT NOT NULL DEFAULT '[]',
      validation_json TEXT,
      google_response_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      pushed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gbp_change_sets_lead ON gbp_change_sets(lead_id, id DESC);
  `);
}

// ---------------------------------------------------------------------------
// Profile state — ONE normalized shape shared by snapshots, prefill,
// the panels and change sets, so diffs never chase format drift.
// ---------------------------------------------------------------------------

function emptyHours() {
  const h = {};
  for (const d of DAY_KEYS) h[d] = [];
  return h;
}

function emptyProfileState() {
  return {
    name: '',
    primary_category: '',
    additional_categories: [],
    description: '',
    phone: '',
    website: '',
    location_mode: 'storefront',
    address: { line1: '', line2: '', city: '', region: '', postal_code: '', country: 'US' },
    service_areas: [],
    hours: emptyHours(),
    attributes: {},
    photos: [],
  };
}

function cleanStr(v, max = 2000) {
  return String(v == null ? '' : v)
    .replace(/ /g, ' ')
    .trim()
    .slice(0, max);
}

function cleanStrList(v, maxItems = 24, maxLen = 300) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = cleanStr(item, maxLen);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(cleanStr(v, 8));
  if (!m) return '';
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return '';
  return `${String(hh).padStart(2, '0')}:${m[2]}`;
}

function normalizeHours(raw) {
  const hours = emptyHours();
  if (!raw || typeof raw !== 'object') return hours;
  for (const day of DAY_KEYS) {
    const periods = Array.isArray(raw[day]) ? raw[day] : [];
    hours[day] = periods
      .map((p) => ({ open: normalizeTime(p && p.open), close: normalizeTime(p && p.close) }))
      .filter((p) => p.open && p.close)
      .slice(0, 4);
  }
  return hours;
}

function normalizeProfileState(input) {
  const src = input && typeof input === 'object' ? input : {};
  const state = emptyProfileState();
  state.name = cleanStr(src.name, 300);
  state.primary_category = cleanStr(src.primary_category, 200);
  state.additional_categories = cleanStrList(src.additional_categories, ADDITIONAL_CATEGORIES_MAX + 5, 200);
  state.description = cleanStr(src.description, 4000);
  state.phone = cleanStr(src.phone, 60);
  state.website = cleanStr(src.website, 500);
  state.location_mode = src.location_mode === 'service_area' ? 'service_area' : 'storefront';
  const addr = src.address && typeof src.address === 'object' ? src.address : {};
  state.address = {
    line1: cleanStr(addr.line1, 300),
    line2: cleanStr(addr.line2, 300),
    city: cleanStr(addr.city, 120),
    region: cleanStr(addr.region, 120),
    postal_code: cleanStr(addr.postal_code, 24),
    country: cleanStr(addr.country, 4) || 'US',
  };
  state.service_areas = cleanStrList(src.service_areas, 20, 160);
  state.hours = normalizeHours(src.hours);
  if (src.attributes && typeof src.attributes === 'object' && !Array.isArray(src.attributes)) {
    for (const [k, v] of Object.entries(src.attributes)) {
      const key = cleanStr(k, 120);
      if (key) state.attributes[key] = !!v;
    }
  }
  if (Array.isArray(src.photos)) {
    state.photos = src.photos
      .map((p) => ({
        source: ['google', 'site', 'upload'].includes(p && p.source) ? p.source : 'site',
        url: cleanStr(p && p.url, 1000),
        role: ['logo', 'cover', 'general'].includes(p && p.role) ? p.role : 'general',
      }))
      .filter((p) => p.url)
      .slice(0, 60);
  }
  return state;
}

function fieldDisplayValue(field, value) {
  if (value == null) return '';
  switch (field) {
    case 'additional_categories':
    case 'service_areas':
      return Array.isArray(value) ? value.join(', ') : String(value);
    case 'location_mode':
      return value === 'service_area' ? 'Service area (no public address)' : 'Storefront';
    case 'address': {
      if (!value || typeof value !== 'object') return '';
      return [value.line1, value.line2, value.city, [value.region, value.postal_code].filter(Boolean).join(' '), value.country]
        .filter(Boolean)
        .join(', ');
    }
    case 'hours': {
      if (!value || typeof value !== 'object') return '';
      const lines = [];
      for (const day of DAY_KEYS) {
        const periods = Array.isArray(value[day]) ? value[day] : [];
        if (periods.length) {
          lines.push(`${DAY_SHORT[day]} ${periods.map((p) => `${p.open}–${p.close}`).join(', ')}`);
        }
      }
      return lines.length ? lines.join(' · ') : 'Closed all week';
    }
    case 'attributes': {
      if (!value || typeof value !== 'object') return '';
      const on = Object.keys(value).filter((k) => value[k]);
      return on.length ? on.join(', ') : 'None set';
    }
    case 'photos': {
      if (!Array.isArray(value) || !value.length) return 'No photos';
      return value.map((p) => `${p.url}${p.role !== 'general' ? ` (${p.role})` : ''}`).join(', ');
    }
    default:
      return String(value);
  }
}

function fieldValuesEqual(field, a, b) {
  if (field === 'address' || field === 'hours' || field === 'attributes') {
    return JSON.stringify(a || null) === JSON.stringify(b || null);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a || []) === JSON.stringify(b || []);
  }
  return String(a == null ? '' : a) === String(b == null ? '' : b);
}

/** Field-by-field before/after between two profile states (spec §7.3 —
 * this diff IS the approval artifact). */
function diffProfileStates(beforeRaw, afterRaw) {
  const before = normalizeProfileState(beforeRaw);
  const after = normalizeProfileState(afterRaw);
  const changes = [];
  for (const { key, label } of PROFILE_FIELDS) {
    if (!fieldValuesEqual(key, before[key], after[key])) {
      changes.push({
        field: key,
        label,
        before: before[key],
        after: after[key],
        beforeText: fieldDisplayValue(key, before[key]),
        afterText: fieldDisplayValue(key, after[key]),
      });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Connections (spec §4) — the refresh token is stored secretBox-encrypted
// and NEVER serialized back out; panels see has_token only.
// ---------------------------------------------------------------------------

function getConnectionRow(db, leadId) {
  ensureTables(db);
  return (
    db.prepare('SELECT * FROM gbp_connections WHERE lead_id = ?').get(Number(leadId)) || null
  );
}

/** Public shape — token material deliberately absent. */
function publicConnection(row, leadId) {
  if (!row) {
    return {
      lead_id: Number(leadId),
      method: 'oauth',
      status: 'none',
      google_account_id: '',
      location_name: '',
      place_id: '',
      scopes: '',
      connected_at: null,
      last_sync_at: null,
      last_error: '',
      has_token: false,
    };
  }
  return {
    lead_id: Number(row.lead_id),
    method: row.method || 'oauth',
    status: row.status || 'none',
    google_account_id: row.google_account_id || '',
    location_name: row.location_name || '',
    place_id: row.place_id || '',
    scopes: row.scopes || '',
    connected_at: row.connected_at || null,
    last_sync_at: row.last_sync_at || null,
    last_error: row.last_error || '',
    has_token: !!row.token_enc,
  };
}

function getConnection(db, leadId) {
  return publicConnection(getConnectionRow(db, leadId), leadId);
}

const CONNECTION_PATCH_KEYS = [
  'method',
  'google_account_id',
  'location_name',
  'place_id',
  'status',
  'scopes',
  'connected_at',
  'last_sync_at',
  'last_error',
];

function upsertConnection(db, leadId, patch = {}) {
  ensureTables(db);
  const id = Number(leadId);
  const existing = getConnectionRow(db, id);
  const cols = CONNECTION_PATCH_KEYS.filter((k) => patch[k] !== undefined);
  if (!existing) {
    const row = { method: 'oauth', status: 'none', place_id: '' };
    for (const k of cols) row[k] = patch[k];
    db.prepare(
      `INSERT INTO gbp_connections (lead_id, method, google_account_id, location_name, place_id, status, scopes, connected_at, last_sync_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      row.method || 'oauth',
      row.google_account_id || null,
      row.location_name || null,
      row.place_id || '',
      row.status || 'none',
      row.scopes || null,
      row.connected_at || null,
      row.last_sync_at || null,
      row.last_error || null
    );
  } else if (cols.length) {
    const sets = cols.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE gbp_connections SET ${sets}, updated_at = datetime('now') WHERE lead_id = ?`).run(
      ...cols.map((k) => patch[k]),
      id
    );
  }
  return getConnection(db, id);
}

/** Place IDs are URL-safe tokens (same rule as the Reviews module). */
function assertPlaceId(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v.length < 8 || v.length > 256 || !/^[A-Za-z0-9_-]+$/.test(v)) {
    throw fail(
      'VALIDATION',
      'That does not look like a Google Place ID. A Place ID is a long code of letters, numbers, dashes and underscores — copy it exactly from Google.'
    );
  }
  return v;
}

function setConnectionPlaceId(db, leadId, placeId) {
  const v = assertPlaceId(placeId);
  const conn = upsertConnection(db, leadId, { place_id: v });
  logActivity(db, `Google Profile: Place ID ${v ? 'set' : 'cleared'} for lead #${leadId}`);
  return conn;
}

/** Manager-invite fallback (spec §3b): staff record that the invite went
 * out; the client accepts in Google, staff mark connected on confirm. */
function recordManagerInvite(db, leadId) {
  const conn = upsertConnection(db, leadId, { method: 'manager', status: 'invited' });
  logActivity(db, `Google Profile: manager invite recorded for lead #${leadId}`);
  return conn;
}

function disconnect(db, leadId) {
  ensureTables(db);
  upsertConnection(db, leadId, { status: 'disconnected', connected_at: null });
  db.prepare(
    "UPDATE gbp_connections SET token_enc = NULL, updated_at = datetime('now') WHERE lead_id = ?"
  ).run(Number(leadId));
  logActivity(db, `Google Profile: disconnected for lead #${leadId}`);
  return getConnection(db, leadId);
}

/** Store the OAuth refresh token encrypted at rest (spec §4). */
function storeConnectionTokens(db, leadId, { refreshToken, scopes, googleAccountId, locationName } = {}) {
  ensureTables(db);
  upsertConnection(db, leadId, {
    method: 'oauth',
    status: 'connected',
    scopes: scopes || GBP_SCOPE,
    google_account_id: googleAccountId || undefined,
    location_name: locationName || undefined,
    connected_at: new Date().toISOString(),
    last_error: null,
  });
  if (refreshToken) {
    db.prepare(
      "UPDATE gbp_connections SET token_enc = ?, updated_at = datetime('now') WHERE lead_id = ?"
    ).run(secretBox.encryptValue(String(refreshToken)), Number(leadId));
  }
  return getConnection(db, leadId);
}

/** Decrypt the stored refresh token. Server-side only — routes must
 * never put this on the wire. */
function readRefreshToken(db, leadId) {
  const row = getConnectionRow(db, leadId);
  if (!row || !row.token_enc) return '';
  return secretBox.decryptValue(row.token_enc) || '';
}

// ---------------------------------------------------------------------------
// Snapshots (spec §4) — the profile exactly as Google last reported it;
// the "current" column of every diff.
// ---------------------------------------------------------------------------

function getLatestSnapshot(db, leadId) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM gbp_snapshots WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
    .get(Number(leadId));
  if (!row) return null;
  return {
    id: row.id,
    lead_id: Number(row.lead_id),
    source: row.source || 'oauth',
    fetched_at: row.fetched_at,
    state: normalizeProfileState(parseJsonLoose(row.state_json, {})),
  };
}

function saveSnapshot(db, leadId, state, source = 'oauth') {
  ensureTables(db);
  const normalized = normalizeProfileState(state);
  db.prepare('INSERT INTO gbp_snapshots (lead_id, source, state_json) VALUES (?, ?, ?)').run(
    Number(leadId),
    String(source || 'oauth').slice(0, 40),
    JSON.stringify(normalized)
  );
  return getLatestSnapshot(db, leadId);
}

// ---------------------------------------------------------------------------
// Prefill (spec §5) — lead record → Places (New) details → the lead's
// BitPype site → (Phase 2) media library. Prefill NEVER silently
// overwrites a value Google already has: where the lead and Google
// disagree, the field is flagged as a conflict and Google's current
// value wins the proposal.
// ---------------------------------------------------------------------------

/** Lead hours live as JSON [{day, open, close}] with day as a name or a
 * 0–6 / 1–7 number depending on the capture path — accept all of it. */
function parseLeadHours(raw) {
  const hours = emptyHours();
  const parsed = parseJsonLoose(raw, null);
  if (!Array.isArray(parsed)) return hours;
  const byName = {};
  DAY_KEYS.forEach((d, i) => {
    byName[d] = d;
    byName[d.slice(0, 3)] = d;
    byName[String(i)] = d; // 0 = Sunday
    byName[String(i + 1)] = d; // 1 = Sunday (Google Places convention)
  });
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const key = byName[String(item.day || '').trim().toLowerCase()];
    if (!key) continue;
    const open = normalizeTime(item.open);
    const close = normalizeTime(item.close);
    if (open && close) hours[key].push({ open, close });
  }
  return hours;
}

function leadProfileState(lead) {
  const state = emptyProfileState();
  if (!lead) return state;
  state.name = cleanStr(lead.business_name, 300);
  state.primary_category = cleanStr(lead.category, 200);
  state.phone = cleanStr(lead.phone, 60);
  state.description = cleanStr(lead.description, 4000);
  state.website = cleanStr(lead.website, 500);
  state.address = {
    line1: cleanStr(lead.address, 300),
    line2: '',
    city: cleanStr(lead.city, 120),
    region: cleanStr(lead.state, 120),
    postal_code: cleanStr(lead.postal_code, 24),
    country: cleanStr(lead.country, 4) || 'US',
  };
  state.location_mode = state.address.line1 ? 'storefront' : 'service_area';
  if (state.location_mode === 'service_area' && state.address.city) {
    state.service_areas = [
      [state.address.city, state.address.region].filter(Boolean).join(', '),
    ].filter(Boolean);
  }
  state.hours = parseLeadHours(lead.hours);
  return state;
}

/** The lead's BitPype site: a live custom domain is the profile-website
 * candidate (§5.3); a pages.dev preview is shown but NOT eligible. */
function siteProfileInfo(db, leadId) {
  const info = { website: '', websiteEligible: false, websiteNote: '', siteId: null, photos: [] };
  if (!tableExists(db, 'websites')) return info;
  let site = null;
  try {
    site = db
      .prepare('SELECT * FROM websites WHERE lead_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(Number(leadId));
  } catch {
    site = db.prepare('SELECT * FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(Number(leadId));
  }
  if (!site) return info;
  info.siteId = site.id;
  const domain = cleanStr(site.custom_domain, 300).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (domain) {
    info.website = `https://${domain}`;
    info.websiteEligible = true;
  } else if (site.preview_url && /^https?:\/\//i.test(site.preview_url)) {
    info.website = String(site.preview_url).replace(/\/+$/, '');
    info.websiteEligible = false;
    info.websiteNote =
      'This is the staged preview address — Google only accepts the business\u2019s real website. It becomes eligible once the site\u2019s own domain is live.';
  }
  // Photo candidates: image URLs already on the site's pages (§5.4).
  try {
    const raw = String(site.pages || '');
    const found = new Set();
    for (const m of raw.matchAll(/https?:\/\/[^\s"'\\)]+?\.(?:jpe?g|png|webp)/gi)) found.add(m[0]);
    for (const m of raw.matchAll(/"(images\/[^"]+?\.(?:jpe?g|png|webp))"/gi)) found.add(m[1]);
    info.photos = [...found].slice(0, 24).map((url) => ({ source: 'site', url, role: 'general' }));
  } catch {
    /* pages JSON is best-effort */
  }
  return info;
}

/** Places API (New) Place Details JSON → normalized profile state. */
function placesProfileState(json) {
  const src = json && typeof json === 'object' ? json : {};
  const state = emptyProfileState();
  state.name = cleanStr(src.displayName && src.displayName.text, 300);
  state.primary_category = cleanStr(src.primaryTypeDisplayName && src.primaryTypeDisplayName.text, 200);
  state.phone = cleanStr(src.nationalPhoneNumber || src.internationalPhoneNumber, 60);
  state.website = cleanStr(src.websiteUri, 500);
  const comps = Array.isArray(src.addressComponents) ? src.addressComponents : [];
  const comp = (type) => {
    const c = comps.find((x) => Array.isArray(x.types) && x.types.includes(type));
    return c ? cleanStr(c.longText || c.shortText, 300) : '';
  };
  const compShort = (type) => {
    const c = comps.find((x) => Array.isArray(x.types) && x.types.includes(type));
    return c ? cleanStr(c.shortText || c.longText, 120) : '';
  };
  const street = [comp('street_number'), comp('route')].filter(Boolean).join(' ');
  state.address = {
    line1: street || cleanStr(src.formattedAddress, 300),
    line2: comp('subpremise'),
    city: comp('locality') || comp('postal_town'),
    region: compShort('administrative_area_level_1'),
    postal_code: comp('postal_code'),
    country: compShort('country') || 'US',
  };
  state.location_mode = state.address.line1 ? 'storefront' : 'service_area';
  const periods =
    src.regularOpeningHours && Array.isArray(src.regularOpeningHours.periods)
      ? src.regularOpeningHours.periods
      : [];
  for (const p of periods) {
    if (!p || !p.open) continue;
    const day = DAY_KEYS[Number(p.open.day)];
    if (!day) continue;
    const open = `${String(Number(p.open.hour) || 0).padStart(2, '0')}:${String(Number(p.open.minute) || 0).padStart(2, '0')}`;
    const close = p.close
      ? `${String(Number(p.close.hour) || 0).padStart(2, '0')}:${String(Number(p.close.minute) || 0).padStart(2, '0')}`
      : '23:59';
    state.hours[day].push({ open, close });
  }
  return {
    state,
    meta: {
      rating: src.rating != null && Number.isFinite(Number(src.rating)) ? Number(src.rating) : null,
      review_count: src.userRatingCount != null ? Math.max(0, Math.round(Number(src.userRatingCount) || 0)) : 0,
      google_maps_uri: src.googleMapsUri ? String(src.googleMapsUri) : '',
      types: Array.isArray(src.types) ? src.types.slice(0, 12).map(String) : [],
    },
  };
}

/** One server-side Places (New) details fetch for prefill. Same honesty
 * codes as the Reviews module: NO_KEY / NO_PLACE_ID mean "dormant", not
 * "broken". The key travels in a header only, never the URL. */
async function fetchPlacesState(placeId, { apiKey, fetchImpl } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    return {
      ok: false,
      code: 'NO_KEY',
      message: 'Google Places API key is not configured — Places prefill is dormant.',
    };
  }
  let id = '';
  try {
    id = assertPlaceId(placeId);
  } catch (e) {
    return { ok: false, code: 'NO_PLACE_ID', message: e.message };
  }
  if (!id) {
    return { ok: false, code: 'NO_PLACE_ID', message: 'No Google Place ID is set for this lead yet.' };
  }
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, code: 'PLACES_ERROR', message: 'No fetch implementation available' };
  let res;
  try {
    res = await doFetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PLACES_FIELD_MASK, Accept: 'application/json' },
    });
  } catch (e) {
    return { ok: false, code: 'PLACES_ERROR', message: `Could not reach Google Places: ${(e && e.message) || e}` };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const gmsg = (body && body.error && (body.error.message || body.error.status)) || `HTTP ${res.status}`;
    if (res.status === 404) return { ok: false, code: 'PLACES_NOT_FOUND', message: `Google could not find that Place ID (${gmsg})` };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'PLACES_DENIED', message: `Google Places refused the request (${gmsg})` };
    }
    return { ok: false, code: 'PLACES_ERROR', message: `Google Places error (${gmsg})` };
  }
  const { state, meta } = placesProfileState(body);
  return { ok: true, state, meta };
}

/** Resolve the lead's Place ID (GBP connection first, then the Reviews
 * module config) and fetch its Places state for prefill. */
async function placesPrefillForLead(db, leadId, opts = {}) {
  ensureTables(db);
  const conn = getConnectionRow(db, leadId);
  let placeId = conn ? String(conn.place_id || '').trim() : '';
  if (!placeId && tableExists(db, 'googlereviews_configs')) {
    try {
      const cfg = db
        .prepare('SELECT place_id FROM googlereviews_configs WHERE lead_id = ?')
        .get(Number(leadId));
      if (cfg) placeId = String(cfg.place_id || '').trim();
    } catch {
      /* config table is optional */
    }
  }
  return fetchPlacesState(placeId, opts);
}

function isEmptyFieldValue(field, value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (field === 'address') {
    return !value || (!value.line1 && !value.city && !value.region && !value.postal_code);
  }
  if (field === 'hours') {
    return !value || DAY_KEYS.every((d) => !Array.isArray(value[d]) || value[d].length === 0);
  }
  if (field === 'attributes') return !value || Object.keys(value).length === 0;
  return String(value).trim() === '';
}

/**
 * Merge the prefill sources into a proposal with per-field provenance.
 * Google's current values (latest snapshot, else the Places state) win
 * conflicts by default (spec §5); the lead and the site fill the gaps.
 */
function mergePrefill({ leadState, googleState, googleSource, siteInfo }) {
  const lead = normalizeProfileState(leadState);
  const google = googleState ? normalizeProfileState(googleState) : null;
  const fields = {};
  const proposed = emptyProfileState();
  const conflicts = [];
  for (const { key, label } of PROFILE_FIELDS) {
    const googleValue = google ? google[key] : null;
    let leadValue = lead[key];
    let leadSource = 'lead';
    if (key === 'website' && siteInfo && siteInfo.website) {
      leadValue = siteInfo.website;
      leadSource = 'site';
    }
    if (key === 'photos' && siteInfo && siteInfo.photos && siteInfo.photos.length) {
      leadValue = siteInfo.photos;
      leadSource = 'site';
    }
    const hasGoogle = google != null && !isEmptyFieldValue(key, googleValue);
    const hasLead = !isEmptyFieldValue(key, leadValue);
    let value;
    let source;
    if (hasGoogle) {
      value = googleValue;
      source = googleSource === 'places' ? 'places' : 'google';
    } else if (hasLead) {
      value = leadValue;
      source = leadSource;
    } else {
      value = lead[key];
      source = 'lead';
    }
    const conflict = hasGoogle && hasLead && !fieldValuesEqual(key, googleValue, leadValue);
    if (conflict) conflicts.push(key);
    proposed[key] = value;
    fields[key] = {
      field: key,
      label,
      proposed: value,
      proposedText: fieldDisplayValue(key, value),
      source,
      googleValue: hasGoogle ? googleValue : null,
      googleText: hasGoogle ? fieldDisplayValue(key, googleValue) : '',
      leadValue: hasLead ? leadValue : null,
      leadText: hasLead ? fieldDisplayValue(key, leadValue) : '',
      conflict,
    };
  }
  return {
    fields,
    proposedState: proposed,
    conflicts,
    websiteEligible: !siteInfo || !siteInfo.website ? null : !!siteInfo.websiteEligible,
    websiteNote: siteInfo ? siteInfo.websiteNote || '' : '',
  };
}

/** Synchronous prefill: lead + site + latest snapshot (no network). */
function buildPrefill(db, leadId, { placesState } = {}) {
  ensureTables(db);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId));
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');
  const snapshot = getLatestSnapshot(db, leadId);
  const siteInfo = siteProfileInfo(db, leadId);
  const merged = mergePrefill({
    leadState: leadProfileState(lead),
    googleState: snapshot ? snapshot.state : placesState || null,
    googleSource: snapshot ? 'google' : 'places',
    siteInfo,
  });
  return { ...merged, siteInfo: { siteId: siteInfo.siteId, websiteEligible: siteInfo.websiteEligible } };
}

// ---------------------------------------------------------------------------
// Local validation — field rules mirroring Google's documented
// constraints (spec §7.2's validateOnly happens server-side at push
// time in Phase 2; these rules catch the same classes of problem
// before a change set may call itself "ready", plus the §8 policy
// traps that must warn BEFORE anything is pushed).
// ---------------------------------------------------------------------------

function validateProfileState(rawState, { leadName } = {}) {
  const state = normalizeProfileState(rawState);
  const errors = [];
  const warnings = [];
  const err = (field, code, message) => errors.push({ field, code, message });
  const warn = (field, code, message) => warnings.push({ field, code, message });

  if (!state.name) err('name', 'NAME_REQUIRED', 'Business name is required.');
  if (state.name.length > NAME_MAX) {
    err('name', 'NAME_TOO_LONG', `Business name must be ${NAME_MAX} characters or fewer (Google's limit).`);
  }
  if (leadName && state.name) {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t.length > 2);
    const leadTokens = new Set(norm(leadName));
    const shares = norm(state.name).some((t) => leadTokens.has(t));
    if (!shares) {
      warn(
        'name',
        'NAME_DIFFERS_FROM_LEAD',
        'This name shares nothing with the business name on the lead record. Google can suspend a profile whose name does not match the real business name — double-check before pushing.'
      );
    }
  }
  if (!state.primary_category) {
    err('primary_category', 'CATEGORY_REQUIRED', 'A primary category is required.');
  }
  if (state.additional_categories.length > ADDITIONAL_CATEGORIES_MAX) {
    err(
      'additional_categories',
      'TOO_MANY_CATEGORIES',
      `Google allows at most ${ADDITIONAL_CATEGORIES_MAX} additional categories.`
    );
  }
  if (state.description.length > DESCRIPTION_MAX) {
    err(
      'description',
      'DESCRIPTION_TOO_LONG',
      `Description must be ${DESCRIPTION_MAX} characters or fewer (Google's limit) — currently ${state.description.length}.`
    );
  }
  if (state.phone) {
    const digits = state.phone.replace(/\D/g, '');
    if (!/^\+?[0-9\s().-]+$/.test(state.phone) || digits.length < 7 || digits.length > 15) {
      err('phone', 'PHONE_INVALID', 'Phone must be a reachable number (7–15 digits, optional leading +).');
    }
  }
  if (state.website) {
    let url = null;
    try {
      url = new URL(state.website);
    } catch {
      url = null;
    }
    if (!url || !/^https?:$/.test(url.protocol)) {
      err('website', 'WEBSITE_INVALID', 'Website must be a full http(s) URL.');
    } else if (/(^|\.)pages\.dev$/i.test(url.hostname)) {
      err(
        'website',
        'WEBSITE_NOT_ELIGIBLE',
        'That is a staged preview address — Google only accepts the business\u2019s real website. It becomes eligible once the site\u2019s own domain is live.'
      );
    }
  }
  for (const day of DAY_KEYS) {
    const periods = state.hours[day] || [];
    if (periods.length > 2) {
      err('hours', 'HOURS_TOO_MANY_PERIODS', `${DAY_SHORT[day]}: Google allows at most 2 open periods per day (split shifts).`);
    }
    for (const p of periods) {
      const okOrder = p.open < p.close || (p.open === '00:00' && p.close === '23:59');
      if (!okOrder) {
        err('hours', 'HOURS_PERIOD_ORDER', `${DAY_SHORT[day]}: close time must be after open time (use 00:00–23:59 for 24 hours).`);
      }
    }
  }
  if (state.location_mode === 'storefront') {
    const missing = [];
    if (!state.address.line1) missing.push('street address');
    if (!state.address.city) missing.push('city');
    if (!state.address.region) missing.push('state / region');
    if (!state.address.postal_code) missing.push('postal code');
    if (missing.length) {
      err('address', 'ADDRESS_INCOMPLETE', `A storefront profile needs a complete address — missing: ${missing.join(', ')}.`);
    }
  } else {
    if (!state.service_areas.length) {
      err('service_areas', 'SERVICE_AREA_REQUIRED', 'A service-area profile needs at least one service area (e.g. "Reading, PA").');
    }
    if (state.address.line1) {
      warn(
        'address',
        'SAB_ADDRESS_HIDDEN',
        'Service-area businesses must not show a street address. The address on file stays in BitPype but will be left out of anything pushed to Google.'
      );
    }
    if (state.address.line1 || state.address.city) {
      warn(
        'location_mode',
        'MODE_SWITCH_REVERIFY',
        'Switching between a storefront and a service-area profile can trigger re-verification by Google.'
      );
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Change sets (spec §4 + §7) — draft → validate → ready → (push, Phase 2
// wiring). Nothing is ever pushed without a saved change set, and while
// the API approval flag is 'pending' a push attempt stops at 'ready'
// with the §7.6 message. Pusher-is-approver (spec §11.3 default): the
// saved change set is the approval artifact.
// ---------------------------------------------------------------------------

function rowToChangeSet(row) {
  if (!row) return null;
  return {
    id: row.id,
    lead_id: Number(row.lead_id),
    author: row.author || '',
    status: row.status,
    state: normalizeProfileState(parseJsonLoose(row.state_json, {})),
    changes: parseJsonLoose(row.changes_json, []),
    validation: parseJsonLoose(row.validation_json, null),
    google_response: parseJsonLoose(row.google_response_json, null),
    last_error: row.last_error || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    pushed_at: row.pushed_at || null,
  };
}

function createChangeSet(db, leadId, { author, state } = {}) {
  ensureTables(db);
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(Number(leadId));
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');
  const proposed = normalizeProfileState(state);
  const snapshot = getLatestSnapshot(db, leadId);
  const base = snapshot ? snapshot.state : emptyProfileState();
  const changes = diffProfileStates(base, proposed);
  const info = db
    .prepare(
      `INSERT INTO gbp_change_sets (lead_id, author, status, state_json, changes_json)
       VALUES (?, ?, 'draft', ?, ?)`
    )
    .run(Number(leadId), String(author || '').slice(0, 120), JSON.stringify(proposed), JSON.stringify(changes));
  logActivity(
    db,
    `Google Profile: draft change set #${info.lastInsertRowid} for lead #${leadId} (${changes.length} field${changes.length === 1 ? '' : 's'})`
  );
  return getChangeSet(db, Number(info.lastInsertRowid));
}

function getChangeSet(db, id) {
  ensureTables(db);
  return rowToChangeSet(db.prepare('SELECT * FROM gbp_change_sets WHERE id = ?').get(Number(id)));
}

/** The cross-lead guard: a change set is only visible/mutable through
 * its own lead. Portal handlers resolve the lead from the session and
 * MUST go through here, never getChangeSet with a client-supplied id. */
function getChangeSetForLead(db, leadId, id) {
  const cs = getChangeSet(db, id);
  if (!cs || Number(cs.lead_id) !== Number(leadId)) return null;
  return cs;
}

function listChangeSets(db, leadId, opts = {}) {
  ensureTables(db);
  const { page, pageSize, offset } = pageArgs(opts, { pageSize: 25, maxSize: 200 });
  const total = db
    .prepare('SELECT COUNT(*) AS c FROM gbp_change_sets WHERE lead_id = ?')
    .get(Number(leadId)).c;
  const rows = db
    .prepare('SELECT * FROM gbp_change_sets WHERE lead_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(Number(leadId), pageSize, offset);
  return pageResult(rows.map(rowToChangeSet), total, page, pageSize);
}

function countAwaitingPush(db, leadId) {
  ensureTables(db);
  if (leadId != null) {
    return db
      .prepare("SELECT COUNT(*) AS c FROM gbp_change_sets WHERE lead_id = ? AND status = 'ready'")
      .get(Number(leadId)).c;
  }
  return db.prepare("SELECT COUNT(*) AS c FROM gbp_change_sets WHERE status = 'ready'").get().c;
}

function validateChangeSet(db, id) {
  const cs = getChangeSet(db, id);
  if (!cs) throw fail('NOT_FOUND', 'Change set not found');
  if (cs.status === 'pushed') throw fail('ALREADY_PUSHED', 'This change set was already pushed.');
  const lead = db.prepare('SELECT business_name FROM leads WHERE id = ?').get(cs.lead_id);
  const validation = validateProfileState(cs.state, { leadName: lead ? lead.business_name : '' });
  const nextStatus = validation.ok ? 'ready' : 'draft';
  db.prepare(
    "UPDATE gbp_change_sets SET validation_json = ?, status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify({ ...validation, at: new Date().toISOString() }), nextStatus, cs.id);
  logActivity(
    db,
    `Google Profile: change set #${cs.id} validated for lead #${cs.lead_id} — ${validation.ok ? 'ready' : `${validation.errors.length} error(s)`}`
  );
  return { changeSet: getChangeSet(db, cs.id), validation };
}

/** Internal profile state → the Google location payload shape the push
 * sends (Phase 2 finalizes against the live API; the updateMask is the
 * contract that matters — only changed fields are ever sent). */
function buildLocationPayload(state) {
  const s = normalizeProfileState(state);
  const payload = {
    name: s.name,
    categories: {
      primaryCategory: { name: s.primary_category },
      additionalCategories: s.additional_categories.map((n) => ({ name: n })),
    },
    profile: { description: s.description },
    primaryPhone: s.phone,
    websiteUri: s.website,
    regularHours: {
      periods: DAY_KEYS.flatMap((day, idx) =>
        (s.hours[day] || []).map((p) => ({
          openDay: day.toUpperCase(),
          openTime: p.open,
          closeDay: day.toUpperCase(),
          closeTime: p.close,
          _dayIndex: idx,
        }))
      ).map(({ _dayIndex, ...rest }) => rest),
    },
    attributes: Object.entries(s.attributes).map(([attributeId, value]) => ({ attributeId, value })),
  };
  if (s.location_mode === 'service_area') {
    payload.serviceArea = {
      businessType: 'CUSTOMER_LOCATION_ONLY',
      places: { placeInfos: s.service_areas.map((placeName) => ({ placeName })) },
    };
  } else {
    payload.storefrontAddress = {
      addressLines: [s.address.line1, s.address.line2].filter(Boolean),
      locality: s.address.city,
      administrativeArea: s.address.region,
      postalCode: s.address.postal_code,
      regionCode: s.address.country || 'US',
    };
  }
  return payload;
}

function updateMaskForChanges(changes) {
  const mask = [];
  for (const c of changes || []) {
    const p = GBP_FIELD_PATHS[c.field];
    if (p && !mask.includes(p)) mask.push(p);
  }
  return mask;
}

function isQuotaError(e) {
  if (!e) return false;
  if (e.status === 429 || e.statusCode === 429) return true;
  const text = `${e.message || ''} ${e.code || ''} ${e.response ? JSON.stringify(e.response) : ''}`;
  return /RESOURCE_EXHAUSTED|quota/i.test(text);
}

/**
 * Attempt a push. Phase 1 contract — in order:
 *  1. approval flag not 'approved' → API_PENDING (§7.6), set stays put.
 *  2. no connected location → NOT_CONNECTED.
 *  3. no google client injected → PUSH_NOT_WIRED (Phase 2 wires it).
 *  4. with a client: validateOnly → updateLocation (updateMask =
 *     changed fields only) → read-back into a fresh snapshot
 *     ('push_readback') → 'pushed'. Quota-shaped errors map back to
 *     API_PENDING with the set untouched; other failures land 'failed'
 *     with Google's response stored (spec §7.6/§7 failures).
 */
async function pushChangeSet(db, id, { approvalState, googleClient } = {}) {
  const cs = getChangeSet(db, id);
  if (!cs) throw fail('NOT_FOUND', 'Change set not found');
  if (cs.status === 'pushed') {
    return { ok: false, code: 'ALREADY_PUSHED', message: 'This change set was already pushed.', changeSet: cs };
  }
  if (cs.status !== 'ready') {
    return {
      ok: false,
      code: 'NOT_READY',
      message: 'Validate the change set first — only a validated ("ready") change set can be pushed.',
      changeSet: cs,
    };
  }
  if (approvalState !== 'approved') {
    return { ok: false, code: 'API_PENDING', message: API_PENDING_MESSAGE, changeSet: cs };
  }
  const conn = getConnectionRow(db, cs.lead_id);
  if (!conn || conn.status !== 'connected' || !conn.location_name) {
    return {
      ok: false,
      code: 'NOT_CONNECTED',
      message: 'This lead has no connected Google location yet — connect the profile before pushing.',
      changeSet: cs,
    };
  }
  if (!googleClient) {
    return { ok: false, code: 'PUSH_NOT_WIRED', message: PUSH_NOT_WIRED_MESSAGE, changeSet: cs };
  }
  const payload = buildLocationPayload(cs.state);
  const updateMask = updateMaskForChanges(cs.changes);
  try {
    if (typeof googleClient.validateOnly === 'function') {
      const v = await googleClient.validateOnly(conn.location_name, payload, updateMask);
      if (v && v.ok === false) {
        return {
          ok: false,
          code: 'VALIDATION',
          message: 'Google validation rejected the change set — nothing was sent.',
          errors: v.errors || [],
          changeSet: cs,
        };
      }
    }
    const response = await googleClient.updateLocation(conn.location_name, payload, updateMask);
    let readBack = null;
    if (typeof googleClient.getLocation === 'function') {
      readBack = await googleClient.getLocation(conn.location_name);
    }
    if (readBack && readBack.state) {
      saveSnapshot(db, cs.lead_id, readBack.state, 'push_readback');
    }
    db.prepare(
      "UPDATE gbp_change_sets SET status = 'pushed', pushed_at = datetime('now'), google_response_json = ?, last_error = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(response || {}), cs.id);
    upsertConnection(db, cs.lead_id, { last_sync_at: new Date().toISOString(), last_error: null });
    logActivity(db, `Google Profile: change set #${cs.id} pushed for lead #${cs.lead_id}`);
    return { ok: true, changeSet: getChangeSet(db, cs.id) };
  } catch (e) {
    if (isQuotaError(e)) {
      return { ok: false, code: 'API_PENDING', message: API_PENDING_MESSAGE, changeSet: cs };
    }
    db.prepare(
      "UPDATE gbp_change_sets SET status = 'failed', google_response_json = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(
      e && e.response ? JSON.stringify(e.response) : null,
      String((e && e.message) || e).slice(0, 1000),
      cs.id
    );
    logActivity(db, `Google Profile: change set #${cs.id} push FAILED for lead #${cs.lead_id}`);
    return {
      ok: false,
      code: 'PUSH_FAILED',
      message: `Google rejected the push: ${(e && e.message) || e}`,
      changeSet: getChangeSet(db, cs.id),
    };
  }
}

// ---------------------------------------------------------------------------
// OAuth (spec §3a) — signed state mirrors the Meta flow
// (src/socialMedia): HMAC over a base64url payload carrying the
// workspace + lead, so the public callback can find its workspace DB
// before any session exists. With no OAuth client configured, the
// start returns the honest not-configured state — there is no dead
// button anywhere.
// ---------------------------------------------------------------------------

function stateSecret() {
  return process.env.SESSION_SECRET || process.env.META_TOKEN_SECRET || 'dev-change-me';
}

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) throw fail('INVALID_STATE', 'Invalid OAuth state');
  const expect = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw fail('INVALID_STATE', 'Invalid OAuth state signature');
  }
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!data || !data.exp || Date.now() > data.exp) throw fail('EXPIRED_STATE', 'OAuth state expired');
  return data;
}

function oauthRedirectUri(appUrl) {
  return `${String(appUrl || '').replace(/\/+$/, '')}/api/v1/gbp/oauth/callback`;
}

function oauthReady(cfg) {
  return !!(cfg && cfg.clientId && cfg.clientSecret);
}

function buildOauthStart(db, { workspaceId, leadId, actor, returnTo, cfg, appUrl } = {}) {
  ensureTables(db);
  if (!oauthReady(cfg)) {
    return { configured: false, code: 'OAUTH_NOT_CONFIGURED', message: OAUTH_NOT_CONFIGURED_MESSAGE };
  }
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(Number(leadId));
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');
  const redirectUri = oauthRedirectUri(appUrl);
  const state = signState({
    w: Number(workspaceId),
    l: Number(leadId),
    a: String(actor || ''),
    r: String(returnTo || ''),
    n: crypto.randomBytes(8).toString('hex'),
    exp: Date.now() + 20 * 60 * 1000,
  });
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GBP_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return { configured: true, url: url.toString(), redirectUri, leadId: Number(leadId) };
}

async function handleOauthCallback(db, { code, state, cfg, appUrl, fetchImpl } = {}) {
  ensureTables(db);
  const st = verifyState(state);
  if (!oauthReady(cfg)) throw fail('OAUTH_NOT_CONFIGURED', OAUTH_NOT_CONFIGURED_MESSAGE);
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw fail('GBP_ERROR', 'No fetch implementation available');
  const redirectUri = oauthRedirectUri(appUrl);
  const tokenRes = await doFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: String(code || ''),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.access_token) {
    throw fail('OAUTH_EXCHANGE_FAILED', `Google token exchange failed (HTTP ${tokenRes.status})`);
  }
  let accountId = '';
  try {
    const uiRes = await doFetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const ui = await uiRes.json().catch(() => ({}));
    if (ui && ui.sub) accountId = String(ui.sub);
  } catch {
    /* account id is informational — the token is the connection */
  }
  const conn = storeConnectionTokens(db, Number(st.l), {
    refreshToken: tokens.refresh_token || '',
    scopes: tokens.scope || GBP_SCOPE,
    googleAccountId: accountId || undefined,
  });
  logActivity(db, `Google Profile: connected via Google sign-in for lead #${st.l}`);
  return { leadId: Number(st.l), returnTo: st.r || '', connection: conn };
}

// ---------------------------------------------------------------------------
// Panel assembly + staff roll-up.
// ---------------------------------------------------------------------------

/** The Reviews module's Places sample, when it exists — read-only in
 * Phase 1 (the FULL review set arrives with the API, spec §6). */
function reviewsSample(db, leadId) {
  if (!tableExists(db, 'googlereviews_cache')) return null;
  try {
    const row = db
      .prepare('SELECT payload_json, fetched_at FROM googlereviews_cache WHERE lead_id = ?')
      .get(Number(leadId));
    if (!row) return null;
    const data = parseJsonLoose(row.payload_json, null);
    if (!data || !Array.isArray(data.reviews)) return null;
    return {
      sample: true,
      rating: data.rating != null ? data.rating : null,
      total: data.total || 0,
      reviews: data.reviews,
      fetched_at: row.fetched_at,
      note: 'Sample from Google Places — the full review set arrives when the Business Profile API is approved.',
    };
  } catch {
    return null;
  }
}

function configSummary(cfg, placesConfigured) {
  const approvalState = cfg && cfg.approvalState === 'approved' ? 'approved' : 'pending';
  return {
    oauthReady: oauthReady(cfg),
    oauthNotConfiguredMessage: OAUTH_NOT_CONFIGURED_MESSAGE,
    approvalState,
    apiPending: approvalState !== 'approved',
    apiPendingMessage: API_PENDING_MESSAGE,
    approvedAt: (cfg && cfg.approvedAt) || '',
    projectNumberSet: !!(cfg && cfg.projectNumber),
    placesConfigured: !!placesConfigured,
    redirectUriPath: '/api/v1/gbp/oauth/callback',
  };
}

/** Everything the staff drawer section and the portal panel render. */
function panelData(db, leadId, { cfg, placesConfigured, placesState, changeSetPageSize } = {}) {
  ensureTables(db);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId));
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');
  const snapshot = getLatestSnapshot(db, leadId);
  const prefill = buildPrefill(db, leadId, { placesState: placesState || null });
  return {
    lead: {
      id: Number(lead.id),
      business_name: lead.business_name || '',
      category: lead.category || '',
      phone: lead.phone || '',
      city: lead.city || '',
      state: lead.state || '',
      status: lead.status || '',
    },
    config: configSummary(cfg, placesConfigured),
    connection: getConnection(db, leadId),
    snapshot: snapshot
      ? { id: snapshot.id, source: snapshot.source, fetched_at: snapshot.fetched_at, state: snapshot.state }
      : null,
    prefill,
    changeSets: listChangeSets(db, leadId, { page: 1, pageSize: changeSetPageSize || 10 }),
    awaitingPush: countAwaitingPush(db, leadId),
    reviews: reviewsSample(db, leadId),
  };
}

/** Admin roll-up (spec §6): every lead × connection status, paginated,
 * plus status counts and the change sets waiting on the approval flag. */
function overview(db, opts = {}) {
  ensureTables(db);
  const { page, pageSize, offset } = pageArgs(opts, { pageSize: 25, maxSize: 200 });
  const total = db.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
  const rows = db
    .prepare(
      `SELECT l.id AS lead_id, l.business_name, l.city, l.state,
              c.status AS connection_status, c.method, c.place_id, c.location_name,
              (SELECT COUNT(*) FROM gbp_change_sets cs WHERE cs.lead_id = l.id AND cs.status = 'ready') AS awaiting_push
         FROM leads l
         LEFT JOIN gbp_connections c ON c.lead_id = l.id
        ORDER BY l.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(pageSize, offset)
    .map((r) => ({
      lead_id: Number(r.lead_id),
      business_name: r.business_name || '',
      city: r.city || '',
      state: r.state || '',
      connection_status: r.connection_status || 'none',
      method: r.method || 'oauth',
      place_id: r.place_id || '',
      location_name: r.location_name || '',
      awaiting_push: Number(r.awaiting_push) || 0,
    }));
  const counts = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS c FROM gbp_connections GROUP BY status').all()) {
    counts[r.status] = r.c;
  }
  return { ...pageResult(rows, total, page, pageSize), counts, awaitingPushTotal: countAwaitingPush(db) };
}

module.exports = {
  GBP_SCOPE,
  API_PENDING_MESSAGE,
  PUSH_NOT_WIRED_MESSAGE,
  OAUTH_NOT_CONFIGURED_MESSAGE,
  DESCRIPTION_MAX,
  NAME_MAX,
  PROFILE_FIELDS,
  GBP_FIELD_PATHS,
  ensureTables,
  emptyProfileState,
  normalizeProfileState,
  fieldDisplayValue,
  diffProfileStates,
  getConnection,
  getConnectionRow,
  publicConnection,
  upsertConnection,
  assertPlaceId,
  setConnectionPlaceId,
  recordManagerInvite,
  disconnect,
  storeConnectionTokens,
  readRefreshToken,
  getLatestSnapshot,
  saveSnapshot,
  leadProfileState,
  siteProfileInfo,
  placesProfileState,
  fetchPlacesState,
  placesPrefillForLead,
  buildPrefill,
  mergePrefill,
  validateProfileState,
  createChangeSet,
  getChangeSet,
  getChangeSetForLead,
  listChangeSets,
  countAwaitingPush,
  validateChangeSet,
  buildLocationPayload,
  updateMaskForChanges,
  pushChangeSet,
  signState,
  verifyState,
  oauthRedirectUri,
  oauthReady,
  buildOauthStart,
  handleOauthCallback,
  reviewsSample,
  configSummary,
  panelData,
  overview,
};
