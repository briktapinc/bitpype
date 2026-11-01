'use strict';
/**
 * Batch 98 — PLANNER / IMPLEMENTOR split (four-role rebuild
 * step 1; review §12.1/§13, findings M1/M2, fix-log SEC-06).
 *
 * What changed:
 *   1. Build mode's fence is a POSITIVE allowlist
 *      (PORTAL_DESIGN_TOOLS = reads ∪ design/content writes).
 *      billing.*, social.*, chatbot.*, members.grantComp,
 *      datatables.clear, charts.clear and every other
 *      non-design tool is never offered and refused at dispatch
 *      (SEC-06 — replaces the Batch 93 deny-list semantics).
 *   2. The PLANNER (museAgent.planPortalChange) writes an
 *      explicit plan object for every ready change — scope,
 *      settled, defaults applied, ordered steps, mechanical
 *      verify[] checks — validated whole (a step outside the
 *      allowlist invalidates the plan, never trims it) and
 *      PERSISTED per site (server/siteChatPlan.js).
 *   3. The IMPLEMENTOR (runPortalImproveLoop with a plan)
 *      executes only the plan's steps: the offered catalog
 *      narrows to reads + plan tools, out-of-plan mutations are
 *      refused at dispatch (NOT_IN_PLAN), and per-step outcomes
 *      are returned structurally (stepResults / planComplete).
 *   4. Big jobs: the plan IS the queued spec — rendered verbatim
 *      into the job instructions and stored machine-readably in
 *      brief.chat_origin.plans for the Batch 99 critic gate.
 *   5. Tier-1 v2 (M1): the site context carries CURRENT computed
 *      styles (server/siteStyleCascade.js over the live render)
 *      plus the chat's own style rules.
 *   6. Image-only turns route through the planner instead of
 *      the clarification trap.
 *
 * NEGATIVE PROOF (batch89/93 convention — the suite must go
 * RED): B98_NEGATIVE=sandbox shims build mode back to the old
 * deny-list semantics (`!DENY_TOOLS.has(name)`) → billing /
 * social / chatbot tools become offerable again and Part 1
 * fails.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b98-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch98', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const NEGATIVE = process.env.B98_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

function loadAgentSource() {
  let src = require('./lib/monolithSource.cjs').museAgentSource();
  if (NEGATIVE === 'sandbox') {
    const shimmed = src.replace(
      "if (mode === 'build') return PORTAL_DESIGN_TOOLS.has(name);",
      "if (mode === 'build') return !DENY_TOOLS.has(name); // B98 NEGATIVE SHIM — deny-list semantics restored"
    );
    assert.notEqual(shimmed, src, 'sandbox shim must change the museAgent source');
    src = shimmed;
  }
  return src;
}

function loadPortalSliceSource() {
  const src = require('./lib/monolithSource.cjs').clientPortalSource();
  const start = src.indexOf('async function runSiteAgentChat(');
  const end = src.indexOf('/**', start);
  assert.ok(start > 0 && end > start, 'slice bounds found');
  return src.slice(start, end);
}

const GOOD_PLAN_JSON = JSON.stringify({
  scope: { pages: ['all'], sections: null },
  settled: ['H3 colour: dark grey'],
  defaultsApplied: ['dark grey resolved to the site dark neutral or #444444'],
  steps: [
    {
      tool: 'theme.styleRule',
      args: { selector: 'h3', property: 'color', value: '#444444' },
      expect: 'every H3 computes to dark grey on light sections',
    },
  ],
  verify: [{ kind: 'computedStyle', selector: 'h3', property: 'color', equals: '#444444', where: 'light' }],
  size: 'small',
});

(async () => {
  const domain = require(path.join(root, 'server', 'domain.js'));
  const chatPlan = require(path.join(root, 'server', 'siteChatPlan.js'));
  const cascade = require(path.join(root, 'server', 'siteStyleCascade.js'));
  const chatPending = require(path.join(root, 'server', 'siteChatPending.js'));
  const designJobs = require(path.join(root, 'src', 'designJobs.js'));
  await require(path.join(root, 'server', 'db.js')).migrate();
  const realDb = domain.withDb(1, (db) => db);
  designJobs.ensureTables(realDb);
  chatPending.ensureTable(realDb);
  chatPlan.ensureTable(realDb);
  require(path.join(root, 'server', 'siteChatThread.js')).ensureTable(realDb);
  require(path.join(root, 'server', 'siteModules.js')).ensureTables(realDb);

  const stubDb = () => ({
    prepare: (sql) => ({
      get: () => (sql.includes('SUM') ? { spent: 0 } : undefined),
      run() {},
    }),
  });
  const textReply = (text) => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: text } }], usage: {} }),
  });
  const truncatedReply = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: null }, finish_reason: 'length' }],
      usage: { completion_tokens: 300 },
    }),
  });
  const toolReply = (wireName) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name: wireName, arguments: '{"leadId":999}' } },
            ],
          },
        },
      ],
      usage: {},
    }),
  });
  const wire = (body, desc) => {
    const t = (body.tools || []).find((x) => x.function.description === desc);
    return t ? t.function.name : null;
  };

  const CATALOG = [
    'site.get', 'site.render', 'theme.get', 'blog.list',
    'site.editText', 'site.publish', 'theme.set', 'theme.styleRule', 'blog.create',
    'pages.structure.update', 'modules.attach', 'forms.create',
    'billing.checkout', 'billing.portal', 'social.generate', 'social.posts.create',
    'chatbot.reply', 'members.grantComp', 'datatables.clear', 'datatables.addRow',
    'charts.clear', 'calls.updateSettings', 'lead.delete',
  ].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
  const CATALOG_NAMES = new Set(CATALOG.map((d) => d.name));

  function loopFixture(handler, defs = CATALOG) {
    const requests = [];
    const calls = [];
    const db = stubDb();
    const domainStub = { withDb: (_ws, fn) => fn(db), getSetting: () => '0' };
    const m = { exports: {} };
    vm.runInNewContext(loadAgentSource() + ';module.exports = module.exports;', {
      module: m,
      exports: m.exports,
      console,
      Buffer,
      URL,
      AbortSignal,
      process,
      require: (name) =>
        name === './platform'
          ? { getPlatformSetting: async (k, d) => (k === 'muse.model_api_key' ? 'synthetic-key' : d) }
          : name === '../src/defaultDesignInstructions'
            ? { defaultWebsiteInstructions: () => '' }
            : name === './domain'
              ? domainStub
              : name === './mcp'
                ? {
                    toolDefs: () => defs,
                    callTool: async (_ws, toolName) => {
                      calls.push(toolName);
                      return { ok: true, data: {} };
                    },
                  }
                : require(name.startsWith('.') ? path.join(root, 'server', name) : name),
      fetch: async (_url, opts) => {
        const body = JSON.parse(opts.body);
        requests.push(body);
        return handler(body, requests.length);
      },
    });
    return { agent: m.exports, requests, calls };
  }

  // ---------------------------------------------------------------
  // Part 1 — SEC-06: build mode is a positive allowlist
  // ---------------------------------------------------------------
  {
    let n = 0;
    const f = loopFixture(() => textReply('x'));
    const allows = (mode, name) => f.agent.portalModeAllowsTool(mode, name);
    for (const bad of [
      'billing.checkout', 'billing.portal', 'billing.cancel', 'social.generate',
      'social.posts.create', 'chatbot.reply', 'chatbot.knowledge.add',
      'members.grantComp', 'members.revokeComp', 'datatables.clear', 'charts.clear',
      'calls.updateSettings', 'calls.poolAdd', 'lead.delete', 'website.delete',
      'settings.set', 'email.send', 'sms.queue', 'outreach.send', 'domains.register',
    ]) {
      assert.equal(allows('build', bad), false, `build must refuse ${bad}`);
      n++;
    }
    for (const good of [
      'site.get', 'site.render', 'theme.get', 'site.editText', 'site.publish',
      'theme.set', 'theme.styleRule', 'blog.create', 'datatables.addRow',
      'forms.create', 'modules.attach', 'pages.structure.update',
    ]) {
      assert.equal(allows('build', good), true, `build must allow ${good}`);
      n++;
    }
    // Read-only modes unchanged: the read allowlist and nothing else.
    assert.equal(allows('answer', 'theme.styleRule'), false);
    assert.equal(allows('answer', 'site.get'), true);
    assert.equal(allows('clarify', 'blog.create'), false);
    n += 3;
    assert.ok(f.agent.PORTAL_DESIGN_TOOLS.has('theme.styleRule'), 'design set exported');
    assert.ok(!f.agent.PORTAL_DESIGN_TOOLS.has('billing.checkout'), 'billing not in design set');
    n += 2;
    group('Part 1 SEC-06 positive allowlist (build = design tools only)', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — plan validation + the persisted plan store
  // ---------------------------------------------------------------
  {
    let n = 0;
    const allowed = new Set(['theme.styleRule', 'site.editText', 'site.publish']);
    const good = chatPlan.validatePlan(JSON.parse(GOOD_PLAN_JSON), allowed);
    assert.ok(good, 'a well-formed plan validates');
    assert.equal(good.size, 'small');
    assert.equal(good.route, 'in-chat');
    assert.equal(good.steps.length, 1);
    assert.ok(good.verify.some((c) => c.kind === 'noCollateral'), 'noCollateral is always present');
    assert.equal(good.verify[0].where, 'light');
    n += 6;
    const poisoned = JSON.parse(GOOD_PLAN_JSON);
    poisoned.steps.push({ tool: 'billing.checkout', args: {}, expect: 'pay' });
    assert.equal(chatPlan.validatePlan(poisoned, allowed), null, 'one out-of-allowlist step invalidates the WHOLE plan');
    const unknown = JSON.parse(GOOD_PLAN_JSON);
    unknown.steps = [{ tool: 'made.upTool', args: {}, expect: 'x' }];
    assert.equal(chatPlan.validatePlan(unknown, allowed), null, 'unknown tool invalidates the plan');
    assert.equal(chatPlan.validatePlan({ steps: [] }, allowed), null, 'a plan with no steps is not a plan');
    assert.equal(chatPlan.validatePlan(null, allowed), null);
    n += 4;
    const big = chatPlan.validatePlan({ ...JSON.parse(GOOD_PLAN_JSON), size: 'big' }, allowed);
    assert.equal(big.route, 'queued', 'big plans route to the queue');
    n++;

    // Store: per-lead, status lifecycle, job linkage.
    const leadA = 98001;
    const leadB = 98002;
    const savedA = chatPlan.savePlan(realDb, { leadId: leadA, plan: good });
    assert.ok(savedA.id > 0);
    assert.equal(savedA.status, 'planned');
    chatPlan.savePlan(realDb, { leadId: leadB, plan: { ...good, size: 'big', route: 'queued' } });
    assert.equal(chatPlan.latestPlan(realDb, leadA).id, savedA.id, 'latest plan is per-lead');
    assert.equal(chatPlan.latestPlan(realDb, leadB).size, 'big');
    const upd = chatPlan.setPlanStatus(realDb, savedA.id, 'queued', { jobId: 4242 });
    assert.equal(upd.status, 'queued');
    assert.equal(upd.jobId, 4242);
    assert.equal(chatPlan.latestPlan(realDb, leadB).status, 'planned', "B's plan untouched by A's transition");
    n += 7;
    const rendered = chatPlan.renderPlanForJob(good);
    assert.ok(rendered.includes('PLAN (binding'), 'job rendering is labelled binding');
    assert.ok(rendered.includes('theme.styleRule'), 'job rendering carries the step tool');
    assert.ok(rendered.includes('#444444'), 'job rendering carries the verify hex');
    n += 3;
    group('Part 2 plan validation + persisted store (per-site)', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — the planner call: prompt, budget loop, validation
  // ---------------------------------------------------------------
  {
    let n = 0;
    const f = loopFixture(() => textReply(GOOD_PLAN_JSON));
    const out = await f.agent.planPortalChange(1, 7, {
      db: stubDb(),
      message: 'change all h3 to dark grey',
      specText: 'change all h3 to dark grey',
      history: [],
      settled: ['scope: entire site'],
      siteContext: 'Business: ZZ B98 Bakery',
    });
    assert.ok(out.plan, 'planner returns a validated plan');
    assert.equal(out.plan.steps[0].tool, 'theme.styleRule');
    n += 2;
    // The planner's budget ladder is pinned at [4800, 8000] —
    // measured live 2026-10-31: a non-trivial plan burned 1200
    // AND 2400 entirely on reasoning (empty completion); at
    // 4800 it landed at 3225 completion tokens on a short
    // history but still truncated with a longer one. Reasoning
    // spend is stochastic — the ladder carries ~2.5x headroom.
    assert.equal(f.requests[0].max_tokens, 4800, 'planner first attempt budget is 4800');
    n++;
    const sys = f.requests[0].messages.filter((mm) => mm.role === 'system').map((mm) => String(mm.content)).join('\n');
    assert.ok(sys.includes('PLANNER'), 'planner prompt names the role');
    assert.ok(sys.includes('DEFAULTS DOCTRINE'), 'doctrine rides the planner prompt');
    assert.ok(sys.includes('scope: entire site'), 'settled facts ride the planner prompt');
    assert.ok(sys.includes('theme.styleRule'), 'allowed tools enumerated for the planner');
    assert.ok(sys.includes('CURRENT computed styles') || sys.includes('computed styles'), 'planner is told the context carries computed styles');
    n += 5;
    // Truncation retry (reasoning model): first attempt burns the
    // budget, second lands the plan.
    const f2 = loopFixture((_body, i) => (i === 1 ? truncatedReply() : textReply(GOOD_PLAN_JSON)));
    const out2 = await f2.agent.planPortalChange(1, 7, { db: stubDb(), message: 'x', specText: 'x' });
    assert.ok(out2.plan, 'planner recovers from a truncated first attempt');
    assert.equal(f2.requests.length, 2, 'exactly one retry');
    assert.ok(f2.requests[1].max_tokens > f2.requests[0].max_tokens, 'retry budget is bigger');
    n += 3;
    // A plan with an out-of-allowlist step is rejected whole.
    const badPlan = JSON.parse(GOOD_PLAN_JSON);
    badPlan.steps.push({ tool: 'billing.checkout', args: {}, expect: 'pay' });
    const f3 = loopFixture(() => textReply(JSON.stringify(badPlan)));
    const out3 = await f3.agent.planPortalChange(1, 7, { db: stubDb(), message: 'x', specText: 'x' });
    assert.equal(out3.plan, null, 'out-of-allowlist step → no plan (caller falls back unplanned)');
    n++;
    // Rework context reaches the prompt.
    const f4 = loopFixture(() => textReply(GOOD_PLAN_JSON));
    await f4.agent.planPortalChange(1, 7, {
      db: stubDb(),
      message: 'x',
      specText: 'x',
      rework: { failures: ['h3 colour computed #ff0000, expected #444444'] },
    });
    const sys4 = f4.requests[0].messages.filter((mm) => mm.role === 'system').map((mm) => String(mm.content)).join('\n');
    assert.ok(sys4.includes('REWORK'), 'rework block present');
    assert.ok(sys4.includes('#ff0000'), 'critic actuals reach the planner verbatim');
    n += 2;
    group('Part 3 planner call (prompt, budget loop, whole-plan validation)', n);
  }

  // ---------------------------------------------------------------
  // Part 4 — the implementor executes the plan, nothing else
  // ---------------------------------------------------------------
  {
    let n = 0;
    const plan = chatPlan.validatePlan(JSON.parse(GOOD_PLAN_JSON), CATALOG_NAMES);
    // (a) with a plan: offered = reads + plan tools + site.publish.
    const f = loopFixture((body, i) => {
      if (i === 1) return toolReply(wire(body, 'theme.styleRule'));
      return textReply('Done — H3s are dark grey #444444. Defaults applied: none.');
    });
    const res = await f.agent.runPortalImproveLoop(1, 7, {
      db: stubDb(),
      message: 'change all h3 to dark grey',
      mode: 'build',
      plan,
    });
    const offered = (f.requests[0].tools || []).map((t) => t.function.description);
    assert.ok(offered.includes('theme.styleRule'), 'plan tool offered');
    assert.ok(offered.includes('site.render'), 'read tools stay offered for grounding');
    assert.ok(!offered.includes('site.editText'), 'design tool outside the plan is NOT offered');
    assert.ok(!offered.includes('billing.checkout'), 'billing is never offered');
    assert.deepEqual(f.calls, ['theme.styleRule', 'site.publish'], 'only the plan step (+ system publish) executed');
    assert.equal(res.planComplete, true, 'plan completed');
    assert.deepEqual(res.stepResults.map((r) => r.status), ['done']);
    assert.equal(res.planViolations, 0);
    n += 8;
    const sysText = f.requests[0].messages.filter((mm) => mm.role === 'system').map((mm) => String(mm.content)).join('\n');
    assert.ok(sysText.includes('THE PLAN'), 'the plan rides the implementor prompt');
    assert.ok(sysText.includes('NOT_IN_PLAN') || sysText.includes('refused by the system'), 'implementor is told the sandbox is real');
    n += 2;
    // (b) a fabricated wire name for an out-of-plan tool never
    // reaches mcp.callTool.
    const f2 = loopFixture((body, i) => {
      if (i === 1) return toolReply('billing_checkout_fabricated00');
      return textReply('I could not do that.');
    });
    const res2 = await f2.agent.runPortalImproveLoop(1, 7, {
      db: stubDb(),
      message: 'charge me',
      mode: 'build',
      plan,
    });
    assert.deepEqual(f2.calls.filter((c) => c.startsWith('billing')), [], 'billing never executed');
    assert.equal(res2.mutated, false);
    n += 2;
    // (c) no plan (fallback): the full DESIGN catalog is offered —
    // and billing/social still are not (SEC-06 at the offer layer).
    const f3 = loopFixture(() => textReply('ok'));
    await f3.agent.runPortalImproveLoop(1, 7, { db: stubDb(), message: 'x', mode: 'build' });
    const offered3 = (f3.requests[0].tools || []).map((t) => t.function.description);
    assert.ok(offered3.includes('blog.create'), 'unplanned build keeps the design catalog');
    assert.ok(!offered3.includes('billing.checkout'), 'unplanned build still excludes billing');
    assert.ok(!offered3.includes('social.generate'), 'unplanned build still excludes social');
    assert.ok(!offered3.includes('datatables.clear'), 'unplanned build still excludes bulk clear');
    n += 4;
    // Source pin: the dispatch-level NOT_IN_PLAN guard ships.
    const agentSrc = require('./lib/monolithSource.cjs').museAgentSource();
    assert.ok(agentSrc.includes('NOT_IN_PLAN'), 'dispatch plan guard ships in source');
    n++;
    group('Part 4 implementor sandbox (plan-scoped catalog, step tracking)', n);
  }

  // ---------------------------------------------------------------
  // Part 5 — runSiteAgentChat: plans persist, big = plan spec
  // ---------------------------------------------------------------
  {
    let n = 0;
    const FIXTURE_PAGES = [
      {
        slug: 'index',
        title: 'Home',
        sections: [{ type: 'hero', content: { headline: 'ZZ B98 Bakery', subheadline: 'Fresh daily.' } }],
      },
    ];
    const fixtureSites = {};
    const seedLead = (label) => {
      const info = realDb
        .prepare('INSERT INTO leads (business_name, category, phone) VALUES (?, ?, ?)')
        .run(`ZZ B98 ${label}`, 'Bakery', '(610) 555-0198');
      const leadId = Number(info.lastInsertRowid);
      fixtureSites[leadId] = { id: 7000 + leadId, pages: FIXTURE_PAGES, theme: { primary: '#7a4a21' } };
      // Batch 99 reviewer fidelity: the critic fingerprints and
      // renders the REAL websites row, so the fixture carries
      // one (seeded H3 colour in theme customCss) and the fake
      // loop below actually changes it, like production.
      realDb
        .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
        .run(
          leadId,
          `ZZ B98 ${label}`,
          'draft',
          JSON.stringify(FIXTURE_PAGES),
          JSON.stringify({ primary: '#7a4a21', customCss: 'h3 { color: #7a4a21; }' })
        );
      return leadId;
    };
    const applyFakeStyleRule = (leadId) => {
      const row = realDb.prepare('SELECT theme FROM websites WHERE lead_id = ?').get(leadId);
      const theme = JSON.parse(row.theme || '{}');
      theme.customCss =
        'h3 { color: #7a4a21; }\n/* bitpype:chat-rules:start */\nh3 { color: #444444; }\n/* bitpype:chat-rules:end */';
      realDb.prepare('UPDATE websites SET theme = ? WHERE lead_id = ?').run(JSON.stringify(theme), leadId);
    };
    let classifyQueue = [];
    let planCalls = [];
    let loopCalls = [];
    let planResult = { plan: chatPlan.validatePlan(JSON.parse(GOOD_PLAN_JSON), CATALOG_NAMES) };
    const fakeMuseAgent = {
      classifyPortalChatIntent: async () => {
        if (!classifyQueue.length) throw new Error('classify queue empty');
        return classifyQueue.shift();
      },
      planPortalChange: async (_ws, _lead, opts) => {
        planCalls.push(opts);
        return planResult;
      },
      runPortalImproveLoop: async (_ws, leadId, opts) => {
        loopCalls.push(opts);
        const base = { steps: 1, model: 'fixture-model', imagesSent: false, imagesDropped: false };
        if (opts.mode === 'build') {
          applyFakeStyleRule(leadId);
          return { ...base, reply: 'Done.', mutated: true, published: true, toolCalls: 1 };
        }
        return { ...base, reply: 'Answer.', mutated: false, published: false, toolCalls: 0 };
      },
    };
    const sliceMod = { exports: {} };
    vm.runInNewContext(loadPortalSliceSource() + ';module.exports = { runSiteAgentChat, takeSiteChatUpdates };', {
      module: sliceMod,
      exports: sliceMod.exports,
      console,
      Buffer,
      process,
      resolveClientSite: (_db, leadId) => fixtureSites[Number(leadId)] || null,
      publishClientSitePreview: async () => ({ previewUrl: 'https://bitpype.test/preview/site' }),
      renderClientSite: (_ws, leadId) => {
        const row = realDb.prepare('SELECT theme FROM websites WHERE lead_id = ?').get(Number(leadId));
        const theme = row ? JSON.parse(row.theme || '{}') : {};
        return {
          html: `<html><head><style>${theme.customCss || ''}</style></head><body><section><h3>ZZ Heading</h3></section></body></html>`,
          previewUrl: 'https://bitpype.test/preview/site',
          editable: true,
          theme: null,
          logo: null,
          pages: [],
        };
      },
      require: (name) =>
        name === './museAgent'
          ? fakeMuseAgent
          : name === './domain'
            ? { withDb: (_ws, fn) => fn(realDb) }
            : require(name.startsWith('.') ? path.join(root, 'server', name) : name),
    });
    const runChat = (leadId, body) => sliceMod.exports.runSiteAgentChat(1, leadId, body);
    const reset = () => {
      classifyQueue = [];
      planCalls = [];
      loopCalls = [];
    };

    // (i) ready small: plan persisted + handed to the loop.
    {
      const lead = seedLead('small');
      reset();
      classifyQueue = [{ intent: 'change', ready: true, size: 'small', settled: [], fallback: false }];
      const res = await runChat(lead, { message: 'change all h3 to dark grey' });
      assert.equal(res.mode, 'build');
      assert.ok(res.planId, 'payload carries the plan id');
      assert.equal(planCalls.length, 1, 'planner called once');
      assert.ok(loopCalls[0].plan, 'the loop received the plan');
      assert.equal(loopCalls[0].plan.steps[0].tool, 'theme.styleRule');
      const row = chatPlan.getPlan(realDb, res.planId);
      assert.equal(row.status, 'implemented', 'plan marked implemented after a mutating build');
      assert.equal(row.leadId, lead);
      n += 7;
    }
    // (ii) ready big: the plan IS the queued spec.
    {
      const lead = seedLead('big');
      reset();
      planResult = {
        plan: chatPlan.validatePlan(
          {
            ...JSON.parse(GOOD_PLAN_JSON),
            size: 'big',
            steps: [{ tool: 'pages.structure.update', args: { action: 'add_page', slug: 'tastings' }, expect: 'a tastings page exists' }],
          },
          new Set(CATALOG.map((d) => d.name))
        ),
      };
      classifyQueue = [{ intent: 'change', ready: true, size: 'big', settled: [], fallback: false }];
      const res = await runChat(lead, { message: 'add a tastings page' });
      assert.equal(res.mode, 'queued');
      assert.ok(res.queuedJobId, 'job queued');
      const job = realDb.prepare('SELECT * FROM design_jobs WHERE id = ?').get(res.queuedJobId);
      const brief = JSON.parse(job.brief || '{}');
      assert.ok(brief.chat_origin && Array.isArray(brief.chat_origin.plans), 'plan stored in the brief');
      assert.equal(brief.chat_origin.plans.length, 1);
      assert.ok(String(job.instructions).includes('PLAN (binding'), 'instructions lead with the binding plan');
      assert.ok(String(job.instructions).includes('pages.structure.update'), 'instructions carry the plan step');
      const row = chatPlan.getPlan(realDb, res.planId);
      assert.equal(row.status, 'queued');
      assert.equal(row.jobId, Number(res.queuedJobId));
      n += 8;
      planResult = { plan: chatPlan.validatePlan(JSON.parse(GOOD_PLAN_JSON), new Set(CATALOG.map((d) => d.name))) };
    }
    // (iii) a question never reaches the planner.
    {
      const lead = seedLead('question');
      reset();
      classifyQueue = [{ intent: 'question', ready: false, size: 'small', settled: [], fallback: false }];
      const res = await runChat(lead, { message: 'what colour are my headings?' });
      assert.equal(res.mode, 'answer');
      assert.equal(planCalls.length, 0, 'planner not called for a question');
      assert.equal(res.planId, null);
      assert.equal(chatPlan.latestPlan(realDb, lead), null, 'no plan row for a question turn');
      n += 4;
    }
    // (iv) planner failure → unplanned build, allowlist still on.
    {
      const lead = seedLead('noplan');
      reset();
      planResult = { plan: null };
      classifyQueue = [{ intent: 'change', ready: true, size: 'small', settled: [], fallback: false }];
      const res = await runChat(lead, { message: 'change all h3 to dark grey' });
      assert.equal(res.mode, 'build', 'turn still implements');
      assert.equal(res.planId, null);
      assert.equal(loopCalls[0].plan, undefined, 'loop ran unplanned');
      n += 3;
      planResult = { plan: chatPlan.validatePlan(JSON.parse(GOOD_PLAN_JSON), new Set(CATALOG.map((d) => d.name))) };
    }
    group('Part 5 runSiteAgentChat (persist, route, queue spec, fallback)', n);
  }

  // ---------------------------------------------------------------
  // Part 6 — Tier-1 v2: the cascade evaluator sees current styles
  // ---------------------------------------------------------------
  {
    let n = 0;
    const html = `<html><head><style>
      :root { --ink: #141414; }
      h3 { color: #7a4a21; }
      .dark-band { background: #1c1a17; }
      .dark-band h3 { color: #f6f6f4; }
      /* bitpype:chat-rules:start */
      h3 { color: #444444; }
      /* bitpype:chat-rules:end */
    </style></head><body>
      <section><h3>Plain Heading</h3><p>Body text</p></section>
      <section class="dark-band"><h3>Dark Heading</h3></section>
    </body></html>`;
    const plain = cascade.computedStyleValues(html, 'h3', 'color');
    const byText = {
      'Plain Heading': plain.find((v) => v.text.startsWith('Plain Heading')),
      'Dark Heading': plain.find((v) => v.text.startsWith('Dark Heading')),
    };
    assert.ok(byText['Plain Heading'] && byText['Dark Heading'], 'both H3s found');
    assert.equal(byText['Plain Heading'].value, '#444444', 'chat-rules block wins over the earlier theme rule (order)');
    assert.equal(byText['Plain Heading'].context, 'light');
    assert.equal(byText['Dark Heading'].value, '#f6f6f4', 'dark-section rule wins on the dark band (specificity)');
    assert.equal(byText['Dark Heading'].context, 'dark', 'effective background splits the context');
    n += 4;
    const keys = cascade.keyStyles(html);
    assert.deepEqual(keys.h3.light.colors, ['#444444']);
    assert.deepEqual(keys.h3.dark.colors, ['#f6f6f4']);
    n += 2;
    const lines = cascade.keyStyleLines(html).join('\n');
    assert.ok(lines.includes('H3 text colour on light sections: #444444'), 'map line names the current H3 colour');
    assert.ok(lines.includes('H3 text colour on dark sections: #f6f6f4'), 'map line names the dark-section colour');
    n += 2;
    // Inline style + var() resolution.
    const html2 = `<style>:root{--brand:#123456} p{color:var(--brand)}</style><p>One</p><p style="color:#ff0000">Two</p>`;
    const ps = cascade.computedStyleValues(html2, 'p', 'color');
    assert.equal(ps[0].value, '#123456', 'var() resolves from :root');
    assert.equal(ps[1].value, '#ff0000', 'inline style wins over rules');
    n += 2;
    group('Part 6 cascade evaluator (Tier-1 v2 eyes)', n);
  }

  console.log(JSON.stringify({ passed: true, groups }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
