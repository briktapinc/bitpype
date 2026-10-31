'use strict';

/**
 * Batch 57 — admin-editable package (plan) CONTENTS.
 *
 * Ely (2026-10-29): plan AMOUNTS are editable in Admin → Settings →
 * Billing → Plan pricing (server/pricingAdmin.js, Batch 24) but plan
 * contents — names, taglines, feature bullets, entitlements — were a
 * static catalog in server/plans.js. "I want that feature": contents
 * editable from admin the same way amounts are.
 *
 * Storage: one platform-setting JSON row per plan —
 *   plans.contents_free / plans.contents_standard /
 *   plans.contents_pro  / plans.contents_premium
 * Absent or empty = the code default from server/plans.js (PLANS).
 * A stored object may carry any subset of {name, tagline, features,
 * entitlements, chatRequestsPerDay}; each present field replaces the
 * default wholesale (see the merge note in plans.js). Plan ids,
 * PLAN_RANK, interval and prices are NOT editable here.
 *
 * Batch 97: chatRequestsPerDay is the plan's daily design-chat cap
 * (positive whole number, or null = unlimited). It rides the same
 * override lifecycle as every other contents field, so the value
 * Ely sets in the Package contents editor follows the plan.
 *
 * Resolution: plans.js keeps the parsed overrides in memory (the sync
 * getPlan/listPlans/publicPlan used across the app stay sync). This
 * module owns the lifecycle, mirroring Batch 56's public-URL cache:
 *   - boot: refreshPlanContents() (server.js) reads the stored rows;
 *   - save: platform.setPlatformSetting calls setContentsCacheForKey()
 *     after every successful write of a plans.contents_* key, whatever
 *     the write path (admin API, generic settings save, MCP/IPC).
 * A corrupt stored row resolves to "no override" (defaults) — a bad row
 * must never break plan resolution for the whole app.
 *
 * Validation is shared by BOTH write choke points: this module's admin
 * update path and settingsKeys.validateSetting (Batch 24b invariant —
 * every platform def is validatable there too, delegating here).
 * Rejection is atomic: updatePlanContents validates every plan first
 * and writes nothing when any plan is invalid.
 */

const plans = require('./plans');
const platform = require('./platform');

const PLAN_IDS = [plans.PLAN_FREE, plans.PLAN_STANDARD, plans.PLAN_PRO, plans.PLAN_PREMIUM];

const CONTENTS_KEYS = {
  [plans.PLAN_FREE]: 'plans.contents_free',
  [plans.PLAN_STANDARD]: 'plans.contents_standard',
  [plans.PLAN_PRO]: 'plans.contents_pro',
  [plans.PLAN_PREMIUM]: 'plans.contents_premium',
};

const CONTENT_FIELDS = ['name', 'tagline', 'features', 'entitlements', 'chatRequestsPerDay'];

/** Entitlement keys an override may set — derived from the code catalog
 *  so a key added to plans.js becomes editable automatically. */
function allowedEntitlementKeys() {
  const keys = new Set();
  for (const id of PLAN_IDS) {
    for (const k of Object.keys(plans.PLANS[id].entitlements || {})) keys.add(k);
  }
  return keys;
}

/** supportCadence values in use across the catalog (derived, ordered). */
function supportCadenceValues() {
  const seen = [];
  for (const id of PLAN_IDS) {
    const v = (plans.PLANS[id].entitlements || {}).supportCadence;
    if (v != null && !seen.includes(v)) seen.push(v);
  }
  return seen;
}

function invalid(msg) {
  const e = new Error(msg);
  e.code = 'VALIDATION';
  return e;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate + normalize one plan's contents override.
 * Accepts a parsed object or a JSON string. Returns a NEW object holding
 * only the fields present, in canonical field order (entitlements in
 * catalog key order), with strings trimmed. Throws a coded VALIDATION
 * error on the first problem — nothing is written by callers on throw.
 */
function validatePlanContents(planIdInput, raw) {
  const planId = plans.normalizePlanId(planIdInput);
  if (!PLAN_IDS.includes(String(planIdInput || '').trim().toLowerCase())) {
    throw invalid(`Unknown plan "${planIdInput}".`);
  }
  let value = raw;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t === '') return null; // empty string = no override (clear)
    try {
      value = JSON.parse(t);
    } catch {
      throw invalid(`Plan contents for ${planId} must be a JSON object.`);
    }
  }
  if (value == null) return null;
  if (!isPlainObject(value)) {
    throw invalid(`Plan contents for ${planId} must be an object with any of: ${CONTENT_FIELDS.join(', ')}.`);
  }
  for (const k of Object.keys(value)) {
    if (!CONTENT_FIELDS.includes(k)) {
      throw invalid(
        `Unknown field "${k}" in ${planId} contents — only ${CONTENT_FIELDS.join(', ')} can be edited here (prices live in the Plan pricing panel).`
      );
    }
  }
  const out = {};
  if ('name' in value) {
    if (typeof value.name !== 'string') throw invalid(`${planId} name must be text.`);
    const name = value.name.trim();
    if (name.length < 1 || name.length > 60) {
      throw invalid(`${planId} name must be 1–60 characters.`);
    }
    out.name = name;
  }
  if ('tagline' in value) {
    if (typeof value.tagline !== 'string') throw invalid(`${planId} tagline must be text.`);
    const tagline = value.tagline.trim();
    if (tagline.length > 140) throw invalid(`${planId} tagline must be 140 characters or fewer.`);
    out.tagline = tagline;
  }
  if ('features' in value) {
    if (!Array.isArray(value.features)) throw invalid(`${planId} features must be a list.`);
    if (value.features.length < 1 || value.features.length > 20) {
      throw invalid(`${planId} features must list 1–20 items.`);
    }
    out.features = value.features.map((f, i) => {
      if (typeof f !== 'string') throw invalid(`${planId} feature #${i + 1} must be text.`);
      const t = f.trim();
      if (t.length < 1 || t.length > 120) {
        throw invalid(`${planId} feature #${i + 1} must be 1–120 characters.`);
      }
      return t;
    });
  }
  if ('entitlements' in value) {
    if (!isPlainObject(value.entitlements)) throw invalid(`${planId} entitlements must be an object.`);
    const allowed = allowedEntitlementKeys();
    const cadences = supportCadenceValues();
    for (const k of Object.keys(value.entitlements)) {
      if (!allowed.has(k)) {
        throw invalid(`Unknown entitlement "${k}" for ${planId} — editable entitlements come from the plan catalog.`);
      }
      const v = value.entitlements[k];
      if (k === 'supportCadence') {
        if (typeof v !== 'string' || !cadences.includes(v)) {
          throw invalid(`${planId} supportCadence must be one of: ${cadences.join(', ')}.`);
        }
      } else if (typeof v !== 'boolean') {
        throw invalid(`${planId} entitlement "${k}" must be true or false.`);
      }
    }
    // Canonical order: catalog key order of the plan's own defaults,
    // then any remaining allowed keys in catalog-union order.
    const ordered = {};
    const ownKeys = Object.keys(plans.PLANS[planId].entitlements || {});
    for (const k of [...ownKeys, ...allowed]) {
      if (k in value.entitlements && !(k in ordered)) ordered[k] = value.entitlements[k];
    }
    out.entitlements = ordered;
  }
  if ('chatRequestsPerDay' in value) {
    const v = value.chatRequestsPerDay;
    if (v === null) {
      out.chatRequestsPerDay = null; // explicit unlimited
    } else if (Number.isInteger(v) && v >= 1 && v <= 100000) {
      out.chatRequestsPerDay = v;
    } else {
      throw invalid(
        `${planId} chatRequestsPerDay must be a whole number of requests per day (1–100000), or null for unlimited.`
      );
    }
  }
  return out;
}

/** Parse a stored setting row into an override object (or null). A row
 *  that fails validation is treated as NO override — plan resolution
 *  must never break app-wide because of one bad row. */
function parseStoredContents(planId, raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return null;
  try {
    return validatePlanContents(planId, t);
  } catch (e) {
    console.warn(`[planContents] ignoring invalid stored override for ${planId}: ${e.message}`);
    return null;
  }
}

/* ------------------------- resolver cache ------------------------- */

function applyOverrides(map) {
  plans.setContentsOverrides(map || {});
}

/** Boot hook (server.js): prime the plans.js resolver from stored rows. */
async function refreshPlanContents() {
  const map = {};
  for (const id of PLAN_IDS) {
    let raw = '';
    try {
      raw = await platform.getPlatformSetting(CONTENTS_KEYS[id], '');
    } catch {
      raw = '';
    }
    const parsed = parseStoredContents(id, raw);
    if (parsed) map[id] = parsed;
  }
  applyOverrides(map);
  return map;
}

/**
 * Called by platform.setPlatformSetting after a successful write of a
 * plans.contents_* key (any write path). Keeps the sync resolver in
 * step with the save, exactly like stripeClient.setPublicUrlCache.
 */
function setContentsCacheForKey(key, value) {
  const planId = PLAN_IDS.find((id) => CONTENTS_KEYS[id] === key);
  if (!planId) return;
  const map = { ...plans.getContentsOverrides() };
  const parsed = parseStoredContents(planId, value);
  if (parsed) map[planId] = parsed;
  else delete map[planId];
  applyOverrides(map);
}

/* --------------------------- admin surface --------------------------- */

function defaultsFor(planId) {
  const d = plans.PLANS[planId];
  return {
    name: d.name,
    tagline: d.tagline,
    features: d.features.slice(),
    entitlements: { ...d.entitlements },
    chatRequestsPerDay: d.chatRequestsPerDay != null ? d.chatRequestsPerDay : null,
  };
}

function resolvedFor(planId) {
  const p = plans.getPlan(planId);
  return {
    name: p.name,
    tagline: p.tagline,
    features: p.features.slice(),
    entitlements: { ...p.entitlements },
    chatRequestsPerDay: p.chatRequestsPerDay != null ? p.chatRequestsPerDay : null,
  };
}

/** GET state for Admin → Settings → Billing → Package contents. */
async function getPlanContentsState() {
  const out = [];
  for (const id of PLAN_IDS) {
    const raw = await platform.getPlatformSetting(CONTENTS_KEYS[id], '');
    out.push({
      id,
      hasOverride: !!String(raw || '').trim(),
      override: parseStoredContents(id, raw),
      defaults: defaultsFor(id),
      contents: resolvedFor(id),
    });
  }
  return {
    plans: out,
    entitlementKeys: [...allowedEntitlementKeys()],
    cadenceOptions: supportCadenceValues(),
  };
}

/**
 * PUT: input maps plan id → contents object (save override) or null
 * (reset to defaults). Plans absent from the input are left untouched.
 * Every entry is validated BEFORE any write (atomic reject); writes go
 * through platform.setPlatformSetting, which refreshes the resolver.
 * If a write fails mid-way, earlier writes are rolled back to their
 * prior raw values (best-effort) so a save never lands half-applied.
 */
async function updatePlanContents(input) {
  if (!isPlainObject(input)) {
    throw invalid('Send an object mapping plan ids to contents (or null to reset a plan).');
  }
  const staged = []; // { planId, key, nextRaw, prevRaw }
  for (const [rawId, value] of Object.entries(input)) {
    const id = String(rawId || '').trim().toLowerCase();
    if (!PLAN_IDS.includes(id)) throw invalid(`Unknown plan "${rawId}".`);
    const key = CONTENTS_KEYS[id];
    const prevRaw = await platform.getPlatformSetting(key, '');
    if (value === null) {
      staged.push({ planId: id, key, nextRaw: '', prevRaw, reset: true });
    } else {
      const normalized = validatePlanContents(id, value); // throws before any write
      staged.push({ planId: id, key, nextRaw: JSON.stringify(normalized), prevRaw, reset: false });
    }
  }
  const updated = [];
  const reset = [];
  const unchanged = [];
  const written = [];
  try {
    for (const s of staged) {
      if (s.nextRaw === String(s.prevRaw || '')) {
        unchanged.push(s.planId);
        continue;
      }
      await platform.setPlatformSetting(s.key, s.nextRaw);
      written.push(s);
      (s.reset ? reset : updated).push(s.planId);
    }
  } catch (e) {
    for (const s of written.reverse()) {
      try {
        await platform.setPlatformSetting(s.key, s.prevRaw);
      } catch {
        /* rollback is best-effort; the original error is what matters */
      }
    }
    throw e;
  }
  return { updated, reset, unchanged };
}

module.exports = {
  PLAN_IDS,
  CONTENTS_KEYS,
  CONTENT_FIELDS,
  allowedEntitlementKeys,
  supportCadenceValues,
  validatePlanContents,
  parseStoredContents,
  refreshPlanContents,
  setContentsCacheForKey,
  getPlanContentsState,
  updatePlanContents,
  defaultsFor,
  resolvedFor,
};
