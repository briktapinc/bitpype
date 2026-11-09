'use strict';
/**
 * Batch 170 — Assistant page: usage/cost display moves to its own tab.
 *
 * Ely's order (2026-11-09): the one-line usage display above the
 * Assistant chat moves into a dedicated "Usage & costs" pane tab on
 * the same page (he chose the move over a new calculator tab). Portal
 * only — the GET /assistant/usage endpoint and its payload are
 * unchanged; the tab renders what the endpoint already returned
 * (headline + byConversation + byUser), which the old line dropped.
 *
 * Part 1 — portal.html source pins: pane tabs (Chat | Usage & costs)
 *   in sec-assistant on the shared portal-pane-tabs pattern; the chat
 *   pane wraps the chat layout AND the Batch 169 Themes block; the
 *   usage pane exists (hidden) with headline + body containers; the
 *   old #assistant-usage-line is GONE; the lede points at the tab.
 * Part 2 — portal.js source pins: setAssistantPane / renderAssistant
 *   Usage / refreshAssistantUsage wiring; tab click wiring mirrors
 *   the Forms pane wiring; opening the Usage tab re-fetches; no
 *   reference to the removed line id anywhere.
 * Part 3 — behavior (vm + DOM stub): the REAL functions extracted
 *   from portal.js render a fixture /assistant/usage payload —
 *   exact headline wording (with and without rollup), per-conversation
 *   rows (untitled shown neutrally), per-user rows (surface label,
 *   token sum, raw + billed), the empty state, a markup-bearing
 *   conversation title rendered as TEXT (no innerHTML anywhere),
 *   pane switching toggles hidden + aria-selected, and a failed
 *   fetch stays silent like the old line.
 * Part 4 — census/pins: SEC-13 totals unchanged (503 / 379 safe /
 *   RAW 86 / IDENT 38 — the new DOM is createElement + textContent
 *   only, zero new sinks of any class); the portal.js (kind,snippet)
 *   sink multiset is unchanged; the ONE baseline entry below the
 *   edit (portal.js:14394, the assistantMd IDENT sink) moved to
 *   :14498 by pure line shift — snippet byte-identical, refreshed
 *   deliberately. Server tree untouched by this batch (route +
 *   usageSummary source pins; git diff on server/ + src/ empty).
 */
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const results = [];
function group(name, count) {
  results.push(`${name}: ${count} checks`);
  console.log(`ok — ${name} (${count})`);
}

// ---------------------------------------------------------------------
// minimal DOM stub — records innerHTML use so the escape-first
// discipline is asserted, not assumed.
let innerHTMLUsed = false;
function stubEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    className: '',
    textContent: '',
    hidden: false,
    attrs: {},
    classes: new Set(),
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...kids) {
      this.children = kids.slice();
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
  };
  el.classList = {
    toggle(cls, on) {
      if (on) el.classes.add(cls);
      else el.classes.delete(cls);
    },
    contains(cls) {
      return el.classes.has(cls);
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return '';
    },
    set() {
      innerHTMLUsed = true;
    },
  });
  return el;
}

function makeDocument() {
  const byId = new Map();
  return {
    byId,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, stubEl('div'));
      return byId.get(id);
    },
    createElement(tag) {
      return stubEl(tag);
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

async function main() {
  const html = read('public/portal.html');
  const js = read('public/js/portal.js');

  // ---------- Part 1: portal.html source pins ----------
  {
    let n = 0;
    const secStart = html.indexOf('id="sec-assistant"');
    assert.ok(secStart > 0, 'sec-assistant exists');
    const sec = html.slice(secStart, html.indexOf('id="sec-preview"', secStart));

    assert.ok(!sec.includes('assistant-usage-line'), 'usage line removed from sec-assistant');
    assert.ok(!html.includes('assistant-usage-line'), 'usage line id gone from portal.html');
    n += 2;

    assert.ok(sec.includes('id="assistant-pane-tabs"'), 'assistant pane tab strip present');
    assert.ok(sec.includes('class="portal-pane-tabs"'), 'tab strip reuses portal-pane-tabs pattern');
    assert.ok(/data-assistant-pane="chat"[^>]*>Chat</.test(sec), 'Chat tab button');
    assert.ok(/data-assistant-pane="usage"[^>]*>Usage &amp; costs</.test(sec), 'Usage & costs tab button');
    assert.ok(sec.includes('aria-label="Assistant sections"'), 'tab strip labelled');
    n += 5;

    const iTabs = sec.indexOf('id="assistant-pane-tabs"');
    const iPaneChat = sec.indexOf('id="assistant-pane-chat"');
    const iLayout = sec.indexOf('class="assistant-layout"');
    const iThemes = sec.indexOf('id="themes-block"');
    const iPaneUsage = sec.indexOf('id="assistant-pane-usage"');
    const iWizard = sec.indexOf('id="theme-wizard-backdrop"');
    assert.ok(iTabs > 0 && iPaneChat > iTabs, 'chat pane follows the tab strip');
    assert.ok(iLayout > iPaneChat, 'chat layout inside the chat pane');
    assert.ok(iThemes > iPaneChat, 'Batch 169 Themes block stays inside the chat pane');
    assert.ok(iPaneUsage > iThemes, 'usage pane after the chat pane content');
    assert.ok(iWizard > iPaneUsage, 'wizard modal stays at section level, after the panes');
    n += 5;

    const usagePane = sec.slice(iPaneUsage, iWizard);
    assert.ok(/id="assistant-pane-usage" hidden>/.test(usagePane), 'usage pane starts hidden');
    assert.ok(usagePane.includes('id="assistant-usage-headline"'), 'headline container in usage pane');
    assert.ok(usagePane.includes('id="assistant-usage-body"'), 'body container in usage pane');
    n += 3;

    assert.ok(sec.includes('see the Usage &amp; costs tab'), 'lede points at the Usage & costs tab');
    assert.ok(!sec.includes('usage line below'), 'old lede reference to the line is gone');
    n += 2;
    group('Part 1 — portal.html tabs + moved display markup', n);
  }

  // ---------- Part 2: portal.js source pins ----------
  {
    let n = 0;
    assert.ok(!js.includes('assistant-usage-line'), 'no JS reference to the removed line id');
    assert.ok(js.includes('function setAssistantPane(pane)'), 'setAssistantPane defined');
    assert.ok(js.includes('function renderAssistantUsage(u)'), 'renderAssistantUsage defined');
    assert.ok(js.includes("await api('/assistant/usage')"), 'usage fetch unchanged');
    assert.ok(js.includes('if (u) renderAssistantUsage(u);'), 'refresh renders the payload');
    n += 5;

    const setter = js.slice(js.indexOf('function setAssistantPane(pane)'), js.indexOf('function usageMoney'));
    assert.ok(setter.includes("document.getElementById('assistant-pane-chat')"), 'setter toggles chat pane');
    assert.ok(setter.includes("document.getElementById('assistant-pane-usage')"), 'setter toggles usage pane');
    assert.ok(setter.includes("querySelectorAll('[data-assistant-pane]')"), 'setter syncs tab buttons');
    assert.ok(setter.includes("if (assistantPane === 'usage') refreshAssistantUsage();"), 'opening the Usage tab re-fetches');
    n += 4;

    const wire = js.slice(js.indexOf('const assistantPaneTabs'), js.indexOf('setAssistantPane(\'chat\');', js.indexOf('const assistantPaneTabs')) + 30);
    assert.ok(wire.includes("closest('[data-assistant-pane]')"), 'tab click wiring mirrors the Forms pane wiring');
    assert.ok(wire.includes('setAssistantPane(btn.getAttribute(\'data-assistant-pane\'))'), 'click switches panes');
    n += 2;

    const render = js.slice(js.indexOf('function renderAssistantUsage(u)'), js.indexOf('async function refreshAssistantUsage()'));
    assert.ok(render.includes('AI assistant usage this month: $'), 'headline keeps the old line wording');
    assert.ok(render.includes('billed separately from your plan on your next invoice'), 'headline billing wording kept');
    assert.ok(render.includes("'Untitled conversation'"), 'untitled conversations shown neutrally');
    assert.ok(render.includes("'No assistant usage yet this month.'"), 'empty state copy present');
    assert.ok(render.includes("'By conversation'") && render.includes("'By user'"), 'both breakdown groups render');
    assert.ok(!render.includes('innerHTML'), 'renderer uses no innerHTML');
    n += 6;
    group('Part 2 — portal.js pane + renderer source pins', n);
  }

  // ---------- Part 3: behavior in a vm with a DOM stub ----------
  {
    let n = 0;
    const start = js.indexOf("let assistantPane = 'chat';");
    const end = js.indexOf('async function loadAssistant()');
    assert.ok(start > 0 && end > start, 'usage block extractable from portal.js');
    const block = js.slice(start, end);
    n += 1;

    const FIXTURE = {
      month: '2026-11',
      portal: { billedUsd: 12.34 },
      admin: { billedUsd: 0 },
      rollup: { month: '2026-11', rawUsd: 10.0, billedUsd: 12.34, status: 'queued', stripeInvoiceItemId: null, note: null },
      byConversation: [
        { conversationId: 5, calls: 3, rawUsd: 1.5, billedUsd: 2.25, title: 'Homepage redesign' },
        { conversationId: 6, calls: 1, rawUsd: 0.5, billedUsd: 0.75, title: '<script>alert(1)</script>' },
        { conversationId: 7, calls: 2, rawUsd: 0.25, billedUsd: 0.5, title: null },
      ],
      byUser: [
        { surface: 'portal', actorId: 7, calls: 6, promptTokens: 1000, completionTokens: 500, rawUsd: 2.25, billedUsd: 3.5, internal: false },
        { surface: 'admin', actorId: null, calls: 1, promptTokens: 10, completionTokens: 5, rawUsd: 0.1, billedUsd: 0.2, internal: true },
      ],
    };
    const EMPTY = { month: '2026-11', portal: { billedUsd: 0 }, admin: { billedUsd: 0 }, rollup: null, byUser: [], byConversation: [] };

    let payload = FIXTURE;
    let failFetch = false;
    const apiCalls = [];
    const documentStub = makeDocument();
    const ctx = {
      document: documentStub,
      api: async (url) => {
        apiCalls.push(url);
        if (failFetch) throw new Error('fixture outage');
        return payload;
      },
    };
    vm.createContext(ctx);
    vm.runInContext(block, ctx);
    assert.equal(typeof ctx.renderAssistantUsage, 'function', 'renderer loaded');
    assert.equal(typeof ctx.setAssistantPane, 'function', 'pane setter loaded');
    assert.equal(typeof ctx.refreshAssistantUsage, 'function', 'refresh loaded');
    n += 3;

    await ctx.refreshAssistantUsage();
    assert.deepEqual(apiCalls, ['/assistant/usage'], 'refresh hits the usage endpoint once');
    const headline = documentStub.byId.get('assistant-usage-headline');
    const body = documentStub.byId.get('assistant-usage-body');
    assert.ok(headline && body, 'usage containers resolved');
    assert.equal(
      headline.textContent,
      'AI assistant usage this month: $12.34 — billed separately from your plan on your next invoice · status: queued.',
      'headline wording identical to the old line, with rollup status'
    );
    n += 3;

    assert.equal(body.children.length, 2, 'two breakdown groups render');
    const [convGroup, userGroup] = body.children;
    assert.equal(convGroup.className, 'assistant-usage-group');
    assert.equal(convGroup.children[0].textContent, 'By conversation');
    const convRows = convGroup.children[1].children;
    assert.equal(convRows.length, 3, 'one row per conversation');
    const rowText = (row) => row.children.map((c) => c.textContent);
    assert.deepEqual(rowText(convRows[0]), ['Homepage redesign', '3 calls', 'raw $1.50', 'billed $2.25'], 'conversation row: title, calls, raw, billed');
    assert.deepEqual(rowText(convRows[1]), ['<script>alert(1)</script>', '1 calls', 'raw $0.50', 'billed $0.75'], 'markup-bearing title carried as plain text');
    assert.deepEqual(rowText(convRows[2]), ['Untitled conversation', '2 calls', 'raw $0.25', 'billed $0.50'], 'untitled conversation shown neutrally');
    assert.equal(userGroup.children[0].textContent, 'By user');
    const userRows = userGroup.children[1].children;
    assert.equal(userRows.length, 2, 'one row per byUser entry');
    assert.deepEqual(rowText(userRows[0]), ['Portal · user 7', '6 calls', '1500 tokens', 'raw $2.25', 'billed $3.50'], 'user row: surface label, calls, token sum, raw, billed');
    assert.deepEqual(rowText(userRows[1]), ['Admin', '1 calls', '15 tokens', 'raw $0.10', 'billed $0.20'], 'actor-less row labelled by surface only');
    assert.equal(innerHTMLUsed, false, 'no innerHTML used anywhere in the render path');
    n += 11;

    // empty state
    payload = EMPTY;
    await ctx.refreshAssistantUsage();
    assert.equal(
      headline.textContent,
      'AI assistant usage this month: $0.00 — billed separately from your plan on your next invoice.',
      'headline without rollup has no status suffix'
    );
    assert.equal(body.children.length, 1, 'empty payload renders a single empty-state node');
    assert.equal(body.children[0].className, 'assistant-usage-empty');
    assert.equal(body.children[0].textContent, 'No assistant usage yet this month.');
    n += 4;

    // pane switching
    const chatPane = documentStub.getElementById('assistant-pane-chat');
    const usagePane = documentStub.getElementById('assistant-pane-usage');
    const tabsEl = documentStub.getElementById('assistant-pane-tabs');
    const btnChat = stubEl('button');
    btnChat.setAttribute('data-assistant-pane', 'chat');
    const btnUsage = stubEl('button');
    btnUsage.setAttribute('data-assistant-pane', 'usage');
    tabsEl.querySelectorAll = (sel) => (sel === '[data-assistant-pane]' ? [btnChat, btnUsage] : []);
    payload = FIXTURE;
    apiCalls.length = 0;
    ctx.setAssistantPane('usage');
    assert.equal(chatPane.hidden, true, 'chat pane hides on Usage tab');
    assert.equal(usagePane.hidden, false, 'usage pane shows on Usage tab');
    assert.equal(btnUsage.getAttribute('aria-selected'), 'true');
    assert.equal(btnChat.getAttribute('aria-selected'), 'false');
    assert.ok(btnUsage.classList.contains('is-active') && !btnChat.classList.contains('is-active'), 'active class follows the pane');
    await tick();
    assert.deepEqual(apiCalls, ['/assistant/usage'], 'opening the Usage tab re-fetches the payload');
    ctx.setAssistantPane('chat');
    assert.equal(chatPane.hidden, false, 'chat pane back on Chat tab');
    assert.equal(usagePane.hidden, true, 'usage pane hides on Chat tab');
    n += 8;

    // fetch failure stays silent (the old line behaved the same)
    failFetch = true;
    const before = headline.textContent;
    await ctx.refreshAssistantUsage();
    assert.equal(headline.textContent, before, 'failed fetch leaves the display untouched and does not throw');
    n += 1;
    group('Part 3 — fixture render + pane behavior (vm)', n);
  }

  // ---------- Part 4: census pins + server untouched ----------
  {
    let n = 0;
    const { census } = require(path.join(root, 'scripts/xss-census.cjs'));
    const cz = census();
    assert.equal(cz.summary.total, 503, 'SEC-13 census total unchanged by Batch 170 (zero new sinks)');
    assert.equal(cz.summary.ESCAPED + cz.summary.SAFE + cz.summary.STATIC + cz.summary.BUILDER, 379, 'SEC-13 safe classes unchanged');
    assert.equal(cz.summary.RAW, 86, 'SEC-13 RAW unchanged');
    assert.equal(cz.summary.IDENT, 38, 'SEC-13 IDENT unchanged');
    n += 4;

    const baseline = JSON.parse(read('tests/batch103-xss-baseline.json'));
    assert.ok(baseline.includes('public/js/portal.js:14498'), 'baseline carries the shifted assistantMd sink at its new line');
    assert.ok(!baseline.includes('public/js/portal.js:14394'), 'stale pre-shift baseline entry removed');
    const reviewed = new Set(cz.sinks.filter((s) => s.kind === 'RAW' || s.kind === 'IDENT').map((s) => `${s.file}:${s.line}`));
    const baseSet = new Set(baseline);
    assert.deepEqual([...reviewed].filter((x) => !baseSet.has(x)), [], 'no unreviewed RAW/IDENT sink lines');
    assert.deepEqual([...baseSet].filter((x) => !reviewed.has(x)), [], 'no stale baseline entries');
    n += 4;

    const routes = read('server/routes/portal.js');
    assert.ok(routes.includes("router.get('/assistant/usage', requireClient"), 'usage route untouched');
    const ac = read('server/assistantChat.js');
    assert.ok(ac.includes('function usageSummary(db, { month, actorId = null })'), 'usageSummary untouched');
    n += 2;

    let serverDiff = null;
    try {
      serverDiff = execFileSync('git', ['-C', root, 'diff', '--name-only', 'HEAD', '--', 'server', 'src'], { encoding: 'utf8' }).trim();
    } catch {
      serverDiff = null; // git unavailable in this environment — the source pins above carry the check
    }
    if (serverDiff !== null) assert.equal(serverDiff, '', 'no server/ or src/ changes in this batch');
    n += 1;
    group('Part 4 — census pins, baseline shift, server untouched', n);
  }

  console.log(`\nbatch170 assistant usage tab: ALL PASS\n${results.map((r) => '  - ' + r).join('\n')}`);
}

main().catch((e) => {
  console.error('batch170 FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
