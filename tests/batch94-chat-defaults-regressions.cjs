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
  let src = fs.readFileSync(path.join(root, 'server', 'clientPortal.js'), 'utf8');
  if (NEGATIVE === 'defaults') {
    const shimmed = src.replace(
      'Number(pending.rounds || 0) >= 1',
      'Number(pending.rounds || 0) >= 999 // B94 NEGATIVE SHIM — convergence seam disabled'
    );
    assert.notEqual(shimmed, src, 'defaults shim must change the source');
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
    assert.ok(agent.includes('DEFAULTS DOCTRINE'), 'classifier defaults doctrine ships');
    assert.ok(agent.includes('TERSE REPLIES ARE ANSWERS'), 'terse-reply doctrine ships');
    assert.ok(agent.includes('new_ambiguity'), 'classifier emits new_ambiguity');
    assert.ok(agent.includes('Design defaults — apply these without asking'), 'build defaults ship');
    assert.ok(agent.includes('Defaults applied:'), 'summary disclosure ships');
    assert.ok(agent.includes('AT MOST 3 questions'), 'clarify cap ships');
    n += 6;
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

  console.log(JSON.stringify({ passed: true, groups, negative: NEGATIVE || null }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
