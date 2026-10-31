'use strict';
/**
 * Batch 94 — the builder chat stops asking silly questions.
 *
 * Ely's complaint (2026-10-30, real transcript): "entire site, H3s
 * darker" drew three questions (exact shade? every page? fonts +
 * dark-section handling?); "just make them black" drew the SAME
 * three again; "they are not" drew three more; "in the dark make
 * them light cream" drew three more. Four rounds, zero edits.
 *
 * Root causes fixed:
 *   1. No defaults — every underspecified dimension became a
 *      question. Fix: a DEFAULTS DOCTRINE in the classifier +
 *      clarify + build prompts (stated scope is settled; colour-only
 *      changes keep fonts; contrast on dark sections is a rule;
 *      "black"/"darker" = #000000; palette tones come from the
 *      site's own context, never a hex-code question).
 *   2. Settled answers were not binding — pending state stored raw
 *      Q&A but no settled dimensions, and the clarify prompt never
 *      saw them, so it regenerated the same checklist. Fix:
 *      site_chat_pending.settled_json + rounds; the classifier
 *      reports the facts each message settles; settled facts ride
 *      the classifier prompt, the clarify prompt, and the build
 *      spec as binding.
 *   3. No convergence pressure — every not-ready verdict asked
 *      again. Fix: the CONVERGENCE SEAM in runSiteAgentChat — one
 *      clarification round per change; once rounds >= 1, a further
 *      answer implements with defaults unless the classifier flags
 *      a genuinely NEW ambiguity (newAmbiguity).
 *   4. Terse replies misread — imperatives/corrections are now
 *      routed as answers that settle dimensions (classifier
 *      doctrine), and the completion summary must STATE the
 *      defaults it applied (correction-after, not questions-before).
 *
 * NEGATIVE PROOF (batch89/93 convention — the suite must go RED):
 *   B94_NEGATIVE=defaults  the convergence seam is shimmed off
 *                          (rounds >= 999) → the stubborn-classifier
 *                          H3 arc in S(i) asks a second round
 *                          instead of implementing on turn 2.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b94-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch94', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const NEGATIVE = process.env.B94_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

function loadAgentSource() {
  return fs.readFileSync(path.join(root, 'server', 'museAgent.js'), 'utf8');
}

function loadPortalSliceSource() {
  const src = fs.readFileSync(path.join(root, 'server', 'clientPortal.js'), 'utf8');
  const start = src.indexOf('async function runSiteAgentChat(');
  const end = src.indexOf('/**', start);
  assert.ok(start > 0 && end > start, 'slice bounds found');
  return src.slice(start, end);
}

// The planner module, optionally shimmed for the negative proof:
// B94_NEGATIVE=defaults raises the convergence budget so the seam
// can never fire — the shipped bug (endless question rounds) must
// come back in scenario S(i).
function loadPlannerModule() {
  let src = fs.readFileSync(path.join(root, 'server', 'siteChatPlanner.js'), 'utf8');
  if (NEGATIVE === 'defaults') {
    const shimmed = src.replace(
      'const CONVERGENCE_ROUNDS = 1;',
      'const CONVERGENCE_ROUNDS = 999; // B94 NEGATIVE SHIM — convergence seam disabled'
    );
    assert.notEqual(shimmed, src, 'defaults shim must change the planner source');
    src = shimmed;
  }
  const m = { exports: {} };
  vm.runInNewContext(src + ';module.exports = module.exports;', {
    module: m,
    exports: m.exports,
    console,
    Buffer,
    process,
    require: (name) => require(name.startsWith('.') ? path.join(root, 'server', name) : name),
  });
  return m.exports;
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
  const chatPending = require(path.join(root, 'server', 'siteChatPending.js'));
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
  const systemText = (req) =>
    (req.messages || [])
      .filter((mm) => mm.role === 'system')
      .map((mm) => String(mm.content))
      .join('\n');

  // ---------------------------------------------------------------
  // Part 1 — museAgent: classifier fields + prompt doctrine
  // ---------------------------------------------------------------
  function loopFixture(handler) {
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

  // 1a. Classifier parses settled + new_ambiguity; fallback is safe.
  {
    let n = 0;
    const f = loopFixture(() =>
      textReply(
        '{"intent":"clarify_answer","ready":true,"size":"small","settled":["H3 colour: black #000000"],"new_ambiguity":false}'
      )
    );
    const res = await f.agent.classifyPortalChatIntent(1, 7, {
      db: stubDb(),
      message: 'just make them black',
      pending: { requestText: 'entire site, H3s darker', kind: 'clarify', answers: [], settled: ['scope: entire site'], rounds: 1 },
    });
    assert.equal(res.intent, 'clarify_answer');
    assert.equal(res.ready, true);
    assert.equal(
      (res.settled || []).join('|'),
      'H3 colour: black #000000',
      'settled facts parsed from the model reply'
    );
    assert.equal(res.newAmbiguity, false);
    n += 4;
    const f2 = loopFixture(() => textReply('{"intent":"clarify_answer","ready":false,"new_ambiguity":true}'));
    const res2 = await f2.agent.classifyPortalChatIntent(1, 7, {
      db: stubDb(),
      message: 'actually also add a booking button somewhere',
      pending: { requestText: 'Make it pop', kind: 'clarify', answers: [], settled: [], rounds: 1 },
    });
    assert.equal(res2.newAmbiguity, true, 'new_ambiguity parsed');
    assert.equal((res2.settled || []).length, 0, 'settled defaults to [] when absent');
    n += 2;
    const f3 = loopFixture(() => textReply('unparseable'));
    const res3 = await f3.agent.classifyPortalChatIntent(1, 7, { db: stubDb(), message: 'x' });
    assert.equal(res3.fallback, true);
    assert.equal((res3.settled || []).length, 0);
    assert.equal(res3.newAmbiguity, false);
    n += 3;
    group('1a classifier: settled + new_ambiguity fields', n);
  }

  // 1b. The classifier prompt carries the defaults doctrine, the
  // settled facts, the rounds budget, and the terse-reply rule.
  {
    let n = 0;
    const f = loopFixture(() => textReply('{"intent":"question","ready":false}'));
    await f.agent.classifyPortalChatIntent(1, 7, {
      db: stubDb(),
      message: 'just make them black',
      pending: {
        requestText: 'entire site, H3s darker',
        kind: 'clarify',
        answers: [],
        settled: ['scope: entire site'],
        rounds: 1,
      },
    });
    const sys = systemText(f.requests[0]);
    assert.ok(sys.includes('DEFAULTS DOCTRINE'), 'defaults doctrine ships in the classifier prompt');
    assert.ok(sys.includes('pure black #000000'), 'black default pinned');
    assert.ok(sys.includes('Contrast is a RULE, never a question'), 'contrast is a rule, not a question');
    assert.ok(sys.includes('choose between hex codes'), 'hex-code questions banned');
    assert.ok(sys.includes('Scope the owner stated is SETTLED'), 'stated scope is settled');
    assert.ok(sys.includes('SETTLED for this change'), 'settled facts rendered into the prompt');
    assert.ok(sys.includes('scope: entire site'), 'the settled fact itself rides');
    assert.ok(sys.includes('Clarification rounds already used for this change: 1'), 'rounds budget rendered');
    assert.ok(sys.includes('TERSE REPLIES ARE ANSWERS'), 'terse imperatives are answers');
    assert.ok(sys.includes('do not keep a clarification alive out of caution'), 'anti-caution line present');
    n += 10;
    group('1b classifier prompt: doctrine + settled + rounds', n);
  }

  // 1c. Clarify prompt: one round, settled/prior-aware, defaults.
  {
    let n = 0;
    const f = loopFixture(() => textReply('1. Which page should the button go on?'));
    const res = await f.agent.runPortalImproveLoop(1, 7, {
      db: stubDb(),
      message: 'Add the button',
      mode: 'clarify',
      clarifyAbout: 'Add a booking button',
      clarifyKind: 'open',
      clarifySettled: ['scope: entire site'],
      clarifyPriorQa: { questionsText: '1. What should it book?', answers: ['Table reservations'] },
      clarifyRound: 2,
    });
    assert.equal(res.mode, 'clarify');
    assert.equal(res.mutated, false);
    const sys = systemText(f.requests.find((r) => r.tools) || f.requests[0]);
    assert.ok(sys.includes('AT MOST 3 questions'), 'question cap stated');
    assert.ok(sys.includes('LAST round of questions'), 'one-round policy stated');
    assert.ok(sys.includes('clarification round 2'), 'round number rendered');
    assert.ok(sys.includes('Already settled — do NOT ask about these again'), 'settled block rendered');
    assert.ok(sys.includes('scope: entire site'));
    assert.ok(sys.includes('You already asked'), 'prior Q&A rendered');
    assert.ok(sys.includes('Do not repeat any of those questions'), 'no-repeat rule stated');
    assert.ok(sys.includes('never ask the owner to pick between hex codes'), 'clarify defaults recap present');
    const offered = (f.requests.find((r) => r.tools) || { tools: [] }).tools.map((t) => t.function.description);
    for (const w of WRITES) assert.ok(!offered.includes(w), 'clarify still offers no write tools');
    n += 11;
    group('1c clarify prompt: one round, settled-aware', n);
  }

  // 1d. Build prompt: defaults applied + disclosed in the summary.
  {
    let n = 0;
    const f = loopFixture((body, i) => {
      if (i === 1) return toolReply(wire(body, 'site.editText'));
      return textReply('Done. Defaults applied: fonts unchanged.');
    });
    const res = await f.agent.runPortalImproveLoop(1, 7, {
      db: stubDb(),
      message: 'entire site, H3s darker',
      mode: 'build',
    });
    assert.equal(res.mutated, true);
    const sys = systemText(f.requests[0]);
    assert.ok(sys.includes('Design defaults — apply these without asking'), 'build defaults doctrine ships');
    assert.ok(sys.includes('pure black #000000'), 'build black default pinned');
    assert.ok(sys.includes('Defaults applied:'), 'summary must disclose defaults');
    assert.ok(sys.includes('correct a default afterwards'), 'correction-after model stated');
    n += 5;
    group('1d build prompt: defaults applied + disclosed', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — runSiteAgentChat routing (real slice; scripted
  // classifier + loop; REAL pending store on the fixture DB).
  // ---------------------------------------------------------------
  const siteModules = require(path.join(root, 'server', 'siteModules.js'));
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
      .run(`ZZ B94 Bakery ${label}`, 'Bakery', '(610) 555-0194');
    const leadId = Number(info.lastInsertRowid);
    fixtureSites[leadId] = { id: 6000 + leadId, pages: FIXTURE_PAGES, theme: FIXTURE_THEME };
    return leadId;
  };

  let classifyQueue = [];
  let classifyCalls = [];
  let loopCalls = [];
  const fakeMuseAgent = {
    classifyPortalChatIntent: async (_ws, _lead, opts) => {
      classifyCalls.push(opts);
      if (!classifyQueue.length) throw new Error('classify queue empty');
      return classifyQueue.shift();
    },
    runPortalImproveLoop: async (_ws, _lead, opts) => {
      loopCalls.push(opts);
      const base = { steps: 1, model: 'fixture-model', imagesSent: false, imagesDropped: false };
      if (opts.mode === 'build') {
        return {
          ...base,
          reply: 'Done — headings updated. Defaults applied: H3s pure black on light sections; dark sections keep the site’s light cream.',
          mutated: true,
          published: true,
          toolCalls: 2,
        };
      }
      if (opts.mode === 'clarify') {
        return {
          ...base,
          reply: 'Quick questions:\n1. What exactly should change?\n2. Where?',
          mutated: false,
          published: false,
          toolCalls: 0,
        };
      }
      return { ...base, reply: 'Your H3s are currently a dark ink.', mutated: false, published: false, toolCalls: 1 };
    },
  };
  const resetTurn = () => {
    classifyQueue = [];
    classifyCalls = [];
    loopCalls = [];
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
        : name === './siteChatPlanner'
          ? loadPlannerModule()
          : name === './domain'
            ? { withDb: (_ws, fn) => fn(realDb) }
            : require(name.startsWith('.') ? path.join(root, 'server', name) : name),
  });
  const runChat = (leadId, body) => sliceMod.exports.runSiteAgentChat(1, leadId, body);
  const jobCount = (leadId) =>
    realDb.prepare('SELECT COUNT(*) AS c FROM design_jobs WHERE lead_id = ?').get(leadId).c;

  // S(i) — Ely's arc, compressed, against a STUBBORN classifier
  // that keeps saying ready=false (the shipped behaviour). The
  // structure must converge anyway: ONE clarify round, then the
  // terse answer implements. Under B94_NEGATIVE=defaults the seam
  // is off and turn 2 clarifies again — this group goes RED.
  {
    let n = 0;
    const lead = seedChatLead('M');
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: false, size: 'small', settled: ['scope: entire site'], fallback: false }];
    const res1 = await runChat(lead, { message: 'entire site, H3s darker' });
    assert.equal(res1.mode, 'clarify', 'turn 1 may use its ONE clarification round');
    assert.equal(res1.mutated, false);
    assert.equal(loopCalls.length, 1);
    assert.equal(loopCalls[0].mode, 'clarify');
    assert.equal(loopCalls[0].clarifyRound, 1);
    assert.ok(loopCalls[0].clarifySettled.includes('scope: entire site'), 'settled scope reaches the clarify prompt');
    n += 6;
    const pending = chatPending.getPending(realDb, lead);
    assert.ok(pending, 'pending persisted');
    assert.equal(pending.rounds, 1, 'round counted on the pending row');
    assert.deepEqual(pending.settled, ['scope: entire site'], 'settled scope persisted');
    n += 3;

    resetTurn();
    classifyQueue = [
      { intent: 'clarify_answer', ready: false, size: 'small', settled: ['H3 colour: black #000000'], fallback: false },
    ];
    const res2 = await runChat(lead, { message: 'just make them black' });
    assert.equal(classifyCalls[0].pending.rounds, 1, 'classifier saw the used round');
    assert.ok(classifyCalls[0].pending.settled.includes('scope: entire site'), 'classifier saw settled facts');
    assert.equal(res2.mode, 'build', 'turn 2 MUST implement — the round budget is spent');
    assert.equal(res2.mutated, true);
    assert.equal(loopCalls.length, 1, 'no second clarify loop run');
    assert.equal(loopCalls[0].mode, 'build');
    assert.ok(loopCalls[0].message.includes('entire site, H3s darker'), 'spec keeps the original request');
    assert.ok(loopCalls[0].message.includes('just make them black'), 'spec keeps the answer');
    assert.ok(loopCalls[0].message.includes('Settled decisions (binding'), 'spec carries settled facts as binding');
    assert.ok(loopCalls[0].message.includes('H3 colour: black #000000'), 'newly settled colour rides the spec');
    assert.equal(chatPending.getPending(realDb, lead), null, 'pending cleared after implementation');
    assert.equal(jobCount(lead), 0, 'small job, no design_jobs row');
    n += 11;
    group('S(i) H3 arc vs stubborn classifier → implemented by turn 2', n);
  }

  // S(ii) — the FULL four-turn arc with a cooperative classifier:
  // exactly ONE question round in four turns; turns 3–4 are fresh
  // micro-changes that implement directly (no checklists return).
  {
    let n = 0;
    const lead = seedChatLead('N');
    const modes = [];
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: false, size: 'small', settled: ['scope: entire site'], fallback: false }];
    const r1 = await runChat(lead, { message: 'entire site, H3s darker' });
    modes.push(loopCalls[0].mode);
    assert.equal(r1.mode, 'clarify');
    resetTurn();
    classifyQueue = [
      { intent: 'clarify_answer', ready: true, size: 'small', settled: ['H3 colour: black #000000'], fallback: false },
    ];
    const r2 = await runChat(lead, { message: 'just make them black' });
    modes.push(loopCalls[0].mode);
    assert.equal(r2.mode, 'build');
    assert.equal(chatPending.getPending(realDb, lead), null);
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: true, size: 'small', fallback: false }];
    const r3 = await runChat(lead, { message: 'they are not' });
    modes.push(loopCalls[0].mode);
    assert.equal(r3.mode, 'build', 'a state correction proceeds — no new checklist');
    assert.equal(chatPending.getPending(realDb, lead), null, 'no pending resurrected by a correction');
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: true, size: 'small', fallback: false }];
    const r4 = await runChat(lead, { message: 'in the dark make them light cream' });
    modes.push(loopCalls[0].mode);
    assert.equal(r4.mode, 'build', 'the dark-section follow-up implements directly');
    assert.deepEqual(modes, ['clarify', 'build', 'build', 'build'], 'one question round in the whole arc');
    n += 8;
    group('S(ii) full 4-turn arc → one round, then all action', n);
  }

  // S(iii) — a genuinely blocking ambiguity still gets its ONE
  // round, then the answer implements.
  {
    let n = 0;
    const lead = seedChatLead('O');
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: false, size: 'small', fallback: false }];
    const res1 = await runChat(lead, { message: 'Add a booking button' });
    assert.equal(res1.mode, 'clarify', 'blocking ambiguity (where? books what?) still clarifies');
    assert.equal(chatPending.getPending(realDb, lead).rounds, 1);
    n += 2;
    resetTurn();
    classifyQueue = [{ intent: 'clarify_answer', ready: true, size: 'small', fallback: false }];
    const res2 = await runChat(lead, { message: 'On the services page — it should book a table' });
    assert.equal(res2.mode, 'build');
    assert.equal(loopCalls[0].mode, 'build');
    assert.equal(chatPending.getPending(realDb, lead), null);
    n += 3;
    group('S(iii) blocking ambiguity → one round → implement', n);
  }

  // S(iv) — vague BIG request: clarify once, then QUEUE (Batch 93
  // size routing intact under the new policy).
  {
    let n = 0;
    const lead = seedChatLead('P');
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: false, size: 'big', fallback: false }];
    const res1 = await runChat(lead, { message: 'Redo my whole site' });
    assert.equal(res1.mode, 'clarify');
    assert.equal(jobCount(lead), 0, 'nothing queued before clarification');
    n += 2;
    resetTurn();
    classifyQueue = [{ intent: 'clarify_answer', ready: true, size: 'big', fallback: false }];
    const res2 = await runChat(lead, { message: 'Every page — new layout, warm rustic style' });
    assert.equal(res2.mode, 'queued');
    assert.equal(jobCount(lead), 1);
    const job = realDb.prepare('SELECT * FROM design_jobs WHERE lead_id = ?').get(lead);
    assert.equal(job.status, 'waiting_on_agent');
    assert.ok(job.instructions.includes('Redo my whole site'));
    assert.ok(job.instructions.includes('warm rustic'));
    n += 5;
    group('S(iv) vague big → clarify once → queued', n);
  }

  // S(v) — question turns still edit nothing (Batch 93 intact).
  {
    let n = 0;
    const lead = seedChatLead('Q');
    resetTurn();
    classifyQueue = [{ intent: 'question', ready: false, fallback: false }];
    const res = await runChat(lead, { message: 'What colour are my headings?' });
    assert.equal(res.mode, 'answer');
    assert.equal(res.mutated, false);
    assert.equal(loopCalls[0].mode, 'answer');
    assert.equal(chatPending.getPending(realDb, lead), null);
    assert.equal(jobCount(lead), 0);
    n += 5;
    group('S(v) question → answer only, no edits', n);
  }

  // S(vi) — a second round is allowed ONLY when the answer opens
  // a genuinely new decision (newAmbiguity); after that, the cap
  // bites again and the next answer implements.
  {
    let n = 0;
    const lead = seedChatLead('R');
    const modes = [];
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: false, size: 'small', fallback: false }];
    await runChat(lead, { message: 'Make it pop' });
    modes.push(loopCalls[0].mode);
    assert.equal(chatPending.getPending(realDb, lead).rounds, 1);
    resetTurn();
    classifyQueue = [{ intent: 'clarify_answer', ready: false, newAmbiguity: true, fallback: false }];
    const res2 = await runChat(lead, { message: 'Focus on the hero' });
    modes.push(loopCalls[0].mode);
    assert.equal(res2.mode, 'clarify', 'a genuinely new ambiguity earns exactly one more round');
    assert.equal(loopCalls[0].clarifyRound, 2, 'second round is numbered as such');
    assert.ok(loopCalls[0].clarifyPriorQa, 'prior Q&A rides the second round');
    assert.ok(String(loopCalls[0].clarifyPriorQa.questionsText).includes('What exactly'), 'first-round questions carried');
    assert.equal(chatPending.getPending(realDb, lead).rounds, 2);
    n += 6;
    resetTurn();
    classifyQueue = [{ intent: 'clarify_answer', ready: false, fallback: false }];
    const res3 = await runChat(lead, { message: 'Warm colours, big headline' });
    modes.push(loopCalls[0].mode);
    assert.equal(res3.mode, 'build', 'after the extra round the cap bites — implement');
    assert.deepEqual(modes, ['clarify', 'clarify', 'build']);
    assert.equal(chatPending.getPending(realDb, lead), null);
    n += 3;
    group('S(vi) second round only for NEW ambiguity, then cap', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — pending store: settled/rounds round-trip, merge
  // semantics, and the Batch 93 → 94 table migration.
  // ---------------------------------------------------------------
  {
    let n = 0;
    const lead = seedChatLead('T');
    chatPending.savePending(realDb, {
      leadId: lead,
      kind: 'clarify',
      requestText: 'entire site, H3s darker',
      questionsText: '1. What shade?',
      answers: [],
      settled: ['scope: entire site'],
      rounds: 1,
    });
    let pending = chatPending.getPending(realDb, lead);
    assert.deepEqual(pending.settled, ['scope: entire site']);
    assert.equal(pending.rounds, 1);
    n += 2;
    const merged = chatPending.mergeSettledFacts(pending.settled, ['H3 colour: black #000000', 'SCOPE: ENTIRE SITE']);
    assert.deepEqual(
      merged,
      ['scope: entire site', 'H3 colour: black #000000'],
      'duplicates collapse case-insensitively, new facts append'
    );
    const replaced = chatPending.mergeSettledFacts(['H3 colour: #141414'], ['H3 colour: black #000000']);
    assert.deepEqual(replaced, ['H3 colour: black #000000'], 'same dimension, new value replaces the old');
    n += 2;
    chatPending.savePending(realDb, { ...pending, leadId: lead, settled: merged, rounds: 2 });
    pending = chatPending.getPending(realDb, lead);
    assert.equal(pending.rounds, 2);
    assert.deepEqual(pending.settled, merged);
    n += 2;

    // Migration: a Batch-93-shaped table (no settled/rounds
    // columns) gains them via ensureTable, rows default cleanly.
    const migDb = new (require(path.join(root, 'node_modules', 'better-sqlite3')))(path.join(temp, 'mig.sqlite'));
    migDb.exec(`
      CREATE TABLE site_chat_pending (
        lead_id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'clarify',
        request_text TEXT NOT NULL,
        questions_text TEXT,
        answers_json TEXT NOT NULL DEFAULT '[]',
        page_slug TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO site_chat_pending (lead_id, request_text) VALUES (5, 'legacy pending');
    `);
    const legacy = chatPending.getPending(migDb, 5);
    assert.equal(legacy.requestText, 'legacy pending');
    assert.deepEqual(legacy.settled, [], 'legacy row reads settled as []');
    assert.equal(legacy.rounds, 0, 'legacy row reads rounds as 0');
    chatPending.savePending(migDb, {
      leadId: 5,
      kind: 'clarify',
      requestText: 'legacy pending',
      questionsText: 'q',
      answers: [],
      settled: ['scope: entire site'],
      rounds: 1,
    });
    const after = chatPending.getPending(migDb, 5);
    assert.equal(after.rounds, 1, 'migrated table stores rounds');
    assert.deepEqual(after.settled, ['scope: entire site']);
    migDb.close();
    n += 5;
    group('Part 3 pending store: settled/rounds + migration', n);
  }

  // ---------------------------------------------------------------
  // Part 4 — wiring pins
  // ---------------------------------------------------------------
  {
    let n = 0;
    const agent = fs.readFileSync(path.join(root, 'server', 'museAgent.js'), 'utf8');
    assert.ok(agent.includes('CLASSIFIER_DOCTRINE_LINES'), 'classifier consumes the planner doctrine');
    assert.ok(agent.includes('TERSE REPLIES ARE ANSWERS'), 'terse-reply doctrine ships');
    assert.ok(agent.includes('new_ambiguity'), 'classifier emits new_ambiguity');
    assert.ok(agent.includes('AT MOST 3 questions'), 'clarify cap ships');
    assert.ok(agent.includes("'theme.styleRule'"), 'style rule tool is in the mutate set');
    assert.ok(agent.includes('portalCapabilityText'), 'capability registry wired into prompts');
    n += 6;
    const plannerSrc = fs.readFileSync(path.join(root, 'server', 'siteChatPlanner.js'), 'utf8');
    assert.ok(plannerSrc.includes('DEFAULTS DOCTRINE'), 'planner owns the defaults doctrine');
    assert.ok(plannerSrc.includes('Design defaults — apply these without asking'), 'planner owns the build defaults');
    assert.ok(plannerSrc.includes('Defaults applied:'), 'planner owns the disclosure line');
    assert.ok(plannerSrc.includes('shouldForceReady'), 'planner owns the convergence policy');
    assert.ok(plannerSrc.includes('resolveNamedColour'), 'planner owns named-colour resolution');
    n += 5;
    const mcpSrc = fs.readFileSync(path.join(root, 'server', 'clientMcp.js'), 'utf8');
    assert.ok(mcpSrc.includes("name: 'theme.styleRule'"), 'style rule tool defined in the client registry');
    assert.ok(mcpSrc.includes('applyClientStyleRule'), 'style rule dispatch wired');
    n += 2;
    const portal = fs.readFileSync(path.join(root, 'server', 'clientPortal.js'), 'utf8');
    assert.ok(portal.includes('CONVERGENCE SEAM'), 'convergence seam ships in the router');
    assert.ok(portal.includes('mergeSettledFacts'), 'settled merge wired');
    assert.ok(portal.includes('clarifySettled'), 'settled facts reach the clarify loop');
    assert.ok(portal.includes('Settled decisions (binding'), 'settled facts ride the build spec');
    n += 4;
    const store = fs.readFileSync(path.join(root, 'server', 'siteChatPending.js'), 'utf8');
    assert.ok(store.includes('settled_json'), 'settled column ships');
    assert.ok(store.includes('ALTER TABLE site_chat_pending ADD COLUMN'), 'migration ships');
    n += 2;
    group('Part 4 wiring pins', n);
  }

  // ---------------------------------------------------------------
  // Part 5 — styleRules + planner units (the implementor core and
  // the planner policy, both pure modules)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const styleRules = require(path.join(root, 'server', 'styleRules.js'));
    const planner = loadPlannerModule();
    assert.equal(styleRules.validateSelector('h3'), 'h3');
    assert.equal(styleRules.validateSelector('H3'), 'h3');
    assert.equal(
      styleRules.validateSelector('section[data-ws-section-type="hero"] h3'),
      'section[data-ws-section-type="hero"] h3'
    );
    assert.equal(styleRules.validateSelector('.price-card'), '.price-card');
    assert.equal(styleRules.validateSelector('div > p'), null, 'combinators rejected');
    assert.equal(styleRules.validateSelector('#main'), null, 'id selectors rejected');
    assert.equal(styleRules.validateSelector('h3, p'), null, 'selector lists rejected');
    assert.equal(styleRules.validateSelector('script'), null, 'non-styleable tags rejected');
    assert.equal(styleRules.validateSelector('h3:hover'), null, 'pseudo-classes rejected');
    n += 9;
    assert.deepEqual(styleRules.validateDeclaration('color', '#ABC'), { property: 'color', value: '#aabbcc' });
    assert.throws(() => styleRules.validateDeclaration('color', 'red'), (e) => e.code === 'INVALID_VALUE');
    assert.throws(() => styleRules.validateDeclaration('position', 'absolute'), (e) => e.code === 'INVALID_PROPERTY');
    assert.deepEqual(styleRules.validateDeclaration('font-size', '20px'), { property: 'font-size', value: '20px' });
    assert.throws(() => styleRules.validateDeclaration('font-size', '20'), (e) => e.code === 'INVALID_VALUE');
    assert.deepEqual(styleRules.validateDeclaration('font-weight', '700'), { property: 'font-weight', value: '700' });
    n += 6;
    let css = 'body { margin: 0; }';
    css = styleRules.upsertStyleRule(css, { selector: 'h3', property: 'color', value: '#000' });
    assert.ok(css.includes('h3 { color: #000000; }'), 'rule written into the managed block');
    assert.ok(css.startsWith('body { margin: 0; }'), 'author CSS preserved');
    css = styleRules.upsertStyleRule(css, { selector: 'h3', property: 'font-weight', value: '700' });
    assert.ok(css.includes('h3 { color: #000000; font-weight: 700; }'), 'second declaration joins the same rule');
    css = styleRules.upsertStyleRule(css, { selector: 'h3', property: 'color', value: '#444444' });
    assert.ok(css.includes('color: #444444;') && !css.includes('#000000'), 're-applying replaces the value');
    css = styleRules.upsertStyleRule(css, { selector: 'h3', property: 'color', value: null });
    css = styleRules.upsertStyleRule(css, { selector: 'h3', property: 'font-weight', value: null });
    assert.ok(!css.includes('chat-rules'), 'removing the last declaration removes the block');
    assert.throws(
      () => styleRules.upsertStyleRule('', { selector: 'h3', property: 'color', value: 'red; } body { display: none' }),
      (e) => e.code === 'INVALID_VALUE',
      'CSS injection through a value is rejected'
    );
    assert.throws(
      () => styleRules.upsertStyleRule('', { selector: 'h3 } body {', property: 'color', value: '#000000' }),
      (e) => e.code === 'INVALID_SELECTOR',
      'CSS injection through a selector is rejected'
    );
    n += 8;
    // Planner: named colours resolve by default — never a question.
    // (Field-wise compares: the planner is VM-loaded, cross-realm.)
    const rc = (name, theme) => {
      const r = planner.resolveNamedColour(name, theme);
      return r ? `${r.hex}|${r.source}` : null;
    };
    assert.equal(rc('dark grey', {}), '#444444|standard');
    assert.equal(rc('dark grey', { secondary: '#141414' }), '#141414|site');
    assert.equal(rc('dark grey', { secondary: '#eeeeee' }), '#444444|standard', 'a light site tone is not passed off as dark grey');
    assert.equal(rc('black', {}), '#000000|standard');
    assert.equal(rc('cream', { paper: '#F6F6F4' }), '#f6f6f4|site');
    assert.equal(rc('banana', {}), null);
    n += 6;
    // Planner: convergence policy matrix.
    const pend = (rounds, kind = 'clarify') => ({ kind, rounds });
    const cls = (intent, newAmbiguity = false) => ({ intent, newAmbiguity });
    if (NEGATIVE !== 'defaults') {
      assert.equal(planner.shouldForceReady(pend(1), cls('clarify_answer')), true);
      assert.equal(planner.shouldForceReady(pend(0), cls('clarify_answer')), false, 'round budget not yet used');
      assert.equal(planner.shouldForceReady(pend(1), cls('clarify_answer', true)), false, 'new ambiguity earns its round');
      assert.equal(planner.shouldForceReady(pend(1), cls('question')), false, 'questions never force-build');
      assert.equal(planner.shouldForceReady(pend(0, 'either_or'), cls('clarify_answer')), true, 'the either/or question IS the one round — a substantive reply resolves it');
      assert.equal(planner.shouldForceReady(pend(0, 'either_or'), cls('question')), false, 'a side question never forces an either/or');
      assert.equal(planner.shouldForceReady(null, cls('change')), false);
      n += 7;
    }
    group('Part 5 style rules + planner units', n);
  }

  // ---------------------------------------------------------------
  // Part 6 — capability registry: claims derive from the tools
  // actually offered (defect 2: refusal/claim contradiction)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const caps = require(path.join(root, 'server', 'portalCapabilities.js'));
    const clientMcp = require(path.join(root, 'server', 'clientMcp.js'));
    const allNames = clientMcp.portalToolDefs().map((t) => t.name);
    assert.ok(allNames.includes('theme.styleRule'), 'the style tool is in the served registry');
    const withStyle = caps.portalCapabilityLines(allNames);
    assert.ok(
      withStyle.some((l) => l.includes('H3') && l.includes('SPECIFIC elements')),
      'capability list claims per-element styling — because the tool exists'
    );
    const withoutStyle = caps.portalCapabilityLines(allNames.filter((x) => x !== 'theme.styleRule'));
    assert.ok(
      !withoutStyle.some((l) => l.includes('SPECIFIC elements')),
      'remove the tool and the claim disappears — one source of truth'
    );
    assert.ok(caps.portalCapabilityText(allNames).includes('single source of truth'));
    n += 4;
    // The SAME registry text reaches the answer prompt (the "what
    // changes can you make" surface) and the build prompt.
    const f = loopFixture(() => textReply('Here is what I can do.'));
    const buildRes = await f.agent.runPortalImproveLoop(1, 999, { db: stubDb(), message: 'change all h3 to dark grey', history: [] });
    assert.equal(buildRes.ok, true);
    const buildSys = systemText(f.requests[0]);
    assert.ok(buildSys.includes('Per-element styling is a SMALL in-chat job'), 'build prompt teaches the style tool');
    assert.ok(buildSys.includes('YOUR CAPABILITIES'), 'build prompt carries the registry text');
    n += 3;
    const f2 = loopFixture(() => textReply('I can edit text, colours, and per-element styling.'));
    const ansRes = await f2.agent.runPortalImproveLoop(1, 999, { db: stubDb(), message: 'what changes can you make', history: [], mode: 'answer' });
    assert.equal(ansRes.ok, true);
    const ansSys = systemText(f2.requests[0]);
    assert.ok(ansSys.includes('YOUR CAPABILITIES'), 'answer prompt carries the same registry text');
    assert.ok(ansSys.includes('answer from the capabilities list'), 'answer mode is grounded in the registry');
    n += 3;
    group('Part 6 capability registry consistency', n);
  }

  // ---------------------------------------------------------------
  // S(i)2 — "change all h3 to dark grey" (Ely's second
  // transcript): implemented IN-CHAT on turn 1 through the real
  // style-rule dispatch — no queue, no question, the applied
  // colour named. Under B94_NEGATIVE=stylerule the registry view
  // loses the tool, the loop falls back to the shipped refusal,
  // and this group goes RED.
  // ---------------------------------------------------------------
  {
    let n = 0;
    const lead = seedChatLead('GREY');
    realDb
      .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
      .run(lead, 'ZZ B94 Grey', 'draft', JSON.stringify(FIXTURE_PAGES), JSON.stringify(FIXTURE_THEME));
    const clientMcp = require(path.join(root, 'server', 'clientMcp.js'));
    let registryNames = clientMcp.portalToolDefs().map((t) => t.name);
    if (NEGATIVE === 'stylerule') registryNames = registryNames.filter((x) => x !== 'theme.styleRule');
    const plannerReal = require(path.join(root, 'server', 'siteChatPlanner.js'));
    const portalReal = require(path.join(root, 'server', 'clientPortal.js'));
    const origLoop = fakeMuseAgent.runPortalImproveLoop;
    fakeMuseAgent.runPortalImproveLoop = async (_ws, leadArg, opts) => {
      if (opts.mode !== 'build') return origLoop(_ws, leadArg, opts);
      if (!registryNames.includes('theme.styleRule')) {
        // The shipped behaviour: refuse + claim it must be queued.
        return {
          steps: 1, model: 'fixture-model', imagesSent: false, imagesDropped: false,
          reply: "I couldn't change just the H3s — my editing tools only change overall text colors, not H3-specific styling. Your request is queued as a design update.",
          mutated: false, published: false, toolCalls: 0,
        };
      }
      const row = realDb.prepare('SELECT theme FROM websites WHERE lead_id = ?').get(leadArg);
      const resolved = plannerReal.resolveNamedColour('dark grey', JSON.parse(row.theme || '{}'));
      await portalReal.applyClientStyleRule(1, leadArg, { selector: 'h3', property: 'color', value: resolved.hex });
      return {
        steps: 2, model: 'fixture-model', imagesSent: false, imagesDropped: false,
        reply: `Done — made all H3s dark grey ${resolved.hex} across the whole site.`,
        mutated: true, published: true, toolCalls: 2,
      };
    };
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: true, size: 'small', settled: ['H3 colour: dark grey'], fallback: false }];
    const res = await runChat(lead, { message: 'change all h3 to dark grey' });
    fakeMuseAgent.runPortalImproveLoop = origLoop;
    assert.equal(res.mode, 'build', 'turn 1 implements in-chat');
    assert.equal(res.mutated, true, 'the style rule was applied');
    assert.equal(jobCount(lead), 0, 'NO design_jobs row — nothing queued for lack of tools');
    const themeRow = realDb.prepare('SELECT theme FROM websites WHERE lead_id = ?').get(lead);
    const themeObj = JSON.parse(themeRow.theme || '{}');
    assert.ok(
      String(themeObj.customCss || '').includes('h3 { color: #444444; }'),
      'an H3-scoped rule with the resolved dark grey exists in the site stylesheet'
    );
    assert.ok(String(res.reply).includes('#444444'), 'completion message names the applied colour');
    assert.ok(!String(res.reply).includes('?'), 'no question was asked');
    n += 6;
    group('S(i)2 H3 dark grey → in-chat style rule on turn 1', n);
  }

  // ---------------------------------------------------------------
  // S(vii) — CROSS-SITE ISOLATION (Ely's hard rule): site A's
  // pending/settled state and style rules are invisible to site
  // B's chat — same workspace, different websites.
  // ---------------------------------------------------------------
  {
    let n = 0;
    const leadA = seedChatLead('ISO-A');
    const leadB = seedChatLead('ISO-B');
    for (const [lead, nm] of [[leadA, 'ISO A'], [leadB, 'ISO B']]) {
      realDb
        .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
        .run(lead, `ZZ B94 ${nm}`, 'draft', JSON.stringify(FIXTURE_PAGES), JSON.stringify(FIXTURE_THEME));
    }
    resetTurn();
    classifyQueue = [{ intent: 'change', ready: false, size: 'small', settled: ['scope: entire site'], fallback: false }];
    const resA = await runChat(leadA, { message: 'entire site, H3s darker' });
    assert.equal(resA.mode, 'clarify');
    const pendA = chatPending.getPending(realDb, leadA);
    assert.ok(pendA && pendA.rounds === 1 && pendA.settled.includes('scope: entire site'), 'site A pending + settled persisted');
    assert.equal(chatPending.getPending(realDb, leadB), null, 'site B has NO pending — A\'s state does not leak');
    n += 3;
    // Site B's first turn must classify with no pending in sight.
    resetTurn();
    classifyQueue = [{ intent: 'question', ready: false, size: 'small', settled: [], fallback: false }];
    const resB = await runChat(leadB, { message: 'What is my headline?' });
    assert.equal(resB.mode, 'answer');
    assert.equal(classifyCalls[0].pending, null, 'site B classification saw NO pending from site A');
    assert.equal(chatPending.getPending(realDb, leadB), null, 'site B still has no pending after its turn');
    const pendA2 = chatPending.getPending(realDb, leadA);
    assert.ok(pendA2 && pendA2.rounds === 1, 'site A pending untouched by site B\'s turn');
    n += 4;
    // Style rules are stored inside each site's OWN theme.
    const portalReal = require(path.join(root, 'server', 'clientPortal.js'));
    await portalReal.applyClientStyleRule(1, leadA, { selector: 'h3', property: 'color', value: '#000000' });
    const themeA = JSON.parse(realDb.prepare('SELECT theme FROM websites WHERE lead_id = ?').get(leadA).theme || '{}');
    const themeB = JSON.parse(realDb.prepare('SELECT theme FROM websites WHERE lead_id = ?').get(leadB).theme || '{}');
    assert.ok(String(themeA.customCss || '').includes('h3 { color: #000000; }'), 'site A carries its rule');
    assert.ok(!String(themeB.customCss || '').includes('chat-rules'), 'site B stylesheet has NO trace of site A\'s rule');
    n += 2;
    group('S(vii) cross-site isolation: no state leaks between websites', n);
  }

  // ---------------------------------------------------------------
  // S(viii) — either/or convergence (live-proof find): a change
  // misrouted to the either/or question must still converge —
  // the owner's confirmation implements, never converts into an
  // open clarify round that then absorbs later requests.
  // ---------------------------------------------------------------
  {
    let n = 0;
    const lead = seedChatLead('EO');
    resetTurn();
    classifyQueue = [{ intent: 'ambiguous', ready: false, size: 'small', settled: [], fallback: false }];
    const res1 = await runChat(lead, { message: 'change all h3 to dark grey' });
    assert.equal(res1.mode, 'clarify', 'turn 1 asks the either/or question');
    const p1 = chatPending.getPending(realDb, lead);
    assert.ok(p1 && p1.kind === 'either_or', 'an either/or pending persisted');
    n += 2;
    resetTurn();
    classifyQueue = [{ intent: 'clarify_answer', ready: false, size: 'small', settled: [], fallback: false }];
    const res2 = await runChat(lead, { message: 'Yes, dark grey — apply it' });
    assert.equal(res2.mode, 'build', 'the confirmation implements — no conversion to an open clarify round');
    assert.equal(chatPending.getPending(realDb, lead), null, 'pending cleared after implementation');
    const buildCall = loopCalls.find((c) => c.mode === 'build');
    assert.ok(buildCall, 'the build loop ran');
    n += 3;
    group('S(viii) either/or pending converges on the confirmation', n);
  }

  // ---------------------------------------------------------------
  // Part 9 — chat history display: the panel's initial load is
  // THIS site's latest 50 saved messages (Ely: "display x amount
  // of chat history in chat window"), no other site's, and turn
  // rows never resurface as "updates".
  // ---------------------------------------------------------------
  {
    let n = 0;
    const thread = require(path.join(root, 'server', 'siteChatThread.js'));
    const portalReal = require(path.join(root, 'server', 'clientPortal.js'));
    assert.equal(thread.CHAT_HISTORY_LIMIT, 50, 'one named constant: 50');
    const leadH = seedChatLead('HIST');
    const leadH2 = seedChatLead('HIST2');
    for (let i = 1; i <= 30; i++) {
      portalReal.recordSiteChatTurn(1, leadH, { userText: `H user ${i}`, assistantText: `H agent ${i}` });
    }
    thread.addMessage(realDb, { leadId: leadH, content: 'H writeback', source: 'design_agent' });
    for (let i = 1; i <= 5; i++) {
      portalReal.recordSiteChatTurn(1, leadH2, { userText: `B user ${i}`, assistantText: `B agent ${i}` });
    }
    const hist = portalReal.getSiteChatHistory(1, leadH);
    assert.equal(hist.limit, 50);
    assert.equal(hist.messages.length, 50, 'exactly the latest 50 messages');
    assert.ok(hist.messages.every((m) => m.content.startsWith('H ')), "no other site's messages in the load");
    const ids = hist.messages.map((m) => m.id);
    assert.ok(ids.every((v, i) => i === 0 || v > ids[i - 1]), 'oldest-first order');
    assert.equal(
      hist.messages[hist.messages.length - 1].content,
      'H writeback',
      'agent write-backs interleave into the history'
    );
    n += 6;
    const hist2 = portalReal.getSiteChatHistory(1, leadH2);
    assert.equal(hist2.messages.length, 10, 'the other site gets only its own 10');
    assert.ok(hist2.messages.every((m) => m.content.startsWith('B ')));
    n += 2;
    const upd = portalReal.takeSiteChatUpdates(1, leadH);
    assert.equal(upd.messages.length, 1, 'turn rows never resurface as updates — only the write-back does');
    assert.equal(upd.messages[0].content, 'H writeback');
    assert.equal(portalReal.takeSiteChatUpdates(1, leadH).messages.length, 0, 'write-back still delivered exactly once');
    n += 3;
    const routes = fs.readFileSync(path.join(root, 'server', 'routes', 'portal.js'), 'utf8');
    assert.ok(routes.includes("'/site/agent-chat/history'"), 'history route ships');
    assert.ok(routes.includes('recordSiteChatTurn'), 'completed turns are recorded');
    const portalJs = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');
    assert.ok(portalJs.includes('loadAgentChatHistory'), 'panel loads history on open');
    assert.ok(portalJs.includes('agentChatServerIds'), 'panel dedupes server messages by id');
    n += 4;
    group('Part 9 chat history: latest 50, per-site, no update echoes', n);
  }

  console.log(JSON.stringify({ passed: true, groups, negative: NEGATIVE || null }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
