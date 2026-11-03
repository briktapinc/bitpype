// @ts-check
'use strict';

/**
 * Batch 111 (consolidation step 4) — Muse provider plumbing: config resolution, spend guard reads, usage logging, tool-shape conversion, the chat/completions transport.
 * PURE code motion from server/museAgent.js (no logic edits, no
 * prompt-text changes); server/museAgent.js re-exports the full
 * original surface.
 */

const platform = require('./platform');
const crypto = require('node:crypto');
const { REQUEST_TIMEOUT_MS, DENY_TOOLS } = require('./museAgentTools');

function fail(code, message) {
  const err = /** @type {Error & { code?: string }} */ (new Error(message));
  err.code = code;
  return err;
}

function getDbSetting(db, key, def = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    // SECRET_KEYS (incl. muse.model_api_key) are secretBox-encrypted at
    // rest — decrypt on read like every other sanctioned reader, or the
    // workspace fallback hands the API ciphertext as its key.
    return row && row.value != null ? String(require('../src/secretBox').decryptSetting(key, row.value)) : def;
  } catch {
    return def;
  }
}

async function resolveMuseConfig(db) {
  let apiKey = '';
  let baseUrl = 'https://api.meta.ai/v1';
  let model = 'muse-spark-1.3';
  try {
    apiKey = String((await platform.getPlatformSetting('muse.model_api_key', '')) || '').trim();
    baseUrl = String((await platform.getPlatformSetting('muse.model_base_url', baseUrl)) || baseUrl).trim();
    model = String((await platform.getPlatformSetting('muse.model_default', model)) || model).trim();
  } catch {
    /* platform DB unavailable — fall through to workspace */
  }
  if (!apiKey && db) {
    apiKey = String(getDbSetting(db, 'muse.model_api_key', '') || '').trim();
    const b = String(getDbSetting(db, 'muse.model_base_url', '') || '').trim();
    const m = String(getDbSetting(db, 'muse.model_default', '') || '').trim();
    if (b) baseUrl = b;
    if (m) model = m;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  return { apiKey, baseUrl, model };
}

function museConfigured(config) {
  const one = (c) => !!(c && c.apiKey && /^https?:\/\//i.test(c.baseUrl));
  if (!config) return false;
  // Batch 120: a routed context counts as configured when EITHER its
  // primary or its fallback profile can serve — the whole point of
  // failover is that a dead primary no longer reads as "not
  // configured". Plain (unrouted) configs keep the original rule.
  if (config.fallback !== undefined) return one(config) || one(config.fallback);
  return one(config);
}

function todaySpendUsd(db) {
  try {
    const row = db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM ai_usage WHERE date(at) = date('now')")
      .get();
    return Number(row.spent) || 0;
  } catch {
    return 0;
  }
}

// Batch 106: the provider that served a museAgent call is the host
// its configured base URL points at (api.meta.ai → 'muse' today).
function providerForConfig(config) {
  try {
    return require('../src/aiProvider').providerFromBaseUrl(config && config.baseUrl);
  } catch {
    return 'unknown';
  }
}

function logUsage(db, { task, provider, model, promptTokens, completionTokens, costUsd, leadId, note }) {
  try {
    db.prepare(
      `INSERT INTO ai_usage (task, provider, model, prompt_tokens, completion_tokens, cost_usd, lead_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      task || 'hands_off',
      provider || 'unknown',
      model || '',
      promptTokens || 0,
      completionTokens || 0,
      costUsd || 0,
      leadId || null,
      note ? String(note).slice(0, 500) : null
    );
  } catch (e) {
    console.warn('[museAgent] ai_usage log failed:', e.message);
  }
}

function mcpToolsToOpenAi(toolDefs) {
  const toolNames = new Map();
  const tools = (toolDefs || [])
    .filter((t) => t && t.name && !DENY_TOOLS.has(t.name))
    .map((t) => {
      // Providers have different namespace rules. Keep wire names portable, short,
      // and unambiguous; dispatch only through this advertised catalog map.
      const name =
        String(t.name)
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 48) +
        '_' +
        crypto.createHash('sha256').update(t.name).digest('hex').slice(0, 12);
      if (toolNames.has(name)) throw fail('TOOL_CATALOG_INVALID', 'Duplicate AI tool alias');
      toolNames.set(name, t.name);
      return {
        type: 'function',
        function: {
          name,
          description: String(t.description || '').slice(0, 1024),
          parameters:
            t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
        },
      };
    });
  return { tools, toolNames };
}

async function chatCompletions(config, body) {
  const url = `${config.baseUrl}/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    // No HTTP status on this one — the routing layer reads a missing
    // status as a network/timeout failure (failover-eligible).
    throw fail('MUSE_NETWORK', `Muse request failed: ${e.message || 'network error'}`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Batch 120: the status rides along so the routing layer can
    // classify the failure (5xx = provider-side, 400 = our bug).
    const err = /** @type {Error & { code?: string, status?: number }} */ (
      fail('MUSE_BAD_RESPONSE', `Muse returned non-JSON (HTTP ${res.status})`)
    );
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const providerMsg =
      data && data.error && data.error.message ? String(data.error.message).slice(0, 200) : `HTTP ${res.status}`;
    const err = /** @type {Error & { code?: string, status?: number }} */ (
      fail('MUSE_REQUEST_FAILED', `Muse request failed: ${providerMsg}`)
    );
    err.status = res.status;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------
// Batch 120 — routed agent transport. The two provider profiles keep
// their legacy settings as storage; the routing matrix (server/
// aiRouting.js) decides which profile serves each agent function,
// and chatCompletionsRouted fails over at this raw call level —
// before any tool execution — so a retried call can never
// double-execute a tool step.
// ------------------------------------------------------------------

const aiRouting = require('./aiRouting');

/**
 * The OpenAI profile (ai.* trio), resolved platform-first with the
 * workspace fallback — the same layering resolveMuseConfig uses for
 * the Muse profile, so both profiles behave identically as sources.
 */
async function resolveOpenAiConfig(db) {
  let apiKey = '';
  let baseUrl = 'https://api.openai.com/v1';
  let model = 'gpt-4o-mini';
  try {
    apiKey = String((await platform.getPlatformSetting('ai.api_key', '')) || '').trim();
    baseUrl = String((await platform.getPlatformSetting('ai.base_url', baseUrl)) || baseUrl).trim();
    model = String((await platform.getPlatformSetting('ai.model.default', model)) || model).trim();
  } catch {
    /* platform DB unavailable — fall through to workspace */
  }
  if (!apiKey && db) {
    apiKey = String(getDbSetting(db, 'ai.api_key', '') || '').trim();
    const b = String(getDbSetting(db, 'ai.base_url', '') || '').trim();
    const m = String(getDbSetting(db, 'ai.model.default', '') || '').trim();
    if (b) baseUrl = b;
    if (m) model = m;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  return { apiKey, baseUrl, model };
}

async function resolveProfileConfig(provider, db) {
  return provider === 'openai' ? resolveOpenAiConfig(db) : resolveMuseConfig(db);
}

/**
 * Resolve the routed context for one agent function. The returned
 * object carries the PRIMARY profile's fields at top level (every
 * existing reader of a muse config keeps working), plus:
 *   fnKey, provider (primary slug), fallback (profile config|null),
 *   servedProvider / servedModel / failoverNote — set by
 *   chatCompletionsRouted after each call for usage logging.
 * @param {any} db
 * @param {string} fnKey 'design_chat' | 'wp_design_chat' | 'hands_off'
 */
async function resolveAgentConfig(db, fnKey) {
  const route = await aiRouting.getRoute(fnKey);
  const primaryCfg = await resolveProfileConfig(route.primary, db);
  let fallback = null;
  if (route.fallback && route.fallback !== 'none' && route.fallback !== route.primary) {
    const fbCfg = await resolveProfileConfig(route.fallback, db);
    fallback = {
      provider: route.fallback,
      apiKey: fbCfg.apiKey,
      baseUrl: fbCfg.baseUrl,
      model: route.modelFallback || fbCfg.model,
    };
  }
  return {
    fnKey,
    provider: route.primary,
    apiKey: primaryCfg.apiKey,
    baseUrl: primaryCfg.baseUrl,
    model: route.modelPrimary || primaryCfg.model,
    fallback,
    servedProvider: /** @type {string | null} */ (null),
    servedModel: /** @type {string | null} */ (null),
    failoverNote: /** @type {string | null} */ (null),
  };
}

/**
 * Run one chat/completions call through the routed context: primary
 * first (unless cooling down / unconfigured), one fallback attempt
 * on a provider-side failure, never a retry on a 400-class error.
 * Sets ctx.servedProvider / servedModel / failoverNote for logging.
 * @param {any} ctx a resolveAgentConfig result
 * @param {any} body the chat/completions body (model is rewritten per attempt)
 */
async function chatCompletionsRouted(ctx, body) {
  const configured = {
    muse: false,
    openai: false,
  };
  const primaryCfg = { provider: ctx.provider, apiKey: ctx.apiKey, baseUrl: ctx.baseUrl, model: ctx.model };
  configured[ctx.provider] = museConfigured(primaryCfg);
  let fallbackCfg = null;
  if (ctx.fallback) {
    fallbackCfg = {
      provider: ctx.fallback.provider,
      apiKey: ctx.fallback.apiKey,
      baseUrl: ctx.fallback.baseUrl,
      model: ctx.fallback.model,
    };
    configured[ctx.fallback.provider] = museConfigured(fallbackCfg);
  }
  const route = {
    primary: ctx.provider,
    fallback: ctx.fallback ? ctx.fallback.provider : 'none',
    modelPrimary: '',
    modelFallback: '',
  };
  const attempts = aiRouting.orderAttempts(ctx.fnKey, route, configured).map((a) => ({
    ...a,
    cfg: a.provider === ctx.provider ? primaryCfg : fallbackCfg,
  }));
  let lastErr = null;
  let pendingNote = null;
  for (let i = 0; i < attempts.length; i++) {
    const att = attempts[i];
    if (!att.cfg) continue;
    try {
      const data = await chatCompletions(att.cfg, { ...body, model: att.cfg.model });
      ctx.servedProvider = providerForConfig(att.cfg);
      ctx.servedModel = att.cfg.model;
      ctx.failoverNote = att.failoverNote || pendingNote;
      if (att.via === 'fallback' && att.failoverNote) {
        aiRouting.noteFailover(ctx.fnKey, ctx.provider, att.provider, att.failoverNote);
      }
      return data;
    } catch (e) {
      lastErr = e;
      const cls = aiRouting.classifyError(e);
      const next = attempts[i + 1];
      if (!next || !next.cfg || !cls.failover) throw e;
      aiRouting.noteProviderFailure(ctx.fnKey, att.provider, cls);
      pendingNote = `failover ${att.provider}→${next.provider} (${cls.reason})`;
      aiRouting.noteFailover(ctx.fnKey, att.provider, next.provider, cls.reason);
    }
  }
  throw lastErr || fail('MUSE_NOT_CONFIGURED', 'No AI provider is configured for this function');
}

/** The ai_usage provider slug for the config that actually served
 * the last routed call (Batch 106 host attribution), or the primary
 * when nothing has been served yet. */
function servedProviderFor(ctx) {
  return (ctx && ctx.servedProvider) || providerForConfig(ctx);
}

function servedModelFor(ctx) {
  return (ctx && ctx.servedModel) || (ctx && ctx.model) || '';
}

/** Append the failover note (when the last call failed over) to a
 * usage-log note so Finance can see which calls were rescued. */
function withFailoverNote(ctx, note) {
  const base = String(note || '');
  return ctx && ctx.failoverNote ? (base ? `${base} · ${ctx.failoverNote}` : ctx.failoverNote) : base;
}

/**
 * Run the Muse tool loop for one design job.
 * @returns {{ ok, delivered, steps, toolCalls, error?, costUsd, model }}
 */

module.exports = {
  resolveMuseConfig,
  resolveOpenAiConfig,
  resolveAgentConfig,
  museConfigured,
  fail,
  getDbSetting,
  todaySpendUsd,
  providerForConfig,
  logUsage,
  mcpToolsToOpenAi,
  chatCompletions,
  chatCompletionsRouted,
  servedProviderFor,
  servedModelFor,
  withFailoverNote,
};
