'use strict';
/**
 * Batch 137 — OWNER-SET QUALIFYING QUESTIONS for the site chatbot
 * (Ely's order 2026-11-04).
 *
 * The mechanic:
 *   - The business owner writes their own qualifying questions in
 *     the portal (Modules → Chatbot → Settings): plain text,
 *     add/edit/delete/reorder, on/off (default OFF), max 6, each
 *     ≤ 200 chars — validated on save, never silently rewritten.
 *     The config rides the chatbot's EXISTING settings store
 *     (chatbot_settings.settings_json, the ai_fallback extras) —
 *     no parallel system.
 *   - The chat asks ONLY the owner's questions, byte-for-byte, in
 *     owner order, woven into the conversation one at a time —
 *     never an interrogation, never a form. Questions the visitor
 *     already answered in their own words are not asked; declined
 *     questions are dropped gracefully; NOTHING (help, capture,
 *     booking) is ever blocked on an unanswered question, and the
 *     visitor never hears pass/fail language.
 *   - Answers are recorded on the chat session as a structured
 *     record ({question text SNAPSHOT, answer, status}) and shown
 *     in the portal inbox (escalations, lead captures, and a
 *     qualifying-answers session list). Editing the owner's list
 *     later never rewrites a recorded snapshot. On a lead capture
 *     the record rides the chat module's existing capture path
 *     (chatbot_leads snapshot + escalation text + owner notify).
 *   - Booking independence (Batch 136 seam): the qualification
 *     block never removes or conditions the module-state booking
 *     pitch. On this Batch 128 base the pitch does not exist yet —
 *     Part 7 prints an explicit SKIP and activates on the
 *     finisher's post-rebase run.
 *
 *   Part 1 — source pins (incl. privacy + no-gating pins).
 *   Part 2 — config CRUD + reorder + validation + caps.
 *   Part 3 — context injection matrix (agent context; public
 *     config stays clean; prompt block byte-equality).
 *   Part 4 — answer recording at the storage layer + agentReply.
 *   Part 5 — AI fallback end-to-end with a stubbed model:
 *     prompt capture, weaving reports recorded, capture NOT gated.
 *   Part 6 — capture ride-along + escalation + portal inbox data.
 *   Part 7 — POST-REBASE Batch 136 booking-pitch independence
 *     (explicit SKIP on this base — never a silent skip).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b137-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch137', 'test', 'session', 'secret', 'value'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 21).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const LEAD_OFF = 13701;
const LEAD_ON = 13702;
const LEAD_AGENT = 13703;
const LEAD_CAPTURE = 13704;
let WS_ID;
let db;

const Q1 = 'Is this for your home or a rental property?';
const Q2 = 'When are you hoping to have the work done?';
const Q3 = 'Roughly how big is the job — one room, or the whole place?';
const QUESTIONS = [Q1, Q2, Q3];

function makeSession(leadId) {
  const token = `b137-${leadId}-${Math.random().toString(36).slice(2, 12)}`;
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

(async () => {
  const chatSrc = read('server/chatbot.js');

  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    // Config rides the EXISTING settings store (settings_json extras).
    assert.ok(
      chatSrc.includes('qualifying_enabled: extra.qualifying_enabled'),
      'settings read: qualifying switch from settings_json extras'
    );
    assert.ok(
      chatSrc.includes('normalizeQualifyingQuestions(data.qualifying_questions)'),
      'settings write: questions validated on save'
    );
    assert.ok(
      chatSrc.includes('qualifying_questions: next.qualifying_questions'),
      'settings write: questions persist into the same extras object'
    );
    assert.ok(!/CREATE TABLE[^;]*qualifying/i.test(chatSrc), 'no new config table — no parallel settings system');
    n += 4;

    // Prompt injection is a conditional spread (off = prompt unchanged).
    assert.ok(
      chatSrc.includes('...qualifyingPromptLines(snapshot.qualification)'),
      'fallback prompt gains the block via conditional spread only'
    );
    const blockBody = chatSrc.slice(
      chatSrc.indexOf('function qualifyingPromptLines'),
      chatSrc.indexOf('function getSessionByToken')
    );
    assert.ok(blockBody.includes('EXACTLY as written, word for word'), 'prompt: owner questions are verbatim-only');
    assert.ok(
      blockBody.includes('never invent, add, or rephrase screening questions'),
      'prompt: the model never invents screening questions'
    );
    assert.ok(
      blockBody.includes('never block help, information, lead capture, or booking'),
      'prompt: nothing is gated on an answer'
    );
    assert.ok(
      blockBody.includes('there is no pass or fail'),
      'prompt: no pass/fail framing exists to leak visitor-side'
    );
    n += 5;

    // Recording layer never touches booking/capture gating.
    const recBody = chatSrc.slice(
      chatSrc.indexOf('function recordQualificationUpdates'),
      chatSrc.indexOf('const QUALIFYING_STATUS_LABELS')
    );
    assert.ok(
      !/booking|capture|visitorStatedNeed/i.test(recBody),
      'the recording layer inspects no booking/capture state'
    );
    assert.ok(
      chatSrc.includes('const MIN_VISITOR_TURNS_BEFORE_CAPTURE = 2'),
      'existing capture gating constant untouched'
    );
    n += 2;

    // Public config privacy: the owner's screening questions are
    // agent-side context, never public-token payload.
    const pubBody = chatSrc.slice(
      chatSrc.indexOf('function getPublicConfigByToken'),
      chatSrc.indexOf('function listAllowedActions')
    );
    assert.ok(!pubBody.includes('qualifying'), 'getPublicConfigByToken carries no qualifying content');
    n++;

    const shareSrc = read('server/moduleShare.js');
    assert.ok(
      shareSrc.includes("chatbot: {\n    kind: 'none',"),
      'chatbot stays an explicit NON-provider (registry parity untouched)'
    );
    const mcpSrc = read('server/clientMcp.js');
    assert.ok(
      mcpSrc.includes('qualification: a.qualification'),
      'client MCP chatbot.reply forwards qualification reports'
    );
    assert.ok(
      mcpSrc.includes('chat.qualifyingFor(db, leadId)'),
      'client MCP chatbot.getSession carries the qualifying config'
    );
    const portalSrc = read('public/js/portal.js');
    assert.ok(portalSrc.includes('id="chat-set-qualifying-enabled"'), 'portal settings pane carries the on/off switch');
    assert.ok(
      portalSrc.includes('id="chat-qualifying-rows"') && portalSrc.includes('id="btn-chat-qualifying-add"'),
      'portal settings pane carries the question list editor'
    );
    assert.ok(
      portalSrc.includes('qualBlockHtml') && portalSrc.includes('qualification_sessions'),
      'portal inbox renders Q&A blocks + the qualifying-answers list'
    );
    n += 6;
    group('Part 1 source pins', n);
  }

  /* ================================================================== */
  /* Setup                                                               */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const share = require(path.join(root, 'server/moduleShare.js'));
  const chat = require(path.join(root, 'server/chatbot.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a137@example.invalid',
    password: ['batch137', 'fixture', 'password'].join('-'),
    name: 'A137',
    workspaceName: 'Batch137 WS',
  });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  chat.ensureTables(db);
  for (const lead of [LEAD_OFF, LEAD_ON, LEAD_AGENT, LEAD_CAPTURE]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      lead,
      `B137 Lead ${lead}`,
      `lead${lead}@example.invalid`,
      'customer'
    );
  }
  assert.equal(sm.MODULE_TYPES.length, 28, 'MODULE_TYPES unchanged — no new module type');
  assert.ok(!sm.MODULE_TYPES.includes('qualifying'), 'no qualifying module type exists');

  /* ================================================================== */
  /* Part 2 — config CRUD + reorder + validation + caps                  */
  /* ================================================================== */
  {
    let n = 0;
    const dflt = chat.getSettings(db, LEAD_OFF);
    assert.equal(dflt.qualifying_enabled, false, 'qualifying defaults OFF');
    assert.deepEqual(dflt.qualifying_questions, [], 'qualifying list defaults empty');
    assert.equal(chat.qualifyingFor(db, LEAD_OFF), null, 'unconfigured lead: no qualifying context');
    n += 3;

    // Questions saved while OFF persist but publish nothing.
    chat.saveSettings(db, LEAD_ON, { qualifying_questions: QUESTIONS });
    assert.deepEqual(
      chat.getSettings(db, LEAD_ON).qualifying_questions,
      QUESTIONS,
      'questions persist byte-for-byte, in owner order'
    );
    assert.equal(chat.qualifyingFor(db, LEAD_ON), null, 'switch OFF: context stays empty even with questions saved');
    n += 2;

    // ON: the context reader serves the owner's words, byte-equal.
    chat.saveSettings(db, LEAD_ON, { qualifying_enabled: true });
    assert.deepEqual(chat.qualifyingFor(db, LEAD_ON), { questions: QUESTIONS }, 'ON: questions byte-equal and ordered');
    n++;

    // Reorder = save in the new order; the new order is what is served.
    const reordered = [Q3, Q1, Q2];
    chat.saveSettings(db, LEAD_ON, { qualifying_questions: reordered });
    assert.deepEqual(chat.qualifyingFor(db, LEAD_ON).questions, reordered, 'reorder persists');
    chat.saveSettings(db, LEAD_ON, { qualifying_questions: QUESTIONS });
    n++;

    // Edit + delete from the list.
    chat.saveSettings(db, LEAD_ON, { qualifying_questions: [Q1, 'Edited question — what town is the property in?'] });
    assert.deepEqual(
      chat.qualifyingFor(db, LEAD_ON).questions,
      [Q1, 'Edited question — what town is the property in?'],
      'edit + delete persist'
    );
    chat.saveSettings(db, LEAD_ON, { qualifying_questions: QUESTIONS });
    n++;

    // Partial saves leave the qualifying config untouched, and the
    // qualifying extras coexist with ai_fallback in settings_json.
    chat.saveSettings(db, LEAD_ON, { ai_fallback: false });
    let s = chat.getSettings(db, LEAD_ON);
    assert.equal(s.ai_fallback, false, 'ai_fallback saved');
    assert.deepEqual(s.qualifying_questions, QUESTIONS, 'ai_fallback save preserves the questions');
    chat.saveSettings(db, LEAD_ON, { greeting: 'Hello there' });
    s = chat.getSettings(db, LEAD_ON);
    assert.equal(s.ai_fallback, false, 'qualifying-era save preserves ai_fallback');
    assert.equal(s.qualifying_enabled, true, 'partial save preserves the switch');
    n += 4;

    // Caps at the boundary are accepted exactly.
    const six = ['One?', 'Two?', 'Three?', 'Four?', 'Five?', 'x'.repeat(200)];
    chat.saveSettings(db, LEAD_ON, { qualifying_questions: six });
    assert.equal(chat.qualifyingFor(db, LEAD_ON).questions.length, 6, 'exactly 6 questions accepted');
    assert.equal(chat.qualifyingFor(db, LEAD_ON).questions[5].length, 200, 'exactly 200 chars accepted');
    chat.saveSettings(db, LEAD_ON, { qualifying_questions: QUESTIONS });
    n += 2;

    // Validation refuses — never clamps or silently rewrites.
    assert.throws(
      () => chat.saveSettings(db, LEAD_ON, { qualifying_questions: [...QUESTIONS, 'a', 'b', 'c', 'd'] }),
      /At most 6/,
      'a 7th question is refused'
    );
    assert.throws(
      () => chat.saveSettings(db, LEAD_ON, { qualifying_questions: ['y'.repeat(201)] }),
      /over 200 characters/,
      'a 201-char question is refused'
    );
    assert.throws(
      () => chat.saveSettings(db, LEAD_ON, { qualifying_questions: ['Real?', '   '] }),
      /blank/,
      'a blank question is refused'
    );
    assert.throws(
      () => chat.saveSettings(db, LEAD_ON, { qualifying_questions: 'not a list' }),
      /must be a list/,
      'a non-list is refused'
    );
    assert.throws(
      () => chat.saveSettings(db, LEAD_ON, { qualifying_questions: [42] }),
      /plain text/,
      'a non-string question is refused'
    );
    assert.deepEqual(
      chat.qualifyingFor(db, LEAD_ON).questions,
      QUESTIONS,
      'refused saves leave the stored list untouched'
    );
    n += 6;

    // ON + empty list = behaves exactly as OFF.
    chat.saveSettings(db, LEAD_OFF, { qualifying_enabled: true, qualifying_questions: [] });
    assert.equal(chat.getSettings(db, LEAD_OFF).qualifying_enabled, true, 'the switch itself saves');
    assert.equal(chat.qualifyingFor(db, LEAD_OFF), null, 'ON + empty list: no context (behaves as off)');
    assert.equal(
      chat.qualifyingFromSettings(chat.getSettings(db, LEAD_OFF)).active,
      false,
      'effective config: inactive'
    );
    n += 3;
    group('Part 2 config CRUD + validation', n);
  }

  /* ================================================================== */
  /* Part 3 — context injection matrix                                   */
  /* ================================================================== */
  {
    let n = 0;
    // Agent context (pending) with the feature ON.
    const sess = makeSession(LEAD_ON);
    addMsg(sess.id, LEAD_ON, 'visitor', 'Hi, my sink is leaking');
    const pending = chat.listPendingSessions(db, LEAD_ON);
    assert.deepEqual(
      pending.qualifying,
      { questions: QUESTIONS },
      'pending context carries the owner questions byte-equal'
    );
    assert.ok(pending.hint.includes('Qualifying questions are ON'), 'pending hint carries the weaving instruction');
    const sOn = pending.sessions.find((s) => s.id === sess.id);
    assert.ok(sOn && sOn.qualification, 'first context build snapshots a record onto the session');
    assert.deepEqual(sOn.qualification.questions, QUESTIONS, 'record snapshot = owner list at first build');
    assert.ok(
      sOn.qualification.items.every((it) => it.status === 'pending' && it.answer === null),
      'record starts all-pending'
    );
    n += 5;

    // claimNext passes the same context through.
    const next = chat.claimNextSession(db, LEAD_ON);
    assert.deepEqual(next.qualifying, { questions: QUESTIONS }, 'claimNext carries the qualifying config');
    n++;

    // Feature OFF: no block, no record, hint untouched.
    const sessOff = makeSession(LEAD_OFF);
    addMsg(sessOff.id, LEAD_OFF, 'visitor', 'Hello?');
    const pendingOff = chat.listPendingSessions(db, LEAD_OFF);
    assert.equal(pendingOff.qualifying, null, 'OFF: no qualifying context');
    assert.ok(!pendingOff.hint.includes('Qualifying questions'), 'OFF: hint carries no qualifying text');
    const sOff = pendingOff.sessions.find((s) => s.id === sessOff.id);
    assert.equal(sOff.qualification, null, 'OFF: no record is created');
    assert.equal(chat.getSessionQualification(db, sessOff.id), null, 'OFF: nothing stored');
    n += 4;

    // The public widget config never leaks the owner's questions.
    const emb = sm.ensureEmbed(db, LEAD_ON, 'chatbot', { workspaceId: WS_ID });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(emb.id);
    const pub = chat.getPublicConfigByToken(db, emb.public_token);
    assert.ok(!JSON.stringify(pub).includes(Q1), 'public config contains no question text');
    assert.ok(!('qualifying_questions' in pub.settings), 'public settings shape unchanged');
    n += 2;

    // The prompt block itself: byte-equal questions, ordered, with
    // the live state of each item; null record = no block at all.
    assert.deepEqual(chat.qualifyingPromptLines(null), [], 'no record -> no prompt block (off = identical prompt)');
    const rec = chat.ensureSessionQualification(db, LEAD_ON, sess.id);
    const lines = chat.qualifyingPromptLines(rec);
    const i1 = lines.findIndex((l) => l.includes(`"${Q1}"`));
    const i2 = lines.findIndex((l) => l.includes(`"${Q2}"`));
    const i3 = lines.findIndex((l) => l.includes(`"${Q3}"`));
    assert.ok(i1 >= 0 && i2 > i1 && i3 > i2, 'prompt block lists the questions byte-equal, in owner order');
    assert.ok(
      lines.some((l) => l.includes('ONE at a time')),
      'prompt carries the one-at-a-time weaving rule'
    );
    n += 3;
    group('Part 3 context injection matrix', n);
  }

  /* ================================================================== */
  /* Part 4 — answer recording (storage layer + agentReply)              */
  /* ================================================================== */
  {
    let n = 0;
    const sess = makeSession(LEAD_ON);
    addMsg(sess.id, LEAD_ON, 'visitor', 'The basement flooded');
    const rec0 = chat.ensureSessionQualification(db, LEAD_ON, sess.id);
    assert.deepEqual(rec0.questions, QUESTIONS, 'record snapshots the current owner list');
    n++;

    // The owner edits the list AFTER the session snapshot: history
    // (and update indexes) must not move.
    chat.saveSettings(db, LEAD_ON, { qualifying_questions: ['A brand new question?'] });
    const recFrozen = chat.ensureSessionQualification(db, LEAD_ON, sess.id);
    assert.deepEqual(recFrozen.questions, QUESTIONS, 'snapshot is frozen against later owner edits');
    chat.saveSettings(db, LEAD_ON, { qualifying_questions: QUESTIONS });
    n++;

    // Status flow: asked -> answered; conversation-answered; declined
    // (alias spellings normalize to the canonical statuses).
    let r = chat.recordQualificationUpdates(db, LEAD_ON, sess.id, [{ index: 0, status: 'asked' }]);
    assert.equal(r.applied, 1);
    assert.equal(r.record.items[0].status, 'asked');
    assert.equal(r.record.items[0].answer, null);
    r = chat.recordQualificationUpdates(db, LEAD_ON, sess.id, [
      { index: 0, status: 'answered', answer: 'For my home' },
      { index: 1, status: 'answered-from-conversation', answer: 'This week, ideally' },
      { index: 2, status: 'skipped-declined' },
    ]);
    assert.equal(r.applied, 3, 'all three reports applied');
    assert.equal(r.record.items[0].status, 'answered');
    assert.equal(r.record.items[0].answer, 'For my home');
    assert.equal(r.record.items[1].status, 'answered_from_conversation', 'alias normalizes to the canonical status');
    assert.equal(r.record.items[1].answer, 'This week, ideally');
    assert.equal(r.record.items[2].status, 'declined', 'skipped-declined normalizes to declined');
    n += 8;

    // Terminal states are sticky: a late "asked" never erases an
    // answer; a declined question never comes back as answered.
    r = chat.recordQualificationUpdates(db, LEAD_ON, sess.id, [
      { index: 0, status: 'asked' },
      { index: 2, status: 'answered', answer: 'Whole place' },
    ]);
    assert.equal(r.applied, 0, 'terminal-state rewrites are refused');
    assert.equal(r.skipped, 2);
    assert.equal(r.record.items[0].status, 'answered', 'the answer survives');
    assert.equal(r.record.items[2].status, 'declined', 'the decline survives');
    n += 4;

    // Invalid reports are skipped and counted, never stored raw.
    r = chat.recordQualificationUpdates(db, LEAD_ON, sess.id, [
      { index: 9, status: 'answered', answer: 'nowhere' },
      { index: 1, status: 'bogus-status' },
      { status: 'answered' },
      'garbage',
    ]);
    assert.equal(r.applied, 0);
    assert.equal(r.skipped, 4, 'out-of-range index, bad status, missing target, non-object: all skipped');
    n += 2;

    // Question-text targeting lands on the right snapshot item.
    const sess2 = makeSession(LEAD_ON);
    chat.ensureSessionQualification(db, LEAD_ON, sess2.id);
    r = chat.recordQualificationUpdates(db, LEAD_ON, sess2.id, [
      { question: Q2, status: 'answered', answer: 'Next month' },
    ]);
    assert.equal(r.applied, 1);
    assert.equal(r.record.items[1].answer, 'Next month');
    assert.equal(r.record.items[0].status, 'pending', 'other items untouched');
    n += 3;

    // Feature never configured for the lead: recording is a no-op
    // with a stated reason, not an error and not a phantom record.
    const sessOff = makeSession(LEAD_OFF);
    r = chat.recordQualificationUpdates(db, LEAD_OFF, sessOff.id, [{ index: 0, status: 'answered', answer: 'x' }]);
    assert.equal(r.record, null);
    assert.equal(r.reason, 'not_configured');
    assert.equal(chat.getSessionQualification(db, sessOff.id), null, 'no record materializes while off');
    n += 3;

    // publicSession carries the record (every session surface).
    const row = chat.getSessionById(db, LEAD_ON, sess.id);
    const pub = chat.publicSession(row);
    assert.equal(pub.qualification.items[0].answer, 'For my home', 'publicSession exposes the recorded answer');
    n++;

    // The live-agent path: chatbot.reply's qualification param,
    // driven through agentReply exactly as clientMcp calls it.
    chat.saveSettings(db, LEAD_AGENT, { qualifying_enabled: true, qualifying_questions: QUESTIONS });
    const aSess = makeSession(LEAD_AGENT);
    addMsg(aSess.id, LEAD_AGENT, 'visitor', 'Do you service rentals?');
    const rep1 = chat.agentReply(
      db,
      LEAD_AGENT,
      aSess.id,
      'We do! Quick question — is this for your home or a rental property?',
      null,
      {
        qualification: [{ index: 0, status: 'asked' }],
      }
    );
    assert.equal(rep1.qualification_applied, 1, 'reply reports the asked state');
    addMsg(aSess.id, LEAD_AGENT, 'visitor', 'A rental property');
    const rep2 = chat.agentReply(db, LEAD_AGENT, aSess.id, 'Great, thanks.', null, {
      qualification: [{ index: 0, status: 'answered', answer: 'A rental property' }],
    });
    assert.equal(rep2.qualification_applied, 1);
    assert.equal(
      rep2.session.qualification.items[0].answer,
      'A rental property',
      'the reply return carries the fresh record'
    );
    assert.equal(
      chat.getSessionQualification(db, aSess.id).items[0].status,
      'answered',
      'the answer is stored on the session'
    );
    n += 4;

    // The fallback's JSON parser carries reports through untouched
    // (validation happens at record time, not parse time).
    const parsed = chat.parseAiFallbackResponse(
      JSON.stringify({ action: 'chat', reply: 'Sure!', qualification: [{ index: 0, status: 'asked' }] }),
      { businessName: 'B137', allowCapture: false }
    );
    assert.equal(parsed.action, 'chat');
    assert.deepEqual(
      parsed.qualification,
      [{ index: 0, status: 'asked' }],
      'qualification array rides the parsed response'
    );
    const plain = chat.parseAiFallbackResponse(JSON.stringify({ action: 'chat', reply: 'Sure!' }), {
      businessName: 'B137',
      allowCapture: false,
    });
    assert.equal(plain.qualification, undefined, 'no reports -> no qualification field (pre-137 shape)');
    n += 3;
    group('Part 4 answer recording', n);
  }

  /* ================================================================== */
  /* Part 5 — AI fallback end-to-end (stubbed model)                     */
  /* ================================================================== */
  {
    let n = 0;
    const ai = require(path.join(root, 'src/ai.js'));
    const realChat = ai.chat;
    const realConfigured = ai.aiConfigured;
    const prompts = [];
    let nextReply = '';

    // 5a — heuristic path (no AI configured): the reply still posts
    // and the session record is snapshotted, all-pending.
    ai.aiConfigured = () => false;
    const hSess = makeSession(LEAD_ON);
    addMsg(hSess.id, LEAD_ON, 'visitor', 'My kitchen sink is leaking badly');
    addMsg(hSess.id, LEAD_ON, 'visitor', 'It started yesterday and the cabinet underneath is soaked');
    const hRes = await chat.runAiFallbackReply(WS_ID, LEAD_ON, hSess.id);
    assert.equal(hRes.via, 'heuristic', 'unconfigured AI takes the heuristic path');
    const hRec = chat.getSessionQualification(db, hSess.id);
    assert.ok(
      hRec && hRec.items.every((it) => it.status === 'pending'),
      'heuristic path: record snapshotted, nothing invented'
    );
    n += 2;

    // 5b — AI path: the prompt carries the owner's questions
    // byte-equal and ordered; the model's reports are recorded.
    ai.aiConfigured = () => true;
    ai.chat = async (args) => {
      prompts.push(args);
      return { text: nextReply };
    };
    const sess = makeSession(LEAD_ON);
    addMsg(sess.id, LEAD_ON, 'visitor', 'Hi, my bathroom tap will not stop dripping');
    addMsg(sess.id, LEAD_ON, 'visitor', 'It is getting worse every day');
    nextReply = JSON.stringify({
      action: 'chat',
      reply: 'Happy to help with that. Quick question — is this for your home or a rental property?',
      qualification: [{ index: 0, status: 'asked' }],
    });
    const r1 = await chat.runAiFallbackReply(WS_ID, LEAD_ON, sess.id);
    assert.equal(r1.via, 'chatgpt');
    assert.deepEqual(r1.qualification, { applied: 1, skipped: 0 }, 'the asked report was recorded');
    const prompt1 = prompts[0].messages[0].content;
    const p1 = prompt1.indexOf(`"${Q1}"`);
    const p2 = prompt1.indexOf(`"${Q2}"`);
    const p3 = prompt1.indexOf(`"${Q3}"`);
    assert.ok(p1 >= 0 && p2 > p1 && p3 > p2, 'prompt: questions byte-equal, in owner order');
    assert.ok(prompt1.includes('Qualifying questions from the business owner'), 'prompt: the block is present when ON');
    assert.equal(chat.getSessionQualification(db, sess.id).items[0].status, 'asked');
    n += 5;

    // Turn 2: the prompt shows Q1 as asked; the visitor's answer
    // (and the volunteered timing for Q2) get recorded.
    addMsg(sess.id, LEAD_ON, 'visitor', 'It is for my home — and I really need it done this week');
    db.prepare('UPDATE chatbot_sessions SET needs_agent = 1 WHERE id = ?').run(sess.id);
    nextReply = JSON.stringify({
      action: 'chat',
      reply: 'Perfect, thank you — this week it is.',
      qualification: [
        { index: 0, status: 'answered', answer: 'For my home' },
        { index: 1, status: 'answered', answer: 'This week' },
      ],
    });
    const r2 = await chat.runAiFallbackReply(WS_ID, LEAD_ON, sess.id);
    assert.deepEqual(r2.qualification, { applied: 2, skipped: 0 });
    const prompt2 = prompts[1].messages[0].content;
    assert.ok(prompt2.includes(`"${Q1}" — asked`), 'second-turn prompt shows the asked state (no re-ask from scratch)');
    const rec2 = chat.getSessionQualification(db, sess.id);
    assert.equal(rec2.items[0].answer, 'For my home');
    assert.equal(rec2.items[1].answer, 'This week');
    assert.equal(rec2.items[2].status, 'pending', 'unreached questions stay pending');
    n += 5;

    // 5c — feature OFF: the prompt is the pre-137 prompt (no block,
    // the original response contract, verbatim).
    const offSess = makeSession(LEAD_OFF);
    addMsg(offSess.id, LEAD_OFF, 'visitor', 'What are your opening hours?');
    nextReply = JSON.stringify({ action: 'chat', reply: 'Hello!' });
    const r3 = await chat.runAiFallbackReply(WS_ID, LEAD_OFF, offSess.id);
    assert.equal(r3.via, 'chatgpt');
    assert.equal(r3.qualification, undefined, 'OFF: no qualification bookkeeping on the reply');
    const promptOff = prompts[2].messages[0].content;
    assert.ok(!promptOff.includes('Qualifying questions'), 'OFF: prompt has no qualifying block');
    assert.ok(
      promptOff.includes('{"action":"chat"|"answer"|"capture","reply":"..."}'),
      'OFF: original JSON contract intact'
    );
    assert.equal(chat.getSessionQualification(db, offSess.id), null, 'OFF: no record created by the fallback');
    n += 5;

    // 5d — capture is NEVER gated: with every question still
    // pending, a capture action proceeds exactly as before.
    const cSess = makeSession(LEAD_ON);
    addMsg(cSess.id, LEAD_ON, 'visitor', 'Our office bathroom is flooding');
    addMsg(cSess.id, LEAD_ON, 'visitor', 'Water is everywhere, please hurry');
    nextReply = JSON.stringify({
      action: 'capture',
      reply: 'Thanks — a short contact form is about to appear so the team can reach you fast.',
      qualification: [],
    });
    const r4 = await chat.runAiFallbackReply(WS_ID, LEAD_ON, cSess.id);
    assert.equal(r4.action, 'capture', 'capture proceeds with zero questions answered');
    const cMsgs = chat.listMessages(db, cSess.id, { limit: 20 });
    assert.ok(
      cMsgs.some((m) => m.role === 'system' && m.meta && m.meta.open_lead_form),
      'the lead form opened as before'
    );
    const cRec = chat.getSessionQualification(db, cSess.id);
    assert.ok(
      cRec && cRec.items.every((it) => it.status === 'pending'),
      'record exists, all pending — nothing blocked on it'
    );
    n += 3;

    ai.chat = realChat;
    ai.aiConfigured = realConfigured;
    group('Part 5 AI fallback end-to-end', n);
  }

  /* ================================================================== */
  /* Part 6 — capture ride-along + escalation + portal inbox             */
  /* ================================================================== */
  {
    let n = 0;
    chat.saveSettings(db, LEAD_CAPTURE, { qualifying_enabled: true, qualifying_questions: QUESTIONS });
    const emb = sm.ensureEmbed(db, LEAD_CAPTURE, 'chatbot', { workspaceId: WS_ID });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(emb.id);
    const sess = makeSession(LEAD_CAPTURE);
    addMsg(sess.id, LEAD_CAPTURE, 'visitor', 'Need a plumber for my rental');
    chat.ensureSessionQualification(db, LEAD_CAPTURE, sess.id);
    chat.recordQualificationUpdates(db, LEAD_CAPTURE, sess.id, [
      { index: 0, status: 'answered', answer: 'A rental property' },
      { index: 1, status: 'asked' },
    ]);

    const cap = chat.captureLead(db, emb.public_token, {
      name: 'Pat Visitor',
      email: 'pat137@example.invalid',
      phone: '',
      message: 'Please call me back',
      session: sess.token,
    });
    assert.ok(cap.lead && cap.lead.id > 0, 'the capture itself works as before');
    assert.equal(cap.lead.qualification, undefined, 'the visitor-facing capture response shape is unchanged');
    assert.ok(cap._notify.qualification_summary.includes(Q1), 'owner notify summary names the question');
    assert.ok(
      cap._notify.qualification_summary.includes('A rental property'),
      'owner notify summary carries the answer'
    );
    assert.equal(cap._notify.qualification.items[0].status, 'answered', 'the record rides the notify payload');
    n += 5;

    const leadRow = db.prepare('SELECT qualification_json FROM chatbot_leads WHERE id = ?').get(cap.lead.id);
    const stored = chat.parseQualificationRecord(leadRow.qualification_json);
    assert.ok(
      stored && stored.items[0].answer === 'A rental property',
      'the record snapshot is stored on the chatbot_leads row'
    );
    const escRow = db
      .prepare(
        "SELECT message FROM chatbot_escalations WHERE lead_id = ? AND reason = 'lead_capture' ORDER BY id DESC LIMIT 1"
      )
      .get(LEAD_CAPTURE);
    assert.ok(escRow.message.includes('Qualifying questions:'), 'the lead-capture escalation text carries the summary');
    assert.ok(escRow.message.includes(Q2), 'the escalation summary lists unanswered questions too');
    n += 3;

    const leads = chat.listChatLeads(db, LEAD_CAPTURE);
    assert.equal(leads[0].qualification.items[0].answer, 'A rental property', 'inbox lead list exposes the record');
    assert.ok(!('qualification_json' in leads[0]), 'the raw JSON column stays internal');
    n += 2;

    // Escalation: flow unchanged, record attached.
    const esc = chat.escalateSession(db, LEAD_CAPTURE, {
      sessionId: sess.id,
      message: 'Unsure about the quote',
      reason: 'unsure',
    });
    assert.equal(esc.qualification.items[0].status, 'answered', 'the escalation return carries the record');
    const sessRow = db.prepare('SELECT needs_agent FROM chatbot_sessions WHERE id = ?').get(sess.id);
    assert.equal(sessRow.needs_agent, 0, 'escalation still clears needs_agent exactly as before');
    n += 2;

    // Portal inbox data: summary attaches records everywhere the
    // owner looks — escalations, leads, and the session list.
    const summary = chat.portalChatbotSummary(db, LEAD_CAPTURE);
    const unsure = summary.escalations.find((e) => e.reason === 'unsure');
    assert.ok(
      unsure && unsure.qualification && unsure.qualification.items[0].answer === 'A rental property',
      'summary: escalation rows carry their session record'
    );
    assert.ok(
      summary.qualification_sessions.some((s) => s.id === sess.id),
      'summary: the session appears in the qualifying-answers list'
    );
    assert.ok(summary.leads[0].qualification, 'summary: lead rows carry the capture snapshot');
    assert.equal(summary.settings.qualifying_enabled, true, 'summary: settings carry the feature state for the pane');
    n += 4;

    // OFF lead: empty list, null attachments — nothing phantom.
    const offSummary = chat.portalChatbotSummary(db, LEAD_OFF);
    assert.deepEqual(offSummary.qualification_sessions, [], 'OFF: no qualifying sessions listed');
    const offEsc = chat.escalateSession(db, LEAD_OFF, { message: 'General question', reason: 'unsure' });
    assert.equal(offEsc.qualification, null, 'OFF: escalation carries no record');
    n += 2;
    group('Part 6 capture + escalation + inbox', n);
  }

  /* ================================================================== */
  /* Part 7 — POST-REBASE (Batch 136) booking-pitch independence         */
  /* ================================================================== */
  {
    let n = 0;
    if (typeof share.getBookingPitch !== 'function') {
      console.log(
        '  SKIP Part 7 — Batch 136 (module-state booking pitch) is not on this base (Batch 128): moduleShare.getBookingPitch does not exist here. These checks activate on the finisher’s post-rebase run: (1) with bookings live, listPendingSessions carries booking_pitch byte-identical with qualifying ON and OFF; (2) the fallback prompt contains BOTH blocks, pitch first, qualifying second; (3) turning qualifying off never removes the pitch.'
      );
      group('Part 7 post-rebase 136 seam (SKIPPED on this base)', 0);
    } else {
      const emb = sm.ensureEmbed(db, LEAD_ON, 'bookings', { workspaceId: WS_ID });
      db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(emb.id);
      sm.createBookingService(db, LEAD_ON, { name: 'Consult', status: 'published', price_cents: 5000 });
      const pitch = share.getBookingPitch(db, LEAD_ON);
      assert.ok(pitch && pitch.active, 'bookings live -> pitch exists');

      const onCtx = chat.listPendingSessions(db, LEAD_ON);
      assert.equal(onCtx.booking_pitch.pitch_text, pitch.pitch_text, 'qualifying ON: pitch present, byte-identical');
      assert.ok(onCtx.qualifying, 'qualifying ON: qualifying context also present (independent blocks)');

      chat.saveSettings(db, LEAD_ON, { qualifying_enabled: false });
      const offCtx = chat.listPendingSessions(db, LEAD_ON);
      assert.equal(
        offCtx.booking_pitch.pitch_text,
        pitch.pitch_text,
        'qualifying OFF: the pitch is unchanged — never conditioned on qualification'
      );
      assert.equal(offCtx.qualifying, null, 'qualifying OFF: only the qualifying block goes away');
      chat.saveSettings(db, LEAD_ON, { qualifying_enabled: true });
      n += 5;

      // Prompt composition: pitch block first, qualifying second,
      // both present; neither gates the other.
      const ai = require(path.join(root, 'src/ai.js'));
      const realChat = ai.chat;
      const realConfigured = ai.aiConfigured;
      const prompts = [];
      ai.aiConfigured = () => true;
      ai.chat = async (args) => {
        prompts.push(args);
        return { text: JSON.stringify({ action: 'chat', reply: 'Hi!' }) };
      };
      const sess = makeSession(LEAD_ON);
      addMsg(sess.id, LEAD_ON, 'visitor', 'Hello, I have a question');
      await chat.runAiFallbackReply(WS_ID, LEAD_ON, sess.id);
      ai.chat = realChat;
      ai.aiConfigured = realConfigured;
      const prompt = prompts[0].messages[0].content;
      const iPitch = prompt.indexOf('Online booking (always true on this site)');
      const iQual = prompt.indexOf('Qualifying questions from the business owner');
      assert.ok(
        iPitch >= 0 && iQual > iPitch,
        'prompt: booking pitch block precedes the qualifying block; both present'
      );
      n++;
      group('Part 7 post-rebase 136 seam', n);
    }
  }

  console.log(`\nBatch 137 chat qualifying-questions regressions: ALL PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('\nBatch 137 chat qualifying-questions regressions FAILED:');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
