// @ts-check
'use strict';

/**
 * Batch 120 — AI provider routing: which API does what, per function,
 * with automatic failover (Ely's order, 2026-11-02: a proper provider
 * option built so he can SELECT WHICH API DOES WHAT — per function,
 * not one global switch).
 *
 * Provider profiles are OpenAI-compatible chat/completions
 * endpoints, and all keep their settings trios as storage (no secret
 * migration, keys are never rendered anywhere):
 *   - 'muse'       → muse.model_api_key / muse.model_base_url /
 *                    muse.model_default (default
 *                    https://api.meta.ai/v1, model muse-spark-1.3)
 *   - 'openai'     → ai.api_key / ai.base_url / ai.model.default
 *                    (default https://api.openai.com/v1, gpt-4o-mini)
 *   - 'openrouter' → openrouter.api_key / openrouter.base_url /
 *                    openrouter.model (Batch 123 — the OpenRouter
 *                    aggregator as a third selectable provider on
 *                    every routed function; default
 *                    https://openrouter.ai/api/v1, model
 *                    openai/gpt-4o-mini). Until an admin pastes a
 *                    key the profile is simply "not configured" and
 *                    behaves exactly like any other keyless profile.
 *
 * Routing is stored as PLATFORM settings (platform-level scope for
 * v1; workspace overrides are future work):
 *   ai.route.<function>.primary        'muse' | 'openai' | 'openrouter'
 *   ai.route.<function>.fallback       'none' | 'muse' | 'openai' | 'openrouter'
 *   ai.route.<function>.model_primary  '' = the provider's default
 *   ai.route.<function>.model_fallback '' = the provider's default
 *
 * Shipped defaults preserve today's behaviour EXCEPT the failover Ely
 * ordered: the agent functions (design chat, WP design chat,
 * hands-off/queue) run Meta Muse primary with OpenAI fallback; the
 * task-stack functions run OpenAI primary with no fallback (their
 * prompts/models are GPT-tuned — the admin can change any row).
 * Image generation (OpenAI images) and photo enhancement (fal) are
 * single-provider today and appear in the matrix as informational
 * rows only — no fake dropdowns.
 *
 * Failover rules (enforced by both call stacks at the raw
 * chat/completions call, BEFORE any tool execution, so a retried
 * call can never double-execute a tool step):
 *   - fail over on provider-side failure: HTTP 401/403 (incl.
 *     billing blocks), 429, 5xx, network error, timeout.
 *   - never fail over on a 400-class request error — that is our
 *     bug, not an outage; it surfaces as-is.
 *   - one fallback attempt per call.
 *   - cooldown: after a 401/403 the primary is skipped for 10
 *     minutes per function; after a 429, for 2 minutes. Cooldown +
 *     the last failover event are visible in the admin matrix.
 *
 * This module is the single resolver both stacks call. It has no
 * top-level server dependencies (platform is lazy-required) so
 * src/ai.js can require it without a load cycle.
 */

const PROVIDERS = {
  muse: { slug: 'muse', label: 'Meta Muse' },
  openai: { slug: 'openai', label: 'OpenAI' },
  openrouter: { slug: 'openrouter', label: 'OpenRouter' },
};

/** @type {Array<{ key: string, label: string, kind: 'agent'|'task', defaultPrimary: string, defaultFallback: string }>} */
const ROUTABLE_FUNCTIONS = [
  { key: 'design_chat', label: 'Portal design chat', kind: 'agent', defaultPrimary: 'muse', defaultFallback: 'openai' },
  {
    key: 'wp_design_chat',
    label: 'WordPress design chat',
    kind: 'agent',
    defaultPrimary: 'muse',
    defaultFallback: 'openai',
  },
  {
    key: 'hands_off',
    label: 'Design queue / hands-off jobs',
    kind: 'agent',
    defaultPrimary: 'muse',
    defaultFallback: 'openai',
  },
  { key: 'research', label: 'Lead research', kind: 'task', defaultPrimary: 'openai', defaultFallback: 'none' },
  { key: 'scoring', label: 'Lead scoring', kind: 'task', defaultPrimary: 'openai', defaultFallback: 'none' },
  {
    key: 'generation',
    label: 'Website content generation',
    kind: 'task',
    defaultPrimary: 'openai',
    defaultFallback: 'none',
  },
  {
    key: 'qa',
    label: 'QA, design review & chatbot answers',
    kind: 'task',
    defaultPrimary: 'openai',
    defaultFallback: 'none',
  },
  { key: 'editor', label: 'SEO editor', kind: 'task', defaultPrimary: 'openai', defaultFallback: 'none' },
  {
    key: 'email_drafting',
    label: 'Email & follow-up drafting',
    kind: 'task',
    defaultPrimary: 'openai',
    defaultFallback: 'none',
  },
  {
    key: 'vision',
    label: 'Vision analysis (image-bearing calls)',
    kind: 'task',
    defaultPrimary: 'openai',
    defaultFallback: 'none',
  },
];

/** Informational rows: single-provider today, shown without editors. */
const INFO_FUNCTIONS = [
  {
    key: 'image_generation',
    label: 'Image generation',
    provider: 'openai',
    note: 'OpenAI Images (ai.model.image) — single provider today',
  },
  {
    key: 'photo_enhancement',
    label: 'Photo enhancement',
    provider: 'fal',
    note: 'fal.ai enhancement only — fal has no chat/generation route here',
  },
];

const FUNCTION_BY_KEY = new Map(ROUTABLE_FUNCTIONS.map((f) => [f.key, f]));

/** src/ai.js task name → routing function key. */
const TASK_TO_FUNCTION = {
  research: 'research',
  scoring: 'scoring',
  generation: 'generation',
  qa: 'qa',
  editor: 'editor',
  email: 'email_drafting',
  followup: 'email_drafting',
};

const COOLDOWN_MS = { auth: 10 * 60 * 1000, rate: 2 * 60 * 1000 };

// -- Cooldown + last-event state (in-memory, per process; the durable
// record is the ai_usage failover notes). ---------------------------
/** @type {Map<string, { until: number, reason: string, at: number }>} */
const cooldowns = new Map();
/** @type {Map<string, { from: string, to: string, reason: string, at: number }>} */
const lastFailoverByFunction = new Map();
/** @type {{ fnKey: string, from: string, to: string, reason: string, at: number } | null} */
let lastFailover = null;

function cooldownKey(fnKey, provider) {
  return `${fnKey}|${provider}`;
}

/** Record a failover-eligible failure; arms the cooldown when the
 * failure class calls for one. Called by both stacks' transports. */
function noteProviderFailure(fnKey, provider, cls) {
  if (!cls || !cls.cooldownMs) return;
  cooldowns.set(cooldownKey(fnKey, provider), {
    until: Date.now() + cls.cooldownMs,
    reason: cls.reason,
    at: Date.now(),
  });
}

function noteFailover(fnKey, from, to, reason) {
  const ev = { from, to, reason, at: Date.now() };
  lastFailoverByFunction.set(fnKey, ev);
  lastFailover = { fnKey, ...ev };
}

/** Is this provider cooling down for this function right now? */
function isCoolingDown(fnKey, provider, now = Date.now()) {
  const c = cooldowns.get(cooldownKey(fnKey, provider));
  if (!c) return null;
  if (c.until <= now) {
    cooldowns.delete(cooldownKey(fnKey, provider));
    return null;
  }
  return c;
}

function routingStatus() {
  const now = Date.now();
  /** @type {Record<string, { cooldowns: Array<{ provider: string, until: number, reason: string }>, lastFailover: any }>} */
  const byFunction = {};
  for (const fn of ROUTABLE_FUNCTIONS) {
    const cds = [];
    for (const slug of Object.keys(PROVIDERS)) {
      const c = isCoolingDown(fn.key, slug, now);
      if (c) cds.push({ provider: slug, until: c.until, reason: c.reason });
    }
    byFunction[fn.key] = { cooldowns: cds, lastFailover: lastFailoverByFunction.get(fn.key) || null };
  }
  return { byFunction, lastFailover };
}

/** Test hook: clear all in-memory routing state. */
function _resetRoutingState() {
  cooldowns.clear();
  lastFailoverByFunction.clear();
  lastFailover = null;
}

/**
 * Classify a transport error for failover. Transports attach the
 * HTTP status to the error (`err.status`) whenever the provider
 * answered; a missing status means the request never got a response
 * (network error / timeout).
 * @param {any} err
 * @returns {{ failover: boolean, cooldownMs: number, reason: string }}
 */
function classifyError(err) {
  const status = err && typeof err.status === 'number' ? err.status : null;
  if (status != null) {
    if (status === 401 || status === 403)
      return { failover: true, cooldownMs: COOLDOWN_MS.auth, reason: `HTTP ${status}` };
    if (status === 429) return { failover: true, cooldownMs: COOLDOWN_MS.rate, reason: 'HTTP 429' };
    if (status >= 500) return { failover: true, cooldownMs: 0, reason: `HTTP ${status}` };
    return { failover: false, cooldownMs: 0, reason: `HTTP ${status}` };
  }
  // No HTTP response: network error, timeout, or a non-JSON body from
  // a struggling provider — all provider-side, all failover-eligible.
  return { failover: true, cooldownMs: 0, reason: 'network/timeout' };
}

function validProvider(v) {
  return v === 'muse' || v === 'openai' || v === 'openrouter' ? v : null;
}

/**
 * Resolve one function's route from platform settings, with the
 * shipped defaults when unset/invalid. Never throws: a platform DB
 * hiccup degrades to the defaults (= today's behaviour for the task
 * stack, Muse+OpenAI-failover for the agent stack).
 * @param {string} fnKey
 * @returns {Promise<{ primary: string, fallback: string, modelPrimary: string, modelFallback: string }>}
 */
async function getRoute(fnKey) {
  const fn = FUNCTION_BY_KEY.get(fnKey);
  const dflt = fn
    ? { primary: fn.defaultPrimary, fallback: fn.defaultFallback, modelPrimary: '', modelFallback: '' }
    : { primary: 'openai', fallback: 'none', modelPrimary: '', modelFallback: '' };
  try {
    const platform = require('./platform');
    const [p, f, mp, mf] = await Promise.all([
      platform.getPlatformSetting(`ai.route.${fnKey}.primary`, ''),
      platform.getPlatformSetting(`ai.route.${fnKey}.fallback`, ''),
      platform.getPlatformSetting(`ai.route.${fnKey}.model_primary`, ''),
      platform.getPlatformSetting(`ai.route.${fnKey}.model_fallback`, ''),
    ]);
    const primary = validProvider(String(p || '').trim()) || dflt.primary;
    let fallback = String(f || '').trim();
    fallback = fallback === 'none' ? 'none' : validProvider(fallback) || dflt.fallback;
    if (fallback === primary) fallback = 'none';
    return {
      primary,
      fallback,
      modelPrimary: String(mp || '')
        .trim()
        .slice(0, 120),
      modelFallback: String(mf || '')
        .trim()
        .slice(0, 120),
    };
  } catch {
    return dflt;
  }
}

/** Synchronous default route (no settings read) — for contexts that
 * cannot await (kept for parity with getRoute's fallback path). */
function defaultRoute(fnKey) {
  const fn = FUNCTION_BY_KEY.get(fnKey);
  return fn
    ? { primary: fn.defaultPrimary, fallback: fn.defaultFallback, modelPrimary: '', modelFallback: '' }
    : { primary: 'openai', fallback: 'none', modelPrimary: '', modelFallback: '' };
}

/**
 * Order the attempts for one call. Returns a list of
 * { provider, via: 'primary'|'fallback', failoverNote } — the note is
 * set on any attempt that is not the plain primary path (cooldown
 * skip, unconfigured primary). `configured` tells the resolver
 * whether each profile has a key.
 */
function orderAttempts(fnKey, route, configured) {
  const primary = route.primary;
  const fallback = route.fallback && route.fallback !== 'none' ? route.fallback : null;
  /** @type {Array<{ provider: string, via: string, failoverNote: string | null }>} */
  const attempts = [];
  const cd = configured[primary] ? isCoolingDown(fnKey, primary) : null;
  if (configured[primary] && !cd) {
    attempts.push({ provider: primary, via: 'primary', failoverNote: null });
    if (fallback && configured[fallback]) attempts.push({ provider: fallback, via: 'fallback', failoverNote: null });
    return attempts;
  }
  // Primary unusable right now (cooling down or not configured):
  // go straight to the fallback when there is one.
  if (fallback && configured[fallback]) {
    const reason = !configured[primary]
      ? `primary ${primary} not configured`
      : `primary ${primary} cooling down after ${cd ? cd.reason : 'failure'}`;
    attempts.push({ provider: fallback, via: 'fallback', failoverNote: reason });
    return attempts;
  }
  // No usable fallback: try the primary anyway (a cooled-down block
  // may have cleared; an unconfigured primary errors as it does
  // today).
  attempts.push({ provider: primary, via: 'primary', failoverNote: null });
  return attempts;
}

/**
 * Admin matrix state: profiles (status only — never key material),
 * every function's resolved route, cooldowns and last failover.
 */
async function adminState() {
  const platform = require('./platform');
  const [museKey, museBase, museModel, aiKey, aiBase, aiModel, orKey, orBase, orModel, falKey] = await Promise.all([
    platform.getPlatformSetting('muse.model_api_key', ''),
    platform.getPlatformSetting('muse.model_base_url', 'https://api.meta.ai/v1'),
    platform.getPlatformSetting('muse.model_default', 'muse-spark-1.3'),
    platform.getPlatformSetting('ai.api_key', ''),
    platform.getPlatformSetting('ai.base_url', 'https://api.openai.com/v1'),
    platform.getPlatformSetting('ai.model.default', 'gpt-4o-mini'),
    platform.getPlatformSetting('openrouter.api_key', ''),
    platform.getPlatformSetting('openrouter.base_url', 'https://openrouter.ai/api/v1'),
    platform.getPlatformSetting('openrouter.model', 'openai/gpt-4o-mini'),
    platform.getPlatformSetting('fal.api_key', ''),
  ]);
  const hostOf = (u) => {
    try {
      return new URL(String(u || '')).host;
    } catch {
      return '';
    }
  };
  const profiles = {
    muse: {
      label: 'Meta Muse',
      configured: !!String(museKey || '').trim(),
      baseHost: hostOf(museBase),
      defaultModel: String(museModel || ''),
    },
    openai: {
      label: 'OpenAI',
      configured: !!String(aiKey || '').trim(),
      baseHost: hostOf(aiBase),
      defaultModel: String(aiModel || ''),
    },
    openrouter: {
      label: 'OpenRouter',
      configured: !!String(orKey || '').trim(),
      baseHost: hostOf(orBase),
      defaultModel: String(orModel || ''),
    },
    fal: {
      label: 'fal.ai',
      configured: !!String(falKey || '').trim(),
      baseHost: 'fal.ai',
      defaultModel: '',
    },
  };
  const status = routingStatus();
  const functions = [];
  for (const fn of ROUTABLE_FUNCTIONS) {
    const route = await getRoute(fn.key);
    functions.push({
      key: fn.key,
      label: fn.label,
      kind: fn.kind,
      route,
      cooldowns: status.byFunction[fn.key].cooldowns,
      lastFailover: status.byFunction[fn.key].lastFailover,
    });
  }
  for (const fn of INFO_FUNCTIONS) {
    functions.push({
      key: fn.key,
      label: fn.label,
      kind: 'info',
      fixedProvider: fn.provider,
      note: fn.note,
      cooldowns: [],
      lastFailover: null,
    });
  }
  return { profiles, functions, lastFailover: status.lastFailover };
}

/**
 * Validate + normalize a routes payload from the admin matrix.
 * Returns { entries: {settingKey: value} } or throws a coded
 * VALIDATION error. fallback === primary is rejected (a route that
 * fails over to itself is a typo, not a route).
 */
function validateRoutesPayload(routes) {
  /** @type {Record<string, string>} */
  const entries = {};
  if (!routes || typeof routes !== 'object') {
    const e = /** @type {Error & { code?: string }} */ (new Error('routes payload required'));
    e.code = 'VALIDATION';
    throw e;
  }
  for (const [fnKey, row] of Object.entries(routes)) {
    if (!FUNCTION_BY_KEY.has(fnKey)) {
      const e = /** @type {Error & { code?: string }} */ (new Error(`Unknown AI function: ${fnKey}`));
      e.code = 'VALIDATION';
      throw e;
    }
    const r = row && typeof row === 'object' ? row : {};
    const primary = validProvider(String(r.primary || '').trim());
    if (!primary) {
      const e = /** @type {Error & { code?: string }} */ (
        new Error(`${fnKey}: primary must be muse, openai or openrouter`)
      );
      e.code = 'VALIDATION';
      throw e;
    }
    let fallback = String(r.fallback == null ? 'none' : r.fallback).trim();
    if (fallback !== 'none' && !validProvider(fallback)) {
      const e = /** @type {Error & { code?: string }} */ (
        new Error(`${fnKey}: fallback must be none, muse, openai or openrouter`)
      );
      e.code = 'VALIDATION';
      throw e;
    }
    if (fallback === primary) {
      const e = /** @type {Error & { code?: string }} */ (
        new Error(`${fnKey}: fallback cannot be the same provider as primary`)
      );
      e.code = 'VALIDATION';
      throw e;
    }
    const model = (v) => {
      const s = String(v || '').trim();
      if (s.length > 120 || /[\r\n]/.test(s)) {
        const e = /** @type {Error & { code?: string }} */ (
          new Error(`${fnKey}: model override must be a single line of at most 120 characters`)
        );
        e.code = 'VALIDATION';
        throw e;
      }
      return s;
    };
    entries[`ai.route.${fnKey}.primary`] = primary;
    entries[`ai.route.${fnKey}.fallback`] = fallback;
    entries[`ai.route.${fnKey}.model_primary`] = model(r.modelPrimary);
    entries[`ai.route.${fnKey}.model_fallback`] = model(r.modelFallback);
  }
  return entries;
}

module.exports = {
  PROVIDERS,
  ROUTABLE_FUNCTIONS,
  INFO_FUNCTIONS,
  TASK_TO_FUNCTION,
  getRoute,
  defaultRoute,
  classifyError,
  noteProviderFailure,
  noteFailover,
  isCoolingDown,
  orderAttempts,
  routingStatus,
  adminState,
  validateRoutesPayload,
  _resetRoutingState,
};
