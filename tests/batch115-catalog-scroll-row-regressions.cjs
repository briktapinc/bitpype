'use strict';
/**
 * Batch 115 — MODULES CATALOG → SINGLE HORIZONTALLY-SCROLLABLE ROW.
 *
 * Ely's order 2026-11-01 21:36 EST, from his screenshot of the
 * staff Modules page: the Catalog's 22 module cards (Blog … Charts)
 * wrapped into a 4-row grid (6 across on the wide view, measured
 * 171px cards, Batch 91). His words: "make this one row, scrollable
 * horizontally" — unconditional, every viewport width.
 *
 * What changed (styles.css + one attribute line in app.js):
 *   .modcat-grid is now a flex row: flex-wrap nowrap, overflow-x
 *   auto (native scroll — momentum on touch, wheel/trackpad,
 *   keyboard via tabindex=0 on the row), gap 16px (the Batch 108
 *   card standard), a thin themed scrollbar (affordance kept), and
 *   bottom padding so the scrollbar and card shadows are not
 *   clipped. .modcat-card is flex: 0 0 171px — the exact width the
 *   cards rendered at 1440 in the old 6-across grid (measured on
 *   production pre-change), never shrinking or stretching; flex
 *   stretch keeps heights equal. The three grid step-down media
 *   queries are deleted. Cards stay display-only (Batch 91: the
 *   catalog never had a click action); content, icons and the
 *   "N installed" meta are byte-identical.
 *
 * Census (reported in the batch report): the SAME 22-module
 * catalog renders on two other surfaces with their own components
 * — the portal module picker (.module-card buttons in a grouped
 * grid; they are tabs driving the settings pane, meta = content
 * counts) and the portal structure block picker (.picker-card,
 * 2-up in a modal). Neither is the Catalog grid from the
 * screenshot; both are deliberately UNCHANGED here and flagged
 * for Ely's call rather than silently diverged.
 *
 * Part 1 — source pins + SEC-13 census (must stay byte-identical:
 *   the app.js edit adds only HTML attributes inside an existing
 *   template; no new sinks).
 * Part 2 — real Chromium, stub API, staff app at 1440/980/390:
 *   exactly one row (shared top, equal heights), uniform 171px
 *   widths, uniform 16px gaps, scrollWidth > clientWidth, the
 *   last card (Checkout) fully reachable at max scroll, the first
 *   card fully visible at rest, keyboard scrolling works, no
 *   page-level horizontal overflow, the installs table below the
 *   catalog still renders, zero page errors.
 *
 * NEGATIVE PROOF: B115_NEGATIVE=css serves styles.css with the
 * row's nowrap/overflow reverted to wrapping -> Part 2 goes RED.
 * B115_SKIP_BROWSER=1 skips Part 2 locally; the gate runs it.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const NEGATIVE = process.env.B115_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

(async () => {
  const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const portalHtml = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
  const portalJs = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');

  // ---------------------------------------------------------------
  // Part 1 — source pins + SEC-13 census
  // ---------------------------------------------------------------
  {
    let n = 0;
    const has = (src, s, label) => {
      assert.ok(src.includes(s), label);
      n += 1;
    };

    // The row contract in CSS.
    const blockStart = stylesCss.indexOf('Batch 115 (Ely');
    assert.ok(blockStart > 0, 'Batch 115 CSS comment block present');
    n += 1;
    const m = stylesCss.match(/\.modcat-grid \{([^}]*)\}/);
    assert.ok(m, 'modcat-grid rule exists');
    n += 1;
    for (const [frag, label] of [
      ['display: flex', 'catalog is a flex row'],
      ['flex-wrap: nowrap', 'row never wraps'],
      ['overflow-x: auto', 'row scrolls horizontally (native)'],
      ['overflow-y: hidden', 'no vertical scroll surprises'],
      ['gap: 16px', 'uniform 16px gap (Batch 108 standard)'],
      ['scrollbar-width: thin', 'thin scrollbar (Firefox)'],
    ]) {
      assert.ok(m[1].includes(frag), label);
      n += 1;
    }
    has(stylesCss, '.modcat-grid::-webkit-scrollbar', 'webkit scrollbar styled, not hidden');
    has(stylesCss, '.modcat-grid:focus-visible', 'keyboard focus on the row is visible');
    assert.ok(
      !/\.modcat-grid\s*\{[^}]*grid-template-columns/.test(stylesCss),
      'no modcat grid columns remain at any breakpoint'
    );
    n += 1;
    const card = stylesCss.match(/\.modcat-card \{([^}]*)\}/);
    assert.ok(card && card[1].includes('flex: 0 0 171px'), 'cards uniform fixed width 171px, no shrink/stretch');
    n += 1;

    // Markup: the row is keyboard-focusable; card markup unchanged.
    const fn = appJs.slice(appJs.indexOf('async function pageModules()'));
    const body = fn.slice(0, fn.indexOf('\nasync function ') > 0 ? fn.indexOf('\nasync function ') : fn.length);
    has(
      body,
      'class="modcat-grid" tabindex="0" role="region" aria-label="Module catalog"',
      'scroll row is focusable + labelled'
    );
    has(body, 'class="modcat-card"', 'catalog cards unchanged');
    has(body, 'moduleIconSvg(c.type)', 'per-type icons unchanged');
    has(body, 'installed</span>', 'installed-count meta unchanged');

    // Cache-busts so clients pick up the new app.js/styles.css.
    has(indexHtml, '/styles.css?v=batch115-catalog1', 'styles.css cache-bust bumped');
    has(indexHtml, '/js/app.js?v=batch123-openrouter1', 'app.js cache-bust bumped');

    // The other two catalog surfaces: deliberately unchanged
    // (flagged for Ely in the batch report, not silently diverged).
    has(portalHtml, '.modules-side-nav {', 'portal module picker grid still present (unchanged by design)');
    has(portalJs, 'function renderModuleTypeTabs()', 'portal module picker renderer unchanged');
    has(portalJs, 'function renderBlockPickerGroups(', 'portal structure block picker unchanged');

    // SEC-13 census: totals + per-kind counts + the (file|kind|
    // snippet) multiset byte-identical to Batch 112–114; the
    // app.js attribute edit touches no sink.
    const { census } = require(path.join(root, 'scripts', 'xss-census.cjs'));
    const cz = census();
    assert.deepEqual(
      cz.summary,
      { total: 437, STATIC: 155, ESCAPED: 41, SAFE: 73, BUILDER: 58, IDENT: 35, RAW: 75 },
      'SEC-13 census summary unchanged'
    );
    n += 1;
    const multi = cz.sinks.map((s) => `${s.file}|${s.kind}|${s.snippet}`).sort();
    const sha = crypto.createHash('sha256').update(multi.join('\n')).digest('hex');
    assert.equal(
      sha,
      '05dd590c4eab59d3561ee9bc0e3d05510cd93e799190df1b50ad5e9352c8625b',
      'SEC-13 sink multiset byte-identical'
    );
    n += 1;
    group('Part 1 source pins + census', n);
  }

  if (process.env.B115_SKIP_BROWSER === '1') {
    console.log('  skip Part 2 browser (B115_SKIP_BROWSER=1 — local iteration only)');
    console.log(`BATCH115 REGRESSION PASS — ${groups.join('; ')}`);
    return;
  }

  // ---------------------------------------------------------------
  // Part 2 — real Chromium, stub API, staff app
  // ---------------------------------------------------------------
  const puppeteer = require('puppeteer');
  const http = require('node:http');
  const express = require('express');
  const app = express();
  app.use(express.json());
  const ME = {
    ok: true,
    data: {
      user: { id: 1, email: 'fixture@example.invalid', isSuperAdmin: true },
      workspaceId: 1,
      workspaces: [{ id: 1, name: 'Fixture', role: 'owner' }],
      isSuperAdmin: true,
      productAccess: true,
    },
  };
  app.get('/api/v1/auth/me', (_q, r) => r.json(ME));
  app.get('/api/v1/captcha/config', (_q, r) => r.json({ ok: true, data: { enabled: false } }));
  const TYPES = [
    ['blog', 'Blog'],
    ['ecommerce', 'Shop'],
    ['courses', 'Courses'],
    ['gallery', 'Gallery'],
    ['directory', 'Directory'],
    ['faq', 'FAQ'],
    ['testimonials', 'Testimonials'],
    ['team', 'Team'],
    ['events', 'Events'],
    ['bookings', 'Bookings'],
    ['chatbot', 'Chatbot'],
    ['offers', 'Special Offers'],
    ['menu', 'Menu / Price List'],
    ['careers', 'Careers'],
    ['video', 'Video'],
    ['estimate', 'Instant Estimate'],
    ['socialfeed', 'Social Feed'],
    ['calltracking', 'Call Tracking'],
    ['members', 'Membership'],
    ['googlereviews', 'Google Reviews'],
    ['datatables', 'Data Tables'],
    ['charts', 'Charts'],
    ['newsletter', 'Newsletter'],
    ['categories', 'Categories'],
    ['photocapture', 'Photo Capture'],
    ['qrcode', 'QR Code'],
    ['checkout', 'Checkout'],
  ];
  app.get('/api/v1/admin-area/modules', (_q, r) =>
    r.json({
      ok: true,
      data: {
        catalog: TYPES.map(([type, label]) => ({ type, label })),
        installs: [],
        counts: { blog: 1, courses: 1, members: 1 },
      },
    })
  );
  app.use('/api/v1', (req, res) => {
    if (req.method !== 'GET') return res.status(500).json({ ok: false, error: 'No fixture writes allowed' });
    res.json({ ok: true, data: {} });
  });
  app.get('/app', (_q, r) => r.sendFile(path.join(root, 'public', 'index.html')));
  app.use((req, res, next) => {
    if (req.path === '/styles.css' && NEGATIVE === 'css') {
      let src = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
      const a = src.indexOf('Batch 115 (Ely');
      assert.ok(a > 0, 'negative: Batch 115 block found');
      const head = src.slice(0, a);
      const tail = src
        .slice(a)
        .replace('flex-wrap: nowrap', 'flex-wrap: wrap')
        .replace('overflow-x: auto', 'overflow-x: visible');
      res.type('text/css').send(head + tail);
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
  const ok = (cond, label) => {
    assert.ok(cond, label);
    n += 1;
  };
  const near = (a, b, tol, label) => {
    assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b} (tol ${tol})`);
    n += 1;
  };
  const WF = (page, fn, label) =>
    page.waitForFunction(fn, { timeout: 20000, polling: 100 }).catch(() => {
      throw new Error(`wait timed out: ${label}`);
    });

  const measure = () => {
    const grid = document.querySelector('.modcat-grid');
    const cards = [...document.querySelectorAll('.modcat-card')];
    const gr = grid.getBoundingClientRect();
    const rects = cards.map((c) => {
      const r = c.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
    });
    const gaps = [];
    for (let i = 1; i < rects.length; i += 1) gaps.push(rects[i].left - rects[i - 1].right);
    return {
      count: cards.length,
      display: getComputedStyle(grid).display,
      overflowX: getComputedStyle(grid).overflowX,
      scrollWidth: grid.scrollWidth,
      clientWidth: grid.clientWidth,
      gridRect: { left: gr.left, right: gr.right },
      rects,
      gaps,
      docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
      lastName: cards[cards.length - 1] ? cards[cards.length - 1].textContent : '',
      tableText: (document.querySelector('#md-body') || {}).textContent || '',
    };
  };

  try {
    const page = await browser.newPage();
    const perrors = [];
    page.on('pageerror', (e) => perrors.push(e.message));
    fs.mkdirSync('/tmp/b115-shots', { recursive: true });

    for (const w of [1440, 980, 390]) {
      await page.setViewport({ width: w, height: 1000 });
      await page.goto(base + '/app#/modules', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await WF(page, () => document.querySelectorAll('.modcat-card').length === 27, `catalog renders @${w}`);
      await page.evaluate(() => document.fonts.ready);
      // Batch 112 stability idiom: measure the REST state only once
      // it is well-defined — scroll reset to 0 and the first card's
      // offset stable across consecutive samples. (Diagnosis from
      // the first gate run: scroll anchoring left scrollLeft=3px
      // after the @980 navigation, shifting the first card 3px —
      // the settled rest offset is exactly the 2px row padding at
      // every width, probe-verified.)
      await page.evaluate(() => {
        document.querySelector('.modcat-grid').scrollLeft = 0;
      });
      await WF(
        page,
        () => {
          const g = document.querySelector('.modcat-grid');
          if (g.scrollLeft !== 0 || g.scrollWidth <= g.clientWidth) return false;
          const c = document.querySelector('.modcat-card');
          const off = c.getBoundingClientRect().left - g.getBoundingClientRect().left;
          const stable = window.__b115off === off;
          window.__b115off = off;
          return stable;
        },
        `catalog at settled rest @${w}`
      );
      let m = await page.evaluate(measure);
      ok(m.count === 27, `@${w}: all 27 catalog cards rendered`);
      ok(m.display === 'flex' && m.overflowX === 'auto', `@${w}: row is a native horizontal scroller`);
      const top0 = m.rects[0].top;
      ok(
        m.rects.every((r) => Math.abs(r.top - top0) <= 1),
        `@${w}: exactly ONE row (all card tops align)`
      );
      const h0 = m.rects[0].height;
      ok(
        m.rects.every((r) => Math.abs(r.height - h0) <= 1),
        `@${w}: equal card heights`
      );
      ok(
        m.rects.every((r) => Math.abs(r.width - 171) <= 1),
        `@${w}: uniform 171px card widths (no shrink/stretch)`
      );
      ok(
        m.gaps.every((g) => Math.abs(g - 16) <= 1),
        `@${w}: uniform 16px inter-card gaps`
      );
      ok(
        m.scrollWidth > m.clientWidth,
        `@${w}: row overflows its container (scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth})`
      );
      ok(m.docOverflowX <= 1, `@${w}: page itself has no horizontal overflow`);
      near(
        m.rects[0].left - m.gridRect.left,
        2,
        1.5,
        `@${w}: first card fully visible at rest (only row padding before it)`
      );
      // Scroll to the very end: Charts must be fully reachable.
      await page.evaluate(() => {
        const g = document.querySelector('.modcat-grid');
        g.scrollLeft = g.scrollWidth;
      });
      await WF(
        page,
        () => {
          const g = document.querySelector('.modcat-grid');
          return g.scrollLeft >= g.scrollWidth - g.clientWidth - 2;
        },
        `scroll reaches the end @${w}`
      );
      m = await page.evaluate(measure);
      const last = m.rects[m.rects.length - 1];
      ok(/Checkout/.test(m.lastName), `@${w}: last card is Checkout`);
      ok(
        last.right <= m.gridRect.right + 1 && last.left >= m.gridRect.left - 1,
        `@${w}: Categories fully inside the row at max scroll (not cut)`
      );
      // Keyboard: focus the row, ArrowRight scrolls it.
      await page.evaluate(() => {
        const g = document.querySelector('.modcat-grid');
        g.scrollLeft = 0;
        g.focus();
      });
      await page.keyboard.press('ArrowRight');
      await WF(
        page,
        () => document.querySelector('.modcat-grid').scrollLeft > 0,
        `ArrowRight scrolls the focused row @${w}`
      );
      n += 1;
      ok(m.tableText.includes('No modules installed yet'), `@${w}: installs table below the catalog still renders`);
      if (w === 1440 || w === 390) {
        await page.evaluate(() => {
          document.querySelector('.modcat-grid').scrollLeft = 0;
        });
        await page.screenshot({ path: `/tmp/b115-shots/catalog-row-${w}.png` });
      }
    }
    ok(perrors.length === 0, `no page errors${perrors.length ? ': ' + perrors[0] : ''}`);
    await page.close();
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
  group('Part 2 browser — one scrollable row at 1440/980/390', n);

  console.log(`BATCH115 REGRESSION PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH115 REGRESSION FAIL:', (e && e.stack) || e);
  process.exit(1);
});
