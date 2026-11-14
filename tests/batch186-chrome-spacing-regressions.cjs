'use strict';
/**
 * Batch 186 — CHROME SPACING FLOOR (Ely, 2026-11-13: "Fix it in the
 * platform (Batch 186) + fix this site's chrome"). Trigger: Ely's
 * one-pass test on the Chefmom build (website 53) FAILED by his
 * ruling — first pass is judged on the whole delivered site. Batch
 * 185's module surfaces passed with zero findings, but the authored
 * header/footer CHROME shipped the same two defects Ely had already
 * flagged on 1HP (website 52):
 *   (1) the header inset sat on the header's INNER BAR while the
 *       band itself carried none — QA: `card-text 10px div.cm-header`
 *       @390, `14px` @980/@1440 (the standing law since 2026-10-19:
 *       the inset goes ON the band, 28px desktop / 22px mobile);
 *   (2) footer link groups as inline anchors separated by <br> —
 *       QA: `sibling-overlap 18px a ~ a` + `text-overlap 18px a ~ a
 *       "Home"` @980, the run-on links wrapping into each other in
 *       the tablet column instead of a block-stacked list.
 * The fix is a measured floor in the spacing guard script (the layer
 * that already ships in every render): inside nav/footer chrome
 * bands, every text glyph must clear its component box (the same
 * box spacingQa measures) by the card floor, and the band root must
 * clear the section-inset law horizontally — topped up on the BAND
 * by exactly the measured deficit, never a blind addition, so a
 * compliant band is left byte-for-byte alone. Inline anchor runs in
 * footer columns (and mobile nav lists) are stacked as block lists
 * with at least an 8px rhythm; a flex/grid parent (the desktop
 * header row) is never stacked.
 *
 *   Part 1 — pins: the chrome pass lives in the guard script, the
 *     floor numbers are unchanged, the suite is registered.
 *   Part 2 — real Chromium fixtures reproducing BOTH Chefmom defect
 *     patterns (header inset on the inner bar only; footer inline
 *     <br> links in a narrow tablet column) plus a partials-chrome
 *     variant: the geometry audit passes them ONLY because the
 *     floor tops the band up and stacks the links (on the Batch 185
 *     tree every one of these fixtures fails the audit — that is
 *     the reproduction). Guard cases: compliant chrome gets NO
 *     inline styles (no double inset); the desktop header nav row
 *     stays a horizontal row; a band whose author CSS forbids the
 *     top-up (!important padding:0) is STILL caught by the audit;
 *     platform module surfaces are unchanged.
 *   Part 3 — export audit unit: the shipped artifact (writeStaticPages
 *     + assessExportedFiles) is clean for the defect-pattern site.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b186-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch186', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

let passed = 0;
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
function check(label, fn) {
  fn();
  passed += 1;
}
async function acheck(label, fn) {
  await fn();
  passed += 1;
}

const engine = require(path.join(root, 'src/websiteEngine.js'));
const spacingQa = require(path.join(root, 'server/spacingQa.js'));

const TEXT = {
  type: 'text',
  content: { heading: 'About the bakery', body: 'A family bakery serving the neighbourhood for years.' },
};

// --- Fixture A: the Chefmom patterns --------------------------------
// Header: inset ONLY on the inner bar (.fx-bar), the band (.fx-header)
// carries no padding at all; the brand sets line-height:1. Footer:
// Explore links are inline anchors separated by <br> in a column that
// is 130px wide at tablet widths, so the long label must wrap; the
// base bar's text sits 15px-class close to its box edge.
const CSS_A = [
  '.fx-header{background:#111111;color:#ffffff}',
  '.fx-bar{display:flex;align-items:center;justify-content:space-between;max-width:1180px;margin:0 auto;padding:10px 28px}',
  '.fx-brand{font-family:Georgia,serif;font-size:30px;line-height:1;color:#ffffff}',
  '.fx-nav{display:flex;gap:26px}',
  '.fx-nav a{color:#ffffff;text-decoration:none;font-size:16px}',
  '@media (max-width:700px){.fx-bar{padding:8px 16px}.fx-nav{display:none}}',
  '.fx-foot{background:#111111;color:#ffffff}',
  '.fx-foot-grid{display:grid;grid-template-columns:1.4fr 130px 1fr;gap:28px;max-width:1180px;margin:0 auto;padding:44px 28px 30px}',
  '.fx-foot h3{margin:0 0 12px;font-size:17px}',
  '.fx-foot p{margin:0 0 8px;font-size:15px;line-height:1.55}',
  '.fx-foot-col a{color:#f3e3d3;text-decoration:none;font-size:17px;line-height:1.6}',
  '.fx-base{border-top:1px solid #333333;padding:13px 22px;font-size:14px}',
  '@media (max-width:700px){.fx-foot-grid{grid-template-columns:1fr;padding:36px 22px 26px}}',
].join('\n');
const NAV_A =
  '<div class="fx-header"><div class="fx-bar"><span class="fx-brand">Fixture Cakes</span>' +
  '<nav class="fx-nav"><a href="/">Home</a><a href="/gallery">Gallery</a><a href="/order">Order</a></nav></div></div>';
const FOOT_A =
  '<div class="fx-foot"><div class="fx-foot-grid"><div><h3>Fixture Cakes</h3><p>Custom cakes for every occasion.</p></div>' +
  '<nav class="fx-foot-col"><h3>Explore</h3><a href="/">Home</a><br><a href="/gallery">Gallery</a><br>' +
  '<a href="/cakes">Cakes &amp; Treats Menu</a><br><a href="/order">Order a Cake</a></nav>' +
  '<div><h3>Contact</h3><p>Call the bakery.</p></div></div>' +
  '<div class="fx-base"><span>Fixture Cakes — baked to order.</span></div></div>';
const pagesA = () => [
  {
    slug: 'index',
    title: 'Home',
    sections: [{ type: 'nav', content: { html: NAV_A } }, TEXT, { type: 'footer', content: { html: FOOT_A } }],
  },
];
const themeA = () => ({ baseCss: true, customCss: CSS_A });

// --- Fixture B: compliant chrome (guard case a) ----------------------
const CSS_B = [
  '.fx-good-h{background:#123c2a;color:#ffffff;padding:24px 36px;display:flex;gap:18px;align-items:baseline}',
  '.fx-good-brand{font-size:26px}',
  '.fx-good-f{background:#123c2a;color:#ffffff;padding:30px 36px}',
  '.fx-good-cols{display:grid;grid-template-columns:1fr 1fr;gap:28px}',
  '.fx-good-f h3{margin:0 0 12px;font-size:17px}',
  '.fx-good-list{list-style:none;margin:0;padding:0}',
  '.fx-good-list li{margin:0 0 10px}',
  '.fx-good-list a{color:#ffffff;text-decoration:none}',
].join('\n');
const NAV_B =
  '<div class="fx-good-h"><span class="fx-good-brand">Good Cakes</span><span>Baked fresh daily</span></div>';
const FOOT_B =
  '<div class="fx-good-f"><div class="fx-good-cols"><div><h3>Explore</h3><ul class="fx-good-list">' +
  '<li><a href="/">Home</a></li><li><a href="/gallery">Gallery</a></li><li><a href="/order">Order a Cake</a></li></ul></div>' +
  '<div><h3>Contact</h3><p>Call the bakery.</p></div></div></div>';
const pagesB = () => [
  {
    slug: 'index',
    title: 'Home',
    sections: [{ type: 'nav', content: { html: NAV_B } }, TEXT, { type: 'footer', content: { html: FOOT_B } }],
  },
];
const themeB = () => ({ baseCss: true, customCss: CSS_B });

// --- Fixture C: author CSS forbids the top-up (audit stays honest) ---
const CSS_C = [
  '.fx-bad{background:#111111;color:#ffffff;padding:0!important}',
  '.fx-bad-brand{display:block;font-size:26px;line-height:1;margin-left:2px}',
  '.fx-bad-tag{display:block;font-size:14px;margin-left:2px}',
].join('\n');
const NAV_C =
  '<div class="fx-bad"><span class="fx-bad-brand">Bad Cakes</span><span class="fx-bad-tag">Baked badly</span></div>';
const pagesC = () => [{ slug: 'index', title: 'Home', sections: [{ type: 'nav', content: { html: NAV_C } }, TEXT] }];
const themeC = () => ({ baseCss: true, customCss: CSS_C });

// --- Fixture D: shared-partials chrome --------------------------------
const CSS_D = [
  '.fx-ph{background:#181818;color:#ffffff;padding:6px 12px}',
  '.fx-ph-brand{font-size:25px;line-height:1.1}',
  '.fx-ph-tag{font-size:14px}',
  '.fx-pf{background:#181818;color:#ffffff;padding:26px 28px}',
  '.fx-pf-col{width:130px}',
  '.fx-pf-col a{color:#f3e3d3;text-decoration:none;font-size:17px;line-height:1.6}',
].join('\n');
const themeD = () => ({
  baseCss: true,
  customCss: CSS_D,
  partials: {
    headerHtml:
      '<header class="fx-ph"><div class="fx-ph-brand">Partial Cakes</div><div class="fx-ph-tag">Custom cakes, baked to order</div></header>',
    footerHtml:
      '<footer class="fx-pf"><nav class="fx-pf-col"><a href="/">Home</a><br><a href="/cakes">Cakes &amp; Treats Menu</a><br><a href="/order">Order a Cake</a></nav></footer>',
  },
});
const pagesD = () => [{ slug: 'index', title: 'Home', sections: [TEXT] }];

// ---------------------------------------------------------------------
// Part 1 — pins
// ---------------------------------------------------------------------
function part1() {
  let n = 0;
  check('floor numbers unchanged (28/22/16 are Ely-set, not this batch)', () => {
    assert.deepEqual(spacingQa.spacingTokens(), {
      sectionInset: 28,
      sectionInsetMobile: 22,
      containerInset: 20,
      cardPad: 16,
      cardGap: 16,
      textInset: 16,
    });
    n += 1;
  });
  check('guard script carries the Batch 186 chrome pass', () => {
    const src = read('src/websiteEngine.js');
    assert.ok(src.includes('function chromePass('), 'chromePass in the guard script');
    assert.ok(src.includes('function chromeFloorPass('), 'measured band top-up');
    assert.ok(src.includes('function stackLinks('), 'footer link stacking');
    assert.ok(src.includes('body>header,body>footer'), 'partials chrome is in scope');
    assert.ok(
      src.includes('[data-ws-section-type="nav"],[data-ws-section-type="footer"]'),
      'typed chrome bands in scope'
    );
    n += 1;
  });
  check('suite registered in the regression runner', () => {
    assert.ok(read('tests/run-regressions.cjs').includes("'batch186-chrome-spacing-regressions'"));
    n += 1;
  });
  group('Part 1 pins', n);
}

// ---------------------------------------------------------------------
// Part 2 — real Chromium: the Chefmom defect fixtures + guard cases
// ---------------------------------------------------------------------
async function launchBrowser() {
  const puppeteer = require('puppeteer');
  const opts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      opts.executablePath = p;
      break;
    }
  }
  if (!opts.executablePath) {
    try {
      const resolved = await puppeteer.executablePath();
      if (resolved && fs.existsSync(resolved)) opts.executablePath = resolved;
    } catch {
      /* launch surfaces the error */
    }
  }
  return puppeteer.launch(opts);
}

async function probe(browser, html, width, fn, arg) {
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width,
      height: width <= 700 ? 844 : 960,
      deviceScaleFactor: 1,
      isMobile: width <= 700,
      hasTouch: width <= 700,
    });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return await page.evaluate(fn, arg);
  } finally {
    await page.close();
  }
}

/* Min distance from any text glyph inside `sel` to that element's
 * padding box, per side — the measurement the audit's card-text
 * check makes against the band. */
function clearanceProbe(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const br = el.getBoundingClientRect();
  const pl = br.left + (parseFloat(cs.borderLeftWidth) || 0);
  const pr = br.right - (parseFloat(cs.borderRightWidth) || 0);
  const pt = br.top + (parseFloat(cs.borderTopWidth) || 0);
  const pb = br.bottom - (parseFloat(cs.borderBottomWidth) || 0);
  let l = 1e9,
    r = 1e9,
    t = 1e9,
    b = 1e9;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !/\S/.test(node.nodeValue)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      l = Math.min(l, rect.left - pl);
      r = Math.min(r, pr - rect.right);
      t = Math.min(t, rect.top - pt);
      b = Math.min(b, pb - rect.bottom);
    }
  }
  return { l, r, t, b };
}

function linkStackProbe(sel) {
  const col = document.querySelector(sel);
  if (!col) return null;
  return Array.from(col.querySelectorAll('a')).map((a) => {
    const r = a.getBoundingClientRect();
    return {
      text: a.textContent.trim(),
      display: getComputedStyle(a).display,
      top: Math.round(r.top * 10) / 10,
      bottom: Math.round(r.bottom * 10) / 10,
      left: Math.round(r.left * 10) / 10,
    };
  });
}

async function part2() {
  let n = 0;
  const geo = (pages, theme) => spacingQa.assessSpacing(pages, theme, { renderPage: engine.renderPage });
  const browser = await launchBrowser();
  try {
    // (A) The Chefmom patterns — audit clean ONLY via the floor.
    const resA = await geo(pagesA(), themeA());
    await acheck(
      'A: Chefmom-pattern chrome passes the geometry audit (floor tops the band + stacks the links)',
      async () => {
        assert.equal(resA.pass, true, JSON.stringify(resA.violations, null, 1));
        n += 1;
      }
    );
    const htmlA = engine.renderPage(pagesA()[0], pagesA(), themeA());
    const head390 = await probe(browser, htmlA, 390, clearanceProbe, '.fx-header');
    const head1440 = await probe(browser, htmlA, 1440, clearanceProbe, '.fx-header');
    const base390 = await probe(browser, htmlA, 390, clearanceProbe, '.fx-base');
    await acheck('A: header band text clearance >= card floor on every side (390 + 1440)', async () => {
      for (const [w, c] of [
        [390, head390],
        [1440, head1440],
      ]) {
        assert.ok(c, `no .fx-header at ${w}`);
        for (const side of ['l', 'r', 't', 'b'])
          assert.ok(c[side] >= 15.5, `@${w} header clearance ${side}=${c[side].toFixed(1)} < 16`);
      }
      n += 1;
    });
    await acheck('A: footer base bar text clearance >= card floor @390 (the cm-foot-base pattern)', async () => {
      assert.ok(base390, 'no .fx-base');
      for (const side of ['l', 'r', 't', 'b'])
        assert.ok(base390[side] >= 15.5, `base clearance ${side}=${base390[side].toFixed(1)} < 16`);
      n += 1;
    });
    const links980 = await probe(browser, htmlA, 980, linkStackProbe, '.fx-foot-col');
    await acheck('A: footer Explore links are a block stack with >=8px rhythm @980 (no wrap, no overlap)', async () => {
      assert.ok(links980 && links980.length === 4, JSON.stringify(links980));
      for (const l of links980) assert.equal(l.display, 'block', `${l.text} not block`);
      for (let i = 1; i < links980.length; i++) {
        const gap = links980[i].top - links980[i - 1].bottom;
        assert.ok(gap >= 7.5, `gap before ${links980[i].text} = ${gap} < 8`);
      }
      n += 1;
    });
    const navRow = await probe(browser, htmlA, 1440, linkStackProbe, '.fx-nav');
    await acheck('guard (b): desktop header nav row stays a horizontal row @1440', async () => {
      assert.ok(navRow && navRow.length === 3, JSON.stringify(navRow));
      for (let i = 1; i < navRow.length; i++) {
        assert.ok(Math.abs(navRow[i].top - navRow[0].top) <= 2, 'nav links left the row');
        assert.ok(navRow[i].left > navRow[i - 1].left, 'nav links not left-to-right');
      }
      n += 1;
    });

    // (B) Compliant chrome — the floor must not touch it.
    const resB = await geo(pagesB(), themeB());
    await acheck('guard (a): compliant chrome passes the audit', async () => {
      assert.equal(resB.pass, true, JSON.stringify(resB.violations, null, 1));
      n += 1;
    });
    const htmlB = engine.renderPage(pagesB()[0], pagesB(), themeB());
    for (const w of [390, 980, 1440]) {
      const styled = await probe(browser, htmlB, w, () => {
        let count = 0;
        document.querySelectorAll('[data-ws-section-type="nav"],[data-ws-section-type="footer"]').forEach((sec) => {
          sec.querySelectorAll('[style]').forEach(() => {
            count += 1;
          });
        });
        return count;
      });
      await acheck(`guard (a): compliant chrome gets NO inline styles @${w} (no double inset)`, async () => {
        assert.equal(styled, 0, `${styled} styled elements inside compliant chrome`);
        n += 1;
      });
    }

    // (C) Author CSS that forbids the top-up — audit still catches it.
    const resC = await geo(pagesC(), themeC());
    await acheck(
      'honesty: a band with !important padding:0 is STILL flagged (floor cannot fake compliance)',
      async () => {
        assert.equal(resC.pass, false, 'sub-floor band passed — audit went blind');
        assert.ok(
          resC.violations.some((v) => v.kind === 'card-text' && v.selector.includes('fx-bad')),
          JSON.stringify(resC.violations)
        );
        n += 1;
      }
    );

    // (D) Shared-partials chrome — same floor, no section wrapper.
    const resD = await geo(pagesD(), themeD());
    await acheck('D: partials chrome passes the audit via the floor', async () => {
      assert.equal(resD.pass, true, JSON.stringify(resD.violations, null, 1));
      n += 1;
    });
    const htmlD = engine.renderPage(pagesD()[0], pagesD(), themeD());
    const phPad = await probe(browser, htmlD, 980, () => {
      const el = document.querySelector('.fx-ph');
      return el ? parseFloat(getComputedStyle(el).paddingTop) || 0 : -1;
    });
    const pfLinks = await probe(browser, htmlD, 980, linkStackProbe, '.fx-pf-col');
    await acheck('D: partial header band topped up on the band itself; partial footer links stacked', async () => {
      assert.ok(phPad >= 15.5, `fx-ph paddingTop=${phPad} (authored 6, floor 16)`);
      assert.ok(pfLinks && pfLinks.length === 3, JSON.stringify(pfLinks));
      for (const l of pfLinks) assert.equal(l.display, 'block', `${l.text} not block`);
      n += 1;
    });

    // (E) Platform chrome + modules — unchanged surfaces stay clean.
    const pagesE = [
      {
        slug: 'index',
        title: 'Home',
        sections: [
          { type: 'nav', content: { brand: 'Fixture Cakes' } },
          {
            type: 'hero',
            content: { heading: 'Reading Roofing Pros', sub: 'Fast, honest roof repairs across Berks County.' },
          },
          {
            type: 'services',
            content: {
              heading: 'What we do',
              items: [
                { title: 'Repairs', text: 'Leak repairs done right the first time, guaranteed in writing.' },
                { title: 'Replacement', text: 'Full roof replacement finished in days, not weeks.' },
              ],
            },
          },
          { type: 'footer', content: {} },
        ],
      },
    ];
    const resE = await geo(pagesE, { baseCss: true });
    await acheck('guard (c): platform nav/footer + module surfaces unchanged and clean', async () => {
      assert.equal(resE.pass, true, JSON.stringify(resE.violations, null, 1));
      n += 1;
    });
  } finally {
    await browser.close();
  }
  group('Part 2 Chromium fixtures', n);
}

// ---------------------------------------------------------------------
// Part 3 — export audit unit (the shipped artifact)
// ---------------------------------------------------------------------
async function part3() {
  let n = 0;
  const dir = path.join(temp, 'export-a');
  const written = engine.writeStaticPages(pagesA(), themeA(), dir, {});
  const audit = await spacingQa.assessExportedFiles({ dir, files: written.files });
  await acheck('export audit: no chrome findings on the shipped Chefmom-pattern site', async () => {
    const chromeFindings = audit.violations.filter((v) => v.selector.includes('fx-') || v.selector.includes('a ~ a'));
    assert.deepEqual(chromeFindings, [], JSON.stringify(audit.violations, null, 1));
    assert.equal(
      audit.violations.filter((v) => v.kind === 'card-text').length,
      0,
      JSON.stringify(audit.violations, null, 1)
    );
    n += 1;
  });
  await acheck(
    'export audit: only residue is the pre-existing legal-body strong artifact (also on the 185 tree)',
    async () => {
      for (const v of audit.violations) {
        assert.ok(
          (v.page === 'privacy.html' || v.page === 'terms.html') && v.selector === 'strong ~ strong',
          `unexpected export violation: ${JSON.stringify(v)}`
        );
      }
      n += 1;
    }
  );
  group('Part 3 export audit', n);
}

(async () => {
  console.log('Batch 186 — chrome spacing floor regressions');
  part1();
  if (process.env.B186_SKIP_BROWSER === '1') {
    console.log('  skip Parts 2-3 (B186_SKIP_BROWSER=1 — local iteration only)');
  } else {
    await part2();
    await part3();
  }
  console.log(`\nBATCH186 REGRESSION PASS — ${passed} checks: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH186 FAIL:', (e && e.stack) || e);
  process.exit(1);
});
