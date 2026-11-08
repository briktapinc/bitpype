'use strict';
/**
 * Batch 123 — OPENROUTER AS A THIRD ROUTED AI PROVIDER (Ely's order
 * 2026-11-03: "Add OpenRouter as an api option to openai and muse").
 *
 * Batch 120 built per-function provider routing (Meta Muse / OpenAI)
 * with automatic failover. This batch adds OpenRouter
 * (https://openrouter.ai/api/v1, OpenAI-compatible) as a third
 * selectable provider profile — openrouter.api_key /
 * openrouter.base_url / openrouter.model — valid as primary AND
 * fallback on every routed function, with the same failover /
 * cooldown / ai_usage attribution semantics. Route defaults are
 * unchanged; until an admin pastes a key the profile is simply
 * "not configured" and behaves like any other keyless profile.
 * Image generation + photo enhancement stay single-provider.
 *
 * What is pinned here:
 *   Part 1 — registry + settings pins: PROVIDERS gains exactly
 *     'openrouter'; shipped route defaults untouched; the
 *     openrouter trio exists as platform defs (secret key, keys
 *     group) + PLATFORM_SECRET_KEYS + SECRET_KEYS + SETTABLE_KEYS +
 *     WORKSPACE_SEED_KEYS (mirroring the muse.model_* treatment);
 *     ai_usage attribution maps openrouter.ai → 'openrouter';
 *     both stacks + the admin panel carry the third provider.
 *   Part 2 — resolver + validation (in-process): openrouter routes
 *     resolve (primary, fallback, self-fallback normalization), the
 *     settings choke points accept openrouter and reject junk, the
 *     matrix payload validator accepts/rejects correctly,
 *     adminState reports the profile (configured / not, host,
 *     default model) without ever exposing key material,
 *     orderAttempts + cooldown semantics for the new provider.
 *   Part 3 — agent-stack transport (stubbed fetch): failover TO
 *     openrouter (403 → rescue, exact namespaced model slug on the
 *     wire, ai_usage provider 'openrouter' + failover note),
 *     openrouter as primary (profile default model, then a stored
 *     profile model), failover FROM openrouter (429 → muse rescue,
 *     ~2 min openrouter cooldown), 400 surfaces with no failover,
 *     and the unconfigured-openrouter behaviors (skipped when a
 *     configured primary exists; straight-to-fallback with the
 *     not-configured note when it is the primary; not-configured
 *     when it is the only slot).
 *   Part 4 — task stack (src/ai.js, stubbed fetch): default rows
 *     unchanged, failover openai→openrouter on 500 with attribution
 *     + note + fallback model override on the wire, openrouter
 *     primary serving with ITS profile model (legacy ai.model.*
 *     never leaks onto its wire), vision routing to openrouter,
 *     unconfigured fallback never silently serves, and
 *     AI_NOT_CONFIGURED when nothing has a key.
 *   Part 5 — HTTP over the real server: super-admin GET state
 *     (openrouter profile present, seeded key strings never appear
 *     in ANY response), the generic settings GET redacts the key
 *     and lists its def as secret, PUT /settings/secret accepts the
 *     key (Ely's paste path), the matrix PUT round-trips an
 *     openrouter fallback through the resolver, invalid matrix PUTs
 *     are 400s, unauthenticated requests are refused.
 *   Part 6 — browser: the matrix renders in Admin → Settings → API
 *     keys at 1440/980/390 with OpenRouter in every provider select
 *     and the profile line, the keys form renders the openrouter
 *     trio fields, and a save round-trip posts fallback=openrouter.
 *
 * B123_SKIP_HTTP=1 / B123_SKIP_BROWSER=1 skip Parts 5/6 locally;
 * the gate runs everything.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b123-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch123', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');
process.env.BOOTSTRAP_EMAIL = 'owner-b123@example.invalid';
process.env['BOOTSTRAP_' + 'PASSWORD'] = ['batch123', 'test', 'bootstrap', 'pw'].join('-');
process.env.BOOTSTRAP_WORKSPACE = 'B123 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';

const PORT = 31493;
const BASE = `http://127.0.0.1:${PORT}`;

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
      if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
      const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
      const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const c of set) {
        const pair = String(c).split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return res;
    },
  };
}
async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const MUSE_KEY = 'b123-muse-key-SECRET';
const OPENAI_KEY = 'b123-openai-key-SECRET';
const OPENROUTER_KEY = 'b123-openrouter-key-SECRET';
const OPENROUTER_KEY_2 = 'b123-openrouter-key-SECOND';

(async () => {
  /* ================================================================== */
  /* Part 1 — registry + settings pins                                   */
  /* ================================================================== */
  {
    let n = 0;
    const aiRouting = require(path.join(root, 'server/aiRouting.js'));
    assert.deepEqual(
      Object.keys(aiRouting.PROVIDERS),
      ['muse', 'openai', 'openrouter'],
      'PROVIDERS is exactly muse + openai + openrouter'
    );
    assert.equal(aiRouting.PROVIDERS.openrouter.label, 'OpenRouter', 'openrouter label');
    n++;
    // Shipped defaults are Batch 120's — OpenRouter is an added
    // option, never a new default.
    for (const fn of aiRouting.ROUTABLE_FUNCTIONS.slice(0, 4)) {
      assert.equal(fn.defaultPrimary, 'muse', `${fn.key} still defaults to muse primary`);
      assert.equal(fn.defaultFallback, 'openai', `${fn.key} still defaults to openai fallback`);
      n++;
    }
    for (const fn of aiRouting.ROUTABLE_FUNCTIONS.slice(4)) {
      assert.equal(fn.defaultPrimary, 'openai', `${fn.key} still defaults to openai primary`);
      assert.equal(fn.defaultFallback, 'none', `${fn.key} still defaults to no fallback`);
      n++;
    }
    assert.deepEqual(
      aiRouting.INFO_FUNCTIONS.map((f) => [f.key, f.provider]),
      [
        ['image_generation', 'openai'],
        ['photo_enhancement', 'fal'],
      ],
      'informational rows unchanged (images are NOT routed through OpenRouter)'
    );
    n++;

    const platform = require(path.join(root, 'server/platform.js'));
    const defOf = (k) => platform.PLATFORM_SETTING_DEFS.find((d) => d.key === k);
    const orKey = defOf('openrouter.api_key');
    assert.ok(
      orKey && orKey.secret === true && orKey.group === 'keys' && orKey.default === '',
      'openrouter.api_key def (secret, keys group)'
    );
    const orBase = defOf('openrouter.base_url');
    assert.ok(
      orBase && orBase.group === 'keys' && orBase.default === 'https://openrouter.ai/api/v1',
      'openrouter.base_url def + default'
    );
    const orModel = defOf('openrouter.model');
    assert.ok(
      orModel && orModel.group === 'keys' && orModel.default === 'openai/gpt-4o-mini',
      'openrouter.model def + default slug'
    );
    n++;
    assert.ok(
      platform.PLATFORM_SECRET_KEYS.includes('openrouter.api_key'),
      'openrouter.api_key is a platform secret (encrypted at rest)'
    );
    assert.ok(
      platform.WORKSPACE_SEED_KEYS.includes('openrouter.api_key') &&
        platform.WORKSPACE_SEED_KEYS.includes('openrouter.base_url') &&
        platform.WORKSPACE_SEED_KEYS.includes('openrouter.model'),
      'openrouter trio seeds into workspaces like muse.model_* (workspace fallback resolution)'
    );
    n++;
    const settingsKeys = require(path.join(root, 'server/settingsKeys.js'));
    assert.ok(
      settingsKeys.SECRET_KEYS.includes('openrouter.api_key'),
      'openrouter.api_key in SECRET_KEYS (masked/encrypted in workspace storage)'
    );
    assert.ok(
      ['openrouter.api_key', 'openrouter.base_url', 'openrouter.model'].every((k) =>
        settingsKeys.SETTABLE_KEYS.includes(k)
      ),
      'openrouter trio is settable through the validated path'
    );
    n++;

    // ai_usage attribution: the OpenRouter host maps to its own slug,
    // never folded into 'openai'.
    const aiProvider = require(path.join(root, 'src/aiProvider.js'));
    assert.equal(
      aiProvider.providerFromBaseUrl('https://openrouter.ai/api/v1'),
      'openrouter',
      'openrouter.ai attributes to openrouter'
    );
    assert.equal(aiProvider.providerFromBaseUrl('https://api.openai.com/v1'), 'openai', 'openai attribution unchanged');
    n++;

    // Both stacks + the admin surface carry the third provider.
    const core = read('server/museAgentCore.js');
    assert.ok(
      core.includes('resolveOpenRouterConfig') && core.includes("getPlatformSetting('openrouter.api_key'"),
      'agent core resolves the openrouter profile'
    );
    n++;
    const aiSrc = read('src/ai.js');
    assert.ok(
      aiSrc.includes('resolveOpenRouterProfile') && aiSrc.includes('openrouter: await resolveOpenRouterProfile(db)'),
      'task stack resolves the openrouter profile'
    );
    n++;
    const appSrc = read('public/js/app.js');
    assert.ok(
      appSrc.includes('value="openrouter"') && appSrc.includes('OpenRouter'),
      'admin matrix offers OpenRouter in the selects'
    );
    assert.ok(appSrc.includes('state.profiles.openrouter'), 'admin matrix renders the OpenRouter profile line');
    n++;
    assert.ok(
      read('public/index.html').includes('/js/app.js?v=batch162-leadcalling1'),
      'app.js cache-bust bumped for batch123'
    );
    n++;
    group('Part 1 registry + settings pins', n);
  }

  /* ================================================================== */
  /* Part 2 — resolver + validation (in-process)                         */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const platform = require(path.join(root, 'server/platform.js'));
  const aiRouting = require(path.join(root, 'server/aiRouting.js'));
  const settingsKeys = require(path.join(root, 'server/settingsKeys.js'));
  {
    let n = 0;
    // Defaults still resolve exactly as Batch 120 shipped them.
    assert.deepEqual(await aiRouting.getRoute('design_chat'), {
      primary: 'muse',
      fallback: 'openai',
      modelPrimary: '',
      modelFallback: '',
    });
    assert.deepEqual(await aiRouting.getRoute('qa'), {
      primary: 'openai',
      fallback: 'none',
      modelPrimary: '',
      modelFallback: '',
    });
    n++;
    // openrouter resolves in both slots.
    await platform.setPlatformSetting('ai.route.design_chat.fallback', 'openrouter');
    assert.equal((await aiRouting.getRoute('design_chat')).fallback, 'openrouter', 'openrouter fallback resolves');
    await platform.setPlatformSetting('ai.route.qa.primary', 'openrouter');
    await platform.setPlatformSetting('ai.route.qa.fallback', 'openai');
    assert.deepEqual(
      await aiRouting.getRoute('qa'),
      { primary: 'openrouter', fallback: 'openai', modelPrimary: '', modelFallback: '' },
      'openrouter primary resolves'
    );
    n++;
    // fallback == primary (openrouter) normalizes to 'none' at read.
    await platform.setPlatformSetting('ai.route.qa.fallback', 'openrouter');
    assert.equal((await aiRouting.getRoute('qa')).fallback, 'none', 'openrouter self-fallback normalized to none');
    await platform.setPlatformSetting('ai.route.qa.primary', 'openai');
    await platform.setPlatformSetting('ai.route.qa.fallback', 'none');
    await platform.setPlatformSetting('ai.route.design_chat.fallback', 'openai');
    n++;
    // The platform choke point accepts openrouter, rejects junk.
    await platform.setPlatformSetting('ai.route.editor.primary', 'openrouter');
    assert.equal((await aiRouting.getRoute('editor')).primary, 'openrouter');
    await platform.setPlatformSetting('ai.route.editor.primary', 'openai');
    for (const [key, value] of [
      ['ai.route.qa.primary', 'fal'],
      ['ai.route.qa.fallback', 'bogus'],
    ]) {
      await assert.rejects(
        () => platform.setPlatformSetting(key, value),
        (e) => e.code === 'VALIDATION',
        `${key} rejects ${value}`
      );
      n++;
    }
    n++;
    // The settings validator mirrors it, and validates the trio.
    assert.equal(
      settingsKeys.validateSetting('ai.route.qa.primary', 'openrouter').ok,
      true,
      'validator accepts openrouter primary'
    );
    assert.equal(
      settingsKeys.validateSetting('ai.route.qa.fallback', 'openrouter').ok,
      true,
      'validator accepts openrouter fallback'
    );
    assert.equal(
      settingsKeys.validateSetting('openrouter.api_key', 'sk-or-fixture').ok,
      true,
      'openrouter key validates'
    );
    assert.equal(
      settingsKeys.validateSetting('openrouter.api_key', 'x'.repeat(501)).ok,
      false,
      'openrouter key length capped like the other keys'
    );
    assert.equal(
      settingsKeys.validateSetting('openrouter.base_url', 'https://openrouter.ai/api/v1').ok,
      true,
      'openrouter base URL validates'
    );
    assert.equal(
      settingsKeys.validateSetting('openrouter.base_url', 'not a url').ok,
      false,
      'openrouter base URL must be a URL'
    );
    assert.equal(
      settingsKeys.validateSetting('openrouter.model', 'openai/gpt-4o-mini').ok,
      true,
      'openrouter model validates'
    );
    assert.equal(settingsKeys.validateSetting('openrouter.model', '').ok, false, 'openrouter model may not be empty');
    n++;
    // Matrix payload validator: openrouter in, self-failover out.
    const entries = aiRouting.validateRoutesPayload({
      design_chat: {
        primary: 'openrouter',
        fallback: 'muse',
        modelPrimary: 'anthropic/claude-sonnet-4',
        modelFallback: '',
      },
    });
    assert.equal(entries['ai.route.design_chat.primary'], 'openrouter');
    assert.equal(
      entries['ai.route.design_chat.model_primary'],
      'anthropic/claude-sonnet-4',
      'namespaced model slug passes validation'
    );
    for (const bad of [
      { design_chat: { primary: 'openrouter', fallback: 'openrouter' } },
      { design_chat: { primary: 'fal', fallback: 'none' } },
      { design_chat: { primary: 'muse', fallback: 'bogus' } },
    ]) {
      assert.throws(
        () => aiRouting.validateRoutesPayload(bad),
        (e) => e.code === 'VALIDATION',
        'validator rejects hostile payload'
      );
      n++;
    }
    n++;
    // adminState: the profile reports status only — never key material.
    let state = await aiRouting.adminState();
    assert.deepEqual(
      Object.keys(state.profiles),
      ['muse', 'openai', 'openrouter', 'fal'],
      'matrix profiles include openrouter'
    );
    assert.equal(state.profiles.openrouter.configured, false, 'no key yet = not configured');
    assert.equal(state.profiles.openrouter.baseHost, 'openrouter.ai', 'openrouter host shown');
    assert.equal(state.profiles.openrouter.defaultModel, 'openai/gpt-4o-mini', 'openrouter default model shown');
    n++;
    await platform.setPlatformSetting('openrouter.api_key', OPENROUTER_KEY);
    state = await aiRouting.adminState();
    assert.equal(state.profiles.openrouter.configured, true, 'pasted key = configured');
    assert.ok(!JSON.stringify(state).includes(OPENROUTER_KEY), 'admin state never contains the key');
    n++;
    // orderAttempts + cooldowns are provider-agnostic.
    const route = { primary: 'openrouter', fallback: 'muse', modelPrimary: '', modelFallback: '' };
    let attempts = aiRouting.orderAttempts('qa', route, { muse: true, openai: true, openrouter: false });
    assert.equal(attempts.length, 1, 'unconfigured primary yields the single fallback attempt');
    assert.equal(attempts[0].provider, 'muse');
    assert.match(attempts[0].failoverNote || '', /primary openrouter not configured/, 'not-configured skip is noted');
    attempts = aiRouting.orderAttempts(
      'qa',
      { ...route, fallback: 'none' },
      { muse: false, openai: false, openrouter: false }
    );
    assert.deepEqual(
      attempts.map((a) => a.provider),
      ['openrouter'],
      'no usable fallback = try the primary anyway (errors as an unconfigured provider does today)'
    );
    n++;
    aiRouting._resetRoutingState();
    aiRouting.noteProviderFailure(
      'qa',
      'openrouter',
      aiRouting.classifyError(Object.assign(new Error('x'), { status: 429 }))
    );
    const cd = aiRouting.isCoolingDown('qa', 'openrouter');
    assert.ok(
      cd && cd.until - Date.now() > 60 * 1000 && cd.until - Date.now() < 3 * 60 * 1000,
      'openrouter 429 arms its own ~2 min cooldown'
    );
    const status = aiRouting.routingStatus();
    assert.ok(
      status.byFunction.qa.cooldowns.some((c) => c.provider === 'openrouter'),
      'openrouter cooldown is visible in routing status'
    );
    attempts = aiRouting.orderAttempts('qa', route, { muse: true, openai: true, openrouter: true });
    assert.deepEqual(
      attempts.map((a) => a.provider),
      ['muse'],
      'cooling-down openrouter primary is skipped to the fallback'
    );
    assert.match(attempts[0].failoverNote || '', /cooling down/, 'cooldown skip is noted');
    aiRouting._resetRoutingState();
    n++;
    group('Part 2 resolver + validation', n);
  }

  /* ================================================================== */
  /* Part 3 — agent-stack transport (stubbed fetch)                      */
  /* ================================================================== */
  {
    let n = 0;
    await platform.setPlatformSetting('muse.model_api_key', MUSE_KEY);
    await platform.setPlatformSetting('ai.api_key', OPENAI_KEY);
    // openrouter.api_key was set in Part 2.
    const setRoute = async (fnKey, primary, fallback, modelFallback = '') => {
      await platform.setPlatformSetting(`ai.route.${fnKey}.primary`, primary);
      await platform.setPlatformSetting(`ai.route.${fnKey}.fallback`, fallback);
      await platform.setPlatformSetting(`ai.route.${fnKey}.model_primary`, '');
      await platform.setPlatformSetting(`ai.route.${fnKey}.model_fallback`, modelFallback);
    };
    await setRoute('design_chat', 'muse', 'openai');
    await setRoute('wp_design_chat', 'muse', 'openai');
    await setRoute('hands_off', 'muse', 'openai');

    const core = require(path.join(root, 'server/museAgentCore.js'));
    const Database = require('better-sqlite3');
    const wsDb = new Database(':memory:');
    wsDb.exec(read('src/schema.sql'));

    const realFetch = global.fetch;
    const calls = [];
    let metaMode = { status: 200 };
    let orMode = { status: 200 };
    const okReply = (text) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: text } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    const errReply = (status, msg) =>
      new Response(JSON.stringify({ error: { message: msg } }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    global.fetch = async (url, opts) => {
      const u = String(url || '');
      const body = JSON.parse(String((opts && opts.body) || '{}'));
      const auth = (opts && opts.headers && opts.headers.Authorization) || '';
      if (u.startsWith('https://api.meta.ai/')) {
        calls.push({ host: 'meta', model: body.model, auth });
        return metaMode.status === 200 ? okReply('from muse') : errReply(metaMode.status, metaMode.msg || 'boom');
      }
      if (u.startsWith('https://api.openai.com/')) {
        calls.push({ host: 'openai', model: body.model, auth });
        return okReply('from openai');
      }
      if (u.startsWith('https://openrouter.ai/')) {
        calls.push({ host: 'openrouter', model: body.model, auth });
        return orMode.status === 200 ? okReply('from openrouter') : errReply(orMode.status, orMode.msg || 'boom');
      }
      return realFetch(url, opts);
    };
    const reset = () => {
      aiRouting._resetRoutingState();
      calls.length = 0;
      metaMode = { status: 200 };
      orMode = { status: 200 };
    };
    const lastUsage = () => wsDb.prepare('SELECT provider, model, note FROM ai_usage ORDER BY id DESC LIMIT 1').get();
    try {
      // -- Failover TO openrouter: muse billing-blocked, openrouter
      // rescues with the exact per-slot model slug on the wire.
      reset();
      metaMode = { status: 403, msg: 'Billing verification failed' };
      await setRoute('design_chat', 'muse', 'openrouter', 'anthropic/claude-sonnet-4');
      let ctx = await core.resolveAgentConfig(null, 'design_chat');
      assert.equal(ctx.provider, 'muse');
      assert.ok(ctx.fallback && ctx.fallback.provider === 'openrouter', 'design_chat fallback resolves to openrouter');
      const data = await core.chatCompletionsRouted(ctx, {
        model: ctx.model,
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(data.choices[0].message.content, 'from openrouter', 'openrouter response returned');
      assert.deepEqual(
        calls.map((c) => c.host),
        ['meta', 'openrouter'],
        'primary tried once, openrouter fallback tried once'
      );
      assert.equal(calls[1].model, 'anthropic/claude-sonnet-4', 'the exact OpenRouter model slug rides the wire');
      assert.equal(calls[1].auth, `Bearer ${OPENROUTER_KEY}`, 'the openrouter key rides its own request');
      assert.equal(core.servedProviderFor(ctx), 'openrouter', 'served provider is openrouter (not folded into openai)');
      assert.match(
        core.withFailoverNote(ctx, 'step'),
        /failover muse→openrouter \(HTTP 403\)/,
        'failover note names openrouter'
      );
      n++;
      core.logUsage(wsDb, {
        task: 'portal_agent',
        provider: core.servedProviderFor(ctx),
        model: core.servedModelFor(ctx),
        promptTokens: 11,
        completionTokens: 7,
        costUsd: 0,
        leadId: null,
        note: core.withFailoverNote(ctx, 'portal muse step 1'),
      });
      assert.equal(lastUsage().provider, 'openrouter', 'ai_usage attributes the rescue to openrouter');
      assert.match(lastUsage().note, /failover muse→openrouter \(HTTP 403\)/, 'ai_usage note carries the failover');
      await setRoute('design_chat', 'muse', 'openai');
      n++;

      // -- OpenRouter as primary: profile default model, then the
      // stored profile model.
      reset();
      await setRoute('wp_design_chat', 'openrouter', 'none');
      ctx = await core.resolveAgentConfig(null, 'wp_design_chat');
      assert.equal(ctx.provider, 'openrouter', 'wp_design_chat primary is openrouter');
      assert.equal(ctx.model, 'openai/gpt-4o-mini', 'primary model is the OpenRouter profile default');
      assert.equal(ctx.fallback, null, 'no fallback configured');
      await core.chatCompletionsRouted(ctx, { model: ctx.model, messages: [{ role: 'user', content: 'wp' }] });
      assert.deepEqual(
        calls.map((c) => c.host),
        ['openrouter'],
        'single openrouter call'
      );
      assert.equal(core.servedProviderFor(ctx), 'openrouter');
      assert.equal(ctx.failoverNote, null, 'no failover on the clean primary path');
      n++;
      await platform.setPlatformSetting('openrouter.model', 'meta-llama/llama-3.3-70b-instruct');
      ctx = await core.resolveAgentConfig(null, 'wp_design_chat');
      assert.equal(ctx.model, 'meta-llama/llama-3.3-70b-instruct', 'stored openrouter.model is the profile default');
      await platform.setPlatformSetting('openrouter.model', 'openai/gpt-4o-mini');
      await setRoute('wp_design_chat', 'muse', 'openai');
      n++;

      // -- Failover FROM openrouter: 429 on openrouter → muse rescues,
      // openrouter cools down for ~2 minutes.
      reset();
      orMode = { status: 429, msg: 'rate limited' };
      await setRoute('hands_off', 'openrouter', 'muse');
      ctx = await core.resolveAgentConfig(null, 'hands_off');
      await core.chatCompletionsRouted(ctx, { model: ctx.model, messages: [{ role: 'user', content: 'job' }] });
      assert.deepEqual(
        calls.map((c) => c.host),
        ['openrouter', 'meta'],
        'openrouter tried once, muse rescued'
      );
      assert.equal(core.servedProviderFor(ctx), 'muse');
      assert.match(
        ctx.failoverNote || '',
        /failover openrouter→muse \(HTTP 429\)/,
        'failover note reads openrouter→muse'
      );
      const cd = aiRouting.isCoolingDown('hands_off', 'openrouter');
      assert.ok(
        cd && cd.until - Date.now() > 60 * 1000 && cd.until - Date.now() < 3 * 60 * 1000,
        'openrouter 429 arms a ~2 min cooldown'
      );
      await setRoute('hands_off', 'muse', 'openai');
      n++;

      // -- 400 from openrouter surfaces; the fallback never runs.
      reset();
      orMode = { status: 400, msg: 'bad request: unknown field' };
      await setRoute('design_chat', 'openrouter', 'muse');
      ctx = await core.resolveAgentConfig(null, 'design_chat');
      await assert.rejects(
        () => core.chatCompletionsRouted(ctx, { model: ctx.model, messages: [{ role: 'user', content: 'hi' }] }),
        (e) => e.status === 400,
        '400 surfaces with its status'
      );
      assert.deepEqual(
        calls.map((c) => c.host),
        ['openrouter'],
        '400 never reaches the fallback'
      );
      assert.equal(aiRouting.isCoolingDown('design_chat', 'openrouter'), null, '400 arms no cooldown');
      await setRoute('design_chat', 'muse', 'openai');
      n++;

      // -- Unconfigured openrouter (no key pasted yet — the day-one
      // production state): never silently serves, never crashes.
      reset();
      await platform.setPlatformSetting('openrouter.api_key', '');
      metaMode = { status: 403, msg: 'Billing verification failed' };
      await setRoute('design_chat', 'muse', 'openrouter');
      ctx = await core.resolveAgentConfig(null, 'design_chat');
      await assert.rejects(
        () => core.chatCompletionsRouted(ctx, { model: ctx.model, messages: [{ role: 'user', content: 'hi' }] }),
        (e) => e.status === 403,
        'an unconfigured fallback cannot rescue — the primary error surfaces'
      );
      assert.deepEqual(
        calls.map((c) => c.host),
        ['meta'],
        'openrouter was never called without a key'
      );
      n++;
      await setRoute('hands_off', 'openrouter', 'muse');
      metaMode = { status: 200 };
      ctx = await core.resolveAgentConfig(null, 'hands_off');
      const rescued = await core.chatCompletionsRouted(ctx, {
        model: ctx.model,
        messages: [{ role: 'user', content: 'job' }],
      });
      assert.equal(
        rescued.choices[0].message.content,
        'from muse',
        'configured fallback serves when the primary is unconfigured'
      );
      assert.match(ctx.failoverNote || '', /primary openrouter not configured/, 'the skip is noted honestly');
      n++;
      await setRoute('wp_design_chat', 'openrouter', 'none');
      ctx = await core.resolveAgentConfig(null, 'wp_design_chat');
      assert.equal(core.museConfigured(ctx), false, 'openrouter as the only slot + no key = not configured');
      await setRoute('wp_design_chat', 'muse', 'openai');
      await setRoute('hands_off', 'muse', 'openai');
      await setRoute('design_chat', 'muse', 'openai');
      await platform.setPlatformSetting('openrouter.api_key', OPENROUTER_KEY);
      n++;
    } finally {
      global.fetch = realFetch;
      aiRouting._resetRoutingState();
    }
    group('Part 3 agent transport openrouter', n);
  }

  /* ================================================================== */
  /* Part 4 — task stack (src/ai.js, stubbed fetch)                      */
  /* ================================================================== */
  {
    let n = 0;
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec(read('src/schema.sql'));
    const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
    setSetting('ai.api_key', OPENAI_KEY);
    setSetting('cost.daily_budget_usd', '0');
    const urlSafety = require(path.join(root, 'server/urlSafety.js'));
    const origAssert = urlSafety.assertAiBaseUrl;
    urlSafety.assertAiBaseUrl = async () => {};
    const ai = require(path.join(root, 'src/ai.js'));

    const realFetch = global.fetch;
    const calls = [];
    let openaiMode = { status: 200 };
    let orMode = { status: 200 };
    const reply = (text) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: text } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    const errReply = (status, msg) =>
      new Response(JSON.stringify({ error: { message: msg } }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    global.fetch = async (url, opts) => {
      const u = String(url || '');
      const body = JSON.parse(String((opts && opts.body) || '{}'));
      if (u.startsWith('https://api.openai.com/')) {
        calls.push({ host: 'openai', model: body.model });
        return openaiMode.status === 200 ? reply('from openai') : errReply(openaiMode.status, openaiMode.msg || 'boom');
      }
      if (u.startsWith('https://api.meta.ai/')) {
        calls.push({ host: 'meta', model: body.model });
        return reply('from muse');
      }
      if (u.startsWith('https://openrouter.ai/')) {
        calls.push({ host: 'openrouter', model: body.model });
        return orMode.status === 200 ? reply('from openrouter') : errReply(orMode.status, orMode.msg || 'boom');
      }
      return realFetch(url, opts);
    };
    const lastUsage = () =>
      db.prepare('SELECT task, provider, model, note FROM ai_usage ORDER BY id DESC LIMIT 1').get();
    const setRoute = async (fnKey, primary, fallback, modelFallback = '') => {
      await platform.setPlatformSetting(`ai.route.${fnKey}.primary`, primary);
      await platform.setPlatformSetting(`ai.route.${fnKey}.fallback`, fallback);
      await platform.setPlatformSetting(`ai.route.${fnKey}.model_primary`, '');
      await platform.setPlatformSetting(`ai.route.${fnKey}.model_fallback`, modelFallback);
    };
    const reset = async () => {
      aiRouting._resetRoutingState();
      calls.length = 0;
      openaiMode = { status: 200 };
      orMode = { status: 200 };
      await setRoute('qa', 'openai', 'none');
      await setRoute('scoring', 'openai', 'none');
      await setRoute('vision', 'openai', 'none');
    };
    try {
      // -- Default row unchanged: OpenAI serves, plain attribution.
      await reset();
      const out1 = await ai.chat({ task: 'qa', messages: [{ role: 'user', content: 'q' }], db });
      assert.equal(out1.text, 'from openai');
      assert.equal(lastUsage().provider, 'openai', 'default row still attributes to openai');
      n++;

      // -- Failover openai → openrouter on 500, override slug on the wire.
      await reset();
      await setRoute('qa', 'openai', 'openrouter', 'x-ai/grok-4-fast');
      openaiMode = { status: 500, msg: 'upstream' };
      const out2 = await ai.chat({ task: 'qa', messages: [{ role: 'user', content: 'q' }], db });
      assert.equal(out2.text, 'from openrouter', 'openrouter rescued the call');
      assert.deepEqual(
        calls.map((c) => c.host),
        ['openai', 'openrouter'],
        'one attempt per provider'
      );
      assert.equal(calls[1].model, 'x-ai/grok-4-fast', 'fallback model override rides the openrouter wire');
      assert.equal(lastUsage().provider, 'openrouter', 'ai_usage attributes to openrouter');
      assert.match(lastUsage().note || '', /failover openai→openrouter \(HTTP 500\)/, 'failover note recorded');
      n++;

      // -- OpenRouter primary: its OWN profile model serves — the
      // legacy per-task ai.model.* names never leak onto its wire.
      await reset();
      setSetting('ai.model.default', 'gpt-4o');
      await platform.setPlatformSetting('openrouter.model', 'deepseek/deepseek-chat');
      await setRoute('scoring', 'openrouter', 'none');
      const out3 = await ai.chat({ task: 'scoring', messages: [{ role: 'user', content: 'score' }], db });
      assert.equal(out3.text, 'from openrouter');
      assert.equal(
        calls[0].model,
        'deepseek/deepseek-chat',
        'the OpenRouter profile model served, not the legacy default'
      );
      assert.equal(lastUsage().provider, 'openrouter');
      await platform.setPlatformSetting('openrouter.model', 'openai/gpt-4o-mini');
      setSetting('ai.model.default', 'gpt-4o-mini');
      n++;

      // -- Vision: image-bearing calls route as 'vision' and can
      // land on openrouter.
      await reset();
      await setRoute('vision', 'openrouter', 'none');
      const out4 = await ai.chat({
        task: 'qa',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
            ],
          },
        ],
        db,
      });
      assert.equal(out4.text, 'from openrouter', 'vision row routed the image call to openrouter');
      assert.equal(lastUsage().task, 'qa', 'usage still logs the caller task');
      assert.equal(lastUsage().provider, 'openrouter');
      n++;

      // -- Unconfigured openrouter fallback never silently serves:
      // the primary's provider-side error surfaces instead.
      await reset();
      await platform.setPlatformSetting('openrouter.api_key', '');
      await setRoute('qa', 'openai', 'openrouter');
      openaiMode = { status: 500, msg: 'upstream' };
      await assert.rejects(
        () => ai.chat({ task: 'qa', messages: [{ role: 'user', content: 'q' }], db }),
        (e) => e.code === 'AI_REQUEST_FAILED' && e.status === 500,
        'primary error surfaces when the fallback has no key'
      );
      assert.deepEqual(
        calls.map((c) => c.host),
        ['openai'],
        'openrouter never called without a key'
      );
      await platform.setPlatformSetting('openrouter.api_key', OPENROUTER_KEY);
      n++;

      // -- Nothing configured anywhere → AI_NOT_CONFIGURED.
      await reset();
      setSetting('ai.api_key', '');
      await platform.setPlatformSetting('muse.model_api_key', '');
      await platform.setPlatformSetting('openrouter.api_key', '');
      await assert.rejects(
        () => ai.chat({ task: 'qa', messages: [{ role: 'user', content: 'q' }], db }),
        (e) => e.code === 'AI_NOT_CONFIGURED',
        'no key on any of the three profiles = AI_NOT_CONFIGURED'
      );
      setSetting('ai.api_key', OPENAI_KEY);
      await platform.setPlatformSetting('muse.model_api_key', MUSE_KEY);
      await platform.setPlatformSetting('openrouter.api_key', OPENROUTER_KEY);
      n++;
    } finally {
      global.fetch = realFetch;
      urlSafety.assertAiBaseUrl = origAssert;
      aiRouting._resetRoutingState();
      await reset();
    }
    group('Part 4 task stack openrouter', n);
  }

  /* ================================================================== */
  /* Part 5 — HTTP over the real server                                  */
  /* ================================================================== */
  if (process.env.B123_SKIP_HTTP === '1') {
    console.log('  skip Part 5 HTTP (B123_SKIP_HTTP=1 — local iteration only)');
  } else {
    let n = 0;
    const child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (b) => (output += b));
    child.stderr.on('data', (b) => (output += b));
    const closed = new Promise((resolve) => child.once('close', resolve));
    try {
      let ready = false;
      for (let i = 0; i < 300 && !ready; i++) {
        if (child.exitCode != null) throw new Error('server exited early: ' + output);
        try {
          const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
          if (r.ok) ready = true;
        } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(ready, 'server became ready');
      n++;

      // Unauthenticated access is refused.
      let res = await fetch(`${BASE}/api/v1/admin/settings/ai-routing`);
      assert.ok([401, 403].includes(res.status), 'GET ai-routing requires auth: ' + res.status);
      n++;

      // Bootstrap super-admin session (login → MFA enroll → confirm).
      const jar = makeJar();
      const post = (p, body) =>
        jar.fetch(BASE + p, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
      const totp = require(path.join(root, 'src/totp.js'));
      res = await post('/api/v1/auth/login', {
        email: process.env.BOOTSTRAP_EMAIL,
        password: process.env['BOOTSTRAP_' + 'PASSWORD'],
      });
      let body = await json(res);
      assert.equal(res.status, 200, 'bootstrap login 200');
      assert.ok(body.data && body.data.mfaRequired === true, 'login parks at MFA');
      res = await post('/api/v1/auth/mfa/enroll/start', {});
      body = await json(res);
      assert.ok(body.data && body.data.secret, 'enroll secret issued');
      res = await post('/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(body.data.secret) });
      body = await json(res);
      assert.equal(res.status, 200, 'MFA confirm 200');
      assert.ok(body.data && body.data.user, 'super-admin session issued');
      n++;

      // GET routing state: the openrouter profile is present and
      // configured (key seeded in-process, same platform DB file) —
      // and NO key material appears anywhere in the response.
      res = await jar.fetch(`${BASE}/api/v1/admin/settings/ai-routing`);
      const raw = await res.text();
      assert.equal(res.status, 200, 'GET ai-routing 200');
      for (const k of [MUSE_KEY, OPENAI_KEY, OPENROUTER_KEY]) {
        assert.ok(!raw.includes(k), 'no key material in the routing state response');
      }
      n++;
      const state = JSON.parse(raw).data;
      assert.equal(state.functions.length, 13, '11 routable rows (Batch 161 assistant_chat) + 2 informational rows');
      assert.equal(state.profiles.openrouter.configured, true, 'openrouter profile reports configured');
      assert.equal(state.profiles.openrouter.baseHost, 'openrouter.ai', 'openrouter host shown');
      assert.equal(state.profiles.openrouter.defaultModel, 'openai/gpt-4o-mini', 'openrouter default model shown');
      n++;

      // The generic settings surface: the trio's defs are listed, the
      // key's value is redacted, the non-secret fields show.
      res = await jar.fetch(`${BASE}/api/v1/admin/settings`);
      const rawSettings = await res.text();
      assert.equal(res.status, 200, 'GET admin settings 200');
      for (const k of [MUSE_KEY, OPENAI_KEY, OPENROUTER_KEY]) {
        assert.ok(!rawSettings.includes(k), 'no key material in the settings response');
      }
      const settingsBody = JSON.parse(rawSettings).data;
      const orDef = settingsBody.defs.find((d) => d.key === 'openrouter.api_key');
      assert.ok(orDef && orDef.secret === true, 'openrouter.api_key def is listed as secret');
      assert.equal(settingsBody.settings['openrouter.api_key'], '***', 'openrouter key value is masked on read');
      assert.equal(
        settingsBody.settings['openrouter.base_url'],
        'https://openrouter.ai/api/v1',
        'openrouter base URL shows its default'
      );
      n++;

      // Ely's paste path: PUT /settings/secret accepts the key, and
      // the new value still never renders anywhere.
      res = await jar.fetch(`${BASE}/api/v1/admin/settings/secret`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'openrouter.api_key', value: OPENROUTER_KEY_2 }),
      });
      body = await json(res);
      assert.equal(res.status, 200, 'PUT settings/secret 200: ' + JSON.stringify(body).slice(0, 160));
      assert.equal(body.data.set, true, 'secret save acknowledged');
      res = await jar.fetch(`${BASE}/api/v1/admin/settings/ai-routing`);
      const raw2 = await res.text();
      assert.ok(!raw2.includes(OPENROUTER_KEY_2), 'rotated key never renders either');
      assert.equal(
        JSON.parse(raw2).data.profiles.openrouter.configured,
        true,
        'profile still configured after the paste'
      );
      n++;

      // Matrix PUT round-trip: an openrouter fallback persists
      // through the resolver (same platform DB).
      res = await jar.fetch(`${BASE}/api/v1/admin/settings/ai-routing`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          routes: {
            scoring: { primary: 'openai', fallback: 'openrouter', modelPrimary: '', modelFallback: 'or-pinned-model' },
          },
        }),
      });
      body = await json(res);
      assert.equal(res.status, 200, 'PUT ai-routing 200: ' + JSON.stringify(body).slice(0, 200));
      assert.equal(body.data.updated, 4, 'one row = four settings written');
      const scoringRow = body.data.state.functions.find((f) => f.key === 'scoring');
      assert.equal(scoringRow.route.fallback, 'openrouter', 'PUT response state shows the openrouter fallback');
      assert.equal(scoringRow.route.modelFallback, 'or-pinned-model');
      assert.deepEqual(
        await aiRouting.getRoute('scoring'),
        { primary: 'openai', fallback: 'openrouter', modelPrimary: '', modelFallback: 'or-pinned-model' },
        'resolver sees the PUT (single source of truth)'
      );
      n++;
      res = await jar.fetch(`${BASE}/api/v1/admin/settings/ai-routing`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          routes: { scoring: { primary: 'openai', fallback: 'none', modelPrimary: '', modelFallback: '' } },
        }),
      });
      assert.equal(res.status, 200, 'restore PUT 200');
      n++;

      // Invalid PUTs are 400s and write nothing.
      for (const bad of [
        { scoring: { primary: 'openrouter', fallback: 'openrouter' } },
        { scoring: { primary: 'fal', fallback: 'none' } },
      ]) {
        res = await jar.fetch(`${BASE}/api/v1/admin/settings/ai-routing`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ routes: bad }),
        });
        assert.equal(res.status, 400, 'invalid matrix rejected: ' + JSON.stringify(bad).slice(0, 60));
        n++;
      }
      const after = await aiRouting.getRoute('scoring');
      assert.equal(after.fallback, 'none', 'rejected PUTs wrote nothing');
      n++;
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
    group('Part 5 HTTP admin endpoints', n);
  }

  /* ================================================================== */
  /* Part 6 — browser: the matrix in Admin → Settings → API keys         */
  /* ================================================================== */
  if (process.env.B123_SKIP_BROWSER === '1') {
    console.log('  skip Part 6 browser (B123_SKIP_BROWSER=1 — local iteration only)');
  } else {
    let n = 0;
    const puppeteer = require('puppeteer');
    const http = require('node:http');
    const express = require('express');
    const app = express();
    app.use(express.json());
    const ME = {
      ok: true,
      data: {
        user: { id: 1, email: 'fixture@example.invalid', isSuperAdmin: true },
        workspaceId: 1,
        workspaces: [{ id: 1, name: 'Fixture', role: 'owner' }],
        isSuperAdmin: true,
        productAccess: true,
      },
    };
    const stubState = () => ({
      profiles: {
        muse: { label: 'Meta Muse', configured: true, baseHost: 'api.meta.ai', defaultModel: 'muse-spark-1.3' },
        openai: { label: 'OpenAI', configured: true, baseHost: 'api.openai.com', defaultModel: 'gpt-4o-mini' },
        openrouter: {
          label: 'OpenRouter',
          configured: true,
          baseHost: 'openrouter.ai',
          defaultModel: 'openai/gpt-4o-mini',
        },
        fal: { label: 'fal.ai', configured: false, baseHost: 'fal.ai', defaultModel: '' },
      },
      functions: [
        ...aiRouting.ROUTABLE_FUNCTIONS.map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind,
          route: { primary: f.defaultPrimary, fallback: f.defaultFallback, modelPrimary: '', modelFallback: '' },
          cooldowns:
            f.key === 'hands_off'
              ? [{ provider: 'openrouter', until: Date.now() + 90 * 1000, reason: 'HTTP 429' }]
              : [],
          lastFailover:
            f.key === 'design_chat'
              ? { from: 'muse', to: 'openrouter', reason: 'HTTP 403', at: Date.now() - 5 * 60 * 1000 }
              : null,
        })),
        ...aiRouting.INFO_FUNCTIONS.map((f) => ({
          key: f.key,
          label: f.label,
          kind: 'info',
          fixedProvider: f.provider,
          note: f.note,
          cooldowns: [],
          lastFailover: null,
        })),
      ],
      lastFailover: {
        fnKey: 'design_chat',
        from: 'muse',
        to: 'openrouter',
        reason: 'HTTP 403',
        at: Date.now() - 5 * 60 * 1000,
      },
    });
    let savedRoutes = null;
    app.get('/api/v1/auth/me', (_q, r) => r.json(ME));
    app.get('/api/v1/captcha/config', (_q, r) => r.json({ ok: true, data: { enabled: false } }));
    app.get('/api/v1/admin/settings', (_q, r) =>
      r.json({
        ok: true,
        data: {
          settings: {},
          defs: [
            { key: 'ai.api_key', group: 'keys', label: 'OpenAI / AI API key', secret: true },
            { key: 'openrouter.api_key', group: 'keys', label: 'OpenRouter API key', secret: true },
            { key: 'openrouter.base_url', group: 'keys', label: 'OpenRouter API base URL' },
            { key: 'openrouter.model', group: 'keys', label: 'OpenRouter default model' },
          ],
        },
      })
    );
    app.get('/api/v1/admin/settings/ai-routing', (_q, r) => {
      const s = stubState();
      if (savedRoutes && savedRoutes.design_chat) {
        const row = s.functions.find((f) => f.key === 'design_chat');
        row.route = {
          primary: savedRoutes.design_chat.primary,
          fallback: savedRoutes.design_chat.fallback,
          modelPrimary: savedRoutes.design_chat.modelPrimary,
          modelFallback: savedRoutes.design_chat.modelFallback,
        };
      }
      r.json({ ok: true, data: s });
    });
    app.put('/api/v1/admin/settings/ai-routing', (req, res2) => {
      savedRoutes = req.body && req.body.routes;
      res2.json({ ok: true, data: { updated: 40, state: stubState() } });
    });
    app.use('/api/v1', (req, res2) => {
      if (req.method !== 'GET') return res2.status(500).json({ ok: false, error: 'No fixture writes allowed' });
      res2.json({ ok: true, data: {} });
    });
    app.get('/app', (_q, r) => r.sendFile(path.join(root, 'public', 'index.html')));
    app.use(express.static(path.join(root, 'public'), { index: false }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      for (const w of [1440, 980, 390]) {
        await page.setViewport({ width: w, height: 900 });
        await page.goto(base + '/app#/admin/keys', { waitUntil: 'domcontentloaded' });
        await page
          .waitForFunction(() => document.querySelector('[data-route-row="design_chat"]'), {
            timeout: 20000,
            polling: 100,
          })
          .catch(() => {
            throw new Error(`matrix did not render @${w}`);
          });
        const m = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('[data-route-row]')];
          const dc = document.querySelector('[data-route-row="design_chat"]');
          const sel = (row, f) => row.querySelector(`[data-route-field="${f}"]`);
          const fb = sel(dc, 'fallback');
          const pr = sel(dc, 'primary');
          const text = document.body.textContent || '';
          return {
            rowCount: rows.length,
            primaryHasOpenRouter: [...pr.options].some(
              (o) => o.value === 'openrouter' && o.textContent === 'OpenRouter'
            ),
            fallbackHasOpenRouter: [...fb.options].some(
              (o) => o.value === 'openrouter' && o.textContent === 'OpenRouter'
            ),
            hasProfileLine: text.includes('OpenRouter:') && text.includes('openrouter.ai'),
            hasFailoverText: text.includes('Last failover') && text.includes('OpenRouter'),
            hasCooldownText: text.includes('OpenRouter cooling down'),
            trioFields: ['openrouter.api_key', 'openrouter.base_url', 'openrouter.model'].filter((k) =>
              document.querySelector(`input[name="${k}"]`)
            ).length,
            hasSave: !!document.querySelector('#ai-routing-save'),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        assert.equal(m.rowCount, 10, `10 editable rows @${w}`);
        assert.ok(m.primaryHasOpenRouter, `primary select offers OpenRouter @${w}`);
        assert.ok(m.fallbackHasOpenRouter, `fallback select offers OpenRouter @${w}`);
        n++;
        assert.ok(m.hasProfileLine, `OpenRouter profile line renders @${w}`);
        assert.ok(m.hasFailoverText, `last-failover text names OpenRouter @${w}`);
        assert.ok(m.hasCooldownText, `OpenRouter cooldown status renders @${w}`);
        n++;
        assert.equal(m.trioFields, 3, `keys form renders the openrouter trio @${w}`);
        assert.ok(m.hasSave, `save button present @${w}`);
        n++;
        assert.ok(m.overflow <= 1, `no horizontal overflow @${w} (overflow=${m.overflow})`);
        n++;
      }
      // Save round-trip: set design_chat's fallback to OpenRouter and
      // check the payload the app posts.
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluate(() => {
        const row = document.querySelector('[data-route-row="design_chat"]');
        const sel = row.querySelector('[data-route-field="fallback"]');
        sel.value = 'openrouter';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#ai-routing-save').click();
      });
      await new Promise((r) => setTimeout(r, 1200));
      assert.ok(savedRoutes, 'save posted to the routing endpoint');
      assert.equal(savedRoutes.design_chat.fallback, 'openrouter', 'edited openrouter fallback posted');
      assert.equal(Object.keys(savedRoutes).length, 10, 'all 10 rows posted');
      n++;
    } finally {
      await browser.close();
      server.close();
    }
    group('Part 6 browser matrix render + save', n);
  }

  console.log(`BATCH123 SUITE: ALL PASS — ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH123 SUITE FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
