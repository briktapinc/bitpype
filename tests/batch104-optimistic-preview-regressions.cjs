'use strict';
/**
 * Batch 104 — OPTIMISTIC PREVIEW for the portal design chat.
 *
 * Ely's ask: an accepted change appears in the preview
 * instantly; the verified build confirms it (patch stays /
 * verified render wins) or verification fails (patch reverts +
 * plain-language notice). Proven here:
 *
 *  1. Derivation units (server/siteChatPatch.js): a validated
 *     plan deterministically yields an allowlisted patch spec —
 *     text ops from site.editText, style ops from
 *     theme.styleRule, vars ops from theme.set colours. There
 *     is NO html op. Hostile or ungroundable step args derive
 *     nothing patchable (tier 3), read-only plans derive null.
 *  2. Payload wiring (runSiteAgentChat slice, fake model):
 *     verified in-chat build -> patch state 'verified' with the
 *     plan's ops; queued big job -> patch state 'queued' riding
 *     the job id (tier 3 for structure-only plans, tier 2 when
 *     the plan carries patchable steps); a build the reviewer
 *     escalates -> 'queued' under the escalation job id; a
 *     build that changed nothing -> state 'failed'; a question
 *     turn carries no patch at all.
 *  3. Bridge (real Chromium, engine-rendered preview in a
 *     sandboxed srcdoc iframe — the preview-browser-check
 *     harness): apply swaps the headline text + recolours the
 *     H3 + sets the theme var; hostile ops (html op, CSS
 *     breakout values, forged selectors) are refused; revert
 *     restores the document exactly; confirm keeps the change
 *     and drops the treatment.
 *  4. Client wiring (source-level): the Tier-1 quoted-swap
 *     parser behaves (and is unit-run from the real portal.js
 *     source), sendAgentChat applies it at send time and
 *     reconciles the server spec, the updates poller resolves
 *     patches by job, portal.html carries the treatments, the
 *     bridge + portal patch code contain no innerHTML, and the
 *     public visitor surfaces carry no patch code at all.
 *
 * NEGATIVE PROOF: B104_NEGATIVE=derive seeds the require cache
 * so the chat handler sees a siteChatPatch whose derivation
 * always returns null -> Part 2's payload assertions go RED.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b104-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch104', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const NEGATIVE = process.env.B104_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

function loadPortalSliceSource() {
  const src = require('./lib/monolithSource.cjs').clientPortalSource();
  const start = src.indexOf('async function runSiteAgentChat(');
  const end = src.indexOf('\n/**', start);
  assert.ok(start > 0 && end > start, 'slice bounds found');
  return src.slice(start, end);
}

const STYLE_PLAN = {
  scope: { pages: ['all'], sections: null },
  settled: ['H3 colour: dark grey'],
  defaultsApplied: [],
  steps: [
    { tool: 'theme.styleRule', args: { selector: 'h3', property: 'color', value: '#444444' }, expect: 'every H3 dark grey' },
  ],
  verify: [{ kind: 'computedStyle', selector: 'h3', property: 'color', equals: '#444444', where: 'light' }],
  size: 'small',
};
const TEXT_PLAN = {
  scope: { pages: ['all'], sections: null },
  settled: [],
  defaultsApplied: [],
  steps: [
    { tool: 'site.editText', args: { target: 'ZZ B104 Bakery', text: 'ZZ B104 Warm Bread' }, expect: 'headline swapped' },
  ],
  verify: [{ kind: 'presence', text: 'ZZ B104 Warm Bread' }],
  size: 'small',
};

(async () => {
  const domain = require(path.join(root, 'server', 'domain.js'));
  const chatPlan = require(path.join(root, 'server', 'siteChatPlan.js'));
  const chatPending = require(path.join(root, 'server', 'siteChatPending.js'));
  const designJobs = require(path.join(root, 'src', 'designJobs.js'));
  const chatPatch = require(path.join(root, 'server', 'siteChatPatch.js'));
  await require(path.join(root, 'server', 'db.js')).migrate();
  const realDb = domain.withDb(1, (db) => db);
  designJobs.ensureTables(realDb);
  chatPending.ensureTable(realDb);
  chatPlan.ensureTable(realDb);

  const ALLOWED = new Set([
    ...require(path.join(root, 'server', 'museAgent.js')).PORTAL_DESIGN_TOOLS,
  ]);
  const vplan = (p) => chatPlan.validatePlan(JSON.parse(JSON.stringify(p)), ALLOWED);
  assert.ok(vplan(STYLE_PLAN) && vplan(TEXT_PLAN), 'fixture plans validate');

  // ---------------------------------------------------------------
  // Part 1 — derivation units
  // ---------------------------------------------------------------
  {
    let n = 0;
    const plan = (steps) => ({ scope: { pages: ['all'] }, steps, verify: [], size: 'small' });
    const d = chatPatch.deriveOptimisticPatch;

    let p = d(plan([{ tool: 'site.editText', args: { target: 'Old Headline', text: 'New Headline' } }]));
    assert.equal(p.tier, 2); assert.deepEqual(p.ops, [{ op: 'text', from: 'Old Headline', to: 'New Headline' }]); n += 2;

    p = d(plan([{ tool: 'theme.styleRule', args: { selector: 'h3', property: 'color', value: '#444444' } }]));
    assert.deepEqual(p.ops, [{ op: 'style', selector: 'h3', property: 'color', value: '#444444' }]); n += 1;

    p = d(plan([{ tool: 'theme.set', args: { primary: '#112233', text: '#445566' } }]));
    assert.deepEqual(p.ops, [{ op: 'vars', vars: { '--ws-primary': '#112233', '--ws-text': '#445566' } }]); n += 1;

    p = d(plan([{ tool: 'theme.set', args: { font: 'Fraunces' } }]));
    assert.equal(p.tier, 3); assert.equal(p.ops.length, 0); n += 2; // fonts-only: real write, nothing patchable

    p = d(plan([{ tool: 'pages.structure.update', args: { action: 'addpage', slug: 'x' } }]), { jobId: 42 });
    assert.equal(p.tier, 3); assert.equal(p.jobId, 42); n += 2;

    assert.equal(d(plan([{ tool: 'site.get', args: {} }, { tool: 'site.render', args: {} }])), null); n += 1;
    assert.equal(d(null), null); assert.equal(d({ steps: [] }), null); n += 2;

    // Hostile / ungroundable args derive no op (the step is
    // still a real write, so the plan lands on tier 3).
    p = d(plan([{ tool: 'theme.styleRule', args: { selector: 'h3{}', property: 'color', value: '#444444' } }]));
    assert.equal(p.ops.length, 0); assert.equal(p.tier, 3); n += 2;
    p = d(plan([{ tool: 'theme.styleRule', args: { selector: 'h3', property: 'color', value: 'red; } body{display:none' } }]));
    assert.equal(p.ops.length, 0); n += 1;
    p = d(plan([{ tool: 'theme.styleRule', args: { selector: 'h3', property: 'behavior', value: 'x' } }]));
    assert.equal(p.ops.length, 0); n += 1;
    p = d(plan([{ tool: 'theme.styleRule', args: { selector: 'h3', property: 'color', remove: true } }]));
    assert.equal(p.ops.length, 0); n += 1;
    p = d(plan([{ tool: 'site.editText', args: { target: 'same', text: 'same' } }]));
    assert.equal(p.ops.length, 0); n += 1;
    p = d(plan([{ tool: 'site.editText', args: { target: 'x'.repeat(300), text: 'New' } }]));
    assert.equal(p.ops.length, 0); n += 1;

    // No op kind outside the allowlist can ever appear, and a
    // mixed plan flags partial honestly.
    p = d(plan([
      { tool: 'site.editText', args: { target: 'A', text: 'B' } },
      { tool: 'modules.attach', args: { module: 'blog' } },
    ]));
    assert.equal(p.tier, 2); assert.equal(p.partial, true);
    assert.ok(p.ops.every((o) => ['text', 'style', 'vars'].includes(o.op))); n += 3;

    // Duplicate text steps dedupe.
    p = d(plan([
      { tool: 'site.editText', args: { target: 'A', text: 'B' } },
      { tool: 'site.editText', args: { target: 'A', text: 'B' } },
    ]));
    assert.equal(p.ops.length, 1); n += 1;

    group('Part 1 derivation units', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — payload wiring through runSiteAgentChat (fake model)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const FIXTURE_PAGES = [
      { slug: 'index', title: 'Home', sections: [{ type: 'hero', content: { headline: 'ZZ B104 Bakery', subheadline: 'Fresh daily.' } }] },
    ];
    const fixtureSites = {};
    const seedLead = (label) => {
      const info = realDb
        .prepare('INSERT INTO leads (business_name, category, phone) VALUES (?, ?, ?)')
        .run(`ZZ B104 ${label}`, 'Bakery', '(610) 555-0198');
      const leadId = Number(info.lastInsertRowid);
      fixtureSites[leadId] = { id: 8000 + leadId, pages: FIXTURE_PAGES, theme: { primary: '#7a4a21' } };
      realDb
        .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
        .run(
          leadId,
          `ZZ B104 ${label}`,
          'draft',
          JSON.stringify(FIXTURE_PAGES),
          JSON.stringify({ primary: '#7a4a21', customCss: 'h3 { color: #7a4a21; }' })
        );
      return leadId;
    };
    const applyPlanToSite = (leadId, plan) => {
      if (!plan) return;
      for (const step of plan.steps || []) {
        if (step.tool === 'theme.styleRule' && !step.args.remove) {
          const row = realDb.prepare('SELECT theme FROM websites WHERE lead_id = ?').get(leadId);
          const theme = JSON.parse(row.theme || '{}');
          theme.customCss =
            'h3 { color: #7a4a21; }\n/* bitpype:chat-rules:start */\n' +
            `${step.args.selector} { ${step.args.property}: ${step.args.value}; }\n/* bitpype:chat-rules:end */`;
          realDb.prepare('UPDATE websites SET theme = ? WHERE lead_id = ?').run(JSON.stringify(theme), leadId);
        }
        if (step.tool === 'site.editText') {
          const row = realDb.prepare('SELECT pages FROM websites WHERE lead_id = ?').get(leadId);
          const pages = JSON.parse(row.pages || '[]');
          if (pages[0] && pages[0].sections[0] && pages[0].sections[0].content.headline === step.args.target) {
            pages[0].sections[0].content.headline = step.args.text;
            realDb.prepare('UPDATE websites SET pages = ? WHERE lead_id = ?').run(JSON.stringify(pages), leadId);
          }
        }
      }
    };
    let classifyQueue = [];
    let planResult = { plan: vplan(STYLE_PLAN) };
    let loopApplies = true;
    const fakeMuseAgent = {
      classifyPortalChatIntent: async () => {
        if (!classifyQueue.length) throw new Error('classify queue empty');
        return classifyQueue.shift();
      },
      planPortalChange: async () => planResult,
      runPortalImproveLoop: async (_ws, leadId, opts) => {
        const base = { steps: 1, model: 'fixture-model', imagesSent: false, imagesDropped: false };
        if (opts.mode === 'build') {
          if (loopApplies) applyPlanToSite(leadId, opts.plan);
          return { ...base, reply: 'Done.', mutated: true, published: true, toolCalls: 1 };
        }
        return { ...base, reply: 'Answer.', mutated: false, published: false, toolCalls: 0 };
      },
    };
    if (NEGATIVE === 'derive') {
      const resolved = require.resolve(path.join(root, 'server', 'siteChatPatch.js'));
      require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { deriveOptimisticPatch: () => null, STYLE_PROPERTIES: new Set(), THEME_VAR_BY_KEY: {} },
      };
    }
    const sliceMod = { exports: {} };
    vm.runInNewContext(loadPortalSliceSource() + ';module.exports = { runSiteAgentChat, takeSiteChatUpdates };', {
      module: sliceMod,
      exports: sliceMod.exports,
      console,
      Buffer,
      process,
      resolveClientSite: (_db, leadId) => fixtureSites[Number(leadId)] || null,
      publishClientSitePreview: async () => ({ previewUrl: 'https://bitpype.test/preview/site' }),
      renderClientSite: (_ws, leadId) => {
        const wrow = realDb.prepare('SELECT theme, pages FROM websites WHERE lead_id = ?').get(Number(leadId));
        const theme = wrow ? JSON.parse(wrow.theme || '{}') : {};
        const pages = wrow ? JSON.parse(wrow.pages || '[]') : [];
        const headline =
          (pages[0] && pages[0].sections[0] && pages[0].sections[0].content.headline) || '';
        return {
          html: `<html><head><style>${theme.customCss || ''}</style></head><body><section><h1>${headline}</h1><h3>ZZ Heading</h3></section></body></html>`,
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
          : name === './domain'
            ? { withDb: (_ws, fn) => fn(realDb) }
            : require(name.startsWith('.') ? path.join(root, 'server', name) : name),
    });
    const runChat = (leadId, body) => sliceMod.exports.runSiteAgentChat(1, leadId, body);
    const readyChange = (size) => [{ intent: 'change', ready: true, size, settled: [], fallback: false }];

    // (a) verified in-chat build -> patch 'verified' with the style op.
    {
      const lead = seedLead('verified-style');
      classifyQueue = readyChange('small');
      planResult = { plan: vplan(STYLE_PLAN) };
      loopApplies = true;
      const res = await runChat(lead, { message: 'change all h3 to dark grey' });
      assert.equal(res.mode, 'build');
      assert.equal(res.review && res.review.verdict, 'pass');
      assert.ok(res.optimisticPatch, 'payload carries the patch');
      assert.equal(res.optimisticPatch.state, 'verified');
      assert.equal(res.optimisticPatch.tier, 2);
      assert.deepEqual(res.optimisticPatch.ops, [
        { op: 'style', selector: 'h3', property: 'color', value: '#444444' },
      ]);
      n += 6;
    }
    // (b) verified text build -> patch with the text op.
    {
      const lead = seedLead('verified-text');
      classifyQueue = readyChange('small');
      planResult = { plan: vplan(TEXT_PLAN) };
      loopApplies = true;
      const res = await runChat(lead, { message: 'change the headline "ZZ B104 Bakery" to "ZZ B104 Warm Bread"' });
      assert.equal(res.review && res.review.verdict, 'pass');
      assert.equal(res.optimisticPatch && res.optimisticPatch.state, 'verified');
      assert.deepEqual(res.optimisticPatch.ops, [
        { op: 'text', from: 'ZZ B104 Bakery', to: 'ZZ B104 Warm Bread' },
      ]);
      n += 3;
    }
    // (c) queued big structural job -> patch 'queued', tier 3, job id rides.
    {
      const lead = seedLead('queued-structural');
      classifyQueue = readyChange('big');
      planResult = {
        plan: vplan({
          ...STYLE_PLAN,
          size: 'big',
          steps: [{ tool: 'pages.structure.update', args: { action: 'addpage', slug: 'tastings' }, expect: 'page exists' }],
          verify: [{ kind: 'presence', text: 'Tastings' }],
        }),
      };
      const res = await runChat(lead, { message: 'add a tastings page' });
      assert.equal(res.mode, 'queued');
      assert.ok(res.optimisticPatch, 'queued turn carries a patch');
      assert.equal(res.optimisticPatch.state, 'queued');
      assert.equal(res.optimisticPatch.tier, 3);
      assert.equal(res.optimisticPatch.ops.length, 0);
      assert.equal(res.optimisticPatch.jobId, Number(res.queuedJobId));
      n += 6;
    }
    // (d) queued big job whose plan carries a patchable step -> tier 2.
    {
      const lead = seedLead('queued-patchable');
      classifyQueue = readyChange('big');
      planResult = { plan: vplan({ ...TEXT_PLAN, size: 'big' }) };
      const res = await runChat(lead, { message: 'rename the headline and rebuild the menu' });
      assert.equal(res.mode, 'queued');
      assert.equal(res.optimisticPatch.state, 'queued');
      assert.equal(res.optimisticPatch.tier, 2);
      assert.equal(res.optimisticPatch.jobId, Number(res.queuedJobId));
      assert.deepEqual(res.optimisticPatch.ops, [
        { op: 'text', from: 'ZZ B104 Bakery', to: 'ZZ B104 Warm Bread' },
      ]);
      n += 5;
    }
    // (e) reviewer escalation -> patch 'queued' under the escalation job.
    {
      const lead = seedLead('escalated');
      classifyQueue = readyChange('small');
      planResult = { plan: vplan(STYLE_PLAN) };
      loopApplies = false; // the loop claims success but changes nothing usable
      const res = await runChat(lead, { message: 'change all h3 to dark grey' });
      assert.equal(res.review && res.review.verdict, 'escalated');
      assert.ok(res.optimisticPatch, 'escalated turn carries a patch');
      assert.equal(res.optimisticPatch.state, 'queued');
      assert.equal(res.optimisticPatch.jobId, Number(res.review.escalatedJobId));
      assert.ok(res.optimisticPatch.jobId > 0);
      n += 5;
      loopApplies = true;
    }
    // (f) unplanned build that changed nothing -> patch state 'failed'.
    {
      const lead = seedLead('failed');
      classifyQueue = readyChange('small');
      planResult = { plan: null };
      loopApplies = false;
      const res = await runChat(lead, { message: 'make it pop' });
      assert.equal(res.mode, 'build');
      assert.equal(res.review && res.review.verdict, 'fail');
      assert.ok(res.optimisticPatch, 'failed turn carries the revert signal');
      assert.equal(res.optimisticPatch.state, 'failed');
      assert.equal(res.optimisticPatch.ops.length, 0);
      n += 5;
      loopApplies = true;
    }
    // (g) a question turn carries no patch.
    {
      const lead = seedLead('question');
      classifyQueue = [{ intent: 'question', ready: false, size: 'small', settled: [], fallback: false }];
      const res = await runChat(lead, { message: 'what colour are my headings?' });
      assert.equal(res.mode, 'answer');
      assert.equal(res.optimisticPatch, null);
      n += 2;
    }
    group('Part 2 payload wiring (fake model)', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — the bridge in a real browser (sandboxed srcdoc iframe)
  // B104_SKIP_BROWSER=1 is a local-iteration aid only (no Chromium
  // on this dev box); the regression gate always runs it in-image.
  // ---------------------------------------------------------------
  if (process.env.B104_SKIP_BROWSER === '1') {
    console.log('  skip Part 3 bridge in Chromium (B104_SKIP_BROWSER=1 — local iteration only)');
  } else {
    let n = 0;
    const puppeteer = require('puppeteer');
    const http = require('node:http');
    const engine = require(path.join(root, 'src', 'websiteEngine.js'));
    const pageSpec = {
      slug: '/',
      title: 'Fixture',
      html:
        '<!doctype html><html><head><style>h3{color:#7a4a21}</style></head><body>' +
        '<h1 id="headline">ZZ104 Fresh Loaves Daily</h1><h3 id="sub">ZZ104 Sub Heading</h3>' +
        '<p>Body copy.</p></body></html>',
    };
    const previewHtml = engine.renderPage(pageSpec, [pageSpec], { primary: '#7a4a21' }, { preview: true, editable: true });
    assert.ok(previewHtml.includes('chat-patch-apply'), 'engine injects the bridge with patch support');
    n += 1;
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><html><body><iframe id="preview" sandbox="allow-scripts allow-forms"></iframe>' +
          '<script>window.events=[];window.addEventListener("message",function(e){' +
          'var f=document.getElementById("preview");if(e.source===f.contentWindow)window.events.push(e.data);});</script></body></html>'
      );
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      await page.goto(base);
      await page.$eval('#preview', (el, html) => {
        el.srcdoc = html;
      }, previewHtml);
      const frameHandle = await page.$('#preview');
      const frame = await frameHandle.contentFrame();
      await frame.waitForFunction(() => !!document.getElementById('headline'), { timeout: 15000 });
      const post = (msg) =>
        page.evaluate((m) => {
          document.getElementById('preview').contentWindow.postMessage(m, '*');
        }, msg);
      const resultFor = (patchId) =>
        page.waitForFunction(
          (id) => window.events.some((e) => e && e.type === 'chat-patch-result' && e.patchId === id),
          { timeout: 10000 },
          patchId
        );
      const drainResults = () => page.evaluate(() => { window.events = window.events.filter((e) => !(e && e.type === 'chat-patch-result')); });

      // Text op: headline swaps instantly, element badged.
      await post({ source: 'ws-portal', type: 'chat-patch-apply', patchId: 'p1', ops: [{ op: 'text', from: 'ZZ104 Fresh Loaves Daily', to: 'ZZ104 Warm Bread' }] });
      await resultFor('p1');
      let snap = await frame.evaluate(() => {
        const h = document.getElementById('headline');
        const marked = document.querySelector('[data-ws-patched]');
        return {
          text: h.textContent,
          // The engine may wrap editable text in an inner span —
          // the treatment mark lands on the deepest exact-match
          // element, which must be the headline or inside it.
          markedInHeadline: !!marked && (marked === h || h.contains(marked)),
          markedText: marked ? marked.textContent : null,
        };
      });
      assert.equal(snap.text, 'ZZ104 Warm Bread'); n += 1;
      assert.equal(snap.markedInHeadline, true); n += 1;
      assert.equal(snap.markedText, 'ZZ104 Warm Bread'); n += 1;
      const p1Result = await page.evaluate(() => window.events.find((e) => e.type === 'chat-patch-result' && e.patchId === 'p1'));
      assert.equal(p1Result.applied, 1); n += 1;
      await drainResults();

      // Style op: H3 computes to the new colour.
      await post({ source: 'ws-portal', type: 'chat-patch-apply', patchId: 'p2', ops: [{ op: 'style', selector: 'h3', property: 'color', value: '#444444' }] });
      await resultFor('p2');
      const color = await frame.evaluate(() => getComputedStyle(document.getElementById('sub')).color);
      assert.equal(color, 'rgb(68, 68, 68)'); n += 1;
      await drainResults();

      // Vars op: theme var set on the root element.
      await post({ source: 'ws-portal', type: 'chat-patch-apply', patchId: 'p3', ops: [{ op: 'vars', vars: { '--ws-primary': '#112233' } }] });
      await resultFor('p3');
      const varVal = await frame.evaluate(() => document.documentElement.style.getPropertyValue('--ws-primary'));
      assert.equal(varVal, '#112233'); n += 1;
      await drainResults();

      // Hostile ops: html op ignored; CSS breakout refused;
      // forged selector refused; a text op carrying markup lands
      // as literal text (textContent), never as elements.
      const scriptsBefore = await frame.evaluate(() => document.querySelectorAll('script').length);
      await post({
        source: 'ws-portal',
        type: 'chat-patch-apply',
        patchId: 'evil',
        ops: [
          { op: 'html', html: '<img id="evilimg" src="x">' },
          { op: 'style', selector: 'h3', property: 'color', value: 'red; } body{display:none' },
          { op: 'style', selector: 'h3{}', property: 'color', value: 'red' },
          { op: 'text', from: 'ZZ104 Warm Bread', to: '<script>alert(1)</script>' },
        ],
      });
      await resultFor('evil');
      const evilResult = await page.evaluate(() => window.events.find((e) => e.type === 'chat-patch-result' && e.patchId === 'evil'));
      assert.equal(evilResult.applied, 1, 'only the text op grounded'); n += 1;
      const evilSnap = await frame.evaluate(() => ({
        evilImg: !!document.getElementById('evilimg'),
        scripts: document.querySelectorAll('script').length,
        headline: document.getElementById('headline').textContent,
        bodyDisplay: getComputedStyle(document.body).display,
        h3Color: getComputedStyle(document.getElementById('sub')).color,
      }));
      assert.equal(evilSnap.evilImg, false); n += 1;
      assert.equal(evilSnap.scripts, scriptsBefore); n += 1;
      assert.equal(evilSnap.headline, '<script>alert(1)</script>'); n += 1;
      assert.equal(evilSnap.bodyDisplay, 'block'); n += 1;
      assert.equal(evilSnap.h3Color, 'rgb(68, 68, 68)', 'earlier good patch untouched by hostile ops'); n += 1;
      await drainResults();

      // Reverts restore the document exactly, newest first.
      await post({ source: 'ws-portal', type: 'chat-patch-revert', patchId: 'evil' });
      await resultFor('evil');
      assert.equal(await frame.evaluate(() => document.getElementById('headline').textContent), 'ZZ104 Warm Bread'); n += 1;
      await drainResults();
      await post({ source: 'ws-portal', type: 'chat-patch-revert', patchId: 'p1' });
      await resultFor('p1');
      assert.equal(await frame.evaluate(() => document.getElementById('headline').textContent), 'ZZ104 Fresh Loaves Daily'); n += 1;
      await drainResults();
      await post({ source: 'ws-portal', type: 'chat-patch-revert', patchId: 'p2' });
      await resultFor('p2');
      assert.equal(await frame.evaluate(() => getComputedStyle(document.getElementById('sub')).color), 'rgb(122, 74, 33)'); n += 1;
      await drainResults();

      // Confirm keeps the change, drops the treatment.
      await post({ source: 'ws-portal', type: 'chat-patch-confirm', patchId: 'p3' });
      await resultFor('p3');
      const confSnap = await frame.evaluate(() => ({
        varVal: document.documentElement.style.getPropertyValue('--ws-primary'),
        fx: !!document.getElementById('ws-chat-patch-fx'),
      }));
      assert.equal(confSnap.varVal, '#112233'); n += 1;
      assert.equal(confSnap.fx, false, 'no patches left applying -> fx style removed'); n += 1;
    } finally {
      await browser.close().catch(() => {});
      server.close();
    }
    group('Part 3 bridge in Chromium', n);
  }

  // ---------------------------------------------------------------
  // Part 4 — client wiring (source-level) + Tier-1 parser units
  // ---------------------------------------------------------------
  {
    let n = 0;
    const portalSrc = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');
    const bridgeSrc = fs.readFileSync(path.join(root, 'public', 'js', 'preview-bridge.js'), 'utf8');
    const portalHtml = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
    const portalServerSrc = require('./lib/monolithSource.cjs').clientPortalSource();

    // Tier-1 parser, unit-run from the real portal.js source.
    const pStart = portalSrc.indexOf('function parseAgentChatTextSwap(');
    const pEnd = portalSrc.indexOf('function postAgentPatchMessage(', pStart);
    assert.ok(pStart > 0 && pEnd > pStart, 'parser found in portal.js');
    const parse = eval(portalSrc.slice(pStart, pEnd) + '; parseAgentChatTextSwap');
    assert.deepEqual(
      parse('Change "The work was never the problem. The routing was." to "Your social media followers are a goldmine"'),
      { from: 'The work was never the problem. The routing was.', to: 'Your social media followers are a goldmine' }
    );
    n += 1;
    assert.deepEqual(parse('change the headline “Fresh loaves daily” to “Warm bread every morning”'), {
      from: 'Fresh loaves daily',
      to: 'Warm bread every morning',
    });
    n += 1;
    assert.deepEqual(parse('Make "Open Saturdays" say "Open Sundays"'), { from: 'Open Saturdays', to: 'Open Sundays' });
    n += 1;
    assert.equal(parse('What does "Open Saturdays" mean?'), null); n += 1;
    assert.equal(parse('Change the headline to something warmer'), null); n += 1;
    assert.equal(parse('change "same" to "same"'), null); n += 1;

    // sendAgentChat: Tier-1 applies BEFORE the api call; the
    // server spec is reconciled after it.
    const sendStart = portalSrc.indexOf('async function sendAgentChat(');
    const sendEnd = portalSrc.indexOf('async function fetchAgentChatUpdates()', sendStart);
    const sendSrc = portalSrc.slice(sendStart, sendEnd);
    const idxParse = sendSrc.indexOf('parseAgentChatTextSwap(text)');
    const idxApi = sendSrc.indexOf("api('/site/agent-chat'");
    assert.ok(idxParse > 0 && idxApi > idxParse, 'Tier-1 parse runs before the chat request'); n += 1;
    assert.ok(sendSrc.includes('data.optimisticPatch'), 'server patch spec reconciled in sendAgentChat'); n += 1;
    assert.ok(sendSrc.includes("sp.state === 'queued'"), 'queued patches tracked by job'); n += 1;
    assert.ok(sendSrc.includes('dropAgentPatch(turnPatchId'), 'turn patch resolved on every outcome'); n += 1;

    // Poller resolution + frame-load reapply + result listener.
    assert.ok(portalSrc.includes('resolveAgentChatPatches(data && data.queue, msgs)'), 'poller resolves patches'); n += 1;
    assert.ok(portalSrc.includes('reapplyAgentChatPatches();'), 'frame load reapplies unverified patches'); n += 1;
    assert.ok(portalSrc.includes("data.type === 'chat-patch-result'"), 'bridge results handled'); n += 1;

    // Treatments exist in portal.html; the skeleton never
    // carries content of its own (CSS only).
    assert.ok(portalHtml.includes('#preview-box.is-patch-applying'), 'applying treatment styled'); n += 1;
    assert.ok(portalHtml.includes('#preview-box.is-patch-skeleton'), 'skeleton treatment styled'); n += 1;

    // No innerHTML sink (property access/assignment) anywhere
    // in the patch code paths — text moves via textContent only.
    const patchBlockStart = portalSrc.indexOf('Batch 104 — OPTIMISTIC PREVIEW');
    const patchBlock = portalSrc.slice(patchBlockStart, sendEnd);
    assert.ok(!/\.\s*innerHTML\b/.test(patchBlock), 'portal patch code uses no innerHTML sink'); n += 1;
    assert.ok(!/\.\s*innerHTML\b/.test(bridgeSrc), 'bridge uses no innerHTML sink'); n += 1;
    assert.ok(!bridgeSrc.includes('insertAdjacentHTML'), 'bridge uses no insertAdjacentHTML'); n += 1;

    // The bridge refuses non-parent senders and unknown ops are
    // skipped, never improvised (no default/html branch).
    assert.ok(bridgeSrc.includes("event.source !== parent"), 'bridge checks the sender is the parent'); n += 1;
    assert.ok(!/op === 'html'|op == 'html'/.test(bridgeSrc), 'bridge has no html op'); n += 1;

    // Server wiring present; public visitor surfaces untouched.
    assert.ok(portalServerSrc.includes("require('./siteChatPatch')"), 'chat handler derives the patch'); n += 1;
    assert.ok(portalServerSrc.includes('optimisticPatch,'), 'payload carries optimisticPatch'); n += 1;
    const chatEmbed = fs.readFileSync(path.join(root, 'public', 'js', 'chat-embed.js'), 'utf8');
    assert.ok(!chatEmbed.includes('chat-patch'), 'visitor chatbot untouched'); n += 1;
    const moduleEmbed = fs.readFileSync(path.join(root, 'public', 'js', 'module-embed.js'), 'utf8');
    assert.ok(!moduleEmbed.includes('chat-patch'), 'module embeds untouched'); n += 1;

    // SEC-13 census: Batch 104 adds NO sink of any class. The
    // batch103 baseline was refreshed DELIBERATELY in this batch:
    // the portal.js insertions shifted 28 pre-existing RAW/IDENT
    // sinks to new line numbers; the census multiset (file, kind,
    // snippet, unsafe exprs) is byte-identical before/after, so
    // only the pinned line numbers moved. These totals pin the
    // "no new sinks" half of that claim.
    const { census } = require(path.join(root, 'scripts', 'xss-census.cjs'));
    const cz = census();
    assert.equal(cz.summary.total, 504, 'SEC-13 census total unchanged by Batch 104 (Batch 156: 450 -> 453; Batch 161: 453 -> 470 — +17 audited Assistant-surface sinks; Batch 168: 503 -> 504, +1 benign STATIC clear, see the batch103 note)'); n += 1;
    assert.equal(cz.summary.ESCAPED + cz.summary.SAFE + cz.summary.STATIC + cz.summary.BUILDER, 380, 'SEC-13 safe classes (Batch 161: 339 -> 351 — the Assistant surfaces, see batch103) (Batch 136 finisher: +2 audited STATIC sinks in module-embed.js — the booking price-summary clear + esc()-wrapped build; 328 -> 330, census 439 -> 441, RAW/IDENT unchanged; Batch 137 finisher: +1 audited SAFE sink in portal.js (qualifying-question rows render — numeric indices + esc()-wrapped question text), census 441 -> 442, SAFE 73 -> 74, reviewed RAW/IDENT content unchanged (12 portal.js positions shifted +127, pure line movement, snippet-verified; Batch 138 finisher: census 442 -> 446 — +3 audited STATIC + 1 IDENT (micSvg(), a constant SVG string) in chat-embed.js for the voice panel, and one portal.js inbox sink reclassified SAFE -> RAW by the conservative classifier after gaining the ${voiceHtml} interpolation (audited: voiceHtml is composed only of esc()-wrapped values, duration arithmetic and fixed close-state words — no visitor-controlled string reaches it unescaped); RAW 76 -> 77, IDENT 35 -> 36, SAFE 74 -> 73, STATIC 158 -> 161, safe classes 331 -> 333; (file,kind,snippet) multiset diff vs the Batch 149 base = exactly these deltas plus pure line movement in portal.js/chat-embed.js; baseline regenerated; Batch 153: census 448 -> 450 — +1 BUILDER +1 RAW in app.js, both the Admin Design-agent editor (rows build — every interpolated value esc()-wrapped; panel shell classified RAW by the conservative classifier, audited: its interpolations are a fixed literal seed note and the numeric limits only, no staff- or visitor-controlled string reaches it unescaped); BUILDER 59 -> 60, RAW 77 -> 78, safe classes 335 -> 336; remaining app.js RAW/IDENT movement is pure line shift from the editor + popup insertions, (file,kind,snippet) multiset diff vs the Batch 139 base = exactly these two sinks; baseline regenerated; Batch 156: census 450 -> 453 — +3 audited safe-class sinks in app.js for the fingerprint surfaces (STATIC ledger page shell — no interpolation; ESCAPED ledger error card; SAFE fingerprint-cell write — hash is server-computed lowercase hex, summary esc()-wrapped), safe classes 336 -> 339; RAW 78 / IDENT 36 and the 114-entry reviewed set byte-identical by (file,kind,snippet) multiset, remaining app.js movement pure line shift; baseline regenerated)'); n += 1;
    assert.equal(cz.summary.RAW + cz.summary.IDENT, 124, 'SEC-13 reviewed set size (Batch 165 finisher added +1 RAW audited Webinar panel-shell sink (RAW 85 -> 86, IDENT 38 unchanged); (Batch 124 added one reviewed RAW sink; Batch 127 finisher added two reviewed variant-editor RAW sinks; Batch 138 finisher added the chat-embed micSvg IDENT + the reclassified portal inbox RAW; Batch 153 added the audited Design-agent editor panel-shell RAW; Batch 161 added +3 RAW +2 IDENT audited Assistant-surface sinks; Batch 162 finisher added +1 RAW audited Contact-page sink (RAW 81 -> 82, IDENT 38 unchanged) — see the census narrative above)'); n += 1;

    group('Part 4 client wiring + parser units', n);
  }

  console.log(`BATCH104 REGRESSION PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH104 REGRESSION FAIL:', (e && e.stack) || e);
  process.exit(1);
});
