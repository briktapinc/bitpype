'use strict';
/**
 * Batch 140 — INDUSTRY DEFAULT QUALIFYING QUESTIONS for the site
 * chat + AI voice agent (Ely's order 2026-11-04).
 *
 * Ely: "The default questions for the chat and voice should be
 * top five questions to prove to that particular business that
 * the feature works. It's unique based on industry. Every
 * business questions will vary."
 *
 * The mechanic (amends Batch 137, does not replace it):
 *   - Deterministic platform templates — NO runtime AI
 *     generation. Each industry family carries exactly FIVE
 *     questions following the same arc: (1) what they need,
 *     (2) scope/detail that determines fit and price,
 *     (3) timing/urgency, (4) location/access, (5) the decision
 *     factor that completes a qualified lead picture. No contact
 *     details (lead capture owns those) and no sensitive
 *     personal/health/financial specifics.
 *   - ONE resolver in server/chatbot.js
 *     (resolveQualifyingQuestions + getIndustryDefaultQuestions)
 *     feeds getSettings, which returns the EFFECTIVE list: the
 *     owner's stored list when non-empty, otherwise the industry
 *     defaults — plus qualifying_questions_source provenance.
 *     Every context builder consumes getSettings (the AI
 *     fallback, the live-agent context, and Batch 138's voice
 *     context, whose buildAssistantContext returns
 *     { settings: getSettings(...) } and whose
 *     qualifyingQuestionsBlock reads settings.qualifying_questions
 *     — verified against the batch138 worktree), so chat and
 *     voice ask the same five.
 *   - Superseded Batch 137 behaviour: enabled + empty owner list
 *     NO LONGER behaves as off — the defaults are the effective
 *     questions and snapshot into qualification_json at session
 *     start exactly like owner questions. Enabled=false still
 *     yields no questions anywhere. A saved owner list is frozen
 *     (category changes never move it); unsaved defaults track
 *     the category. Stored settings are never rewritten by
 *     resolution — a partial save cannot freeze defaults in.
 *
 *   Part 1 — source pins.
 *   Part 2 — three contrasting industries, exact verbatim sets.
 *   Part 3 — resolution matrix (off / on+empty / owner wins /
 *     category tracking / frozen owner list / snapshot).
 *   Part 4 — personalization (services + city) and generic
 *     fallback, caps held under interpolation.
 *   Part 5 — the voice seam: the settings object
 *     buildAssistantContext returns carries the resolver's five.
 *   Part 6 — every family: exactly 5, each ≤200 chars; classifier
 *     priority spot-checks.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b140-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch140', 'test', 'session', 'secret', 'value'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 21).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const PLUMBING = [
  'What plumbing problem can we help with — a leak, a clog, a water heater, or something else?',
  'Where is the problem — kitchen, bathroom, basement — and how many fixtures are affected?',
  'Is water actively leaking or backed up right now, or can it wait for a scheduled visit?',
  'Is this for a home or a business property, and what town is it in?',
  'Have you had this same problem before, or is this the first time?',
];
const FLORIST = [
  'Are you looking for fresh flowers, a plant for your home, or supplies for your garden?',
  'Is it for an occasion — a birthday, sympathy, a wedding, or just because?',
  'Do you need delivery, or will you pick it up in the shop?',
  'When do you need it by?',
  'Is there a plant you have in mind, or would you like a suggestion based on your light and space?',
];
const DENTAL = [
  'What brings you in — a checkup and cleaning, a specific concern, or a cosmetic treatment?',
  'Is anything bothering you right now, like pain or sensitivity?',
  'Are you a new patient, or have you visited us before?',
  'When are you hoping to be seen — is it urgent?',
  'Do mornings, afternoons, or evenings usually work best for appointments?',
];
const ROOFING_Q1 = 'Do you need a roof repair, a full replacement, or an inspection?';
const CUSTOM = ['Custom one — what is the story?', 'Custom two — when do you need it?'];

const L_PLUMB = 14001;
const L_FLORIST = 14002;
const L_DENTAL = 14003;
const L_TRACK = 14004;
const L_FROZEN = 14005;
const L_SVC = 14006;
const L_BARE = 14007;
const L_LONG = 14008;
let WS_ID;
let db;

function makeSession(leadId) {
  const token = `b140-${leadId}-${Math.random().toString(36).slice(2, 12)}`;
  const info = db
    .prepare(
      "INSERT INTO chatbot_sessions (lead_id, session_token, status, needs_agent, last_visitor_at) VALUES (?, ?, 'open', 1, datetime('now'))"
    )
    .run(leadId, token);
  return { id: Number(info.lastInsertRowid), token };
}
function addLead(id, { category = null, city = null, services = null } = {}) {
  db.prepare('INSERT INTO leads (id, business_name, email, status, category, city, services) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    `B140 Lead ${id}`,
    `lead${id}@example.invalid`,
    'customer',
    category,
    city,
    services ? JSON.stringify(services) : null
  );
}

(async () => {
  const chatSrc = read('server/chatbot.js');

  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    assert.ok(chatSrc.includes('INDUSTRY_QUESTION_TEMPLATES'), 'templates table exists in chatbot.js');
    assert.ok(chatSrc.includes('function getIndustryDefaultQuestions'), 'industry defaults resolver exists');
    assert.ok(chatSrc.includes('function resolveQualifyingQuestions'), 'the single resolver exists');
    assert.ok(chatSrc.includes("source: 'industry_default'"), 'resolver reports industry_default provenance');
    assert.ok(chatSrc.includes("source: 'owner'"), 'resolver reports owner provenance');
    assert.ok(chatSrc.includes('const resolved = resolveQualifyingQuestions(db, leadId, raw.qualifying_questions);'), 'getSettings resolves through the single resolver');
    assert.ok(chatSrc.includes('qualifying_questions_stored'), 'getSettings exposes the raw stored list separately');
    assert.ok(chatSrc.includes('const cur = getRawSettings(db, leadId);'), 'saveSettings falls back to RAW stored settings (defaults can never be frozen in by a partial save)');
    assert.ok(!/ai\.chat|generateQuestions|openai/i.test(chatSrc.slice(chatSrc.indexOf('INDUSTRY_QUESTION_TEMPLATES'), chatSrc.indexOf('function parseSettingsRow'))), 'template resolution is deterministic — no model call anywhere in the resolver span');
    const portalSrc = read('public/js/portal.js');
    assert.ok(portalSrc.includes('id="chat-qualifying-provenance"') && portalSrc.includes('Industry defaults for'), 'portal pane shows the industry-defaults provenance note');
    n += 10;
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
  const chat = require(path.join(root, 'server/chatbot.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a140@example.invalid',
    password: ['batch140', 'fixture', 'password'].join('-'),
    name: 'A140',
    workspaceName: 'Batch140 WS',
  });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  chat.ensureTables(db);
  addLead(L_PLUMB, { category: 'Plumber', city: 'Reading' });
  addLead(L_FLORIST, { category: 'Florist' });
  addLead(L_DENTAL, { category: 'Dental Clinic' });
  addLead(L_TRACK, { category: 'Plumber' });
  addLead(L_FROZEN, { category: 'Plumber' });
  addLead(L_SVC, { city: 'Reading', services: ['Brake Repair', 'Oil Change'] });
  addLead(L_BARE, {});
  addLead(L_LONG, { services: ['X'.repeat(160), 'Y'.repeat(160)] });

  /* ================================================================== */
  /* Part 2 — three contrasting industries, exact verbatim sets          */
  /* ================================================================== */
  {
    let n = 0;
    const plumb = chat.getIndustryDefaultQuestions(db, L_PLUMB);
    assert.equal(plumb.family, 'plumbing');
    assert.equal(plumb.industry, 'Plumbing');
    assert.deepEqual(plumb.questions, PLUMBING, 'plumber set is verbatim');
    const flor = chat.getIndustryDefaultQuestions(db, L_FLORIST);
    assert.equal(flor.family, 'florist');
    assert.deepEqual(flor.questions, FLORIST, 'florist/plant-shop set is verbatim');
    const dent = chat.getIndustryDefaultQuestions(db, L_DENTAL);
    assert.equal(dent.family, 'dental');
    assert.deepEqual(dent.questions, DENTAL, 'dental set is verbatim');
    n += 6;

    assert.notDeepEqual(plumb.questions, flor.questions, 'plumber != florist');
    assert.notDeepEqual(plumb.questions, dent.questions, 'plumber != dental');
    assert.notDeepEqual(flor.questions, dent.questions, 'florist != dental');
    for (const set of [plumb.questions, flor.questions, dent.questions]) {
      assert.equal(set.length, 5, 'exactly five per business');
      assert.ok(set.every((q) => typeof q === 'string' && q.length > 0 && q.length <= 200), 'each question within the 200-char cap');
    }
    n += 6;

    // Deterministic: same profile in, same five out, every time.
    assert.deepEqual(chat.getIndustryDefaultQuestions(db, L_PLUMB).questions, PLUMBING, 'resolution is deterministic');
    assert.deepEqual(chat.resolveQualifyingQuestions(db, L_PLUMB, []).questions, PLUMBING, 'resolver agrees with the defaults reader');
    n += 2;
    group('Part 2 three industries verbatim', n);
  }

  /* ================================================================== */
  /* Part 3 — resolution matrix                                          */
  /* ================================================================== */
  {
    let n = 0;
    // Disabled (the default): no effective questions in any context.
    let s = chat.getSettings(db, L_PLUMB);
    assert.equal(s.qualifying_enabled, false, 'switch still defaults OFF');
    assert.equal(s.qualifying_questions_source, 'industry_default', 'effective list is resolved even while off (the editor shows what WOULD be asked)');
    assert.deepEqual(s.qualifying_questions, PLUMBING, 'off: effective list is the industry five');
    assert.equal(chat.qualifyingFor(db, L_PLUMB), null, 'disabled -> no qualifying context');
    const offSess = makeSession(L_PLUMB);
    assert.equal(chat.ensureSessionQualification(db, L_PLUMB, offSess.id), null, 'disabled -> no session snapshot');
    n += 5;

    // Enabled + empty stored list: defaults become effective AND
    // snapshot into the session record exactly like owner questions.
    chat.saveSettings(db, L_PLUMB, { qualifying_enabled: true });
    s = chat.getSettings(db, L_PLUMB);
    assert.deepEqual(s.qualifying_questions_stored, [], 'stored list is still empty — resolution did not write storage');
    assert.deepEqual(chat.qualifyingFor(db, L_PLUMB), { questions: PLUMBING }, 'enabled+empty: defaults appear in the assistant context');
    const sess = makeSession(L_PLUMB);
    const rec = chat.ensureSessionQualification(db, L_PLUMB, sess.id);
    assert.deepEqual(rec.questions, PLUMBING, 'enabled+empty: defaults snapshot into qualification_json at session start');
    assert.ok(rec.items.every((it) => it.status === 'pending'), 'snapshot items start pending');
    n += 4;

    // Owner's custom list always wins, byte-for-byte.
    chat.saveSettings(db, L_FROZEN, { qualifying_enabled: true, qualifying_questions: CUSTOM });
    s = chat.getSettings(db, L_FROZEN);
    assert.equal(s.qualifying_questions_source, 'owner', 'saved list reports owner provenance');
    assert.deepEqual(s.qualifying_questions, CUSTOM, 'owner list wins byte-for-byte');
    assert.deepEqual(chat.qualifyingFor(db, L_FROZEN).questions, CUSTOM, 'context serves the owner list, not the defaults');
    n += 3;

    // Unsaved defaults track the category.
    chat.saveSettings(db, L_TRACK, { qualifying_enabled: true });
    assert.deepEqual(chat.getSettings(db, L_TRACK).qualifying_questions, PLUMBING, 'starts on the plumbing five');
    db.prepare('UPDATE leads SET category = ? WHERE id = ?').run('Roofing', L_TRACK);
    const tracked = chat.getSettings(db, L_TRACK).qualifying_questions;
    assert.equal(tracked[0], ROOFING_Q1, 'after a category change the unsaved defaults follow it');
    assert.notDeepEqual(tracked, PLUMBING, 'the set actually changed');
    n += 3;

    // A saved owner list does NOT follow a category change.
    db.prepare('UPDATE leads SET category = ? WHERE id = ?').run('Dental Clinic', L_FROZEN);
    assert.deepEqual(chat.getSettings(db, L_FROZEN).qualifying_questions, CUSTOM, 'saved owner list is frozen across category changes');
    assert.equal(chat.getSettings(db, L_FROZEN).qualifying_questions_source, 'owner', 'provenance stays owner');
    n += 2;

    // A partial save (unrelated field) must not freeze defaults in.
    chat.saveSettings(db, L_TRACK, { greeting: 'Hello there' });
    s = chat.getSettings(db, L_TRACK);
    assert.deepEqual(s.qualifying_questions_stored, [], 'partial save leaves the stored list empty');
    assert.equal(s.qualifying_questions_source, 'industry_default', 'still resolving defaults after a partial save');
    assert.equal(s.qualifying_questions[0], ROOFING_Q1, 'and still tracking the current category');
    n += 3;
    group('Part 3 resolution matrix', n);
  }

  /* ================================================================== */
  /* Part 4 — personalization + generic fallback                         */
  /* ================================================================== */
  {
    let n = 0;
    // Uncategorized lead WITH services + city: the generic five
    // personalize from the business's own profile.
    const svc = chat.getIndustryDefaultQuestions(db, L_SVC);
    assert.equal(svc.family, 'generic', 'no category -> generic family');
    assert.equal(svc.industry, 'General local services');
    assert.equal(svc.questions[0], 'Which of our services can we help you with — Brake Repair, Oil Change — or something else?', 'services interpolate into Q1');
    assert.equal(svc.questions[3], 'Are you in or near Reading, or somewhere else?', 'city interpolates into Q4');
    assert.equal(svc.questions.length, 5, 'generic set is also exactly five');
    assert.ok(svc.questions.every((q) => q.length <= 200), 'personalized questions stay within cap');
    n += 6;

    // Uncategorized lead with nothing: uninterpolated fallbacks.
    const bare = chat.getIndustryDefaultQuestions(db, L_BARE);
    assert.equal(bare.family, 'generic');
    assert.equal(bare.questions[0], 'What can we help you with today?', 'no services -> fallback Q1');
    assert.equal(bare.questions[3], 'What area are you in, so we can confirm we serve it?', 'no city -> fallback Q4');
    assert.equal(bare.questions.length, 5);
    n += 4;

    // Interpolation that would overflow falls back, never truncates
    // a question mid-word and never exceeds the cap.
    const lng = chat.getIndustryDefaultQuestions(db, L_LONG);
    assert.equal(lng.questions[0], 'What can we help you with today?', 'overflow interpolation falls back to the uninterpolated template');
    assert.ok(lng.questions.every((q) => q.length <= 200), 'all questions still within cap');
    n += 2;
    group('Part 4 personalization + generic', n);
  }

  /* ================================================================== */
  /* Part 5 — the voice seam (Batch 138)                                 */
  /* ================================================================== */
  {
    let n = 0;
    // Batch 138's buildVoiceInstructions composes its qualifying
    // block from chatbot.buildAssistantContext(db, leadId).settings
    // .qualifying_questions. buildAssistantContext itself was added
    // by Batch 138 and does not exist on this Batch 137 base — it
    // returns { settings: getSettings(db, leadId) } verbatim
    // (verified in the batch138 worktree), so this pins the exact
    // object the voice seam consumes, and uses buildAssistantContext
    // itself when it is present (post-rebase).
    const viaCtx =
      typeof chat.buildAssistantContext === 'function'
        ? chat.buildAssistantContext(db, L_PLUMB, { query: '' }).settings
        : chat.getSettings(db, L_PLUMB);
    assert.deepEqual(viaCtx.qualifying_questions, PLUMBING, 'the settings object the voice seam consumes carries the resolver five');
    assert.equal(viaCtx.qualifying_questions_source, 'industry_default', 'provenance rides the same object');
    const resolver = chat.resolveQualifyingQuestions(db, L_PLUMB, []);
    assert.deepEqual(viaCtx.qualifying_questions, resolver.questions, 'voice-seam settings == resolver output, question for question');
    n += 3;
    group('Part 5 voice seam settings object', n);
  }

  /* ================================================================== */
  /* Part 6 — every family: shape, caps, classifier priority             */
  /* ================================================================== */
  {
    let n = 0;
    const templates = chat.INDUSTRY_QUESTION_TEMPLATES;
    const families = Object.keys(templates);
    assert.ok(families.length >= 40, `at least 40 families incl. generic (got ${families.length})`);
    n++;
    for (const [key, fam] of Object.entries(templates)) {
      assert.equal(fam.questions.length, 5, `${key}: exactly five questions`);
      for (const entry of fam.questions) {
        const q = typeof entry === 'object' ? entry.q : entry;
        const alt = typeof entry === 'object' ? entry.alt : null;
        assert.ok(typeof q === 'string' && q.length > 0 && q.length <= 200, `${key}: question within cap`);
        if (alt) assert.ok(alt.length <= 200, `${key}: fallback within cap`);
      }
      n++;
    }
    const cases = [
      ['Commercial Cleaning Company', 'commercial_cleaning'],
      ['House Cleaning', 'house_cleaning'],
      ['Auto Detailing Studio', 'auto_detailing'],
      ['Auto Repair', 'auto_repair'],
      ['Garden Center', 'florist'],
      ['Plant Shop', 'florist'],
      ['Dental Clinic', 'dental'],
      ['Family Dentist', 'dental'],
      ['Daycare Center', 'education'],
      ['Wedding Planner', 'events'],
      ['Veterinary Clinic', 'veterinary'],
      ['Pet Grooming', 'pet'],
      ['Dumpster Rental', 'dumpster'],
      ['Real Estate Agent', 'real_estate'],
      ['Law Firm', 'law'],
      ['Bookkeeping Services', 'accounting'],
      ['Insurance Agency', 'insurance'],
      ['Web Design Studio', 'web_services'],
      ['Personal Trainer', 'fitness'],
      ['Hair Salon', 'salon'],
      ['Massage Therapy', 'spa'],
      ['', 'generic'],
      ['Underwater Basket Weaving', 'generic'],
    ];
    for (const [cat, expected] of cases) {
      assert.equal(chat.classifyIndustry(cat), expected, `classify ${JSON.stringify(cat)} -> ${expected}`);
      n++;
    }
    group('Part 6 families + classifier', n);
  }

  console.log(`\nBatch 140 industry-default qualifying-questions regressions: ALL PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('\nBatch 140 industry-default qualifying-questions regressions FAILED:');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
