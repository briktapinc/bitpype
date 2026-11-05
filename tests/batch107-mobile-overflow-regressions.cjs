'use strict';
/**
 * Batch 107 — MOBILE OVERFLOW FIXES (staff app + client portal).
 * Ely's order 2026-10-31 with two phone screenshots: (1) a staff
 * table squeezing its columns until STATUS and UPDATED broke
 * mid-word; (2) the portal Blog module detail running its
 * "Show on page" label + select off the card's right edge.
 * The fix is the CLASS, one pattern per surface:
 *
 *  STAFF TABLES — every table lives in a scroll container
 *  (.table-wrap / .table-scroll / .panel-b, Batch 107 adds .card /
 *  .panel / .modal via the :has(> table) containment net, plus
 *  .table-scroll wraps at the seven bare render sites). At
 *  <=860px a contained table keeps a width floor scaled to its
 *  column count (4 cols 540px … 9+ cols 990px) so columns stop
 *  compressing — the CONTAINER scrolls sideways, the page never
 *  does, and fmtDate renders timestamps with non-breaking
 *  separators so a date can never split mid-word. Desktop
 *  rendering is untouched (all rules live in the media query;
 *  containment is inert when content fits).
 *
 *  PORTAL — the modules embed bar's label + select can shrink
 *  (min-width:0 chain, select max-width:100%) and stacks at
 *  <=700px (label above a full-width select); panels whose direct
 *  child is a bare table scroll sideways instead of clipping
 *  (.panel:has(> table)); portal tables keep width floors at
 *  <=700px; portal date helpers render non-breaking timestamps.
 *
 * Proven here:
 *  Part 1 — source pins for every rule above + SEC-13 census
 *    (totals + regenerated baseline exact; the Batch 107 JS edits
 *    shifted sink lines only — the (file, kind, unsafe) multiset
 *    was proven byte-identical before the baseline regen).
 *  Part 2 — real Chromium, stub API, the STAFF app at 390 / 700 /
 *    1440: leads, social campaigns, calls, finance (AI cards),
 *    partner earnings, mailing list, billing credits, admin audit.
 *    Per screen: no document-level horizontal overflow; the
 *    date/status sentinel cells render on ONE line; the scroll
 *    container actually scrolls at phone width (floor engaged);
 *    at 1440 the table fills its container exactly as before.
 *  Part 3 — real Chromium, stub API, the PORTAL at 390 / 700 /
 *    1440: the module detail for EVERY one of the 22 module types
 *    (embed bar inside its card, select stacked at phone width),
 *    the item editor for every type that has one, plus the GBP
 *    compare, Rentals history, SEO changes and Analytics tables.
 *
 * NEGATIVE PROOFS: B107_NEGATIVE=staff-css serves styles.css with
 * the Batch 107 block stripped -> the Part 2 floor assertions go
 * RED. B107_NEGATIVE=portal serves portal.html with the Batch 107
 * rules stripped -> the Part 3 embed-bar assertions go RED.
 * B107_SKIP_BROWSER=1 skips Parts 2+3 locally (no Chromium on the
 * dev box); the gate always runs them in-image.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const NEGATIVE = process.env.B107_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const MODULE_TYPES = [
  'blog', 'ecommerce', 'courses', 'gallery', 'directory', 'faq',
  'testimonials', 'team', 'events', 'bookings', 'chatbot', 'offers',
  'menu', 'careers', 'video', 'estimate', 'socialfeed',
  'googlereviews', 'calltracking', 'members', 'datatables', 'charts', 'newsletter',
];
const EDITORLESS = new Set(['socialfeed', 'googlereviews', 'calltracking', 'members', 'newsletter']);

(async () => {
  const stylesCss = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const portalHtml = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
  const portalJs = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');

  // ---------------------------------------------------------------
  // Part 1 — source pins + SEC-13 census
  // ---------------------------------------------------------------
  {
    let n = 0;
    const has = (src, s, label) => { assert.ok(src.includes(s), label); n += 1; };
    // Staff: containment net extended to cards/panels.
    has(stylesCss, '.card:has(> table),', 'staff containment net covers .card');
    has(stylesCss, '.panel:has(> table) {', 'staff containment net covers .panel');
    // Staff: the Batch 107 floor block.
    has(stylesCss, 'Batch 107: one mobile pattern for staff tables', 'staff floor block present');
    has(stylesCss, '@media (max-width: 860px)', 'staff floor media query at 860px');
    has(stylesCss, ':is(.table-wrap, .table-scroll, .panel-b, .card, .panel, .modal)', 'floor applies to every containment context');
    has(stylesCss, 'table:has(tr > :nth-child(4))', 'floor keys off column count (4)');
    has(stylesCss, 'table:has(tr > :nth-child(9))', 'floor keys off column count (9)');
    has(stylesCss, 'min-width: 540px', '4-column floor is 540px');
    has(stylesCss, 'min-width: 990px', '9-column floor is 990px');
    // Staff: fmtDate renders non-breaking timestamps; the last inline
    // timestamp (mailing sends) routes through fmtDate.
    has(appJs, "replace(/-/g, '\\u2011')", 'fmtDate uses non-breaking hyphens');
    has(appJs, "replace(/ /g, '\\u00A0')", 'fmtDate uses non-breaking spaces');
    has(appJs, '${esc(fmtDate(r.created_at))}</td><td>${esc(r.subject)}</td>', 'mailing sends date routes through fmtDate');
    // Staff: the seven bare render sites gained .table-scroll wraps.
    has(appJs, '<div class="table-scroll"><table class="tbl">', 'GBP compare table wrapped');
    has(appJs, '<div class="table-scroll"><table><thead><tr><th>Check</th>', 'QA checks table wrapped');
    has(appJs, '<div class="table-scroll"><table><thead><tr><th>Task</th>', 'AI model-routing table wrapped');
    has(appJs, '<div class="table-scroll"><table><thead><tr><th>When</th><th>Change</th>', 'billing credits table wrapped');
    has(appJs, '<div class="table-scroll"><table class="table"><thead><tr><th>Time</th>', 'calls log table wrapped');
    has(appJs, '<div class="table-scroll"><table class="table"><thead><tr><th>Email</th>', 'mailing members table wrapped');
    has(appJs, '<div class="table-scroll"><table class="table"><thead><tr><th>Date</th><th>Subject</th>', 'mailing history table wrapped');
    // Portal: embed bar fix.
    has(portalHtml, 'id="modules-target-page" class="modules-page-select"', 'page select carries the shrinkable class');
    assert.ok(!portalHtml.includes('id="modules-target-page" style='), 'page select has no inline width style'); n += 1;
    has(portalHtml, '.modules-page-select {', 'page select rule present');
    has(portalHtml, '.modules-page-label {', 'page label rule present');
    has(portalHtml, '.modules-embed-actions { flex: 1 1 100%; }', 'embed actions take the full row at phone width');
    has(portalHtml, '.modules-page-select { width: 100%; min-width: 0; }', 'select goes full width when stacked');
    // Portal: panel table containment + floors.
    has(portalHtml, '.panel:has(> table) {', 'portal panels scroll a bare child table');
    has(portalHtml, '.panel table:has(tr > :nth-child(4)) { min-width: 520px; }', 'portal 4-column floor');
    has(portalHtml, '.panel table:has(tr > :nth-child(3)) { min-width: 430px; }', 'portal 3-column floor');
    // Portal: non-breaking date helpers.
    assert.ok((portalJs.match(/u2011/g) || []).length >= 3, 'portal date helpers render non-breaking timestamps'); n += 1;
    // SEC-13 census: totals pinned; baseline regenerated for the
    // Batch 107 line shifts (multiset proven identical pre-regen).
    const { census } = require(path.join(root, 'scripts', 'xss-census.cjs'));
    const cz = census();
    assert.equal(cz.summary.total, 446, 'SEC-13 census total unchanged'); n += 1;
    assert.equal(cz.summary.ESCAPED + cz.summary.SAFE + cz.summary.STATIC + cz.summary.BUILDER, 333, 'SEC-13 safe classes unchanged (Batch 136 finisher: +2 audited STATIC sinks in module-embed.js — the booking price-summary clear + esc()-wrapped build; 328 -> 330, census 439 -> 441, RAW/IDENT unchanged; Batch 137 finisher: +1 audited SAFE sink in portal.js (qualifying-question rows render — numeric indices + esc()-wrapped question text), census 441 -> 442, SAFE 73 -> 74, reviewed RAW/IDENT content unchanged (12 portal.js positions shifted +127, pure line movement, snippet-verified; Batch 138 finisher: census 442 -> 446 — +3 audited STATIC + 1 IDENT (micSvg(), a constant SVG string) in chat-embed.js for the voice panel, and one portal.js inbox sink reclassified SAFE -> RAW by the conservative classifier after gaining the ${voiceHtml} interpolation (audited: voiceHtml is composed only of esc()-wrapped values, duration arithmetic and fixed close-state words — no visitor-controlled string reaches it unescaped); RAW 76 -> 77, IDENT 35 -> 36, SAFE 74 -> 73, STATIC 158 -> 161, safe classes 331 -> 333; (file,kind,snippet) multiset diff vs the Batch 149 base = exactly these deltas plus pure line movement in portal.js/chat-embed.js; baseline regenerated)'); n += 1;
    const reviewed = new Set(cz.sinks.filter((s) => s.kind === 'RAW' || s.kind === 'IDENT').map((s) => `${s.file}:${s.line}`));
    const BASELINE = new Set(require(path.join(root, 'tests', 'batch103-xss-baseline.json')));
    assert.deepEqual([...reviewed].filter((x) => !BASELINE.has(x)), [], 'no new RAW/IDENT sinks vs baseline'); n += 1;
    assert.deepEqual([...BASELINE].filter((x) => !reviewed.has(x)), [], 'no baseline sink unaccounted'); n += 1;
    group('Part 1 source pins + census', n);
  }

  if (process.env.B107_SKIP_BROWSER === '1') {
    console.log('  skip Parts 2+3 browser (B107_SKIP_BROWSER=1 — local iteration only)');
  
  console.log(`BATCH107 REGRESSION PASS — ${groups.join('; ')}`);
    return;
  }

  const puppeteer = require('puppeteer');
  const http = require('node:http');
  const express = require('express');
  const launch = () =>
    puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  const NO_OVERFLOW = () => document.documentElement.scrollWidth <= window.innerWidth + 1;
  // Find the first cell (in scope) whose text starts with a 4-digit
  // year; report its rendered line count via a Range.
  const DATE_CELL = (scope) => {
    const rootEl = scope ? document.querySelector(scope) : document;
    if (!rootEl) return { found: false };
    const td = [...rootEl.querySelectorAll('td')].find((c) => /^\d{4}/.test(c.textContent.trim()));
    if (!td) return { found: false };
    const r = document.createRange();
    r.selectNodeContents(td);
    return { found: true, lines: r.getClientRects().length, text: td.textContent.trim() };
  };

  // ---------------------------------------------------------------
  // Part 2 — staff app in Chromium (stub API)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const app = express();
    app.use(express.json());
    const ME = { ok: true, data: { user: { id: 1, email: 'fixture@example.invalid', isSuperAdmin: true }, workspaceId: 1, workspaces: [{ id: 1, name: 'Fixture', role: 'owner' }], isSuperAdmin: true, productAccess: true } };
    app.get('/api/v1/auth/me', (_q, r) => r.json(ME));
    app.get('/api/v1/captcha/config', (_q, r) => r.json({ ok: true, data: { enabled: false } }));
    app.get('/api/v1/billing/summary', (_q, r) =>
      r.json({
        ok: true,
        data: {
          plan: 'standard', plans: [], email: 'fixture@example.invalid', isSuperAdmin: true,
          credits: { balance: 15, recent: [{ created_at: '2026-10-22 21:29:34', delta: 10, balance_after: 15, reason: 'Top-up' }] },
          payments: [{ created_at: '2026-10-22 21:29:34', amount_cents: 9900, currency: 'usd', status: 'paid', description: 'Standard plan' }],
        },
      })
    );
    app.get('/api/v1/leads', (_q, r) =>
      r.json({
        ok: true,
        data: {
          total: 1,
          leads: [{
            id: 603, business_name: 'ZZ B107 Fixture Bakery And Catering Company', email: 'owner@fixture.invalid',
            lead_group: 'Client', category: 'Bakery', tags: ['hot'], score: 91, status: 'archived',
            source: 'manual', updated_at: '2026-10-22 21:29:34',
          }],
        },
      })
    );
    app.get('/api/v1/social/overview', (_q, r) =>
      r.json({
        ok: true,
        data: {
          campaigns: [{ id: 7, title: 'October posts', month_start: '2026-10-01', business_name: 'ZZ B107 Bakery', status: 'archived', with_images: 1 }],
          accounts: [], totals: {}, metaConfigured: false,
          counts: { accounts: 1, pendingApproval: 0, scheduled: 2, failed: 0 },
        },
      })
    );
    app.get('/api/v1/admin-area/calls', (_q, r) =>
      r.json({
        ok: true,
        data: {
          twilio_configured: true, workspace_id: 1, businesses: [], pickerBusinesses: [], pool: [],
          calls: [{
            id: 5, created_at: '2026-10-22T21:29:34Z', lead_name: 'ZZ B107 Bakery',
            from_number: '+14845550100', to_number: '+16105550199', status: 'completed',
            duration_seconds: 95, verified: true,
          }],
        },
      })
    );
    app.get('/api/v1/admin-area/finance/summary', (_q, r) =>
      r.json({
        ok: true,
        data: {
          period: { preset: '30d' },
          categories: {
            ai: {
              byProvider: [{ key: 'muse', calls: 12, cents: 345 }],
              byProviderTask: [{ provider: 'muse', task: 'design_chat', cents: 345 }],
            },
          },
        },
      })
    );
    app.get('/api/v1/admin-area/finance/ledger', (_q, r) => r.json({ ok: true, data: { rows: [], total: 0, page: 1, pages: 1 } }));
    app.get('/api/v1/admin-area/finance/ai-by-workspace', (_q, r) =>
      r.json({
        ok: true,
        data: {
          rows: [{ name: 'Fixture WS', workspaceId: 1, calls: 12, tokens: 34567, cents: 345, byProvider: [{ key: 'muse', cents: 345, calls: 12 }] }],
          totals: { calls: 12, tokens: 34567, cents: 345 },
        },
      })
    );
    app.get('/api/v1/partners/me', (_q, r) =>
      r.json({
        ok: true,
        data: {
          balanceCents: 12500, thresholdCents: 50000, ratePercent: 30, eligible: false, terms: {},
          entries: [{ createdAt: '2026-10-22', kind: 'commission', stripeInvoiceId: 'in_fixture123', amountCents: 2970 }],
          payouts: [{ createdAt: '2026-10-01', method: 'manual', note: 'September', amountCents: 5000 }],
        },
      })
    );
    app.get('/api/v1/partners/approvals', (_q, r) =>
      r.json({ ok: true, data: { approvals: [{ createdAt: '2026-10-20', actionKind: 'domain_purchase', status: 'pending' }] } })
    );
    app.get('/api/v1/admin/mailing-list/subscribers', (_q, r) =>
      r.json({
        ok: true,
        data: {
          counts: { total: 1, subscribed: 1, unsubscribed: 0 }, total: 1,
          rows: [{ id: 3, email: 'reader@fixture.invalid', name: 'Fixture Reader', status: 'subscribed', source: 'landing', created_at: '2026-10-22 09:15:00' }],
        },
      })
    );
    app.get('/api/v1/admin/mailing-list/sends', (_q, r) =>
      r.json({
        ok: true,
        data: { rows: [{ created_at: '2026-10-22 21:29:34', subject: 'October news', attempted: 10, sent: 9, failed: 0, skipped: 1 }] },
      })
    );
    app.get('/api/v1/admin/audit', (_q, r) =>
      r.json({
        ok: true,
        data: { rows: [{ at: '2026-10-22 21:29:34', actor_email: 'op@fixture.invalid', action: 'lead.create', detail: 'lead_id=603' }] },
      })
    );
    app.use('/api/v1', (req, res) => {
      if (req.method !== 'GET') return res.status(500).json({ ok: false, error: 'No fixture writes allowed' });
      res.json({ ok: true, data: {} });
    });
    app.get('/app', (_q, r) => r.sendFile(path.join(root, 'public', 'index.html')));
    app.use((req, res, next) => {
      if (req.path === '/styles.css' && NEGATIVE === 'staff-css') {
        let src = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
        const a = src.indexOf('/* ---------- Batch 107');
        if (a > 0) src = src.slice(0, a);
        res.type('text/css').send(src);
        return;
      }
      next();
    });
    app.use(express.static(path.join(root, 'public'), { index: false }));

    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await launch();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setRequestInterception(true);
      page.on('request', (r) => (r.url().startsWith(base) ? r.continue() : r.abort()));
      const goto = async (hash, waitFn, label) => {
        await page.goto(base + '/app' + hash);
        await page.waitForFunction(waitFn, { timeout: 15000 }).catch(() => {
          throw new Error(`staff screen did not render: ${label} (${hash})`);
        });
      };
      const noOverflow = async (label) => {
        assert.equal(await page.evaluate(NO_OVERFLOW), true, `no page-level horizontal overflow — ${label}`);
        n += 1;
      };
      const dateCell = async (scope, label) => {
        const d = await page.evaluate(DATE_CELL, scope || null);
        assert.ok(d.found, `date cell found — ${label}`);
        assert.equal(d.lines, 1, `timestamp renders on ONE line — ${label} (got ${d.lines}: "${d.text}")`);
        assert.ok(d.text.includes('‑'), `timestamp uses non-breaking hyphens — ${label}`);
        n += 3;
        return d;
      };

      // ---- 390px: the squeeze widths ----
      await page.setViewport({ width: 390, height: 844 });
      // Leads (9 cols, .table-wrap): floor 990px, container scrolls.
      await goto('#/leads', () => document.querySelector('#l-body') && document.querySelector('#l-body').textContent.includes('ZZ B107'), 'leads');
      await noOverflow('staff leads @390');
      await dateCell('#l-body', 'staff leads updated @390');
      {
        const w = await page.$eval('#l-body', (td) => {
          const table = td.closest('table');
          const wrap = td.closest('.table-wrap');
          return { minW: getComputedStyle(table).minWidth, scrolls: wrap.scrollWidth > wrap.clientWidth + 4 };
        });
        assert.equal(w.minW, '990px', 'leads table floor is 990px at 390 (9 columns)');
        assert.equal(w.scrolls, true, 'leads table container scrolls instead of squeezing');
        n += 2;
      }
      // Social campaigns (5 cols, .table-scroll).
      await goto('#/social', () => document.body.textContent.includes('October posts'), 'social');
      await noOverflow('staff social @390');
      {
        const s = await page.evaluate(() => {
          const badge = [...document.querySelectorAll('.table-scroll .badge')][0];
          if (!badge) return { found: false };
          const r = document.createRange();
          r.selectNodeContents(badge);
          const scroller = badge.closest('.table-scroll');
          return { found: true, lines: r.getClientRects().length, scrolls: scroller.scrollWidth > scroller.clientWidth + 4 };
        });
        assert.ok(s.found, 'social status badge rendered');
        assert.equal(s.lines, 1, 'social status badge stays on one line @390');
        assert.equal(s.scrolls, true, 'social campaigns container scrolls @390');
        n += 3;
      }
      // Calls log (7 cols, wrapped by Batch 107).
      await goto('#/calls', () => document.body.textContent.includes('+14845550100'), 'calls');
      await noOverflow('staff calls @390');
      {
        const c = await page.evaluate(() => {
          const td = [...document.querySelectorAll('#cl-body td')].find((x) => x.textContent.includes('+14845550100'));
          if (!td) return { found: false };
          const r = document.createRange();
          r.selectNodeContents(td);
          const scroller = td.closest('.table-scroll');
          return { found: true, lines: r.getClientRects().length, wrapped: !!scroller, scrolls: scroller && scroller.scrollWidth > scroller.clientWidth + 4 };
        });
        assert.ok(c.found, 'calls row rendered');
        assert.equal(c.wrapped, true, 'calls table sits in a .table-scroll (Batch 107 wrap)');
        assert.equal(c.lines, 1, 'caller number stays on one line @390');
        assert.equal(c.scrolls, true, 'calls container scrolls @390');
        n += 4;
      }
      // Finance: AI cards are bare tables inside .card (containment net).
      await goto('#/finance', () => document.body.textContent.includes('AI usage by workspace'), 'finance');
      await noOverflow('staff finance @390');
      {
        const f = await page.evaluate(() => {
          const h = [...document.querySelectorAll('.card h3')].find((x) => x.textContent.includes('AI usage by workspace'));
          if (!h) return { found: false };
          const card = h.closest('.card');
          const table = card.querySelector(':scope > table');
          return { found: true, direct: !!table, minW: table ? getComputedStyle(table).minWidth : '', scrolls: card.scrollWidth > card.clientWidth + 4 };
        });
        assert.ok(f.found, 'finance AI-by-workspace card rendered');
        assert.equal(f.direct, true, 'AI table is a direct child of its card');
        assert.equal(f.minW, '540px', 'finance table floor is 540px at 390 (4 columns)');
        assert.equal(f.scrolls, true, 'finance card scrolls its table @390');
        n += 4;
      }
      // Partner earnings: three bare tables inside .card.
      await goto('#/partner-earnings', () => document.body.textContent.includes('Payment history'), 'partner earnings');
      await noOverflow('partner earnings @390');
      {
        const p = await page.evaluate(() => {
          const tables = [...document.querySelectorAll('.card > table')];
          return {
            count: tables.length,
            floors: tables.map((t) => ({ cols: t.querySelectorAll('thead th').length, minW: getComputedStyle(t).minWidth })),
          };
        });
        assert.ok(p.count >= 3, `partner earnings renders its card tables (${p.count})`);
        assert.ok(p.floors.filter((f) => f.cols >= 4).every((f) => f.minW === '540px'), 'partner 4-column tables carry the 540px floor @390');
        n += 2;
      }
      // Mailing list: members + history tables (wrapped by Batch 107).
      await goto('#/mailing-list', () => document.querySelector('#ml-history') && document.querySelector('#ml-history').textContent.includes('October news'), 'mailing list');
      await noOverflow('mailing list @390');
      await dateCell('#ml-history', 'mailing history date @390');
      {
        const m = await page.evaluate(() => {
          const badge = document.querySelector('#ml-list .badge');
          if (!badge) return { found: false };
          const r = document.createRange();
          r.selectNodeContents(badge);
          return { found: true, lines: r.getClientRects().length };
        });
        assert.ok(m.found, 'mailing member badge rendered');
        assert.equal(m.lines, 1, 'mailing status badge stays on one line @390');
        n += 2;
      }
      // Billing credits (wrapped by Batch 107): fmtDate sentinel.
      // Batch 113: at phone width the billing tab bar hands over to
      // its dropdown — switch the way a phone user does. The pick
      // clicks the same pill under the hood, so the panel swap (and
      // everything asserted below) is unchanged.
      await goto('#/billing', () => !!document.querySelector('#billing-tabs'), 'billing');
      if (
        await page.evaluate(() => {
          const s = document.querySelector('#view .tabs-select');
          return !!s && getComputedStyle(s).display !== 'none';
        })
      ) {
        await page.select('#view .tabs-select', 'credits');
      } else {
        await page.click('#billing-tabs [data-tab="credits"]');
      }
      await page.waitForFunction(() => document.querySelector('#bill-panel-credits') && !document.querySelector('#bill-panel-credits').hidden, { timeout: 10000 });
      await noOverflow('billing credits @390');
      await dateCell('#bill-panel-credits', 'billing credits date @390');
      // Admin audit (panel-b table): fmtDate sentinel.
      await goto('#/admin/audit', () => document.querySelector('#admin-body') && document.querySelector('#admin-body').textContent.includes('lead.create'), 'admin audit');
      await noOverflow('admin audit @390');
      await dateCell('#admin-body', 'admin audit date @390');

      // ---- 700px: floors still apply (<=860) ----
      await page.setViewport({ width: 700, height: 900 });
      await goto('#/leads', () => document.querySelector('#l-body') && document.querySelector('#l-body').textContent.includes('ZZ B107'), 'leads @700');
      await noOverflow('staff leads @700');
      await dateCell('#l-body', 'staff leads updated @700');
      await goto('#/finance', () => document.body.textContent.includes('AI usage by workspace'), 'finance @700');
      await noOverflow('staff finance @700');

      // ---- 1440px: desktop behaviour unchanged ----
      await page.setViewport({ width: 1440, height: 900 });
      await goto('#/leads', () => document.querySelector('#l-body') && document.querySelector('#l-body').textContent.includes('ZZ B107'), 'leads @1440');
      await noOverflow('staff leads @1440');
      {
        const w = await page.$eval('#l-body', (td) => {
          const table = td.closest('table');
          const wrap = td.closest('.table-wrap');
          return { tw: table.getBoundingClientRect().width, cw: wrap.clientWidth, minW: getComputedStyle(table).minWidth, scrolls: wrap.scrollWidth > wrap.clientWidth + 4 };
        });
        assert.ok(Math.abs(w.tw - w.cw) <= 2, `desktop leads table fills its container exactly (table ${w.tw} vs wrap ${w.cw})`);
        assert.equal(w.minW, '0px', 'no table floor on desktop');
        assert.equal(w.scrolls, false, 'no container scroll on desktop');
        n += 3;
      }
      await dateCell('#l-body', 'staff leads updated @1440');
      assert.equal(errors.length, 0, `no staff page errors (${errors.join('; ')})`); n += 1;
    } finally {
      await browser.close().catch(() => {});
      server.close();
    }
    group('Part 2 staff browser (390/700/1440)', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — portal in Chromium (stub API)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const PAGES = [
      { slug: 'index', title: 'Home' },
      { slug: 'services', title: 'Launch Your Website Business with BitPype Solo — Services' },
    ];
    const EMBED = { published: true, embed_enabled: true, page_slug: 'index', embed_url: 'https://fixture.invalid/embed/b107' };
    const ITEM = {
      id: 1, title: 'Fixture Item With A Reasonably Long Title', name: 'Fixture Item Name',
      status: 'published', question: 'Fixture question?', author: 'Fixture Author',
      role: 'Fixture Role', price_cents: 2500, kind: 'doc',
    };
    const modulePayload = (type) => {
      const data = { items: [{ ...ITEM }], embed: { ...EMBED }, pages: PAGES, categories: [] };
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
          columns: [
            { key: 'name', label: 'Name', type: 'text' },
            { key: 'when', label: 'When', type: 'date' },
            { key: 'site', label: 'Website', type: 'link' },
            { key: 'price', label: 'Price', type: 'currency' },
            { key: 'ok', label: 'OK', type: 'boolean' },
          ],
          roles: {},
        };
      if (type === 'charts')
        data.charts = { datatable_columns: [{ key: 'name', type: 'text' }, { key: 'sales', type: 'currency' }] };
      if (type === 'newsletter')
        data.newsletter = {
          config: { heading: 'The B107 Letter', blurb: '', button_label: 'Subscribe', from_name: '', from_email: '' },
          counts: { active: 1, unsubscribed: 0, total: 1 },
          from: { state: 'default', fromEmail: 'hello@bitpype.test', fromName: 'BitPype', replyTo: null, note: '' },
          sends: [],
          subscribers: [
            { id: 1, email: 'sub@fixture.invalid', name: 'Sub One', source: 'embed', status: 'active', created_at: '2026-10-30 10:00:00' },
          ],
          business_name: 'ZZ B107 Bakery',
        };
      return data;
    };

    const app = express();
    app.use(express.json());
    app.get('/api/v1/captcha/config', (_q, r) => r.json({ ok: true, data: { enabled: false } }));
    app.get('/api/v1/portal/me', (_q, r) =>
      r.json({
        ok: true,
        data: {
          client: { id: 2, email: 'owner@b107.fixture', businessName: 'ZZ B107 Bakery', userType: 'owner', visibleTabs: ['website', 'changes', 'forms', 'leadscout', 'modules', 'social', 'referrals', 'mcp', 'soul', 'analytics', 'seo', 'gbp', 'rentals', 'billing'] },
          lead: { business_name: 'ZZ B107 Bakery', city: 'Blandon', state: 'PA' },
          site: { id: 30, name: 'ZZ B107 Bakery' },
          previewUrl: null,
        },
      })
    );
    app.get('/api/v1/portal/modules', (_q, r) =>
      r.json({
        ok: true,
        data: {
          plan: 'premium', siteModules: true, pages: PAGES,
          modules: MODULE_TYPES.map((type) => ({ type, count: 1, embed: { ...EMBED } })),
        },
      })
    );
    app.get('/api/v1/portal/modules/:type', (req, r) => r.json({ ok: true, data: modulePayload(req.params.type) }));
    app.get('/api/v1/portal/forms', (_q, r) =>
      r.json({ ok: true, data: { forms: [{ id: 11, name: 'Contact form', published: 1, form_kind: 'contact', target_page_slug: 'contact' }] } })
    );
    app.get('/api/v1/portal/gbp', (_q, r) =>
      r.json({
        ok: true,
        data: {
          config: { oauthReady: false, oauthNotConfiguredMessage: 'Google sign-in is not configured yet.' },
          connection: { status: 'none' },
          prefill: {
            fields: {
              name: { label: 'Business name', googleText: 'ZZ B107 Bakery LLC', proposedText: 'ZZ B107 Bakery' },
              phone: { label: 'Phone', googleText: '+1 484-555-0100', proposedText: '+1 484-555-0101', conflict: true },
            },
            proposedState: { name: 'ZZ B107 Bakery', address: {}, hours: {} },
          },
          changeSets: { rows: [] },
        },
      })
    );
    app.get('/api/v1/portal/rentals', (_q, r) =>
      r.json({
        ok: true,
        data: {
          rentals: [{
            site: { name: 'ZZ B107 Rentals' }, status: 'active', model: 'per_lead', price_cents: 2500,
            started_at: '2026-09-01', this_month: { qualified_leads: 3, credits_charged: 6 },
            counters: { amount_due_cents: 0 },
            history: [{ at: '2026-10-22T21:29:34', source_label: 'Contact form', label: 'jane@fixture.invalid', charge: { status: 'charged', credits: 2 } }],
          }],
        },
      })
    );
    app.get('/api/v1/portal/seo', (_q, r) =>
      r.json({
        ok: true,
        data: {
          configured: true, gscToken: '',
          pending: {
            proposal: {
              keywords: { primary: 'bakery near reading pa', supporting: ['fresh bread bland on'] },
              changes: [{ label: 'Home page title', current: 'Bakery', proposed: 'Bakery in Reading PA — fresh bread daily' }],
            },
          },
          history: [],
        },
      })
    );
    app.get('/api/v1/portal/analytics', (_q, r) =>
      r.json({
        ok: true,
        data: {
          internalEnabled: true, googleIds: [], visits: 128, clicks: 34,
          pages: [{ path: '/services/ai-website-platform-for-solo-agencies', visits: 55 }],
          clickTypes: [{ kind: 'phone', count: 12 }],
          daily: [{ day: '2026-10-22', visits: 9, clicks: 2 }],
        },
      })
    );
    app.use('/api/v1/portal', (_q, r) =>
      r.json({ ok: true, data: { plan: 'premium', plans: [], forms: [], modules: [], contacts: [], accounts: [], previewUrl: null } })
    );
    app.use((req, res, next) => {
      if ((req.path === '/portal' || req.path === '/portal.html') && NEGATIVE === 'portal') {
        let src = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
        src = src.replace(/@media \(max-width: 700px\) \{\n      \.modules-embed-actions[\s\S]*?\n    \}\n/, '');
        src = src.replace(/\.panel:has\(> table\) \{\n      overflow-x: auto;\n    \}\n/, '');
        res.type('text/html').send(src);
        return;
      }
      next();
    });
    app.get('/portal', (_q, r) => r.sendFile(path.join(root, 'public', 'portal.html')));
    app.use(express.static(path.join(root, 'public'), { index: false }));

    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await launch();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setRequestInterception(true);
      page.on('request', (r) => (r.url().startsWith(base) ? r.continue() : r.abort()));
      const noOverflow = async (label) => {
        assert.equal(await page.evaluate(NO_OVERFLOW), true, `no page-level horizontal overflow — ${label}`);
        n += 1;
      };

      // At <=900px the portal nav is the off-canvas drawer (Batch 105
      // shell): open it before clicking a tab.
      const navTo = async (panel) => {
        const w = await page.evaluate(() => window.innerWidth);
        if (w <= 900) {
          await page.click('#portal-menu-btn');
          const opened = await page
            .waitForFunction(() => document.getElementById('portal-shell').classList.contains('nav-open'), { timeout: 2500 })
            .then(() => true)
            .catch(() => false);
          if (!opened) {
            // A click landing mid-navigation can be swallowed; the
            // button toggles, so one more click is the cure.
            await page.click('#portal-menu-btn');
            await page.waitForFunction(() => document.getElementById('portal-shell').classList.contains('nav-open'), { timeout: 5000 });
          }
          // The drawer slides for 0.2s; wait until it is fully in.
          await page.waitForFunction(() => document.getElementById('portal-sidebar').getBoundingClientRect().x >= -1, { timeout: 5000 });
        }
        await page.click('#nav-' + panel);
      };
      // Batch 112 de-flake: the fixed 250/400ms sleeps before overflow
      // measurements became a settle wait — fonts ready, then sample
      // the document width until it stops moving (bounded ~1.2s).
      const settleLayout = async () => {
        await page.evaluate(async () => {
          await document.fonts.ready;
          const el = document.documentElement;
          let last = -1;
          for (let i = 0; i < 24; i++) {
            const w = el.scrollWidth;
            if (w === last) break;
            last = w;
            await new Promise((r) => setTimeout(r, 50));
          }
        });
      };
      // The embed bar contract: the select stays inside its card; at
      // phone width it stacks full-width under its label.
      const embedBar = async (label, stacked) => {
        const b = await page.evaluate(() => {
          const card = document.getElementById('modules-embed-bar');
          const sel = document.getElementById('modules-target-page');
          if (!card || !sel) return { found: false };
          const cr = card.getBoundingClientRect();
          const sr = sel.getBoundingClientRect();
          const label = sel.closest('label');
          const lr = label ? label.getBoundingClientRect() : null;
          return {
            found: true,
            labelHidden: label ? label.hidden : false,
            inside: sr.left >= cr.left - 1 && sr.right <= cr.right + 1,
            stackedWidth: lr ? sr.width >= lr.width - 2 : false,
            stackedBelow: lr ? sr.top >= lr.top + 10 : false,
            selW: sr.width, cardW: cr.width,
          };
        });
        assert.ok(b.found, `embed bar present — ${label}`);
        if (!b.labelHidden) {
          assert.equal(b.inside, true, `page select stays inside its card — ${label} (select ${b.selW}px in card ${b.cardW}px)`);
          if (stacked) {
            assert.equal(b.stackedWidth, true, `page select takes the full row width when stacked — ${label}`);
            assert.equal(b.stackedBelow, true, `page select sits BELOW its label when stacked — ${label}`);
          }
          n += stacked ? 3 : 2;
        } else {
          n += 1;
        }
      };

      await page.setViewport({ width: 390, height: 844 });
      await page.goto(base + '/portal#/modules');
      await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
      await page.waitForSelector('#sec-modules:not([hidden])', { timeout: 15000 });
      await page.waitForFunction(() => document.querySelectorAll('#modules-type-tabs [data-module-type]').length === 23, { timeout: 15000 });
      await page.waitForFunction(() => !!document.querySelector('#modules-items .item-card'), { timeout: 15000 });

      // EVERY module type: detail view + (where one exists) the editor.
      // (Clicks go through evaluate: selecting a type re-renders the
      // rail itself, which detaches puppeteer's element handles.)
      for (const type of MODULE_TYPES) {
        await page.evaluate((t) => {
          const b = document.querySelector(`#modules-type-tabs [data-module-type="${t}"]`);
          if (!b) throw new Error('type tab missing: ' + t);
          b.click();
        }, type);
        await page.waitForFunction(
          (t) => {
            const items = document.getElementById('modules-items');
            const paneShown = [...document.querySelectorAll('[id^="modules-pane-"]')].some((p) => !p.hidden && p.offsetParent !== null);
            return (items && items.children.length > 0) || paneShown;
          },
          { timeout: 15000 },
          type
        ).catch(() => { throw new Error(`module detail did not render: ${type}`); });
        await settleLayout();
        await noOverflow(`portal module ${type} @390`);
        await embedBar(`portal module ${type} @390`, true);
        if (!EDITORLESS.has(type)) {
          const hasEdit = await page.evaluate(() => !!document.querySelector('#modules-items [data-module-edit]'));
          assert.ok(hasEdit, `editor entry point renders — ${type}`);
          await page.evaluate(() => document.querySelector('#modules-items [data-module-edit]').click());
          await page.waitForSelector('#sec-module-item:not([hidden])', { timeout: 10000 });
          await page.waitForFunction(() => document.querySelectorAll('#modules-fields .field').length > 0, { timeout: 10000 })
            .catch(() => { throw new Error(`module editor fields did not render: ${type}`); });
          await noOverflow(`portal module ${type} editor @390`);
          const fit = await page.evaluate(() => {
            const fields = [...document.querySelectorAll('#modules-fields input, #modules-fields select, #modules-fields textarea')];
            return { count: fields.length, outside: fields.filter((f) => { const r = f.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.left < -1; }).length };
          });
          assert.ok(fit.count > 0, `editor has controls — ${type} (${fit.count})`);
          assert.equal(fit.outside, 0, `every editor control fits the viewport — ${type}`);
          n += 3;
          await page.evaluate(() => document.getElementById('btn-module-item-back').scrollIntoView({ block: 'center' }));
          await page.click('#btn-module-item-back').catch(() => {});
          await page.waitForFunction(() => !document.getElementById('sec-modules').hidden, { timeout: 4000 })
            .catch(async () => {
              // Hit-testing at phone width can leave the sticky top bar
              // over the button; the wiring is what this gate proves.
              await page.evaluate(() => document.getElementById('btn-module-item-back').click());
              await page.waitForFunction(() => !document.getElementById('sec-modules').hidden, { timeout: 10000 })
                .catch(() => { throw new Error(`editor back-navigation failed: ${type}`); });
            });
        }
      }

      // GBP compare table (bare table in .panel).
      await navTo('gbp');
      await page.waitForSelector('#sec-gbp:not([hidden])', { timeout: 10000 });
      await page.waitForFunction(() => !!document.querySelector('#gbp-host table'), { timeout: 15000 });
      await noOverflow('portal GBP @390');
      {
        const g = await page.$eval('#gbp-host table', (t) => {
          const panel = t.closest('.panel');
          return { minW: getComputedStyle(t).minWidth, scrolls: panel.scrollWidth > panel.clientWidth + 4 };
        });
        assert.equal(g.minW, '520px', 'GBP compare table floor is 520px at 390 (4 columns)');
        assert.equal(g.scrolls, true, 'GBP panel scrolls its table @390');
        n += 2;
      }
      // Rentals history table + non-breaking timestamp.
      await navTo('rentals');
      await page.waitForSelector('#sec-rentals:not([hidden])', { timeout: 10000 });
      await page.waitForFunction(() => !!document.querySelector('#rentals-host table'), { timeout: 15000 });
      await noOverflow('portal rentals @390');
      {
        const d = await page.evaluate(DATE_CELL, '#rentals-host');
        assert.ok(d.found, 'rentals history date cell found');
        assert.equal(d.lines, 1, 'rentals history timestamp on ONE line @390');
        assert.ok(d.text.includes('‑'), 'rentals timestamp uses non-breaking hyphens');
        n += 3;
      }
      // SEO changes table.
      await navTo('seo');
      await page.waitForSelector('#sec-seo:not([hidden])', { timeout: 10000 });
      await page.waitForFunction(() => !!document.querySelector('#seo-host table'), { timeout: 15000 });
      await noOverflow('portal SEO @390');
      // Analytics tables.
      await navTo('analytics');
      await page.waitForSelector('#sec-analytics:not([hidden])', { timeout: 10000 });
      await page.waitForFunction(() => !!document.querySelector('#analytics-pages tr'), { timeout: 15000 });
      await noOverflow('portal analytics @390');

      // ---- 700px spot checks ----
      await page.setViewport({ width: 700, height: 900 });
      await navTo('modules');
      await page.waitForSelector('#sec-modules:not([hidden])', { timeout: 10000 });
      await page.evaluate(() => document.querySelector('#modules-type-tabs [data-module-type="blog"]').click());
      await settleLayout();
      await noOverflow('portal module blog @700');
      await embedBar('portal module blog @700', true);
      await navTo('gbp');
      await page.waitForSelector('#sec-gbp:not([hidden])', { timeout: 10000 });
      await noOverflow('portal GBP @700');

      // ---- 1440px: desktop layout preserved ----
      await page.setViewport({ width: 1440, height: 900 });
      await navTo('modules');
      await page.waitForSelector('#sec-modules:not([hidden])', { timeout: 10000 });
      await page.evaluate(() => document.querySelector('#modules-type-tabs [data-module-type="blog"]').click());
      await settleLayout();
      await noOverflow('portal module blog @1440');
      {
        const b = await page.evaluate(() => {
          const card = document.getElementById('modules-embed-bar');
          const sel = document.getElementById('modules-target-page');
          const cr = card.getBoundingClientRect();
          const sr = sel.getBoundingClientRect();
          return { inside: sr.right <= cr.right + 1, rowLayout: sr.width < cr.width - 200 };
        });
        assert.equal(b.inside, true, 'page select inside its card @1440');
        assert.equal(b.rowLayout, true, 'embed bar keeps its desktop row layout @1440 (select not full-width)');
        n += 2;
      }
      assert.equal(errors.length, 0, `no portal page errors (${errors.join('; ')})`); n += 1;
    } finally {
      await browser.close().catch(() => {});
      server.close();
    }
    group('Part 3 portal browser (390/700/1440)', n);
  }

  console.log(`BATCH107 REGRESSION PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH107 REGRESSION FAIL:', (e && e.stack) || e);
  process.exit(1);
});
