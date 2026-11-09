'use strict';
/**
 * Batch 167 — chat redesign port (YWL Rules A–K) regressions.
 *
 * Ely's order 2026-11-08: "Check the research we did for
 * yourwebsitelive's chat in the other chat and apply the same for
 * Bitpype chat" — the Chat module (visitor chatbot), not voice, not
 * the design chat, not the Assistant. The YWL redesign (audit +
 * build report 2026-11-08, live session ses_15a1fba0bb8cbbc0e9
 * failed seven ways) is ported as BEHAVIOUR onto BitPype's engine:
 * BitPype has no deterministic flow engine — the routed model is
 * the brain — so the rules land as a harness in the AI fallback
 * turn, server-side gates on model-reported qualification state,
 * per-session chat state (miss ladder + honest outcomes) and a
 * price fact-check on answered replies.
 *
 *   Part 1 — source pins + units: settings registry (defs with
 *     defaults, settable, validated); harness predicates incl. the
 *     Rule E6 answerInQuestion guard ("booking appointments");
 *     price-amount grounding set (book/bookable/knowledge + ≤3-item
 *     sums); recordQualificationUpdates gates (start gate,
 *     anti-miscapture, re-ask budget + mute) incl. proof the gates
 *     are fallback-only (direct/agent calls keep 137 semantics);
 *     computeChatOutcome matrix.
 *   Part 2 — the ITEM 73-style transcript replay, line by line:
 *     greeting clean → substantive answer starts qualification →
 *     question-while-pending answered, bridged, NEVER stored →
 *     mid-flow question with short bridge → real answer recorded →
 *     decline recorded deterministically → human request mid-flow
 *     (handoff, model not consulted) → AI stands down → a human
 *     reply clears the stand-down.
 *   Part 3 — harness cancels (questions / capture offer / booking
 *     pitch, each named in the confirmation + suppressed after) and
 *     the Rule E6 harness guard (a pending question whose own text
 *     offers "talk to someone" — the reply is its answer, not a
 *     handoff), re-ask budget through the fallback, capture
 *     suppression after cancel.
 *   Part 4 — fallback ladder at the default threshold (unknown ×3)
 *     and at the admin-set threshold (setting read live); price
 *     fact-check (regen fixes it / second violation downgrades +
 *     fact_check_blocks + miss; ≤3-item sum passes); honest
 *     outcomes at the capture "end" + portal summary counts;
 *     heuristic path untouched (no state written).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b167-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch167', 'test', 'session', 'secret', 'value'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const LEAD_MAIN = 16701; // qualifying ON (owner list) — the replay
const LEAD_PLAIN = 16702; // qualifying OFF — ladder / outcomes
const LEAD_BOOK = 16703; // pricing entry — fact-check
const LEAD_BOOKING = 16704; // bookings pitch — cancel target
let WS_ID;
let db;

const Q1 = 'Is this for your home or a rental property?';
const Q2 = 'When are you hoping to have the work done?';
const Q3 = 'Roughly how big is the job — one room, or the whole place?';
const QUESTIONS = [Q1, Q2, Q3];

function makeSession(leadId) {
  const token = `b167-${leadId}-${Math.random().toString(36).slice(2, 12)}`;
  const info = db
    .prepare(
      "INSERT INTO chatbot_sessions (lead_id, session_token, status, needs_agent, last_visitor_at) VALUES (?, ?, 'open', 1, datetime('now'))"
    )
    .run(leadId, token);
  return { id: Number(info.lastInsertRowid), token };
}
function addMsg(sessionId, leadId, role, body) {
  db.prepare('INSERT INTO chatbot_messages (session_id, lead_id, role, body) VALUES (?, ?, ?, ?)').run(
    sessionId,
    leadId,
    role,
    body
  );
}
function visitorTurn(sessionId, leadId, body) {
  addMsg(sessionId, leadId, 'visitor', body);
  db.prepare('UPDATE chatbot_sessions SET needs_agent = 1 WHERE id = ?').run(sessionId);
}
function agentBodies(sessionId) {
  return chat
    .listMessages(db, sessionId, { limit: 100 })
    .filter((m) => m.role === 'agent')
    .map((m) => m.body);
}

let chat;
let sm;
let share;
let pricing;
let platform;
let ai;
let realChat;
let realConfigured;
const prompts = [];
let chatCalls = 0;
let nextReply = '';
let replyQueue = null;

function stubAi(queue) {
  replyQueue = queue || null;
  ai.aiConfigured = () => true;
  ai.chat = async (args) => {
    chatCalls += 1;
    prompts.push(args);
    const text = replyQueue ? replyQueue.shift() : nextReply;
    return { text };
  };
}
function unstubAi() {
  ai.chat = realChat;
  ai.aiConfigured = realConfigured;
  replyQueue = null;
}

(async () => {
  const chatSrc = read('server/chatbot.js');

  /* ================================================================== */
  /* Setup                                                               */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  sm = require(path.join(root, 'server/siteModules.js'));
  share = require(path.join(root, 'server/moduleShare.js'));
  pricing = require(path.join(root, 'server/pricing.js'));
  platform = require(path.join(root, 'server/platform.js'));
  chat = require(path.join(root, 'server/chatbot.js'));
  ai = require(path.join(root, 'src/ai.js'));
  realChat = ai.chat;
  realConfigured = ai.aiConfigured;

  const a = await workspace.createUserWithWorkspace({
    email: 'a167@example.invalid',
    password: ['batch167', 'fixture', 'password'].join('-'),
    name: 'A167',
    workspaceName: 'Batch167 WS',
  });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  chat.ensureTables(db);
  for (const lead of [LEAD_MAIN, LEAD_PLAIN, LEAD_BOOK, LEAD_BOOKING]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      lead,
      `B167 Lead ${lead}`,
      `lead${lead}@example.invalid`,
      'customer'
    );
  }
  chat.saveSettings(db, LEAD_MAIN, { qualifying_enabled: true, qualifying_questions: QUESTIONS });

  /* ================================================================== */
  /* Part 1 — source pins + units                                        */
  /* ================================================================== */
  {
    let n = 0;
    // No module type added; the widget is untouched (no chip
    // transport exists in BitPype's embed — bridges are text).
    assert.equal(sm.MODULE_TYPES.length, 29, 'MODULE_TYPES unchanged on the Batch 162 base (finisher re-derives on the merged tree)');
    assert.ok(!sm.MODULE_TYPES.includes('chat_state'), 'no chat-state module type exists');
    assert.equal(chat.CHAT_SCRIPT_VER, 'chat8', 'widget script version untouched — no widget change in this port');
    n += 3;

    // Settings registry: defs carry the seed defaults; keys are
    // settable + validated; the engine reads them live by name.
    const platformSrc = read('server/platform.js');
    assert.ok(/key: 'chat\.qual_reask_budget'[\s\S]{0,200}?default: '1'/.test(platformSrc), 'def: chat.qual_reask_budget default 1');
    assert.ok(/key: 'chat\.fallback_handoff_at'[\s\S]{0,200}?default: '3'/.test(platformSrc), 'def: chat.fallback_handoff_at default 3');
    const settingsKeys = require(path.join(root, 'server/settingsKeys.js'));
    assert.ok(settingsKeys.SETTABLE_KEYS.includes('chat.qual_reask_budget'), 're-ask budget is settable');
    assert.ok(settingsKeys.SETTABLE_KEYS.includes('chat.fallback_handoff_at'), 'handoff threshold is settable');
    assert.equal(settingsKeys.validateSetting('chat.qual_reask_budget', '2').ok, true, 'budget 2 validates');
    assert.equal(settingsKeys.validateSetting('chat.qual_reask_budget', '99').ok, false, 'budget 99 refused');
    assert.equal(settingsKeys.validateSetting('chat.fallback_handoff_at', '0').ok, false, 'threshold 0 refused (min 1)');
    assert.equal(settingsKeys.validateSetting('chat.fallback_handoff_at', '3').ok, true, 'threshold 3 validates');
    assert.ok(chatSrc.includes("platform.getPlatformSetting('chat.qual_reask_budget'"), 'engine reads the budget setting live');
    assert.ok(chatSrc.includes("platform.getPlatformSetting('chat.fallback_handoff_at'"), 'engine reads the threshold setting live');
    n += 10;

    // Harness + ladder + state anchors exist in the engine.
    for (const anchor of [
      'CHAT_HARD_HUMAN_RE',
      'CHAT_FLOW_ABORT_RE',
      "via: 'harness_handoff'",
      "via: 'harness_cancel'",
      "via: 'fallback_ladder'",
      "reason: 'repeated_unanswered'",
      "reason: 'visitor_requested_human'",
      'chat_state_json',
      'function computeChatOutcome',
      'CHAT_FACT_CHECK_UNKNOWN_REPLY',
    ]) {
      assert.ok(chatSrc.includes(anchor), `engine anchor present: ${anchor}`);
      n += 1;
    }

    // Rule E6 guard — the SaaS "booking appointments" case verbatim.
    const agentQ = 'What would you like your agent to handle — answering questions, booking appointments, or something else?';
    assert.equal(chat.answerInQuestion('booking appointments', agentQ), true, 'E6: words inside the question text are its answer');
    assert.equal(chat.answerInQuestion('book', agentQ), false, 'E6: a partial word is not the answer');
    assert.equal(chat.answerInQuestion('I need a plumber', agentQ), false, 'E6: unrelated text is not the answer');
    assert.equal(chat.answerInQuestion('no', Q1), false, 'E6: too-short replies never count');
    n += 4;

    // Predicates.
    assert.equal(chat.looksLikeQuestion('What do you do?'), true, 'question: ?');
    assert.equal(chat.looksLikeQuestion('how much is delivery'), true, 'question: opener word');
    assert.equal(chat.looksLikeQuestion('For my home'), false, 'statement is not a question');
    assert.equal(chat.looksLikeRequest('Write me a poem about taps'), true, 'request: creative noun');
    assert.equal(chat.isChatDecline('skip'), true, 'decline: skip');
    assert.equal(chat.isChatHedge("I'm not sure yet"), true, 'hedge: not sure');
    assert.equal(chat.isSubstantiveQuestion('What are your hours?'), true, 'substantive question');
    assert.equal(chat.isSubstantiveQuestion('Hi there'), false, 'greeting is not substantive');
    n += 8;

    // Price grounding set: book/bookable amounts + knowledge-stated
    // amounts + sums of up to three listed prices; nothing else.
    const allowed = chat.allowedChatAmounts([5800], ['Delivery is $15 within the county.']);
    assert.ok(allowed.has(5800), 'grounded: the listed price itself');
    assert.ok(allowed.has(11600), 'grounded: a 2-item sum');
    assert.ok(allowed.has(17400), 'grounded: a 3-item sum');
    assert.ok(!allowed.has(23200), 'NOT grounded: a 4-item sum');
    assert.ok(allowed.has(1500), 'grounded: an amount stated in retrieved knowledge');
    assert.deepEqual(chat.unverifiedChatAmounts('That will be $999 today', allowed), [999], 'an invented price is unverified');
    assert.deepEqual(chat.unverifiedChatAmounts('That will be $58 today', allowed), [], 'a listed price verifies');
    n += 7;

    // Recording gates are fallback-only: a direct call (the agent /
    // legacy path) records an asked report with NO start gate.
    {
      const sess = makeSession(LEAD_MAIN);
      addMsg(sess.id, LEAD_MAIN, 'visitor', 'My tap drips');
      const r = chat.recordQualificationUpdates(db, LEAD_MAIN, sess.id, [{ index: 0, status: 'asked' }]);
      assert.equal(r.applied, 1, 'direct call: asked records with no gates (137 semantics preserved)');
      assert.equal(r.gated, 0, 'direct call: nothing gated');
      n += 2;
    }
    // Start gate (fallback opts): asked before start is gated;
    // startedThisTurn lets an answer+ask in one reply land.
    {
      const sess = makeSession(LEAD_MAIN);
      addMsg(sess.id, LEAD_MAIN, 'visitor', 'My tap drips');
      let r = chat.recordQualificationUpdates(db, LEAD_MAIN, sess.id, [{ index: 0, status: 'asked' }], {
        enforceStartGate: true,
      });
      assert.deepEqual({ applied: r.applied, gated: r.gated }, { applied: 0, gated: 1 }, 'start gate: asked before start is gated');
      r = chat.recordQualificationUpdates(db, LEAD_MAIN, sess.id, [{ index: 0, status: 'asked' }], {
        enforceStartGate: true,
        startedThisTurn: true,
      });
      assert.equal(r.applied, 1, 'start gate: answer+ask in the same turn records');
      n += 2;
    }
    // Anti-miscapture gate: the visitor's question is never stored.
    {
      const sess = makeSession(LEAD_MAIN);
      addMsg(sess.id, LEAD_MAIN, 'visitor', 'My tap drips');
      chat.recordQualificationUpdates(db, LEAD_MAIN, sess.id, [{ index: 0, status: 'asked' }]);
      const opts = { guardMiscapture: true, latestVisitorText: 'What do you do?' };
      let r = chat.recordQualificationUpdates(db, LEAD_MAIN, sess.id, [
        { index: 0, status: 'answered', answer: 'What do you do?' },
      ], opts);
      assert.deepEqual({ applied: r.applied, gated: r.gated }, { applied: 0, gated: 1 }, 'miscapture: the question itself is never stored as the answer');
      r = chat.recordQualificationUpdates(db, LEAD_MAIN, sess.id, [
        { index: 0, status: 'answered', answer: '' },
      ], opts);
      assert.equal(r.gated, 1, 'miscapture: an answerless "answered" report against a question is gated');
      r = chat.recordQualificationUpdates(db, LEAD_MAIN, sess.id, [
        { index: 0, status: 'answered', answer: 'For my home' },
      ], { guardMiscapture: true, latestVisitorText: 'For my home — also, what do you do?' });
      assert.equal(r.applied, 1, 'a genuine value in a longer message still records');
      const rec = chat.getSessionQualification(db, sess.id);
      assert.equal(rec.items[0].answer, 'For my home', 'the recorded answer is the value, not the question');
      n += 4;
    }
    // Re-ask budget + mute + parser round-trip of the new fields.
    {
      const sess = makeSession(LEAD_MAIN);
      addMsg(sess.id, LEAD_MAIN, 'visitor', 'My tap drips');
      const opts = { reaskBudget: 1 };
      chat.recordQualificationUpdates(db, LEAD_MAIN, sess.id, [{ index: 0, status: 'asked' }], opts);
      chat.recordQualificationUpdates(db, LEAD_MAIN, sess.id, [{ index: 0, status: 'asked' }], opts);
      let rec = chat.getSessionQualification(db, sess.id);
      assert.equal(rec.items[0].reasks, 1, 'first re-ask counts against the budget');
      assert.ok(!rec.items[0].muted, 'not muted inside the budget');
      chat.recordQualificationUpdates(db, LEAD_MAIN, sess.id, [{ index: 0, status: 'asked' }], opts);
      rec = chat.getSessionQualification(db, sess.id);
      assert.equal(rec.items[0].reasks, 2, 'second re-ask counted');
      assert.equal(rec.items[0].muted, true, 'past the budget the question is muted');
      const lines = chat.qualifyingPromptLines(rec).join('\n');
      assert.ok(lines.includes('do NOT ask it again this session'), 'prompt: muted question carries the do-not-ask line');
      const round = chat.parseQualificationRecord(JSON.stringify(rec));
      assert.equal(round.items[0].reasks, 2, 'parser round-trips reasks');
      assert.equal(round.items[0].muted, true, 'parser round-trips muted');
      n += 7;
    }
    // Suppression: nothing records after the visitor cancels.
    {
      const sess = makeSession(LEAD_MAIN);
      addMsg(sess.id, LEAD_MAIN, 'visitor', 'My tap drips');
      const r = chat.recordQualificationUpdates(db, LEAD_MAIN, sess.id, [{ index: 0, status: 'answered', answer: 'For my home' }], {
        suppressQual: true,
      });
      assert.deepEqual({ applied: r.applied, gated: r.gated }, { applied: 0, gated: 1 }, 'suppressed: updates are gated wholesale');
      n += 1;
    }
    // Outcome matrix (Rule G) on raw state.
    {
      const sess = makeSession(LEAD_PLAIN);
      const row = () => db.prepare('SELECT * FROM chatbot_sessions WHERE id = ?').get(sess.id);
      assert.equal(chat.computeChatOutcome(db, row()), 'open', 'outcome: untouched session is open');
      db.prepare('UPDATE chatbot_sessions SET chat_state_json = ? WHERE id = ?').run(
        JSON.stringify({ answered_count: 2 }),
        sess.id
      );
      assert.equal(chat.computeChatOutcome(db, row()), 'resolved', 'outcome: answered turns resolve');
      db.prepare('UPDATE chatbot_sessions SET chat_state_json = ? WHERE id = ?').run(
        JSON.stringify({ miss_total: 2 }),
        sess.id
      );
      assert.equal(chat.computeChatOutcome(db, row()), 'unresolved', 'outcome: misses with nothing achieved are unresolved');
      db.prepare('UPDATE chatbot_sessions SET chat_state_json = ? WHERE id = ?').run(
        JSON.stringify({ handoff_requested: true, miss_total: 2 }),
        sess.id
      );
      assert.equal(chat.computeChatOutcome(db, row()), 'escalated', 'outcome: a requested handoff escalates');
      n += 4;
    }
    group('Part 1 source pins + units', n);
  }

  /* ================================================================== */
  /* Part 2 — the ITEM 73-style transcript replay                        */
  /* ================================================================== */
  {
    let n = 0;
    stubAi(null);
    const sess = makeSession(LEAD_MAIN);
    const rec = () => chat.getSessionQualification(db, sess.id);
    const state = () => chat.getChatState(db, sess.id);

    // Line 1 — greeting: clean welcome, no interrogation, no pump.
    visitorTurn(sess.id, LEAD_MAIN, 'Hi there');
    nextReply = JSON.stringify({ action: 'chat', reply: 'Hi! Welcome in — how can I help today?' });
    let r = await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
    assert.equal(r.via, 'chatgpt', 'replay 1: greeting handled by the model');
    assert.ok(agentBodies(sess.id).some((b) => b.includes('how can I help')), 'replay 1: the welcome posted');
    assert.ok(rec() && rec().items.every((it) => it.status === 'pending'), 'replay 1: no question asked on a greeting');
    assert.ok(prompts[prompts.length - 1].messages[0].content.includes('NOT STARTED'), 'replay 1: prompt block is dormant before any answer');
    n += 4;

    // Line 2 — first substantive question, answered: qualification
    // STARTS, and the answer+ask in the same reply is recorded.
    visitorTurn(sess.id, LEAD_MAIN, 'What are your opening hours?');
    nextReply = JSON.stringify({
      action: 'answer',
      reply: 'We are open Monday to Friday, 9am to 5pm. Quick one so the team can help faster — is this for your home or a rental property?',
      qualification: [{ index: 0, status: 'asked' }],
    });
    r = await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
    assert.deepEqual(r.qualification, { applied: 1, skipped: 0, gated: 0 }, 'replay 2: the same-turn ask records once qualification starts');
    assert.equal(rec().started, true, 'replay 2: qualification started by the first substantive answered turn');
    assert.equal(rec().items[0].status, 'asked', 'replay 2: Q1 is waiting');
    assert.equal(state().answered_count, 1, 'replay 2: the answered turn counted');
    assert.equal(r.outcome, 'resolved', 'replay 2: provisional outcome is honestly resolved (something was answered)');
    n += 5;

    // Line 3 — THE F3 LINE: a question asked while Q1 is pending is
    // answered, and the model's attempt to store the question AS
    // the answer is gated server-side. Nothing is stored.
    visitorTurn(sess.id, LEAD_MAIN, 'What do you do?');
    nextReply = JSON.stringify({
      action: 'answer',
      reply: 'We look after homes and rental properties across the county — repairs, installs and callouts.',
      qualification: [{ index: 0, status: 'answered', answer: 'What do you do?' }],
    });
    r = await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
    assert.equal(r.qualification.gated, 1, 'replay 3: the miscapture report was gated');
    assert.equal(rec().items[0].status, 'asked', 'replay 3: Q1 is still waiting — the question was NOT stored as its answer');
    assert.equal(rec().items[0].answer, null, 'replay 3: no answer text was stored');
    assert.ok(agentBodies(sess.id).some((b) => b.includes('repairs, installs and callouts')), 'replay 3: the visitor question itself was answered');
    n += 4;

    // Line 4 — another mid-flow question: answered with a short
    // bridge in the reply; the pending question is untouched.
    visitorTurn(sess.id, LEAD_MAIN, 'Do you cover my area?');
    nextReply = JSON.stringify({
      action: 'answer',
      reply: 'Yes — we cover the whole county. And is this for your home or a rental property?',
      qualification: [],
    });
    r = await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
    assert.ok(agentBodies(sess.id).some((b) => b.includes('cover the whole county')), 'replay 4: the interrupting question was answered');
    assert.equal(rec().items[0].status, 'asked', 'replay 4: Q1 still waiting after the bridge');
    assert.equal(state().answered_count, 3, 'replay 4: answered turns keep counting');
    n += 3;

    // Line 5 — the real answer lands, and the next question opens.
    visitorTurn(sess.id, LEAD_MAIN, 'It is for my home');
    nextReply = JSON.stringify({
      action: 'chat',
      reply: 'Perfect, thank you. When are you hoping to have the work done?',
      qualification: [
        { index: 0, status: 'answered', answer: 'For my home' },
        { index: 1, status: 'asked' },
      ],
    });
    r = await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
    assert.deepEqual(r.qualification, { applied: 2, skipped: 0, gated: 0 }, 'replay 5: answer + next ask recorded');
    assert.equal(rec().items[0].answer, 'For my home', 'replay 5: the real answer is stored');
    assert.equal(rec().items[1].status, 'asked', 'replay 5: Q2 is waiting');
    n += 3;

    // Line 6 — a decline is recorded deterministically by the
    // harness (the prompt for THIS turn already shows it declined);
    // declined is terminal — it is never re-asked.
    visitorTurn(sess.id, LEAD_MAIN, 'skip');
    nextReply = JSON.stringify({ action: 'chat', reply: 'No problem at all — happy to keep helping here.', qualification: [] });
    r = await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
    assert.ok(
      prompts[prompts.length - 1].messages[0].content.includes(`"${Q2}" — the visitor passed on this one`),
      'replay 6: the harness decline is already in this turn\u2019s prompt'
    );
    assert.equal(rec().items[1].status, 'declined', 'replay 6: the decline is recorded');
    n += 2;

    // Line 7 — a human request mid-flow: the harness hands off
    // WITHOUT consulting the model.
    const callsBefore = chatCalls;
    visitorTurn(sess.id, LEAD_MAIN, 'Can I talk to a person?');
    r = await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
    assert.equal(r.via, 'harness_handoff', 'replay 7: human request takes the handoff path');
    assert.equal(chatCalls, callsBefore, 'replay 7: the model was not consulted');
    const esc = db
      .prepare("SELECT * FROM chatbot_escalations WHERE session_id = ? AND reason = 'visitor_requested_human'")
      .get(sess.id);
    assert.ok(esc, 'replay 7: an escalation row exists for the team');
    assert.equal(state().handoff_requested, true, 'replay 7: the handoff flag is set');
    assert.equal(state().outcome, 'escalated', 'replay 7: the honest outcome is escalated');
    n += 5;

    // Line 8 — while the handoff is pending the AI stands down; a
    // human reply clears the stand-down.
    visitorTurn(sess.id, LEAD_MAIN, 'Hello — anyone there?');
    r = await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
    assert.deepEqual({ skipped: r.skipped, reason: r.reason }, { skipped: true, reason: 'handoff_pending' }, 'replay 8: AI stands down while a person is expected');
    chat.agentReply(db, LEAD_MAIN, sess.id, 'Hi, this is Sam from the team — how can I help?');
    assert.equal(chat.getChatState(db, sess.id).handoff_requested, false, 'replay 8: a human reply clears the stand-down');
    n += 2;

    unstubAi();
    group('Part 2 ITEM 73 transcript replay', n);
  }

  /* ================================================================== */
  /* Part 3 — harness cancels + E6 guard + re-ask budget via fallback    */
  /* ================================================================== */
  {
    let n = 0;
    stubAi(null);

    // Cancel the questions: named confirmation + suppression.
    {
      const sess = makeSession(LEAD_MAIN);
      visitorTurn(sess.id, LEAD_MAIN, 'What are your opening hours?');
      nextReply = JSON.stringify({
        action: 'answer',
        reply: 'Monday to Friday, 9am to 5pm. Is this for your home or a rental property?',
        qualification: [{ index: 0, status: 'asked' }],
      });
      await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
      visitorTurn(sess.id, LEAD_MAIN, "I don't want to answer questions");
      const callsBefore = chatCalls;
      const r = await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
      assert.equal(r.via, 'harness_cancel', 'cancel: the harness answers, not the model');
      assert.equal(chatCalls, callsBefore, 'cancel: model not consulted');
      assert.ok(agentBodies(sess.id).some((b) => b.includes("I've cancelled those questions")), 'cancel: the confirmation names what was cancelled');
      assert.equal(chat.getSessionQualification(db, sess.id).items[0].status, 'declined', 'cancel: the waiting question is closed as declined');
      assert.equal(chat.getChatState(db, sess.id).suppress_qual, true, 'cancel: questions suppressed for the session');
      // The conversation continues — with no qualifying block at all.
      visitorTurn(sess.id, LEAD_MAIN, 'What are your opening hours?');
      nextReply = JSON.stringify({ action: 'answer', reply: 'Monday to Friday, 9am to 5pm.', qualification: [] });
      const r2 = await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
      assert.equal(r2.via, 'chatgpt', 'cancel: the chat itself continues normally');
      assert.ok(!prompts[prompts.length - 1].messages[0].content.includes('Qualifying questions'), 'cancel: no qualifying block in later prompts');
      n += 7;
    }

    // Cancel the capture offer: named confirmation; a later capture
    // attempt is downgraded and the form does not re-open.
    {
      const sess = makeSession(LEAD_PLAIN);
      visitorTurn(sess.id, LEAD_PLAIN, 'I need a plumber for my rental');
      visitorTurn(sess.id, LEAD_PLAIN, 'The kitchen sink is leaking');
      nextReply = JSON.stringify({
        action: 'capture',
        reply: 'Thanks — a short contact form is about to appear so the team can reach you fast.',
        qualification: [],
      });
      let r = await chat.runAiFallbackReply(WS_ID, LEAD_PLAIN, sess.id);
      assert.equal(r.action, 'capture', 'capture-cancel: the offer went out first');
      const formsBefore = chat
        .listMessages(db, sess.id, { limit: 100 })
        .filter((m) => m.role === 'system' && m.meta && m.meta.open_lead_form).length;
      assert.equal(formsBefore, 1, 'capture-cancel: the form opened once');
      visitorTurn(sess.id, LEAD_PLAIN, 'no thanks');
      r = await chat.runAiFallbackReply(WS_ID, LEAD_PLAIN, sess.id);
      assert.equal(r.via, 'harness_cancel', 'capture-cancel: harness path');
      assert.ok(agentBodies(sess.id).some((b) => b.includes("I've cancelled asking for your details")), 'capture-cancel: confirmation names the capture');
      assert.equal(chat.getChatState(db, sess.id).suppress_capture, true, 'capture-cancel: capture suppressed');
      visitorTurn(sess.id, LEAD_PLAIN, 'Just tell me your opening hours instead');
      nextReply = JSON.stringify({
        action: 'capture',
        reply: 'Thanks — a short contact form is about to appear so the team can reach you fast.',
        qualification: [],
      });
      r = await chat.runAiFallbackReply(WS_ID, LEAD_PLAIN, sess.id);
      assert.ok(agentBodies(sess.id).some((b) => b.includes('happy to keep helping right here')), 'capture-cancel: a later capture is downgraded to a plain reply');
      const formsAfter = chat
        .listMessages(db, sess.id, { limit: 100 })
        .filter((m) => m.role === 'system' && m.meta && m.meta.open_lead_form).length;
      assert.equal(formsAfter, 1, 'capture-cancel: the form never re-opens');
      n += 7;
    }

    // Cancel the booking: the pitch leaves later prompts.
    {
      const emb = sm.ensureEmbed(db, LEAD_BOOKING, 'bookings', { workspaceId: WS_ID });
      db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(emb.id);
      sm.createBookingService(db, LEAD_BOOKING, { name: 'Haircut', status: 'published', price_cents: 5000 });
      assert.ok(share.getBookingPitch(db, LEAD_BOOKING), 'booking-cancel: the pitch is live for this lead');
      const sess = makeSession(LEAD_BOOKING);
      visitorTurn(sess.id, LEAD_BOOKING, "I don't want to book anything — just browsing");
      const r = await chat.runAiFallbackReply(WS_ID, LEAD_BOOKING, sess.id);
      assert.equal(r.via, 'harness_cancel', 'booking-cancel: harness path');
      assert.ok(agentBodies(sess.id).some((b) => b.includes("I've cancelled that booking")), 'booking-cancel: confirmation names the booking');
      assert.equal(chat.getChatState(db, sess.id).suppress_booking, true, 'booking-cancel: pitch suppressed');
      visitorTurn(sess.id, LEAD_BOOKING, 'What are your opening hours?');
      nextReply = JSON.stringify({ action: 'answer', reply: 'Monday to Friday, 9am to 5pm.', qualification: [] });
      await chat.runAiFallbackReply(WS_ID, LEAD_BOOKING, sess.id);
      assert.ok(
        !prompts[prompts.length - 1].messages[0].content.includes('Online booking (always true on this site):'),
        'booking-cancel: the pitch is gone from later prompts (no re-pitch)'
      );
      n += 5;
    }

    // Rule E6 through the harness: the pending question's own text
    // offers "talk to someone" — the reply is its ANSWER, never a
    // handoff, even though it matches the human-request pattern.
    {
      const LEAD_E6 = 16705;
      db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
        LEAD_E6,
        'B167 Lead 16705',
        'lead16705@example.invalid',
        'customer'
      );
      const EQ = 'Would you like to talk to someone on our team about it, or shall I note it here?';
      chat.saveSettings(db, LEAD_E6, { qualifying_enabled: true, qualifying_questions: [EQ] });
      const sess = makeSession(LEAD_E6);
      visitorTurn(sess.id, LEAD_E6, 'What are your opening hours?');
      nextReply = JSON.stringify({
        action: 'answer',
        reply: 'Monday to Friday, 9am to 5pm. Would you like to talk to someone on our team about it, or shall I note it here?',
        qualification: [{ index: 0, status: 'asked' }],
      });
      await chat.runAiFallbackReply(WS_ID, LEAD_E6, sess.id);
      visitorTurn(sess.id, LEAD_E6, 'talk to someone');
      nextReply = JSON.stringify({
        action: 'chat',
        reply: 'Of course — noting that down.',
        qualification: [{ index: 0, status: 'answered', answer: 'Talk to someone on the team' }],
      });
      const r = await chat.runAiFallbackReply(WS_ID, LEAD_E6, sess.id);
      assert.equal(r.via, 'chatgpt', 'E6: the reply was treated as the answer, not a handoff');
      assert.equal(chat.getSessionQualification(db, sess.id).items[0].status, 'answered', 'E6: the answer recorded');
      const escCount = db
        .prepare('SELECT COUNT(*) AS c FROM chatbot_escalations WHERE session_id = ?')
        .get(sess.id).c;
      assert.equal(escCount, 0, 'E6: no escalation was created');
      n += 3;
    }

    // Re-ask budget through the fallback: two bridged re-asks mute
    // the question; the prompt then carries the do-not-ask line.
    {
      const sess = makeSession(LEAD_MAIN);
      visitorTurn(sess.id, LEAD_MAIN, 'What are your opening hours?');
      nextReply = JSON.stringify({
        action: 'answer',
        reply: 'Monday to Friday, 9am to 5pm. Is this for your home or a rental property?',
        qualification: [{ index: 0, status: 'asked' }],
      });
      await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
      for (const q of ['Do you cover my area?', 'Do you work weekends?']) {
        visitorTurn(sess.id, LEAD_MAIN, q);
        nextReply = JSON.stringify({
          action: 'answer',
          reply: 'Yes. Is this for your home or a rental property?',
          qualification: [{ index: 0, status: 'asked' }],
        });
        await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
      }
      const rec = chat.getSessionQualification(db, sess.id);
      assert.equal(rec.items[0].reasks, 2, 're-ask: both bridged re-asks counted');
      assert.equal(rec.items[0].muted, true, 're-ask: past the default budget of 1 the question is muted');
      visitorTurn(sess.id, LEAD_MAIN, 'And do you have parking?');
      nextReply = JSON.stringify({ action: 'answer', reply: 'Yes, right outside.', qualification: [] });
      await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
      assert.ok(
        prompts[prompts.length - 1].messages[0].content.includes('do NOT ask it again this session'),
        're-ask: the next prompt carries the muted do-not-ask line'
      );
      n += 3;
    }

    unstubAi();
    group('Part 3 harness cancels + E6 guard + re-ask budget', n);
  }

  /* ================================================================== */
  /* Part 4 — ladder, fact-check, outcomes at the ends, heuristic        */
  /* ================================================================== */
  {
    let n = 0;
    stubAi(null);

    // Fallback ladder at the DEFAULT threshold (3 consecutive
    // substantive questions the model cannot answer).
    {
      const sess = makeSession(LEAD_PLAIN);
      const state = () => chat.getChatState(db, sess.id);
      const qs = ['Do you fix dishwashers?', 'Do you offer weekend callouts?', 'Is there a callout fee?'];
      let r;
      for (let i = 0; i < 2; i++) {
        visitorTurn(sess.id, LEAD_PLAIN, qs[i]);
        nextReply = JSON.stringify({ action: 'chat', reply: 'Hmm, let me think about that differently.', qualification: [] });
        r = await chat.runAiFallbackReply(WS_ID, LEAD_PLAIN, sess.id);
        assert.equal(r.via, 'chatgpt', `ladder: miss ${i + 1} is still a normal reply`);
        assert.equal(state().miss_streak, i + 1, `ladder: streak is ${i + 1}`);
      }
      assert.equal(state().outcome, 'unresolved', 'ladder: misses with nothing achieved read unresolved');
      visitorTurn(sess.id, LEAD_PLAIN, qs[2]);
      nextReply = JSON.stringify({ action: 'chat', reply: 'Hmm, let me think about that differently.', qualification: [] });
      r = await chat.runAiFallbackReply(WS_ID, LEAD_PLAIN, sess.id);
      assert.equal(r.via, 'fallback_ladder', 'ladder: the third consecutive miss becomes the person offer');
      const esc = db
        .prepare("SELECT * FROM chatbot_escalations WHERE session_id = ? AND reason = 'repeated_unanswered'")
        .get(sess.id);
      assert.ok(esc, 'ladder: the escalation (person offer) exists');
      assert.ok(agentBodies(sess.id).some((b) => b.includes('A team member will follow up')), 'ladder: the escalation lines posted to the visitor');
      assert.equal(state().handoff_requested, true, 'ladder: handoff flag set');
      assert.equal(state().miss_total, 3, 'ladder: all three misses counted');
      assert.equal(state().outcome, 'escalated', 'ladder: outcome escalated');
      n += 9;
    }

    // The threshold is the admin setting, read live: set it to 2 and
    // the ladder fires a turn earlier. Restored to the default after.
    {
      await platform.setPlatformSetting('chat.fallback_handoff_at', '2');
      try {
        const sess = makeSession(LEAD_PLAIN);
        visitorTurn(sess.id, LEAD_PLAIN, 'Do you fix dishwashers?');
        nextReply = JSON.stringify({ action: 'chat', reply: 'Hmm.', qualification: [] });
        let r = await chat.runAiFallbackReply(WS_ID, LEAD_PLAIN, sess.id);
        assert.equal(r.via, 'chatgpt', 'setting: first miss still a normal reply at threshold 2');
        visitorTurn(sess.id, LEAD_PLAIN, 'Do you offer weekend callouts?');
        nextReply = JSON.stringify({ action: 'chat', reply: 'Hmm.', qualification: [] });
        r = await chat.runAiFallbackReply(WS_ID, LEAD_PLAIN, sess.id);
        assert.equal(r.via, 'fallback_ladder', 'setting: the ladder honours the admin-set threshold of 2');
        n += 2;
      } finally {
        await platform.setPlatformSetting('chat.fallback_handoff_at', '');
      }
    }

    // Price fact-check (Rule H): invented price → one regeneration
    // fixes it; a repeat invention downgrades to an honest unknown
    // + fact_check_blocks + a miss; a ≤3-item sum passes untouched.
    {
      pricing.createPricingEntry(db, LEAD_BOOK, { name: 'Monstera Deliciosa', price_cents: 5800, status: 'published' });
      const sess = makeSession(LEAD_BOOK);
      const state = () => chat.getChatState(db, sess.id);
      visitorTurn(sess.id, LEAD_BOOK, 'How much is the Monstera?');
      stubAi([
        JSON.stringify({ action: 'answer', reply: 'The Monstera Deliciosa is $999.', qualification: [] }),
        JSON.stringify({ action: 'answer', reply: 'The Monstera Deliciosa is $58.', qualification: [] }),
      ]);
      const callsBefore = chatCalls;
      let r = await chat.runAiFallbackReply(WS_ID, LEAD_BOOK, sess.id);
      assert.equal(chatCalls - callsBefore, 2, 'fact-check: exactly one regeneration was attempted');
      assert.ok(agentBodies(sess.id).some((b) => b.includes('$58') && !b.includes('$999')), 'fact-check: the grounded price reached the visitor, not the invented one');
      assert.equal(state().fact_check_blocks, 0, 'fact-check: a fixed regeneration is not a block');
      assert.equal(state().answered_count, 1, 'fact-check: the corrected answer counts as answered');

      visitorTurn(sess.id, LEAD_BOOK, 'And the large olive tree?');
      stubAi([
        JSON.stringify({ action: 'answer', reply: 'The large olive tree is $450.', qualification: [] }),
        JSON.stringify({ action: 'answer', reply: 'The large olive tree is $450.', qualification: [] }),
      ]);
      r = await chat.runAiFallbackReply(WS_ID, LEAD_BOOK, sess.id);
      assert.ok(
        agentBodies(sess.id).some((b) => b.includes("don't have that price confirmed")),
        'fact-check: a second violation downgrades to the honest unknown'
      );
      assert.equal(state().fact_check_blocks, 1, 'fact-check: the block is counted');
      assert.equal(state().miss_streak, 1, 'fact-check: a downgrade counts as a miss on the ladder');

      visitorTurn(sess.id, LEAD_BOOK, 'What about two Monsteras together?');
      stubAi([JSON.stringify({ action: 'answer', reply: 'Two Monsteras come to $116 in total.', qualification: [] })]);
      const callsBefore2 = chatCalls;
      r = await chat.runAiFallbackReply(WS_ID, LEAD_BOOK, sess.id);
      assert.equal(chatCalls - callsBefore2, 1, 'fact-check: a grounded sum needs no regeneration');
      assert.ok(agentBodies(sess.id).some((b) => b.includes('$116')), 'fact-check: the 2-item sum reached the visitor');
      stubAi(null);
      n += 8;
    }

    // Honest outcome at the capture "end" + portal summary counts.
    {
      const sess = makeSession(LEAD_PLAIN);
      visitorTurn(sess.id, LEAD_PLAIN, 'What are your opening hours?');
      nextReply = JSON.stringify({ action: 'answer', reply: 'Monday to Friday, 9am to 5pm.', qualification: [] });
      const r = await chat.runAiFallbackReply(WS_ID, LEAD_PLAIN, sess.id);
      assert.equal(r.outcome, 'resolved', 'outcome: the answered session reads resolved provisionally');
      const emb = sm.ensureEmbed(db, LEAD_PLAIN, 'chatbot', { workspaceId: WS_ID });
      db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(emb.id);
      chat.captureLead(db, emb.public_token, {
        name: 'Pat Visitor',
        email: 'pat167@example.invalid',
        phone: '',
        message: 'Please call me back',
        session: sess.token,
      });
      const pub = chat.publicSession(db.prepare('SELECT * FROM chatbot_sessions WHERE id = ?').get(sess.id));
      assert.equal(pub.outcome, 'resolved', 'outcome: after capture the stored outcome stays resolved (lead)');
      assert.ok(pub.chat_state && pub.chat_state.answered_count === 1, 'outcome: counters ride the public session when state exists');
      const summary = chat.portalChatbotSummary(db, LEAD_PLAIN);
      assert.ok(summary.outcomes && summary.outcomes.resolved >= 1, 'outcome: portal summary counts resolved sessions');
      assert.ok(summary.outcomes.escalated >= 1, 'outcome: portal summary counts the ladder-escalated session');
      n += 5;
    }

    // Heuristic path (no AI configured) is untouched by the port:
    // same canned behaviour, and NO chat state is written.
    {
      ai.aiConfigured = () => false;
      ai.chat = realChat;
      const sess = makeSession(LEAD_MAIN);
      visitorTurn(sess.id, LEAD_MAIN, 'My kitchen sink is leaking badly');
      visitorTurn(sess.id, LEAD_MAIN, 'It started yesterday and the cabinet is soaked');
      const r = await chat.runAiFallbackReply(WS_ID, LEAD_MAIN, sess.id);
      assert.equal(r.via, 'heuristic', 'heuristic: unconfigured AI still takes the heuristic path');
      assert.equal(chat.getChatState(db, sess.id), null, 'heuristic: no chat state is written');
      const pub = chat.publicSession(db.prepare('SELECT * FROM chatbot_sessions WHERE id = ?').get(sess.id));
      assert.ok(!('outcome' in pub), 'heuristic: the public session shape is unchanged without state');
      n += 3;
    }

    unstubAi();
    group('Part 4 ladder + fact-check + outcomes + heuristic', n);
  }

  console.log(
    `\nBatch 167 chat redesign regressions: ALL PASS — ${groups.join('; ')}`
  );
})().catch((err) => {
  console.error('\nBatch 167 chat redesign regressions FAILED:');
  console.error(err);
  process.exit(1);
});
