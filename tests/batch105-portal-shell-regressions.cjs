'use strict';
/**
 * Batch 105 — PORTAL UI RESKIN: the client portal takes the
 * staff app's shell (public/index.html + styles.css): left
 * sidenav with the portal's 14 tabs, sticky top bar, full-width
 * main, two-column card grids where a tab's content is cards,
 * and the admin's responsive behaviour (off-canvas drawer at
 * <=900px, grids collapse at <=980px). Chrome only — no portal
 * behaviour changes. Proven here:
 *
 *  1. Structure (source): the shell markup wraps the app —
 *     sidebar (white lockup on dark + tagline, per the official
 *     logo rule), backdrop, main with the sticky top bar holding
 *     Security + Log out; the gate/login view is untouched in
 *     its own .gate-wrap; all 14 nav buttons keep their exact
 *     id / role="tab" / data-panel contract and gain an icon;
 *     every panel section survives; the CSS carries the shell
 *     grid, the drawer media query, the card-grid + collapse,
 *     the [hidden] nav guard, and the fullscreen hide rule.
 *  2. Contract pins: portal.js still toggles is-website-wide
 *     via querySelector('.wrap') — which now resolves to the
 *     shell (the only .wrap left in the document) — and the
 *     drawer wiring (open/close/backdrop/close-on-nav) is
 *     present and null-safe. SEC-13 census: Batch 105 adds no
 *     sink and shifts no sink line (the wiring block sits after
 *     the last baseline sink), so totals + baseline are exact.
 *  3. Browser (stub API + real portal.html/portal.js, the
 *     site-analytics-portal-browser harness): a real portal
 *     session renders the app at 1440 / 980 / 390 — sidenav
 *     240px and main full width on desktop; tab clicks switch
 *     panels; Forms item cards and the Billing/Analytics card
 *     rows sit two-across on desktop and stack at 980; at 390
 *     the sidenav is an off-canvas drawer (menu opens it,
 *     backdrop shows, choosing a section closes it), Log out
 *     stays visible, no horizontal overflow, no page errors.
 *     A restricted visibleTabs pass proves the owner/partner/
 *     renter visibility rules still hide tabs (Agent SOUL.md).
 *
 * NEGATIVE PROOF: B105_NEGATIVE=drawer serves portal.js with
 * the Batch 105 wiring block stripped -> the 390px drawer
 * assertions in Part 3 go RED.
 * B105_SKIP_BROWSER=1 skips Part 3 locally (no Chromium on the
 * dev box); the gate always runs it in-image.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const NEGATIVE = process.env.B105_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const PANELS = [
  'website', 'changes', 'forms', 'leadscout', 'modules', 'social', 'referrals',
  'mcp', 'soul', 'analytics', 'seo', 'gbp', 'rentals', 'billing',
];

(async () => {
  const portalHtml = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
  const portalSrc = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');

  // ---------------------------------------------------------------
  // Part 1 — shell structure (source-level)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const idx = (s) => portalHtml.indexOf(s);
    // Gate untouched, in its own wrap; app shell follows it.
    assert.ok(idx('class="gate-wrap"') > 0, 'gate container renamed gate-wrap'); n += 1;
    assert.ok(idx('id="gate"') > idx('class="gate-wrap"'), 'gate lives in gate-wrap'); n += 1;
    assert.ok(idx('id="app"') > idx('id="gate"'), 'app after gate'); n += 1;
    assert.ok(!portalHtml.includes('class="wrap"'), 'no bare .wrap container remains'); n += 1;
    // Shell skeleton, in order.
    const shellAt = idx('id="portal-shell"');
    assert.ok(shellAt > idx('id="app"'), 'shell inside #app'); n += 1;
    assert.ok(portalHtml.includes('class="portal-shell wrap"'), 'shell carries .wrap (wide-toggle target)'); n += 1;
    assert.ok(idx('id="portal-sidebar"') > shellAt, 'sidebar inside shell'); n += 1;
    assert.ok(idx('id="portal-nav"') > idx('id="portal-sidebar"'), 'nav inside sidebar'); n += 1;
    assert.ok(idx('id="portal-backdrop"') > idx('id="portal-nav"'), 'backdrop after sidebar'); n += 1;
    assert.ok(idx('class="portal-main"') > idx('id="portal-backdrop"'), 'main after backdrop'); n += 1;
    assert.ok(idx('<main class="portal-content">') > idx('class="portal-main"'), 'content main inside portal-main'); n += 1;
    // Brand: white lockup on the dark sidebar + tagline + close btn.
    assert.ok(portalHtml.includes('<img class="portal-brand-logo" src="/brand/logo-white.png"'), 'white lockup in sidebar brand'); n += 1;
    assert.ok(portalHtml.includes('class="portal-brand-tag"'), 'brand tagline present'); n += 1;
    assert.ok(portalHtml.includes('id="portal-nav-close"'), 'drawer close button present'); n += 1;
    assert.ok(portalHtml.includes('id="portal-menu-btn"'), 'menu button present'); n += 1;
    // Top bar (inside main) keeps Security + Log out reachable.
    const topAt = idx('<header class="topbar">');
    assert.ok(topAt > idx('class="portal-main"'), 'topbar inside portal-main'); n += 1;
    const topEnd = portalHtml.indexOf('</header>', topAt);
    const topSlice = portalHtml.slice(topAt, topEnd);
    assert.ok(topSlice.includes('id="biz-name"') && topSlice.includes('id="biz-meta"'), 'topbar keeps business identity'); n += 1;
    assert.ok(topSlice.includes('id="btn-security"'), 'topbar keeps Security'); n += 1;
    assert.ok(topSlice.includes('id="btn-logout"'), 'topbar keeps Log out'); n += 1;
    assert.ok(topSlice.includes('id="portal-menu-btn"'), 'topbar holds the menu button'); n += 1;
    // All 14 tabs: exact button contract + an icon each.
    for (const p of PANELS) {
      const m = portalHtml.match(new RegExp(`<button[^>]*role="tab"[^>]*data-panel="${p}"[^>]*>([\\s\\S]*?)</button>`));
      assert.ok(m, `nav button for ${p} present with role=tab + data-panel`);
      assert.ok(m[1].includes('<svg'), `nav button for ${p} carries an icon`);
      n += 2;
    }
    // Every panel section survives inside the content main.
    const contentAt = idx('<main class="portal-content">');
    for (const p of PANELS) {
      assert.ok(idx(`data-panel="${p}"`) > 0, `section hook for ${p} (button or panel)`); n += 1;
    }
    assert.ok(idx('id="sec-preview"') > contentAt, 'sections live inside portal-content'); n += 1;
    assert.ok(idx('id="sec-billing"') > contentAt, 'billing inside portal-content'); n += 1;
    // Card rows landed where the brief asked.
    assert.ok((portalHtml.match(/class="portal-cards"/g) || []).length >= 4, 'portal-cards rows in analytics/referrals/billing'); n += 1;
    assert.ok(portalHtml.includes('id="bill-credits-box"'), 'billing credits card keeps its id'); n += 1;
    assert.ok(portalHtml.includes('id="analytics-visits"') && portalHtml.includes('id="analytics-clicks"'), 'analytics stat ids intact'); n += 1;
    // CSS contract.
    const cssHas = (s, label) => { assert.ok(portalHtml.includes(s), label); n += 1; };
    cssHas('.portal-shell {', 'shell rule present');
    cssHas('grid-template-columns: var(--sidebar-w) minmax(0, 1fr)', 'shell grid mirrors admin (240px sidenav)');
    cssHas('.portal-shell.nav-open .portal-sidebar', 'drawer open state styled');
    cssHas('.portal-nav button[hidden] { display: none !important; }', 'hidden nav buttons stay hidden in the sidenav');
    cssHas('body.is-preview-fullscreen .portal-sidebar', 'fullscreen edit hides the sidebar');
    cssHas('.portal-cards {', 'card grid rule present');
    cssHas('#forms-list.item-list', 'forms list two-column rule present');
    cssHas('#modules-items.item-list', 'module items two-column rule present');
    cssHas('/js/portal.js?v=batch178-router1', 'portal.js cache-busted');
    group('Part 1 shell structure', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — JS contract + SEC-13 census pin
  // ---------------------------------------------------------------
  {
    let n = 0;
    assert.ok(portalSrc.includes("document.querySelector('.wrap')"), 'wide toggle still resolves via .wrap (now the shell)'); n += 1;
    assert.ok(portalSrc.includes("classList.toggle('is-website-wide', next === 'website')"), 'wide toggle behaviour unchanged'); n += 1;
    const wireAt = portalSrc.indexOf('Batch 105 — app-shell drawer wiring');
    assert.ok(wireAt > 0, 'drawer wiring block present'); n += 1;
    const wire = portalSrc.slice(wireAt, portalSrc.indexOf('(async function boot()', wireAt));
    assert.ok(wire.includes("getElementById('portal-menu-btn')"), 'wiring finds the menu button'); n += 1;
    assert.ok(wire.includes("classList.add('nav-open')") && wire.includes("classList.remove('nav-open')"), 'wiring toggles nav-open both ways'); n += 1;
    assert.ok(wire.includes('portalBackdropEl.hidden = false') && wire.includes('portalBackdropEl.hidden = true'), 'wiring drives the backdrop'); n += 1;
    assert.ok(wire.includes("portalNav.addEventListener('click', closePortalNav)"), 'choosing a section closes the drawer'); n += 1;
    assert.ok(!/\.\s*innerHTML\b/.test(wire), 'drawer wiring uses no innerHTML sink'); n += 1;
    // SEC-13: no new sink, no shifted sink — totals + baseline exact.
    const { census } = require(path.join(root, 'scripts', 'xss-census.cjs'));
    const cz = census();
    // Batch 156 rotation: census 450 -> 453 (+1 STATIC +1 ESCAPED +1 SAFE in app.js — the fingerprint surfaces), safe classes 336 -> 339, RAW 78 / IDENT 36 and the 114-entry reviewed set unchanged; baseline regenerated.
    // Batch 161 rotation: census 453 -> 470 (+17 audited Assistant-surface sinks in app.js/portal.js — escape-first markdown renderer + esc()-wrapped usage templates, pairwise multiset-proven vs the 159 census), safe classes 339 -> 351, RAW 81 / IDENT 38, reviewed set 119 entries; baseline regenerated.
    assert.equal(cz.summary.total, 514, 'SEC-13 census total unchanged by Batch 105'); n += 1;
    assert.equal(cz.summary.ESCAPED + cz.summary.SAFE + cz.summary.STATIC + cz.summary.BUILDER, 386, 'SEC-13 safe classes (Batch 176 finisher re-pin: 380 -> 381 — audited Assistant page-head shell reclassification RAW -> STATIC in app.js, multiset-proven vs the Batch 175 base; see the batch104 note) (Batch 161: 339 -> 351, see batch103) (Batch 136 finisher: +2 audited STATIC sinks in module-embed.js — the booking price-summary clear + esc()-wrapped build; 328 -> 330, census 439 -> 441, RAW/IDENT unchanged; Batch 137 finisher: +1 audited SAFE sink in portal.js (qualifying-question rows render — numeric indices + esc()-wrapped question text), census 441 -> 442, SAFE 73 -> 74, reviewed RAW/IDENT content unchanged (12 portal.js positions shifted +127, pure line movement, snippet-verified); Batch 147 finisher-prep: RAW/IDENT content unchanged again — 32 portal.js positions shifted by the layout-editor insertion, (file,kind,snippet) multiset verified identical to the Batch 144 base, baseline tests/batch103-xss-baseline.json regenerated, totals unchanged at 442; Batch 148 finisher: RAW/IDENT content unchanged again — 31 positions shifted (30 in portal.js + 1 in websiteEngine.js) by the section-layout-knobs insertion, (file,kind,snippet) multiset verified identical to the Batch 147 base, baseline regenerated, totals unchanged at 442; Batch 138 finisher: census 442 -> 446 — +3 audited STATIC + 1 IDENT (micSvg(), a constant SVG string) in chat-embed.js for the voice panel, and one portal.js inbox sink reclassified SAFE -> RAW by the conservative classifier after gaining the ${voiceHtml} interpolation (audited: voiceHtml is composed only of esc()-wrapped values, duration arithmetic and fixed close-state words — no visitor-controlled string reaches it unescaped); RAW 76 -> 77, IDENT 35 -> 36, SAFE 74 -> 73, STATIC 158 -> 161, safe classes 331 -> 333; (file,kind,snippet) multiset diff vs the Batch 149 base = exactly these deltas plus pure line movement in portal.js/chat-embed.js; baseline regenerated; Batch 153: census 448 -> 450 — +1 BUILDER +1 RAW in app.js, both the Admin Design-agent editor (rows build — every interpolated value esc()-wrapped; panel shell classified RAW by the conservative classifier, audited: its interpolations are a fixed literal seed note and the numeric limits only, no staff- or visitor-controlled string reaches it unescaped); BUILDER 59 -> 60, RAW 77 -> 78, safe classes 335 -> 336; remaining app.js RAW/IDENT movement is pure line shift from the editor + popup insertions, (file,kind,snippet) multiset diff vs the Batch 139 base = exactly these two sinks; baseline regenerated)'); n += 1;
    const reviewed = new Set(cz.sinks.filter((s) => s.kind === 'RAW' || s.kind === 'IDENT').map((s) => `${s.file}:${s.line}`));
    const BASELINE = new Set(require(path.join(root, 'tests', 'batch103-xss-baseline.json')));
    assert.deepEqual([...reviewed].filter((x) => !BASELINE.has(x)), [], 'no new RAW/IDENT sinks'); n += 1;
    assert.deepEqual([...BASELINE].filter((x) => !reviewed.has(x)), [], 'no baseline sink moved'); n += 1;
    group('Part 2 JS contract + census', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — real portal session in Chromium (stub API)
  // ---------------------------------------------------------------
  if (process.env.B105_SKIP_BROWSER === '1') {
    console.log('  skip Part 3 browser (B105_SKIP_BROWSER=1 — local iteration only)');
  } else {
    let n = 0;
    const puppeteer = require('puppeteer');
    const http = require('node:http');
    const express = require('express');

    const ALL_TABS = PANELS.slice();
    let visibleTabs = ALL_TABS;
    const app = express();
    app.use(express.json());
    app.get('/api/v1/captcha/config', (_q, r) => r.json({ ok: true, data: { enabled: false } }));
    app.get('/api/v1/portal/me', (_q, r) =>
      r.json({
        ok: true,
        data: {
          client: { id: 1, email: 'owner@b105.fixture', businessName: 'ZZ B105 Bakery', visibleTabs },
          lead: { business_name: 'ZZ B105 Bakery', city: 'Blandon', state: 'PA' },
          site: { id: 1, name: 'ZZ B105 Bakery' },
          previewUrl: null,
        },
      })
    );
    app.get('/api/v1/portal/forms', (_q, r) =>
      r.json({
        ok: true,
        data: {
          forms: [
            { id: 11, name: 'Contact form', published: 1, form_kind: 'contact', target_page_slug: 'contact' },
            { id: 12, name: 'Wedding enquiry', published: 0, form_kind: 'estimate', target_page_slug: 'contact' },
          ],
        },
      })
    );
    app.use('/api/v1/portal', (_q, r) =>
      r.json({ ok: true, data: { plan: 'standard', plans: [], forms: [], modules: [], contacts: [], accounts: [], previewUrl: null } })
    );
    app.get('/portal', (_q, r) => r.sendFile(path.join(root, 'public', 'portal.html')));
    // Static assets, with the NEGATIVE hook applied to portal.js.
    app.use((req, res, next) => {
      if (req.path === '/js/portal.js' && NEGATIVE === 'drawer') {
        let src = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');
        const a = src.indexOf('  // Batch 105 — app-shell drawer wiring');
        const b = src.indexOf('  (async function boot()', a);
        if (a > 0 && b > a) src = src.slice(0, a) + src.slice(b);
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
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setRequestInterception(true);
      page.on('request', (r) => (r.url().startsWith(base) ? r.continue() : r.abort()));
      const box = (sel) => page.$eval(sel, (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
      const visible = (sel) =>
        page.$eval(sel, (el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
        }).catch(() => false);

      // — Desktop 1440: shell geometry + navigation + cards —
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(base + '/portal#/website');
      await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
      await page.waitForSelector('#sec-preview:not([hidden])', { timeout: 15000 });
      const side = await box('#portal-sidebar');
      assert.ok(Math.abs(side.w - 240) <= 2 && side.x === 0, `sidenav is the admin 240px column (w=${side.w})`); n += 1;
      const content = await box('.portal-content');
      assert.ok(content.w > 1050, `main area is full width, not the old 980px column (w=${content.w})`); n += 1;
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal overflow at 1440'); n += 1;
      assert.equal(await visible('#btn-logout'), true, 'Log out visible in the top bar'); n += 1;
      assert.equal(await page.$eval('.topbar', (el) => getComputedStyle(el).position), 'sticky', 'top bar is sticky like the admin'); n += 1;
      const visTabs = await page.$$eval('#portal-nav [data-panel]', (els) =>
        els.filter((el) => !el.hidden && el.getBoundingClientRect().width > 0).map((el) => el.getAttribute('data-panel'))
      );
      assert.ok(visTabs.includes('website') && visTabs.includes('soul') && visTabs.includes('billing') && visTabs.length >= 13, `owner sees the full tab set (${visTabs.length})`); n += 1;
      // Website tab internals intact: chat + preview workspace.
      assert.equal(await visible('.website-workspace'), true, 'website workspace (chat + preview) renders in the shell'); n += 1;
      assert.equal(await visible('.agent-chat'), true, 'design chat renders'); n += 1;

      // Forms: two item cards side by side at desktop width.
      await page.click('#nav-forms');
      await page.waitForSelector('#sec-forms:not([hidden])');
      await page.waitForFunction(() => document.querySelectorAll('#forms-list .item-card').length === 2, { timeout: 10000 });
      const fc = await page.$$eval('#forms-list .item-card', (els) => els.map((el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y }; }));
      assert.ok(Math.abs(fc[0].y - fc[1].y) <= 2 && fc[1].x > fc[0].x, 'form cards sit two-across at 1440'); n += 1;

      // Billing: status + credits cards side by side.
      await page.click('#nav-billing');
      await page.waitForSelector('#sec-billing:not([hidden])');
      const bc = await page.$$eval('#sec-billing .portal-cards > .panel', (els) => els.map((el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width }; }));
      assert.equal(bc.length, 2, 'billing card row has two cards'); n += 1;
      assert.ok(Math.abs(bc[0].y - bc[1].y) <= 2 && bc[1].x > bc[0].x, 'billing cards sit two-across at 1440'); n += 1;

      // Analytics: stat cards side by side.
      await page.click('#nav-analytics');
      await page.waitForSelector('#sec-analytics:not([hidden])');
      const ac = await page.$$eval('#sec-analytics .portal-cards > .panel', (els) => els.map((el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y }; }));
      assert.ok(ac.length >= 2 && Math.abs(ac[0].y - ac[1].y) <= 2 && ac[1].x > ac[0].x, 'analytics stat cards sit two-across at 1440'); n += 1;

      // — 980: card grids stack —
      await page.setViewport({ width: 980, height: 800 });
      await page.click('#nav-forms');
      await page.waitForSelector('#sec-forms:not([hidden])');
      const fc980 = await page.$$eval('#forms-list .item-card', (els) => els.map((el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y }; }));
      assert.ok(fc980[1].y > fc980[0].y, 'form cards stack at 980'); n += 1;
      await page.click('#nav-billing');
      await page.waitForSelector('#sec-billing:not([hidden])');
      const bc980 = await page.$$eval('#sec-billing .portal-cards > .panel', (els) => els.map((el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y }; }));
      assert.ok(bc980[1].y > bc980[0].y, 'billing cards stack at 980'); n += 1;

      // — 390: off-canvas drawer —
      await page.setViewport({ width: 390, height: 844 });
      await page.evaluate(() => { location.hash = '#/website'; });
      await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
      await page.waitForSelector('#sec-preview:not([hidden])', { timeout: 15000 });
      // The drawer has the admin's 0.2s slide transition; let it settle.
      await page.waitForFunction(() => document.getElementById('portal-sidebar').getBoundingClientRect().right <= 1, { timeout: 5000 });
      const sideClosed = await box('#portal-sidebar');
      assert.ok(sideClosed.x + sideClosed.w <= 1, `sidenav is off-canvas at 390 (right edge=${sideClosed.x + sideClosed.w})`); n += 1;
      assert.equal(await visible('#portal-menu-btn'), true, 'menu button visible at 390'); n += 1;
      assert.equal(await visible('#btn-logout'), true, 'Log out still visible at 390'); n += 1;
      await page.click('#portal-menu-btn');
      await page.waitForFunction(() => document.getElementById('portal-shell').classList.contains('nav-open'), { timeout: 5000 });
      await page.waitForFunction(() => document.getElementById('portal-sidebar').getBoundingClientRect().x >= -1, { timeout: 5000 });
      const sideOpen = await box('#portal-sidebar');
      assert.ok(sideOpen.x >= -1 && sideOpen.w > 200, 'drawer slides in at 390'); n += 1;
      assert.equal(await page.$eval('#portal-backdrop', (el) => el.hidden), false, 'backdrop shows with the drawer'); n += 1;
      await page.click('#nav-modules');
      await page.waitForSelector('#sec-modules:not([hidden])', { timeout: 10000 });
      assert.equal(await page.$eval('#portal-shell', (el) => el.classList.contains('nav-open')), false, 'choosing a section closes the drawer'); n += 1;
      assert.equal(await page.$eval('#portal-backdrop', (el) => el.hidden), true, 'backdrop hides with the drawer'); n += 1;
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal overflow at 390'); n += 1;

      // — Restricted tabs: visibility rules preserved —
      visibleTabs = ALL_TABS.filter((t) => !['soul', 'mcp', 'rentals'].includes(t));
      await page.setViewport({ width: 1440, height: 900 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
      await page.evaluate(() => { location.hash = '#/website'; });
      await page.waitForSelector('#sec-preview:not([hidden])', { timeout: 15000 });
      assert.equal(await page.$eval('#nav-soul', (el) => el.hidden), true, 'Agent SOUL.md tab hidden for a restricted user'); n += 1;
      assert.equal(await visible('#nav-soul'), false, 'hidden tab does not render in the sidenav'); n += 1;
      assert.equal(await page.$eval('#nav-rentals', (el) => el.hidden), true, 'Rentals tab hidden for a restricted user'); n += 1;
      assert.equal(await visible('#nav-billing'), true, 'allowed tabs still render'); n += 1;

      assert.equal(errors.length, 0, `no page errors (${errors.join('; ')})`); n += 1;
    } finally {
      await browser.close().catch(() => {});
      server.close();
    }
    group('Part 3 browser shell (1440/980/390)', n);
  }

  console.log(`BATCH105 REGRESSION PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH105 REGRESSION FAIL:', (e && e.stack) || e);
  process.exit(1);
});
