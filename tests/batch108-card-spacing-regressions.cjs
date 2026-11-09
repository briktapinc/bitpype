'use strict';
/**
 * Batch 108 — PORTAL CARD SPACING: one uniform gap standard.
 * Ely's order 2026-10-31 ~19:25 EDT: "Some cards in portal touch each
 * other, make sure there are equal margins between each card."
 *
 * THE AUDIT (rendered DOM measurement in Chromium, stub API, before
 * the fix — not CSS reading): the JS-rendered panel hosts stacked
 * their cards with NO separation at all — #seo-host 3 panels at 0px,
 * #gbp-host 5 panels at 0px, #rentals-host 2 panels at 0px, at every
 * width. Everything else was a patchwork: portal-cards / plan-grid /
 * post-list / LeadScout layout at 14px, item lists and the Batch 91
 * module-card grid at 12px, the Insert-block picker at 10px, form
 * submission cards at 8px, stacked static panels hand-margined at 14
 * or 16px depending on the section.
 *
 * THE STANDARD: --card-gap: 16px — the value the portal's own
 * stacked-panel margins and newest flex stacks (modules-admin,
 * structure-module-list, website-workspace) already used. Every card
 * grid/flex container now takes `gap: var(--card-gap)`; stacked
 * sibling panels (which have no container gap) take the same value
 * via a sibling rule; the JS templates that hand-set card margins
 * (module settings .card blocks, submission post-cards, GBP draft
 * panels) use the token too. Spacing only — no card design, icon, or
 * behaviour changed.
 *
 * Proven here:
 *  Part 1 — source pins: the token, every container rule on the
 *    token, the sibling-stack rule, the JS template margins, the old
 *    off-standard values gone, SEC-13 census untouched.
 *  Part 2 — real Chromium, stub API: at 1440 / 980 / 390, EVERY
 *    adjacent-card gap on every audited surface measures the
 *    standard (16px): portal-cards (Analytics/Referrals/Billing),
 *    plan cards, item-card lists (Forms + Modules), the Batch 91
 *    module-card grid, post cards (Social + form Submissions),
 *    LeadScout layout panels, the DataTables settings card stack,
 *    the Insert-block picker, referral stat cards, and the stacked
 *    panels of Changes / Social / MCP / SEO / GBP / Rentals.
 *
 * NEGATIVE PROOF: B108_NEGATIVE=gap serves portal.html with the
 * sibling-stack rule stripped and the module-card grid gap zeroed ->
 * Part 2 goes RED on exactly those surfaces.
 * B108_SKIP_BROWSER=1 skips Part 2 locally (no Chromium on the dev
 * box); the gate always runs it in-image.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const NEGATIVE = process.env.B108_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const MODULE_TYPES = [
  'blog', 'ecommerce', 'courses', 'gallery', 'directory', 'faq',
  'testimonials', 'team', 'events', 'bookings', 'chatbot', 'offers',
  'menu', 'careers', 'video', 'estimate', 'socialfeed',
  'googlereviews', 'calltracking', 'members', 'datatables', 'charts',
];

(async () => {
  const portalHtml = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
  const portalJs = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');

  // ---------------------------------------------------------------
  // Part 1 — source pins + census
  // ---------------------------------------------------------------
  {
    let n = 0;
    const has = (src, s, label) => { assert.ok(src.includes(s), label); n += 1; };
    const hasNot = (src, s, label) => { assert.ok(!src.includes(s), label); n += 1; };
    const ruleHas = (selector, snippet, label) => {
      // Top-level portal rules are 4-space indented; slice the rule body.
      const idx = portalHtml.indexOf(String.fromCharCode(10) + '    ' + selector + ' {');
      assert.ok(idx >= 0, `${label} — rule exists`);
      const body = portalHtml.slice(idx, portalHtml.indexOf('}', idx));
      assert.ok(body.includes(snippet), `${label} — contains ${snippet}`);
      n += 2;
    };

    has(portalHtml, '--card-gap: 16px;', 'the one card-gap token (16px)');
    ruleHas('.portal-cards', 'gap: var(--card-gap)', 'portal-cards grid gap');
    ruleHas('.portal-cards', 'margin-bottom: var(--card-gap)', 'portal-cards stack margin');
    ruleHas('.modules-side-nav', 'gap: var(--card-gap)', 'Batch 91 module-card grid gap');
    ruleHas('.structure-block-group', 'gap: var(--card-gap)', 'Insert-block picker grid gap');
    ruleHas('.item-list', 'gap: var(--card-gap)', 'item-card list gap');
    ruleHas('.post-list', 'gap: var(--card-gap)', 'post-card list gap');
    ruleHas('.plan-grid', 'gap: var(--card-gap)', 'billing plan grid gap');
    ruleHas('.modules-admin', 'gap: var(--card-gap)', 'modules admin stack gap');
    ruleHas('.structure-module-list', 'gap: var(--card-gap)', 'picker group stack gap');
    ruleHas('.website-workspace', 'gap: var(--card-gap)', 'website workspace gap');
    ruleHas('.modules-embed-card', 'margin-bottom: var(--card-gap)', 'embed card margin');
    // The sibling-stack rule that separates the previously touching panels.
    has(portalHtml, '#seo-host > .panel + .panel,', 'stack rule covers SEO host');
    has(portalHtml, '#gbp-host > .panel + .panel,', 'stack rule covers GBP host');
    has(portalHtml, '#rentals-host > .panel + .panel,', 'stack rule covers Rentals host');
    has(portalHtml, 'section.portal-panel > .panel + .panel {', 'stack rule covers section panel stacks');
    has(portalHtml, 'margin-top: var(--card-gap);', 'stack rule uses the token');
    // Inline card separations in the static HTML.
    has(portalHtml, 'gap:var(--card-gap)', 'LeadScout layout inline gap on token');
    has(portalHtml, 'flex-wrap:wrap;gap:var(--card-gap);margin-bottom:8px', 'referral stat row gap on token');
    has(portalHtml, '<div class="panel" style="margin-bottom:var(--card-gap)">', 'social accounts panel margin on token');
    // JS template card margins on the token.
    const flatJs = portalJs.split(String.fromCharCode(92)).join('');
    assert.equal(flatJs.split('<div class="card" style="margin-bottom:var(--card-gap)"').length - 1, 11, 'all eleven module settings .card blocks on token (Batch 124: Categories scopes panel; Batch 126 finisher: +1 QR display panel; Batch 128: +3 shop orders + checkout panels)'); n += 1;
    has(flatJs, '<article class="post-card" style="margin-bottom:var(--card-gap)">', 'submission post-card margin on token');
    has(flatJs, '<div class="panel" style="margin-top:var(--card-gap)">', 'GBP draft panel margin on token');
    // Off-standard values are gone from the card surfaces.
    hasNot(portalJs, 'margin-bottom:14px', 'no 14px card margins left in portal.js');
    hasNot(flatJs, 'post-card" style="margin-bottom:8px"', 'submission cards no longer at 8px');
    hasNot(flatJs, 'panel" style="margin-top:10px"', 'GBP draft panels no longer at 10px');
    // SEC-13 census untouched (portal.js edits are same-line value swaps).
    const { census } = require(path.join(root, 'scripts', 'xss-census.cjs'));
    const cz = census();
    // Batch 156 rotation: census 450 -> 453 (+1 STATIC +1 ESCAPED +1 SAFE in app.js — the fingerprint surfaces), safe classes 336 -> 339, RAW 78 / IDENT 36 and the 114-entry reviewed set unchanged; baseline regenerated. Batch 161 rotation: census 453 -> 470 (+17 audited Assistant-surface sinks in app.js/portal.js, pairwise multiset-proven vs the 159 census — see batch103 narrative), safe classes 339 -> 351, RAW 81 / IDENT 38, reviewed set 119 entries; baseline regenerated.
    assert.equal(cz.summary.total, 486, 'SEC-13 census total unchanged (Batch 153 rotation: census 448 -> 450 — +1 BUILDER +1 RAW in app.js, both the Admin Design-agent editor (rows build — every interpolated value esc()-wrapped; panel shell classified RAW by the conservative classifier, audited: its interpolations are a fixed literal seed note and the numeric limits only, no staff- or visitor-controlled string reaches it unescaped); BUILDER 59 -> 60, RAW 77 -> 78, safe classes 335 -> 336; remaining app.js RAW/IDENT movement is pure line shift from the editor + popup insertions, (file,kind,snippet) multiset diff vs the Batch 139 base = exactly these two sinks; baseline regenerated)'); n += 1;
    const reviewed = new Set(cz.sinks.filter((s) => s.kind === 'RAW' || s.kind === 'IDENT').map((s) => `${s.file}:${s.line}`));
    const BASELINE = new Set(require(path.join(root, 'tests', 'batch103-xss-baseline.json')));
    assert.deepEqual([...reviewed].filter((x) => !BASELINE.has(x)), [], 'no new RAW/IDENT sinks vs baseline'); n += 1;
    assert.deepEqual([...BASELINE].filter((x) => !reviewed.has(x)), [], 'no baseline sink unaccounted'); n += 1;
    group('Part 1 source pins + census', n);
  }

  if (process.env.B108_SKIP_BROWSER === '1') {
    console.log('  skip Part 2 browser (B108_SKIP_BROWSER=1 — local iteration only)');
    console.log(`BATCH108 REGRESSION PASS — ${groups.join('; ')}`);
    return;
  }

  // ---------------------------------------------------------------
  // Part 2 — real Chromium: every adjacent card gap == 16px
  // ---------------------------------------------------------------
  const puppeteer = require('puppeteer');
  const http = require('node:http');
  const express = require('express');
  const launch = () =>
    puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

  const PAGES = [
    { slug: 'index', title: 'Home' },
    { slug: 'services', title: 'Services' },
  ];
  const EMBED = { published: true, embed_enabled: true, page_slug: 'index', embed_url: 'https://fixture.invalid/embed/b108' };
  const ITEM = (i) => ({
    id: i, title: `Fixture Item ${i} With A Title`, name: `Fixture Item ${i}`,
    status: 'published', question: 'Fixture question?', author: 'Fixture Author',
    role: 'Fixture Role', price_cents: 2500, kind: 'doc',
  });
  const modulePayload = (type) => {
    const data = { items: [ITEM(1), ITEM(2), ITEM(3)], embed: { ...EMBED }, pages: PAGES, categories: [] };
    if (type === 'bookings') data.booking = { settings: {}, hours: [], appointments: [], active_appointment_count: 0 };
    if (type === 'chatbot') data.chatbot = { settings: {}, escalations: [] };
    if (type === 'estimate') data.estimate = { config: {}, requests: [] };
    if (type === 'socialfeed') data.socialfeed = { settings: {}, posts: [] };
    if (type === 'googlereviews') data.googlereviews = { settings: {}, reviews: [] };
    if (type === 'calltracking') data.calltracking = { settings: {}, calls: [] };
    if (type === 'members') data.members = { settings: {}, members: [] };
    if (type === 'ecommerce') data.shop = { settings: {}, payments: {} };
    if (type === 'datatables')
      data.datatable = {
        title: 'Prices', template: 'table', submit_mode: 'off', roles: {},
        columns: [
          { key: 'name', label: 'Name', type: 'text' },
          { key: 'price', label: 'Price', type: 'currency' },
        ],
      };
    if (type === 'charts')
      data.charts = { datatable_columns: [{ key: 'name', type: 'text' }, { key: 'sales', type: 'currency' }] };
    return data;
  };
  const RENTAL = (nm) => ({
    site: { name: nm }, status: 'active', model: 'per_lead', price_cents: 2500,
    started_at: '2026-09-01', this_month: { qualified_leads: 3, credits_charged: 6 },
    counters: { amount_due_cents: 0 }, history: [],
  });

  const app = express();
  app.use(express.json());
  app.get('/api/v1/captcha/config', (_q, r) => r.json({ ok: true, data: { enabled: false } }));
  app.get('/api/v1/portal/me', (_q, r) =>
    r.json({
      ok: true,
      data: {
        client: { id: 2, email: 'owner@b108.fixture', businessName: 'ZZ B108 Bakery', userType: 'owner', visibleTabs: ['website', 'changes', 'forms', 'leadscout', 'modules', 'social', 'referrals', 'mcp', 'soul', 'analytics', 'seo', 'gbp', 'rentals', 'billing'] },
        lead: { business_name: 'ZZ B108 Bakery', city: 'Blandon', state: 'PA' },
        site: { id: 30, name: 'ZZ B108 Bakery' },
        previewUrl: null,
      },
    })
  );
  app.get('/api/v1/portal/modules', (_q, r) =>
    r.json({ ok: true, data: { plan: 'premium', siteModules: true, pages: PAGES, modules: MODULE_TYPES.map((type) => ({ type, count: 3, embed: { ...EMBED } })) } })
  );
  app.get('/api/v1/portal/modules/:type', (req, r) => r.json({ ok: true, data: modulePayload(req.params.type) }));
  app.get('/api/v1/portal/forms/submissions', (_q, r) =>
    r.json({
      ok: true,
      data: {
        inbox: true, plan: 'pro', total: 2,
        submissions: [
          { id: 1, created_at: '2026-10-30T10:00:00', routing: 'email', form_id: 11, payload: { name: 'Jane', message: 'Hello there' } },
          { id: 2, created_at: '2026-10-30T11:00:00', routing: 'email', form_id: 11, payload: { name: 'John', message: 'Second one' } },
        ],
      },
    })
  );
  app.get('/api/v1/portal/forms', (_q, r) =>
    r.json({
      ok: true,
      data: {
        forms: [
          { id: 11, name: 'Contact form', published: 1, form_kind: 'contact', target_page_slug: 'contact' },
          { id: 12, name: 'Estimate form', published: 1, form_kind: 'estimate', target_page_slug: 'contact' },
          { id: 13, name: 'Booking form', published: 0, form_kind: 'booking', target_page_slug: 'contact' },
        ],
      },
    })
  );
  app.get('/api/v1/portal/billing', (_q, r) =>
    r.json({
      ok: true,
      data: {
        plan: 'standard', canSelfServe: true,
        plans: [
          { id: 'free', name: 'Free', priceLabel: 'Free', tagline: 'Launch a site.', features: ['Website'], checkout: false, priceConfigured: true },
          { id: 'standard', name: 'Standard', priceLabel: '$99/mo', tagline: 'Support included.', features: ['Website', 'Edits'], checkout: true, priceConfigured: true },
          { id: 'pro', name: 'Pro', priceLabel: '$169/mo', tagline: 'Social included.', features: ['Website', 'Edits', 'Social'], checkout: true, priceConfigured: true },
        ],
      },
    })
  );
  app.get('/api/v1/portal/seo', (_q, r) =>
    r.json({
      ok: true,
      data: {
        configured: true, gscToken: '', pending: null,
        history: [{ change_count: 2, actor_kind: 'owner', applied_at: '2026-10-01', keywords: { primary: 'bakery reading pa' } }],
      },
    })
  );
  app.get('/api/v1/portal/gbp', (_q, r) =>
    r.json({
      ok: true,
      data: {
        config: { apiPending: true, oauthReady: false, oauthNotConfiguredMessage: 'Google sign-in is not configured yet.' },
        connection: { status: 'none' },
        prefill: {
          fields: { name: { label: 'Business name', googleText: 'ZZ B108 Bakery LLC', proposedText: 'ZZ B108 Bakery' } },
          proposedState: { name: 'ZZ B108 Bakery', address: {}, hours: {} },
        },
        changeSets: { rows: [] },
      },
    })
  );
  app.get('/api/v1/portal/rentals', (_q, r) => r.json({ ok: true, data: { rentals: [RENTAL('ZZ Site One'), RENTAL('ZZ Site Two')] } }));
  app.get('/api/v1/portal/referrals', (_q, r) => r.json({ ok: true, data: { totals: {}, creditMath: {}, referrals: [] } }));
  app.get('/api/v1/portal/leadscout/contacts', (_q, r) =>
    r.json({ ok: true, data: { contacts: [{ id: 1, name: 'Jane Fixture', email: 'jane@fixture.invalid', phone: '', event_count: 2 }], health: {} } })
  );
  app.get('/api/v1/portal/social/accounts', (_q, r) => r.json({ ok: true, data: { accounts: [], metaConfigured: false } }));
  app.get('/api/v1/portal/calendar', (_q, r) =>
    r.json({
      ok: true,
      data: {
        year: 2026, month: 10,
        posts: [
          { id: 1, caption: 'First fixture post caption', platforms: ['facebook'], image_url: null, status: 'draft' },
          { id: 2, caption: 'Second fixture post caption', platforms: ['instagram'], image_url: null, status: 'draft' },
        ],
      },
    })
  );
  app.get('/api/v1/portal/analytics', (_q, r) =>
    r.json({ ok: true, data: { internalEnabled: true, googleIds: [], visits: 128, clicks: 34, pages: [{ path: '/services', visits: 55 }], clickTypes: [{ kind: 'phone', count: 12 }], daily: [{ day: '2026-10-22', visits: 9, clicks: 2 }] } })
  );
  app.use('/api/v1/portal', (_q, r) => r.json({ ok: true, data: { plan: 'premium', plans: [], forms: [], modules: [], contacts: [], accounts: [], previewUrl: null } }));
  app.use((req, res, next) => {
    if ((req.path === '/portal' || req.path === '/portal.html') && NEGATIVE === 'gap') {
      let src = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
      // Strip the sibling-stack rule and zero the module-card grid gap:
      // Part 2 must go red on the GBP/SEO/Rentals stacks and the grid.
      src = src.replace(/#seo-host > \.panel \+ \.panel,[\s\S]*?margin-top: var\(--card-gap\);\n    \}\n/, '');
      src = src.replace(/(\.modules-side-nav \{[^}]*?)gap: var\(--card-gap\);/, '$1gap: 0;');
      res.type('text/html').send(src);
      return;
    }
    next();
  });
  app.get('/portal', (_q, r) => r.sendFile(path.join(root, 'public', 'portal.html')));
  app.use(express.static(path.join(root, 'public'), { index: false }));

  const MEASURE = (containerSel, itemSel) => {
    const box = document.querySelector(containerSel);
    if (!box) return { error: 'no container' };
    const els = [...box.querySelectorAll(itemSel)].filter((e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    });
    const rects = els.map((e) => {
      const r = e.getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom };
    });
    const gaps = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const vOv = Math.min(a.b, b.b) - Math.max(a.t, b.t);
        const hOv = Math.min(a.r, b.r) - Math.max(a.l, b.l);
        if (vOv > 4 && b.l >= a.r - 1 && b.l - a.r < 40) gaps.push(Math.round((b.l - a.r) * 10) / 10);
        if (hOv > 4 && b.t >= a.b - 1 && b.t - a.b < 40) gaps.push(Math.round((b.t - a.b) * 10) / 10);
      }
    }
    return { count: rects.length, gaps };
  };

  {
    let n = 0;
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await launch();
    try {
      for (const width of [1440, 980, 390]) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 1000 });
        await page.setRequestInterception(true);
        page.on('request', (r) => (r.url().startsWith(base) ? r.continue() : r.abort()));
        await page.goto(base + '/portal', { waitUntil: 'networkidle0', timeout: 30000 });
        await page.waitForSelector('#nav-website', { visible: true, timeout: 10000 });
        const navTo = async (panel, containerSel, itemSel) => {
          const w = await page.evaluate(() => window.innerWidth);
          if (w <= 900) {
            await page.click('#portal-menu-btn');
            // Batch 112 de-flake: the swallowed (.catch(() => {}))
            // waits are gone. The drawer-open wait follows the
            // Batch 107 suite's proven pattern: a click landing
            // mid-navigation can be swallowed, and since the button
            // toggles, exactly one retry click is the cure — verified
            // by the hard wait that follows, never assumed.
            const opened = await page
              .waitForFunction(() => document.getElementById('portal-shell').classList.contains('nav-open'), { timeout: 2500 })
              .then(() => true)
              .catch(() => false);
            if (!opened) {
              await page.click('#portal-menu-btn');
              await page.waitForFunction(() => document.getElementById('portal-shell').classList.contains('nav-open'), { timeout: 10000 });
            }
            await page.waitForFunction(() => document.getElementById('portal-sidebar').getBoundingClientRect().x >= -1, { timeout: 10000, polling: 100 });
          }
          await page.click('#nav-' + panel);
          // Batch 112 de-flake: was a fixed 700ms sleep — wait until
          // the panel's measured container actually holds cards.
          // The predicate mirrors MEASURE's own filter (sized +
          // displayed): a DOM-count wait can pass on cards inside a
          // still-hidden pane while MEASURE finds none (gate s3).
          if (containerSel) {
            await page.waitForFunction(
              (c, i) => {
                const el = document.querySelector(c);
                if (!el) return false;
                const vis = [...el.querySelectorAll(i)].filter((e) => {
                  const r = e.getBoundingClientRect();
                  const cs = getComputedStyle(e);
                  return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
                });
                return vis.length >= 2;
              },
              { timeout: 20000, polling: 100 },
              containerSel,
              itemSel
            );
          }
        };
        const expectStandard = async (label, c, i) => {
          const res = await page.evaluate(MEASURE, c, i);
          assert.ok(!res.error, `${label} @${width}: container present`);
          assert.ok(res.gaps.length >= 1, `${label} @${width}: at least one adjacent card pair (got ${JSON.stringify(res)})`);
          for (const g of res.gaps) {
            assert.ok(Math.abs(g - 16) <= 0.6, `${label} @${width}: adjacent gap ${g}px == 16px standard`);
            n += 1;
          }
        };

        await navTo('analytics', '#sec-analytics .portal-cards', ':scope > .panel');
        await expectStandard('portal-cards analytics', '#sec-analytics .portal-cards', ':scope > .panel');
        await navTo('referrals', '#sec-referrals .portal-cards', ':scope > .panel');
        await expectStandard('portal-cards referrals', '#sec-referrals .portal-cards', ':scope > .panel');
        await expectStandard('referral stat cards', '#sec-referrals .panel .row', ':scope > .stat-card');
        await expectStandard('referrals cards->panel stack', '#sec-referrals', ':scope > .portal-cards, :scope > .panel');
        await navTo('billing', '#sec-billing .portal-cards', ':scope > .panel');
        await expectStandard('portal-cards billing', '#sec-billing .portal-cards', ':scope > .panel');
        await expectStandard('plan grid', '#bill-plan-grid', ':scope > .plan-card');
        await navTo('seo', '#seo-host', ':scope > .panel');
        await expectStandard('seo panel stack (was 0px)', '#seo-host', ':scope > .panel');
        await navTo('gbp', '#gbp-host', ':scope > .panel');
        await expectStandard('gbp panel stack (was 0px)', '#gbp-host', ':scope > .panel');
        await navTo('rentals', '#rentals-host', ':scope > .panel');
        await expectStandard('rentals panel stack (was 0px)', '#rentals-host', ':scope > .panel');
        await navTo('changes', '#sec-changes', ':scope > .panel');
        await expectStandard('changes panel stack', '#sec-changes', ':scope > .panel');
        await navTo('social', '#sec-social', ':scope > .panel');
        await expectStandard('social panel stack', '#sec-social', ':scope > .panel');
        await expectStandard('social post list', '#post-list', ':scope > .post-card');
        await navTo('forms', '#forms-list', ':scope > .item-card');
        await expectStandard('forms item list', '#forms-list', ':scope > .item-card');
        // Batch 112 de-flake: was sleep(700), then a DOM-count wait,
        // then (s3 fix) an effect wait with a bare retry click — all
        // raced the module's own async render. Proven mechanics
        // (gate-container instrumentation, gate s3 + stress runs):
        // the chrome render re-hides the results pane (portal.js
        // updateModuleContentChrome sets results.hidden = true), so
        // a click landing before that render completes is undone by
        // it (pane display:none + hidden at measure time, 2 cards in
        // DOM, 0 visible), and a retry click during the re-render
        // hits a not-yet-clickable button. Sequence on real signals:
        // (1) wait for the render to settle — submission cards in
        // the DOM AND the default setup pane actually shown; (2)
        // click; (3) wait on the exact signal MEASURE needs — pane
        // shown AND >= 2 sized cards — with one effect-verified
        // retry click on a demonstrably clickable button if the
        // first click was still undone or swallowed.
        await page.waitForFunction(
          () => {
            const setup = document.getElementById('forms-pane-setup');
            if (!setup || setup.hidden || getComputedStyle(setup).display === 'none') return false;
            return document.querySelectorAll('#form-submissions > .post-card').length >= 2;
          },
          { timeout: 20000, polling: 100 }
        );
        await page.click('button[data-forms-pane="results"]');
        const resultsReady = () => {
          const pane = document.getElementById('forms-pane-results');
          if (!pane || pane.hidden || getComputedStyle(pane).display === 'none') return false;
          const cards = [...document.querySelectorAll('#form-submissions > .post-card')];
          if (cards.length < 2) return false;
          return cards.slice(0, 2).every((c) => {
            const r = c.getBoundingClientRect();
            const cs = getComputedStyle(c);
            return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
          });
        };
        const switched = await page
          .waitForFunction(resultsReady, { timeout: 2500, polling: 100 })
          .then(() => true)
          .catch(() => false);
        if (!switched) {
          await page.waitForSelector('button[data-forms-pane="results"]', { visible: true, timeout: 10000 });
          await page.click('button[data-forms-pane="results"]');
          await page.waitForFunction(resultsReady, { timeout: 20000, polling: 100 });
        }
        await expectStandard('form submission cards (were 8px)', '#form-submissions', ':scope > .post-card');
        await navTo('leadscout', '.leadscout-layout', ':scope > .panel');
        await expectStandard('leadscout layout panels', '.leadscout-layout', ':scope > .panel');
        await navTo('modules', '#modules-type-tabs', ':scope > .module-card');
        await expectStandard('module card grid (Batch 91)', '#modules-type-tabs', ':scope > .module-card');
        await expectStandard('modules item list', '#modules-items', ':scope > .item-card');
        await page.evaluate(() => {
          const cards = [...document.querySelectorAll('#modules-type-tabs .module-card')];
          const dt = cards.find((c) => /Data Tables/i.test(c.textContent));
          if (dt) dt.click();
        });
        // Batch 112 de-flake: was sleep(900) — wait for the settings
        // panel's cards to render, with MEASURE's own sized/visible
        // predicate (a DOM count can pass on hidden cards — gate s3).
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll('#modules-datatables-panel > .card')].filter((e) => {
              const r = e.getBoundingClientRect();
              const cs = getComputedStyle(e);
              return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
            }).length >= 2,
          { timeout: 20000, polling: 100 }
        );
        await expectStandard('datatables settings card stack', '#modules-datatables-panel', ':scope > .card');
        await navTo('mcp', '#mcp-app', ':scope > .panel');
        await page.evaluate(() => {
          const up = document.getElementById('mcp-upgrade');
          const app2 = document.getElementById('mcp-app');
          if (up) up.hidden = true;
          if (app2) app2.hidden = false;
        });
        // (Batch 112: the fixed sleep after this synchronous DOM
        // write is gone — page.evaluate applies it before returning.)
        await expectStandard('mcp panel stack', '#mcp-app', ':scope > .panel');
        await navTo('website');
        await page.evaluate(() => {
          const list = document.getElementById('structure-module-list');
          const btn = (label) =>
            `<button type="button"><span class="picker-card-icon tint-content"></span>${label}</button>`;
          list.innerHTML =
            `<div class="structure-block-group"><p class="hint" style="margin:0 0 8px">Design modules — Content</p>${btn('Heading')}${btn('Text')}${btn('Image')}${btn('Button')}</div>` +
            `<div class="structure-block-group"><p class="hint" style="margin:0 0 8px">Design modules — Layout</p>${btn('Columns')}${btn('Spacer')}</div>`;
          document.getElementById('structure-module-modal').hidden = false;
        });
        // (Batch 112: fixed sleep after the synchronous innerHTML
        // write removed — the write lands before evaluate returns.)
        await expectStandard('picker block-group cards (were 10px)', '.structure-block-group', ':scope > button');
        await page.close();
      }
    } finally {
      await browser.close();
      server.close();
    }
    group('Part 2 browser gap measurements (1440/980/390)', n);
  }

  console.log(`BATCH108 REGRESSION PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
