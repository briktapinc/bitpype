'use strict';
/**
 * Batch 113 — MOBILE DROPDOWN TAB NAVIGATION (staff app).
 *
 * Ely's order 2026-11-01, from his phone screenshot of Platform
 * admin: the 18 section pills (Overview … Audit) wrap into a wall
 * that eats half the mobile screen. Site wide in the staff app,
 * mobile only: every pill-style SECTION tab bar becomes a single
 * dropdown on phones showing the active section; choosing an entry
 * switches exactly as tapping the pill does. Desktop/tablet keep
 * the pill rows untouched.
 *
 * Mechanism (one shared helper, no per-bar hacks): enhanceTabs()
 * in app.js pairs a bar with a native <select> built from the
 * bar's own buttons (createElement/textContent only — no new HTML
 * sinks). A pick clicks the REAL button, so the activation path is
 * the bar's own delegated onclick — hash routing for
 * Admin/Settings/Billing, the local pane switch for Outreach —
 * with deep links and back/forward intact. A MutationObserver
 * keeps the select's value synced to the active button however the
 * tab changed. CSS does the swap: .tabs-select is display:none
 * outside @media (max-width: 700px) (the staff shell's phone
 * breakpoint, Ely's standing mobile-nav standard); inside it, an
 * enhanced bar (.tabs.tabs-enhanced) is display:none and the
 * select is a full-width 48px control. Without JS no select
 * exists and no bar is ever hidden (the select is JS-built and
 * the hiding selector requires the JS-set class).
 *
 * Treated bars (census in the batch report): #admin-tabs (18,
 * hash), #settings-tabs (17, hash), #billing-tabs (4, hash),
 * #o-tabs (3, local). Deliberately NOT treated: #auth-tabs — a
 * two-option Log in/Register mode toggle on the sign-in card, not
 * section navigation; it self-hides in forgot/reset modes and
 * makes no wall. The client portal keeps its Batch 105 drawer nav;
 * its in-pane tab chips are two-option pane toggles (censused in
 * the batch report, unchanged).
 *
 * Part 1 — source pins + SEC-13 census: the Batch 113 app.js
 *   edits are additive (helper + four one-line call sites) and
 *   sink-free; the census summary and the (file|kind|snippet)
 *   multiset are pinned byte-identical to Batch 112's, and the
 *   reviewed RAW/IDENT baseline was regenerated for line shifts
 *   only (Batch 111 precedent).
 * Part 2 — real Chromium, stub API, staff app at 390/700: every
 *   treated surface shows the dropdown (pill wall gone), the
 *   active section preselected, content starting immediately
 *   under the compact nav; picking entries switches route/pane
 *   exactly like the pills (hash, panels, local state); a deep
 *   link to a non-first tab lands preselected; Back re-syncs.
 *   At 980/1440 the pill rows render and the select stays hidden.
 *
 * NEGATIVE PROOF: B113_NEGATIVE=css serves styles.css with the
 * Batch 113 block stripped -> the Part 2 phone assertions go RED
 * (pill wall back, no visible dropdown).
 * B113_SKIP_BROWSER=1 skips Part 2 locally; the gate runs it.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const NEGATIVE = process.env.B113_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

(async () => {
  const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

  // ---------------------------------------------------------------
  // Part 1 — source pins + SEC-13 census
  // ---------------------------------------------------------------
  {
    let n = 0;
    const has = (src, s, label) => {
      assert.ok(src.includes(s), label);
      n += 1;
    };

    // The shared mechanism.
    has(appJs, 'function enhanceTabs(tabsEl)', 'enhanceTabs helper exists');
    has(appJs, "sel.className = 'tabs-select'", 'paired select carries .tabs-select');
    has(appJs, 'if (b) b.click();', 'a pick clicks the real pill button (identical activation path)');
    has(appJs, 'new MutationObserver(sync)', 'select value syncs to the active button via MutationObserver');
    has(appJs, "tabsEl.classList.add('tabs-enhanced')", 'enhanced bars are marked for the CSS swap');
    for (const id of ['admin-tabs', 'settings-tabs', 'billing-tabs', 'o-tabs']) {
      has(appJs, `enhanceTabs($('#${id}'))`, `#${id} is enhanced`);
      n += 0; // has() already counted
    }
    assert.equal(appJs.split("enhanceTabs($('#").length - 1, 4, 'exactly four enhanceTabs call sites');
    n += 1;
    assert.ok(!appJs.includes("enhanceTabs($('#auth-tabs')"), '#auth-tabs deliberately not enhanced (2-option form toggle)');
    n += 1;

    // The CSS swap.
    const blockStart = stylesCss.indexOf('Batch 113: tab bars become a dropdown on phones');
    assert.ok(blockStart > 0, 'Batch 113 CSS block present');
    n += 1;
    const block = stylesCss.slice(blockStart);
    has(block, '.tabs-select {', 'select base rule in the Batch 113 block');
    has(block, '@media (max-width: 700px)', 'swap lives at the 700px phone breakpoint');
    has(block, '.tabs.tabs-enhanced {', 'only ENHANCED bars hide on phones');
    has(block, 'min-height: 48px', 'dropdown keeps a 48px touch target');
    assert.ok(!/\.tabs \{[^}]*display:\s*none/.test(block), 'no bare .tabs hiding — an unenhanced bar can never vanish');
    n += 1;
    assert.ok(!indexHtml.includes('tabs-select'), 'no select in static HTML — no-JS keeps the pills at every width');
    n += 1;

    // Cache-busts so phones actually pick up the new app.js/styles.css.
    has(indexHtml, '/styles.css?v=batch115-catalog1', 'styles.css cache-bust bumped');
    has(indexHtml, '/js/app.js?v=batch119-suspension1', 'app.js cache-bust bumped');

    // SEC-13 census: totals + per-kind counts unchanged from
    // Batch 112, the (file|kind|snippet) multiset byte-identical
    // (sha pinned), reviewed set == regenerated baseline exactly.
    const { census } = require(path.join(root, 'scripts', 'xss-census.cjs'));
    const cz = census();
    assert.deepEqual(cz.summary, { total: 407, STATIC: 137, ESCAPED: 41, SAFE: 70, BUILDER: 54, IDENT: 35, RAW: 70 }, 'SEC-13 census summary unchanged');
    n += 1;
    const multi = cz.sinks.map((s) => `${s.file}|${s.kind}|${s.snippet}`).sort();
    const sha = crypto.createHash('sha256').update(multi.join('\n')).digest('hex');
    assert.equal(sha, '8d62923b492a110b1945ee44faa5a737e5f59cac43bdd9f8c1e9869474bd0122', 'SEC-13 sink multiset byte-identical to Batch 112');
    n += 1;
    const reviewed = new Set(cz.sinks.filter((s) => s.kind === 'RAW' || s.kind === 'IDENT').map((s) => `${s.file}:${s.line}`));
    const BASELINE = new Set(require(path.join(root, 'tests', 'batch103-xss-baseline.json')));
    assert.deepEqual([...reviewed].filter((x) => !BASELINE.has(x)), [], 'no new RAW/IDENT sinks vs baseline');
    n += 1;
    assert.deepEqual([...BASELINE].filter((x) => !reviewed.has(x)), [], 'no baseline sink unaccounted');
    n += 1;
    group('Part 1 source pins + census', n);
  }

  if (process.env.B113_SKIP_BROWSER === '1') {
    console.log('  skip Part 2 browser (B113_SKIP_BROWSER=1 — local iteration only)');
    console.log(`BATCH113 REGRESSION PASS — ${groups.join('; ')}`);
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
  const ME = { ok: true, data: { user: { id: 1, email: 'fixture@example.invalid', isSuperAdmin: true }, workspaceId: 1, workspaces: [{ id: 1, name: 'Fixture', role: 'owner' }], isSuperAdmin: true, productAccess: true } };
  app.get('/api/v1/auth/me', (_q, r) => r.json(ME));
  app.get('/api/v1/captcha/config', (_q, r) => r.json({ ok: true, data: { enabled: false } }));
  app.get('/api/v1/admin/overview', (_q, r) =>
    r.json({ ok: true, data: { users: 3, usersActive: 3, workspaces: 4, superAdmins: 1, mcpTokens: 2, scheduledJobs: 0 } })
  );
  app.get('/api/v1/admin/audit', (_q, r) =>
    r.json({ ok: true, data: { rows: [{ at: '2026-10-22 21:29:34', actor_email: 'op@fixture.invalid', action: 'lead.create', detail: 'lead_id=603' }] } })
  );
  app.get('/api/v1/outreach/stats', (_q, r) =>
    r.json({ ok: true, data: { sentToday: 2, dailyCap: 100, activeCampaigns: 1, campaigns: 1, templates: 3, suppressionCount: 0, messagesByStatus: { queued: 0 } } })
  );
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
  app.use('/api/v1', (req, res) => {
    if (req.method !== 'GET') return res.status(500).json({ ok: false, error: 'No fixture writes allowed' });
    res.json({ ok: true, data: {} });
  });
  app.get('/app', (_q, r) => r.sendFile(path.join(root, 'public', 'index.html')));
  app.use((req, res, next) => {
    if (req.path === '/styles.css' && NEGATIVE === 'css') {
      let src = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
      const a = src.indexOf('/* ---------- Batch 113');
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

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  let n = 0;
  const eq = (a, b, label) => {
    assert.equal(a, b, `${label}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    n += 1;
  };
  const ok = (cond, label) => {
    assert.ok(cond, label);
    n += 1;
  };
  const WF = (page, fn, label) =>
    page.waitForFunction(fn, { timeout: 20000, polling: 100 }).catch(() => {
      throw new Error(`wait timed out: ${label}`);
    });
  // Batch 112 stability idiom: the heavy route renders (Settings
  // builds 17 sections) can land in two commits; interact only once
  // the view fingerprint is unchanged across consecutive samples.
  const waitStable = (page, label) =>
    page
      .waitForFunction(
        () => {
          const v = document.querySelector('#view');
          if (!v) return false;
          const fp = v.childNodes.length + ':' + v.innerHTML.length;
          if (window.__b113fp === fp) return true;
          window.__b113fp = fp;
          return false;
        },
        { timeout: 20000, polling: 150 }
      )
      .catch(() => {
        throw new Error(`wait timed out (stable): ${label}`);
      });
  const barState = (barSel) => {
    const bar = document.querySelector(barSel);
    const sel = bar ? bar.parentElement.querySelector('.tabs-select') : null;
    const out = { barExists: !!bar, selExists: !!sel };
    if (bar) {
      const cs = getComputedStyle(bar);
      out.barDisplay = cs.display;
      out.barHeight = Math.round(bar.getBoundingClientRect().height);
      out.pillCount = bar.querySelectorAll('button[data-tab]').length;
    }
    if (sel) {
      const cs = getComputedStyle(sel);
      const r = sel.getBoundingClientRect();
      out.selDisplay = cs.display;
      out.selHeight = Math.round(r.height);
      out.selBottom = Math.round(r.bottom);
      out.selValue = sel.value;
      out.selOptions = [...sel.options].map((o) => `${o.value}:${o.textContent}`);
    }
    out.noOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
    return out;
  };

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (r) => (r.url().startsWith(base) ? r.continue() : r.abort()));

  // ---- Phones (390 + the 700 breakpoint): Admin, the headline fix ----
  for (const w of [390, 700]) {
    await page.setViewport({ width: w, height: 844 });
    await page.goto(base + '/app#/admin/overview', { waitUntil: 'domcontentloaded' });
    await WF(page, () => document.querySelector('#admin-tabs') && document.querySelector('#admin-body .stat-card'), `admin overview renders @${w}`);
    await page.evaluate(() => document.fonts.ready);
    let st = await page.evaluate(barState, '#admin-tabs');
    ok(st.barExists && st.selExists, `admin bar + paired select exist @${w}`);
    eq(st.barDisplay, 'none', `pill wall hidden on phone @${w}`);
    eq(st.barHeight, 0, `pill bar takes no vertical space @${w}`);
    eq(st.selDisplay, 'block', `dropdown visible on phone @${w}`);
    ok(st.selHeight >= 48, `dropdown touch height >= 48px @${w} (got ${st.selHeight})`);
    eq(st.pillCount, 18, `admin bar still carries all 18 pills in the DOM @${w}`);
    eq(st.selOptions.length, 18, `dropdown lists all 18 sections @${w}`);
    eq(st.selOptions[0], 'overview:Overview', `first dropdown entry is Overview @${w}`);
    ok(st.selOptions.includes('gbp:Google Business'), 'dropdown includes Google Business');
    ok(st.selOptions.includes('audit:Audit'), 'dropdown includes Audit');
    eq(st.selValue, 'overview', `current section preselected @${w}`);
    ok(st.noOverflow, `no page-level horizontal overflow @${w}`);
    const gap = await page.evaluate(() => {
      const sel = document.querySelector('#view .tabs-select');
      const body = document.querySelector('#admin-body');
      return Math.round(body.getBoundingClientRect().top - sel.getBoundingClientRect().bottom);
    });
    ok(gap >= 0 && gap <= 24, `content starts immediately under the compact nav @${w} (gap ${gap}px)`);

    // Pick Users from the dropdown: same hash routing as the pill.
    await page.select('#view .tabs-select', 'users');
    await WF(page, () => location.hash === '#/admin/users' && document.querySelector('#admin-body').textContent.includes('Create user'), `dropdown pick routes to #/admin/users @${w}`);
    st = await page.evaluate(barState, '#admin-tabs');
    eq(st.selValue, 'users', `dropdown shows Users after the switch @${w}`);
    eq(st.barDisplay, 'none', `pill wall still hidden after the switch @${w}`);

    // Back: hash + dropdown re-sync to Overview.
    await page.goBack();
    await WF(page, () => location.hash === '#/admin/overview' && document.querySelector('#view .tabs-select') && document.querySelector('#view .tabs-select').value === 'overview', `Back returns to Overview and the dropdown re-syncs @${w}`);
    ok(true, `back/forward intact @${w}`);

    // Deep link to a non-first tab lands preselected.
    await page.goto(base + '/app#/admin/audit', { waitUntil: 'domcontentloaded' });
    await WF(page, () => document.querySelector('#admin-body') && document.querySelector('#admin-body').textContent.includes('lead.create'), `deep-linked audit tab renders @${w}`);
    st = await page.evaluate(barState, '#admin-tabs');
    eq(st.selValue, 'audit', `deep link preselects Audit in the dropdown @${w}`);
  }

  // ---- Phone: Settings (17 sections, hash-routed) ----
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(base + '/app#/settings/ai', { waitUntil: 'domcontentloaded' });
  await WF(page, () => document.querySelector('#settings-tabs') && document.querySelector('#view .tabs-select'), 'settings renders with dropdown @390');
  await waitStable(page, 'settings render settles @390');
  let st = await page.evaluate(barState, '#settings-tabs');
  eq(st.barDisplay, 'none', 'settings pill wall hidden @390');
  eq(st.selOptions.length, 17, 'settings dropdown lists all 17 sections');
  eq(st.selValue, 'ai', 'settings deep link preselects AI');
  await page.select('#view .tabs-select', 'sms');
  await WF(page, () => location.hash === '#/settings/sms', 'dropdown pick commits the #/settings/sms route');
  await WF(
    page,
    () => {
      const el = document.getElementById('sec-sms');
      return !!el && !el.hidden;
    },
    'SMS section visible after the settings re-render'
  );
  st = await page.evaluate(barState, '#settings-tabs');
  eq(st.selValue, 'sms', 'settings dropdown shows SMS after the switch');

  // ---- Phone: Billing (4 sections, hash-routed panels) ----
  await page.goto(base + '/app#/billing', { waitUntil: 'domcontentloaded' });
  await WF(page, () => document.querySelector('#billing-tabs') && document.querySelector('#view .tabs-select'), 'billing renders with dropdown @390');
  await waitStable(page, 'billing render settles @390');
  st = await page.evaluate(barState, '#billing-tabs');
  eq(st.barDisplay, 'none', 'billing pill row hidden @390');
  eq(st.selOptions.length, 4, 'billing dropdown lists all 4 sections');
  eq(st.selValue, 'subscription', 'billing preselects Plans');
  await page.select('#view .tabs-select', 'credits');
  await WF(
    page,
    () => {
      const c = document.getElementById('bill-panel-credits');
      const s = document.getElementById('bill-panel-subscription');
      return location.hash === '#/billing/credits' && !!c && !!s && !c.hidden && s.hidden;
    },
    'dropdown pick routes to #/billing/credits and swaps the panels'
  );
  st = await page.evaluate(barState, '#billing-tabs');
  eq(st.selValue, 'credits', 'billing dropdown shows Credits after the switch');

  // ---- Phone: Outreach (3 sections, local pane switch, no hash) ----
  await page.goto(base + '/app#/outreach', { waitUntil: 'domcontentloaded' });
  await WF(page, () => document.querySelector('#o-tabs') && document.querySelector('#view .tabs-select') && document.querySelector('#o-tab').textContent.includes('New campaign'), 'outreach renders with dropdown @390');
  await waitStable(page, 'outreach render settles @390');
  st = await page.evaluate(barState, '#o-tabs');
  eq(st.barDisplay, 'none', 'outreach pill row hidden @390');
  eq(st.selOptions.length, 3, 'outreach dropdown lists all 3 sections');
  eq(st.selValue, 'campaigns', 'outreach preselects Campaigns');
  await page.select('#view .tabs-select', 'templates');
  await WF(
    page,
    () =>
      document.querySelector('#view .tabs-select').value === 'templates' &&
      document.querySelector('#o-tabs button[data-tab="templates"]').classList.contains('active') &&
      !document.querySelector('#o-tab').textContent.includes('New campaign'),
    'dropdown pick switches the outreach pane locally (active pill state follows)'
  );
  eq(await page.evaluate(() => location.hash), '#/outreach', 'outreach switch stays local — hash untouched, exactly like the pills');
  ok(true, 'outreach local switch matches pill behaviour');

  // ---- Tablet + desktop: pills exactly as before, no dropdown ----
  for (const w of [980, 1440]) {
    await page.setViewport({ width: w, height: 900 });
    await page.goto(base + '/app#/admin/overview', { waitUntil: 'domcontentloaded' });
    await WF(page, () => document.querySelector('#admin-tabs') && document.querySelector('#admin-body .stat-card'), `admin overview renders @${w}`);
    await page.evaluate(() => document.fonts.ready);
    st = await page.evaluate(barState, '#admin-tabs');
    eq(st.barDisplay, 'flex', `pill row renders as before @${w}`);
    ok(st.barHeight > 0, `pill row takes its usual space @${w}`);
    eq(st.pillCount, 18, `all 18 pills present @${w}`);
    eq(st.selDisplay, 'none', `dropdown never appears @${w}`);
    // And the pills themselves still route.
    await page.evaluate(() => document.querySelector('#admin-tabs button[data-tab="audit"]').click());
    await WF(page, () => location.hash === '#/admin/audit', `pill click still routes @${w}`);
    ok(true, `pill navigation intact @${w}`);
  }

  eq(pageErrors.length, 0, `no page errors across all flows (got: ${pageErrors.slice(0, 3).join(' | ') || 'none'})`);
  group('Part 2 browser — dropdown on phones, pills above (390/700/980/1440)', n);

  await browser.close();
  server.close();
  console.log(`BATCH113 REGRESSION PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH113 REGRESSION FAIL', e);
  process.exit(1);
});
