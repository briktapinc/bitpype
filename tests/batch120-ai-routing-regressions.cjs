'use strict';
/**
 * Batch 120 — AI PROVIDER ROUTING WITH AUTOMATIC FAILOVER (Ely's
 * order 2026-11-02: "build a proper provider option with automatic
 * failover" + "build it in a way i can select which api does what" —
 * per function, not one global switch).
 *
 * What is pinned here:
 *   Part 1 — registry + source pins: the routing registry (10
 *     routable functions + 2 informational single-provider rows), the
 *     40 ai.route.* platform settings defs, WORKSPACE_SEED_KEYS
 *     exclusion (routing is platform-level in v1), both stacks wired
 *     to the resolver, the admin matrix panel + endpoints present.
 *   Part 2 — resolver + validation (in-process): shipped defaults
 *     per function, stored overrides honored, fallback==primary
 *     normalized at read, the settings choke point rejects invalid
 *     route values, the matrix payload validator (fallback≠primary,
 *     unknown function, bad provider, model hygiene).
 *   Part 3 — agent-stack transport (stubbed fetch): failover on
 *     403-billing / 429 / 5xx / network-timeout, NO failover on 400,
 *     one fallback attempt, cooldown arming (10 min auth / 2 min
 *     rate / none for 5xx) + cooldown skip straight to the fallback,
 *     model overrides per slot, no double tool execution (the retry
 *     happens at the raw call, before any tool runs), ai_usage
 *     attribution + failover note via the served-provider helpers.
 *   Part 4 — task stack (src/ai.js, stubbed fetch): default rows
 *     preserve legacy behaviour, a routed fallback rescues a 500
 *     with provider attribution + failover note + fallback model
 *     override on the wire, 400 surfaces without failover, vision
 *     routing for image-bearing calls, email+followup share the
 *     email_drafting row, AI_NOT_CONFIGURED when no routed provider
 *     has a key.
 *   Part 5 — HTTP over the real server: super-admin GET state (12
 *     rows, profile status only — seeded key material never appears
 *     in any response), PUT round-trip persists through the resolver,
 *     invalid PUTs are 400s, unauthenticated + non-super-admin
 *     sessions are refused.
 *   Part 6 — browser: the matrix renders in Admin → Settings → API
 *     keys at 1440/980/390 (10 editable rows + 2 informational rows,
 *     cooldown + last-failover status text, no horizontal overflow)
 *     and a save round-trip posts the edited row.
 *
 * B120_SKIP_HTTP=1 / B120_SKIP_BROWSER=1 skip Parts 5/6 locally;
 * the gate runs everything.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b120-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch120', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');
process.env.BOOTSTRAP_EMAIL = 'owner-b120@example.invalid';
process.env.BOOTSTRAP_PASSWORD = ['Batch120', 'Bootstrap', 'Pass'].join('-') + '!';
process.env.BOOTSTRAP_WORKSPACE = 'B120 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';

const PORT = 31492;
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

const MUSE_KEY = 'b120-muse-key-SECRET';
const OPENAI_KEY = 'b120-openai-key-SECRET';

(async () => {
  /* ================================================================== */
  /* Part 1 — registry + source pins                                     */
  /* ================================================================== */
  {
    let n = 0;
    const aiRouting = require(path.join(root, 'server/aiRouting.js'));
    assert.equal(aiRouting.ROUTABLE_FUNCTIONS.length, 10, '10 routable functions');
    n++;
    assert.deepEqual(
      aiRouting.ROUTABLE_FUNCTIONS.map((f) => f.key),
      [
        'design_chat',
        'wp_design_chat',
        'hands_off',
        'research',
        'scoring',
        'generation',
        'qa',
        'editor',
        'email_drafting',
        'vision',
      ],
      'function rows in matrix order'
    );
    n++;
    for (const fn of aiRouting.ROUTABLE_FUNCTIONS.slice(0, 3)) {
      assert.equal(fn.defaultPrimary, 'muse', `${fn.key} defaults to Meta Muse primary`);
      assert.equal(fn.defaultFallback, 'openai', `${fn.key} defaults to OpenAI fallback (the failover Ely ordered)`);
      n++;
    }
    for (const fn of aiRouting.ROUTABLE_FUNCTIONS.slice(3)) {
      assert.equal(fn.defaultPrimary, 'openai', `${fn.key} defaults to OpenAI primary (legacy behaviour)`);
      assert.equal(fn.defaultFallback, 'none', `${fn.key} defaults to no fallback`);
      n++;
    }
    assert.deepEqual(
      aiRouting.INFO_FUNCTIONS.map((f) => [f.key, f.provider]),
      [
        ['image_generation', 'openai'],
        ['photo_enhancement', 'fal'],
      ],
      'informational rows: image generation OpenAI-only, photo enhancement fal-only'
    );
    n++;
    assert.deepEqual(
      aiRouting.TASK_TO_FUNCTION,
      {
        research: 'research',
        scoring: 'scoring',
        generation: 'generation',
        qa: 'qa',
        editor: 'editor',
        email: 'email_drafting',
        followup: 'email_drafting',
      },
      'task → function map (email + followup share the drafting row)'
    );
    n++;

    const platform = require(path.join(root, 'server/platform.js'));
    const routeDefs = platform.PLATFORM_SETTING_DEFS.filter((d) => d.key.startsWith('ai.route.'));
    assert.equal(routeDefs.length, 40, '40 ai.route.* setting defs (10 functions × 4)');
    n++;
    assert.ok(
      routeDefs.every((d) => d.group === 'ai_routing'),
      'route defs live in the ai_routing group (no generic tab)'
    );
    n++;
    assert.ok(
      platform.WORKSPACE_SEED_KEYS.every((k) => !k.startsWith('ai.route.')),
      'routing keys are never seeded into workspaces (platform-level v1)'
    );
    n++;

    // Both stacks + surfaces wired to the resolver.
    const core = read('server/museAgentCore.js');
    assert.ok(
      core.includes('chatCompletionsRouted') && core.includes('resolveAgentConfig'),
      'agent core carries the routed transport'
    );
    n++;
    const agentSrc = [
      'server/museAgent.js',
      'server/museAgentClassifier.js',
      'server/museAgentPlanner.js',
      'server/wpDesignChat.js',
      'server/handsOff.js',
    ]
      .map(read)
      .join('\n');
    assert.ok(
      !/[^a-zA-Z]chatCompletions\(/.test(agentSrc.replace(/chatCompletionsRouted/g, '')),
      'no unrouted chatCompletions call left in the agent stack'
    );
    n++;
    const aiSrc = read('src/ai.js');
    assert.ok(
      aiSrc.includes("require('../server/aiRouting')") && aiSrc.includes('TASK_TO_FUNCTION'),
      'task stack resolves through aiRouting'
    );
    n++;
    assert.ok(
      aiSrc.includes('providerFromBaseUrl(served.profile.baseUrl)'),
      'task stack attributes usage to the serving attempt'
    );
    n++;
    const adminSrc = read('server/routes/admin.js');
    assert.ok(
      adminSrc.includes("router.get('/settings/ai-routing'") && adminSrc.includes("router.put('/settings/ai-routing'"),
      'admin routing endpoints exist'
    );
    n++;
    const appSrc = read('public/js/app.js');
    assert.ok(
      appSrc.includes('aiRoutingPanelHtml') && appSrc.includes('data-route-row'),
      'admin matrix panel renders rows'
    );
    n++;
    const apiSrc = read('public/js/api.js');
    assert.ok(
      apiSrc.includes('adminAiRouting') && apiSrc.includes('adminAiRoutingSave'),
      'api client carries the routing calls'
    );
    n++;
    group('Part 1 registry + source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — resolver + validation (in-process)                         */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const platform = require(path.join(root, 'server/platform.js'));
  const aiRouting = require(path.join(root, 'server/aiRouting.js'));
  {
    let n = 0;
    // Shipped defaults resolve with nothing stored.
    for (const fn of aiRouting.ROUTABLE_FUNCTIONS) {
      const r = await aiRouting.getRoute(fn.key);
      assert.equal(r.primary, fn.defaultPrimary, `${fn.key} default primary`);
      assert.equal(r.fallback, fn.defaultFallback, `${fn.key} default fallback`);
      assert.equal(r.modelPrimary, '', `${fn.key} default primary model blank`);
      assert.equal(r.modelFallback, '', `${fn.key} default fallback model blank`);
      n++;
    }
    // Stored overrides are honored.
    await platform.setPlatformSetting('ai.route.qa.primary', 'openai');
    await platform.setPlatformSetting('ai.route.qa.fallback', 'muse');
    await platform.setPlatformSetting('ai.route.qa.model_fallback', 'muse-override-1');
    const qa = await aiRouting.getRoute('qa');
    assert.deepEqual(
      qa,
      { primary: 'openai', fallback: 'muse', modelPrimary: '', modelFallback: 'muse-override-1' },
      'stored qa route resolves'
    );
    n++;
    // fallback == primary stored directly (bypassing the matrix)
    // normalizes to 'none' at read — a route never fails over to
    // itself.
    await platform.setPlatformSetting('ai.route.editor.primary', 'muse');
    await platform.setPlatformSetting('ai.route.editor.fallback', 'muse');
    const ed = await aiRouting.getRoute('editor');
    assert.equal(ed.primary, 'muse');
    assert.equal(ed.fallback, 'none', 'self-fallback normalized to none');
    n++;
    await platform.setPlatformSetting('ai.route.editor.primary', 'openai');
    await platform.setPlatformSetting('ai.route.editor.fallback', 'none');

    // The settings choke point rejects invalid route values.
    for (const [key, value] of [
      ['ai.route.qa.primary', 'fal'],
      ['ai.route.qa.fallback', 'bogus'],
      ['ai.route.qa.model_primary', 'two\nlines'],
      ['ai.route.qa.model_fallback', 'x'.repeat(121)],
    ]) {
      await assert.rejects(
        () => platform.setPlatformSetting(key, value),
        (e) => e.code === 'VALIDATION',
        `${key} rejects ${JSON.stringify(value).slice(0, 24)}`
      );
      n++;
    }
    // Payload validator: the whole matrix, happy + hostile.
    const entries = aiRouting.validateRoutesPayload({
      design_chat: { primary: 'muse', fallback: 'openai', modelPrimary: '', modelFallback: 'gpt-x' },
    });
    assert.deepEqual(
      entries,
      {
        'ai.route.design_chat.primary': 'muse',
        'ai.route.design_chat.fallback': 'openai',
        'ai.route.design_chat.model_primary': '',
        'ai.route.design_chat.model_fallback': 'gpt-x',
      },
      'validator emits the four settings entries per row'
    );
    n++;
    for (const bad of [
      { design_chat: { primary: 'muse', fallback: 'muse' } },
      { nope: { primary: 'muse', fallback: 'none' } },
      { design_chat: { primary: 'fal', fallback: 'none' } },
      { design_chat: { primary: 'muse', fallback: 'openai', modelPrimary: 'a\nb' } },
    ]) {
      assert.throws(
        () => aiRouting.validateRoutesPayload(bad),
        (e) => e.code === 'VALIDATION',
        'validator rejects hostile payload'
      );
      n++;
    }
    // Error classifier: the failover contract in one place.
    const cls = (status) => aiRouting.classifyError(Object.assign(new Error('x'), status == null ? {} : { status }));
    assert.deepEqual(
      [cls(401).failover, cls(401).cooldownMs],
      [true, 10 * 60 * 1000],
      '401 fails over + 10 min cooldown'
    );
    n++;
    assert.deepEqual(
      [cls(403).failover, cls(403).cooldownMs],
      [true, 10 * 60 * 1000],
      '403 (billing) fails over + 10 min cooldown'
    );
    n++;
    assert.deepEqual(
      [cls(429).failover, cls(429).cooldownMs],
      [true, 2 * 60 * 1000],
      '429 fails over + 2 min cooldown'
    );
    n++;
    assert.deepEqual([cls(500).failover, cls(500).cooldownMs], [true, 0], '5xx fails over, no cooldown');
    n++;
    assert.equal(cls(400).failover, false, '400 never fails over');
    n++;
    assert.equal(cls(404).failover, false, '404 never fails over');
    n++;
    assert.deepEqual(
      [cls(null).failover, cls(null).reason],
      [true, 'network/timeout'],
      'no-status (network/timeout) fails over'
    );
    n++;
    group('Part 2 resolver + validation', n);
  }

  /* ================================================================== */
  /* Part 3 — agent-stack transport failover (stubbed fetch)             */
  /* ================================================================== */
  {
    let n = 0;
    await platform.setPlatformSetting('muse.model_api_key', MUSE_KEY);
    await platform.setPlatformSetting('ai.api_key', OPENAI_KEY);
    // Reset the qa/editor experiments from Part 2 to shipped defaults.
    await platform.setPlatformSetting('ai.route.qa.fallback', 'none');
    await platform.setPlatformSetting('ai.route.qa.model_fallback', '');

    const core = require(path.join(root, 'server/museAgentCore.js'));
    const Database = require('better-sqlite3');
    const wsDb = new Database(':memory:');
    wsDb.exec(read('src/schema.sql'));

    const realFetch = global.fetch;
    const calls = [];
    let metaMode = { status: 403, body: { error: { message: 'Billing verification failed' } } };
    const okBody = (withTools) => ({
      choices: [
        {
          message: withTools
            ? {
                content: '',
                tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'set_text_x', arguments: '{}' } }],
              }
            : { content: 'served' },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    });
    global.fetch = async (url, opts) => {
      const u = String(url || '');
      const body = JSON.parse(String((opts && opts.body) || '{}'));
      if (u.startsWith('https://api.meta.ai/')) {
        calls.push({ host: 'meta', model: body.model });
        if (metaMode.throw) throw new Error('socket hang up');
        return new Response(JSON.stringify(metaMode.body), {
          status: metaMode.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.startsWith('https://api.openai.com/')) {
        calls.push({ host: 'openai', model: body.model });
        return new Response(JSON.stringify(okBody(metaMode.withTools)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return realFetch(url, opts);
    };
    const reset = (mode) => {
      aiRouting._resetRoutingState();
      calls.length = 0;
      metaMode = mode;
    };
    try {
      // -- 403 billing block on the primary → one OpenAI attempt serves.
      reset({ status: 403, body: { error: { message: 'Billing verification failed' } } });
      let ctx = await core.resolveAgentConfig(null, 'design_chat');
      assert.equal(ctx.provider, 'muse', 'design_chat primary is muse by default');
      assert.ok(ctx.fallback && ctx.fallback.provider === 'openai', 'design_chat fallback is openai by default');
      n++;
      const data = await core.chatCompletionsRouted(ctx, {
        model: ctx.model,
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(data.choices[0].message.content, 'served', 'fallback response returned');
      assert.deepEqual(
        calls.map((c) => c.host),
        ['meta', 'openai'],
        'primary tried once, fallback tried once'
      );
      assert.equal(core.servedProviderFor(ctx), 'openai', 'served provider is openai');
      assert.equal(core.servedModelFor(ctx), 'gpt-4o-mini', 'served model is the OpenAI profile default');
      assert.match(
        core.withFailoverNote(ctx, 'portal muse step 1'),
        /failover muse→openai \(HTTP 403\)/,
        'failover note recorded'
      );
      n++;
      // ai_usage attribution through the real logging path.
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
      const usageRow = wsDb.prepare('SELECT provider, model, note FROM ai_usage ORDER BY id DESC LIMIT 1').get();
      assert.equal(usageRow.provider, 'openai', 'ai_usage attributes the rescue to openai');
      assert.match(usageRow.note, /failover muse→openai \(HTTP 403\)/, 'ai_usage note carries the failover');
      n++;
      // Cooldown armed for 10 minutes + status visible.
      const cd = aiRouting.isCoolingDown('design_chat', 'muse');
      assert.ok(cd && cd.until - Date.now() > 9 * 60 * 1000, 'auth failure arms a ~10 minute cooldown');
      const status = aiRouting.routingStatus();
      assert.equal(status.byFunction.design_chat.cooldowns.length, 1, 'cooldown visible in routing status');
      assert.equal(status.byFunction.design_chat.lastFailover.from, 'muse', 'last failover event recorded');
      n++;
      // While cooling down, the primary is NOT retried — straight to
      // the fallback, with the skip noted.
      calls.length = 0;
      ctx = await core.resolveAgentConfig(null, 'design_chat');
      await core.chatCompletionsRouted(ctx, { model: ctx.model, messages: [{ role: 'user', content: 'hi again' }] });
      assert.deepEqual(
        calls.map((c) => c.host),
        ['openai'],
        'cooling-down primary is skipped entirely'
      );
      assert.match(ctx.failoverNote || '', /cooling down/, 'cooldown skip is noted');
      n++;

      // -- 429 → failover + ~2 minute cooldown.
      reset({ status: 429, body: { error: { message: 'slow down' } } });
      ctx = await core.resolveAgentConfig(null, 'hands_off');
      await core.chatCompletionsRouted(ctx, { model: ctx.model, messages: [{ role: 'user', content: 'job' }] });
      assert.equal(core.servedProviderFor(ctx), 'openai');
      const cd429 = aiRouting.isCoolingDown('hands_off', 'muse');
      assert.ok(
        cd429 && cd429.until - Date.now() > 60 * 1000 && cd429.until - Date.now() < 3 * 60 * 1000,
        '429 arms a ~2 minute cooldown'
      );
      n++;

      // -- 5xx → failover, NO cooldown (transient).
      reset({ status: 503, body: { error: { message: 'upstream' } } });
      ctx = await core.resolveAgentConfig(null, 'wp_design_chat');
      await core.chatCompletionsRouted(ctx, { model: ctx.model, messages: [{ role: 'user', content: 'wp' }] });
      assert.equal(core.servedProviderFor(ctx), 'openai', '5xx fails over');
      assert.equal(aiRouting.isCoolingDown('wp_design_chat', 'muse'), null, '5xx arms no cooldown');
      n++;

      // -- network throw → failover as network/timeout.
      reset({ throw: true });
      ctx = await core.resolveAgentConfig(null, 'design_chat');
      await core.chatCompletionsRouted(ctx, { model: ctx.model, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(core.servedProviderFor(ctx), 'openai', 'network failure fails over');
      assert.match(ctx.failoverNote || '', /network\/timeout/, 'network failover reason noted');
      n++;

      // -- 400 → surfaces, fallback NEVER called, no cooldown.
      reset({ status: 400, body: { error: { message: 'bad request: unknown field' } } });
      ctx = await core.resolveAgentConfig(null, 'design_chat');
      await assert.rejects(
        () => core.chatCompletionsRouted(ctx, { model: ctx.model, messages: [{ role: 'user', content: 'hi' }] }),
        (e) => e.status === 400,
        '400 surfaces with its status'
      );
      assert.deepEqual(
        calls.map((c) => c.host),
        ['meta'],
        '400 never reaches the fallback'
      );
      assert.equal(aiRouting.isCoolingDown('design_chat', 'muse'), null, '400 arms no cooldown');
      n++;

      // -- No double tool execution: the failover happens at the raw
      // call, so a tool-bearing response arrives exactly once and the
      // loop's dispatch (one pass over the returned tool_calls) runs
      // each tool exactly once.
      reset({ status: 403, body: { error: { message: 'Billing verification failed' } }, withTools: true });
      ctx = await core.resolveAgentConfig(null, 'design_chat');
      const toolData = await core.chatCompletionsRouted(ctx, {
        model: ctx.model,
        messages: [{ role: 'user', content: 'change it' }],
      });
      const executed = [];
      for (const tc of toolData.choices[0].message.tool_calls || []) executed.push(tc.function.name);
      assert.deepEqual(executed, ['set_text_x'], 'tool calls from the single served response execute exactly once');
      assert.equal(calls.filter((c) => c.host === 'openai').length, 1, 'fallback produced exactly one response');
      n++;

      // -- Model overrides ride the route, per slot.
      reset({ status: 403, body: { error: { message: 'Billing verification failed' } } });
      await platform.setPlatformSetting('ai.route.hands_off.model_primary', 'muse-custom-p');
      await platform.setPlatformSetting('ai.route.hands_off.model_fallback', 'gpt-custom-f');
      ctx = await core.resolveAgentConfig(null, 'hands_off');
      assert.equal(ctx.model, 'muse-custom-p', 'primary model override resolves');
      assert.equal(ctx.fallback.model, 'gpt-custom-f', 'fallback model override resolves');
      await core.chatCompletionsRouted(ctx, { model: ctx.model, messages: [{ role: 'user', content: 'job' }] });
      assert.deepEqual(
        calls.map((c) => c.model),
        ['muse-custom-p', 'gpt-custom-f'],
        'wire models are the overrides'
      );
      await platform.setPlatformSetting('ai.route.hands_off.model_primary', '');
      await platform.setPlatformSetting('ai.route.hands_off.model_fallback', '');
      n++;

      // -- Neither profile configured → not configured (the graceful
      // pre-120 behaviour for the whole agent stack).
      aiRouting._resetRoutingState();
      await platform.setPlatformSetting('muse.model_api_key', '');
      await platform.setPlatformSetting('ai.api_key', '');
      ctx = await core.resolveAgentConfig(null, 'design_chat');
      assert.equal(core.museConfigured(ctx), false, 'no key on either profile = not configured');
      await platform.setPlatformSetting('ai.api_key', OPENAI_KEY);
      ctx = await core.resolveAgentConfig(null, 'design_chat');
      assert.equal(core.museConfigured(ctx), true, 'fallback-only key still counts as configured');
      await platform.setPlatformSetting('muse.model_api_key', MUSE_KEY);
      n++;
    } finally {
      global.fetch = realFetch;
      aiRouting._resetRoutingState();
    }
    group('Part 3 agent transport failover', n);
  }

  /* ================================================================== */
  /* Part 4 — task stack routing (src/ai.js, stubbed fetch)              */
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
    let metaMode = { status: 200 };
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
        return metaMode.status === 200 ? reply('from muse') : errReply(metaMode.status, metaMode.msg || 'boom');
      }
      return realFetch(url, opts);
    };
    const lastUsage = () =>
      db.prepare('SELECT task, provider, model, note FROM ai_usage ORDER BY id DESC LIMIT 1').get();
    const reset = async (route) => {
      aiRouting._resetRoutingState();
      calls.length = 0;
      openaiMode = { status: 200 };
      metaMode = { status: 200 };
      for (const fnKey of ['qa', 'vision', 'email_drafting']) {
        await platform.setPlatformSetting(
          `ai.route.${fnKey}.primary`,
          (route && route[fnKey] && route[fnKey].primary) || 'openai'
        );
        await platform.setPlatformSetting(
          `ai.route.${fnKey}.fallback`,
          (route && route[fnKey] && route[fnKey].fallback) || 'none'
        );
        await platform.setPlatformSetting(`ai.route.${fnKey}.model_primary`, '');
        await platform.setPlatformSetting(
          `ai.route.${fnKey}.model_fallback`,
          (route && route[fnKey] && route[fnKey].modelFallback) || ''
        );
      }
    };
    try {
      // -- Default row: legacy behaviour, OpenAI serves, plain note.
      await reset();
      const out1 = await ai.chat({
        task: 'qa',
        messages: [{ role: 'user', content: 'q' }],
        db,
        note: 'chatbot answer',
      });
      assert.equal(out1.text, 'from openai');
      assert.equal(out1.provider, 'openai');
      assert.deepEqual(
        calls.map((c) => c.host),
        ['openai'],
        'default row calls OpenAI only'
      );
      assert.equal(lastUsage().provider, 'openai');
      assert.equal(lastUsage().note, 'chatbot answer', 'no failover note on the plain path');
      n++;

      // -- OpenAI 500 with a muse fallback configured → rescued,
      // attributed, noted, fallback model override on the wire.
      await reset({ qa: { fallback: 'muse', modelFallback: 'muse-fb-1' } });
      openaiMode = { status: 500, msg: 'internal' };
      const out2 = await ai.chat({
        task: 'qa',
        messages: [{ role: 'user', content: 'q' }],
        db,
        note: 'chatbot answer',
      });
      assert.equal(out2.text, 'from muse', 'fallback served the answer');
      assert.equal(out2.provider, 'muse', 'return attributes the serving provider');
      assert.equal(out2.model, 'muse-fb-1', 'fallback model override served');
      assert.deepEqual(
        calls.map((c) => c.host),
        ['openai', 'meta'],
        'one attempt per provider'
      );
      assert.equal(calls[1].model, 'muse-fb-1', 'wire model on the fallback attempt is the override');
      const u2 = lastUsage();
      assert.equal(u2.provider, 'muse', 'ai_usage attributes the rescue to muse');
      assert.match(u2.note, /failover openai→muse \(HTTP 500\)/, 'ai_usage note carries the failover');
      n++;

      // -- 400 surfaces; the fallback is never called.
      await reset({ qa: { fallback: 'muse' } });
      openaiMode = { status: 400, msg: 'bad field' };
      await assert.rejects(
        () => ai.chat({ task: 'qa', messages: [{ role: 'user', content: 'q' }], db }),
        (e) => e.code === 'AI_REQUEST_FAILED' && e.status === 400,
        '400 surfaces as AI_REQUEST_FAILED with status'
      );
      assert.deepEqual(
        calls.map((c) => c.host),
        ['openai'],
        'no fallback attempt on a 400'
      );
      n++;

      // -- Image-bearing calls route as the vision function.
      await reset({ vision: { primary: 'muse' } });
      const out3 = await ai.chat({
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
      assert.equal(out3.text, 'from muse', 'vision row routed the image call to muse');
      assert.equal(lastUsage().task, 'qa', 'usage still logs the caller task');
      assert.equal(lastUsage().provider, 'muse');
      n++;

      // -- email + followup share the email_drafting row.
      await reset();
      await platform.setPlatformSetting('ai.route.email_drafting.primary', 'muse');
      const out4 = await ai.chat({ task: 'email', messages: [{ role: 'user', content: 'draft' }], db });
      const out5 = await ai.chat({ task: 'followup', messages: [{ role: 'user', content: 'draft 2' }], db });
      assert.equal(out4.provider, 'muse');
      assert.equal(out5.provider, 'muse', 'followup follows the drafting row too');
      await platform.setPlatformSetting('ai.route.email_drafting.primary', 'openai');
      n++;

      // -- No routed provider has a key → AI_NOT_CONFIGURED.
      await reset();
      setSetting('ai.api_key', '');
      await platform.setPlatformSetting('muse.model_api_key', '');
      await assert.rejects(
        () => ai.chat({ task: 'qa', messages: [{ role: 'user', content: 'q' }], db }),
        (e) => e.code === 'AI_NOT_CONFIGURED',
        'no key anywhere = AI_NOT_CONFIGURED'
      );
      setSetting('ai.api_key', OPENAI_KEY);
      await platform.setPlatformSetting('muse.model_api_key', MUSE_KEY);
      n++;
    } finally {
      global.fetch = realFetch;
      urlSafety.assertAiBaseUrl = origAssert;
      aiRouting._resetRoutingState();
      await reset();
    }
    group('Part 4 task stack routing', n);
  }

  /* ================================================================== */
  /* Part 5 — HTTP over the real server                                  */
  /* ================================================================== */
  if (process.env.B120_SKIP_HTTP === '1') {
    console.log('  skip Part 5 HTTP (B120_SKIP_HTTP=1 — local iteration only)');
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
      res = await fetch(`${BASE}/api/v1/admin/settings/ai-routing`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ routes: {} }),
      });
      assert.ok([401, 403].includes(res.status), 'PUT ai-routing requires auth: ' + res.status);
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
        password: process.env.BOOTSTRAP_PASSWORD,
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

      // GET state: 12 rows, shipped defaults, profile status only.
      res = await jar.fetch(`${BASE}/api/v1/admin/settings/ai-routing`);
      const raw = await res.text();
      assert.equal(res.status, 200, 'GET ai-routing 200');
      assert.ok(!raw.includes(MUSE_KEY) && !raw.includes(OPENAI_KEY), 'no key material in the state response');
      n++;
      const state = JSON.parse(raw).data;
      assert.equal(state.functions.length, 12, '10 routable rows + 2 informational rows');
      const byKey = Object.fromEntries(state.functions.map((f) => [f.key, f]));
      assert.equal(byKey.design_chat.route.primary, 'muse', 'design_chat primary muse');
      assert.equal(byKey.design_chat.route.fallback, 'openai', 'design_chat fallback openai');
      assert.equal(byKey.qa.route.primary, 'openai', 'qa primary openai');
      assert.equal(byKey.qa.route.fallback, 'none', 'qa fallback none');
      assert.equal(byKey.image_generation.kind, 'info', 'image generation is informational');
      assert.equal(byKey.image_generation.fixedProvider, 'openai');
      assert.equal(byKey.photo_enhancement.fixedProvider, 'fal');
      assert.equal(state.profiles.muse.configured, true, 'muse profile reports configured');
      assert.equal(state.profiles.muse.baseHost, 'api.meta.ai', 'muse profile host shown');
      assert.equal(state.profiles.openai.configured, true, 'openai profile reports configured');
      assert.equal(state.profiles.fal.configured, false, 'fal profile reports not configured');
      n++;

      // PUT round-trip: flip scoring to muse-primary and read it back
      // through both the endpoint and the in-process resolver (same
      // platform DB file).
      res = await jar.fetch(`${BASE}/api/v1/admin/settings/ai-routing`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          routes: { scoring: { primary: 'muse', fallback: 'openai', modelPrimary: 'muse-score-1', modelFallback: '' } },
        }),
      });
      body = await json(res);
      assert.equal(res.status, 200, 'PUT ai-routing 200: ' + JSON.stringify(body).slice(0, 200));
      assert.equal(body.data.updated, 4, 'one row = four settings written');
      const scoringRow = body.data.state.functions.find((f) => f.key === 'scoring');
      assert.equal(scoringRow.route.primary, 'muse', 'PUT response state shows the new route');
      assert.equal(scoringRow.route.modelPrimary, 'muse-score-1');
      n++;
      const resolved = await aiRouting.getRoute('scoring');
      assert.deepEqual(
        resolved,
        { primary: 'muse', fallback: 'openai', modelPrimary: 'muse-score-1', modelFallback: '' },
        'resolver sees the PUT (single source of truth)'
      );
      n++;
      // Restore the shipped default for later parts / cleanliness.
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
        { scoring: { primary: 'muse', fallback: 'muse' } },
        { nope: { primary: 'muse', fallback: 'none' } },
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
      assert.equal(after.primary, 'openai', 'rejected PUTs wrote nothing');
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
  if (process.env.B120_SKIP_BROWSER === '1') {
    console.log('  skip Part 6 browser (B120_SKIP_BROWSER=1 — local iteration only)');
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
        fal: { label: 'fal.ai', configured: false, baseHost: 'fal.ai', defaultModel: '' },
      },
      functions: [
        ...aiRouting.ROUTABLE_FUNCTIONS.map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind,
          route: { primary: f.defaultPrimary, fallback: f.defaultFallback, modelPrimary: '', modelFallback: '' },
          cooldowns:
            f.key === 'hands_off' ? [{ provider: 'muse', until: Date.now() + 8 * 60 * 1000, reason: 'HTTP 403' }] : [],
          lastFailover:
            f.key === 'design_chat'
              ? { from: 'muse', to: 'openai', reason: 'HTTP 403', at: Date.now() - 5 * 60 * 1000 }
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
        to: 'openai',
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
        data: { settings: {}, defs: [{ key: 'ai.api_key', group: 'keys', label: 'OpenAI API key', secret: true }] },
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
          const text = document.body.textContent || '';
          return {
            rowCount: rows.length,
            dcPrimary: sel(dc, 'primary').value,
            dcFallback: sel(dc, 'fallback').value,
            infoRows: ['Image generation', 'Photo enhancement'].filter((t) => text.includes(t)).length,
            hasCooldownText: text.includes('cooling down'),
            hasFailoverText: text.includes('Last failover'),
            hasSave: !!document.querySelector('#ai-routing-save'),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        assert.equal(m.rowCount, 10, `10 editable rows @${w}`);
        n++;
        assert.equal(m.dcPrimary, 'muse', `design_chat primary defaults to Meta Muse @${w}`);
        assert.equal(m.dcFallback, 'openai', `design_chat fallback defaults to OpenAI @${w}`);
        n++;
        assert.equal(m.infoRows, 2, `both informational rows render @${w}`);
        assert.ok(m.hasCooldownText, `cooldown status text visible @${w}`);
        assert.ok(m.hasFailoverText, `last-failover status text visible @${w}`);
        assert.ok(m.hasSave, `save button present @${w}`);
        n++;
        assert.ok(m.overflow <= 1, `no horizontal overflow @${w} (overflow=${m.overflow})`);
        n++;
      }
      // Save round-trip: flip design_chat to OpenAI primary and check
      // the payload the app posts.
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluate(() => {
        const row = document.querySelector('[data-route-row="design_chat"]');
        const sel = row.querySelector('[data-route-field="primary"]');
        sel.value = 'openai';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#ai-routing-save').click();
      });
      await new Promise((r) => setTimeout(r, 1200));
      assert.ok(savedRoutes, 'save posted to the routing endpoint');
      assert.equal(savedRoutes.design_chat.primary, 'openai', 'edited primary posted');
      assert.equal(typeof savedRoutes.design_chat.fallback, 'string', 'fallback field posted');
      assert.equal(Object.keys(savedRoutes).length, 10, 'all 10 rows posted');
      n++;
    } finally {
      await browser.close();
      server.close();
    }
    group('Part 6 browser matrix render + save', n);
  }

  console.log(`BATCH120 SUITE: ALL PASS — ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH120 SUITE FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
