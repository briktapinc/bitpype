'use strict';
/**
 * Batch 110 regressions — portal design-chat widget: internal
 * scroll + side collapse (Ely's order 2026-10-31: "Make the text
 * in the design chat window scrollble so it doesn't increase the
 * widgets height also add collapse to the chat widget so the
 * website page can fill the entire width, make the widget
 * collapsible from the side").
 *
 * BEFORE (measured, real Chromium, 40 injected messages):
 *   1440/980 split layout was already capped (chat 648px, list
 *   clientH 387 vs scrollH 3759). At 390 (stacked <=900px) the
 *   media query set .agent-chat { max-height: none } and the
 *   widget EXPLODED: chat 377 -> 4048px, workspace 921 -> 4592px,
 *   the list never scrolled (clientH == scrollH == 3759).
 *
 * THE FIX:
 *   - .agent-chat-messages carries the scroll contract
 *     explicitly (overflow-y: auto + min-height: 0 + overscroll
 *     containment) at every width; the stacked panel is capped
 *     at min(68vh, 620px) so the list scrolls internally there
 *     too. Header/status stay on top, composer pinned bottom.
 *   - appendAgentBubble follow modes: 'force' for the owner's
 *     own send + its reply; 'gentle' (default) for background
 *     poller write-backs — follows only when already near the
 *     bottom; 'none' for the bulk history render (scrolls once
 *     at the end, opening on the newest message).
 *   - Side collapse: the panel sits in .agent-chat-col; a rail
 *     tab button (#agent-chat-side-toggle) straddles its right
 *     edge. .website-workspace.is-chat-collapsed switches the
 *     grid to a 30px rail + 1fr, so the preview fills the width.
 *     ONE state drives the rail tab AND the in-header text
 *     toggle; persisted in localStorage
 *     ('portal.agentChatCollapsed'); default expanded. Stacked
 *     (<=900px) the same state folds the panel vertically —
 *     messages/status/composer hide, header + tab stay.
 *
 * Part 1 — source pins (CSS contract, markup, JS wiring, and
 * the Batch 93/94/104 behaviours this batch must not regress:
 * busy animation, history endpoint use, poller, patch bridge).
 * Part 2 — real Chromium against a stubbed portal API: the
 * real history load (50 messages), real poller write-backs
 * (the 60s interval is clamped to 1.2s by a harness shim),
 * the real send flow, real collapse clicks + persistence.
 *
 * NEGATIVE PROOFS:
 *   B110_NEGATIVE=scroll   -> portal.html served with the
 *     messages rule's overflow-y stripped to visible: the 390
 *     height assertions go RED (widget grows again).
 *   B110_NEGATIVE=collapse -> portal.js served with the Batch
 *     110 collapse wiring block removed: clicking the rail tab
 *     does nothing and the collapse assertions go RED.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const NEGATIVE = process.env.B110_NEGATIVE || '';
const groups = [];
const group = (name, n) => { groups.push(`${name} (${n})`); console.log(`  ok ${name} — ${n} checks`); };
const has = (hay, needle, label) => { assert.ok(hay.includes(needle), `${label} — missing: ${needle.slice(0, 90)}`); };

(async () => {
  // ---------------------------------------------------------------
  // Part 1 — source pins
  // ---------------------------------------------------------------
  {
    let n = 0;
    const html = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
    const js = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');

    // Scroll contract in the messages rule itself.
    const msgRule = html.slice(html.indexOf('.agent-chat-messages {'), html.indexOf('.agent-chat-empty {'));
    has(msgRule, 'overflow-y: auto;', 'messages list scrolls internally'); n += 1;
    has(msgRule, 'min-height: 0;', 'messages list can shrink in the flex column'); n += 1;
    has(msgRule, 'overscroll-behavior: contain;', 'scroll chaining contained'); n += 1;

    // Stacked cap (the <=900px growth bug): panel capped, no max-height:none.
    const mq = html.slice(html.indexOf('@media (max-width: 900px)'), html.indexOf('.logo {'));
    has(mq, 'height: min(68vh, 620px);', 'stacked chat panel height capped'); n += 1;
    assert.ok(!/\.agent-chat \{\s*max-height: none;/.test(mq), 'stacked chat no longer uncapped'); n += 1;

    // Collapse geometry + rail tab.
    has(html, '.website-workspace.is-chat-collapsed {\n      grid-template-columns: 30px minmax(0, 1fr);', 'collapsed grid = 30px rail + full-width preview'); n += 1;
    has(html, '.agent-chat-col {', 'chat column wrapper rule present'); n += 1;
    has(html, 'class="agent-chat-col" id="agent-chat-col"', 'chat column wrapper markup present'); n += 1;
    has(html, 'id="agent-chat-side-toggle"', 'side toggle button present'); n += 1;
    has(html, 'aria-controls="agent-chat"', 'side toggle controls the panel'); n += 1;
    has(html, 'aria-label="Collapse design chat panel"', 'side toggle labelled'); n += 1;
    // Stacked collapse folds vertically.
    has(mq, '.website-workspace.is-chat-collapsed .agent-chat-messages,', 'stacked collapse hides the message list'); n += 1;

    // Busy animation (Batch 93) untouched.
    has(html, '@keyframes agent-chat-busy-pulse', 'busy pulse keyframes intact'); n += 1;
    has(html, '.agent-chat-status.is-busy::before', 'busy dot intact'); n += 1;

    // JS: collapse state, one driver for both toggles, persistence.
    has(js, "localStorage.setItem('portal.agentChatCollapsed'", 'collapse state persisted'); n += 1;
    has(js, "localStorage.getItem('portal.agentChatCollapsed') === '1'", 'collapse state restored on wire-up'); n += 1;
    has(js, "workspace.classList.toggle('is-chat-collapsed', collapsed)", 'workspace class driven by the one state'); n += 1;
    has(js, "sideToggle.setAttribute('aria-expanded'", 'rail tab aria-expanded synced'); n += 1;
    has(js, '// Batch 110 collapse wiring — start', 'collapse wiring block present (negative-proof anchor)'); n += 1;

    // JS: follow modes — force on the owner's send path, gentle
    // default for the poller, none for the bulk history render.
    has(js, 'const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 96;', 'near-bottom measured before append'); n += 1;
    has(js, "appendAgentBubble('user', text, pending, 'force');", 'own send forces follow'); n += 1;
    has(js, "appendAgentBubble('assistant', reply, null, 'force');", 'direct reply forces follow'); n += 1;
    has(js, "appendAgentBubble(m.role === 'user' ? 'user' : 'assistant', m.content, null, 'none');", 'history render does not scroll per bubble'); n += 1;
    has(js, 'snapToBottom', 'history snap-to-bottom helper present'); n += 1;
    has(js, 'IntersectionObserver', 'history snap repeats when the hidden-at-boot list becomes visible'); n += 1;
    const poller = js.slice(js.indexOf('async function fetchAgentChatUpdates()'), js.indexOf('function wireAgentChat()'));
    has(poller, "appendAgentBubble('assistant', m.content);", 'poller write-backs use the gentle default'); n += 1;

    // Batch 94 history + Batch 104 bridge entry points intact.
    has(js, "api('/site/agent-chat/history')", 'history endpoint still loaded'); n += 1;
    has(js, "api('/site/agent-chat/updates')", 'updates poller still fetches'); n += 1;
    has(js, "data.type === 'chat-patch-result'", 'optimistic-preview bridge listener intact'); n += 1;

    // No innerHTML sink introduced by this batch's JS block.
    const b110 = js.slice(js.indexOf('// Batch 110 collapse wiring — start'), js.indexOf('// Batch 110 collapse wiring — end'));
    assert.ok(!/\.innerHTML\b/.test(b110), 'collapse wiring uses no innerHTML sink'); n += 1;

    group('Part 1 source pins', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — real Chromium, stubbed portal API
  // ---------------------------------------------------------------
  const puppeteer = require('puppeteer');
  const http = require('node:http');
  const express = require('express');

  const HISTORY = Array.from({ length: 50 }, (_, i) => ({
    id: 1000 + i,
    role: i % 2 ? 'assistant' : 'user',
    content: `Saved message ${i + 1} about the site design, colours, headings and layout.`,
  }));
  let armedUpdates = [];
  const app = express();
  app.use(express.json());
  app.get('/api/v1/captcha/config', (_q, r) => r.json({ ok: true, data: { enabled: false } }));
  app.get('/api/v1/portal/me', (_q, r) =>
    r.json({
      ok: true,
      data: {
        client: { id: 1, email: 'owner@b110.fixture', businessName: 'ZZ B110 Bakery' },
        lead: { business_name: 'ZZ B110 Bakery', city: 'Blandon', state: 'PA' },
        site: { id: 1, name: 'ZZ B110 Bakery' },
        previewUrl: null,
      },
    })
  );
  app.get('/api/v1/portal/site/agent-chat/history', (_q, r) =>
    r.json({ ok: true, data: { messages: HISTORY, chatUsage: null, queue: null, summary: null } })
  );
  app.get('/api/v1/portal/site/agent-chat/updates', (_q, r) => {
    const msgs = armedUpdates;
    armedUpdates = [];
    r.json({ ok: true, data: { messages: msgs, queue: null } });
  });
  app.post('/api/v1/portal/site/agent-chat', (_q, r) =>
    r.json({ ok: true, data: { reply: 'Done — I made that change.', mutated: false } })
  );
  app.use('/api/v1/portal', (_q, r) =>
    r.json({ ok: true, data: { plan: 'standard', plans: [], forms: [], modules: [], contacts: [], accounts: [], previewUrl: null } })
  );
  app.get('/portal', (_q, r) => {
    if (NEGATIVE === 'scroll') {
      let src = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
      src = src.split('overflow-y: auto;\n      overscroll-behavior: contain;').join('overflow-y: visible;\n      overscroll-behavior: contain;');
      r.type('html').send(src);
      return;
    }
    r.sendFile(path.join(root, 'public', 'portal.html'));
  });
  app.use((req, res, next) => {
    if (req.path === '/js/portal.js' && NEGATIVE === 'collapse') {
      let src = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');
      const a = src.indexOf('    // Batch 110 collapse wiring — start');
      const b = src.indexOf('    // Batch 110 collapse wiring — end', a);
      assert.ok(a > 0 && b > a, 'negative hook anchors found');
      src = src.slice(0, a) + src.slice(b);
      res.type('application/javascript').send(src);
      return;
    }
    next();
  });
  app.use(express.static(path.join(root, 'public'), { index: false }));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  let n = 0;
  const near = (a, b, tol, label) => { assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} != ${b} (±${tol})`); n += 1; };
  const eq = (a, b, label) => { assert.equal(a, b, `${label}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); n += 1; };
  const ok = (cond, label) => { assert.ok(cond, label); n += 1; };

  const geom = (page) =>
    page.evaluate(() => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
      const ws = document.getElementById('website-workspace');
      const chat = document.getElementById('agent-chat');
      const list = document.getElementById('agent-chat-messages');
      const col = document.querySelector('.website-preview-col');
      return {
        ws: R(ws), chat: R(chat), col: R(col),
        chatDisplay: getComputedStyle(chat).display,
        listDisplay: getComputedStyle(list).display,
        listClientH: list.clientHeight,
        listScrollH: list.scrollHeight,
        listScrollTop: list.scrollTop,
        bubbles: list.querySelectorAll('.agent-bubble').length,
        collapsed: ws.classList.contains('is-chat-collapsed'),
        docScrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
      };
    });
  const atBottom = (g) => g.listScrollTop + g.listClientH >= g.listScrollH - 2;

  try {
    for (const w of [1440, 980, 390]) {
      const page = await browser.newPage();
      // Harness shim: the updates poller's 60s interval ticks at
      // 1.2s so write-backs can be observed without a minute wait.
      await page.evaluateOnNewDocument(() => {
        const si = window.setInterval;
        window.setInterval = (fn, ms, ...a) => si(fn, ms === 60000 ? 1200 : ms, ...a);
      });
      await page.setViewport({ width: w, height: 900 });
      await page.goto(base + '/portal#/website', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
      await page.waitForSelector('#sec-preview:not([hidden])', { timeout: 15000 });
      await page.waitForFunction(() => document.querySelectorAll('#agent-chat-messages .agent-bubble').length === 50, { timeout: 15000 });

      // Batch 145 (U2 harness fix — test only, no product change):
      // the geometry read below used to race a cold-cache webfont
      // swap (portal.html loads Figtree/Fraunces from Google Fonts):
      // the swap grows scrollHeight after the widget's synchronous
      // snap, and the single immediate read with a 2px tolerance
      // flaked. Await document.fonts.ready, then wait for the
      // scroll geometry to settle (two identical consecutive
      // scrollHeight reads), before measuring.
      await page.evaluate(async () => {
        if (document.fonts && document.fonts.ready) {
          try { await document.fonts.ready; } catch { /* */ }
        }
      });
      await page.waitForFunction(() => {
        const list = document.getElementById('agent-chat-messages');
        if (!list) return false;
        const h = list.scrollHeight;
        if (window.__b145SettleH === h) return true;
        window.__b145SettleH = h;
        return false;
      }, { timeout: 10000, polling: 150 });

      // — History: 50 saved messages render into the scroll
      // region and the thread opens on the newest message.
      let g = await geom(page);
      eq(g.bubbles, 50, `history renders 50 messages @${w}`);
      ok(atBottom(g), `history opens scrolled to the newest message @${w}`);
      ok(g.listScrollH > g.listClientH, `message list overflows its fixed region (internal scroll) @${w}`);
      const H = g.chat.h;
      const colW = g.col.w;
      const wsW = g.ws.w;

      // — Poller write-backs while at the bottom: followed,
      // and the widget height does not move.
      armedUpdates = [1, 2, 3].map((i) => ({ id: 2000 + i, role: 'assistant', content: `Design job finished — write-back ${i}.` }));
      await page.waitForFunction(() => document.querySelectorAll('#agent-chat-messages .agent-bubble').length === 53, { timeout: 15000 });
      g = await geom(page);
      near(g.chat.h, H, 1, `widget height unchanged after poller write-backs @${w}`);
      ok(atBottom(g), `write-backs followed while at the bottom @${w}`);

      // — Gentle scroll: scrolled up reading history, a
      // background write-back must NOT yank the view down.
      await page.$eval('#agent-chat-messages', (el) => { el.scrollTop = 0; });
      armedUpdates = [4, 5].map((i) => ({ id: 2000 + i, role: 'assistant', content: `Another write-back ${i}.` }));
      await page.waitForFunction(() => document.querySelectorAll('#agent-chat-messages .agent-bubble').length === 55, { timeout: 15000 });
      g = await geom(page);
      ok(g.listScrollTop <= 2, `no yank when a write-back lands while reading history @${w} (scrollTop ${g.listScrollTop})`);
      near(g.chat.h, H, 1, `widget height still fixed @${w}`);

      // — Own send: user bubble + reply always land at the bottom.
      await page.type('#agent-chat-input', 'Make the headline shorter');
      await page.click('#agent-chat-send');
      await page.waitForFunction(() => document.querySelectorAll('#agent-chat-messages .agent-bubble').length === 57, { timeout: 15000 });
      g = await geom(page);
      ok(atBottom(g), `own send lands on the newest message @${w}`);
      near(g.chat.h, H, 1, `widget height unchanged after send @${w}`);

      if (w > 900) {
        // — Side collapse: preview takes the full width minus
        // the 30px rail and the 16px grid gap.
        await page.click('#agent-chat-side-toggle');
        await page.waitForFunction(() => document.getElementById('website-workspace').classList.contains('is-chat-collapsed'), { timeout: 5000 });
        // The grid columns transition (0.22s) — wait for the
        // geometry to settle before measuring.
        await page.waitForFunction(
          (target) => Math.abs(document.querySelector('.website-preview-col').getBoundingClientRect().width - target) <= 2,
          { timeout: 5000 },
          wsW - 30 - 16
        );
        g = await geom(page);
        eq(g.chatDisplay, 'none', `collapsed panel leaves the flow @${w}`);
        near(g.col.w, wsW - 30 - 16, 2, `collapsed preview fills the width @${w} (col ${g.col.w} of ws ${wsW})`);
        eq(await page.$eval('#agent-chat-side-toggle', (el) => el.getAttribute('aria-expanded')), 'false', `rail tab aria-expanded=false @${w}`);
        eq(await page.evaluate(() => localStorage.getItem('portal.agentChatCollapsed')), '1', `collapse persisted @${w}`);
        const hit = await page.evaluate(() => {
          const b = document.getElementById('agent-chat-side-toggle').getBoundingClientRect();
          const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          return !!(el && (el.id === 'agent-chat-side-toggle' || el.closest('#agent-chat-side-toggle')));
        });
        eq(hit, true, `rail tab is the hit target at its centre @${w}`);
        ok(g.docScrollW <= g.innerW + 1, `no horizontal overflow while collapsed @${w}`);

        // — Persistence across reload: starts collapsed.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
        await page.waitForFunction(() => document.getElementById('website-workspace').classList.contains('is-chat-collapsed'), { timeout: 10000 });
        ok(true, `collapse survives reload @${w}`);

        // — Expand back: prior split restored.
        await page.click('#agent-chat-side-toggle');
        await page.waitForFunction(() => !document.getElementById('website-workspace').classList.contains('is-chat-collapsed'), { timeout: 5000 });
        await page.waitForFunction(
          (target) => Math.abs(document.querySelector('.website-preview-col').getBoundingClientRect().width - target) <= 2,
          { timeout: 5000 },
          colW
        );
        g = await geom(page);
        near(g.col.w, colW, 2, `expanded preview back to its split width @${w}`);
        eq(await page.evaluate(() => localStorage.getItem('portal.agentChatCollapsed')), '0', `expand persisted @${w}`);
      } else {
        // — Stacked collapse: same state folds vertically —
        // header stays, the message region hides, height drops.
        await page.click('#agent-chat-side-toggle');
        await page.waitForFunction(() => document.getElementById('website-workspace').classList.contains('is-chat-collapsed'), { timeout: 5000 });
        g = await geom(page);
        eq(g.listDisplay, 'none', `stacked collapse hides the message list @390`);
        ok(g.chat.h < H && g.chat.h <= 160, `stacked collapsed panel is header-only @390 (h ${g.chat.h} vs ${H})`);
        ok(g.docScrollW <= g.innerW + 1, `no horizontal overflow while stacked-collapsed @390`);
        await page.click('#agent-chat-side-toggle');
        await page.waitForFunction(() => !document.getElementById('website-workspace').classList.contains('is-chat-collapsed'), { timeout: 5000 });
        g = await geom(page);
        near(g.chat.h, H, 1, `stacked expand restores the capped panel height @390`);
        eq(g.listDisplay, 'flex', `stacked expand restores the message list @390`);
      }
      ok(g.docScrollW <= g.innerW + 1, `no horizontal overflow @${w}`);
      await page.close();
    }
    group('Part 2 browser measurements (1440/980/390)', n);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`BATCH110 REGRESSION PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH110 REGRESSION FAIL', e);
  process.exit(1);
});
