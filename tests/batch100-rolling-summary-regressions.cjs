'use strict';
/**
 * Batch 100 — ROLLING SUMMARY (four-role rebuild step 3;
 * review §12.4).
 *
 * A per-site rolling conversation summary, persisted
 * server-side (server/siteChatSummary.js), maintained
 * incrementally from turn artifacts (settled facts, mode,
 * mutation, queue outcome — deterministic, entries cite the
 * transcript message ids) and fed into the chat context
 * alongside Batch 96's transcript tail. Supersede-don't-
 * duplicate: a new fact on a settled dimension replaces the
 * old one (marked superseded). Queued-job open items resolve
 * when their job delivers. Keyed by lead like every chat
 * store — summaries never cross sites.
 *
 * Wiring: portal chat route folds each recorded turn in
 * (portal.updateSiteChatSummary); the history payload carries
 * the summary; public/js/portal.js renders it as a collapsible
 * "what your agent remembers" block; runSiteAgentChat appends
 * the rendered summary to the site context so the classifier,
 * planner, loop and queued specs all see it.
 *
 * NEGATIVE PROOF: B100_NEGATIVE=summary shims the context
 * injection out of the runSiteAgentChat slice -> the seeded
 * summary never reaches the classifier and Part 2 goes RED.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b100-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch100', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const NEGATIVE = process.env.B100_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

function loadPortalSliceSource() {
  let src = require('./lib/monolithSource.cjs').clientPortalSource();
  const start = src.indexOf('async function runSiteAgentChat(');
  const end = src.indexOf('/**', start);
  assert.ok(start > 0 && end > start, 'slice bounds found');
  src = src.slice(start, end);
  if (NEGATIVE === 'summary') {
    const shimmed = src.replace('CONVERSATION SUMMARY (rolling digest', 'SUMMARY WITHHELD (negative shim)');
    assert.notEqual(shimmed, src, 'summary shim must change the slice source');
    src = shimmed;
  }
  return src;
}

(async () => {
  const domain = require(path.join(root, 'server', 'domain.js'));
  const chatSummary = require(path.join(root, 'server', 'siteChatSummary.js'));
  const chatPending = require(path.join(root, 'server', 'siteChatPending.js'));
  const designJobs = require(path.join(root, 'src', 'designJobs.js'));
  await require(path.join(root, 'server', 'db.js')).migrate();
  const realDb = domain.withDb(1, (db) => db);
  designJobs.ensureTables(realDb);
  chatPending.ensureTable(realDb);

  const seedLead = (label) => {
    const info = realDb
      .prepare('INSERT INTO leads (business_name, category, phone) VALUES (?, ?, ?)')
      .run(`ZZ B100 ${label}`, 'Bakery', '(610) 555-0198');
    return Number(info.lastInsertRowid);
  };

  // ---------------------------------------------------------------
  // Part 1 — the deterministic merge
  // ---------------------------------------------------------------
  {
    let n = 0;
    const lead = seedLead('merge');
    let s = chatSummary.mergeTurn(realDb, lead, {
      userText: 'change all h3 to dark grey',
      userMsgId: 101,
      assistantMsgId: 102,
      settledFacts: ['h3 colour: dark grey (#444444)', 'scope: entire site'],
      mode: 'build',
      mutated: true,
      reviewVerdict: 'pass',
    });
    assert.equal(s.settledStyle.length, 1, 'style-dimension fact lands in settledStyle');
    assert.ok(s.settledStyle[0].text.includes('#444444'));
    assert.equal(s.settledStyle[0].msgId, 102, 'entry cites the transcript message id');
    assert.equal(s.decisions.length, 1, 'non-style fact lands in decisions');
    assert.equal(s.changesApplied.length, 1, 'mutating build recorded');
    assert.ok(s.changesApplied[0].text.includes('change all h3 to dark grey'), 'change entry quotes the request');
    assert.equal(s.changesApplied[0].review, 'pass', 'review verdict rides the change entry');
    n += 7;

    // Supersede: same dimension, new value.
    s = chatSummary.mergeTurn(realDb, lead, {
      userText: 'make the h3 charcoal instead',
      userMsgId: 103,
      assistantMsgId: 104,
      settledFacts: ['h3 colour: charcoal (#333333)'],
      mode: 'build',
      mutated: true,
    });
    const styleActive = s.settledStyle.filter((e) => e.status === 'active');
    assert.equal(styleActive.length, 1, 'one active value per dimension');
    assert.ok(styleActive[0].text.includes('#333333'), 'the new value wins');
    assert.ok(s.settledStyle.some((e) => e.status === 'superseded' && e.text.includes('#444444')), 'the old value is kept, marked superseded');
    assert.equal(s.changesApplied.length, 2);
    n += 4;

    // Queued: open item appears, then resolves on delivery.
    const job = designJobs.createJob(realDb, {
      leadId: lead,
      type: 'improvement',
      title: 'Improvement: tastings page',
      instructions: 'Add it.',
      siteShape: 'landing',
    });
    s = chatSummary.mergeTurn(realDb, lead, {
      userText: 'add a tastings page',
      userMsgId: 105,
      assistantMsgId: 106,
      mode: 'queued',
      queuedJobId: Number(job.id),
    });
    assert.ok(s.openItems.some((e) => e.status === 'active' && e.jobId === Number(job.id)), 'queued job is an open item');
    realDb.prepare("UPDATE design_jobs SET status = 'delivered' WHERE id = ?").run(job.id);
    s = chatSummary.mergeTurn(realDb, lead, {
      userText: 'what colour are my headings?',
      userMsgId: 107,
      assistantMsgId: 108,
      mode: 'answer',
    });
    assert.ok(!s.openItems.some((e) => e.status === 'active' && e.jobId === Number(job.id)), 'delivered job leaves open items');
    assert.ok(s.changesApplied.some((e) => e.text.includes('delivered')), 'delivery recorded as a change');
    n += 3;

    // Clarify opens an item; a later build closes it.
    s = chatSummary.mergeTurn(realDb, lead, { userText: 'make it pop', userMsgId: 109, assistantMsgId: 110, mode: 'clarify' });
    assert.ok(s.openItems.some((e) => e.kind === 'clarify' && e.status === 'active'), 'clarification is an open item');
    s = chatSummary.mergeTurn(realDb, lead, { userText: 'bigger headings', userMsgId: 111, assistantMsgId: 112, mode: 'build', mutated: true });
    assert.ok(!s.openItems.some((e) => e.kind === 'clarify' && e.status === 'active'), 'the build resolves the clarification item');
    n += 2;

    // Render: sections + citations + cap.
    const text = chatSummary.renderSummaryText(s);
    assert.ok(text.includes('Settled style choices:'), 'render has the style section');
    assert.ok(text.includes('(msg #104)'), 'render cites message ids');
    assert.ok(text.length <= chatSummary.MAX_RENDER_CHARS + 32, 'render is capped');
    assert.ok(!text.includes('#444444'), 'superseded values stay out of the render');
    n += 4;

    // Per-site: another lead has no summary; merges never leak.
    const other = seedLead('other');
    assert.equal(chatSummary.getSummary(realDb, other), null, 'a fresh site has no summary');
    chatSummary.mergeTurn(realDb, other, {
      userText: 'paint it blue',
      userMsgId: 201,
      assistantMsgId: 202,
      settledFacts: ['h3 colour: blue (#0000ff)'],
      mode: 'build',
      mutated: true,
    });
    const mine = chatSummary.getSummary(realDb, lead);
    assert.ok(!JSON.stringify(mine).includes('#0000ff'), "the other site's facts never enter this summary");
    const theirs = chatSummary.getSummary(realDb, other);
    assert.ok(!JSON.stringify(theirs).includes('#333333'), 'and vice versa');
    n += 3;
    group('Part 1 deterministic merge (supersede, resolve, per-site)', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — the summary reaches the turn context (slice)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const FIXTURE_PAGES = [{ slug: 'index', title: 'Home', sections: [{ type: 'hero', content: { headline: 'ZZ B100 Bakery' } }] }];
    const leadInfo = realDb
      .prepare('INSERT INTO leads (business_name, category, phone) VALUES (?, ?, ?)')
      .run('ZZ B100 Slice', 'Bakery', '(610) 555-0198');
    const lead = Number(leadInfo.lastInsertRowid);
    realDb
      .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
      .run(lead, 'ZZ B100 Slice', 'draft', JSON.stringify(FIXTURE_PAGES), JSON.stringify({ primary: '#7a4a21', customCss: 'h3 { color: #444444; }' }));
    chatSummary.mergeTurn(realDb, lead, {
      userText: 'change all h3 to dark grey',
      userMsgId: 11,
      assistantMsgId: 12,
      settledFacts: ['h3 colour: dark grey (#444444)'],
      mode: 'build',
      mutated: true,
    });

    let classifySawContext = '';
    const fakeMuseAgent = {
      classifyPortalChatIntent: async (_ws, _lead, opts) => {
        classifySawContext = String((opts && opts.siteContext) || '');
        return { intent: 'question', ready: false, size: 'small', settled: [], fallback: false };
      },
      planPortalChange: async () => ({ plan: null }),
      runPortalImproveLoop: async () => ({ steps: 0, reply: 'Your headings are dark grey.', mutated: false, published: false, toolCalls: 0, model: 'fixture', imagesSent: false, imagesDropped: false }),
    };
    const sliceMod = { exports: {} };
    vm.runInNewContext(loadPortalSliceSource() + ';module.exports = { runSiteAgentChat };', {
      module: sliceMod,
      exports: sliceMod.exports,
      console,
      Buffer,
      process,
      resolveClientSite: () => ({ id: 42, pages: FIXTURE_PAGES, theme: { primary: '#7a4a21', customCss: 'h3 { color: #444444; }' } }),
      publishClientSitePreview: async () => ({ previewUrl: 'https://bitpype.test/preview/site' }),
      renderClientSite: () => ({
        html: '<html><head><style>h3 { color: #444444; }</style></head><body><section><h3>ZZ Heading</h3></section></body></html>',
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
    const res = await sliceMod.exports.runSiteAgentChat(1, lead, { message: 'remind me what we settled for the headings' });
    assert.equal(res.mode, 'answer');
    assert.ok(classifySawContext.includes('CONVERSATION SUMMARY'), 'the rolling summary rides the site context');
    assert.ok(classifySawContext.includes('dark grey (#444444)'), 'the settled style fact reaches the classifier');
    assert.ok(classifySawContext.includes('Changes applied:'), 'applied changes ride along');
    n += 4;
    group('Part 2 summary in turn context (slice)', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — wiring pins
  // ---------------------------------------------------------------
  {
    let n = 0;
    const cp = require('./lib/monolithSource.cjs').clientPortalSource();
    const routes = fs.readFileSync(path.join(root, 'server', 'routes', 'portal.js'), 'utf8');
    const js = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');
    assert.ok(cp.includes("require('./siteChatSummary')"), 'clientPortal uses the summary module');
    assert.ok(cp.includes('summary: chatSummary.getSummary(db, leadId)'), 'history payload carries the summary');
    assert.ok(cp.includes('settled: settledNow'), 'settled facts ride the chat payload');
    assert.ok(routes.includes('updateSiteChatSummary'), 'the route folds turns into the summary');
    assert.ok(js.includes('renderAgentChatSummary'), 'portal UI renders the summary block');
    assert.ok(js.includes("data.summary) renderAgentChatSummary"), 'history load renders it');
    n += 6;
    group('Part 3 wiring pins', n);
  }

  console.log(JSON.stringify({ passed: true, groups, negative: NEGATIVE || null }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
