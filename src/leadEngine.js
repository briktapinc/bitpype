'use strict';

/**
 * Lead engine for Website Scout — pure logic + better-sqlite3 access.
 *
 * Owns: create/read/update/delete, CSV import, duplicate detection + merge,
 * lead scoring (spec section 16), qualification (spec section 15), researched
 * facts with provenance (spec sections 17–18), and research orchestration.
 *
 * Anti-hallucination rule: facts are only stored when a source exists.
 * CSV/manual passthrough facts are stored as claim_class UNKNOWN;
 * AI-generated marketing copy is AI_COPY; provider-verified facts are
 * VERIFIED; owner-supplied facts are OWNER_PROVIDED.
 */

const { CsvProvider, getProvider, normalizeToLead, notConfiguredError } = require('./providers');

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Scoring table, spec section 16. */
const SCORE_SIGNALS = {
  no_website: 30,
  many_reviews: 15, // review_count >= 20
  high_rating: 10, // rating > 4
  public_email: 10,
  phone: 5,
  active_business: 10, // rule-based heuristic, see below
  poor_website: 15, // rule-based heuristic, see below
  strong_category: 10, // category in STRONG_CATEGORIES
};
const SCORE_CAP = 100;

/**
 * Categories with strong demand for done-for-you websites (spec section 16,
 * "strong service category"). Kept as a plain list so the heuristic is
 * transparent and editable.
 */
const STRONG_CATEGORIES = [
  'plumber',
  'plumbing',
  'electrician',
  'electrical',
  'hvac',
  'roofing',
  'roofer',
  'law',
  'lawyer',
  'attorney',
  'law firm',
  'dental',
  'dentist',
];

const CLAIM_CLASSES = ['VERIFIED', 'AI_COPY', 'OWNER_PROVIDED', 'UNKNOWN'];

// Batch 116 — a lead's website home. 'bitpype' (the default) means the
// website story is a BitPype build (the `websites` table + the build
// flow), exactly as before this batch. 'external' means their live site
// lives OUTSIDE BitPype: the existing `website` column then holds that
// site's URL and `website_platform` says where it lives. The kind flag
// never creates, deletes or unlinks a BitPype site — a lead can carry
// both facts (a BitPype site AND an external site); the flag only says
// which one is the lead's primary website home.
const WEBSITE_KINDS = ['bitpype', 'external'];
const WEBSITE_PLATFORMS = ['wordpress', 'other'];

const LEAD_STATUSES = [
  'new',
  'researching',
  'qualified',
  'building',
  'qa_pending',
  'ready',
  'outreach_pending',
  'contacted',
  'engaged',
  'claimed',
  'trial',
  'customer',
  'lost',
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function validationError(message) {
  const err = new Error(message);
  err.code = 'VALIDATION_ERROR';
  return err;
}

/** Digits only — used for phone dedup. */
function normalizePhoneDigits(phone) {
  if (!phone) return '';
  const d = String(phone).replace(/\D/g, '');
  // Drop a leading US country code so +1-555… matches 555…
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

/** Lowercase, strip entity suffixes (LLC/Inc/…), strip punctuation/space. */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(llc|inc|corp|corporation|ltd|co|company|llp|pllc|pa|pc|dba)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Lowercase host without www. from a URL string. */
function domainFromWebsite(website) {
  if (!website) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Lowercase domain from an email address. */
function domainFromEmail(email) {
  const m = String(email || '')
    .trim()
    .toLowerCase()
    .match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
  return m ? m[1] : '';
}

/**
 * Canonical email key for the one-email-one-lead rule. Mirrors the
 * LeadScout portal-contacts normalization (server/portalContacts.js
 * normEmail) so both stores agree on what "the same email" means:
 * trim → lowercase → 240-char cap. '' means "no email" — empty-email
 * leads never collide with each other.
 */
function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
    .slice(0, 240);
}

/**
 * Structured conflict for the one-email-one-lead rule. The message names
 * the existing lead (id + business name) for humans; the same facts ride
 * on the error object (existingLeadId / existingBusinessName / details)
 * for API + MCP callers, so an agent can update the existing lead
 * instead of retrying the create. HTTP layer maps err.status (409).
 */
function duplicateEmailError(existing, email) {
  const err = new Error(
    `email ${email} already belongs to lead #${existing.id} (${existing.business_name}) in this workspace — update that lead instead of creating a new one`
  );
  err.code = 'DUPLICATE_EMAIL';
  err.status = 409;
  err.existingLeadId = existing.id;
  err.existingBusinessName = existing.business_name;
  err.details = {
    existing_lead_id: existing.id,
    existing_business_name: existing.business_name,
    email,
  };
  return err;
}

/**
 * Translate a raw unique-index hit on leads.email_norm into the
 * structured duplicate-email error (covers the check→write race when
 * the DB-level safety net is in place). Returns the original error
 * when the constraint was about something else.
 */
function translateEmailConstraint(db, e, emailNorm) {
  if (emailNorm && /UNIQUE constraint|SQLITE_CONSTRAINT/i.test(String((e && e.message) || ''))) {
    const clash = findLeadByEmail(db, emailNorm);
    if (clash) return duplicateEmailError(clash, emailNorm);
  }
  return e;
}

/** Normalized address key for dedup. */
function normalizeAddress(addr) {
  return String(addr || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim());
}

function isValidUrl(url) {
  const raw = String(url).trim();
  if (!raw || /\s/.test(raw)) return false;
  // Reject non-http(s) schemes like ftp:// or ht!tp://
  if (raw.includes('://') && !/^https?:\/\//i.test(raw)) return false;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return ['http:', 'https:'].includes(u.protocol) && u.hostname.includes('.');
  } catch {
    return false;
  }
}

/** Empty/null/whitespace = no website; valid http(s) URL = has website. */
function leadHasWebsite(website) {
  if (website == null || String(website).trim() === '') return false;
  return isValidUrl(website);
}

/** Normalize websitePresence filter: 'has' | 'no' | null (any). */
function normalizeWebsitePresence(value) {
  const v = String(value == null ? '' : value)
    .trim()
    .toLowerCase();
  if (v === 'has' || v === 'no') return v;
  return null;
}

function toJson(v) {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

function fromJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Get a setting value (string) with fallback. */
function getSetting(db, key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? require('./secretBox').decryptSetting(key, row.value) : fallback;
  } catch {
    return fallback;
  }
}

/** DB handles whose deferred-unique-index warning was already logged. */
const emailIndexDeferredWarned = new WeakSet();

/** Ensure lead_group / email_norm (and indexes) exist on older databases. */
function ensureLeadColumns(db) {
  const cols = db.prepare('PRAGMA table_info(leads)').all();
  if (!cols.length) return;
  if (!cols.some((c) => c.name === 'lead_group')) {
    db.exec('ALTER TABLE leads ADD COLUMN lead_group TEXT');
  }
  // Batch 116: website_kind / website_platform (see WEBSITE_KINDS).
  if (!cols.some((c) => c.name === 'website_kind')) {
    try {
      db.exec("ALTER TABLE leads ADD COLUMN website_kind TEXT NOT NULL DEFAULT 'bitpype'");
    } catch {
      /* ignore */
    }
  }
  if (!cols.some((c) => c.name === 'website_platform')) {
    try {
      db.exec('ALTER TABLE leads ADD COLUMN website_platform TEXT');
    } catch {
      /* ignore */
    }
  }
  // email_norm backs the one-email-one-lead rule (see normalizeEmail):
  // every lead write maintains it, and a partial unique index over the
  // non-empty values is the data-layer safety net.
  if (!cols.some((c) => c.name === 'email_norm')) {
    try {
      db.exec("ALTER TABLE leads ADD COLUMN email_norm TEXT DEFAULT ''");
    } catch {
      /* ignore */
    }
  }
  // Backfill / repair normalized emails. The SQL mirrors normalizeEmail
  // for ASCII addresses (SQLite LOWER is ASCII-only); the domain-layer
  // check always re-normalizes stored emails in JS, so enforcement does
  // not depend on this column being perfect.
  try {
    db.exec(`
      UPDATE leads
      SET email_norm = SUBSTR(LOWER(TRIM(email)), 1, 240)
      WHERE email IS NOT NULL AND TRIM(email) <> ''
        AND (email_norm IS NULL OR email_norm <> SUBSTR(LOWER(TRIM(email)), 1, 240));
      UPDATE leads
      SET email_norm = ''
      WHERE (email IS NULL OR TRIM(email) = '') AND email_norm IS NOT NULL AND email_norm <> '';
    `);
  } catch {
    /* ignore */
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_leads_group ON leads(lead_group)');
  } catch {
    /* ignore */
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_leads_category ON leads(category)');
  } catch {
    /* ignore */
  }
  // Safety net only — enforcement lives in createLead/updateLead. A
  // tenant DB that still holds legacy duplicate emails cannot take the
  // unique index; defer it (warn once per DB handle) instead of crashing
  // startup. The index appears on its own once duplicates are merged.
  try {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_email_norm_unique ON leads(email_norm) WHERE email_norm <> ''"
    );
  } catch (e) {
    if (!emailIndexDeferredWarned.has(db)) {
      emailIndexDeferredWarned.add(db);
      console.warn(
        '[leads] unique email index deferred: this workspace still has duplicate lead emails — merge them to enable the index. Domain-layer enforcement is active regardless. (' +
          (e && e.message) +
          ')'
      );
    }
  }
}

function normalizeGroupName(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, ' ').slice(0, 200);
  return s || null;
}

/**
 * Canonical category casings, keyed by the lowercase/whitespace-collapsed
 * category. Derived from the production (ws1) category distribution on
 * 2026-10-24: for each lowercase key, the most common existing casing wins
 * (ties break toward the more-Title-Case variant). Categories that differ
 * only by case are the SAME category — filters/facets group on the raw
 * string, so 'Salon' + 'salon' used to split one bucket into two.
 */
const CATEGORY_CANONICAL = {
  "accountant": "accountant",
  "antique store": "antique store",
  "appliance repair": "appliance repair",
  "appliance store": "appliance store",
  "auction house": "auction house",
  "auto body": "auto body",
  "auto detailing": "auto detailing",
  "auto detailing service": "Auto Detailing Service",
  "auto glass service": "Auto Glass Service",
  "auto repair": "auto repair",
  "automotive body shop": "Automotive Body Shop",
  "automotive repair shop": "Automotive Repair Shop",
  "awning supplier": "Awning Supplier",
  "bakery": "bakery",
  "bakery & café": "Bakery & Café",
  "barber": "barber",
  "barber shop": "Barber Shop",
  "barbershop": "barbershop",
  "beauty salon": "Beauty Salon",
  "boat propeller repair": "boat propeller repair",
  "boxing gym": "boxing gym",
  "cabinet maker": "cabinet maker",
  "cafe": "cafe",
  "car wash": "car wash",
  "carpet cleaning": "carpet cleaning",
  "chimney sweep": "chimney sweep",
  "chiropractor": "chiropractor",
  "christmas tree farm": "christmas tree farm",
  "cleaning": "cleaning",
  "computer repair": "computer repair",
  "concrete": "concrete",
  "concrete contractor": "concrete contractor",
  "construction": "construction",
  "contractor": "Contractor",
  "courier service": "courier service",
  "dance studio": "Dance Studio",
  "daycare": "daycare",
  "dentist": "Dentist",
  "dentist & dental office": "Dentist & Dental Office",
  "driving school": "driving school",
  "dry cleaner": "dry cleaner",
  "electrician": "electrician",
  "embroidery": "embroidery",
  "equestrian center": "equestrian center",
  "excavation": "excavation",
  "farm": "farm",
  "farm market": "Farm Market",
  "feed store": "feed store",
  "fencing": "fencing",
  "florist": "florist",
  "food truck": "food truck",
  "gift shop": "gift shop",
  "glass & mirror shop": "glass & mirror shop",
  "grocery store": "grocery store",
  "gunsmith": "gunsmith",
  "hair & nail salon": "Hair & Nail Salon",
  "hair salon": "Hair Salon",
  "handyman": "handyman",
  "hvac": "HVAC",
  "hvac contractor": "HVAC Contractor",
  "interior design": "interior design",
  "jewelry store": "Jewelry store",
  "landscape company": "Landscape Company",
  "landscaper": "Landscaper",
  "landscaping": "landscaping",
  "laundromat": "laundromat",
  "lawn mower repair": "lawn mower repair",
  "locksmith": "locksmith",
  "machine shop": "Machine Shop",
  "martial arts": "martial arts",
  "masonry": "masonry",
  "metal fabricator": "Metal Fabricator",
  "motorcycle repair": "motorcycle repair",
  "music lessons": "music lessons",
  "nail salon": "Nail Salon",
  "notary": "notary",
  "painting": "painting",
  "party rental": "party rental",
  "party supply": "party supply",
  "party supply/rental": "party supply/rental",
  "paving": "paving",
  "pawn shop": "pawn shop",
  "pest control": "pest control",
  "pet boarding": "pet boarding",
  "pet groomer": "pet groomer",
  "photo booth service": "photo booth service",
  "photography": "Photography",
  "piano tuning": "piano tuning",
  "plumber": "plumber",
  "plumbing service": "Plumbing Service",
  "pool service": "pool service",
  "pressure washing": "pressure washing",
  "puerto rican restaurant": "Puerto Rican Restaurant",
  "recording studio": "recording studio",
  "restaurant": "restaurant",
  "rim repair": "rim repair",
  "roofer": "Roofer",
  "roofing": "roofing",
  "roofing service": "Roofing Service",
  "salon": "salon",
  "sawmill": "sawmill",
  "self storage": "self storage",
  "self-storage": "self-storage",
  "self-storage facility": "self-storage facility",
  "septic service": "septic service",
  "sewing & alterations": "sewing & alterations",
  "shoe repair": "shoe repair",
  "sign service": "sign service",
  "sign shop": "sign shop",
  "sporting goods store": "sporting goods store",
  "tailor": "tailor",
  "tattoo & piercing shop": "Tattoo & Piercing Shop",
  "taxi service": "taxi service",
  "taxidermist": "taxidermist",
  "thrift store": "thrift store",
  "tire dealer": "tire dealer",
  "tire shop": "tire shop",
  "towing": "towing",
  "transportation service": "transportation service",
  "tree care / arborist": "Tree Care / Arborist",
  "tree service": "tree service",
  "truck repair": "truck repair",
  "upholstery": "upholstery",
  "video game store": "video game store",
  "vintage store": "vintage store",
  "website design": "Website Design",
  "wedding & event dj": "wedding & event DJ",
  "window tinting": "window tinting",
};

/** Words that stay uppercase in the Title-Case fallback for new categories. */
const CATEGORY_ACRONYMS = { hvac: 'HVAC', dj: 'DJ', rv: 'RV' };

function titleCaseCategory(s) {
  return s
    .toLowerCase()
    .split(' ')
    .map((w) => CATEGORY_ACRONYMS[w] || (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Map any case/whitespace variant of a category to its ONE canonical
 * casing: the canonical map above for known categories, Title Case for
 * new ones. Null/empty pass through unchanged (callers store null).
 */
function normalizeCategory(v) {
  if (v === null || v === undefined) return v;
  const s = String(v).trim().replace(/\s+/g, ' ');
  if (!s) return v;
  return CATEGORY_CANONICAL[s.toLowerCase()] || titleCaseCategory(s);
}

/** Default hunt folder label from category + location. */
function defaultDiscoverGroup(category, location) {
  const c = String(category || '').trim();
  const loc = String(location || '').trim();
  if (c && loc) return normalizeGroupName(`${c} · ${loc}`);
  return normalizeGroupName(c || loc || 'Discovery');
}

/** Convert a DB row into a lead object with JSON fields parsed. */
function rowToLead(row) {
  if (!row) return null;
  return {
    ...row,
    hours: fromJson(row.hours, []),
    services: fromJson(row.services, []),
    social_links: fromJson(row.social_links, []),
    tags: fromJson(row.tags, []),
    qualified: Boolean(row.qualified),
    // Batch 116: normalize on read so rows written before the columns
    // existed (or by any other path) always expose a sane kind pair.
    website_kind: row.website_kind === 'external' ? 'external' : 'bitpype',
    website_platform:
      row.website_kind === 'external' &&
      (row.website_platform === 'wordpress' || row.website_platform === 'other')
        ? row.website_platform
        : null,
  };
}

function logEvent(db, leadId, type, detail) {
  db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)').run(
    leadId,
    type,
    detail != null ? String(detail).slice(0, 2000) : null
  );
}

/**
 * Find the lead that owns an email address (one-email-one-lead rule).
 * Compares normalizeEmail() in JS against every row's stored email, so
 * the rule holds even for rows written before the email_norm column
 * existed. Returns the lead (rowToLead shape) or null. `excludeIds`
 * (id or array of ids) lets update/merge ignore the lead being changed
 * plus any leads about to be deleted into it.
 */
function findLeadByEmail(db, email, excludeIds) {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  ensureLeadColumns(db);
  const excluded = new Set(
    (Array.isArray(excludeIds) ? excludeIds : [excludeIds])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
  );
  const rows = db
    .prepare("SELECT id, email FROM leads WHERE email IS NOT NULL AND TRIM(email) <> ''")
    .all();
  for (const r of rows) {
    if (excluded.has(r.id)) continue;
    if (normalizeEmail(r.email) === norm) return getLead(db, r.id);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

/**
 * Batch 116 — resolve + validate the website-kind fields from RAW input
 * (normalizeToLead intentionally stays provider-shaped, so the kind is
 * read from `data` itself; updateLead passes the merged row, whose
 * rowToLead output always carries a kind, so partial updates preserve
 * it). `lead` is the normalized lead (for the website URL check).
 * Rules: kind defaults to 'bitpype'; 'external' REQUIRES a valid
 * http(s) website URL and a platform ('wordpress' | 'other', default
 * 'other'); 'bitpype' always stores platform NULL.
 */
function normalizeWebsiteKind(data, lead) {
  const rawKind = data.website_kind == null ? null : String(data.website_kind).trim().toLowerCase();
  if (rawKind != null && rawKind !== '' && !WEBSITE_KINDS.includes(rawKind)) {
    throw validationError(`invalid website_kind: ${data.website_kind}`);
  }
  const kind = rawKind ? rawKind : 'bitpype';
  let platform = null;
  if (kind === 'external') {
    const rawPlatform =
      data.website_platform == null ? null : String(data.website_platform).trim().toLowerCase();
    if (rawPlatform != null && rawPlatform !== '' && !WEBSITE_PLATFORMS.includes(rawPlatform)) {
      throw validationError(`invalid website_platform: ${data.website_platform}`);
    }
    platform = rawPlatform ? rawPlatform : 'other';
    if (!lead.website || !isValidUrl(lead.website)) {
      throw validationError('a valid website URL is required for an external website');
    }
  }
  return { website_kind: kind, website_platform: platform };
}

/** Validate + normalize lead input. Throws VALIDATION_ERROR. */
function validateLeadInput(data) {
  // Batch 143 (full review): reject object/array values for string
  // fields BEFORE normalizeToLead stringifies them — its s() helper
  // String()s anything, so an MCP lead.create carrying
  // business_name:{…} previously persisted a lead literally named
  // '[object Object]'. Every write path (create, update, CSV
  // import, discovery) funnels through here. tags / hours /
  // services / social_links are the legitimate array fields and
  // are not in this list.
  const STRING_FIELDS = [
    'business_name',
    'name',
    'category',
    'phone',
    'email',
    'website',
    'url',
    'address',
    'city',
    'state',
    'postal_code',
    'zip',
    'postalCode',
    'country',
    'description',
    'source',
    'source_ref',
    'status',
    'notes',
  ];
  for (const f of STRING_FIELDS) {
    const v = data ? data[f] : undefined;
    if (v !== null && typeof v === 'object') {
      throw validationError(`${f} must be a string`);
    }
  }
  const lead = normalizeToLead(data || {});
  // One canonical casing per category across every write path (create,
  // update, CSV import and discovery all funnel through here).
  if (lead.category) lead.category = normalizeCategory(lead.category);
  if (!lead.business_name) throw validationError('business_name is required');
  if (lead.email && !isValidEmail(lead.email)) {
    throw validationError(`invalid email: ${lead.email}`);
  }
  if (lead.website && !isValidUrl(lead.website)) {
    throw validationError(`invalid website URL: ${lead.website}`);
  }
  if (lead.rating !== undefined && (lead.rating < 0 || lead.rating > 5)) {
    throw validationError('rating must be between 0 and 5');
  }
  if (lead.review_count !== undefined && (!Number.isInteger(lead.review_count) || lead.review_count < 0)) {
    throw validationError('review_count must be a non-negative integer');
  }
  if (lead.status && !LEAD_STATUSES.includes(lead.status)) {
    throw validationError(`invalid status: ${lead.status}`);
  }
  if (data.tags !== undefined && !Array.isArray(data.tags)) {
    throw validationError('tags must be an array');
  }
  // Batch 116: website kind/platform ride along on the normalized lead
  // so createLead/updateLead persist them with the rest of the row.
  const kindFields = normalizeWebsiteKind(data || {}, lead);
  lead.website_kind = kindFields.website_kind;
  lead.website_platform = kindFields.website_platform;
  return lead;
}

/**
 * Create a lead. `data` may be raw (any provider shape) — it is normalized
 * first, then validated. Returns the created lead row.
 */
function createLead(db, data) {
  const lead = validateLeadInput(data);
  ensureLeadColumns(db);
  // One email = one lead per workspace. Empty emails never collide.
  const emailNorm = normalizeEmail(lead.email);
  if (emailNorm) {
    const clash = findLeadByEmail(db, lead.email);
    if (clash) throw duplicateEmailError(clash, emailNorm);
  }
  const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
  const notes = data.notes != null ? String(data.notes).slice(0, 10000) : null;
  const status = LEAD_STATUSES.includes(data.status) ? data.status : 'new';
  const leadGroup = normalizeGroupName(data.lead_group ?? data.group);

  const stmt = db.prepare(`
    INSERT INTO leads
      (business_name, category, phone, email, email_norm, website, website_kind, website_platform, address, city, state,
       postal_code, country, latitude, longitude, rating, review_count,
       description, hours, services, social_links, source, source_ref,
       status, tags, lead_group, notes)
    VALUES
      (@business_name, @category, @phone, @email, @email_norm, @website, @website_kind, @website_platform, @address, @city, @state,
       @postal_code, @country, @latitude, @longitude, @rating, @review_count,
       @description, @hours, @services, @social_links, @source, @source_ref,
       @status, @tags, @lead_group, @notes)
  `);
  let info;
  try {
    info = stmt.run({
      // normalizeToLead() drops empty keys; default everything to null so no
      // named parameter is ever missing from the INSERT.
      business_name: null,
      category: null,
      phone: null,
      email: null,
      website: null,
      website_kind: 'bitpype',
      website_platform: null,
      address: null,
      city: null,
      state: null,
      postal_code: null,
      country: null,
      latitude: null,
      longitude: null,
      rating: null,
      review_count: null,
      description: null,
      source: null,
      source_ref: null,
      notes: null,
      lead_group: null,
      ...lead,
      email_norm: emailNorm,
      hours: toJson(lead.hours),
      services: toJson(lead.services),
      social_links: toJson(lead.social_links),
      status,
      tags: JSON.stringify(tags),
      lead_group: leadGroup,
      notes,
    });
  } catch (e) {
    // The unique index caught a duplicate the pre-check raced past.
    throw translateEmailConstraint(db, e, emailNorm);
  }
  logEvent(db, info.lastInsertRowid, 'created', `source=${lead.source || 'manual'}`);
  return getLead(db, info.lastInsertRowid);
}

function getLead(db, id) {
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  return rowToLead(row);
}

/** Partial update of a lead. Validates changed fields. Returns updated row. */
function updateLead(db, id, obj) {
  const existing = getLead(db, id);
  if (!existing) throw validationError(`lead not found: ${id}`);
  const merged = { ...existing, ...(obj || {}) };
  const lead = validateLeadInput(merged);
  // One email = one lead: only a CHANGE to a different normalized email
  // can collide. Re-saving the lead's own email (or editing other
  // fields) never trips the rule — legacy duplicates stay editable.
  const emailNorm = normalizeEmail(lead.email);
  if (emailNorm && emailNorm !== normalizeEmail(existing.email)) {
    const clash = findLeadByEmail(db, lead.email, existing.id);
    if (clash) throw duplicateEmailError(clash, emailNorm);
  }
  const tags = obj.tags !== undefined ? (Array.isArray(obj.tags) ? obj.tags.map(String) : null) : existing.tags;
  if (obj.tags !== undefined && !Array.isArray(obj.tags)) {
    throw validationError('tags must be an array');
  }
  ensureLeadColumns(db);
  const notes = obj.notes !== undefined ? String(obj.notes).slice(0, 10000) : existing.notes;
  const status =
    obj.status !== undefined
      ? LEAD_STATUSES.includes(obj.status)
        ? obj.status
        : (() => {
            throw validationError(`invalid status: ${obj.status}`);
          })()
      : existing.status;
  const leadGroup =
    obj.lead_group !== undefined || obj.group !== undefined
      ? normalizeGroupName(obj.lead_group !== undefined ? obj.lead_group : obj.group)
      : existing.lead_group || null;

  try {
    db.prepare(
        `
    UPDATE leads SET
      business_name=@business_name, category=@category, phone=@phone,
      email=@email, email_norm=@email_norm, website=@website, website_kind=@website_kind,
      website_platform=@website_platform, address=@address, city=@city,
      state=@state, postal_code=@postal_code, country=@country,
      latitude=@latitude, longitude=@longitude, rating=@rating,
      review_count=@review_count, description=@description,
      hours=@hours, services=@services, social_links=@social_links,
      source=@source, source_ref=@source_ref, status=@status,
      tags=@tags, lead_group=@lead_group, notes=@notes, updated_at=datetime('now')
    WHERE id=@id
  `
      )
      .run({
        // normalizeToLead() drops empty keys; default everything to null so no
        // named parameter is ever missing from the UPDATE.
        business_name: null,
        category: null,
        phone: null,
        email: null,
        website: null,
        website_kind: 'bitpype',
        website_platform: null,
        address: null,
        city: null,
        state: null,
        postal_code: null,
        country: null,
        latitude: null,
        longitude: null,
        rating: null,
        review_count: null,
        description: null,
        source: null,
        source_ref: null,
        notes: null,
        lead_group: null,
        ...lead,
        email_norm: emailNorm,
        hours: toJson(lead.hours),
        services: toJson(lead.services),
        social_links: toJson(lead.social_links),
        status,
        tags: JSON.stringify(tags || []),
        lead_group: leadGroup,
        notes,
        id,
      });
  } catch (e) {
    // The unique index caught a duplicate the pre-check raced past.
    throw translateEmailConstraint(db, e, emailNorm);
  }
  logEvent(db, id, 'updated', 'fields updated');
  return getLead(db, id);
}

/** Tolerant reference counter: feature tables may not exist on older tenant DBs. */
function countLeadRefs(db, table, leadId, extraSql = '', extraParams = []) {
  const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!found) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE lead_id = ? ${extraSql}`).get(leadId, ...extraParams);
  return Number(row && row.c) || 0;
}

/**
 * Batch 45 (B1) — pre-flight reference summary for the delete confirm:
 * the headline dependents a lead delete will touch, computed BEFORE
 * anything is deleted so the UI can show it and the caller can decide
 * with open eyes. (Batch 143: the counts below are the confirm-dialog
 * headline set, not the full drop list — deleteLead drops every
 * lead_id-keyed tenant table except design_jobs, which keep their own
 * lifecycle by design; designJobs is counted here so the UI can say so.)
 */
function leadReferenceSummary(db, id) {
  const leadId = Number(id);
  let websites = [];
  try {
    websites = db.prepare('SELECT id, archived_at FROM websites WHERE lead_id = ? ORDER BY id').all(leadId);
  } catch {
    websites = [];
  }
  const websiteIds = websites.map((w) => Number(w.id));
  let siteDomains = countLeadRefs(db, 'site_domains', leadId);
  if (websiteIds.length) {
    const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'site_domains'").get();
    if (found) {
      const ph = websiteIds.map(() => '?').join(',');
      const row = db
        .prepare(`SELECT COUNT(*) AS c FROM site_domains WHERE lead_id = ? OR website_id IN (${ph})`)
        .get(leadId, ...websiteIds);
      siteDomains = Number(row && row.c) || 0;
    }
  }
  return {
    websites: websites.length,
    websitesActive: websites.filter((w) => !w.archived_at).length,
    websitesArchived: websites.filter((w) => !!w.archived_at).length,
    websiteIds,
    siteDomains,
    designJobs: countLeadRefs(db, 'design_jobs', leadId),
    domainTransactions: countLeadRefs(db, 'domain_transactions', leadId),
    bookings: countLeadRefs(db, 'bookings', leadId),
    callLogs: countLeadRefs(db, 'call_logs', leadId),
    contactForms: countLeadRefs(db, 'contact_forms', leadId),
    formSubmissions: countLeadRefs(db, 'form_submissions', leadId),
    // Batch 85: member data owned by this lead's site. These tables key
    // on lead_id with no FK to leads, so a lead delete used to orphan
    // them (found by the Batch 82 live proof). Portal accounts live in
    // the platform DB and are inventoried by the domain facade, which
    // merges them into this summary as `portalAccounts`.
    siteMembers: countLeadRefs(db, 'site_members', leadId),
    siteMemberSessions: countLeadRefs(db, 'site_member_sessions', leadId),
    siteModuleEmbeds: countLeadRefs(db, 'site_module_embeds', leadId),
  };
}

/**
 * Delete a lead and its dependent rows.
 *
 * Batch 45 (B1 hardening): this used to lean on the schema cascade —
 * websites.lead_id is ON DELETE CASCADE — so deleting a lead silently
 * HARD-deleted its website row + versions while the Cloudflare Pages
 * project kept serving and site_domains stayed 'linked' at a dead site.
 * Now, inside the same transaction:
 *   1. The reference summary is computed first (also returned, so the
 *      confirm the user saw matches what happened).
 *   2. Every non-archived website is soft-archived through the website
 *      path (websiteEngine.deleteWebsite — the Batch 27 archive), never
 *      silently hard-deleted by the cascade. The archived rows then
 *      follow the lead; nothing LIVE is ever destroyed by this call.
 *   3. site_domains rows for the lead / its websites are deleted in-tx
 *      (they are plain refs with no FK — they used to dangle 'linked').
 * Design jobs keep their own lifecycle (deliberately not deleted).
 */
function deleteLead(db, id) {
  const existing = getLead(db, id);
  if (!existing) throw validationError(`lead not found: ${id}`);
  let summary = null;
  const archivedWebsiteIds = [];
  let siteRows = [];
  let chatAttachmentRows = [];
  let assistantAttachmentRows = [];
  const tx = db.transaction(() => {
    summary = leadReferenceSummary(db, id);
    // Batch 67: remember the site rows (name/preview path) before the
    // cascade takes them, so their export folders can be removed and
    // the deletion can be activity-logged after the transaction.
    try {
      siteRows = db.prepare('SELECT id, name, preview_path FROM websites WHERE lead_id = ?').all(id);
    } catch {
      siteRows = [];
    }
    // Batch 89: remember design-chat attachment files before their rows
    // drop, so the files can be unlinked after the transaction.
    try {
      const attTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'site_chat_attachments'")
        .get();
      if (attTable) {
        chatAttachmentRows = db
          .prepare('SELECT stored_rel, thumb_rel FROM site_chat_attachments WHERE lead_id = ?')
          .all(id);
      }
    } catch {
      chatAttachmentRows = [];
    }
    // Batch 168 (S8#F1): same for Assistant (Batch 161) attachments —
    // rows keyed to this lead OR to a conversation of this lead (the
    // conversation rows drop in the same transaction below).
    try {
      const asstTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_attachments'")
        .get();
      if (asstTable) {
        assistantAttachmentRows = db
          .prepare(
            `SELECT stored_rel FROM assistant_attachments
             WHERE lead_id = ?
                OR conversation_id IN (SELECT id FROM assistant_conversations WHERE lead_id = ?)`
          )
          .all(id, id);
      }
    } catch {
      assistantAttachmentRows = [];
    }
    // Archive-first for websites (soft delete via the website path).
    if (summary.websiteIds.length) {
      const engine = require('./websiteEngine');
      for (const siteId of summary.websiteIds) {
        const site = db.prepare('SELECT archived_at FROM websites WHERE id = ?').get(siteId);
        if (site && !site.archived_at) {
          engine.deleteWebsite(db, siteId);
          archivedWebsiteIds.push(siteId);
        }
      }
    }
    const drop = (table) => {
      // Some tenant DBs predate a feature table; skip tables that do not exist.
      const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (found) db.prepare(`DELETE FROM ${table} WHERE lead_id = ?`).run(id);
    };
    // site_domains cleanup (B1): the lead's own rows plus any rows that
    // point at the lead's websites, all inside this transaction.
    const sdTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'site_domains'").get();
    if (sdTable) {
      db.prepare('DELETE FROM site_domains WHERE lead_id = ?').run(id);
      if (summary.websiteIds.length) {
        const ph = summary.websiteIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM site_domains WHERE website_id IN (${ph})`).run(...summary.websiteIds);
      }
    }
    // Dependency order, all inside this one transaction: submissions belong
    // to the lead's forms, so they go before the forms themselves. ai_usage
    // is the hard blocker — its FK to leads has no ON DELETE CASCADE, so the
    // lead delete failed FK_CONFLICT whenever a lead had AI usage rows.
    // contact_forms / design_learning_events carry plain lead_id columns (no
    // FK) and would otherwise be left orphaned.
    drop('form_submissions');
    drop('contact_forms');
    // Batch 85: member data goes with the lead — sessions first (they
    // belong to members), then the member accounts and the module embed
    // rows that mount the lead's modules. All three key on lead_id with
    // no FK, so without this they outlived the lead as orphans. Portal
    // accounts (platform DB) are swept by the domain facade in the same
    // delete operation.
    drop('site_member_sessions');
    drop('site_members');
    drop('site_module_embeds');
    // Batch 124: the shared taxonomy is lead-scoped too — assignments
    // first (they reference categories), then the categories.
    drop('module_category_assignments');
    drop('module_categories');
    // Batch 139: the price list is lead-scoped content. Linked
    // entries hold no money state of their own — the prices live on
    // the source records, which drop under their own modules.
    drop('pricing_entries');
    // Batch 89: design-chat image attachments belong to the lead's
    // conversation; their rows drop here and the files are unlinked
    // after the transaction (paths collected before the tx below).
    drop('site_chat_attachments');
    // Batch 93: the builder chat's pending clarification and any
    // undelivered design-agent thread messages belong to the lead's
    // conversation too — they drop with the lead.
    drop('site_chat_pending');
    drop('site_chat_messages');
    // Batch 90: chart definitions belong to the lead's Charts module;
    // they carry a plain lead_id with no FK, so drop them explicitly
    // (module delete also sweeps them via modulePurgeSteps).
    drop('charts');
    // Batch 118: newsletter rows are lead_id-keyed too (module delete
    // sweeps them via modulePurgeSteps as well).
    drop('newsletter_sends');
    drop('newsletter_subscribers');
    drop('newsletter_configs');
    // Batch 134 (bug hunt): the Batch 122/124–128 tables are lead_id-
    // keyed with no FK to leads, and none were in this list — deleting
    // a lead orphaned its whole shop (products, the variant tree,
    // orders AND their line items, buyer emails included), its QR
    // codes, photo submissions + config, checkout config, shared-layer
    // refs, and the LeadScout events the window's captures wrote.
    // Children first, mirroring modulePurgeSteps' order.
    drop('ecommerce_order_items');
    drop('ecommerce_product_variants');
    drop('ecommerce_product_option_values');
    drop('ecommerce_product_options');
    drop('ecommerce_orders');
    drop('ecommerce_products');
    drop('module_qrcodes');
    drop('photocapture_submissions');
    drop('photocapture_configs');
    drop('checkout_configs');
    drop('module_shared_refs');
    // Batch 131 finisher: the comments tables are lead_id-keyed with
    // no FK too (the Batch 134 lesson — a window table left off this
    // list is orphaned by every delete). Likes first (they reference
    // comments and items), then comments, then the config.
    drop('module_likes');
    drop('module_comments');
    drop('comments_configs');
    // Batch 178: the deleted lead's Router follows go with it. Its
    // CLAIMS are released, not dropped — router_leads are workspace
    // feed rows (the poster is not this lead's data); an exclusive
    // claim must not keep a lead out of every feed forever because
    // the claimer was deleted.
    drop('router_follows');
    if (leadTableExists(db, 'router_leads')) {
      db.prepare(
        "UPDATE router_leads SET status = 'new', claimed_by_lead_id = NULL, claimed_at = NULL WHERE claimed_by_lead_id = ? AND status = 'claimed'"
      ).run(id);
    }
    // Batch 143 (full review): the drop list above only ever grew by
    // the tables each batch's own window exercised — the Batch 134
    // suite seeded ~10 tables, so the pre-122 module families were
    // never added and every delete orphaned them (a deleted lead kept
    // its blog posts, bookings, chatbot history, call logs — and its
    // encrypted Stripe key rows in shop_stripe_keys /
    // membership_stripe_keys / lead_payment_configs). The rule from
    // Batch 134 is now completed: EVERY lead_id-keyed tenant table is
    // dropped here except design_jobs and domain_transactions
    // (deliberate keeps — job lifecycle and financial history). The
    // batch143 suite derives the table inventory from the schema and
    // fails if a future table is added without a drop or a documented
    // keep. Children before parents where rows reference each other.
    drop('blog_posts');
    drop('courses');
    // course_lessons / gallery_images key on the parent row, not the
    // lead — sweep the ones whose parent just went (same shape as the
    // merge child sweep in reassignLeadDependents).
    if (leadTableExists(db, 'course_lessons') && leadTableExists(db, 'courses')) {
      db.prepare('DELETE FROM course_lessons WHERE course_id NOT IN (SELECT id FROM courses)').run();
    }
    drop('gallery_albums');
    if (leadTableExists(db, 'gallery_images') && leadTableExists(db, 'gallery_albums')) {
      db.prepare('DELETE FROM gallery_images WHERE album_id NOT IN (SELECT id FROM gallery_albums)').run();
    }
    drop('directory_listings');
    drop('faq_items');
    drop('testimonials');
    drop('team_members');
    drop('events');
    drop('offers');
    drop('menu_items');
    drop('menu_categories');
    drop('careers_postings');
    drop('video_items');
    drop('bookings');
    drop('booking_blocks');
    drop('booking_services');
    drop('booking_hours');
    drop('booking_settings');
    drop('chatbot_messages');
    drop('chatbot_sessions');
    drop('chatbot_leads');
    drop('chatbot_escalations');
    drop('chatbot_knowledge');
    drop('chatbot_settings');
    drop('estimate_requests');
    drop('estimate_options');
    drop('estimate_configs');
    drop('social_posts');
    drop('social_weekly_batches');
    drop('social_campaigns');
    drop('social_accounts');
    drop('socialfeed_cache');
    drop('socialfeed_configs');
    drop('googlereviews_cache');
    drop('googlereviews_configs');
    drop('datatable_rows');
    drop('datatable_configs');
    drop('call_rescue_messages');
    drop('call_rescues');
    drop('call_rescue_configs');
    drop('call_logs');
    drop('calls_billing');
    drop('calltracking_rotation_numbers');
    drop('calltracking_configs');
    drop('member_subscriptions');
    drop('membership_tiers');
    drop('members_configs');
    drop('site_member_reset_tokens');
    drop('site_member_preview_grants');
    drop('lead_payment_configs');
    drop('membership_stripe_keys');
    drop('shop_stripe_keys');
    drop('seo_proposals');
    drop('seo_history');
    drop('change_requests');
    drop('design_email_redesigns');
    drop('campaign_messages');
    drop('intent_scores');
    drop('prospect_events');
    drop('gbp_change_sets');
    drop('gbp_snapshots');
    drop('gbp_connections');
    drop('site_chat_plans');
    drop('site_chat_summaries');
    drop('site_chat_daily_usage');
    drop('site_screenshots');
    // domain_transactions deliberately KEPT: financial history
    // survives lead deletion (Batch 45 doctrine, suite-pinned).
    drop('leadscout_capture_failures');
    drop('leadscout_events');
    drop('lead_onboarding_items');
    drop('ai_usage');
    drop('design_learning_events');
    drop('business_facts');
    drop('lead_scores');
    drop('lead_events');
    // Batch 168 (S8#F1): the post-143 module families were in NO drop
    // or merge list — the 143 suite's inventory came from the tables
    // its own fixture seeded, so tables added by Batches 158/161/162/
    // 164 fell outside it silently. Deleting a lead orphaned its
    // Custom Code blocks (owner HTML/JS + a live public_token that
    // stayed token-addressable), its lead-calling contact notes, its
    // review→social dedupe rows, and its Assistant conversations /
    // messages / attachments. All drop here; the batch168 suite
    // derives its inventory from a FULLY-provisioned schema so the
    // next new table cannot fall out the same way.
    drop('module_custom_code_blocks');
    drop('lead_contact_notes');
    drop('googlereviews_social_posts');
    // Assistant children first: attachments + messages key on the
    // conversation, conversations key on the lead.
    if (leadTableExists(db, 'assistant_attachments')) {
      db.prepare(
        `DELETE FROM assistant_attachments
         WHERE lead_id = ?
            OR conversation_id IN (SELECT id FROM assistant_conversations WHERE lead_id = ?)`
      ).run(id, id);
    }
    drop('assistant_conversations');
    if (leadTableExists(db, 'assistant_messages') && leadTableExists(db, 'assistant_conversations')) {
      db.prepare(
        'DELETE FROM assistant_messages WHERE conversation_id NOT IN (SELECT id FROM assistant_conversations)'
      ).run();
    }
    db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  });
  tx();
  // Batch 67 — a lead delete must not be silent, and must not orphan
  // storage. Forensics (2026-10-29): deleting fixture lead 641 took
  // its ARCHIVED website 28's row with it via the websites.lead_id
  // CASCADE (versions + claim manifest followed), wrote NO activity
  // row, and left ws-1-site-28-…'s export folder on disk — with no
  // websites row left, no purge could ever reclaim it, and the folder
  // kept serving publicly until the preview gate was made fail-closed
  // (Batch 67 M-1). So: log the deletion with the website ids that
  // followed the lead, and remove those sites' export folders (the
  // rows are gone; the folders are pure orphans). Best-effort: a
  // storage failure never resurrects the lead.
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'leads',
      `Lead #${id} ("${String(existing.business_name || '').slice(0, 80)}") deleted; ` +
        `${siteRows.length} website row(s) followed the lead` +
        (siteRows.length ? ` (ids: ${siteRows.map((s) => s.id).join(', ')})` : '') +
        '; export folders removed where present.'
    );
  } catch {
    /* activity logging must never break the delete */
  }
  let removedExportFolders = 0;
  if (siteRows.length) {
    try {
      const engine = require('./websiteEngine');
      for (const site of siteRows) {
        try {
          const res = engine.removeSiteStorageFolders(site.id, {
            siteName: site.name,
            previewPath: site.preview_path,
          });
          removedExportFolders += (res.removed || []).length;
        } catch {
          /* best-effort per site */
        }
      }
    } catch {
      /* best-effort */
    }
  }
  // Batch 89 — unlink the design-chat attachment files whose rows the
  // transaction dropped (stored_rel is storage-root-relative, so no
  // workspace knowledge is needed here). Best-effort, like the export
  // folders above: a storage failure never resurrects the lead.
  let removedChatAttachments = 0;
  if (chatAttachmentRows.length) {
    try {
      const chatAtt = require('../server/siteChatAttachments');
      const before = chatAttachmentRows.length;
      chatAtt.deleteFilesForRows(chatAttachmentRows);
      removedChatAttachments = before;
    } catch {
      /* best-effort */
    }
  }
  // Batch 168 (S8#F1): unlink the Assistant attachment files whose
  // rows the transaction dropped (same best-effort discipline).
  let removedAssistantAttachments = 0;
  if (assistantAttachmentRows.length) {
    try {
      const asst = require('../server/assistantChat');
      const before = assistantAttachmentRows.length;
      asst.deleteAttachmentFilesForRows(assistantAttachmentRows);
      removedAssistantAttachments = before;
    } catch {
      /* best-effort */
    }
  }
  return {
    ok: true,
    id,
    summary,
    archivedWebsiteIds,
    removedExportFolders,
    removedChatAttachments,
    removedAssistantAttachments,
  };
}

/* ------------------------------------------------------------------ */
/* CSV import                                                          */
/* ------------------------------------------------------------------ */

const CSV_MAX_BYTES = 1024 * 1024; // 1 MB

/**
 * Import leads from CSV text. Returns { created, skipped, duplicates, errors }.
 * Row-level failures never abort the whole import. A row whose email
 * already belongs to a lead (one-email-one-lead rule) is skipped — not
 * fatal — and counted in `duplicates` with the existing lead's id.
 */
function importCsv(db, text, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw validationError('CSV text is empty');
  }
  if (Buffer.byteLength(text, 'utf8') > CSV_MAX_BYTES) {
    throw validationError('CSV text exceeds 1 MB limit');
  }
  ensureLeadColumns(db);
  const leadGroup = normalizeGroupName(opts.group || opts.lead_group);
  const provider = new CsvProvider();
  const raws = provider.parse(text);
  const result = { created: 0, skipped: 0, duplicates: 0, errors: [], group: leadGroup };
  raws.forEach((raw, i) => {
    const lineNo = i + 2; // header is line 1
    if (!Object.values(raw).some((v) => String(v).trim() !== '')) {
      result.skipped++;
      return;
    }
    try {
      createLead(db, {
        ...raw,
        source: 'csv',
        lead_group: normalizeGroupName(raw.lead_group || raw.group) || leadGroup,
      });
      result.created++;
    } catch (e) {
      result.skipped++;
      if (e && e.code === 'DUPLICATE_EMAIL') {
        result.duplicates++;
        result.errors.push({
          line: lineNo,
          error: e.message,
          duplicate_of: e.existingLeadId != null ? e.existingLeadId : null,
        });
      } else {
        result.errors.push({ line: lineNo, error: e.message });
      }
    }
  });
  return result;
}

/**
 * Discover leads from a provider search and insert new ones.
 * Skips rows whose source_ref already exists. Optionally scores each new lead.
 */
async function discoverLeads(db, opts = {}) {
  ensureLeadColumns(db);
  const { getProvider } = require('./providers');
  const providerName = String(opts.provider || 'tavily').trim() || 'tavily';
  const provider = getProvider(providerName);
  if (!provider) throw validationError(`unknown provider: ${providerName}`);
  if (provider.name === 'csv' || provider.name === 'manual') {
    throw validationError(`provider "${providerName}" does not support discovery search`);
  }
  if (provider.configured === false) {
    await provider.search(opts); // throws PROVIDER_NOT_CONFIGURED
  }
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 10));
  const rawCategory = String(opts.category != null ? opts.category : opts.query || '').trim();
  const anyCategory = !rawCategory || rawCategory === '*' || /^any$/i.test(rawCategory);
  // "*" / "any" / blank → broad local-business search; don't store "*" as the niche.
  const query = anyCategory ? 'local business' : String(opts.query || rawCategory || 'business').trim() || 'business';
  const category = anyCategory ? '' : rawCategory;
  const location = String(opts.location || 'Springfield').trim() || 'Springfield';
  const scoreAfter = opts.score !== false;
  const websitePresence = normalizeWebsitePresence(opts.websitePresence);
  const leadGroup =
    normalizeGroupName(opts.group || opts.lead_group) || defaultDiscoverGroup(anyCategory ? 'Any' : category, location);
  const autoTags = [anyCategory ? 'any' : category, location].map((t) => String(t).trim()).filter(Boolean);

  // Over-fetch when post-filtering by website presence (providers rarely support it natively).
  const fetchLimit = websitePresence ? Math.min(50, Math.max(limit * 3, limit)) : limit;

  const searchDepthSetting = String(getSetting(db, 'providers.tavily.search_depth', 'advanced') || 'advanced')
    .trim()
    .toLowerCase();
  const searchDepth = searchDepthSetting === 'basic' ? 'basic' : 'advanced';

  const rawResults = await provider.search({
    query,
    category,
    location,
    limit: fetchLimit,
    radiusMiles: opts.radiusMiles,
    minRating: opts.minRating,
    minReviews: opts.minReviews,
    websitePresence: websitePresence || undefined,
    searchDepth,
  });

  // Post-filter: empty/null/whitespace website = no; valid http(s) URL = has.
  // Providers (e.g. Tavily) have no native website-presence filter — only query hints.
  // Directory listing URLs are no longer treated as the business website upstream.
  let filtered = rawResults;
  if (websitePresence) {
    filtered = rawResults.filter((raw) => {
      const website = (provider.normalize ? provider.normalize(raw) : raw).website;
      const has = leadHasWebsite(website);
      return websitePresence === 'has' ? has : !has;
    });
  }

  const result = {
    provider: provider.name,
    queried: rawResults.length,
    created: 0,
    skipped: 0,
    scored: 0,
    leads: [],
    errors: [],
    group: leadGroup,
    websitePresence: websitePresence || null,
    searchDepth,
    warning: null,
  };

  if (rawResults.length === 0) {
    result.warning = `No search hits from ${provider.name} for "${category}" in "${location}". Try a clearer category/location or check the Tavily key.`;
    console.warn(`[discover] ${result.warning}`);
  } else if (websitePresence && filtered.length === 0) {
    result.warning = `Found ${rawResults.length} hits but none matched website filter "${websitePresence}". Try "Any" or a different niche/location.`;
    console.warn(`[discover] ${result.warning}`);
  } else if (filtered.length < limit) {
    result.warning = `Thin results: ${filtered.length} usable of ${rawResults.length} hits (wanted ${limit}).`;
    console.warn(`[discover] ${result.warning}`);
  }
  const existingRef = db.prepare('SELECT id FROM leads WHERE source = ? AND source_ref = ?');

  for (const raw of filtered) {
    if (result.created >= limit) break;
    try {
      const normalized = provider.normalize ? provider.normalize(raw) : raw;
      const source = normalized.source || provider.name;
      const sourceRef = normalized.source_ref || null;
      if (sourceRef) {
        const hit = existingRef.get(source, sourceRef);
        if (hit) {
          result.skipped++;
          continue;
        }
      }
      const tags = new Set([...(Array.isArray(normalized.tags) ? normalized.tags : []), ...autoTags]);
      const lead = createLead(db, {
        ...normalized,
        category: normalized.category || category,
        source,
        source_ref: sourceRef,
        status: 'new',
        lead_group: leadGroup,
        tags: [...tags],
      });
      result.created++;
      result.leads.push({
        id: lead.id,
        business_name: lead.business_name,
        score: lead.score,
        lead_group: lead.lead_group,
      });
      if (scoreAfter) {
        try {
          const scored = scoreLead(db, lead.id);
          result.scored++;
          result.leads[result.leads.length - 1].score = scored.score;
        } catch (scoreErr) {
          result.errors.push({ name: lead.business_name, error: `score: ${scoreErr.message}` });
        }
      }
    } catch (e) {
      result.skipped++;
      result.errors.push({ name: (raw && (raw.business_name || raw.name)) || '?', error: e.message });
    }
  }

  try {
    const thin = result.warning ? ` ${result.warning}` : '';
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'leads',
      `Discover via ${provider.name}: ${result.created} created, ${result.skipped} skipped, ${result.queried} queried → group "${leadGroup}" (${category} · ${location}).${thin}`.slice(
        0,
        2000
      )
    );
  } catch {
    /* ignore */
  }

  return result;
}

/**
 * Facets for filtering: distinct groups, categories, and tags with counts.
 */
function listLeadFacets(db) {
  ensureLeadColumns(db);
  const groups = db
    .prepare(
      `
    SELECT COALESCE(NULLIF(TRIM(lead_group), ''), '(ungrouped)') AS name, COUNT(*) AS count
    FROM leads GROUP BY name ORDER BY count DESC, name ASC LIMIT 100
  `
    )
    .all();
  const categories = db
    .prepare(
      `
    SELECT COALESCE(NULLIF(TRIM(category), ''), '(uncategorized)') AS name, COUNT(*) AS count
    FROM leads GROUP BY name ORDER BY count DESC, name ASC LIMIT 100
  `
    )
    .all();
  const tagCounts = new Map();
  const tagRows = db.prepare("SELECT tags FROM leads WHERE tags IS NOT NULL AND tags != ''").all();
  for (const row of tagRows) {
    let tags = [];
    try {
      tags = JSON.parse(row.tags || '[]');
    } catch {
      tags = [];
    }
    if (!Array.isArray(tags)) continue;
    for (const t of tags) {
      const key = String(t || '').trim();
      if (!key) continue;
      tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
    }
  }
  const tags = [...tagCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 100);
  return { groups, categories, tags };
}

/* ------------------------------------------------------------------ */
/* Duplicate detection + merge                                         */
/* ------------------------------------------------------------------ */

/**
 * Find likely duplicates of a lead (spec section 14).
 * Matches on: normalized phone digits, normalized business name
 * (lowercase, entity suffixes + punctuation stripped), normalized address,
 * website domain, email domain, exact email.
 * Returns [{ id, business_name, matched_on: [...] }].
 */
function findDuplicates(db, lead) {
  const me = typeof lead === 'object' ? lead : getLead(db, lead);
  if (!me) throw validationError('lead not found for duplicate check');

  const myPhone = normalizePhoneDigits(me.phone);
  const myName = normalizeName(me.business_name);
  const myDomain = domainFromWebsite(me.website) || domainFromEmail(me.email);
  const myEmail = String(me.email || '')
    .trim()
    .toLowerCase();
  const myAddr = normalizeAddress(me.address);

  if (!myPhone && !myName && !myAddr && !myDomain && !myEmail) return [];

  const rows = db
    .prepare('SELECT id, business_name, phone, email, website, address FROM leads WHERE id != ?')
    .all(me.id);

  const out = [];
  for (const r of rows) {
    const matchedOn = [];
    const rPhone = normalizePhoneDigits(r.phone);
    if (myPhone && rPhone && myPhone === rPhone && myPhone.length >= 7) matchedOn.push('phone');
    const rName = normalizeName(r.business_name);
    if (myName && rName && myName === rName) matchedOn.push('name');
    const rAddr = normalizeAddress(r.address);
    if (myAddr && rAddr && myAddr === rAddr && myAddr.length >= 8) matchedOn.push('address');
    const rDomain = domainFromWebsite(r.website) || domainFromEmail(r.email);
    if (myDomain && rDomain && myDomain === rDomain) matchedOn.push('domain');
    const rEmail = String(r.email || '')
      .trim()
      .toLowerCase();
    if (myEmail && rEmail && myEmail === rEmail) matchedOn.push('email');
    if (matchedOn.length > 0) {
      out.push({ id: r.id, business_name: r.business_name, matched_on: matchedOn });
      if (out.length >= 20) break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Merge: dependent-table treatment                                    */
/* ------------------------------------------------------------------ */

/**
 * Every table that carries a lead_id must be dealt with before the dropped
 * lead row is deleted, or the delete fails (ai_usage's FK is ON DELETE
 * NO ACTION and the app runs with foreign_keys=ON) or silently destroys
 * data (the ON DELETE CASCADE tables). Treatment per table, inventoried
 * from the live schema (PRAGMA foreign_key_list + index_list):
 *
 * MOVE — no per-lead uniqueness, plain reassignment to the keeper:
 *   ai_usage, business_facts, lead_scores, lead_events, intent_scores,
 *   prospect_events, campaign_messages, contact_forms, form_submissions,
 *   design_jobs, design_learning_events, design_email_redesigns,
 *   directory_listings, ecommerce_orders, faq_items, bookings,
 *   booking_blocks, chatbot_escalations, chatbot_knowledge, chatbot_leads,
 *   chatbot_messages, chatbot_sessions, leadscout_capture_failures,
 *   leadscout_events, site_domains, site_screenshots, social_campaigns,
 *   social_posts, social_weekly_batches, testimonials, offers,
 *   menu_categories, menu_items, careers_postings, video_items,
 *   estimate_options, estimate_requests
 *
 * MOVE_DEDUPE — UNIQUE(lead_id, <keys>): rows whose key the keeper already
 *   has are dropped (keeper wins); the rest are reassigned:
 *   blog_posts[slug], booking_hours[weekday,start_time,end_time],
 *   booking_services[slug], courses[slug], ecommerce_products[slug],
 *   events[slug], gallery_albums[slug], team_members[slug],
 *   site_module_embeds[module_type], social_accounts[platform,account_id]
 *
 * SINGLETON — lead_id is the PRIMARY KEY (one settings row per lead):
 *   booking_settings, chatbot_settings, estimate_configs. Keeper's row
 *   wins; if the keeper has none, the dropped lead's row is reassigned.
 *
 * WEBSITES — lead_id is UNIQUE with ON DELETE CASCADE, and a merge must
 *   never delete a website: reassigned when the keeper has none. If BOTH
 *   leads own a website the merge aborts with a validation error — the
 *   schema allows one website per lead, so a human must decide which site
 *   survives before the leads can merge.
 */
const MERGE_MOVE_TABLES = [
  'ai_usage',
  'business_facts',
  'lead_scores',
  'lead_events',
  'intent_scores',
  'prospect_events',
  'campaign_messages',
  'contact_forms',
  'form_submissions',
  'design_jobs',
  'design_learning_events',
  'design_email_redesigns',
  'directory_listings',
  'ecommerce_orders',
  'faq_items',
  'bookings',
  'booking_blocks',
  'chatbot_escalations',
  'chatbot_knowledge',
  'chatbot_leads',
  'chatbot_messages',
  'chatbot_sessions',
  'leadscout_capture_failures',
  'leadscout_events',
  'site_domains',
  'site_screenshots',
  'social_campaigns',
  'social_posts',
  'social_weekly_batches',
  'testimonials',
  'offers',
  'menu_categories',
  'menu_items',
  'careers_postings',
  'video_items',
  'estimate_options',
  'estimate_requests',
  'domain_transactions',
  'site_member_sessions',
  'site_member_reset_tokens',
  'site_member_preview_grants',
  'membership_tiers',
  'member_subscriptions',
  'call_logs',
  // Batch 143 (full review): newsletter_subscribers is deliberately
  // NOT in this MOVE list — it is in MERGE_DEDUPE_TABLES (unique per
  // (lead_id, email), keeper's row wins). Listing it in both made the
  // MOVE loop re-key the dropped lead's rows first, so a subscriber
  // email both leads had collected violated the UNIQUE index and the
  // whole merge rolled back — the exact duplicate-email case merge
  // exists for was unmergeable.
  'newsletter_sends',
  // Batch 134 (bug hunt): the Batch 124–128 lead-scoped tables move
  // with the lead — before this they stayed keyed to the dropped lead
  // and were silently orphaned by every merge (a merged shop kept its
  // products but lost every variant; orders moved without their line
  // items). module_categories moves here too, but only after the
  // (scope, slug) clash remap in reassignLeadDependents re-points
  // assignments at the keeper's twin categories.
  'module_qrcodes',
  'photocapture_submissions',
  'ecommerce_order_items',
  'ecommerce_product_options',
  'ecommerce_product_option_values',
  'ecommerce_product_variants',
  'module_categories',
  'module_category_assignments',
  // Batch 131 finisher: comments move with the lead (their
  // leadscout_events already move above, and the comment_id refs on
  // those events stay valid — comment row ids never change hands).
  'module_comments',
  // Batch 143 (full review): tables no treatment list mentioned, so a
  // merge stranded them on the dropped lead (whose row is then
  // deleted — permanent orphans; a merged site silently lost its
  // Data Tables and Charts). Plain content/history rows move.
  'datatable_rows',
  'charts',
  'site_chat_messages',
  'site_chat_attachments',
  'site_chat_plans',
  'call_rescue_messages',
  'call_rescues',
  'change_requests',
  'seo_history',
  'seo_proposals',
  // gbp_snapshots / gbp_change_sets carry FK ON DELETE CASCADE to
  // leads, so without a move here the merge DESTROYED the dropped
  // lead's GBP history when its lead row was deleted.
  'gbp_snapshots',
  'gbp_change_sets',
  // Batch 139: price-list entries move with the lead — their ids and
  // linked_id targets (services/products, also moving) stay valid.
  'pricing_entries',
  // Batch 168 (S8#F1): the post-143 families move too — Custom Code
  // blocks (their global-unique public_tokens and row ids are
  // untouched by a re-key), lead-calling contact notes, and the
  // Assistant's conversations + attachments (messages key on the
  // conversation id, which never changes hands, so they follow
  // without a row of their own here).
  'module_custom_code_blocks',
  'lead_contact_notes',
  'assistant_conversations',
  'assistant_attachments',
];

const MERGE_DEDUPE_TABLES = {
  blog_posts: ['slug'],
  booking_hours: ['weekday', 'start_time', 'end_time'],
  booking_services: ['slug'],
  courses: ['slug'],
  ecommerce_products: ['slug'],
  events: ['slug'],
  gallery_albums: ['slug'],
  team_members: ['slug'],
  site_module_embeds: ['module_type'],
  social_accounts: ['platform', 'account_id'],
  // A member email is unique per lead — on merge the keeper's account wins.
  site_members: ['email'],
  // A newsletter email is unique per lead too — keeper's row wins.
  newsletter_subscribers: ['email'],
  // Batch 134: shared-layer refs are unique per (consumer, provider
  // type, role) — the keeper's link for a slot wins on merge.
  module_shared_refs: ['consumer_type', 'consumer_id', 'provider_type', 'role'],
  // Batch 131 finisher: likes are unique per (target, visitor) — on
  // merge the keeper's like for a target+visitor wins, the rest move.
  module_likes: ['target_type', 'target_id', 'visitor_key'],
  // Batch 178: a Router follow is unique per (lead type, location) —
  // on merge the keeper's follow for a type+location wins, the rest
  // move. Router CLAIMS re-point in reassignLeadDependents
  // (claimed_by_lead_id is not a plain lead_id column).
  router_follows: ['lead_type_key', 'location_norm'],
  // Batch 143 (full review): the remaining per-lead unique-keyed
  // tables get the same keeper-wins treatment on their natural key.
  calltracking_rotation_numbers: ['phone_number'],
  calls_billing: ['month'],
  site_chat_daily_usage: ['day'],
  lead_onboarding_items: ['item_key'],
  // Batch 168 (S8#F1): review→social dedupe rows are PK (lead_id,
  // review_key) — on merge the keeper's row for a review wins.
  googlereviews_social_posts: ['review_key'],
};

const MERGE_SINGLETON_TABLES = [
  'booking_settings',
  'chatbot_settings',
  'estimate_configs',
  'socialfeed_configs',
  'socialfeed_cache',
  'googlereviews_configs',
  'googlereviews_cache',
  'calltracking_configs',
  'members_configs',
  'membership_stripe_keys',
  'shop_stripe_keys',
  'newsletter_configs',
  // Batch 134: per-lead module configs keyed by lead_id (PK) — one
  // survives a merge, the keeper's.
  'photocapture_configs',
  'checkout_configs',
  // Batch 131 finisher: the comments config is the same shape (PK).
  'comments_configs',
  // Batch 143 (full review): the remaining lead_id-PK singletons.
  // lead_payment_configs is the security-relevant one — it holds the
  // lead's encrypted Stripe secret/webhook keys (Batch 129) and was
  // in NO treatment list, so a merge stranded live credentials on the
  // deleted lead while the keeper silently fell back to another key
  // layer. gbp_connections is UNIQUE(lead_id) — same one-row shape.
  'datatable_configs',
  'lead_payment_configs',
  'site_chat_summaries',
  'site_chat_pending',
  'call_rescue_configs',
  'gbp_connections',
];

function leadTableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/**
 * Move every dependent row of `dropId` onto `keepId`, per the treatment
 * table above. Runs inside mergeLeads' transaction; any throw (website
 * conflict, unexpected constraint) rolls the whole merge back.
 */
function reassignLeadDependents(db, keepId, dropId) {
  // Websites first: the only treatment that can abort the merge.
  if (leadTableExists(db, 'websites')) {
    const keepSite = db.prepare('SELECT id FROM websites WHERE lead_id = ?').get(keepId);
    const dropSite = db.prepare('SELECT id FROM websites WHERE lead_id = ?').get(dropId);
    if (keepSite && dropSite) {
      throw validationError(
        `cannot merge lead ${dropId} into lead ${keepId}: both own a website ` +
          `(keeper website ${keepSite.id}, dropped lead website ${dropSite.id}); ` +
          'a merge never deletes a website — resolve the extra website first'
      );
    }
    if (dropSite) db.prepare('UPDATE websites SET lead_id = ? WHERE lead_id = ?').run(keepId, dropId);
  }

  // Batch 134 (bug hunt): category (scope, slug) clash remap, BEFORE
  // the plain moves. module_categories is UNIQUE(lead_id, scope,
  // slug), so a dropped category whose twin the keeper already has
  // cannot move — instead its assignments re-point at the keeper's
  // twin (INSERT OR IGNORE: an item already in the twin keeps one
  // row), its children reparent to the twin, and the dropped row
  // goes. Non-clashing categories then move with MERGE_MOVE_TABLES.
  if (leadTableExists(db, 'module_categories') && leadTableExists(db, 'module_category_assignments')) {
    const dropCats = db.prepare('SELECT id, scope, slug FROM module_categories WHERE lead_id = ?').all(dropId);
    for (const dc of dropCats) {
      const twin = db
        .prepare('SELECT id FROM module_categories WHERE lead_id = ? AND scope = ? AND slug = ?')
        .get(keepId, dc.scope, dc.slug);
      if (!twin) continue;
      db.prepare('UPDATE module_categories SET parent_id = ? WHERE lead_id = ? AND parent_id = ?').run(
        twin.id,
        dropId,
        dc.id
      );
      db.prepare(
        `INSERT OR IGNORE INTO module_category_assignments (lead_id, consumer_type, item_id, category_id)
         SELECT lead_id, consumer_type, item_id, ? FROM module_category_assignments
         WHERE lead_id = ? AND category_id = ?`
      ).run(twin.id, dropId, dc.id);
      db.prepare('DELETE FROM module_category_assignments WHERE lead_id = ? AND category_id = ?').run(dropId, dc.id);
      db.prepare('DELETE FROM module_categories WHERE id = ? AND lead_id = ?').run(dc.id, dropId);
    }
  }

  // Batch 178: Router claims move to the keeper — an exclusive claim
  // the dropped lead held stays claimed (by the keeper now), so the
  // lead stays out of other feeds exactly as before the merge.
  if (leadTableExists(db, 'router_leads')) {
    db.prepare('UPDATE router_leads SET claimed_by_lead_id = ? WHERE claimed_by_lead_id = ?').run(keepId, dropId);
  }

  for (const table of MERGE_MOVE_TABLES) {
    if (!leadTableExists(db, table)) continue; // older tenant DBs predate some tables
    db.prepare(`UPDATE ${table} SET lead_id = ? WHERE lead_id = ?`).run(keepId, dropId);
  }

  for (const [table, keys] of Object.entries(MERGE_DEDUPE_TABLES)) {
    if (!leadTableExists(db, table)) continue;
    const keyMatch = keys.map((k) => `k.${k} IS d.${k}`).join(' AND ');
    db.prepare(
      `UPDATE ${table} AS d SET lead_id = @keep WHERE d.lead_id = @drop AND NOT EXISTS (
         SELECT 1 FROM ${table} k WHERE k.lead_id = @keep AND ${keyMatch}
       )`
    ).run({ keep: keepId, drop: dropId });
    // Whatever still points at the dropped lead conflicts with a keeper row
    // on the unique key — the keeper's row wins, the duplicate is dropped.
    db.prepare(`DELETE FROM ${table} WHERE lead_id = ?`).run(dropId);
  }

  for (const table of MERGE_SINGLETON_TABLES) {
    if (!leadTableExists(db, table)) continue;
    db.prepare(
      `DELETE FROM ${table} WHERE lead_id = @drop AND EXISTS (SELECT 1 FROM ${table} WHERE lead_id = @keep)`
    ).run({ keep: keepId, drop: dropId });
    db.prepare(`UPDATE ${table} SET lead_id = ? WHERE lead_id = ?`).run(keepId, dropId);
  }

  // Batch 134 (bug hunt): variant-tree sweep. The dedupe above deletes
  // the dropped lead's products whose slug the keeper already owns;
  // the MOVE loop has already re-keyed their options/values/variants
  // to the keeper, so rows pointing at a product that no longer
  // exists are dead weight — remove exactly those (a surviving
  // product's tree is untouched; its ids never change hands).
  if (leadTableExists(db, 'ecommerce_products')) {
    for (const table of ['ecommerce_product_variants', 'ecommerce_product_option_values', 'ecommerce_product_options']) {
      if (!leadTableExists(db, table)) continue;
      db.prepare(
        `DELETE FROM ${table} WHERE lead_id = ? AND product_id NOT IN (SELECT id FROM ecommerce_products)`
      ).run(keepId);
    }
  }

  // Batch 143 (full review): the same child-orphan shape the variant
  // sweep handles exists for the other slug-deduped parents — the
  // dedupe above deletes a dropped course/album whose slug the keeper
  // already owns, and its lessons/images (keyed by parent id, no
  // lead_id) pointed at the deleted parent forever. Sweep exactly the
  // rows whose parent no longer exists; surviving parents' children
  // are untouched (their ids never change hands).
  if (leadTableExists(db, 'course_lessons') && leadTableExists(db, 'courses')) {
    db.prepare('DELETE FROM course_lessons WHERE course_id NOT IN (SELECT id FROM courses)').run();
  }
  if (leadTableExists(db, 'gallery_images') && leadTableExists(db, 'gallery_albums')) {
    db.prepare('DELETE FROM gallery_images WHERE album_id NOT IN (SELECT id FROM gallery_albums)').run();
  }
}

/**
 * Merge duplicate leads into one keeper. Moves every dependent row to the
 * keeper (see reassignLeadDependents for per-table treatment), fills empty
 * keeper fields from dropped leads, unions tags, appends notes, then
 * deletes the dropped leads. All in one transaction.
 */
function mergeLeads(db, keepId, dropIds) {
  const keep = getLead(db, keepId);
  if (!keep) throw validationError(`keeper lead not found: ${keepId}`);
  const ids = [...new Set((dropIds || []).map(Number).filter((n) => Number.isInteger(n) && n !== keepId))];
  if (ids.length === 0) throw validationError('no leads to merge');

  ensureLeadColumns(db);
  const FILL_FIELDS = [
    'category',
    'phone',
    'email',
    'website',
    'address',
    'city',
    'state',
    'postal_code',
    'country',
    'latitude',
    'longitude',
    'rating',
    'review_count',
    'description',
    'lead_group',
  ];

  const tx = db.transaction(() => {
    const merged = { ...keep };
    const tagSet = new Set(keep.tags || []);
    const noteParts = [];
    if (keep.notes) noteParts.push(keep.notes);

    for (const dropId of ids) {
      const drop = getLead(db, dropId);
      if (!drop) throw validationError(`lead to merge not found: ${dropId}`);
      for (const f of FILL_FIELDS) {
        if (
          (merged[f] === null || merged[f] === undefined || merged[f] === '') &&
          drop[f] !== null &&
          drop[f] !== undefined &&
          drop[f] !== ''
        ) {
          merged[f] = drop[f];
        }
      }
      (drop.tags || []).forEach((t) => tagSet.add(t));
      if (drop.notes) noteParts.push(`--- merged from #${dropId} (${drop.business_name}) ---\n${drop.notes}`);
      noteParts.push(`merged lead #${dropId} (${drop.business_name}) on ${new Date().toISOString()}`);

      reassignLeadDependents(db, keepId, dropId);
      db.prepare('DELETE FROM leads WHERE id = ?').run(dropId);
    }

    // The keeper may inherit an email from a dropped lead; it still may
    // not collide with a THIRD lead that is not part of this merge.
    const mergedEmailNorm = normalizeEmail(merged.email);
    if (mergedEmailNorm && mergedEmailNorm !== normalizeEmail(keep.email)) {
      const clash = findLeadByEmail(db, merged.email, [keepId, ...ids]);
      if (clash) throw duplicateEmailError(clash, mergedEmailNorm);
    }

    const setCols = FILL_FIELDS.map((f) => `${f} = @${f}`).join(', ');
    const params = {};
    for (const f of FILL_FIELDS) params[f] = merged[f] === undefined ? null : merged[f];
    db.prepare(
      `
      UPDATE leads SET ${setCols}, tags=@tags, notes=@notes, email_norm=@email_norm,
        updated_at=datetime('now') WHERE id=@id
    `
    ).run({
      ...params,
      tags: JSON.stringify([...tagSet]),
      notes: noteParts.join('\n\n').slice(0, 10000) || null,
      email_norm: mergedEmailNorm,
      id: keepId,
    });
    logEvent(db, keepId, 'merged', `absorbed leads: ${ids.join(', ')}`);
  });
  tx();
  return getLead(db, keepId);
}

/* ------------------------------------------------------------------ */
/* Website quality heuristics (transparent, rule-based)                */
/* ------------------------------------------------------------------ */

/** Read stored website-check facts for a lead into a flags object. */
function websiteFlagsFromFacts(db, leadId) {
  const rows = db
    .prepare("SELECT fact_key, value FROM business_facts WHERE lead_id = ? AND fact_key LIKE 'website.%'")
    .all(leadId);
  const flags = {};
  for (const r of rows) {
    const key = r.fact_key.replace(/^website\./, '');
    if (r.value === 'true') flags[key] = true;
    else if (r.value === 'false') flags[key] = false;
    else if (r.value !== '' && Number.isFinite(Number(r.value))) flags[key] = Number(r.value);
    else flags[key] = r.value;
  }
  return flags;
}

/**
 * "Poor website" heuristic (spec section 16, +15).
 * website present AND (unreachable OR no SSL OR not mobile-friendly OR
 * outdated design). Transparent: every input comes from stored website.*
 * facts written by researchLead, or from an explicit opts.websiteCheck.
 */
function isPoorWebsite(lead, flags) {
  if (!lead.website) return false;
  if (flags.reachable === false) return true;
  if (flags.has_ssl === false) return true;
  if (flags.mobile_friendly === false) return true;
  if (flags.outdated_design === true) return true;
  return false;
}

/**
 * "Active business" heuristic (spec section 16, +10).
 * status not in ('lost') AND has at least one contact channel
 * (phone, email, or website).
 */
function isActiveBusiness(lead) {
  if (lead.status === 'lost') return false;
  return Boolean(lead.phone || lead.email || lead.website);
}

/** "Strong category" heuristic (spec section 16, +10). */
function isStrongCategory(lead) {
  const c = String(lead.category || '').toLowerCase();
  return STRONG_CATEGORIES.some((k) => c.includes(k));
}

/* ------------------------------------------------------------------ */
/* Scoring (spec section 16)                                           */
/* ------------------------------------------------------------------ */

/**
 * Score a lead 0–100 using the spec section-16 table. Writes a lead_scores
 * row (with JSON breakdown) and updates leads.score. opts.websiteCheck can
 * inject a WebsiteCheck object; otherwise stored website.* facts are used.
 */
function scoreLead(db, id, opts = {}) {
  const lead = getLead(db, id);
  if (!lead) throw validationError(`lead not found: ${id}`);

  const flags = opts.websiteCheck
    ? {
        reachable: opts.websiteCheck.reachable,
        has_ssl: opts.websiteCheck.hasSsl,
        mobile_friendly: opts.websiteCheck.mobileFriendly,
        outdated_design: opts.websiteCheck.outdatedDesign,
      }
    : websiteFlagsFromFacts(db, id);

  const breakdown = {};
  if (!lead.website) breakdown.no_website = SCORE_SIGNALS.no_website;
  if (Number.isInteger(lead.review_count) && lead.review_count >= 20) {
    breakdown.many_reviews = SCORE_SIGNALS.many_reviews;
  }
  if (typeof lead.rating === 'number' && lead.rating > 4) {
    breakdown.high_rating = SCORE_SIGNALS.high_rating;
  }
  if (lead.email && isValidEmail(lead.email)) breakdown.public_email = SCORE_SIGNALS.public_email;
  if (lead.phone) breakdown.phone = SCORE_SIGNALS.phone;
  if (isActiveBusiness(lead)) breakdown.active_business = SCORE_SIGNALS.active_business;
  if (isPoorWebsite(lead, flags)) breakdown.poor_website = SCORE_SIGNALS.poor_website;
  if (isStrongCategory(lead)) breakdown.strong_category = SCORE_SIGNALS.strong_category;

  const score = Math.min(
    SCORE_CAP,
    Object.values(breakdown).reduce((a, b) => a + b, 0)
  );

  db.prepare('INSERT INTO lead_scores (lead_id, score, breakdown) VALUES (?, ?, ?)').run(
    id,
    score,
    JSON.stringify(breakdown)
  );
  db.prepare("UPDATE leads SET score = ?, updated_at = datetime('now') WHERE id = ?").run(score, id);
  logEvent(db, id, 'scored', `score=${score} breakdown=${JSON.stringify(breakdown)}`);
  return { id, score, breakdown };
}

/* ------------------------------------------------------------------ */
/* Qualification (spec section 15)                                     */
/* ------------------------------------------------------------------ */

/**
 * Qualify a lead from spec section-15 positive/negative flags plus the
 * current score vs score.threshold_qualified.
 * Sets qualified (0/1), qualification_note, and moves status to 'qualified'
 * when newly qualified from new/researching. Returns
 * { id, qualified, positives, negatives, score, threshold, note }.
 */
function qualifyLead(db, id) {
  const lead = getLead(db, id);
  if (!lead) throw validationError(`lead not found: ${id}`);
  const flags = websiteFlagsFromFacts(db, id);

  const positives = [];
  const negatives = [];

  // Positive flags (opportunities for a new website)
  if (!lead.website) positives.push('no_website');
  if (flags.reachable === false && lead.website) positives.push('broken_website');
  if (flags.mobile_friendly === false) positives.push('not_mobile_responsive');
  if (flags.has_ssl === false) positives.push('missing_ssl');
  if (flags.has_cta === false) positives.push('missing_cta');
  if (flags.has_contact_form === false) positives.push('no_contact_mechanism');
  if (flags.has_booking === false && lead.website) positives.push('no_booking_mechanism');
  if (typeof flags.load_time_ms === 'number' && flags.load_time_ms > 8000) positives.push('slow_website');
  if (flags.outdated_design === true) positives.push('outdated_design');
  if (isPoorWebsite(lead, flags) && !positives.includes('no_website')) positives.push('poor_website');

  // Negative flags (disqualifiers)
  const excellentWebsite =
    Boolean(lead.website) &&
    flags.reachable !== false &&
    flags.has_ssl === true &&
    flags.mobile_friendly === true &&
    flags.has_cta !== false &&
    flags.outdated_design !== true &&
    !isPoorWebsite(lead, flags);
  if (excellentWebsite) negatives.push('excellent_existing_website');
  if (lead.status === 'lost') negatives.push('closed_or_lost');
  const dupes = findDuplicates(db, lead);
  if (dupes.length > 0) negatives.push(`duplicate_listing (#${dupes.map((d) => d.id).join(', #')})`);
  if (!lead.phone && !lead.email && !lead.website) negatives.push('invalid_contact_information');

  const threshold = Number(getSetting(db, 'score.threshold_qualified', '50')) || 50;
  const score = typeof lead.score === 'number' ? lead.score : 0;
  const qualified = positives.length > 0 && negatives.length === 0 && score >= threshold;

  const note = [
    `score=${score} (threshold=${threshold})`,
    `positives: ${positives.join(', ') || 'none'}`,
    `negatives: ${negatives.join(', ') || 'none'}`,
    qualified ? 'QUALIFIED' : 'NOT QUALIFIED',
  ].join(' | ');

  db.prepare(
    `
    UPDATE leads SET qualified = ?, qualification_note = ?,
      status = CASE WHEN ? = 1 AND status IN ('new','researching') THEN 'qualified' ELSE status END,
      updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(qualified ? 1 : 0, note.slice(0, 2000), qualified ? 1 : 0, id);
  logEvent(db, id, qualified ? 'qualified' : 'disqualified', note.slice(0, 2000));

  return { id, qualified, positives, negatives, score, threshold, note };
}

/* ------------------------------------------------------------------ */
/* Facts with provenance (spec sections 17–18)                         */
/* ------------------------------------------------------------------ */

/**
 * Store one researched fact. claim_class must be one of
 * VERIFIED / AI_COPY / OWNER_PROVIDED / UNKNOWN. Never invent facts —
 * every fact needs a source.
 */
function addFact(db, leadId, fact) {
  const lead = getLead(db, leadId);
  if (!lead) throw validationError(`lead not found: ${leadId}`);
  const f = fact || {};
  if (!f.fact_key || !String(f.fact_key).trim()) throw validationError('fact.fact_key is required');
  if (f.value === null || f.value === undefined || String(f.value).trim() === '') {
    throw validationError('fact.value is required');
  }
  if (!f.source || !String(f.source).trim()) throw validationError('fact.source is required');
  if (!CLAIM_CLASSES.includes(f.claim_class)) {
    throw validationError(`fact.claim_class must be one of ${CLAIM_CLASSES.join('/')}`);
  }
  const confidence = ['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'medium';
  const key = String(f.fact_key).trim().slice(0, 200);
  // Site ingest JSON (structure/snapshot/style/map) regularly exceeds 5k; keep headroom so JSON stays valid.
  const maxVal = /^site\.(structure|snapshot|style_guide|map|faq)$/.test(key) ? 80000 : 5000;
  const info = db
    .prepare(
      `
    INSERT INTO business_facts (lead_id, fact_key, value, source, source_url, confidence, claim_class)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      leadId,
      key,
      String(f.value).slice(0, maxVal),
      String(f.source).trim().slice(0, 200),
      f.source_url ? String(f.source_url).slice(0, 1000) : null,
      confidence,
      f.claim_class
    );
  logEvent(db, leadId, 'fact_added', `${f.fact_key} [${f.claim_class}] via ${f.source}`);
  return db.prepare('SELECT * FROM business_facts WHERE id = ?').get(info.lastInsertRowid);
}

function getFacts(db, leadId) {
  return db.prepare('SELECT * FROM business_facts WHERE lead_id = ? ORDER BY fetched_at DESC, id DESC').all(leadId);
}

/* ------------------------------------------------------------------ */
/* Research (spec section 17)                                          */
/* ------------------------------------------------------------------ */

/**
 * Research a lead: fetch business details + contact details + website
 * quality via a provider, store each fact with provenance, and fill empty
 * lead fields. Prefers a configured discovery provider (e.g. Tavily);
 * otherwise uses csv/manual passthrough (facts stored as UNKNOWN) plus
 * site ingest. Never invents stub businesses. AI enhancement is optional
 * and never invents facts.
 */
async function researchLead(db, id) {
  const lead = getLead(db, id);
  if (!lead) throw validationError(`lead not found: ${id}`);

  // Prefer lead.source when it is a configured discovery provider; else Tavily
  // if configured; else csv/manual passthrough of existing lead fields.
  let provider = getProvider(lead.source);
  const sourceIsDiscovery =
    provider && provider.configured !== false && provider.name !== 'csv' && provider.name !== 'manual';
  if (!sourceIsDiscovery) {
    const tavily = getProvider('tavily');
    if (tavily && tavily.configured) {
      provider = tavily;
    } else if (!provider || provider.configured === false) {
      provider = getProvider('manual');
    }
  }
  if (!provider) {
    throw notConfiguredError(
      'research',
      'No discovery provider is configured. Set a Tavily API key in Settings → Lead discovery.'
    );
  }
  const isVerified = provider.name !== 'csv' && provider.name !== 'manual' && provider.configured !== false;
  const factClass = isVerified ? 'VERIFIED' : 'UNKNOWN';
  const factConfidence = isVerified ? 'medium' : 'low';
  const sourceUrl = lead.website || null;

  db.prepare("UPDATE leads SET status='researching', updated_at=datetime('now') WHERE id=?").run(id);
  logEvent(db, id, 'research_started', `provider=${provider.name}`);

  const stored = [];
  const storeFact = (fact_key, value, extra = {}) => {
    if (value === null || value === undefined || String(value).trim() === '') return;
    stored.push(
      addFact(db, id, {
        fact_key,
        value: String(value),
        source: provider.name,
        source_url: sourceUrl,
        confidence: factConfidence,
        claim_class: factClass,
        ...extra,
      })
    );
  };

  try {
    const biz = await provider.fetchBusiness({ business_name: lead.business_name, website: lead.website });
    const norm = provider.normalize ? provider.normalize(biz) : normalizeToLead(biz);

    // Store business facts with provenance.
    storeFact('phone', norm.phone);
    storeFact('email', norm.email);
    storeFact('address', norm.address);
    storeFact('city', norm.city);
    storeFact('state', norm.state);
    storeFact('postal_code', norm.postal_code);
    storeFact('rating', norm.rating);
    storeFact('review_count', norm.review_count);
    storeFact('description', norm.description);
    if (Array.isArray(norm.services)) norm.services.forEach((sv, i) => storeFact(`service:${i}`, sv));
    if (Array.isArray(norm.hours)) storeFact('hours', JSON.stringify(norm.hours));

    // Website quality check + rich site ingest (content for redesign briefs).
    const siteUrl = norm.website || lead.website;
    let ingestFill = {};
    if (siteUrl) {
      let check = null;
      try {
        check = await provider.fetchWebsite(siteUrl);
      } catch {
        check = null;
      }

      let ingest = null;
      let ingestStoredQuality = false;
      try {
        const siteIngest = require('./siteIngest');
        ingest = await siteIngest.ingestSite(siteUrl);
        for (const f of siteIngest.factsFromIngest(ingest)) {
          stored.push(addFact(db, id, f));
          if (String(f.fact_key).startsWith('website.')) ingestStoredQuality = true;
        }
        if (ingest && ingest.check) check = ingest.check;
        if (ingest && ingest.extracted) {
          if (ingest.extracted.phones[0]) ingestFill.phone = ingest.extracted.phones[0];
          if (ingest.extracted.emails[0]) ingestFill.email = ingest.extracted.emails[0];
          if (ingest.extracted.about && !norm.description)
            ingestFill.description = ingest.extracted.about.slice(0, 2000);
          if (ingest.extracted.services.length) ingestFill.services = ingest.extracted.services;
          if (ingest.extracted.hours.length) ingestFill.hours = ingest.extracted.hours;
        }
        const map = ingest.siteMap || (ingest.extracted && ingest.extracted.site_map) || {};
        logEvent(
          db,
          id,
          'site_ingested',
          `pages=${ingest.pageCount || 0} services=${(map.services && map.services.length) || (ingest.extracted && ingest.extracted.services.length) || 0}` +
            ` sitemap=${map.sitemap_count || 0} areas=${(map.areas && map.areas.length) || 0}` +
            (ingest.error ? ` err=${ingest.error}` : '')
        );

        // Optional AI enhancement of hero/gallery photos (fal.ai).
        try {
          const imageEnhance = require('./imageEnhance');
          const imgs = (ingest.extracted && ingest.extracted.images) || [];
          const ranked = [...imgs].sort((a, b) => {
            const rank = (r) => (r === 'hero' ? 0 : r === 'logo' ? 1 : 2);
            return rank(a.role) - rank(b.role);
          });
          const urls = ranked
            .map((x) => x.url)
            .filter(Boolean)
            .slice(0, imageEnhance.MAX_IMAGES);
          if (urls.length && imageEnhance.falConfigured(db)) {
            const enhanced = await imageEnhance.enhanceImages(db, urls, { leadId: id });
            let ei = 0;
            for (const row of enhanced) {
              if (!row.enhanced_url) {
                logEvent(
                  db,
                  id,
                  'image_enhance_skipped',
                  `${row.source} :: ${row.error || row.reason || 'skip'}`.slice(0, 500)
                );
                continue;
              }
              stored.push(
                addFact(db, id, {
                  fact_key: `site.image.enhanced:${ei}`,
                  value: row.enhanced_url,
                  source: 'fal-enhance',
                  source_url: row.source,
                  confidence: 'medium',
                  claim_class: 'AI_COPY',
                })
              );
              if (row.local_path) {
                stored.push(
                  addFact(db, id, {
                    fact_key: `site.image.enhanced:${ei}.local`,
                    value: row.local_path,
                    source: 'fal-enhance',
                    source_url: row.source,
                    confidence: 'medium',
                    claim_class: 'AI_COPY',
                  })
                );
              }
              ei++;
            }
            logEvent(db, id, 'images_enhanced', `count=${ei} model=${imageEnhance.DEFAULT_MODEL}`);
          }
        } catch (enhErr) {
          logEvent(db, id, 'image_enhance_failed', String((enhErr && enhErr.message) || enhErr).slice(0, 500));
        }
      } catch (ingestErr) {
        logEvent(db, id, 'site_ingest_failed', String((ingestErr && ingestErr.message) || ingestErr).slice(0, 500));
      }

      // Provider probe only when ingest did not already write quality facts.
      if (check && !ingestStoredQuality) {
        storeFact('website.reachable', String(check.reachable));
        storeFact('website.has_ssl', String(check.hasSsl));
        storeFact('website.mobile_friendly', String(check.mobileFriendly));
        storeFact('website.has_cta', String(check.hasCta));
        storeFact('website.has_contact_form', String(check.hasContactForm));
        storeFact('website.has_booking', String(check.hasBooking));
        storeFact('website.load_time_ms', String(check.loadTimeMs));
        storeFact('website.outdated_design', String(check.outdatedDesign));
        storeFact('website.checked_at', check.checkedAt);
      }
    }

    // Fill empty lead fields from research (never overwrite existing data).
    const fillable = [
      'phone',
      'email',
      'website',
      'address',
      'city',
      'state',
      'postal_code',
      'rating',
      'review_count',
      'description',
    ];
    const updates = {};
    const merged = { ...norm, ...ingestFill };
    for (const f of fillable) {
      if (
        (lead[f] === null || lead[f] === undefined || lead[f] === '') &&
        merged[f] !== null &&
        merged[f] !== undefined &&
        merged[f] !== ''
      ) {
        updates[f] = merged[f];
      }
    }
    // services / hours live as JSON columns when empty on the lead.
    if (
      (!lead.services || lead.services === '[]' || lead.services === '') &&
      Array.isArray(ingestFill.services) &&
      ingestFill.services.length
    ) {
      updates.services = JSON.stringify(ingestFill.services);
    }
    if (
      (!lead.hours || lead.hours === '[]' || lead.hours === '') &&
      Array.isArray(ingestFill.hours) &&
      ingestFill.hours.length
    ) {
      updates.hours = JSON.stringify(ingestFill.hours);
    }
    if (Object.keys(updates).length > 0) {
      const set = Object.keys(updates)
        .map((k) => `${k} = @${k}`)
        .join(', ');
      db.prepare(`UPDATE leads SET ${set}, updated_at=datetime('now') WHERE id=@id`).run({ ...updates, id });
    }

    // Optional AI enhancement: draft marketing copy (AI_COPY, never facts).
    // src/ai.js is owned by another workstream and may not exist yet.
    try {
      const ai = require('./ai.js');
      if (ai && typeof ai.aiConfiguredRouted === 'function' && (await ai.aiConfiguredRouted(db, 'research'))) {
        const res = await ai.chat({
          task: 'research',
          db,
          messages: [
            {
              role: 'system',
              content:
                'Write a short, friendly marketing description (2-3 sentences) for a local business website. Do NOT invent factual claims (founding year, awards, service areas) — only generic, clearly promotional language.',
            },
            {
              role: 'user',
              content: `Business: ${lead.business_name} (${lead.category || 'local business'}). Known: ${norm.description || 'no description available'}.`,
            },
          ],
          maxTokens: 150,
          leadId: id,
          note: 'research marketing blurb',
        });
        const copy = res && (res.text || res.content || res);
        if (copy && String(copy).trim()) {
          storeFact('marketing_blurb', String(copy).trim().slice(0, 1000), {
            claim_class: 'AI_COPY',
            confidence: 'low',
          });
        }
      }
    } catch (aiErr) {
      // AI optional: module missing, not configured, or failed — skip.
      logEvent(db, id, 'research_ai_skipped', String((aiErr && aiErr.message) || aiErr).slice(0, 500));
    }

    logEvent(db, id, 'research_completed', `provider=${provider.name} facts=${stored.length} class=${factClass}`);
    return { id, provider: provider.name, facts: stored.length, filled: Object.keys(updates).length };
  } catch (err) {
    logEvent(db, id, 'research_failed', String(err.message).slice(0, 1000));
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Leads Explorer (Batch 183)                                          */
/* ------------------------------------------------------------------ */

/**
 * Batch 183 — Leads Explorer: a real-data map over the leads table.
 *
 * Leads carry latitude/longitude columns but nothing populates them,
 * so locations are resolved lazily through Google Places Text Search
 * (Places API (New)) and cached in lead_geo_cache. Honesty rules,
 * mirroring src/gbp.js fetchPlacesState: no platform key = DORMANT
 * (zero fetch calls, nothing written, never an error and never a
 * guessed pin); a candidate is accepted ONLY when its name normalizes
 * to the lead's business name (normalizeName) AND its locality matches
 * the lead's city; an HTTP/network failure is status 'error'
 * (retryable), never cached as 'no_match'.
 */
const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_TEXT_SEARCH_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents';
const EXPLORER_RESOLVE_CAP = 25;
const EXPLORER_RADII = [3, 5, 10];

/** Plain-language labels for score breakdown signals (spec section 16). */
const SCORE_REASON_LABELS = {
  no_website: 'No website',
  many_reviews: '20+ reviews',
  high_rating: 'Rated over 4.0',
  public_email: 'Public email found',
  phone: 'Phone listed',
  active_business: 'Active business',
  poor_website: 'Poor website',
  strong_category: 'Strong category',
};

function ensureLeadGeoCache(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_geo_cache (
      lead_id INTEGER PRIMARY KEY,
      place_id TEXT,
      lat REAL,
      lng REAL,
      matched_name TEXT,
      formatted_address TEXT,
      status TEXT NOT NULL DEFAULT 'error' CHECK (status IN ('ok', 'no_match', 'error')),
      at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
}

function validCoords(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  return (
    lat !== null &&
    lat !== undefined &&
    lat !== '' &&
    lng !== null &&
    lng !== undefined &&
    lng !== '' &&
    Number.isFinite(la) &&
    Number.isFinite(ln) &&
    la >= -90 &&
    la <= 90 &&
    ln >= -180 &&
    ln <= 180
  );
}

function writeGeoCache(db, leadId, row) {
  db.prepare(
    `INSERT INTO lead_geo_cache (lead_id, place_id, lat, lng, matched_name, formatted_address, status, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET
       place_id = excluded.place_id, lat = excluded.lat, lng = excluded.lng,
       matched_name = excluded.matched_name, formatted_address = excluded.formatted_address,
       status = excluded.status, at = excluded.at`
  ).run(
    leadId,
    row.place_id || null,
    row.lat != null ? row.lat : null,
    row.lng != null ? row.lng : null,
    row.matched_name || null,
    row.formatted_address || null,
    row.status
  );
}

/**
 * One Places Text Search call. The key travels ONLY in the
 * X-Goog-Api-Key header (never the URL or body), like gbp.js.
 * Returns { ok:true, places } or { ok:false, code, dormant? }.
 */
async function placesTextSearch(textQuery, { apiKey, fetchImpl } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    return {
      ok: false,
      code: 'NO_KEY',
      dormant: true,
      message: 'Google Places API key is not configured — Leads Explorer is dormant.',
    };
  }
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, code: 'PLACES_ERROR', message: 'No fetch implementation available' };
  let res;
  try {
    res = await doFetch(PLACES_TEXT_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': PLACES_TEXT_SEARCH_FIELD_MASK,
        Accept: 'application/json',
      },
      body: JSON.stringify({ textQuery }),
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
    return { ok: false, code: 'PLACES_ERROR', message: `Google Places error (${gmsg})` };
  }
  return { ok: true, places: body && Array.isArray(body.places) ? body.places : [] };
}

function placeDisplayName(place) {
  const dn = place && place.displayName;
  if (!dn) return '';
  return String(typeof dn === 'object' ? dn.text || '' : dn);
}

/** Locality from addressComponents (locality, then postal_town). */
function placeLocality(place) {
  const comps = place && Array.isArray(place.addressComponents) ? place.addressComponents : [];
  for (const wanted of ['locality', 'postal_town']) {
    const c = comps.find((x) => x && Array.isArray(x.types) && x.types.includes(wanted));
    if (c) return String(c.longText || c.long_name || c.shortText || '').trim();
  }
  return '';
}

/**
 * Acceptance rule: the candidate's name must normalize to the lead's
 * business name AND its locality must match the lead's city (from
 * addressComponents, falling back to the formatted address containing
 * the city, case-insensitive). Anything else is not this business.
 */
function placeMatchesLead(place, lead) {
  if (!place || !validCoords(place.location && place.location.latitude, place.location && place.location.longitude)) {
    return false;
  }
  if (normalizeName(placeDisplayName(place)) !== normalizeName(lead.business_name)) return false;
  const city = String(lead.city || '').trim();
  if (!city) return true;
  const locality = placeLocality(place);
  if (locality) return locality.toLowerCase() === city.toLowerCase();
  return String(place.formattedAddress || '')
    .toLowerCase()
    .includes(city.toLowerCase());
}

/**
 * Resolve one lead's location. Order: stored lat/lng on the lead →
 * lead_geo_cache 'ok' row → Places Text Search "name + address" (only
 * when an address is stored) → "name + city + state". Accepted matches
 * are cached AND written back onto leads.latitude/longitude. No key →
 * { status:'dormant', code:'NO_KEY' } with zero fetch calls and no
 * writes.
 */
async function resolveLeadLocation(db, lead, { apiKey, fetchImpl } = {}) {
  ensureLeadGeoCache(db);
  if (!lead || lead.id == null) return { status: 'error', code: 'NO_LEAD' };
  if (validCoords(lead.latitude, lead.longitude)) {
    return { status: 'ok', source: 'stored', lat: Number(lead.latitude), lng: Number(lead.longitude) };
  }
  const cache = db.prepare('SELECT * FROM lead_geo_cache WHERE lead_id = ?').get(lead.id);
  if (cache && cache.status === 'ok' && validCoords(cache.lat, cache.lng)) {
    db.prepare("UPDATE leads SET latitude = ?, longitude = ?, updated_at = datetime('now') WHERE id = ?").run(
      cache.lat,
      cache.lng,
      lead.id
    );
    return { status: 'ok', source: 'cache', lat: Number(cache.lat), lng: Number(cache.lng), place_id: cache.place_id };
  }
  if (cache && cache.status === 'no_match') return { status: 'no_match', source: 'cache' };
  const key = String(apiKey || '').trim();
  if (!key) return { status: 'dormant', code: 'NO_KEY' };

  const queries = [];
  const address = String(lead.address || '').trim();
  if (address) queries.push(`${lead.business_name} ${address}`);
  const cityState = [lead.business_name, lead.city, lead.state]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ');
  if (cityState && !queries.includes(cityState)) queries.push(cityState);

  let sawError = false;
  for (const q of queries) {
    const r = await placesTextSearch(q, { apiKey: key, fetchImpl });
    if (!r.ok) {
      sawError = true;
      continue;
    }
    const hit = r.places.find((p) => placeMatchesLead(p, lead));
    if (hit) {
      const lat = Number(hit.location.latitude);
      const lng = Number(hit.location.longitude);
      writeGeoCache(db, lead.id, {
        place_id: hit.id || null,
        lat,
        lng,
        matched_name: placeDisplayName(hit),
        formatted_address: hit.formattedAddress || null,
        status: 'ok',
      });
      db.prepare("UPDATE leads SET latitude = ?, longitude = ?, updated_at = datetime('now') WHERE id = ?").run(
        lat,
        lng,
        lead.id
      );
      return { status: 'ok', source: 'places', lat, lng, place_id: hit.id || null };
    }
  }
  if (sawError) {
    // Retryable: recorded as 'error', never as a terminal no_match.
    writeGeoCache(db, lead.id, { status: 'error' });
    return { status: 'error', code: 'PLACES_ERROR' };
  }
  writeGeoCache(db, lead.id, { status: 'no_match' });
  return { status: 'no_match', source: 'places' };
}

function explorerBand(score, thresholds) {
  const n = Number(score) || 0;
  if (n >= thresholds.hot) return 'hot';
  if (n >= thresholds.qualified) return 'warm';
  if (n > 0) return 'cool';
  return 'none';
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function reasonLabel(key) {
  if (SCORE_REASON_LABELS[key]) return SCORE_REASON_LABELS[key];
  const pretty = String(key || '')
    .replace(/_/g, ' ')
    .trim();
  return pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : String(key || '');
}

/**
 * Reasons a lead scored what it scored: the LATEST lead_scores
 * breakdown mapped to plain labels; with no breakdown row, ONLY real
 * stored facts (no website / rating over 4.0 / 20+ reviews / phone),
 * using the same labels and the spec section-16 points.
 */
function leadScoreReasons(db, lead) {
  let row = null;
  try {
    row = db.prepare('SELECT breakdown FROM lead_scores WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(lead.id);
  } catch {
    row = null;
  }
  const breakdown = row ? fromJson(row.breakdown, null) : null;
  if (breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown)) {
    return Object.entries(breakdown).map(([k, v]) => ({ label: reasonLabel(k), points: Number(v) || 0 }));
  }
  const reasons = [];
  if (!String(lead.website || '').trim()) reasons.push({ label: SCORE_REASON_LABELS.no_website, points: SCORE_SIGNALS.no_website });
  if (Number(lead.review_count) >= 20) {
    reasons.push({ label: SCORE_REASON_LABELS.many_reviews, points: SCORE_SIGNALS.many_reviews });
  }
  if (typeof lead.rating === 'number' && lead.rating > 4) {
    reasons.push({ label: SCORE_REASON_LABELS.high_rating, points: SCORE_SIGNALS.high_rating });
  }
  if (lead.phone) reasons.push({ label: SCORE_REASON_LABELS.phone, points: SCORE_SIGNALS.phone });
  return reasons;
}

const EXPLORER_LEAD_COLUMNS =
  'id, business_name, category, phone, website, address, city, state, latitude, longitude, rating, review_count, score';

/**
 * Everything the Leads Explorer renders for one workspace DB:
 * areas (distinct lead cities + counts), the selected area's pins
 * (leads with real coordinates within `radius` miles of the area
 * centre — the centroid of ALL resolved pins in the area), band
 * summary counts, and the honest unmapped list. Resolution is lazy
 * and bounded: at most EXPLORER_RESOLVE_CAP not-yet-cached leads in
 * the selected area per call, cache-first. No key → dormant:true,
 * zero fetch calls, pins only from coordinates already stored.
 */
async function explorerData(db, opts = {}) {
  ensureLeadColumns(db);
  ensureLeadGeoCache(db);
  const hot = Number(getSetting(db, 'score.threshold_hot', '70')) || 70;
  const qualified = Number(getSetting(db, 'score.threshold_qualified', '50')) || 50;
  const thresholds = { hot, qualified };
  const radius = EXPLORER_RADII.includes(Number(opts.radius)) ? Number(opts.radius) : 10;
  const apiKey = String(opts.apiKey || '').trim();
  const dormant = !apiKey;

  const allLeads = db.prepare(`SELECT ${EXPLORER_LEAD_COLUMNS} FROM leads ORDER BY id`).all();

  // Areas: distinct non-empty cities with counts, biggest first.
  const areaByKey = new Map();
  for (const lead of allLeads) {
    const city = String(lead.city || '').trim();
    if (!city) continue;
    const k = city.toLowerCase();
    if (!areaByKey.has(k)) areaByKey.set(k, { city, count: 0 });
    areaByKey.get(k).count += 1;
  }
  const areas = [...areaByKey.values()].sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));

  const wanted = String(opts.area || '').trim().toLowerCase();
  const selected = areas.find((a) => a.city.toLowerCase() === wanted) || areas[0] || null;
  const area = selected ? selected.city : null;
  const inArea = (lead) => selected && String(lead.city || '').trim().toLowerCase() === selected.city.toLowerCase();
  let areaLeads = allLeads.filter(inArea);

  // Lazy, bounded resolution for the selected area only.
  if (apiKey && opts.resolve !== '0' && areaLeads.length) {
    const cacheByLead = new Map(db.prepare('SELECT * FROM lead_geo_cache').all().map((r) => [r.lead_id, r]));
    const pending = areaLeads.filter((lead) => {
      if (validCoords(lead.latitude, lead.longitude)) return false;
      const c = cacheByLead.get(lead.id);
      return !c || c.status === 'error';
    });
    for (const lead of pending.slice(0, EXPLORER_RESOLVE_CAP)) {
      await resolveLeadLocation(db, lead, { apiKey, fetchImpl: opts.fetchImpl });
    }
    areaLeads = db.prepare(`SELECT ${EXPLORER_LEAD_COLUMNS} FROM leads ORDER BY id`).all().filter(inArea);
  }

  const cacheByLead = new Map(db.prepare('SELECT * FROM lead_geo_cache').all().map((r) => [r.lead_id, r]));
  const located = areaLeads.filter((lead) => validCoords(lead.latitude, lead.longitude));
  const centre = located.length
    ? {
        lat: located.reduce((s, l) => s + Number(l.latitude), 0) / located.length,
        lng: located.reduce((s, l) => s + Number(l.longitude), 0) / located.length,
      }
    : null;

  const pins = [];
  const byBand = { hot: 0, warm: 0, cool: 0, none: 0 };
  if (centre) {
    for (const lead of located) {
      const d = haversineMiles(centre.lat, centre.lng, Number(lead.latitude), Number(lead.longitude));
      if (d > radius) continue;
      const band = explorerBand(lead.score, thresholds);
      byBand[band] += 1;
      pins.push({
        id: lead.id,
        business_name: lead.business_name,
        category: lead.category || null,
        city: lead.city || null,
        address: lead.address || null,
        website_state: String(lead.website || '').trim() === '' ? 'No website' : 'Website present',
        score: Number(lead.score) || 0,
        band,
        lat: Number(lead.latitude),
        lng: Number(lead.longitude),
        rating: lead.rating != null ? Number(lead.rating) : null,
        review_count: lead.review_count != null ? Number(lead.review_count) : null,
        phone: lead.phone || null,
        reasons: leadScoreReasons(db, lead),
      });
    }
  }

  const unmapped = areaLeads
    .filter((lead) => !validCoords(lead.latitude, lead.longitude))
    .map((lead) => {
      const c = cacheByLead.get(lead.id);
      const why = dormant
        ? 'no_key'
        : c && c.status === 'no_match'
          ? 'no_match'
          : c && c.status === 'error'
            ? 'error'
            : 'not_located';
      return {
        id: lead.id,
        business_name: lead.business_name,
        city: lead.city || null,
        score: Number(lead.score) || 0,
        band: explorerBand(lead.score, thresholds),
        why,
      };
    });

  return {
    areas,
    area,
    radius,
    thresholds,
    dormant,
    centre,
    pins,
    unmapped,
    summary: {
      total: areaLeads.length,
      mapped: located.length,
      unmapped: unmapped.length,
      withinRadius: pins.length,
      byBand,
    },
  };
}

/* ------------------------------------------------------------------ */

module.exports = {
  // constants
  SCORE_SIGNALS,
  SCORE_CAP,
  STRONG_CATEGORIES,
  CLAIM_CLASSES,
  LEAD_STATUSES,
  CSV_MAX_BYTES,
  // helpers (exported for tests / other workstreams)
  normalizePhoneDigits,
  normalizeEmail,
  findLeadByEmail,
  normalizeName,
  domainFromWebsite,
  domainFromEmail,
  normalizeAddress,
  isValidEmail,
  isValidUrl,
  leadHasWebsite,
  normalizeWebsitePresence,
  isPoorWebsite,
  isActiveBusiness,
  isStrongCategory,
  websiteFlagsFromFacts,
  getSetting,
  ensureLeadColumns,
  normalizeGroupName,
  normalizeCategory,
  defaultDiscoverGroup,
  // crud
  createLead,
  getLead,
  updateLead,
  deleteLead,
  leadReferenceSummary,
  // import / discover / dedup / merge
  importCsv,
  discoverLeads,
  listLeadFacets,
  findDuplicates,
  mergeLeads,
  // scoring / qualification
  scoreLead,
  qualifyLead,
  // explorer (Batch 183)
  ensureLeadGeoCache,
  placesTextSearch,
  resolveLeadLocation,
  explorerData,
  explorerBand,
  haversineMiles,
  // facts / research
  addFact,
  getFacts,
  researchLead,
};
