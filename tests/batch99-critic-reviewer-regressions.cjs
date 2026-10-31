'use strict';
/**
 * Batch 99 — CRITIC + REVIEWER (four-role rebuild step 2;
 * review §12.2/§12.3, findings C1–C3).
 *
 * What changed:
 *   1. server/siteChatCritic.js — the critic inspects the
 *      ACTUAL rendered result (computed styles via the cascade
 *      evaluator, rendered text) against the plan's verify[]
 *      checks, and diffs a site fingerprint (per-page hashes,
 *      theme core vs customCss) for collateral: out-of-scope
 *      page changes, theme changes without a theme step, page
 *      changes without a page step are violations; a claimed
 *      mutation that left the fingerprint identical fails as
 *      "no effective change" (finding C3, mechanised).
 *   2. The REVIEWER gates every in-chat build in
 *      runSiteAgentChat: pass -> the summary ships and the
 *      verdict persists on the plan row; fail -> bounded rework
 *      through the planner with the critic's findings (<= 2
 *      cycles); still failing -> the reviewer escalates by
 *      queueing the design job itself (plan + findings) and
 *      the reply discloses it. Unplanned builds get the same
 *      mutation-sanity critic.
 *   3. Queued jobs: queueBigJob stamps the pre-turn fingerprint
 *      as brief.chat_origin.baseline; deliverJob runs the
 *      critic against the delivered site BEFORE write-back —
 *      pass (with an evidence line), bounce back to
 *      waiting_on_agent with findings (max 2), or accept with
 *      the caveat disclosed.
 *
 * NEGATIVE PROOF: B99_NEGATIVE=reviewer shims the critic the
 * reviewer sees to always pass -> rework never triggers,
 * escalation never happens, the mutation-sanity reply never
 * fires, and Part 2 goes RED.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b99-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch99', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const NEGATIVE = process.env.B99_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

function loadPortalSliceSource() {
  const src = fs.readFileSync(path.join(root, 'server', 'clientPortal.js'), 'utf8');
  const start = src.indexOf('async function runSiteAgentChat(');
  const end = src.indexOf('/**', start);
  assert.ok(start > 0 && end > start, 'slice bounds found');
  return src.slice(start, end);
}

const COLOUR_PLAN = {
  scope: { pages: ['all'], sections: null },
  settled: ['H3 colour: dark grey'],
  defaultsApplied: ['dark grey resolved to #444444'],
  steps: [
    {
      tool: 'theme.styleRule',
      args: { selector: 'h3', property: 'color', value: '#444444' },
      expect: 'every H3 computes to dark grey on light sections',
    },
  ],
  verify: [{ kind: 'computedStyle', selector: 'h3', property: 'color', equals: '#444444', where: 'light' }],
  size: 'small',
};

(async () => {
  const domain = require(path.join(root, 'server', 'domain.js'));
  const chatPlan = require(path.join(root, 'server', 'siteChatPlan.js'));
  const critic = require(path.join(root, 'server', 'siteChatCritic.js'));
  const chatPending = require(path.join(root, 'server', 'siteChatPending.js'));
  const thread = require(path.join(root, 'server', 'siteChatThread.js'));
  const designJobs = require(path.join(root, 'src', 'designJobs.js'));
  await require(path.join(root, 'server', 'db.js')).migrate();
  const realDb = domain.withDb(1, (db) => db);
  designJobs.ensureTables(realDb);
  chatPending.ensureTable(realDb);
  chatPlan.ensureTable(realDb);
  thread.ensureTable(realDb);

  const ALLOW = new Set(['theme.styleRule', 'theme.set', 'pages.structure.update', 'modules.attach', 'site.editText']);
  const colourPlan = () => chatPlan.validatePlan(JSON.parse(JSON.stringify(COLOUR_PLAN)), ALLOW);

  // ---------------------------------------------------------------
  // Part 1 — critic units: verify checks + collateral diff
  // ---------------------------------------------------------------
  {
    let n = 0;
    const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));
    const mdb = new Database(':memory:');
    mdb.exec('CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, pages TEXT, theme TEXT)');
    const pagesV1 = [
      { slug: 'index', title: 'Home', sections: [{ type: 'html', content: { html: '<h3>Hi</h3>' } }] },
      { slug: 'about', title: 'About', sections: [] },
    ];
    const themeV1 = { primary: '#7a4a21', customCss: 'h3 { color: #7a4a21; }' };
    mdb.prepare('INSERT INTO websites (id, lead_id, pages, theme) VALUES (1, 7, ?, ?)').run(
      JSON.stringify(pagesV1),
      JSON.stringify(themeV1)
    );
    const fp1 = critic.siteFingerprint(mdb, 7);
    assert.deepEqual(fp1.slugs, ['index', 'about']);
    assert.ok(fp1.pagesHash.index && fp1.pagesHash.about, 'per-page hashes');
    n += 2;

    // Nothing changed -> no diff, no violations.
    const d0 = critic.diffFingerprints(fp1, critic.siteFingerprint(mdb, 7), colourPlan());
    assert.equal(d0.changed, false);
    assert.equal(d0.violations.length, 0);
    n += 2;

    // customCss change WITH a style-rule step -> clean.
    const themeV2 = { ...themeV1, customCss: 'h3 { color: #7a4a21; }\n/* bitpype:chat-rules:start */\nh3 { color: #444444; }\n/* bitpype:chat-rules:end */' };
    mdb.prepare('UPDATE websites SET theme = ? WHERE lead_id = 7').run(JSON.stringify(themeV2));
    const fp2 = critic.siteFingerprint(mdb, 7);
    const d1 = critic.diffFingerprints(fp1, fp2, colourPlan());
    assert.equal(d1.changed, true);
    assert.equal(d1.customCssChanged, true);
    assert.equal(d1.themeCoreChanged, false, 'customCss is split from the theme core');
    assert.equal(d1.violations.length, 0, 'planned CSS change is not collateral');
    n += 4;

    // Same CSS change with a plan that has NO style step -> violation.
    const textPlan = chatPlan.validatePlan(
      { ...COLOUR_PLAN, steps: [{ tool: 'site.editText', args: { text: 'x' }, expect: 'text' }], verify: [{ kind: 'presence', text: 'x' }] },
      ALLOW
    );
    const d2 = critic.diffFingerprints(fp1, fp2, textPlan);
    assert.ok(d2.violations.some((v) => v.includes('custom CSS')), 'unplanned CSS change is collateral');
    n++;

    // Theme core change without theme.set -> violation.
    mdb.prepare('UPDATE websites SET theme = ? WHERE lead_id = 7').run(
      JSON.stringify({ ...themeV2, primary: '#0000ff' })
    );
    const fp3 = critic.siteFingerprint(mdb, 7);
    const d3 = critic.diffFingerprints(fp2, fp3, colourPlan());
    assert.equal(d3.themeCoreChanged, true);
    assert.ok(d3.violations.some((v) => v.includes('theme settings')), 'unplanned theme change is collateral');
    n += 2;

    // Out-of-scope page change -> violation; in-scope is clean.
    const scopedPlan = chatPlan.validatePlan(
      {
        ...COLOUR_PLAN,
        scope: { pages: ['index'], sections: null },
        steps: [{ tool: 'pages.structure.update', args: { action: 'update' }, expect: 'page' }],
        verify: [{ kind: 'presence', text: 'Hello' }],
      },
      ALLOW
    );
    const pagesV2 = [pagesV1[0], { slug: 'about', title: 'About Us', sections: [] }];
    mdb.prepare('UPDATE websites SET pages = ? WHERE lead_id = 7').run(JSON.stringify(pagesV2));
    const fp4 = critic.siteFingerprint(mdb, 7);
    const d4 = critic.diffFingerprints(fp3, fp4, scopedPlan);
    assert.ok(d4.violations.some((v) => v.includes('"about"')), 'out-of-scope page change flagged');
    const d5 = critic.diffFingerprints(fp3, fp4, colourPlan());
    assert.equal(d5.violations.filter((v) => v.includes('"about"')).length, 0, 'whole-site scope covers it');
    n += 2;

    // runCritic: computedStyle pass/fail against canned renders.
    const htmlSeed =
      '<html><head><style>h3 { color: #7a4a21; }</style></head><body><section><h3>Plain Heading</h3></section></body></html>';
    const htmlDone =
      '<html><head><style>h3 { color: #7a4a21; }\n/* bitpype:chat-rules:start */\nh3 { color: #444444; }\n/* bitpype:chat-rules:end */</style></head><body><section><h3>Plain Heading</h3></section></body></html>';
    const plan = colourPlan();
    const passReport = critic.runCritic({ plan, before: fp1, after: fp2, renderPageHtml: () => htmlDone });
    assert.equal(passReport.verdict, 'pass', 'rendered #444444 passes the plan');
    const failReport = critic.runCritic({ plan, before: fp1, after: fp2, renderPageHtml: () => htmlSeed });
    assert.equal(failReport.verdict, 'fail');
    assert.ok(failReport.failures[0].includes('#7a4a21'), 'failure names the ACTUAL rendered value');
    assert.ok(failReport.failures[0].includes('#444444'), 'failure names the expected value');
    n += 4;

    // Presence checks.
    const presencePlan = chatPlan.validatePlan(
      { ...COLOUR_PLAN, steps: [{ tool: 'site.editText', args: { text: 'Wedding Cake Tastings' }, expect: 'page' }], verify: [{ kind: 'presence', text: 'Wedding Cake Tastings' }] },
      ALLOW
    );
    const pOk = critic.runCritic({ plan: presencePlan, before: fp2, after: fp2, renderPageHtml: () => '<html><body><h1>Wedding Cake Tastings</h1></body></html>' });
    assert.equal(pOk.verdict, 'pass');
    const pBad = critic.runCritic({ plan: presencePlan, before: fp2, after: fp2, renderPageHtml: () => htmlSeed });
    assert.equal(pBad.verdict, 'fail');
    assert.ok(pBad.failures[0].includes('not found'), 'missing text fails plainly');
    n += 3;

    // Mutation sanity: claimed change, identical fingerprint.
    const sanity = critic.runCritic({ plan, before: fp1, after: fp1, renderPageHtml: () => htmlDone, expectChange: true });
    assert.equal(sanity.verdict, 'fail');
    assert.ok(sanity.failures.some((f) => f.includes('byte-identical')), 'no-effective-change is a critic failure');
    n += 2;
    mdb.close();
    group('Part 1 critic units (verify + collateral + sanity)', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — the reviewer inside runSiteAgentChat
  // ---------------------------------------------------------------
  {
    let n = 0;
    const FIXTURE_PAGES = [
      { slug: 'index', title: 'Home', sections: [{ type: 'hero', content: { headline: 'ZZ B99 Bakery' } }] },
    ];
    const seedLead = (label) => {
      const info = realDb
        .prepare('INSERT INTO leads (business_name, category, phone) VALUES (?, ?, ?)')
        .run(`ZZ B99 ${label}`, 'Bakery', '(610) 555-0198');
      const leadId = Number(info.lastInsertRowid);
      realDb
        .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
        .run(leadId, `ZZ B99 ${label}`, 'draft', JSON.stringify(FIXTURE_PAGES), JSON.stringify({ primary: '#7a4a21', customCss: 'h3 { color: #7a4a21; }' }));
      return leadId;
    };
    const applyHex = (leadId, hex) => {
      const row = realDb.prepare('SELECT theme FROM websites WHERE lead_id = ?').get(leadId);
      const theme = JSON.parse(row.theme || '{}');
      theme.customCss = `h3 { color: #7a4a21; }\n/* bitpype:chat-rules:start */\nh3 { color: ${hex}; }\n/* bitpype:chat-rules:end */`;
      realDb.prepare('UPDATE websites SET theme = ? WHERE lead_id = ?').run(JSON.stringify(theme), leadId);
    };

    let planQueue = [];
    let planCalls = [];
    let loopScript = [];
    let loopCalls = [];
    const fakeMuseAgent = {
      classifyPortalChatIntent: async () => ({ intent: 'change', ready: true, size: 'small', settled: [], fallback: false }),
      planPortalChange: async (_ws, _lead, opts) => {
        planCalls.push(opts);
        return planQueue.length ? planQueue.shift() : { plan: colourPlan() };
      },
      runPortalImproveLoop: async (_ws, leadId, opts) => {
        loopCalls.push(opts);
        const base = { steps: 1, model: 'fixture-model', imagesSent: false, imagesDropped: false };
        if (opts.mode !== 'build') return { ...base, reply: 'Answer.', mutated: false, published: false, toolCalls: 0 };
        const action = loopScript.length ? loopScript.shift() : { hex: '#444444' };
        if (action.hex) applyHex(leadId, action.hex);
        return { ...base, reply: action.reply || 'Done — headings updated.', mutated: true, published: true, toolCalls: 1 };
      },
    };
    const alwaysPassCritic = {
      siteFingerprint: () => null,
      runCritic: () => ({ verdict: 'pass', checks: [], collateral: { changed: true, violations: [] }, failures: [] }),
    };
    const sliceMod = { exports: {} };
    vm.runInNewContext(loadPortalSliceSource() + ';module.exports = { runSiteAgentChat, takeSiteChatUpdates };', {
      module: sliceMod,
      exports: sliceMod.exports,
      console,
      Buffer,
      process,
      resolveClientSite: (_db, leadId) => {
        const row = realDb.prepare('SELECT * FROM websites WHERE lead_id = ?').get(Number(leadId));
        return row ? { id: row.id, pages: JSON.parse(row.pages || '[]'), theme: JSON.parse(row.theme || '{}') } : null;
      },
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
          : name === './siteChatCritic' && NEGATIVE === 'reviewer'
            ? alwaysPassCritic
            : name === './domain'
              ? { withDb: (_ws, fn) => fn(realDb) }
              : require(name.startsWith('.') ? path.join(root, 'server', name) : name),
    });
    const runChat = (leadId, body) => sliceMod.exports.runSiteAgentChat(1, leadId, body);
    const reset = () => {
      planQueue = [];
      planCalls = [];
      loopScript = [];
      loopCalls = [];
    };

    // (a) first-try pass: review verdict ships, persisted on the plan.
    {
      const lead = seedLead('pass');
      reset();
      const res = await runChat(lead, { message: 'change all h3 to dark grey' });
      assert.equal(res.mode, 'build');
      assert.ok(res.review, 'payload carries the review');
      assert.equal(res.review.verdict, 'pass');
      assert.equal(res.review.cycles, 0);
      assert.equal(planCalls.length, 1, 'no rework when the critic passes');
      const row = chatPlan.getPlan(realDb, res.planId);
      assert.equal(row.status, 'implemented');
      assert.ok(row.review && row.review.verdict === 'pass', 'verdict persisted on the plan row');
      assert.ok(row.review.checks.some((c) => c.kind === 'computedStyle' && c.pass), 'evidence checks persisted');
      n += 8;
    }
    // (b) wrong colour lands -> critic fails -> ONE rework with the
    // findings -> corrected plan -> pass at cycle 1.
    {
      const lead = seedLead('rework');
      reset();
      loopScript = [{ hex: '#999999' }, { hex: '#444444', reply: 'Fixed — headings are dark grey now.' }];
      const res = await runChat(lead, { message: 'change all h3 to dark grey' });
      assert.equal(res.review.verdict, 'pass', 'rework recovers the turn');
      assert.equal(res.review.cycles, 1);
      assert.equal(planCalls.length, 2, 'planner re-called once for rework');
      assert.ok(planCalls[1].rework && planCalls[1].rework.failures.join(' ').includes('#999999'), 'critic actuals feed the rework');
      assert.equal(res.reply, 'Fixed — headings are dark grey now.', "the successful attempt's summary ships");
      n += 5;
    }
    // (c) never lands -> 2 rework cycles -> the reviewer escalates
    // by queueing the job itself, plan + findings attached.
    {
      const lead = seedLead('escalate');
      reset();
      loopScript = [{ hex: '#999999' }, { hex: '#999999' }, { hex: '#999999' }];
      const res = await runChat(lead, { message: 'change all h3 to dark grey' });
      assert.equal(res.review.verdict, 'escalated');
      assert.equal(res.review.cycles, 2, 'rework is bounded at 2 cycles');
      assert.ok(res.review.escalatedJobId, 'reviewer created the queued job');
      assert.ok(res.reply.includes("isn't right yet"), 'reply discloses the failure plainly');
      assert.ok(res.reply.includes('queued it for the design agent'), 'reply discloses the escalation');
      const job = realDb.prepare('SELECT * FROM design_jobs WHERE id = ?').get(res.review.escalatedJobId);
      assert.ok(job, 'escalation job exists');
      assert.ok(String(job.instructions).includes('AUTOMATED REVIEWER ESCALATION'), 'findings ride the job');
      const brief = JSON.parse(job.brief || '{}');
      assert.ok(brief.chat_origin && Array.isArray(brief.chat_origin.plans), 'plan rides the escalation job');
      assert.ok(brief.chat_origin.baseline, 'baseline stamped for the delivery gate');
      const row = chatPlan.getPlan(realDb, res.planId);
      assert.equal(row.status, 'escalated');
      n += 10;
    }
    // (d) unplanned: loop claims a mutation, nothing changes ->
    // mutation-sanity fails and the reply says so honestly.
    {
      const lead = seedLead('sanity');
      reset();
      planQueue = [{ plan: null }];
      loopScript = [{ hex: null }];
      const res = await runChat(lead, { message: 'make the headings pop more' });
      assert.equal(res.mode, 'build');
      assert.ok(res.review && res.review.verdict === 'fail', 'sanity failure surfaces in the review');
      assert.ok(res.reply.includes('nothing actually changed'), 'reply refuses the fiction');
      n += 3;
    }
    group('Part 2 reviewer (pass / rework / escalate / sanity)', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — deliverJob gate: verify before write-back
  // ---------------------------------------------------------------
  {
    let n = 0;
    const leadInfo = realDb
      .prepare('INSERT INTO leads (business_name, category, phone) VALUES (?, ?, ?)')
      .run('ZZ B99 Gate Bakery', 'Bakery', '(610) 555-0198');
    const leadId = Number(leadInfo.lastInsertRowid);
    const pages = [
      { slug: 'index', title: 'Home', sections: [{ type: 'html', content: { html: '<section><h3>ZZ Gate Heading</h3><p>Loaves.</p></section>' } }] },
    ];
    const themeSeed = { primary: '#7a4a21', paper: '#F6F6F4', ink: '#141414', headingFont: 'Fraunces', font: 'Figtree', customCss: 'h3 { color: #7a4a21; }' };
    realDb
      .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
      .run(leadId, 'ZZ B99 Gate Bakery', 'draft', JSON.stringify(pages), JSON.stringify(themeSeed));
    const plan = colourPlan();
    const baseline = critic.siteFingerprint(realDb, leadId);
    const created = designJobs.createJob(realDb, {
      leadId,
      type: 'improvement',
      title: 'Improvement: headings',
      instructions: 'Change the headings per the plan.',
      siteShape: 'landing',
    });
    const jobId = Number(created.id);
    realDb.prepare('UPDATE design_jobs SET brief = ? WHERE id = ?').run(
      JSON.stringify({ chat_origin: { source: 'portal_site_chat', plans: [plan], plan, baseline, websiteId: null, queuedAt: new Date().toISOString() } }),
      jobId
    );

    // Delivery WITHOUT the change -> bounce, honest write-back.
    const d1 = await designJobs.deliverJob(realDb, jobId, { summary: 'Headings are now dark grey.' }, null, {});
    let job = realDb.prepare('SELECT * FROM design_jobs WHERE id = ?').get(jobId);
    assert.equal(job.status, 'waiting_on_agent', 'unverified delivery bounces back to the queue');
    assert.ok(String(job.instructions).includes('AUTOMATED REVIEW'), 'findings appended to the job');
    let brief = JSON.parse(job.brief || '{}');
    assert.equal(brief.chat_origin.verify.state, 'bounced');
    assert.equal(brief.chat_origin.bounces, 1);
    let msgs = thread.takeUndelivered(realDb, leadId);
    assert.equal(msgs.length, 1, 'owner got exactly one write-back');
    assert.ok(msgs[0].content.includes("didn't pass verification"), 'write-back is honest, not "done"');
    n += 6;

    // Apply the change, deliver again -> pass + evidence line.
    const themeDone = { ...themeSeed, customCss: 'h3 { color: #7a4a21; }\n/* bitpype:chat-rules:start */\nh3 { color: #444444; }\n/* bitpype:chat-rules:end */' };
    realDb.prepare('UPDATE websites SET theme = ? WHERE lead_id = ?').run(JSON.stringify(themeDone), leadId);
    const d2 = await designJobs.deliverJob(realDb, jobId, { summary: 'Headings are now dark grey.' }, null, {});
    job = realDb.prepare('SELECT * FROM design_jobs WHERE id = ?').get(jobId);
    assert.equal(job.status, 'delivered', 'verified delivery ships');
    brief = JSON.parse(job.brief || '{}');
    assert.equal(brief.chat_origin.verify.state, 'passed');
    msgs = thread.takeUndelivered(realDb, leadId);
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].content.includes('Your queued design job is done.'), 'completion summary posted');
    assert.ok(msgs[0].content.includes('Verified before posting this'), 'evidence line rides the write-back');
    assert.ok(msgs[0].content.includes('#444444'), 'evidence names the rendered value');
    n += 6;
    group('Part 3 deliverJob gate (bounce then verified pass)', n);
  }

  // ---------------------------------------------------------------
  // Part 4 — wiring pins
  // ---------------------------------------------------------------
  {
    let n = 0;
    const cp = fs.readFileSync(path.join(root, 'server', 'clientPortal.js'), 'utf8');
    const dj = fs.readFileSync(path.join(root, 'src', 'designJobs.js'), 'utf8');
    assert.ok(cp.includes("require('./siteChatCritic')"), 'reviewer uses the critic module');
    assert.ok(cp.includes('REVIEWER gate'), 'reviewer block ships');
    assert.ok(cp.includes('cycles < 2'), 'rework bound ships');
    assert.ok(cp.includes('AUTOMATED REVIEWER ESCALATION'), 'escalation ships');
    assert.ok(cp.includes('baseline: priorOrigin.baseline || turnFingerprintBefore'), 'baseline stamping ships');
    assert.ok(dj.includes('CRITIC + REVIEWER gate'), 'deliverJob gate ships');
    assert.ok(dj.includes("verifyRecord.state = 'bounced'"), 'bounce path ships');
    assert.ok(dj.includes('Verified before posting this'), 'evidence line ships');
    n += 8;
    group('Part 4 wiring pins', n);
  }

  console.log(JSON.stringify({ passed: true, groups, negative: NEGATIVE || null }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
