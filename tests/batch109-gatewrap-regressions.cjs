'use strict';
/**
 * Batch 109 regressions — .gate-wrap phantom band + Billing pair pin.
 *
 * Ely's diagnosis (2026-10-31): ".gate-wrap is adding padding to
 * the top of the portal page on a laptop." Root cause: portal.js
 * showApp() hides #gate (class .hidden) once the client is in,
 * but the .gate-wrap wrapper around it was never taken out of
 * flow — its padding (28px top + 72px bottom) rendered as a 100px
 * empty band above every portal page, at every width (measured
 * 100px at 1440/980/390 before this batch).
 *
 * Fix (CSS only, scoped by :has): when the gate is hidden, the
 * wrapper leaves the flow entirely:
 *   .gate-wrap:has(> #gate.hidden) { display: none; }
 * The wrapper has exactly ONE consumer in the codebase — the
 * #gate auth screens — and those keep the base rule untouched.
 *
 * Part 1 — source pins: base .gate-wrap rule unchanged; fix rule
 * present; single consumer; showApp/showGate hidden-toggling
 * intact; Billing section structure (the Active-plan + Social
 * credits pair lives in .portal-cards, Batch 108 standard);
 * SEC-13 census untouched (this batch edits no JS).
 *
 * Part 2 — real Chromium (1440/980/390), one atomic evaluate per
 * width replicating exactly the class changes showGate() /
 * showApp() make:
 *   gate state   -> wrapper in flow, padding-top 28px, auth panel
 *                   rendered (gate screens unbroken);
 *   authed state -> wrapper display:none, height 0, #app top = 0
 *                   (the phantom band is gone);
 *   billing pair -> adjacent gap == 16px (Batch 108 --card-gap):
 *                   side-by-side horizontal at 1440, stacked
 *                   vertical at 980 and 390 (<=980px is the
 *                   .portal-cards single-column breakpoint).
 *
 * NEGATIVE PROOF: B109_NEGATIVE=gatewrap serves portal.html with
 * the :has rule stripped -> the authed-state assertions go RED
 * (wrapper height back to 100px).
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const NEGATIVE = process.env.B109_NEGATIVE || '';
const groups = [];
const group = (name, n) => { groups.push(`${name} (${n})`); console.log(`  ok ${name} — ${n} checks`); };
const has = (hay, needle, label) => { assert.ok(hay.includes(needle), `${label} — missing: ${needle.slice(0, 90)}`); };

(async () => {
  // ---------------------------------------------------------------
  // Part 1 — source pins
  // ---------------------------------------------------------------
  {
    let n = 0;
    const portalHtml = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
    const portalJs = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');

    has(portalHtml, '.gate-wrap { position: relative; max-width: 980px; margin: 0 auto; padding: 28px 24px 72px; }', 'base .gate-wrap rule unchanged (auth screens keep their padding)'); n += 1;
    has(portalHtml, '.gate-wrap:has(> #gate.hidden) { display: none; }', 'Batch 109 fix rule present'); n += 1;
    assert.equal(portalHtml.split('class="gate-wrap"').length - 1, 1, 'exactly one .gate-wrap consumer element (the #gate wrapper)'); n += 1;
    has(portalJs, "gate.classList.add('hidden')", 'showApp() still hides #gate'); n += 1;
    has(portalJs, "gate.classList.remove('hidden')", 'showGate() still reveals #gate'); n += 1;

    // Billing pair structure: Active-plan panel + Social credits
    // panel inside .portal-cards within #sec-billing.
    const billStart = portalHtml.indexOf('id="sec-billing"');
    assert.ok(billStart > 0, 'billing section exists'); n += 1;
    const bill = portalHtml.slice(billStart, billStart + 4000);
    has(bill, '<div class="portal-cards">', 'billing pair sits in .portal-cards'); n += 1;
    has(bill, 'id="bill-status"', 'Active-plan panel present in the pair'); n += 1;
    has(bill, 'id="bill-credits-box"', 'Social credits panel present in the pair'); n += 1;
    has(portalHtml, '.portal-cards {', 'portal-cards rule present'); n += 1;

    // No JS touched by this batch: SEC-13 census must be identical.
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

  if (process.env.B109_SKIP_BROWSER === '1') {
    console.log('  skip Part 2 browser (B109_SKIP_BROWSER=1 — local iteration only)');
    console.log(`BATCH109 REGRESSION PASS — ${groups.join('; ')}`);
    return;
  }

  // ---------------------------------------------------------------
  // Part 2 — real Chromium measurements
  // ---------------------------------------------------------------
  const puppeteer = require('puppeteer');
  const http = require('node:http');
  const express = require('express');
  const app = express();
  if (NEGATIVE === 'gatewrap') {
    app.get('/portal.html', (req, res) => {
      let src = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
      src = src.split('.gate-wrap:has(> #gate.hidden) { display: none; }').join('');
      res.type('html').send(src);
    });
  }
  app.use(express.static(path.join(root, 'public'), { index: false }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  let n = 0;
  const near = (a, b, tol, label) => { assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} != ${b} (±${tol})`); n += 1; };
  const eq = (a, b, label) => { assert.equal(a, b, `${label}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); n += 1; };
  const ok = (cond, label) => { assert.ok(cond, label); n += 1; };

  for (const w of [1440, 980, 390]) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/portal.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Batch 112 de-flake: was a fixed 500ms sleep — measure only once
    // fonts are in and the wrap height is stable across two samples.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(
      () => {
        const wrap = document.querySelector('.gate-wrap');
        if (!wrap) return false;
        const h = Math.round(wrap.getBoundingClientRect().height * 10) / 10;
        if (window.__b109h === h) return true;
        window.__b109h = h;
        return false;
      },
      { timeout: 20000, polling: 100 }
    );
    const m = await page.evaluate(() => {
      const r = {};
      const wrap = document.querySelector('.gate-wrap');
      const gate = document.getElementById('gate');
      const appEl = document.getElementById('app');
      const cs = getComputedStyle(wrap);
      const authPanel = document.querySelector('#gate .auth-panel');
      r.gateState = {
        display: cs.display,
        height: Math.round(wrap.getBoundingClientRect().height * 10) / 10,
        paddingTop: cs.paddingTop,
        authPanelHeight: authPanel ? Math.round(authPanel.getBoundingClientRect().height * 10) / 10 : 0,
      };
      // authed state: exactly what showApp() toggles
      gate.classList.add('hidden');
      appEl.classList.remove('hidden');
      const cs2 = getComputedStyle(wrap);
      r.appState = {
        display: cs2.display,
        height: Math.round(wrap.getBoundingClientRect().height * 10) / 10,
        appTop: Math.round(appEl.getBoundingClientRect().top * 10) / 10,
      };
      // billing pair
      document.querySelectorAll('.portal-panel').forEach((s) => { s.hidden = true; });
      const bill = document.getElementById('sec-billing');
      bill.hidden = false;
      const panels = bill.querySelectorAll('.portal-cards > .panel');
      const a = panels[0].getBoundingClientRect();
      const b = panels[1].getBoundingClientRect();
      const sideBySide = Math.abs(a.top - b.top) < 2;
      r.billing = {
        count: panels.length,
        orientation: sideBySide ? 'side-by-side' : 'stacked',
        gap: sideBySide ? Math.round((b.left - a.right) * 10) / 10 : Math.round((b.top - a.bottom) * 10) / 10,
      };
      return r;
    });

    // Gate screens still render correctly with the wrapper.
    eq(m.gateState.display, 'block', `gate wrapper in flow on auth screen @${w}`);
    eq(m.gateState.paddingTop, '28px', `gate wrapper padding-top intact on auth screen @${w}`);
    ok(m.gateState.height > 200, `gate wrapper wraps the full auth screen @${w} (height ${m.gateState.height})`);
    ok(m.gateState.authPanelHeight > 100, `auth panel rendered inside the gate @${w} (height ${m.gateState.authPanelHeight})`);
    // Authed: the phantom band is gone.
    eq(m.appState.display, 'none', `gate wrapper out of flow once the gate is hidden @${w}`);
    near(m.appState.height, 0, 0.6, `gate wrapper height once the gate is hidden @${w}`);
    near(m.appState.appTop, 0, 0.6, `portal app starts at the top of the page @${w} (was 100px phantom band)`);
    // Billing pair on the Batch 108 standard.
    eq(m.billing.count, 2, `billing pair renders two panels @${w}`);
    eq(m.billing.orientation, w === 1440 ? 'side-by-side' : 'stacked', `billing pair orientation @${w}`);
    near(m.billing.gap, 16, 0.6, `billing pair gap == 16px standard @${w} (${m.billing.orientation})`);
    await page.close();
  }
  group('Part 2 browser measurements (1440/980/390)', n);

  await browser.close();
  server.close();
  console.log(`BATCH109 REGRESSION PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH109 REGRESSION FAIL', e);
  process.exit(1);
});
