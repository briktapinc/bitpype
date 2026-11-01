'use strict';

/**
 * Batch 29 — portal user types, tab + module access.
 *
 * ONE place computes what a client portal user may open:
 *   - TABS: the portal's top-level panels (Website, Changes, …).
 *   - MODULES: the site modules inside the Modules panel (Blog, …,
 *     Call Tracking, …) — keys are siteModules.MODULE_TYPES verbatim.
 * The frontend renders nav + module lists from the /me payload, and the
 * portal API guards every route group with the same effective sets, so
 * a hidden tab/module is also a forbidden one (403), never just an
 * invisible button.
 *
 * Precedence (per tab / per module):
 *   factory defaults  →  admin-configured type defaults (platform
 *   setting `portal_access.type_defaults`, editable in Admin →
 *   Portal access)  →  per-user overrides (client_portal_users
 *   .nav_overrides / .module_overrides, Admin → Users).
 *
 * Factory defaults:
 *   owner  → every tab, every module.
 *   renter → tabs [website, modules, rentals], modules [calltracking]
 *            (a site tenant gets their site, the call log, and their
 *            rental view — nothing else unless admin widens it).
 *   partner → every tab, every module (Batch 80, Creator Partner
 *            program — partners work with the full toolset; the type
 *            rides this same registry so admin-configured defaults +
 *            per-user overrides apply to partners too. Staff-side
 *            partner accounts are platform `users` classified by
 *            users.account_type — see server/partners.js).
 */

const { MODULE_TYPES, MODULE_META } = require('./siteModules');

// ---------------------------------------------------------------- tabs
const PORTAL_TABS = [
  'website',
  'changes',
  'forms',
  'leadscout',
  'modules',
  'social',
  'referrals',
  'mcp',
  // Batch 84: the BitPype Agent SOUL.md page — owner factory default
  // gains it via PORTAL_TABS.slice() (partners too); renters stay on
  // their factory three (an agent instruction file is the operator's,
  // not a site tenant's).
  'soul',
  'analytics',
  'seo',
  'rentals',
  'billing',
  // Batch 46: Google Business Profile manager — owner factory default
  // gains it via PORTAL_TABS.slice(); renters stay on their factory
  // three (a tenant rents a site, not the business's Google profile).
  'gbp',
  // Batch 114: the WordPress connector (their own external WP site,
  // connected via the free plugin) — owner + partner factory default
  // via PORTAL_TABS.slice(); renters stay on their factory three.
  'wordpress',
];

const TAB_LABELS = {
  website: 'Website',
  changes: 'Changes',
  forms: 'Forms',
  leadscout: 'LeadScout',
  modules: 'Modules',
  social: 'Social',
  referrals: 'Referrals',
  mcp: 'MCP',
  soul: 'Agent SOUL.md',
  analytics: 'Analytics',
  seo: 'SEO',
  rentals: 'Rentals',
  billing: 'Billing',
  gbp: 'Google Profile',
  wordpress: 'WordPress',
};

const USER_TYPES = ['owner', 'renter', 'partner'];

// ------------------------------------------------------------- modules
const PORTAL_MODULES = MODULE_TYPES.slice();
const MODULE_LABELS = Object.fromEntries(
  PORTAL_MODULES.map((key) => [key, (MODULE_META[key] && MODULE_META[key].label) || key])
);

// ------------------------------------------------------- factory defaults
const FACTORY_DEFAULTS = {
  tabs: {
    owner: PORTAL_TABS.slice(),
    renter: ['website', 'modules', 'rentals'],
    partner: PORTAL_TABS.slice(),
  },
  modules: {
    owner: PORTAL_MODULES.slice(),
    renter: ['calltracking'],
    partner: PORTAL_MODULES.slice(),
  },
};

// Back-compat aliases (tab-only view of the factory defaults).
const TYPE_DEFAULTS = FACTORY_DEFAULTS.tabs;
const MODULE_TYPE_DEFAULTS = FACTORY_DEFAULTS.modules;

const SETTINGS_KEY = 'portal_access.type_defaults';

function normalizeUserType(raw) {
  const t = String(raw || '')
    .trim()
    .toLowerCase();
  return USER_TYPES.includes(t) ? t : 'owner';
}

/**
 * Owner-tier types (Batch 80): 'owner' and 'partner' both carry full
 * portal authority; 'renter' is the restricted tier. Owner-only route
 * defaults and destructive actions check this, not === 'owner'.
 */
function isOwnerTier(raw) {
  const t = normalizeUserType(raw);
  return t === 'owner' || t === 'partner';
}

/**
 * Parse a stored overrides value (JSON string, object, or null) into a
 * clean { key: boolean } map over `knownKeys`. Unknown keys and
 * non-boolean values are dropped; anything unparseable yields {}.
 */
function parseOverrides(raw, knownKeys) {
  let obj = raw;
  if (obj == null || obj === '') return {};
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const key of knownKeys) {
    if (typeof obj[key] === 'boolean') out[key] = obj[key];
  }
  return out;
}

function parseNavOverrides(raw) {
  return parseOverrides(raw, PORTAL_TABS);
}

function parseModuleOverrides(raw) {
  return parseOverrides(raw, PORTAL_MODULES);
}

function sanitizeNavOverrides(input) {
  return parseNavOverrides(typeof input === 'string' ? input : JSON.stringify(input || {}));
}

function sanitizeModuleOverrides(input) {
  return parseOverrides(
    typeof input === 'string' ? input : JSON.stringify(input || {}),
    PORTAL_MODULES
  );
}

/** Clean a key list against the known keys (dedupe, drop unknowns). */
function sanitizeKeyList(input, knownKeys) {
  if (!Array.isArray(input)) return null;
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const key = String(raw || '')
      .trim()
      .toLowerCase();
    if (knownKeys.includes(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/**
 * Resolve the admin-configured type defaults. Input: the raw platform
 * setting (JSON string or object) shaped
 *   { owner: { tabs: [...], modules: [...] }, renter: { ... } }
 * Every slice is sanitized independently; a missing/invalid slice
 * falls back to the factory slice, so a corrupt stored config can
 * never widen or break access — it just resets that slice.
 */
function resolveTypeDefaults(raw) {
  let cfg = raw;
  if (typeof cfg === 'string') {
    try {
      cfg = JSON.parse(cfg);
    } catch {
      cfg = null;
    }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return structuredClone(FACTORY_DEFAULTS);
  }
  const out = structuredClone(FACTORY_DEFAULTS);
  for (const type of USER_TYPES) {
    const slice = cfg[type];
    if (!slice || typeof slice !== 'object') continue;
    const tabs = sanitizeKeyList(slice.tabs, PORTAL_TABS);
    if (tabs) out.tabs[type] = tabs;
    const modules = sanitizeKeyList(slice.modules, PORTAL_MODULES);
    if (modules) out.modules[type] = modules;
  }
  return out;
}

/** Sanitize an admin-submitted defaults payload for storage. */
function sanitizeTypeDefaults(input) {
  const resolved = resolveTypeDefaults(input);
  return {
    owner: { tabs: resolved.tabs.owner, modules: resolved.modules.owner },
    renter: { tabs: resolved.tabs.renter, modules: resolved.modules.renter },
  };
}

// ------------------------------------------- configured defaults (cached)
let defaultsCache = { at: 0, value: null };
const DEFAULTS_TTL_MS = 30 * 1000;

/**
 * The live type defaults: admin-configured platform setting when set,
 * factory defaults otherwise. Cached briefly; the admin write path
 * invalidates immediately (same process serves admin + portal).
 */
async function loadConfiguredDefaults() {
  const now = Date.now();
  if (defaultsCache.value && now - defaultsCache.at < DEFAULTS_TTL_MS) {
    return defaultsCache.value;
  }
  let raw = '';
  try {
    raw = await require('./platform').getPlatformSetting(SETTINGS_KEY, '');
  } catch {
    raw = '';
  }
  const value = resolveTypeDefaults(raw);
  defaultsCache = { at: now, value };
  return value;
}

function invalidateDefaultsCache() {
  defaultsCache = { at: 0, value: null };
}

/** Factory-defaults view for sync callers (payloads that don't gate). */
function factoryDefaults() {
  return structuredClone(FACTORY_DEFAULTS);
}

// ------------------------------------------------------- effective sets
function effectiveSet(knownKeys, defaultsForType, overridesRaw) {
  const defaults = new Set(defaultsForType || []);
  const overrides = parseOverrides(overridesRaw, knownKeys);
  return knownKeys.filter((key) =>
    Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : defaults.has(key)
  );
}

function effectiveTabs(userType, overridesRaw, defaults) {
  const type = normalizeUserType(userType);
  const d = defaults || FACTORY_DEFAULTS;
  return effectiveSet(PORTAL_TABS, d.tabs[type], overridesRaw);
}

function effectiveModules(userType, overridesRaw, defaults) {
  const type = normalizeUserType(userType);
  const d = defaults || FACTORY_DEFAULTS;
  return effectiveSet(PORTAL_MODULES, d.modules[type], overridesRaw);
}

/** Accepts a portal user row (snake_case or camelCase). */
function tabsForUser(user, defaults) {
  if (!user || typeof user !== 'object') return effectiveTabs('owner', null, defaults);
  return effectiveTabs(
    user.user_type || user.userType,
    user.nav_overrides ?? user.navOverrides,
    defaults
  );
}

function modulesForUser(user, defaults) {
  if (!user || typeof user !== 'object') return effectiveModules('owner', null, defaults);
  return effectiveModules(
    user.user_type || user.userType,
    user.module_overrides ?? user.moduleOverrides,
    defaults
  );
}

function hasTab(user, tab, defaults) {
  return tabsForUser(user, defaults).includes(tab);
}

function hasModule(user, moduleKey, defaults) {
  return modulesForUser(user, defaults).includes(moduleKey);
}

module.exports = {
  PORTAL_TABS,
  TAB_LABELS,
  PORTAL_MODULES,
  MODULE_LABELS,
  USER_TYPES,
  FACTORY_DEFAULTS,
  TYPE_DEFAULTS,
  MODULE_TYPE_DEFAULTS,
  SETTINGS_KEY,
  normalizeUserType,
  isOwnerTier,
  parseNavOverrides,
  parseModuleOverrides,
  sanitizeNavOverrides,
  sanitizeModuleOverrides,
  sanitizeKeyList,
  resolveTypeDefaults,
  sanitizeTypeDefaults,
  loadConfiguredDefaults,
  invalidateDefaultsCache,
  factoryDefaults,
  effectiveTabs,
  effectiveModules,
  tabsForUser,
  modulesForUser,
  hasTab,
  hasModule,
};
