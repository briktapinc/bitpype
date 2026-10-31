'use strict';
/**
 * Batch 93 — the portal site-builder chat becomes a design AGENT.
 *
 * Behaviour under test (Ely 2026-10-30):
 *   - A message is classified first (museAgent.classifyPortalChatIntent):
 *     question / change / off-topic / ambiguous / clarify_answer / cancel,
 *     with readiness (specific enough?) and — once ready — SIZE
 *     (small = implement in chat; big = queue to the design agent).
 *   - Questions are answered in a READ-ONLY loop mode: the write
 *     tools are never offered (PORTAL_READONLY_TOOLS allowlist via
 *     the portalModeAllowsTool seam) and refused again at dispatch.
 *   - Underspecified changes ask clarification questions; the
 *     pending change persists server-side (site_chat_pending) across
 *     turns; a question mid-clarification is answered AND the
 *     pending change stays visible/alive.
 *   - Specific SMALL changes implement in-chat (existing loop).
 *     Specific BIG changes are NOT edited: a design_jobs row
 *     (type 'improvement', status 'waiting_on_agent') is queued
 *     with the clarified spec + chat attachment references, the
 *     user is told, and completion writes back into the thread
 *     (site_chat_messages via the deliverJob hook; surfaced by
 *     takeSiteChatUpdates / GET /site/agent-chat/updates).
 *   - Off-topic messages are declined with no loop run at all.
 *   - Context tiers: a Tier-1 whole-site map (business basics,
 *     pages/sections, modules, theme) is built per turn and rides
 *     the classifier, every loop mode, and a queued job's spec;
 *     Tier 2 is the read tools.
 *
 * NEGATIVE PROOFS (batch89 convention — the suite must go RED):
 *   B93_NEGATIVE=fence  portalModeAllowsTool returns true → the
 *                       hostile question-turn model call EXECUTES
 *                       site.editText (Part 1c assertions fail).
 *   B93_NEGATIVE=gate   the clarification branch is disabled
 *                       (`!ready && false`) → a vague change is
 *                       implemented immediately (Part 2 S-iii fails).
 *   B93_NEGATIVE=size   the size gate is pinned small (`isBig=false`)
 *                       → a big job is edited in-chat and never
 *                       queued (Part 2 S-size-ii fails).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b93-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch93', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const NEGATIVE = process.env.B93_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

function loadAgent(extraShim) {
  let src = fs.readFileSync(path.join(root, 'server', 'museAgent.js'), 'utf8');
  if (NEGATIVE === 'fence') {
    const shimmed = src.replace(
      'return PORTAL_READONLY_TOOLS.has(name);',
      'return true; // B93 NEGATIVE SHIM — fence removed'
    );
    assert.notEqual(shimmed, src, 'fence shim must change the source');
    src = shimmed;
  }
  if (extraShim) src = extraShim(src);
  return src;
}

function loadPortalSliceSource() {
  let src = fs.readFileSync(path.join(root, 'server', 'clientPortal.js'), 'utf8');
  if (NEGATIVE === 'gate') {
    const shimmed = src.replace('} else if (!ready) {', '} else if (!ready && false) { // B93 NEGATIVE SHIM');
    assert.notEqual(shimmed, src, 'gate shim must change the source');
    src = shimmed;
  }
  if (NEGATIVE === 'size') {
    const shimmed = src.replace(
      "const isBig = !!(cls && cls.size === 'big');",
      'const isBig = false; // B93 NEGATIVE SHIM — size gate removed'
    );
    assert.notEqual(shimmed, src, 'size shim must change the source');
    src = shimmed;
  }
  const start = src.indexOf('async function runSiteAgentChat(');
  const end = src.indexOf('/**', start);
  assert.ok(start > 0 && end > start, 'slice bounds found');
  return src.slice(start, end);
}

const READS = ['site.get', 'site.render', 'theme.get', 'blog.list'];
const WRITES = ['site.editText', 'site.publish', 'theme.set', 'blog.create'];
const ALL_DEFS = [...READS, ...WRITES].map((name) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
}));

(async () => {
  const domain = require(path.join(root, 'server', 'domain.js'));
  const chatAtt = require(path.join(root, 'server', 'siteChatAttachments.js'));
  const chatPending = require(path.join(root, 'server', 'siteChatPending.js'));
  const chatThread = require(path.join(root, 'server', 'siteChatThread.js'));
  const designJobs = require(path.join(root, 'src', 'designJobs.js'));
  await require(path.join(root, 'server', 'db.js')).migrate();

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
  // A reasoning model that spends the whole budget thinking returns
  // content:null with finish_reason 'length' (proven live).
  const truncatedReply = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: null }, finish_reason: 'length' }],
      usage: { completion_tokens: 300 },
    }),
  });

  // ---------------------------------------------------------------
  // Part 1 — museAgent: classifier + loop modes + the fence
  // ---------------------------------------------------------------
  function loopFixture(handler) {
    const requests = [];
    const calls = [];
    const db = stubDb();
    const domainStub = { withDb: (_ws, fn) => fn(db), getSetting: () => '0' };
    const m = { exports: {} };
    vm.runInNewContext(loadAgent() + ';module.exports = module.exports;', {
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
                    toolDefs: () => ALL_DEFS,
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

  // 1a. Classifier parsing + fallbacks.
  {
    let n = 0;
    const classifyWith = async (payload, opts = {}) => {
      const f = loopFixture(() => textReply(payload));
      return f.agent.classifyPortalChatIntent(1, 7, { db: stubDb(), message: 'msg', ...opts });
    };
    const q = await classifyWith('{"intent":"question","ready":false}');
    assert.equal(q.intent, 'question');
    assert.equal(q.fallback, false);
    n += 2;
    const big = await classifyWith('{"intent":"change","ready":true,"size":"big","borderline":true}');
    assert.equal(big.intent, 'change');
    assert.equal(big.ready, true);
    assert.equal(big.size, 'big');
    assert.equal(big.borderline, true);
    n += 4;
    const prose = await classifyWith('Sure — {"intent":"offtopic","ready":false} hope that helps');
    assert.equal(prose.intent, 'offtopic', 'JSON extracted from prose');
    n++;
    const junk = await classifyWith('I cannot decide');
    assert.equal(junk.intent, 'ambiguous', 'unparseable → safe fallback (no pending)');
    assert.equal(junk.fallback, true);
    n += 2;
    const junkPending = await classifyWith('I cannot decide', {
      pending: { requestText: 'Make it pop', kind: 'clarify', answers: [] },
    });
    assert.equal(junkPending.intent, 'clarify_answer', 'unparseable → clarification answer (pending)');
    assert.equal(junkPending.ready, false);
    n += 2;
    const cancelNoPending = await classifyWith('{"intent":"cancel","ready":false}');
    assert.equal(cancelNoPending.intent, 'ambiguous', 'cancel without pending is remapped');
    const answerNoPending = await classifyWith('{"intent":"clarify_answer","ready":true}');
    assert.equal(answerNoPending.intent, 'change', 'clarify_answer without pending becomes change');
    n += 2;
    // Reasoning-model truncation: attempt 1 returns no content
    // (finish_reason 'length') → the classifier retries ONCE with a
    // bigger budget and parses attempt 2, instead of silently
    // degrading to the ambiguous fallback (the live-proof bug).
    {
      const f = loopFixture((body, i) =>
        i === 1 ? truncatedReply() : textReply('{"intent":"question","ready":false}')
      );
      const out = await f.agent.classifyPortalChatIntent(1, 7, { db: stubDb(), message: 'What is my headline?' });
      assert.equal(out.intent, 'question', 'retry recovers the real classification');
      assert.equal(out.fallback, false);
      assert.equal(f.requests.length, 2, 'exactly one truncation retry');
      assert.ok(f.requests[0].max_tokens >= 1000, 'classifier budgets for reasoning tokens');
      assert.ok(f.requests[1].max_tokens > f.requests[0].max_tokens, 'retry budget is bigger');
      n += 5;
    }
    group('1a classifier: parsing + fallbacks + truncation retry', n);
  }

  // 1b. Answer mode: read-only tools, Tier-1 context, real answer.
  {
    let n = 0;
    const f = loopFixture((body, i) => {
      if (i === 1) return toolReply(wire(body, 'site.render'));
      return textReply('Your headline is "Fresh Bread Daily".');
    });
    const res = await f.agent.runPortalImproveLoop(1, 7, {
      db: stubDb(),
      message: 'What is my headline?',
      mode: 'answer',
      siteContext: 'Business: ZZ B93 Bakery · Category: Bakery',
    });
    assert.equal(res.mode, 'answer');
    assert.equal(res.mutated, false);
    assert.deepEqual(f.calls, ['site.render'], 'only the read tool executed');
    n += 3;
    for (const req of f.requests) {
      if (!req.tools) continue;
      const offered = req.tools.map((t) => t.function.description);
      for (const w of WRITES) assert.ok(!offered.includes(w), `write tool ${w} must never be offered in answer mode`);
      n++;
    }
    const sysText = f.requests
      .flatMap((r) => r.messages || [])
      .filter((mm) => mm.role === 'system')
      .map((mm) => String(mm.content))
      .join('\n');
    assert.ok(sysText.includes('WHOLE-SITE CONTEXT'), 'Tier-1 map rides the answer turn');
    assert.ok(sysText.includes('ZZ B93 Bakery'), 'map content present');
    assert.ok(sysText.includes('never invent'), 'grounding rule present');
    assert.ok(res.reply.includes('Fresh Bread Daily'));
    n += 4;
    group('1b answer mode: fenced, grounded, answered', n);
  }

  // 1c. Hostile model in answer mode tries to edit. Normally the
  // write wire name is not even offered, and a fabricated one is
  // refused at dispatch. Under B93_NEGATIVE=fence the tool IS
  // offered and executes — these assertions fail (suite goes red).
  {
    let n = 0;
    const f = loopFixture((body, i) => {
      if (i === 1) return toolReply(wire(body, 'site.editText') || 'site_editText_fabricated000');
      return textReply('I cannot change that on a question turn.');
    });
    const res = await f.agent.runPortalImproveLoop(1, 7, {
      db: stubDb(),
      message: 'What do you think of my headline?',
      mode: 'answer',
    });
    assert.deepEqual(f.calls, [], 'NO tool may execute when the model tries to edit on a question turn');
    assert.equal(res.mutated, false, 'question turn must not mutate');
    n += 2;
    group('1c answer mode: hostile edit refused (fence)', n);
  }

  // 1d. Clarify mode: asks, never edits, read-only catalog.
  {
    let n = 0;
    const f = loopFixture((body) => {
      if (!body.tools) return textReply('{"intent":"change","ready":false}');
      return textReply('Quick questions:\n1. Which page?\n2. What colours?');
    });
    const res = await f.agent.runPortalImproveLoop(1, 7, {
      db: stubDb(),
      message: 'Make it pop',
      mode: 'clarify',
      clarifyAbout: 'Make it pop',
      clarifyKind: 'open',
    });
    assert.equal(res.mode, 'clarify');
    assert.equal(res.mutated, false);
    assert.deepEqual(f.calls, []);
    assert.ok(res.reply.includes('Which page?'));
    const offered = (f.requests.find((r) => r.tools) || { tools: [] }).tools.map((t) => t.function.description);
    for (const w of WRITES) assert.ok(!offered.includes(w), 'clarify mode offers no write tools');
    n += 5;
    group('1d clarify mode: questions only', n);
  }

  // 1e. Build mode is the historical behaviour, unchanged.
  {
    let n = 0;
    const f = loopFixture((body, i) => {
      if (i === 1) return toolReply(wire(body, 'site.editText'));
      return textReply('Done — headline updated.');
    });
    const res = await f.agent.runPortalImproveLoop(1, 7, {
      db: stubDb(),
      message: 'Change the headline',
    });
    assert.equal(res.mode, 'build');
    assert.equal(res.mutated, true);
    assert.deepEqual(f.calls, ['site.editText', 'site.publish'], 'edit + auto-publish');
    assert.equal(res.published, true);
    n += 4;
    group('1e build mode: unchanged behaviour', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — runSiteAgentChat routing (real slice; scripted
  // classifier + loop; REAL pending/thread/design-jobs stores on
  // the fixture DB).
  // ---------------------------------------------------------------
  const siteModules = require(path.join(root, 'server', 'siteModules.js'));
  const leadEngine = require(path.join(root, 'src', 'leadEngine.js'));
  const realDb = domain.withDb(1, (db) => db);
  siteModules.ensureTables(realDb);
  designJobs.ensureTables(realDb);

  const FIXTURE_PAGES = [
    {
      slug: 'index',
      title: 'Home',
      sections: [
        { type: 'hero', content: { heading: 'Fresh Bread Daily', text: 'Baked at dawn, gone by noon.' } },
        { type: 'text', content: { heading: 'Our Story', text: 'A family bakery.' } },
      ],
    },
    {
      slug: 'services',
      title: 'Services',
      sections: [{ type: 'services', content: { heading: 'What We Bake', text: 'Sourdough, rye, and rolls.' } }],
    },
  ];
  const FIXTURE_THEME = { primaryColor: '#7a4a21', fontHeading: 'Fraunces' };
  const fixtureSites = {};
  const seedChatLead = (label) => {
    const info = realDb
      .prepare('INSERT INTO leads (business_name, category, phone) VALUES (?, ?, ?)')
      .run(`ZZ B93 Bakery ${label}`, 'Bakery', '(610) 555-0193');
    const leadId = Number(info.lastInsertRowid);
    fixtureSites[leadId] = { id: 5000 + leadId, pages: FIXTURE_PAGES, theme: FIXTURE_THEME };
    realDb.prepare('INSERT INTO site_module_embeds (lead_id, module_type) VALUES (?, ?)').run(leadId, 'gallery');
    return leadId;
  };

  let classifyQueue = [];
  let classifyCalls = [];
  let loopCalls = [];
  let answerText = 'Your services page lists sourdough, rye, and rolls.';
  const fakeMuseAgent = {
    classifyPortalChatIntent: async (_ws, _lead, opts) => {
      classifyCalls.push(opts);
      if (!classifyQueue.length) throw new Error('classify queue empty');
      return classifyQueue.shift();
    },
    runPortalImproveLoop: async (_ws, _lead, opts) => {
      loopCalls.push(opts);
      const base = {
        steps: 1,
        model: 'fixture-model',
        imagesSent: (opts.images || []).length > 0,
        imagesDropped: false,
      };
      if (opts.mode === 'build') {
        return { ...base, reply: 'Done — I updated your site.', mutated: true, published: true, toolCalls: 2 };
      }
      if (opts.mode === 'clarify') {
        return {
          ...base,
          reply: 'Quick questions:\n1. Which page should change?\n2. What style are you picturing?',
          mutated: false,
          published: false,
          toolCalls: 0,
        };
      }
      return { ...base, reply: answerText, mutated: false, published: false, toolCalls: 1 };
    },
  };
  const resetTurn = () => {
    classifyQueue = [];
    classifyCalls = [];
    loopCalls = [];
  };
  const sliceMod = { exports: {} };
  vm.runInNewContext(
    loadPortalSliceSource() + ';module.exports = { runSiteAgentChat, takeSiteChatUpdates };',
    {
      module: sliceMod,
      exports: sliceMod.exports,
      console,
      Buffer,
      process,
      resolveClientSite: (_db, leadId) => fixtureSites[Number(leadId)] || null,
      publishClientSitePreview: async () => ({ previewUrl: 'https://bitpype.test/preview/site' }),
      renderClientSite: () => ({
        html: '<html><body>preview</body></html>',
        previewUrl: 'https://bitpype.test/preview/site',
        editable: true,
        theme: null,
        logo: null,
        pages: [],
      }),
      require: (name) =>
        name === './museAgent'
          ? fakeMuseAgent
          : name === './domain'
            ? { withDb: (_ws, fn) => fn(realDb) }
            : require(name.startsWith('.') ? path.join(root, 'server', name) : name),
    }
  );
  const runChat = (leadId, body) => sliceMod.exports.runSiteAgentChat(1, leadId, body);
  const jobCount = (leadId) =>
    realDb.prepare('SELECT COUNT(*) AS c FROM design_jobs WHERE lead_id = ?').get(leadId).c;
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const savePng = (leadId, name) =>
    chatAtt.saveAttachment(realDb, {
      workspaceId: 1,
      leadId,
      buffer: Buffer.from(PNG_1PX, 'base64'),
      originalName: name,
    });

  // S(i) — design question: answered, grounded in Tier-1, no edits.
  {
    let n = 0;
    const lead = seedChatLead('A');
    resetTurn();
    classifyQueue = [{ intent: 'question', ready: false, fallback: false }];
    const res = await runChat(lead, { message: "What's on my home page?" });
    assert.equal(res.mode, 'answer');
    assert.equal(res.mutated, false);
    assert.equal(loopCalls.length, 1);
    assert.equal(loopCalls[0].mode, 'answer');
    assert.ok(res.reply.includes('sourdough'));
    n += 5;
    // Tier 1 rides BOTH the classifier and the loop, with real content.
    assert.ok(classifyCalls[0].siteContext.includes('ZZ B93 Bakery A'), 'classifier got the map');
    assert.ok(loopCalls[0].siteContext.includes('Fresh Bread Daily'), 'map carries section content');
    assert.ok(loopCalls[0].siteContext.includes('gallery'), 'map carries module inventory');
    assert.ok(loopCalls[0].siteContext.includes('#7a4a21'), 'map carries brand/style');
    assert.ok(loopCalls[0].siteContext.includes('/services'), 'map carries every page');
    n += 5;
    assert.equal(jobCount(lead), 0);
    assert.equal(chatPending.getPending(realDb, lead), null);
    n += 2;
    group('S(i) question → grounded answer, no edits', n);
  }

  // S(ii) — off-topic: declined, loop never runs.
  {
    let n = 0;
    const lead = seedChatLead('B');
    resetTurn();
    classifyQueue = [{ intent: 'offtopic', ready: false, fallback: false }];
    const res = await runChat(lead, { message: "What's the weather tomorrow?" });
    assert.equal(res.mode, 'offtopic');
    assert.equal(res.mutated, false);
    assert.equal(loopCalls.length, 0, 'off-topic never reaches the loop');
    assert.ok(res.reply.includes('design agent'));
    assert.ok(res.reply.includes('only help with your site'));
    n += 5;
    group('S(ii) off-topic → declined, no loop', n);
  }

  // S(iii)+(iv) — vague change clarifies (pending persists), then
  // the clarification answer implements it SMALL in-chat.
  {
    let n = 0;
    const lead = seedChatLead('C');
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: false, size: 'small', fallback: false }];
    const res1 = await runChat(lead, { message: 'Make my site better' });
    assert.equal(res1.mode, 'clarify', 'vague change must NOT implement yet');
    assert.equal(res1.mutated, false);
    assert.equal(res1.pendingClarification, true);
    assert.equal(loopCalls.length, 1);
    assert.equal(loopCalls[0].mode, 'clarify');
    assert.equal(loopCalls[0].clarifyAbout, 'Make my site better');
    n += 6;
    const pending = chatPending.getPending(realDb, lead);
    assert.ok(pending, 'pending change persisted server-side');
    assert.equal(pending.requestText, 'Make my site better');
    assert.equal(pending.kind, 'clarify');
    assert.equal(jobCount(lead), 0);
    n += 4;

    resetTurn();
    classifyQueue = [{ intent: 'clarify_answer', ready: true, size: 'small', fallback: false }];
    const res2 = await runChat(lead, { message: 'The homepage — warm and rustic, bigger headline' });
    assert.equal(classifyCalls[0].pending.requestText, 'Make my site better', 'classifier saw the pending change');
    assert.equal(loopCalls.length, 1);
    assert.equal(loopCalls[0].mode, 'build', 'clarified small change implements in-chat');
    assert.ok(loopCalls[0].message.includes('Make my site better'), 'spec carries the original request');
    assert.ok(loopCalls[0].message.includes('warm and rustic'), 'spec carries the clarification');
    assert.equal(res2.mode, 'build');
    assert.equal(res2.mutated, true);
    assert.equal(res2.pendingClarification, false);
    assert.equal(chatPending.getPending(realDb, lead), null, 'pending cleared after implementation');
    assert.equal(jobCount(lead), 0, 'small job created NO design_jobs row');
    n += 10;
    group('S(iii)+(iv) vague → clarify → clarified small implements', n);
  }

  // S(v) — specific change: direct build, no clarification.
  {
    let n = 0;
    const lead = seedChatLead('D');
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: true, size: 'small', fallback: false }];
    const res = await runChat(lead, {
      message: 'Make the headline dark blue and add my phone number under it',
    });
    assert.equal(res.mode, 'build');
    assert.equal(res.mutated, true);
    assert.equal(loopCalls.length, 1, 'exactly one loop run — no clarification round-trip');
    assert.equal(loopCalls[0].mode, 'build');
    assert.equal(chatPending.getPending(realDb, lead), null);
    assert.equal(jobCount(lead), 0);
    n += 6;
    group('S(v) specific change → direct build', n);
  }

  // S(vi) — question DURING a pending clarification: answered, the
  // pending change stays alive and visible in the reply.
  {
    let n = 0;
    const lead = seedChatLead('E');
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: false, size: 'small', fallback: false }];
    await runChat(lead, { message: 'Improve the homepage' });
    assert.ok(chatPending.getPending(realDb, lead), 'pending set');
    n++;
    resetTurn();
    classifyQueue = [{ intent: 'question', ready: false, fallback: false }];
    const res = await runChat(lead, { message: "What's on my services page?" });
    assert.equal(res.mode, 'answer');
    assert.ok(res.reply.includes('sourdough'), 'question answered');
    assert.ok(res.reply.includes('Still holding your earlier change request'), 'pending made visible');
    assert.ok(res.reply.includes('Improve the homepage'));
    assert.ok(chatPending.getPending(realDb, lead), 'pending change retained');
    assert.equal(loopCalls[0].mode, 'answer');
    n += 6;
    group('S(vi) question during pending → answered + pending kept', n);
  }

  // S(vii) — attachments work in question AND change modes.
  {
    let n = 0;
    const lead = seedChatLead('F');
    const a1 = await savePng(lead, 'logo-idea.png');
    resetTurn();
    classifyQueue = [{ intent: 'question', ready: false, fallback: false }];
    answerText = 'That logo would sit well in the header — the colours match your palette.';
    const resQ = await runChat(lead, {
      message: 'What do you think of this logo for the site?',
      attachmentIds: [a1.id],
    });
    assert.equal(resQ.mode, 'answer');
    assert.equal((loopCalls[0].images || []).length, 1, 'image reaches the answer loop');
    assert.equal(resQ.attachments[0].id, a1.id);
    n += 3;
    const a2 = await savePng(lead, 'hero-photo.png');
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: true, size: 'small', fallback: false }];
    const resB = await runChat(lead, {
      message: 'Use this photo in the hero',
      attachmentIds: [a2.id],
    });
    assert.equal(resB.mode, 'build');
    assert.equal((loopCalls[0].images || []).length, 1, 'image reaches the build loop');
    n += 2;
    group('S(vii) attachments in question + change modes', n);
  }

  // S(either-or) — ambiguous message gets ONE either/or question;
  // "just asking" resolves it as a question and clears the pending.
  {
    let n = 0;
    const lead = seedChatLead('G');
    resetTurn();
    classifyQueue = [{ intent: 'ambiguous', ready: false, fallback: false }];
    const res1 = await runChat(lead, { message: 'the blue looks bad' });
    assert.equal(res1.mode, 'clarify');
    assert.equal(loopCalls[0].mode, 'clarify');
    assert.equal(loopCalls[0].clarifyKind, 'either_or');
    const pending = chatPending.getPending(realDb, lead);
    assert.ok(pending && pending.kind === 'either_or');
    n += 4;
    resetTurn();
    classifyQueue = [{ intent: 'question', ready: false, fallback: false }];
    answerText = 'It is a deep navy, #1d3557.';
    const res2 = await runChat(lead, { message: 'Just asking — what blue is it?' });
    assert.equal(res2.mode, 'answer');
    assert.equal(chatPending.getPending(realDb, lead), null, 'either/or pending resolved as just-asking');
    n += 2;
    group('S(either-or) ambiguous → one question; just-asking resolves', n);
  }

  // S(cancel) — abandoning a pending change clears it, no loop run.
  {
    let n = 0;
    const lead = seedChatLead('H');
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: false, size: 'small', fallback: false }];
    await runChat(lead, { message: 'Improve the homepage' });
    assert.ok(chatPending.getPending(realDb, lead));
    resetTurn();
    classifyQueue = [{ intent: 'cancel', ready: false, fallback: false }];
    const res = await runChat(lead, { message: 'forget it' });
    assert.equal(res.mode, 'answer');
    assert.equal(loopCalls.length, 0, 'cancel runs no loop');
    assert.ok(res.reply.toLowerCase().includes('dropped'));
    assert.equal(chatPending.getPending(realDb, lead), null);
    n += 5;
    group('S(cancel) pending change dropped cleanly', n);
  }

  // S(supersede) — a fresh specific change arriving while a
  // clarification is pending replaces it: built from the fresh
  // message alone, pending cleared.
  {
    let n = 0;
    const lead = seedChatLead('S');
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: false, size: 'small', fallback: false }];
    await runChat(lead, { message: 'Improve the homepage' });
    assert.ok(chatPending.getPending(realDb, lead), 'pending set');
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: true, size: 'small', fallback: false }];
    const res = await runChat(lead, { message: 'Change the headline to "Fresh Bread Daily"' });
    assert.equal(res.mode, 'build');
    assert.equal(loopCalls.length, 1);
    assert.equal(
      loopCalls[0].message,
      'Change the headline to "Fresh Bread Daily"',
      'fresh instruction stands on its own (not folded into the stale request)'
    );
    assert.equal(chatPending.getPending(realDb, lead), null, 'stale pending superseded + cleared');
    n += 5;
    group('S(supersede) fresh change replaces a pending clarification', n);
  }

  // S(size-ii) — BIG specific job: NOT edited in chat; queued to
  // the design agent with spec + attachment refs + Tier-1 context.
  let bigJobId = null;
  let bigLead = null;
  {
    let n = 0;
    bigLead = seedChatLead('I');
    const att = await savePng(bigLead, 'menu-board.png');
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: true, size: 'big', borderline: false, fallback: false }];
    const res = await runChat(bigLead, {
      message: 'Redo the whole homepage with a new layout, a menu section, and an online ordering section',
      attachmentIds: [att.id],
    });
    assert.equal(res.mode, 'queued', 'big job routes to the design queue');
    assert.equal(res.mutated, false);
    assert.equal(loopCalls.length, 0, 'the chat did NOT edit a big job');
    assert.ok(res.queuedJobId > 0);
    assert.ok(res.reply.includes('bigger job'));
    assert.ok(res.reply.includes('queued'));
    assert.ok(res.reply.includes('design agent'));
    n += 7;
    bigJobId = res.queuedJobId;
    const job = realDb.prepare('SELECT * FROM design_jobs WHERE id = ?').get(bigJobId);
    assert.ok(job, 'design_jobs row exists');
    assert.equal(job.type, 'improvement');
    assert.equal(job.status, 'waiting_on_agent');
    assert.equal(Number(job.lead_id), bigLead);
    assert.ok(job.instructions.includes('Redo the whole homepage'), 'spec in instructions');
    assert.ok(job.instructions.includes(`attachment ids ${att.id}`), 'attachment reference travels');
    assert.ok(job.instructions.includes('Site context'), 'Tier-1 context in the spec');
    assert.ok(job.instructions.includes('ZZ B93 Bakery I'));
    const brief = JSON.parse(job.brief);
    assert.equal(brief.chat_origin.source, 'portal_site_chat');
    assert.deepEqual(brief.chat_origin.attachmentIds, [att.id]);
    n += 10;
    group('S(size-ii) big job → queued, site unedited by chat', n);
  }

  // S(size-iv) — claim + completion through the real design-job
  // flow writes the summary back into the chat thread.
  {
    let n = 0;
    const claimed = designJobs.claimNextAgentJob(realDb);
    assert.ok(claimed, 'a job was claimable');
    assert.equal(claimed.id, bigJobId, 'the queued chat job is the one claimed');
    n += 2;
    await designJobs.deliverJob(
      realDb,
      bigJobId,
      { summary: 'Rebuilt the hero, added the menu section, and wired up ordering.' },
      []
    );
    const status = realDb.prepare('SELECT status FROM design_jobs WHERE id = ?').get(bigJobId).status;
    assert.equal(status, 'delivered');
    const updates = sliceMod.exports.takeSiteChatUpdates(1, bigLead);
    assert.equal(updates.messages.length, 1, 'completion landed in the thread');
    assert.equal(updates.messages[0].role, 'assistant');
    assert.ok(updates.messages[0].content.includes('Rebuilt the hero'), 'agent summary is the message');
    assert.equal(updates.messages[0].jobId, bigJobId);
    const again = sliceMod.exports.takeSiteChatUpdates(1, bigLead);
    assert.equal(again.messages.length, 0, 'write-back surfaces exactly once');
    n += 6;
    group('S(size-iv) claim + deliver → summary back in chat', n);
  }

  // S(size-iii) — vague BIG request: clarification FIRST, queue
  // only after the clarified spec exists.
  {
    let n = 0;
    const lead = seedChatLead('J');
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: false, size: 'big', fallback: false }];
    const res1 = await runChat(lead, { message: 'Redo my whole site' });
    assert.equal(res1.mode, 'clarify');
    assert.equal(jobCount(lead), 0, 'no job queued before clarification');
    assert.ok(chatPending.getPending(realDb, lead));
    n += 3;
    resetTurn();
    classifyQueue = [{ intent: 'clarify_answer', ready: true, size: 'big', fallback: false }];
    const res2 = await runChat(lead, {
      message: 'Every page — new layout, warm rustic style, keep the logo',
    });
    assert.equal(res2.mode, 'queued');
    assert.equal(jobCount(lead), 1);
    const job = realDb.prepare('SELECT * FROM design_jobs WHERE lead_id = ?').get(lead);
    assert.ok(job.instructions.includes('Redo my whole site'), 'spec keeps the original request');
    assert.ok(job.instructions.includes('warm rustic'), 'spec keeps the clarification');
    n += 4;
    group('S(size-iii) vague big → clarify first, then queue', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — pending/thread stores + lead-delete sweep
  // ---------------------------------------------------------------
  {
    let n = 0;
    const lead = seedChatLead('K');
    chatPending.savePending(realDb, {
      leadId: lead,
      kind: 'clarify',
      requestText: 'Make the menu page nicer',
      questionsText: '1. Which colours?',
      answers: [],
      pageSlug: 'menu',
    });
    let pending = chatPending.getPending(realDb, lead);
    assert.equal(pending.requestText, 'Make the menu page nicer');
    assert.equal(pending.kind, 'clarify');
    assert.deepEqual(pending.answers, []);
    chatPending.savePending(realDb, { ...pending, leadId: lead, answers: ['Warm colours'] });
    pending = chatPending.getPending(realDb, lead);
    assert.deepEqual(pending.answers, ['Warm colours'], 'answers accumulate on the same row');
    chatPending.clearPending(realDb, lead);
    assert.equal(chatPending.getPending(realDb, lead), null);
    n += 5;

    const msgId = chatThread.addMessage(realDb, {
      leadId: lead,
      role: 'assistant',
      content: 'Your queued design job is done.',
      source: 'design_job',
      jobId: 42,
    });
    assert.ok(msgId > 0);
    const taken = chatThread.takeUndelivered(realDb, lead);
    assert.equal(taken.length, 1);
    assert.equal(taken[0].content, 'Your queued design job is done.');
    assert.equal(chatThread.takeUndelivered(realDb, lead).length, 0, 'delivered exactly once');
    n += 4;

    const sweepLead = seedChatLead('L');
    chatPending.savePending(realDb, {
      leadId: sweepLead,
      kind: 'either_or',
      requestText: 'the blue looks bad',
      questionsText: '',
      answers: [],
    });
    chatThread.addMessage(realDb, {
      leadId: sweepLead,
      role: 'assistant',
      content: 'queued notice',
      source: 'design_job',
      jobId: 7,
    });
    leadEngine.deleteLead(realDb, sweepLead);
    const leftPending = realDb
      .prepare('SELECT COUNT(*) AS c FROM site_chat_pending WHERE lead_id = ?')
      .get(sweepLead).c;
    const leftThread = realDb
      .prepare('SELECT COUNT(*) AS c FROM site_chat_messages WHERE lead_id = ?')
      .get(sweepLead).c;
    assert.equal(leftPending, 0, 'lead delete sweeps pending clarification');
    assert.equal(leftThread, 0, 'lead delete sweeps chat thread messages');
    n += 2;
    group('Part 3 stores round-trip + lead-delete sweep', n);
  }

  // ---------------------------------------------------------------
  // Part 4 — wiring pins (routes, UI poller, animated busy status)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const agent = fs.readFileSync(path.join(root, 'server', 'museAgent.js'), 'utf8');
    assert.ok(agent.includes('PORTAL_READONLY_TOOLS'), 'read-only allowlist ships');
    assert.ok(agent.includes('portalModeAllowsTool'), 'single fence seam ships');
    assert.ok(agent.includes('classifyPortalChatIntent'), 'classifier ships');
    assert.ok(agent.includes('spans multiple sections or pages'), 'size rubric written into the classifier prompt');
    assert.ok(agent.includes('WHOLE-SITE CONTEXT'), 'Tier-1 map injected in the loop');
    assert.ok(agent.includes('PRIORITY RULES'), 'classifier question-priority rules ship');
    assert.ok(agent.includes('is ALWAYS "question"'), 'information questions are never ambiguous');
    assert.ok(agent.includes('do not keep a clarification alive out of caution'), 'ready bar resists clarification traps');
    assert.ok(agent.includes('For BIG jobs the bar is lower, not higher'), 'big jobs are not held in clarification over taste details');
    assert.ok(agent.includes('NEVER blocks a concrete edit'), 'unanswered goal questions never block a spelled-out edit');
    n += 8;
    const portal = fs.readFileSync(path.join(root, 'server', 'clientPortal.js'), 'utf8');
    assert.ok(portal.includes('siteChatPending'), 'pending store wired into the chat');
    assert.ok(portal.includes('portal_site_chat'), 'chat-origin stamp wired');
    assert.ok(portal.includes("'improvement'"), 'queue uses the improvement job type');
    assert.ok(portal.includes('buildSiteMap'), 'Tier-1 map builder ships');
    n += 4;
    const jobs = fs.readFileSync(path.join(root, 'src', 'designJobs.js'), 'utf8');
    assert.ok(jobs.includes('chat_origin'), 'write-back hook reads the chat-origin stamp');
    assert.ok(jobs.includes('siteChatThread'), 'write-back hook writes the chat thread');
    const engine = fs.readFileSync(path.join(root, 'src', 'leadEngine.js'), 'utf8');
    assert.ok(engine.includes("drop('site_chat_pending')"), 'pending swept on lead delete');
    assert.ok(engine.includes("drop('site_chat_messages')"), 'thread swept on lead delete');
    n += 4;
    const routes = fs.readFileSync(path.join(root, 'server', 'routes', 'portal.js'), 'utf8');
    assert.ok(routes.includes("'/site/agent-chat/updates'"), 'updates endpoint routed');
    const portalJs = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');
    assert.ok(portalJs.includes('fetchAgentChatUpdates'), 'portal polls for write-backs');
    assert.ok(portalJs.includes('/site/agent-chat/updates'), 'poller hits the updates endpoint');
    n += 3;
    // Animated "Updating your site…" busy indicator (Ely): pure CSS
    // keyed on .is-busy, exact copy preserved at the send site,
    // reduced-motion honoured.
    const portalHtml = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
    assert.ok(portalHtml.includes('@keyframes agent-chat-busy-pulse'), 'busy pulse keyframes ship');
    assert.ok(portalHtml.includes('@keyframes agent-chat-busy-dot'), 'busy dot keyframes ship');
    const busyRule = portalHtml.slice(portalHtml.indexOf('.agent-chat-status.is-busy {', portalHtml.indexOf('Batch 93: while the agent is working')));
    assert.ok(busyRule.includes('animation: agent-chat-busy-pulse'), 'busy status animates while working');
    const rmIdx = portalHtml.indexOf('@media (prefers-reduced-motion: reduce)');
    assert.ok(rmIdx > 0, 'reduced-motion block ships');
    assert.ok(
      portalHtml.slice(rmIdx, rmIdx + 300).includes('.agent-chat-status.is-busy'),
      'reduced-motion covers the busy status'
    );
    assert.ok(
      portalHtml.slice(rmIdx, rmIdx + 300).includes('animation: none'),
      'reduced-motion turns the animation off'
    );
    assert.ok(
      portalJs.includes("setAgentChatStatus('Updating your site…', 'busy')"),
      'exact status copy set at turn start'
    );
    assert.ok(
      portalJs.includes("classList.toggle('is-busy', kind === 'busy')"),
      'busy class (and thus the animation) is wired to the working state'
    );
    n += 8;
    group('Part 4 wiring pins + animated busy indicator', n);
  }

  fs.rmSync(temp, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: true, groups, negative: NEGATIVE || null }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
