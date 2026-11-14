'use strict';
/**
 * Batch 187 — FULL-WIDTH BANDS (Ely, 2026-11-14: "the nav and footer
 * and gallery sections need true full width, edge to edge").
 * Trigger: on the Chefmom glam build (website 53) the black nav band,
 * footer band and gallery sections stopped short of BOTH screen
 * edges at every width. Measured root cause (app-container Chrome,
 * 390/980/1440, every page): the band elements themselves carry no
 * cap — the platform's section WRAPPERS do. The Batch 135 spacing
 * guard pads every [data-ws-section-type] root with the section
 * inset (28px / 22px mobile, !important). That is correct when the
 * root IS the band (native module sections paint their own
 * background to their own edges) and wrong when the root is one of
 * the platform's own wrappers around authored chrome/bands —
 * div.ws-nav-chrome, div.ws-footer-chrome, div.ws-html-block: the
 * wrapper spans the viewport but its padding cages the authored
 * band's background at the content box (bands measured 346/924/1384
 * wide at viewports 390/980/1440). The gallery module embed stacked
 * a second platform cap on top: .bitpype-module-inpage pins every
 * in-page module to a 1100px centred column (the gallery measured
 * 1100 wide at 1440, its image grid only 976).
 *
 * The fix, in the floor's own raise-only idiom:
 *   - Guard CSS: the three wrapper classes carry NO horizontal
 *     padding (specificity-tied with the general inset rule, later
 *     in the same block, so it wins on exactly those classes). The
 *     band inside owns the inset.
 *   - Guard script: the Batch 186 measured top-up already enforces
 *     chrome bands. For .ws-html-block roots, Batch 187 adds a band
 *     pass that rescues ONLY bare text with no band box (it used to
 *     inherit the wrapper's padding; the block root is now topped
 *     up instead, with inline !important — the only layer that can
 *     raise a guarded root). Authored bands inside a block keep
 *     their own inset, policed by the Batch 185 geometry audit —
 *     the floor does not rewrite them. Module embeds inside a
 *     block are skipped — their surface is the module system's own.
 *   - spacingQa: section-pad exempts the wrapper roots (their
 *     padding is 0 by law now; band text is policed by the
 *     text-edge / card-text geometry, as before).
 *   - module-embed.js: gallery mounts get .bp-mod-fullwidth —
 *     max-width none, no auto margins, no horizontal padding — so a
 *     gallery band spans the viewport and its grid may touch the
 *     edges. Every other module type keeps the 1100px column.
 *
 *   Part 1 — pins.
 *   Part 2 — real Chromium fixtures: (A) the Chefmom pattern (band
 *     with its own inset inside the wrapper; a full-bleed gallery
 *     strip in an html block) — bands and tiles reach the edges at
 *     390/980/1440 and the geometry audit passes; (B) chrome bands
 *     with NO authored inset — full width AND the Batch 186 floor
 *     still raises their text inset; (B2) an authored html strip
 *     with no inset — full width, but NOT rescued: the geometry
 *     audit flags it, the Batch 185 freestyle-band rule; (C) a
 *     bare-text html block — the root fallback returns the inset;
 *     (D) guard cases: an authored 44px band inset is never reduced,
 *     a native module section keeps its guard padding; (E) the real
 *     module-embed.js: a gallery mount goes full width while a blog
 *     mount keeps the 1100px column. On the Batch 186 tree the
 *     width assertions in A/B/D and the embed assertions in E fail —
 *     that is the reproduction.
 *   Part 3 — export audit unit: the shipped artifact carries the
 *     wrapper-zero rule and shows no section-pad findings.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b187-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch187', 'test', 'session', 'secret'].join('-');
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

// --- Fixture A: the Chefmom pattern ----------------------------------
// Bands carry their own inset (like .cm-header/.cm-footer); the home
// gallery strip is an authored section inside an html block whose
// grid is authored edge-to-edge (padding:0, uniform gaps).
const CSS_A = [
  '.fx-header{background:#111111;color:#ffffff;padding:22px 28px}',
  '.fx-bar{display:flex;align-items:center;gap:26px;max-width:1180px;margin:0 auto}',
  '.fx-brand{font-family:Georgia,serif;font-size:30px;color:#ffffff}',
  '.fx-nav{display:flex;gap:24px;margin-left:auto}',
  '.fx-nav a{color:#ffffff;text-decoration:none;font-size:15px}',
  '@media (max-width:700px){.fx-header{padding:20px 22px}.fx-nav{display:none}}',
  '.fx-strip{background:#0d0d0d;padding:0}',
  '.fx-strip-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}',
  '.fx-strip-grid a{display:block;aspect-ratio:3/4;background:#7a1f3d;border-radius:10px}',
  '@media (max-width:700px){.fx-strip-grid{grid-template-columns:1fr 1fr}}',
  '.fx-footer{background:#111111;color:#ffffff;padding:44px 0 0}',
  '.fx-foot-grid{display:grid;grid-template-columns:1fr 1fr;gap:28px;max-width:1180px;margin:0 auto;padding:0 28px}',
  '.fx-foot-grid h3{margin:0 0 12px;font-size:16px}',
  '.fx-foot-list{list-style:none;margin:0;padding:0}',
  '.fx-foot-list li{margin:0 0 10px}',
  '.fx-foot-list a{color:#f3e3d3;text-decoration:none}',
  '.fx-foot-base{max-width:1180px;margin:30px auto 0;padding:16px 28px 22px;border-top:1px solid #333333;font-size:13px}',
  '@media (max-width:700px){.fx-foot-grid{grid-template-columns:1fr;padding:0 22px}.fx-foot-base{padding:14px 22px 20px}}',
].join('\n');
const NAV_A =
  '<div class="fx-header"><div class="fx-bar"><span class="fx-brand">Fixture Cakes</span>' +
  '<nav class="fx-nav"><a href="/">Home</a><a href="/gallery">Gallery</a><a href="/order">Order</a></nav></div></div>';
const STRIP_A =
  '<section class="fx-strip"><div class="fx-strip-grid">' +
  '<a href="/gallery"></a><a href="/gallery"></a><a href="/gallery"></a><a href="/gallery"></a>' +
  '</div></section>';
const FOOT_A =
  '<div class="fx-footer"><div class="fx-foot-grid"><div><h3>Fixture Cakes</h3><p>Custom cakes for every occasion.</p></div>' +
  '<div><h3>Explore</h3><ul class="fx-foot-list"><li><a href="/">Home</a></li><li><a href="/gallery">Gallery</a></li></ul></div></div>' +
  '<div class="fx-foot-base"><span>Fixture Cakes — baked to order.</span></div></div>';
const pagesA = () => [
  {
    slug: 'index',
    title: 'Home',
    sections: [
      { type: 'nav', content: { html: NAV_A } },
      { type: 'html', content: { html: STRIP_A } },
      TEXT,
      { type: 'footer', content: { html: FOOT_A } },
    ],
  },
];
const themeA = () => ({ baseCss: true, customCss: CSS_A });

// --- Fixture B: chrome bands with NO authored inset -------------------
// Full width (the wrapper cage is gone) AND the Batch 186 measured
// chrome top-up still raises the band text inset to the law.
const CSS_B = [
  '.fx2-header{background:#111111;color:#ffffff}',
  '.fx2-brand{display:block;font-size:28px;padding:6px 0}',
  '.fx2-strip{background:#0d0d0d;color:#ffffff}',
  '.fx2-strip p{margin:0;font-size:18px;padding:10px 0}',
  '.fx2-footer{background:#111111;color:#ffffff}',
  '.fx2-footer p{margin:0;font-size:15px;padding:8px 0}',
].join('\n');
const pagesB = () => [
  {
    slug: 'index',
    title: 'Home',
    sections: [
      { type: 'nav', content: { html: '<div class="fx2-header"><span class="fx2-brand">No Inset Cakes</span></div>' } },
      { type: 'footer', content: { html: '<div class="fx2-footer"><p>Baked to order.</p></div>' } },
    ],
  },
];
const themeB = () => ({ baseCss: true, customCss: CSS_B });

// --- Fixture B2: an authored html strip with NO inset -----------------
// Full width is the law; the inset is the author's. The floor must
// NOT silently rescue an authored band (Batch 185 fixture (f) pins
// freestyle bands as audit-flagged, never rewritten) — the strip
// reaches the edges and the geometry audit flags its text.
const pagesB2 = () => [
  {
    slug: 'index',
    title: 'Home',
    sections: [
      { type: 'html', content: { html: '<section class="fx2-strip"><p>Fresh from the oven</p></section>' } },
      TEXT,
    ],
  },
];

// --- Fixture C: bare text straight in an html block -------------------
const pagesC = () => [
  {
    slug: 'index',
    title: 'Home',
    sections: [TEXT, { type: 'html', content: { html: '<p class="fx3-note">Just a line of text.</p>' } }],
  },
];
const themeC = () => ({ baseCss: true, customCss: '.fx3-note{margin:0;font-size:17px}' });

// --- Fixture D: deliberate insets + native surfaces -------------------
const CSS_D = ['.fx4-header{background:#111111;color:#ffffff;padding:24px 44px}', '.fx4-brand{font-size:26px}'].join(
  '\n'
);
const pagesD = () => [
  {
    slug: 'index',
    title: 'Home',
    sections: [
      {
        type: 'nav',
        content: { html: '<div class="fx4-header"><span class="fx4-brand">Wide Inset Cakes</span></div>' },
      },
      {
        type: 'cards',
        content: {
          heading: 'What we bake',
          items: [
            { title: 'Birthday', text: 'Custom birthday cakes in every theme.' },
            { title: 'Wedding', text: 'Tiered wedding cakes, delivered with care.' },
          ],
        },
      },
      {
        type: 'footer',
        content: { html: '<div class="fx4-header"><span class="fx4-brand">Wide Inset Cakes</span></div>' },
      },
    ],
  },
];
const themeD = () => ({ baseCss: true, customCss: CSS_D });

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
  check('guard CSS zeroes exactly the three wrapper classes, after the general inset rule', () => {
    const css = engine.spacingGuardCss();
    const zero =
      '[data-ws-section-type].ws-nav-chrome,[data-ws-section-type].ws-footer-chrome,[data-ws-section-type].ws-html-block{padding-left:0!important;padding-right:0!important}';
    assert.ok(css.includes(zero), 'wrapper-zero rule missing from spacingGuardCss');
    const general = css.indexOf('padding-left:var(--bp-space-section-inset)!important');
    assert.ok(general >= 0 && css.indexOf(zero) > general, 'zero rule must ship after the general inset rule');
    n += 1;
  });
  check('guard script carries the Batch 187 band pass + root fallback, chrome pass intact', () => {
    const src = read('src/websiteEngine.js');
    assert.ok(src.includes('function bandPass('), 'bandPass in the guard script');
    assert.ok(src.includes('function bandRoots('), 'bandRoots in the guard script');
    assert.ok(src.includes('function topUpRoot('), 'root fallback top-up');
    assert.ok(src.includes('rootFallback'), 'chromeFloorPass fallback flag');
    assert.ok(src.includes('bitpype-module-embed,[data-bitpype-module]'), 'module embeds skipped by the band pass');
    assert.ok(
      engine.spacingGuardScript().includes("rootFallback==='band'"),
      'band pass runs in fallback-only mode (authored bands are audit-policed, never rewritten)'
    );
    assert.ok(
      engine.spacingGuardScript().includes("closest('table')"),
      'band pass skips tables (the table-wrap pass owns them — Batch 135 fixture (f) pattern)'
    );
    assert.ok(src.includes('function chromePass('), 'Batch 186 chrome pass intact');
    assert.ok(
      !src.includes('[data-ws-section-type="nav"]'),
      'guard script never carries the stamped nav attribute literal (batch141 reads whole documents)'
    );
    n += 1;
  });
  check('spacingQa section-pad exempts wrapper roots in BOTH measurement passes', () => {
    const src = read('server/spacingQa.js');
    assert.equal(src.split("sec.classList.contains('ws-html-block')").length - 1, 2, 'exemption in both passes');
    assert.equal(src.split("sec.classList.contains('ws-nav-chrome')").length - 1, 2, 'nav exemption in both passes');
    n += 1;
  });
  check('module-embed.js: gallery mounts go full width, the 1100px column stays for the rest', () => {
    const src = read('public/js/module-embed.js');
    assert.ok(src.includes('.bitpype-module-embed.bitpype-module-inpage.bp-mod-fullwidth{'), 'fullwidth rule present');
    assert.ok(
      src.includes("'max-width:none;margin-left:0;margin-right:0;padding-left:0;padding-right:0;'"),
      'fullwidth declarations'
    );
    assert.ok(src.includes("data-bitpype-module-type') || '') === 'gallery'"), 'mountOne stamps gallery mounts only');
    assert.ok(src.includes('.bitpype-module-embed.bitpype-module-inpage{'), 'inpage column rule intact');
    n += 1;
  });
  check('suite registered in the regression runner', () => {
    assert.ok(read('tests/run-regressions.cjs').includes("'batch187-fullwidth-bands-regressions'"));
    n += 1;
  });
  group('Part 1 pins', n);
}

// ---------------------------------------------------------------------
// Part 2 — real Chromium fixtures
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
    await new Promise((r) => setTimeout(r, 350));
    return await page.evaluate(fn, arg);
  } finally {
    await page.close();
  }
}

/* Band geometry: the element's own rect vs the viewport. */
function bandProbe(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    left: Math.round(r.left * 10) / 10,
    right: Math.round(r.right * 10) / 10,
    width: Math.round(r.width * 10) / 10,
    padL: parseFloat(cs.paddingLeft) || 0,
    padR: parseFloat(cs.paddingRight) || 0,
  };
}

/* Min distance from any text glyph inside `sel` to the VIEWPORT edges. */
function glyphInsetProbe(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const vw = document.documentElement.clientWidth;
  let l = 1e9,
    r = 1e9;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !/\S/.test(node.nodeValue)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      l = Math.min(l, rect.left);
      r = Math.min(r, vw - rect.right);
    }
  }
  return { l: Math.round(l * 10) / 10, r: Math.round(r * 10) / 10 };
}

/* First/last tile edges of the fixture A strip grid. */
function tilesProbe() {
  const tiles = Array.from(document.querySelectorAll('.fx-strip-grid a'));
  if (!tiles.length) return null;
  const first = tiles[0].getBoundingClientRect();
  const last = tiles[tiles.length - 1].getBoundingClientRect();
  return {
    count: tiles.length,
    firstLeft: Math.round(first.left * 10) / 10,
    lastRight: Math.round(last.right * 10) / 10,
  };
}

async function part2() {
  let n = 0;
  const geo = (pages, theme) => spacingQa.assessSpacing(pages, theme, { renderPage: engine.renderPage });
  const browser = await launchBrowser();
  try {
    // (A) The Chefmom pattern — bands + gallery tiles reach the edges.
    const htmlA = engine.renderPage(pagesA()[0], pagesA(), themeA());
    for (const w of [390, 980, 1440]) {
      const head = await probe(browser, htmlA, w, bandProbe, '.fx-header');
      const foot = await probe(browser, htmlA, w, bandProbe, '.fx-footer');
      const strip = await probe(browser, htmlA, w, bandProbe, '.fx-strip');
      const tiles = await probe(browser, htmlA, w, tilesProbe);
      const brand = await probe(browser, htmlA, w, glyphInsetProbe, '.fx-header');
      await acheck(`A: nav band, footer band and gallery strip span the full viewport @${w}`, async () => {
        for (const [name, b] of [
          ['header', head],
          ['footer', foot],
          ['strip', strip],
        ]) {
          assert.ok(b, `no .fx-${name} @${w}`);
          assert.ok(
            Math.abs(b.left) <= 0.6 && Math.abs(b.width - w) <= 0.6,
            `${name} @${w}: left=${b.left} width=${b.width} (viewport ${w})`
          );
        }
        assert.ok(tiles && tiles.count === 4, `tiles @${w}: ${JSON.stringify(tiles)}`);
        assert.ok(
          Math.abs(tiles.firstLeft) <= 0.6,
          `first tile left=${tiles.firstLeft} @${w} — grid does not reach the edge`
        );
        assert.ok(Math.abs(tiles.lastRight - w) <= 0.6, `last tile right=${tiles.lastRight} @${w} (viewport ${w})`);
        const floor = w <= 700 ? 22 : 28;
        assert.ok(brand && brand.l >= floor - 0.6, `brand glyph inset left=${brand && brand.l} @${w} < ${floor}`);
        n += 1;
      });
    }
    const resA = await geo(pagesA(), themeA());
    await acheck('A: geometry audit passes the Chefmom-pattern site (no section-pad on wrappers)', async () => {
      assert.equal(resA.pass, true, JSON.stringify(resA.violations, null, 1));
      assert.equal(
        resA.violations.filter((v) => v.kind === 'section-pad').length,
        0,
        JSON.stringify(resA.violations, null, 1)
      );
      n += 1;
    });

    // (B) Chrome bands with no authored inset — full width, floor intact.
    const htmlB = engine.renderPage(pagesB()[0], pagesB(), themeB());
    for (const w of [390, 1440]) {
      const floor = w <= 700 ? 22 : 28;
      const out = {};
      for (const [name, sel] of [
        ['header', '.fx2-header'],
        ['footer', '.fx2-footer'],
      ]) {
        out[name] = {
          band: await probe(browser, htmlB, w, bandProbe, sel),
          glyph: await probe(browser, htmlB, w, glyphInsetProbe, sel),
        };
      }
      await acheck(`B: inset-less chrome bands go full width AND the floor raises their text inset @${w}`, async () => {
        for (const name of ['header', 'footer']) {
          const { band, glyph } = out[name];
          assert.ok(band && Math.abs(band.width - w) <= 0.6, `${name} width=${band && band.width} @${w}`);
          assert.ok(
            glyph && glyph.l >= floor - 0.6 && glyph.r >= floor - 0.6,
            `${name} glyph inset ${JSON.stringify(glyph)} @${w} < ${floor}`
          );
        }
        n += 1;
      });
    }
    const resB = await geo(pagesB(), themeB());
    await acheck(
      'B: geometry audit passes the inset-less chrome site (floor, not the cage, provides the inset)',
      async () => {
        assert.equal(resB.pass, true, JSON.stringify(resB.violations, null, 1));
        n += 1;
      }
    );

    // (B2) An authored html strip with no inset: full width, NOT rescued.
    const htmlB2 = engine.renderPage(pagesB2()[0], pagesB2(), themeB());
    for (const w of [390, 1440]) {
      const floor = w <= 700 ? 22 : 28;
      const band = await probe(browser, htmlB2, w, bandProbe, '.fx2-strip');
      const glyph = await probe(browser, htmlB2, w, glyphInsetProbe, '.fx2-strip');
      await acheck(`B2: the authored strip spans full width but keeps its (missing) inset @${w}`, async () => {
        assert.ok(band && Math.abs(band.width - w) <= 0.6, `strip width=${band && band.width} @${w}`);
        assert.ok(glyph && glyph.l < floor - 1, `strip text was silently rescued: inset=${glyph && glyph.l} @${w}`);
        n += 1;
      });
    }
    const resB2 = await geo(pagesB2(), themeB());
    await acheck('B2: geometry audit FLAGS the un-inset authored strip (Batch 185 freestyle-band rule)', async () => {
      assert.equal(resB2.pass, false, 'audit should fail the un-inset strip');
      assert.ok(
        resB2.violations.some((v) => v.kind === 'card-text' && v.selector.includes('fx2-strip')),
        JSON.stringify(resB2.violations, null, 1)
      );
      n += 1;
    });

    // (C) Bare text in an html block — the root fallback returns the inset.
    const htmlC = engine.renderPage(pagesC()[0], pagesC(), themeC());
    for (const w of [390, 1440]) {
      const floor = w <= 700 ? 22 : 28;
      const glyph = await probe(browser, htmlC, w, glyphInsetProbe, '.fx3-note');
      await acheck(`C: bare html-block text is inset by the root fallback @${w}`, async () => {
        assert.ok(
          glyph && glyph.l >= floor - 0.6 && glyph.r >= floor - 0.6,
          `glyph inset ${JSON.stringify(glyph)} @${w} < ${floor}`
        );
        n += 1;
      });
    }
    const resC = await geo(pagesC(), themeC());
    await acheck('C: geometry audit passes the bare-text block site', async () => {
      assert.equal(resC.pass, true, JSON.stringify(resC.violations, null, 1));
      n += 1;
    });

    // (D) Guards: authored insets are never reduced; native sections keep the guard.
    const htmlD = engine.renderPage(pagesD()[0], pagesD(), themeD());
    const bandD = await probe(browser, htmlD, 1440, bandProbe, '.fx4-header');
    const cardsD = await probe(browser, htmlD, 1440, bandProbe, 'section[data-ws-section-type="cards"]');
    await acheck('D: a band authored at 44px keeps 44px (raise-only) and spans full width', async () => {
      assert.ok(bandD, 'no .fx4-header');
      assert.equal(bandD.padL, 44, `band padding reduced: ${bandD.padL}`);
      assert.ok(Math.abs(bandD.width - 1440) <= 0.6, `band width=${bandD.width}`);
      n += 1;
    });
    await acheck('D: a native module section keeps its guard padding (containment unchanged)', async () => {
      assert.ok(cardsD, 'no native cards section');
      assert.equal(cardsD.padL, 28, `native section padding=${cardsD.padL} (guard inset must remain)`);
      n += 1;
    });
    const resD = await geo(pagesD(), themeD());
    await acheck('D: geometry audit passes the guard-case site', async () => {
      assert.equal(resD.pass, true, JSON.stringify(resD.violations, null, 1));
      n += 1;
    });

    // (E) The real module-embed.js: gallery full width, blog keeps the column.
    const embedJs = read('public/js/module-embed.js').replace(/<\/script/gi, '<\\/script');
    const mount = (type, token) =>
      `<div class="bitpype-module-embed" data-bitpype-module="1" data-bitpype-module-type="${type}" data-bitpype-module-token="${token}" data-bitpype-api="http://127.0.0.1:9"></div>`;
    const htmlE =
      '<!doctype html><html><head><meta charset="utf-8"><title>embed fixture</title></head>' +
      '<body style="margin:0"><div style="background:#0d0d0d">' +
      mount('gallery', 'tok187gallery') +
      mount('blog', 'tok187blog') +
      '</div><script>' +
      embedJs +
      '</script></body></html>';
    const fileE = path.join(temp, 'embed-fixture.html');
    fs.writeFileSync(fileE, htmlE);
    const pageE = await browser.newPage();
    try {
      await pageE.setViewport({ width: 1440, height: 960 });
      await pageE.goto('file://' + fileE, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise((r) => setTimeout(r, 1500));
      const embeds = await pageE.evaluate(() => {
        const out = {};
        document.querySelectorAll('.bitpype-module-embed').forEach((el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          out[el.getAttribute('data-bitpype-module-type')] = {
            full: el.classList.contains('bp-mod-fullwidth'),
            maxWidth: cs.maxWidth,
            width: Math.round(r.width * 10) / 10,
            left: Math.round(r.left * 10) / 10,
          };
        });
        return out;
      });
      await acheck('E: gallery embed spans the full viewport (class + max-width:none + geometry)', async () => {
        const g = embeds.gallery;
        assert.ok(g, 'gallery mount missing');
        assert.equal(g.full, true, 'bp-mod-fullwidth not stamped on the gallery mount');
        assert.equal(g.maxWidth, 'none', `gallery max-width=${g.maxWidth}`);
        assert.ok(
          Math.abs(g.width - 1440) <= 0.6 && Math.abs(g.left) <= 0.6,
          `gallery embed width=${g.width} left=${g.left}`
        );
        n += 1;
      });
      await acheck('E: blog embed keeps the 1100px content column (scope guard)', async () => {
        const b = embeds.blog;
        assert.ok(b, 'blog mount missing');
        assert.equal(b.full, false, 'bp-mod-fullwidth leaked onto a blog mount');
        assert.equal(b.maxWidth, '1100px', `blog max-width=${b.maxWidth}`);
        assert.ok(Math.abs(b.width - 1100) <= 0.6, `blog embed width=${b.width}`);
        n += 1;
      });
    } finally {
      await pageE.close();
    }
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
  await acheck(
    'export audit: no section-pad findings and no band findings on the shipped full-width site',
    async () => {
      assert.equal(
        audit.violations.filter((v) => v.kind === 'section-pad').length,
        0,
        JSON.stringify(audit.violations, null, 1)
      );
      const bandFindings = audit.violations.filter((v) => v.selector.includes('fx-'));
      assert.deepEqual(bandFindings, [], JSON.stringify(audit.violations, null, 1));
      n += 1;
    }
  );
  await acheck(
    'export audit: only residue is the pre-existing legal-body strong artifact (also on the 186 tree)',
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
  await acheck('export artifact ships the wrapper-zero rule in its CSS', async () => {
    const indexHtml = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(
      indexHtml.includes('.ws-html-block{padding-left:0!important'),
      'zero rule missing from exported index.html'
    );
    n += 1;
  });
  group('Part 3 export audit', n);
}

(async () => {
  console.log('Batch 187 — full-width bands regressions');
  part1();
  if (process.env.B187_SKIP_BROWSER === '1') {
    console.log('  skip Parts 2-3 (B187_SKIP_BROWSER=1 — local iteration only)');
  } else {
    await part2();
    await part3();
  }
  console.log(`\nBATCH187 REGRESSION PASS — ${passed} checks: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH187 FAIL:', (e && e.stack) || e);
  process.exit(1);
});
