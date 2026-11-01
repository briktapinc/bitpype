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
  return !!(config && config.apiKey && /^https?:\/\//i.test(config.baseUrl));
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
    throw fail('MUSE_NETWORK', `Muse request failed: ${e.message || 'network error'}`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw fail('MUSE_BAD_RESPONSE', `Muse returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const providerMsg =
      data && data.error && data.error.message ? String(data.error.message).slice(0, 200) : `HTTP ${res.status}`;
    throw fail('MUSE_REQUEST_FAILED', `Muse request failed: ${providerMsg}`);
  }
  return data;
}

/**
 * Run the Muse tool loop for one design job.
 * @returns {{ ok, delivered, steps, toolCalls, error?, costUsd, model }}
 */

module.exports = {
  resolveMuseConfig,
  museConfigured,
  fail,
  getDbSetting,
  todaySpendUsd,
  providerForConfig,
  logUsage,
  mcpToolsToOpenAi,
  chatCompletions,
};
