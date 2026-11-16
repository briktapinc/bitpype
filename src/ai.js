'use strict';

/**
 * Shared AI client (owned by the Website Engine workstream).
 *
 * OpenAI-compatible POST to `<ai.base_url>/chat/completions` using the API key
 * stored in settings (`ai.api_key`). Other workstreams require this module:
 *
 *   const { chat, aiConfigured } = require('../ai');
 *
 * Contract:
 *  - chat({ task, messages, maxTokens=2000, leadId, note, db }) — task is one of
 *    research|generation|scoring|email|qa|editor|followup. Model resolves from
 *    `ai.model.<task>` falling back to `ai.model.default`.
 *  - `db` is required (workspace SQLite). Missing db throws AI_DB_REQUIRED so
 *    concurrent tenants cannot share keys/budget via a module-level handle.
 *  - Throws AI_NOT_CONFIGURED when no key is set (callers fall back to
 *    deterministic template output).
 *  - Throws AUTOMATION_PAUSED when settings.automation_paused = 1.
 *  - Throws BUDGET_EXCEEDED when today's SUM(ai_usage.cost_usd) >=
 *    cost.daily_budget_usd (a budget <= 0 means unlimited).
 *  - Every call is logged to ai_usage with token counts + cost estimate
 *    (cost.per_1k_prompt default 0.0015, cost.per_1k_completion default 0.002)
 *    and the serving provider, derived from the base URL actually used
 *    (Batch 106 — see src/aiProvider.js).
 *  - Batch 120: the provider for each call comes from the per-function
 *    routing matrix (server/aiRouting.js) — task → function via
 *    TASK_TO_FUNCTION, image-bearing calls route as 'vision'. A
 *    provider-side failure (401/403/429/5xx/network/timeout) retries
 *    once on the function's fallback provider; a 400-class error
 *    surfaces without failing over. AI_NOT_CONFIGURED now means no
 *    routed provider for the function has a key.
 *  - Batch 123: OpenRouter is a third routable profile (openrouter.*
 *    trio, platform-first like Muse). It keeps its own default model
 *    — legacy per-task ai.model.* names are OpenAI-profile-only.
 *  - aiConfigured(db) — true when an API key is set on that workspace db.
 *  - No key material is ever written to logs or error messages.
 */

function requireDb(db, label = 'db') {
  if (!db || typeof db.prepare !== 'function') {
    throw fail('AI_DB_REQUIRED', `${label} is required — pass the workspace database handle.`);
  }
  return db;
}

function getSetting(key, def, db) {
  requireDb(db, 'db');
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? require('./secretBox').decryptSetting(key, row.value) : def;
}

function aiConfigured(db) {
  if (!db || typeof db.prepare !== 'function') return false;
  const key = getSetting('ai.api_key', '', db);
  return !!(key && String(key).trim());
}

/**
 * Batch 192 (Greptile verification #12): the routed counterpart of
 * aiConfigured(). aiConfigured() checks ONLY the workspace's legacy
 * ai.api_key, so callers that pre-gated on it skipped/refused work
 * even when the function's routed provider was a platform-keyed
 * profile (Muse / OpenRouter) with a key set — the exact defect
 * Batch 143 fixed for the chatbot alone. This helper propagates
 * that fix: the gate passes when EITHER the legacy key is set OR
 * aiRouting.orderAttempts() for the function yields an attempt
 * whose provider is actually configured (platform-first Muse /
 * OpenRouter keys, workspace fallback — the chatbot's resolution).
 * The OpenAI profile's key IS the legacy workspace key, already
 * checked above. `fnKey` accepts a routing function key
 * ('editor', 'qa', …) or a chat task name ('email', 'research', …).
 * When nothing is configured — or the routing layer is unreachable —
 * it returns false, exactly as the legacy gate did.
 */
async function aiConfiguredRouted(db, fnKey) {
  if (aiConfigured(db)) return true;
  if (!db || typeof db.prepare !== 'function') return false;
  try {
    const aiRouting = require('../server/aiRouting');
    const platform = require('../server/platform');
    const key = aiRouting.TASK_TO_FUNCTION[String(fnKey || '')] || String(fnKey || 'qa');
    const [route, pMuse, pOr] = await Promise.all([
      aiRouting.getRoute(key),
      platform.getPlatformSetting('muse.model_api_key', ''),
      platform.getPlatformSetting('openrouter.api_key', ''),
    ]);
    const wsSetting = (k) => {
      try {
        return getSetting(k, '', db);
      } catch {
        return '';
      }
    };
    const configured = {
      muse: !!String(pMuse || wsSetting('muse.model_api_key') || '').trim(),
      openai: false, // the legacy workspace key — already known unset here
      openrouter: !!String(pOr || wsSetting('openrouter.api_key') || '').trim(),
    };
    return aiRouting.orderAttempts(key, route, configured).some((a) => configured[a.provider]);
  } catch {
    return false;
  }
}

function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function todaySpendUsd(db) {
  const row = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM ai_usage WHERE date(at) = date('now')").get();
  return Number(row.spent) || 0;
}

const VALID_TASKS = new Set(['research', 'generation', 'scoring', 'email', 'qa', 'editor', 'followup']);

/** @deprecated No-op — callers must pass db into chat()/aiConfigured(). Kept for IPC compat. */
function setDb() {
  /* intentionally empty */
}

async function chat({ task, messages, maxTokens = 2000, leadId = null, note = null, db: dbArg = null } = {}) {
  if (!task || !VALID_TASKS.has(task)) {
    throw fail('INVALID_TASK', `Unknown AI task "${task}".`);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw fail('INVALID_MESSAGES', 'messages must be a non-empty array.');
  }
  let hasImages = false;
  for (const m of messages) {
    if (!m || typeof m.role !== 'string') {
      throw fail('INVALID_MESSAGES', 'Each message needs a string role and content.');
    }
    if (typeof m.content === 'string') continue;
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== 'object') {
          throw fail('INVALID_MESSAGES', 'Multimodal content parts must be objects.');
        }
        if (part.type === 'image_url' || (part.image_url && part.image_url.url)) hasImages = true;
      }
      continue;
    }
    throw fail('INVALID_MESSAGES', 'Each message content must be a string or multimodal array.');
  }
  const tokens = Number(maxTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw fail('INVALID_MAX_TOKENS', 'maxTokens must be a positive number.');
  }

  const db = requireDb(dbArg);

  // Batch 120 — per-function provider routing (server/aiRouting.js):
  // this task's function row picks the primary + fallback provider,
  // and a provider-side failure on the primary retries ONCE on the
  // fallback at this raw call level. Image-bearing calls route as
  // the 'vision' function. The OpenAI profile below keeps the exact
  // legacy workspace resolution (per-task model + vision swap); the
  // Muse profile resolves platform-first like the agent stack.
  const aiRouting = require('../server/aiRouting');
  const fnKey = hasImages ? 'vision' : aiRouting.TASK_TO_FUNCTION[task] || 'qa';
  const route = await aiRouting.getRoute(fnKey);

  let legacyModel = getSetting(`ai.model.${task}`, '', db);
  if (!legacyModel || !String(legacyModel).trim()) {
    legacyModel = getSetting('ai.model.default', 'gpt-4o-mini', db);
  }
  legacyModel = String(legacyModel).trim();
  // Vision-capable default when the request includes screenshots / images.
  if (hasImages) {
    const visionModel = getSetting('ai.model.vision', '', db);
    if (visionModel && String(visionModel).trim()) {
      legacyModel = String(visionModel).trim();
    } else if (/mini|nano|haiku/i.test(legacyModel)) {
      legacyModel = 'gpt-4o';
    }
  }

  const profiles = {
    openai: {
      apiKey: getSetting('ai.api_key', '', db),
      baseUrl: String(getSetting('ai.base_url', 'https://api.openai.com/v1', db) || '')
        .trim()
        .replace(/\/+$/, ''),
      model: legacyModel,
    },
    muse: await resolveMuseProfile(db),
    openrouter: await resolveOpenRouterProfile(db),
  };
  const configured = {
    muse: !!(profiles.muse.apiKey && String(profiles.muse.apiKey).trim()),
    openai: !!(profiles.openai.apiKey && String(profiles.openai.apiKey).trim()),
    openrouter: !!(profiles.openrouter.apiKey && String(profiles.openrouter.apiKey).trim()),
  };
  const attempts = aiRouting.orderAttempts(fnKey, route, configured).map((a) => ({
    ...a,
    profile: profiles[a.provider],
    model: (a.via === 'primary' ? route.modelPrimary : route.modelFallback) || profiles[a.provider].model,
  }));

  if (!attempts.some((a) => a.profile.apiKey && String(a.profile.apiKey).trim())) {
    throw fail('AI_NOT_CONFIGURED', 'AI is not configured for this function: no routed provider has an API key set.');
  }

  if (String(getSetting('automation_paused', '0', db)) === '1') {
    throw fail('AUTOMATION_PAUSED', 'Automation is paused; AI calls are blocked.');
  }

  const budget = parseFloat(getSetting('cost.daily_budget_usd', '10', db));
  if (budget > 0) {
    const spent = todaySpendUsd(db);
    if (spent >= budget) {
      throw fail('BUDGET_EXCEEDED', 'Daily AI budget exceeded.');
    }
  }

  // One raw chat/completions attempt against one profile. The SSRF /
  // key-exfiltration guard (port of audit H4) runs per attempt, before
  // that profile's key leaves: the key rides on this request, so the
  // base must be https and resolve to public addresses (see
  // server/urlSafety.assertAiBaseUrl).
  async function attemptFetch(att) {
    const baseUrl = att.profile.baseUrl;
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw fail('INVALID_BASE_URL', 'The routed provider base URL must be an http(s) URL.');
    }
    try {
      await require('../server/urlSafety').assertAiBaseUrl(baseUrl);
    } catch (e) {
      throw fail(e.code || 'UNSAFE_BASE_URL', e.message);
    }
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        // Never follow redirects: the validated base is the only host
        // the key may reach (port of audit H4).
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          // Key is only ever placed in the Authorization header, never logged.
          Authorization: `Bearer ${String(att.profile.apiKey).trim()}`,
        },
        body: JSON.stringify({
          model: att.model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          max_tokens: Math.floor(tokens),
        }),
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      // No .status — the routing layer reads that as network/timeout
      // (provider-side, failover-eligible).
      throw fail('AI_NETWORK_ERROR', `AI request failed to reach the provider (${e.message || 'network error'}).`);
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      throw fail('AI_BAD_RESPONSE', `AI provider returned a non-JSON response (HTTP ${res.status}).`, {
        status: res.status,
      });
    }
    if (!res.ok) {
      // Never include the key or raw provider payload in the error.
      const providerMsg =
        data && data.error && data.error.message ? String(data.error.message).slice(0, 200) : `HTTP ${res.status}`;
      throw fail('AI_REQUEST_FAILED', `AI request failed: ${providerMsg}`, { status: res.status });
    }
    return data;
  }

  let data = null;
  let served = null;
  let servedNote = null;
  let lastErr = null;
  let pendingNote = null;
  for (let i = 0; i < attempts.length; i++) {
    const att = attempts[i];
    try {
      data = await attemptFetch(att);
      served = att;
      servedNote = att.failoverNote || pendingNote;
      if (att.via === 'fallback' && att.failoverNote) {
        aiRouting.noteFailover(fnKey, route.primary, att.provider, att.failoverNote);
      }
      break;
    } catch (e) {
      lastErr = e;
      const cls = aiRouting.classifyError(e);
      const next = attempts[i + 1];
      if (!next || !cls.failover) throw e;
      aiRouting.noteProviderFailure(fnKey, att.provider, cls);
      aiRouting.noteFailover(fnKey, att.provider, next.provider, cls.reason);
      pendingNote = `failover ${att.provider}→${next.provider} (${cls.reason})`;
    }
  }
  if (!served) {
    throw lastErr || fail('AI_NOT_CONFIGURED', 'AI is not configured for this function.');
  }

  const usage = (data && data.usage) || {};
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const per1kPrompt = parseFloat(getSetting('cost.per_1k_prompt', '0.0015', db)) || 0;
  const per1kCompletion = parseFloat(getSetting('cost.per_1k_completion', '0.002', db)) || 0;
  const costUsd = (promptTokens / 1000) * per1kPrompt + (completionTokens / 1000) * per1kCompletion;

  // Log every call, attributed to the provider that actually served
  // it — derived from the base URL this call was sent to (Batch 106) —
  // with the failover note appended when the fallback rescued the
  // call. Note text never includes key material (callers must keep
  // prompts free of secrets; see credential rules).
  const provider = require('./aiProvider').providerFromBaseUrl(served.profile.baseUrl);
  const model = served.model;
  const fullNote = servedNote ? (note ? `${note} · ${servedNote}` : servedNote) : note;
  db.prepare(
    `INSERT INTO ai_usage (task, provider, model, prompt_tokens, completion_tokens, cost_usd, lead_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(task, provider, model, promptTokens, completionTokens, costUsd, leadId, fullNote ? String(fullNote).slice(0, 500) : null);

  let text = '';
  try {
    const choice = data.choices && data.choices[0];
    text = (choice && choice.message && choice.message.content) || '';
  } catch (e) {
    /* keep text empty */
  }

  return { text: String(text), model, provider, promptTokens, completionTokens, costUsd };
}

/**
 * The Muse profile (muse.model_* trio) for the task stack, resolved
 * platform-first with the workspace fallback — the same layering
 * server/museAgentCore.resolveMuseConfig uses, so a function routed
 * to Meta Muse behaves identically from either stack.
 */
async function resolveMuseProfile(db) {
  let apiKey = '';
  let baseUrl = 'https://api.meta.ai/v1';
  let model = 'muse-spark-1.3';
  try {
    const platform = require('../server/platform');
    apiKey = String((await platform.getPlatformSetting('muse.model_api_key', '')) || '').trim();
    baseUrl = String((await platform.getPlatformSetting('muse.model_base_url', baseUrl)) || baseUrl).trim() || baseUrl;
    model = String((await platform.getPlatformSetting('muse.model_default', model)) || model).trim() || model;
  } catch {
    /* platform DB unavailable — fall through to workspace */
  }
  if (!apiKey && db) {
    apiKey = String(getSetting('muse.model_api_key', '', db) || '').trim();
    const b = String(getSetting('muse.model_base_url', '', db) || '').trim();
    const m = String(getSetting('muse.model_default', '', db) || '').trim();
    if (b) baseUrl = b;
    if (m) model = m;
  }
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model };
}

/**
 * Batch 123 — the OpenRouter profile (openrouter.* trio) for the
 * task stack, resolved platform-first with the workspace fallback —
 * the same layering as the Muse profile above. Unlike the OpenAI
 * profile it carries its OWN default model (OpenRouter slugs are
 * namespaced, e.g. openai/gpt-4o-mini), so a per-slot route model
 * override or the profile default serves; the legacy per-task
 * ai.model.* names never leak onto the OpenRouter wire.
 */
async function resolveOpenRouterProfile(db) {
  let apiKey = '';
  let baseUrl = 'https://openrouter.ai/api/v1';
  let model = 'openai/gpt-4o-mini';
  try {
    const platform = require('../server/platform');
    apiKey = String((await platform.getPlatformSetting('openrouter.api_key', '')) || '').trim();
    baseUrl = String((await platform.getPlatformSetting('openrouter.base_url', baseUrl)) || baseUrl).trim() || baseUrl;
    model = String((await platform.getPlatformSetting('openrouter.model', model)) || model).trim() || model;
  } catch {
    /* platform DB unavailable — fall through to workspace */
  }
  if (!apiKey && db) {
    apiKey = String(getSetting('openrouter.api_key', '', db) || '').trim();
    const b = String(getSetting('openrouter.base_url', '', db) || '').trim();
    const m = String(getSetting('openrouter.model', '', db) || '').trim();
    if (b) baseUrl = b;
    if (m) model = m;
  }
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model };
}

module.exports = { chat, aiConfigured, aiConfiguredRouted, setDb, getSetting };
