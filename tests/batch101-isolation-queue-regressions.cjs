'use strict';
/**
 * Batch 101 — ISOLATION + QUEUE HONESTY (four-role rebuild
 * step 4; review §12.5/§13, Audit 2 §I re-verification).
 *
 * 1. Queue honesty: a queued big job's state is derived from
 *    its real row (server/siteChatQueue.js) — queued /
 *    building / in_review (bounced by the Batch 99 reviewer) /
 *    waiting_on_you / delivered — and rides the chat payload,
 *    the history payload and the updates poller, rendered as a
 *    status line in the portal.
 * 2. Merge honesty: a new big ask merges ONLY into an
 *    unstarted (waiting_on_agent) open job. If the open job is
 *    already claimed (in_progress), the ask becomes a SECOND
 *    job — the claimed job's instructions are never silently
 *    rewritten mid-build (the old createJob-replace hazard,
 *    removed by a direct insert in queueBigJob).
 * 3. Playbook fence (H6 re-verified under the new
 *    architecture): chat-origin deliveries skip
 *    designLearning.observeDeliver — the owner's chat words
 *    (job titles/briefs) never enter the shared playbook
 *    corpus. Non-chat deliveries still teach it.
 * 4. The full cross-site battery under the new architecture:
 *    transcripts, pendings, plans, summaries and poller
 *    write-backs are per-site; nothing crosses.
 *
 * NEGATIVE PROOF: B101_NEGATIVE=queue seeds the require cache
 * so clientPortal sees a siteChatQueue whose jobChatState
 * always claims 'queued' (plausible fiction) -> Part 3's
 * state transitions fail and the suite goes RED.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b101-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch101', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const NEGATIVE = process.env.B101_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

function loadPortalSliceSource() {
  const src = require('./lib/monolithSource.cjs').clientPortalSource();
  const start = src.indexOf('async function runSiteAgentChat(');
  const end = src.indexOf('/**', start);
  assert.ok(start > 0 && end > start, 'slice bounds found');
  return src.slice(start, end);
}

const BIG_PLAN = {
  scope: { pages: ['tastings'], sections: null },
  settled: [],
  defaultsApplied: [],
  steps: [{ tool: 'pages.structure.update', args: { action: 'create', slug: 'tastings' }, expect: 'page exists' }],
  verify: [{ kind: 'presence', text: 'Tastings' }],
  size: 'big',
};

(async () => {
  const domain = require(path.join(root, 'server', 'domain.js'));
  const chatQueue = require(path.join(root, 'server', 'siteChatQueue.js'));
  const chatPlan = require(path.join(root, 'server', 'siteChatPlan.js'));
  const chatSummary = require(path.join(root, 'server', 'siteChatSummary.js'));
  const chatPending = require(path.join(root, 'server', 'siteChatPending.js'));
  const thread = require(path.join(root, 'server', 'siteChatThread.js'));
  const designJobs = require(path.join(root, 'src', 'designJobs.js'));
  const designLearning = require(path.join(root, 'src', 'designLearning.js'));
  await require(path.join(root, 'server', 'db.js')).migrate();
  const realDb = domain.withDb(1, (db) => db);
  designJobs.ensureTables(realDb);
  chatPending.ensureTable(realDb);
  chatPlan.ensureTable(realDb);
  thread.ensureTable(realDb);

  const seedLead = (label, withSite = true) => {
    const info = realDb
      .prepare('INSERT INTO leads (business_name, category, phone) VALUES (?, ?, ?)')
      .run(`ZZ B101 ${label}`, 'Bakery', '(610) 555-0198');
    const leadId = Number(info.lastInsertRowid);
    if (withSite) {
      realDb
        .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
        .run(
          leadId,
          `ZZ B101 ${label}`,
          'draft',
          JSON.stringify([{ slug: 'index', title: 'Home', sections: [{ type: 'hero', content: { headline: `ZZ B101 ${label}` } }] }]),
          JSON.stringify({ primary: '#7a4a21', customCss: '' })
        );
    }
    return leadId;
  };

  // ---------------------------------------------------------------
  // Part 1 — state mapping units
  // ---------------------------------------------------------------
  {
    let n = 0;
    const brief = { chat_origin: { source: 'portal_site_chat', queuedAt: '2026-10-31T10:00:00.000Z' } };
    assert.equal(chatQueue.jobChatState({ id: 5, status: 'waiting_on_agent' }, brief).state, 'queued');
    assert.equal(chatQueue.jobChatState({ id: 5, status: 'in_progress' }, brief).state, 'building');
    assert.equal(chatQueue.jobChatState({ id: 5, status: 'draft' }, brief).state, 'building');
    assert.equal(chatQueue.jobChatState({ id: 5, status: 'questions_pending' }, brief).state, 'waiting_on_you');
    assert.equal(chatQueue.jobChatState({ id: 5, status: 'delivered' }, brief).state, 'delivered');
    const bouncedBrief = { chat_origin: { source: 'portal_site_chat', verify: { state: 'bounced' } } };
    const bounced = chatQueue.jobChatState({ id: 5, status: 'waiting_on_agent' }, bouncedBrief);
    assert.equal(bounced.state, 'in_review', 'a bounced job reads as in-review, not freshly queued');
    assert.equal(bounced.verifyState, 'bounced');
    assert.equal(chatQueue.jobChatState(null, brief), null);
    assert.equal(chatQueue.shouldMergeIntoOpenJob({ status: 'waiting_on_agent' }), true);
    assert.equal(chatQueue.shouldMergeIntoOpenJob({ status: 'in_progress' }), false);
    assert.equal(chatQueue.shouldMergeIntoOpenJob({ status: 'questions_pending' }), false);
    assert.equal(chatQueue.shouldMergeIntoOpenJob(null), false);
    n += 12;
    group('Part 1 queue state mapping (honest states)', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — merge honesty through runSiteAgentChat
  // ---------------------------------------------------------------
  {
    let n = 0;
    const FIXTURE_PAGES = [{ slug: 'index', title: 'Home', sections: [{ type: 'hero', content: { headline: 'ZZ B101 Bakery' } }] }];
    const bigPlan = () => chatPlan.validatePlan(JSON.parse(JSON.stringify(BIG_PLAN)), new Set(['pages.structure.update', 'theme.styleRule']));
    const fakeMuseAgent = {
      classifyPortalChatIntent: async () => ({ intent: 'change', ready: true, size: 'big', settled: [], fallback: false }),
      planPortalChange: async () => ({ plan: bigPlan() }),
      runPortalImproveLoop: async () => ({ steps: 0, reply: 'n/a', mutated: false, published: false, toolCalls: 0, model: 'fixture', imagesSent: false, imagesDropped: false }),
    };
    const sliceMod = { exports: {} };
    vm.runInNewContext(loadPortalSliceSource() + ';module.exports = { runSiteAgentChat };', {
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
      renderClientSite: () => ({ html: '<html><body>preview</body></html>', previewUrl: 'https://bitpype.test/preview/site', editable: true, theme: null, logo: null, pages: [] }),
      require: (name) =>
        name === './museAgent'
          ? fakeMuseAgent
          : name === './domain'
            ? { withDb: (_ws, fn) => fn(realDb) }
            : require(name.startsWith('.') ? path.join(root, 'server', name) : name),
    });
    const runChat = (leadId, body) => sliceMod.exports.runSiteAgentChat(1, leadId, body);

    // (a) claimed job: a second big ask becomes a SECOND job.
    {
      const lead = seedLead('claimed');
      const first = await runChat(lead, { message: 'add a tastings page' });
      assert.equal(first.mode, 'queued');
      const firstJobId = Number(first.queuedJobId);
      const before = realDb.prepare('SELECT instructions FROM design_jobs WHERE id = ?').get(firstJobId);
      realDb.prepare("UPDATE design_jobs SET status = 'in_progress' WHERE id = ?").run(firstJobId);
      const second = await runChat(lead, { message: 'also add a wholesale page' });
      assert.equal(second.mode, 'queued');
      assert.notEqual(Number(second.queuedJobId), firstJobId, 'a claimed job is never merged into — a second job is created');
      const after = realDb.prepare('SELECT instructions, status FROM design_jobs WHERE id = ?').get(firstJobId);
      assert.equal(after.instructions, before.instructions, "the claimed job's instructions are byte-identical");
      assert.equal(after.status, 'in_progress', 'the claimed job keeps its state');
      assert.ok(second.queueStatus && second.queueStatus.state === 'queued', 'the new job reports its honest state');
      n += 6;
    }
    // (b) unstarted job: the ask merges, plans accumulate.
    {
      const lead = seedLead('waiting');
      const first = await runChat(lead, { message: 'add a tastings page' });
      const jobId = Number(first.queuedJobId);
      const second = await runChat(lead, { message: 'and a wholesale page too' });
      assert.equal(Number(second.queuedJobId), jobId, 'an unstarted job still merges');
      const job = realDb.prepare('SELECT * FROM design_jobs WHERE id = ?').get(jobId);
      assert.ok(String(job.instructions).includes('Additional queued request'), 'the second ask appended');
      const brief = JSON.parse(job.brief || '{}');
      assert.equal(brief.chat_origin.plans.length, 2, 'both plans ride the merged job');
      n += 3;
    }
    group('Part 2 merge honesty (claimed = second job, waiting = merge)', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — status surfacing (history + poller), honest arcs
  // ---------------------------------------------------------------
  {
    let n = 0;
    // Cache surgery so the NEGATIVE shim (or the real module)
    // is what clientPortal's lazy require picks up.
    const queuePath = require.resolve(path.join(root, 'server', 'siteChatQueue.js'));
    delete require.cache[queuePath];
    if (NEGATIVE === 'queue') {
      require.cache[queuePath] = {
        exports: {
          jobChatState: (row) => ({ jobId: Number(row.id), state: 'queued', rawStatus: String(row.status || ''), queuedAt: null, ageMinutes: 0, verifyState: null }),
          shouldMergeIntoOpenJob: () => true,
          stateLabel: () => 'queued',
        },
      };
    }
    const clientPortal = require(path.join(root, 'server', 'clientPortal.js'));
    const lead = seedLead('states');
    const created = designJobs.createJob(realDb, {
      leadId: lead,
      type: 'improvement',
      title: 'Improvement: tastings',
      instructions: 'Add it.',
      siteShape: 'landing',
    });
    const jobId = Number(created.id);
    realDb.prepare('UPDATE design_jobs SET brief = ? WHERE id = ?').run(
      JSON.stringify({ chat_origin: { source: 'portal_site_chat', queuedAt: new Date().toISOString(), plans: [] } }),
      jobId
    );
    const stateOf = () => {
      const hist = clientPortal.getSiteChatHistory(1, lead);
      const entry = (hist.queue || []).find((q) => q.jobId === jobId);
      return entry && entry.state;
    };
    assert.equal(stateOf(), 'queued');
    realDb.prepare("UPDATE design_jobs SET status = 'in_progress' WHERE id = ?").run(jobId);
    assert.equal(stateOf(), 'building', 'claimed reads as building');
    // Bounced: back to waiting + verify bounced -> in_review.
    const briefBounced = JSON.parse(realDb.prepare('SELECT brief FROM design_jobs WHERE id = ?').get(jobId).brief || '{}');
    briefBounced.chat_origin.verify = { state: 'bounced', at: new Date().toISOString() };
    realDb.prepare("UPDATE design_jobs SET status = 'waiting_on_agent', brief = ? WHERE id = ?").run(JSON.stringify(briefBounced), jobId);
    assert.equal(stateOf(), 'in_review', 'bounced reads as in-review');
    realDb.prepare("UPDATE design_jobs SET status = 'delivered' WHERE id = ?").run(jobId);
    assert.equal(stateOf(), 'delivered');
    const updates = clientPortal.takeSiteChatUpdates(1, lead);
    assert.ok((updates.queue || []).some((q) => q.jobId === jobId && q.state === 'delivered'), 'the poller carries the same truth');
    n += 5;
    if (NEGATIVE === 'queue') delete require.cache[queuePath];
    group('Part 3 status surfacing (history + poller arcs)', n);
  }

  // ---------------------------------------------------------------
  // Part 4 — playbook fence (H6 re-verified)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const lead = seedLead('fence');
    const chatJob = designJobs.createJob(realDb, {
      leadId: lead,
      type: 'improvement',
      title: 'Improvement: ZZ101 secret owner words',
      instructions: 'Owner words.',
      siteShape: 'landing',
    });
    realDb.prepare('UPDATE design_jobs SET brief = ? WHERE id = ?').run(
      JSON.stringify({ chat_origin: { source: 'portal_site_chat', plans: [], queuedAt: new Date().toISOString() } }),
      chatJob.id
    );
    await designJobs.deliverJob(realDb, Number(chatJob.id), { summary: 'Done.' }, null, {});
    const chatEvents = designLearning.listEvents(realDb, { jobId: Number(chatJob.id) });
    assert.equal(chatEvents.length, 0, 'chat-origin delivery teaches the playbook NOTHING');
    const plainJob = designJobs.createJob(realDb, {
      leadId: lead,
      type: 'improvement',
      title: 'Improvement: regular agent job',
      instructions: 'Regular.',
      siteShape: 'landing',
    });
    await designJobs.deliverJob(realDb, Number(plainJob.id), { summary: 'Done.' }, null, {});
    const plainEvents = designLearning.listEvents(realDb, { jobId: Number(plainJob.id) });
    assert.ok(plainEvents.length >= 1, 'non-chat deliveries still teach the playbook');
    n += 2;
    group('Part 4 playbook fence (chat-origin skipped)', n);
  }

  // ---------------------------------------------------------------
  // Part 5 — the cross-site battery, all stores at once
  // ---------------------------------------------------------------
  {
    let n = 0;
    const clientPortal = require(path.join(root, 'server', 'clientPortal.js'));
    const a = seedLead('battery-a');
    const b = seedLead('battery-b');
    const MARKER = 'ZZ101-UNIQUE-MARKER-quince';
    thread.addMessage(realDb, { leadId: a, role: 'user', content: `please ${MARKER}`, source: 'portal_chat', delivered: true });
    chatPending.savePending(realDb, a, { kind: 'clarify', requestText: MARKER, questions: ['Which?'], answers: [], settledFacts: [], roundsUsed: 0 });
    chatPlan.savePlan(realDb, {
      leadId: a,
      plan: chatPlan.validatePlan(
        { scope: { pages: ['all'] }, settled: [MARKER], steps: [{ tool: 'theme.styleRule', args: { selector: 'h3', property: 'color', value: '#444444' }, expect: 'x' }], verify: [], size: 'small' },
        new Set(['theme.styleRule'])
      ),
    });
    chatSummary.mergeTurn(realDb, a, {
      userText: MARKER,
      userMsgId: 1,
      assistantMsgId: 2,
      settledFacts: [`note: ${MARKER}`],
      mode: 'build',
      mutated: true,
    });
    thread.addMessage(realDb, { leadId: a, jobId: 999, source: 'design_job', content: `write-back ${MARKER}`, delivered: false });

    const histB = clientPortal.getSiteChatHistory(1, b);
    assert.equal(histB.messages.length, 0, "B's transcript is empty");
    assert.equal(histB.summary, null, "B's summary is absent");
    assert.equal((histB.queue || []).length, 0, "B's queue is empty");
    assert.equal(chatPending.getPending(realDb, b), null, "B has no pending");
    assert.equal(chatPlan.latestPlan(realDb, b), null, "B has no plan");
    assert.ok(!JSON.stringify(histB).includes(MARKER), "A's marker never appears in B's history payload");
    const updB = clientPortal.takeSiteChatUpdates(1, b);
    assert.equal(updB.messages.length, 0, "B's poller is empty");
    n += 7;
    const updA1 = clientPortal.takeSiteChatUpdates(1, a);
    assert.equal(updA1.messages.length, 1, "A's write-back surfaces once");
    const updA2 = clientPortal.takeSiteChatUpdates(1, a);
    assert.equal(updA2.messages.length, 0, 'and never twice (dedupe)');
    const histA = clientPortal.getSiteChatHistory(1, a);
    assert.ok(JSON.stringify(histA).includes(MARKER), "A's own state is intact");
    n += 3;
    group('Part 5 cross-site battery (transcript/pending/plan/summary/poller)', n);
  }

  // ---------------------------------------------------------------
  // Part 6 — wiring pins
  // ---------------------------------------------------------------
  {
    let n = 0;
    const cp = require('./lib/monolithSource.cjs').clientPortalSource();
    const dj = fs.readFileSync(path.join(root, 'src', 'designJobs.js'), 'utf8');
    const js = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
    assert.ok(cp.includes('shouldMergeIntoOpenJob'), 'merge gate ships');
    assert.ok(cp.includes('a second queued job'), 'second-job path ships');
    assert.ok(cp.includes('chatQueueStatuses'), 'status helper ships');
    assert.ok(cp.includes('queueStatus:'), 'chat payload carries the status');
    assert.ok(dj.includes('playbook fence'), 'learning fence ships');
    assert.ok(dj.includes('isChatOriginJob'), 'fence condition ships');
    assert.ok(js.includes('renderAgentChatQueue'), 'portal renders the queue line');
    assert.ok(html.includes('id="agent-chat-queue"'), 'queue line element ships');
    n += 8;
    group('Part 6 wiring pins', n);
  }

  console.log(JSON.stringify({ passed: true, groups, negative: NEGATIVE || null }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
