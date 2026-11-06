// @ts-check
'use strict';

/**
 * Batch 153 — DESIGN TYPES: the design agent's type catalog
 * (Ely's order, 2026-11-06: "in design agent, add design type and
 * design instructions list and make them editable — this is what
 * will be populated in new design job popup when the type is
 * selected"; clarified: the editor lives in Admin; and "populate
 * default for each type" — every seeded type carries real default
 * instructions, not just website).
 *
 * The catalog is a list of { type, instructions } entries. The staff
 * app's New design job popup builds its Type select from it and
 * fills the job's Instructions box with the selected type's
 * instructions (staff can still edit them per job — a job snapshots
 * its own type + instructions at creation, so later catalog edits
 * never touch existing jobs).
 *
 * Storage: ONE platform setting, design.types, holding the JSON
 * list — the same mechanism as the AI routing matrix (Batch 120)
 * and the plan contents (Batch 57): platform-level, validated +
 * canonicalized at the platform.setPlatformSetting choke point AND
 * in settingsKeys.validateSetting, so no write path can land a
 * malformed catalog. Absent/empty stored value = the CODE SEED in
 * src/defaultDesignInstructions.js (the six historical types in
 * their historical order; website's instructions are that module's
 * DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS verbatim).
 *
 * Resolution is SYNC for callers (domain.designDefaultInstructions
 * serves the staff popup + MCP synchronously), so — exactly like
 * planContents — the parsed list is cached in memory: primed at
 * boot (server.js), refreshed after every design.types write
 * (platform.setPlatformSetting calls setDesignTypesCacheForKey),
 * and re-read by the admin state endpoint. A corrupt stored row
 * resolves to the seed — a bad row must never break the popup.
 *
 * Validation (shared by the admin endpoint, the choke point, and
 * validateSetting): names are required, unique case-insensitively,
 * at most 40 chars (createJob slices type at 40 — a longer stored
 * name would be silently truncated when a job is queued), and use
 * a conservative charset; instructions are capped at 20,000 chars
 * (the design_jobs.instructions limit — createJob slices there, so
 * the catalog REFUSES over-limit text instead of letting it be
 * silently cut). Instructions may be emptied per type (the popup
 * then opens that type with a blank box, the pre-153 behaviour).
 */

const platform = require('./platform');
const { seedDesignTypes } = require('../src/defaultDesignInstructions');

const SETTING_KEY = 'design.types';
const MAX_TYPES = 50;
const MAX_TYPE_NAME_CHARS = 40;
const MAX_INSTRUCTIONS_CHARS = 20000;
/** Letters, digits, spaces and the punctuation a job-type label
 *  plausibly needs; mirrors what normalizeJobType preserves. */
const TYPE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _&+.'()/-]*$/;

/** @param {string} msg */
function invalid(msg) {
  const e = new Error(msg);
  // @ts-ignore — coded error, the platform/settings error contract
  e.code = 'VALIDATION';
  return e;
}

/**
 * Validate + normalize a design-type list. Accepts the list itself
 * or its JSON string. Returns a NEW array of {type, instructions}
 * in the caller's order, names trimmed. Throws a coded VALIDATION
 * error on the first problem — callers write nothing on throw.
 * @param {unknown} input
 * @returns {Array<{ type: string, instructions: string }>}
 */
function validateDesignTypes(input) {
  let list = input;
  if (typeof list === 'string') {
    const t = list.trim();
    if (t === '') throw invalid('Design types must be a JSON list of {type, instructions} entries.');
    try {
      list = JSON.parse(t);
    } catch {
      throw invalid('Design types must be a JSON list of {type, instructions} entries.');
    }
  }
  if (!Array.isArray(list)) throw invalid('Design types must be a list of {type, instructions} entries.');
  if (!list.length) throw invalid('Keep at least one design type — the New design job popup needs a type to offer.');
  if (list.length > MAX_TYPES)
    throw invalid(`Too many design types (${list.length}) — the catalog holds at most ${MAX_TYPES}.`);
  const seen = new Map();
  const out = [];
  list.forEach((item, i) => {
    const n = i + 1;
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw invalid(`Design type #${n} must be an entry with a type name and instructions.`);
    const type = String(item.type == null ? '' : item.type).trim();
    if (!type) throw invalid(`Design type #${n} needs a name.`);
    if (type.length > MAX_TYPE_NAME_CHARS)
      throw invalid(
        `Design type "${type.slice(0, 24)}…" is too long — names are at most ${MAX_TYPE_NAME_CHARS} characters (longer names are cut off when a job is created).`
      );
    if (!TYPE_NAME_RE.test(type))
      throw invalid(`Design type "${type}" may only use letters, numbers, spaces and - _ & + ' / ( ) .`);
    const key = type.toLowerCase();
    if (seen.has(key)) throw invalid(`Design type "${type}" duplicates "${seen.get(key)}" — names must be unique.`);
    seen.set(key, type);
    const instructions = item.instructions == null ? '' : String(item.instructions);
    if (instructions.length > MAX_INSTRUCTIONS_CHARS)
      throw invalid(
        `Instructions for "${type}" run ${instructions.length} characters — the limit is ${MAX_INSTRUCTIONS_CHARS} (a design job cannot hold more). Shorten them before saving.`
      );
    out.push({ type, instructions });
  });
  return out;
}

/**
 * The settings-string form of the validator: '' (nothing stored)
 * canonicalizes to '' — the seed resolves at read. Anything else
 * must be a valid list and is stored as its canonical JSON.
 * @param {unknown} raw
 * @returns {string}
 */
function validateDesignTypesSetting(raw) {
  const v = raw == null ? '' : String(raw);
  if (v.trim() === '') return '';
  return JSON.stringify(validateDesignTypes(v));
}

/* ------------------------------------------------------------------ */
/* Resolution (sync cache, planContents-style)                         */
/* ------------------------------------------------------------------ */

/** @type {{ types: Array<{ type: string, instructions: string }>, seeded: boolean } | null} */
let cache = null;

function seedState() {
  return { types: seedDesignTypes(), seeded: true };
}

/** Parse a stored string into a state; corrupt/empty → the seed. */
function stateFromStored(stored) {
  if (stored && String(stored).trim()) {
    try {
      const types = validateDesignTypes(String(stored));
      if (types.length) return { types, seeded: false };
    } catch {
      /* a bad row resolves to the seed — never break the popup */
    }
  }
  return seedState();
}

/**
 * The sync resolver every read path uses. Before the boot prime
 * lands it serves the seed, so the popup can never open empty.
 */
function resolveDesignTypes() {
  return cache || seedState();
}

/** Re-read the stored row into the cache. Called at boot and by
 *  the admin state endpoint (so an out-of-band write is picked up
 *  when an admin next opens the panel). */
async function refreshDesignTypes() {
  let stored = '';
  try {
    stored = await platform.getStoredPlatformSetting(SETTING_KEY);
  } catch {
    stored = '';
  }
  cache = stateFromStored(stored);
  return cache;
}

/** platform.setPlatformSetting hook: keep the sync cache in step
 *  after every successful design.types write, whatever the path
 *  (admin endpoint, generic settings save, MCP/IPC facade). The
 *  value arriving here is already canonicalized by the choke point. */
function setDesignTypesCacheForKey(key, value) {
  if (key !== SETTING_KEY) return;
  cache = stateFromStored(value == null ? '' : String(value));
}

/* ------------------------------------------------------------------ */
/* Admin surface                                                       */
/* ------------------------------------------------------------------ */

/** State for Admin → Design agent: the resolved list, whether it is
 *  the untouched seed, and the limits the editor displays. */
async function adminState() {
  const state = await refreshDesignTypes();
  return {
    types: state.types.map((t) => ({ type: t.type, instructions: t.instructions })),
    seeded: state.seeded,
    limits: {
      maxTypes: MAX_TYPES,
      maxTypeNameChars: MAX_TYPE_NAME_CHARS,
      maxInstructionsChars: MAX_INSTRUCTIONS_CHARS,
    },
  };
}

/**
 * Replace the whole catalog (the admin editor saves the full list).
 * Validates first — a rejected save writes nothing. Returns the new
 * admin state.
 */
async function updateDesignTypes(input) {
  const types = validateDesignTypes(input);
  await platform.setPlatformSetting(SETTING_KEY, JSON.stringify(types));
  // setPlatformSetting's cache hook already ran; assign defensively
  // so the returned state is the list just written even if the hook
  // contract changes.
  cache = { types, seeded: false };
  return {
    types: types.map((t) => ({ type: t.type, instructions: t.instructions })),
    seeded: false,
    updated: types.length,
  };
}

module.exports = {
  SETTING_KEY,
  MAX_TYPES,
  MAX_TYPE_NAME_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  validateDesignTypes,
  validateDesignTypesSetting,
  resolveDesignTypes,
  refreshDesignTypes,
  setDesignTypesCacheForKey,
  adminState,
  updateDesignTypes,
};
