'use strict';
/**
 * Batch 96 — design-chat memory hardening (review §13, findings
 * H5-remainder + H7; blueprint §12.4/§12.5).
 *
 * What changed:
 *   1. The saved transcript is the conversation's source of truth.
 *      runSiteAgentChat loads THIS site's transcript tail
 *      server-side (siteChatThread.listContextTail, capped by
 *      CHAT_CONTEXT_LIMIT) and feeds it to the classifier and the
 *      improve loop. The history array the browser used to send
 *      is retired — the portal no longer sends it, and a client
 *      that still sends one is ignored (a stale or tampered
 *      client can neither lose the thread nor invent one).
 *   2. Operator transcript lookup: MCP site.chatTranscript reads
 *      a site's stored transcript (per-lead, bounded by
 *      CHAT_HISTORY_LIMIT) — debugging no longer needs the owner
 *      to paste a transcript.
 *   3. Pending clarifications expire (H7): a row untouched for
 *      PENDING_TTL_DAYS (7) is swept on read — deleted, never
 *      resurrected. The turn that sweeps it tells the owner
 *      honestly (reply note + pendingExpired in the payload)
 *      and starts fresh: the classifier sees NO pending.
 *   4. The cross-site battery (§8) re-verified against the new
 *      paths: pending/settled store, transcript, context tail,
 *      and the updates poller's dedupe — site A's state is
 *      invisible to site B everywhere.
 *   5. C1's residual gate requirement: the classifier budget
 *      loop (1200 + retry 2400 for the reasoning model) is now
 *      pinned permanently — source shape AND behaviour (a
 *      truncated first attempt retries at 2400 and routes).
 *
 * NEGATIVE PROOF (batch89/93/94 convention — the suite must go
 * RED): B96_NEGATIVE=ttl shims PENDING_TTL_MS to effectively
 * infinity in the pending module (unit groups AND the
 * runSiteAgentChat slice) → the 8-day-old pending is never
 * swept, S-B's fresh-start assertions fail.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b96-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch96', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const NEGATIVE = process.env.B96_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

// The pending module, optionally shimmed for the negative proof:
// B96_NEGATIVE=ttl makes the TTL unreachable so nothing ever
// expires — the shipped H7 behaviour (stale pendings steering
// forever) must come back and the TTL groups must go RED.
function loadPendingModule() {
  let src = fs.readFileSync(path.join(root, 'server', 'siteChatPending.js'), 'utf8');
  if (NEGATIVE === 'ttl') {
    const shimmed = src.replace(
      'const PENDING_TTL_MS = PENDING_TTL_DAYS * 24 * 60 * 60 * 1000;',
      'const PENDING_TTL_MS = Number.MAX_SAFE_INTEGER; // B96 NEGATIVE SHIM — TTL disabled'
    );
    assert.notEqual(shimmed, src, 'ttl shim must change the pending source');
    src = shimmed;
  }
  const m = { exports: {} };
  vm.runInNewContext(src + ';module.exports = module.exports;', {
    module: m,
    exports: m.exports,
    console,
    Buffer,
    process,
  });
  return m.exports;
}

function loadAgentSource() {
  return require('./lib/monolithSource.cjs').museAgentSource();
}

function loadPortalSliceSource() {
  const src = require('./lib/monolithSource.cjs').clientPortalSource();
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
  const thread = require(path.join(root, 'server', 'siteChatThread.js'));
  const designJobs = require(path.join(root, 'src', 'designJobs.js'));
  const chatPending = loadPendingModule();
  await require(path.join(root, 'server', 'db.js')).migrate();

  const siteModules = require(path.join(root, 'server', 'siteModules.js'));
  const realDb = domain.withDb(1, (db) => db);
  siteModules.ensureTables(realDb);
  designJobs.ensureTables(realDb);
  thread.ensureTable(realDb);
  chatPending.ensureTable(realDb);

  const FIXTURE_PAGES = [
    {
      slug: 'index',
      title: 'Home',
      sections: [
        { type: 'hero', content: { heading: 'Fresh Bread Daily', text: 'Baked at dawn, gone by noon.' } },
        { type: 'text', content: { heading: 'Our Story', text: 'A family bakery.' } },
      ],
    },
  ];
  const FIXTURE_THEME = { primaryColor: '#7a4a21', fontHeading: 'Fraunces' };
  const fixtureSites = {};
  const seedChatLead = (label) => {
    const info = realDb
      .prepare('INSERT INTO leads (business_name, category, phone) VALUES (?, ?, ?)')
      .run(`ZZ B96 Bakery ${label}`, 'Bakery', '(610) 555-0196');
    const leadId = Number(info.lastInsertRowid);
    fixtureSites[leadId] = { id: 9600 + leadId, pages: FIXTURE_PAGES, theme: FIXTURE_THEME };
    return leadId;
  };
  const daysAgo = (days) =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const backdatePending = (leadId, createdDays, updatedDays) => {
    realDb
      .prepare('UPDATE site_chat_pending SET created_at = ?, updated_at = ? WHERE lead_id = ?')
      .run(daysAgo(createdDays), daysAgo(updatedDays), leadId);
  };
  const pendingRowCount = (leadId) =>
    realDb.prepare('SELECT COUNT(*) AS c FROM site_chat_pending WHERE lead_id = ?').get(leadId).c;

  // ---------------------------------------------------------------
  // Part 1 — pending TTL (H7): expiry sweeps, activity survives,
  // per-site independence. (Real pending module; shimmed only
  // under B96_NEGATIVE=ttl.)
  // ---------------------------------------------------------------
  {
    let n = 0;
    assert.equal(chatPending.PENDING_TTL_DAYS, 7, 'TTL is 7 days');
    n += 1;
    const leadA = seedChatLead('TTL-A');
    const leadB = seedChatLead('TTL-B');

    chatPending.savePending(realDb, {
      leadId: leadA,
      kind: 'clarify',
      requestText: 'ZZ96 fresh request',
      questionsText: 'Which shade?',
      answers: [],
      settled: [],
      rounds: 1,
    });
    const fresh = chatPending.getPending(realDb, leadA);
    assert.ok(fresh && fresh.requestText === 'ZZ96 fresh request', 'fresh pending reads back');
    n += 1;

    // Untouched for 8 days → expired: swept (row DELETED) and
    // reported through getPendingWithExpiry exactly once.
    backdatePending(leadA, 9, 8);
    const swept = chatPending.getPendingWithExpiry(realDb, leadA);
    assert.equal(swept.pending, null, 'expired pending is not returned as live');
    assert.ok(swept.expired && swept.expired.requestText === 'ZZ96 fresh request', 'swept row is reported for the honest note');
    assert.equal(pendingRowCount(leadA), 0, 'expired row is deleted — it can never resurrect');
    const again = chatPending.getPendingWithExpiry(realDb, leadA);
    assert.equal(again.expired, null, 'the sweep is reported once, not on every later read');
    assert.equal(chatPending.getPending(realDb, leadA), null, 'plain getPending also sees no pending');
    n += 5;

    // 6 days untouched → still alive (inside the TTL).
    chatPending.savePending(realDb, {
      leadId: leadB,
      kind: 'clarify',
      requestText: 'ZZ96 six day request',
      questionsText: 'q',
      answers: [],
      settled: [],
      rounds: 1,
    });
    backdatePending(leadB, 6, 6);
    const six = chatPending.getPendingWithExpiry(realDb, leadB);
    assert.ok(six.pending && six.pending.requestText === 'ZZ96 six day request', 'a 6-day-old pending survives');
    assert.equal(six.expired, null);
    n += 2;

    // Old at birth but touched yesterday → alive: the TTL
    // measures abandonment (updated_at), not the request's age.
    backdatePending(leadB, 30, 1);
    const touched = chatPending.getPending(realDb, leadB);
    assert.ok(touched && touched.requestText === 'ZZ96 six day request', 'recent activity keeps an old thread alive');
    n += 1;

    // Per-site: expiring B (now abandoned) leaves a fresh A alone.
    chatPending.savePending(realDb, {
      leadId: leadA,
      kind: 'clarify',
      requestText: 'ZZ96 A second request',
      questionsText: 'q',
      answers: [],
      settled: [],
      rounds: 0,
    });
    backdatePending(leadB, 30, 9);
    assert.equal(chatPending.getPending(realDb, leadB), null, 'B expired on its own clock');
    const aStill = chatPending.getPending(realDb, leadA);
    assert.ok(aStill && aStill.requestText === 'ZZ96 A second request', "A's fresh pending untouched by B's sweep");
    n += 2;
    group('Part 1 pending TTL: sweep, report-once, activity, per-site', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — transcript context tail: the pipeline's window onto
  // the saved transcript (per-lead, capped, {role, content}).
  // ---------------------------------------------------------------
  {
    let n = 0;
    assert.equal(thread.CHAT_CONTEXT_LIMIT, 10, 'one named constant: context tail = 10');
    assert.equal(thread.CHAT_HISTORY_LIMIT, 50, 'display limit unchanged at 50');
    n += 2;
    const lead = seedChatLead('TAIL');
    const other = seedChatLead('TAIL2');
    for (let i = 1; i <= 7; i++) {
      thread.addMessage(realDb, { leadId: lead, role: 'user', content: `TAIL user ${i}`, source: 'portal_chat', delivered: true });
      thread.addMessage(realDb, { leadId: lead, role: 'assistant', content: `TAIL agent ${i}`, source: 'portal_chat', delivered: true });
    }
    thread.addMessage(realDb, { leadId: lead, content: 'TAIL writeback', source: 'design_agent' });
    thread.addMessage(realDb, { leadId: other, role: 'user', content: 'OTHER user 1', source: 'portal_chat', delivered: true });

    const tail = thread.listContextTail(realDb, lead);
    assert.equal(tail.length, 10, 'tail capped at CHAT_CONTEXT_LIMIT');
    assert.ok(tail.every((m) => Object.keys(m).sort().join(',') === 'content,role'), 'tail rows are plain {role, content} pairs');
    assert.equal(tail[tail.length - 1].content, 'TAIL writeback', 'write-backs ride the tail — the outcome is part of the conversation');
    assert.equal(tail[0].content, 'TAIL agent 3', 'tail is the MOST RECENT window, oldest-first');
    assert.ok(!tail.some((m) => m.content.startsWith('OTHER')), "no other site's messages in the tail");
    n += 5;
    const tailOther = thread.listContextTail(realDb, other);
    assert.equal(tailOther.length, 1);
    assert.equal(tailOther[0].content, 'OTHER user 1');
    n += 2;
    group('Part 2 context tail: capped, per-site, write-backs included', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — classifier budget loop, pinned permanently (C1
  // residual): source shape + real behaviour against a scripted
  // endpoint (truncated first attempt retries at 2400).
  // ---------------------------------------------------------------
  {
    let n = 0;
    const agentSrc = loadAgentSource();
    assert.ok(/for \(const maxTokens of \[1200, 2400\]\)/.test(agentSrc), 'classifier iterates the [1200, 2400] budget loop');
    assert.ok(agentSrc.includes('max_tokens: maxTokens'), 'the loop variable drives max_tokens');
    n += 2;

    const stubDb = () => ({
      prepare: (sql) => ({
        get: () => (sql.includes('SUM') ? { spent: 0 } : undefined),
        run() {},
        all: () => [],
      }),
    });
    const reply = (content, finishReason) => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content }, finish_reason: finishReason || 'stop' }],
        usage: {},
      }),
    });
    function loopFixture(handler) {
      const requests = [];
      const m = { exports: {} };
      const domainStub = { withDb: (_ws, fn) => fn(stubDb()), getSetting: () => '0' };
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
                  ? { toolDefs: () => ALL_DEFS, callTool: async () => ({ ok: true, data: {} }) }
                  : require(name.startsWith('.') ? path.join(root, 'server', name) : name),
        fetch: async (_url, opts) => {
          const body = JSON.parse(opts.body);
          requests.push(body);
          return handler(body, requests.length);
        },
      });
      return { agent: m.exports, requests };
    }

    // Truncated first attempt (reasoning ate the budget) →
    // retried bigger → routes on the second answer.
    const f = loopFixture((_body, call) =>
      call === 1
        ? reply('', 'length')
        : reply('{"intent":"question","ready":false,"size":"small"}', 'stop')
    );
    const res = await f.agent.classifyPortalChatIntent(1, 7, { db: stubDb(), message: 'What is my headline?' });
    assert.equal(res.intent, 'question', 'the retried classification routes');
    assert.deepEqual(
      f.requests.map((r) => r.max_tokens),
      [1200, 2400],
      'first attempt at 1200, retry at 2400 — the permanent budget loop'
    );
    n += 2;

    // A genuine non-JSON answer is NOT retried (fallback, one call).
    const f2 = loopFixture(() => reply('not json at all', 'stop'));
    const res2 = await f2.agent.classifyPortalChatIntent(1, 7, { db: stubDb(), message: 'hello' });
    assert.equal(res2.fallback, true, 'non-JSON answer falls back');
    assert.equal(f2.requests.length, 1, 'no retry spent on a genuine non-answer');
    n += 2;
    group('Part 3 classifier budget loop: [1200, 2400] pinned + behavioural', n);
  }

  // ---------------------------------------------------------------
  // Part 4 — runSiteAgentChat routing (real slice; scripted
  // classifier + loop; REAL thread + pending stores).
  // ---------------------------------------------------------------
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
        return { ...base, reply: 'Done — headings updated.', mutated: true, published: true, toolCalls: 2 };
      }
      if (opts.mode === 'clarify') {
        return { ...base, reply: 'Quick questions:\n1. What exactly should change?', mutated: false, published: false, toolCalls: 0 };
      }
      return { ...base, reply: 'Your headline is Fresh Bread Daily.', mutated: false, published: false, toolCalls: 1 };
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
        : name === './siteChatPending'
          ? chatPending
          : name === './domain'
            ? { withDb: (_ws, fn) => fn(realDb) }
            : require(name.startsWith('.') ? path.join(root, 'server', name) : name),
  });
  const runChat = (leadId, body) => sliceMod.exports.runSiteAgentChat(1, leadId, body);

  // S-A — the server transcript is the source of truth: a
  // poisoned client history is ignored; the classifier and the
  // loop receive the SAVED tail. No client history at all works
  // the same.
  {
    let n = 0;
    const lead = seedChatLead('SRC');
    thread.addMessage(realDb, { leadId: lead, role: 'user', content: 'ZZ96 SERVER past user turn', source: 'portal_chat', delivered: true });
    thread.addMessage(realDb, { leadId: lead, role: 'assistant', content: 'ZZ96 SERVER past agent reply', source: 'portal_chat', delivered: true });
    thread.addMessage(realDb, { leadId: lead, role: 'user', content: 'ZZ96 SERVER second user turn', source: 'portal_chat', delivered: true });

    resetTurn();
    classifyQueue = [{ intent: 'question', ready: false, size: 'small', settled: [], fallback: false }];
    const res = await runChat(lead, {
      message: 'What is my headline?',
      history: [
        { role: 'user', content: 'ZZ96 CLIENT POISON' },
        { role: 'assistant', content: 'ZZ96 CLIENT POISON REPLY' },
      ],
    });
    assert.equal(res.mode, 'answer');
    const clsHist = (classifyCalls[0].history || []).map((h) => h.content).join('\n');
    assert.ok(clsHist.includes('ZZ96 SERVER past user turn'), 'classifier received the server transcript');
    assert.ok(clsHist.includes('ZZ96 SERVER past agent reply'), 'classifier received the agent side of the transcript');
    assert.ok(!clsHist.includes('CLIENT POISON'), 'classifier never saw the client-sent history');
    const loopHist = (loopCalls[0].history || []).map((h) => h.content).join('\n');
    assert.ok(loopHist.includes('ZZ96 SERVER second user turn'), 'improve loop received the server transcript');
    assert.ok(!loopHist.includes('CLIENT POISON'), 'improve loop never saw the client-sent history');
    n += 6;

    resetTurn();
    classifyQueue = [{ intent: 'question', ready: false, size: 'small', settled: [], fallback: false }];
    await runChat(lead, { message: 'And my story heading?' });
    const clsHist2 = (classifyCalls[0].history || []).map((h) => h.content).join('\n');
    assert.ok(clsHist2.includes('ZZ96 SERVER past user turn'), 'no client history sent — server tail still loads');
    n += 1;
    group('S-A server transcript is the source of truth (client array ignored)', n);
  }

  // S-B — TTL in the pipeline: an 8-day-abandoned pending is
  // swept BEFORE classification (the classifier sees no pending
  // → fresh start), the owner is told honestly, and the payload
  // carries pendingExpired. Under B96_NEGATIVE=ttl the pending
  // survives and these assertions go RED.
  {
    let n = 0;
    const lead = seedChatLead('TTLFLOW');
    chatPending.savePending(realDb, {
      leadId: lead,
      kind: 'clarify',
      requestText: 'ZZ96 stale repaint request',
      questionsText: 'Which purple?',
      answers: [],
      settled: [],
      rounds: 1,
    });
    backdatePending(lead, 9, 8);

    resetTurn();
    classifyQueue = [{ intent: 'question', ready: false, size: 'small', settled: [], fallback: false }];
    const res = await runChat(lead, { message: 'What services do I offer?' });
    assert.equal(classifyCalls[0].pending, null, 'classifier saw NO pending — the stale one was swept first');
    assert.ok(res.pendingExpired, 'payload reports the expiry');
    assert.equal(res.pendingExpired.requestText, 'ZZ96 stale repaint request', 'payload names the swept request');
    assert.ok(/over a week/.test(res.reply) && /let it go/.test(res.reply), 'reply tells the owner honestly, in words');
    assert.equal(chatPending.getPending(realDb, lead), null, 'pending is gone after the turn');
    assert.equal(pendingRowCount(lead), 0, 'the row was deleted, not hidden');
    n += 6;
    group('S-B expired pending: swept pre-classification, honest note, fresh start', n);
  }

  // S-C — a live pending is untouched by the TTL path: the
  // classifier sees it, no expiry is reported, no note appears.
  {
    let n = 0;
    const lead = seedChatLead('FRESH');
    chatPending.savePending(realDb, {
      leadId: lead,
      kind: 'clarify',
      requestText: 'ZZ96 live request',
      questionsText: 'Which shade?',
      answers: [],
      settled: ['scope: entire site'],
      rounds: 1,
    });
    backdatePending(lead, 1, 1);
    resetTurn();
    classifyQueue = [{ intent: 'question', ready: false, size: 'small', settled: [], fallback: false }];
    const res = await runChat(lead, { message: 'What is my headline?' });
    assert.ok(classifyCalls[0].pending && classifyCalls[0].pending.requestText === 'ZZ96 live request', 'classifier saw the live pending');
    assert.equal(res.pendingExpired, null, 'no expiry reported for a live pending');
    assert.ok(!/over a week/.test(res.reply), 'no housekeeping note for a live pending');
    n += 3;
    group('S-C live pending: untouched, no false expiry', n);
  }

  // ---------------------------------------------------------------
  // S-D — the §8 cross-site battery against the NEW paths:
  // site A's transcript, pending, context and write-backs are
  // invisible to site B; the updates poller dedupes (a write-back
  // surfaces exactly once and history shows it exactly once).
  // ---------------------------------------------------------------
  {
    let n = 0;
    const leadA = seedChatLead('ISO-A');
    const leadB = seedChatLead('ISO-B');
    thread.addMessage(realDb, { leadId: leadA, role: 'user', content: 'ISO-A unique owner words', source: 'portal_chat', delivered: true });
    thread.addMessage(realDb, { leadId: leadA, role: 'assistant', content: 'ISO-A unique agent words', source: 'portal_chat', delivered: true });
    thread.addMessage(realDb, { leadId: leadA, content: 'ISO-A writeback words', source: 'design_agent' });
    chatPending.savePending(realDb, {
      leadId: leadA,
      kind: 'clarify',
      requestText: 'ISO-A pending request',
      questionsText: 'q',
      answers: [],
      settled: ['ISO-A settled fact'],
      rounds: 1,
    });

    resetTurn();
    classifyQueue = [{ intent: 'question', ready: false, size: 'small', settled: [], fallback: false }];
    const resB = await runChat(leadB, { message: 'What is my headline?' });
    assert.equal(resB.mode, 'answer');
    assert.equal(classifyCalls[0].pending, null, "B's classifier saw no pending (A's is not B's)");
    const bHist = (classifyCalls[0].history || []).map((h) => h.content).join('\n');
    assert.ok(!bHist.includes('ISO-A'), "B's context tail contains zero A content");
    assert.equal(chatPending.getPending(realDb, leadB), null, 'B has no pending row');
    const pendA = chatPending.getPending(realDb, leadA);
    assert.ok(pendA && pendA.requestText === 'ISO-A pending request', "A's pending untouched by B's turn");
    n += 5;

    const portalReal = require(path.join(root, 'server', 'clientPortal.js'));
    const histB = portalReal.getSiteChatHistory(1, leadB);
    assert.ok(histB.messages.every((m) => !String(m.content).includes('ISO-A')), "B's history load has zero A content");
    const updB = portalReal.takeSiteChatUpdates(1, leadB);
    assert.equal(updB.messages.length, 0, "B's updates poller returns nothing of A's");
    n += 2;

    const updA1 = portalReal.takeSiteChatUpdates(1, leadA);
    assert.equal(updA1.messages.length, 1, "A's write-back surfaces via the poller");
    assert.equal(updA1.messages[0].content, 'ISO-A writeback words');
    const updA2 = portalReal.takeSiteChatUpdates(1, leadA);
    assert.equal(updA2.messages.length, 0, 'the write-back surfaces exactly once');
    const histA = portalReal.getSiteChatHistory(1, leadA);
    const wbCount = histA.messages.filter((m) => m.content === 'ISO-A writeback words').length;
    assert.equal(wbCount, 1, 'history shows the write-back exactly once (poller/history dedupe)');
    const ids = histA.messages.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'history message ids are unique');
    n += 5;
    group('S-D cross-site battery: pending/transcript/poller isolation + dedupe', n);
  }

  // ---------------------------------------------------------------
  // S-E — operator transcript lookup (MCP site.chatTranscript):
  // real callTool against the fixture workspace; per-lead only.
  // ---------------------------------------------------------------
  {
    let n = 0;
    const mcp = require(path.join(root, 'server', 'mcp.js'));
    const defNames = mcp.toolDefs({}).map((t) => t.name);
    assert.ok(defNames.includes('site.chatTranscript'), 'tool registered in the hosted catalog');
    const leadA = seedChatLead('LOOKUP-A');
    const leadB = seedChatLead('LOOKUP-B');
    thread.addMessage(realDb, { leadId: leadA, role: 'user', content: 'LOOKUP-A owner asked about scones', source: 'portal_chat', delivered: true });
    thread.addMessage(realDb, { leadId: leadA, role: 'assistant', content: 'LOOKUP-A agent answered about scones', source: 'portal_chat', delivered: true });

    const callA = await mcp.callTool(1, 'site.chatTranscript', { leadId: leadA });
    assert.equal(callA.ok, true, JSON.stringify(callA).slice(0, 200));
    const resA = callA.data;
    assert.equal(resA.leadId, leadA);
    assert.equal(resA.limit, 50, 'lookup window is the named CHAT_HISTORY_LIMIT');
    assert.equal(resA.count, 2);
    assert.ok(resA.messages.some((m) => m.content.includes('LOOKUP-A owner asked')), 'operator reads the stored transcript');
    assert.ok(resA.messages.every((m) => m.content.includes('LOOKUP-A')), 'lookup returns ONLY that site\'s messages');
    n += 6;
    const callB = await mcp.callTool(1, 'site.chatTranscript', { leadId: leadB });
    assert.equal(callB.ok, true);
    assert.equal(callB.data.count, 0, "another site's lookup is empty — no cross-site read");
    n += 2;
    const noLead = await mcp.callTool(1, 'site.chatTranscript', {});
    assert.equal(noLead.ok, false, 'leadId is required — errors surface as { ok:false }');
    n += 1;
    group('S-E operator transcript lookup: per-lead MCP read', n); // 9 checks
  }

  // ---------------------------------------------------------------
  // Part 5 — wiring pins: the client array is retired on both
  // ends, and the new paths are wired where the pipeline runs.
  // ---------------------------------------------------------------
  {
    let n = 0;
    const portalSrc = require('./lib/monolithSource.cjs').clientPortalSource();
    assert.ok(portalSrc.includes('listContextTail'), 'pipeline loads the server transcript tail');
    assert.ok(portalSrc.includes('getPendingWithExpiry'), 'pipeline reads pending through the TTL sweep');
    assert.ok(portalSrc.includes('pendingExpired'), 'payload carries the expiry report');
    assert.ok(!portalSrc.includes('history: body.history'), 'client-sent history is no longer consumed anywhere');
    n += 4;
    const portalJs = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');
    assert.ok(!portalJs.includes('agentChatHistory.slice(-10)'), 'panel no longer packages history for the request');
    assert.ok(!portalJs.includes('body = { message: text, history }'), 'chat request body carries no history field');
    assert.ok(portalJs.includes('loadAgentChatHistory'), 'panel still loads the saved history on open (display)');
    assert.ok(portalJs.includes('agentChatServerIds'), 'panel still dedupes server messages by id (display)');
    n += 4;
    const routesSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'portal.js'), 'utf8');
    assert.ok(routesSrc.includes("'/site/agent-chat/history'"), 'history route still ships');
    n += 1;
    group('Part 5 wiring pins: retired array, live display path', n);
  }

  console.log(JSON.stringify({ passed: true, groups, negative: NEGATIVE || null }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
