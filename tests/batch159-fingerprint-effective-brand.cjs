'use strict';
/**
 * Batch 159 — SITE FINGERPRINT: EFFECTIVE BRAND (fix for the Batch 156
 * baseline defect Ely caught: "Victoria isn't blue").
 *
 * Batch 156 read only the legacy flat theme fields. On real sites
 * those are stale platform defaults (#1a56db stamped at creation)
 * while the design that paints lives in theme.colors/theme.fonts and
 * in the site's own CSS. This suite pins the fix:
 *
 *   Part 1 — a Victoria-shaped fixture: flat primary = the #1a56db
 *     default, NO structured tokens, the green palette carried by
 *     customCss exactly as the real site carries it (:root variables,
 *     pine headings/links, terra buttons). The fingerprint MUST come
 *     out GREEN (#1d4633) with paletteSource 'css'. (On the real
 *     production model the same values arrive via tier 1 — see
 *     Part 2 — and the finisher's live proof re-derived all four
 *     production sites.)
 *   Part 2 — precedence: structured tokens (theme.colors/theme.fonts)
 *     beat CSS and flat fields even when both disagree; a flat-only
 *     fixture keeps Batch 156 behaviour byte-for-byte on values, with
 *     provenance 'theme'.
 *   Part 3 — mixed provenance resolves per aspect and is labelled:
 *     palette from tokens + fonts from CSS → source 'mixed'.
 *   Part 4 — CSS algorithm pins: background tints can never be
 *     primary; var()-only colours score through their usages; the
 *     heading-colour identity bonus beats a louder accent; a
 *     neutral-only stylesheet yields no CSS palette (falls through);
 *     one stray font rule cannot flip a pairing; CSS repeated on
 *     every page is measured once (dedupe).
 *   Part 5 — determinism + half independence for the new derivation:
 *     key order cannot move the hash; a CSS-only change moves the
 *     brand hash and leaves the layout hash still.
 *   Part 6 — similarity runs on EFFECTIVE palettes: two sites that
 *     shared the same stale flat primary (a Batch 156 double-match)
 *     no longer flag when their CSS brands differ, and a tokens-green
 *     site DOES double-match a CSS-green site with the same layout.
 *
 * Pure-module suite (the domain/MCP/HTTP surfaces are unchanged from
 * Batch 156 and stay pinned by tests/batch156-site-fingerprint.cjs).
 * Header convention follows the sibling real-server suites:
 * CAPTCHA_OPTIONAL=1 + APP_URL are set even though nothing boots here.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b159-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const fp = require(path.join(root, 'server/siteFingerprint.js'));

/* ---------------- fixtures ---------------- */

function simplePages(extraSections) {
  return [
    {
      slug: 'index',
      title: 'Home',
      sections: [
        { type: 'nav', content: { business_name: 'Fixture Co', links: [] } },
        { type: 'hero', content: { headline: 'Hi', cta_text: 'Go', cta_href: '#x' } },
        ...(extraSections || []),
        { type: 'footer', content: { business_name: 'Fixture Co' } },
      ],
    },
    {
      slug: 'about',
      title: 'About',
      sections: [
        { type: 'nav', content: { business_name: 'Fixture Co', links: [] } },
        { type: 'text', content: { title: 'About', body: 'Words.' } },
        { type: 'footer', content: { business_name: 'Fixture Co' } },
      ],
    },
  ];
}

/* Victoria-shaped CSS (condensed from the real site's customCss):
 * the palette lives in :root variables; pine paints headings, links
 * and the wordmark; terra paints buttons and price accents and is
 * used MORE often than pine in raw declarations. */
const VICTORIA_CSS = `
:root{--pine:#1D4633;--deep:#0E2C1F;--cream:#F7F1E3;--paper:#FFFDF6;--terra:#C05F33;--sage:#7D9B76;--ink:#22301F;--gold:#D9A441}
body{background:var(--cream);color:var(--ink);font-family:"Karla",system-ui,sans-serif}
h1,h2,h3,h4{font-family:"Fraunces",serif;color:var(--pine)}
a{color:var(--pine)}
.brand{font-family:"Fraunces",serif;color:var(--pine)}
.call{background:var(--terra);color:#fff}
.call:hover{background:var(--pine)}
.btn{background:var(--terra);border:2px solid var(--terra)}
.cta-band{background:var(--pine)}
.cta-band a{background:var(--terra)}
.hero{background:linear-gradient(118deg,#0E2C1F 0%,#1D4633 46%,#3E6B4F 100%)}
.eyebrow{color:var(--terra)}
.meta{color:var(--terra)}
.price{color:var(--terra)}
.form button{background:var(--terra)}
`;

const VICTORIA_MODEL = {
  theme: {
    // The stale platform defaults, exactly as production carried them.
    primary: '#1a56db',
    secondary: '#0e2a5c',
    bg: '#ffffff',
    text: '#1f2937',
    font: '"Karla", sans-serif',
    headingFont: '"Fraunces", serif',
    logoMode: 'text',
    logoUrl: '',
    customCss: VICTORIA_CSS,
  },
  pages: simplePages([
    {
      type: 'html',
      content: {
        html: '<section><style>.mod button{background:#C05F33}.mod h2{color:#1D4633}</style><h2>Shop</h2></section>',
      },
    },
  ]),
};

(async () => {
  /* ================================================================== */
  /* Part 1 — Victoria-shaped fixture: green, from CSS                   */
  /* ================================================================== */
  {
    let n = 0;
    const f = fp.computeFingerprint(VICTORIA_MODEL);
    assert.equal(
      f.brand.palette.primary,
      '#1d4633',
      'CSS-carried green palette yields the GREEN primary, not the stale flat blue'
    );
    assert.equal(f.brand.paletteSource, 'css', 'palette provenance is the CSS tier');
    assert.notEqual(f.brand.palette.primary, '#1a56db', 'the stale flat default never wins over the site CSS');
    n += 3;

    assert.deepEqual(
      f.brand.fonts,
      { heading: 'fraunces', body: 'karla' },
      'fonts resolve from the CSS body/heading rules'
    );
    assert.equal(f.brand.fontsSource, 'css', 'fonts provenance is the CSS tier');
    assert.equal(f.brand.source, 'css', 'overall provenance is css when both aspects come from CSS');
    n += 3;

    // The slots around the primary are the site's real design too:
    // a light warm background (never the flat #ffffff by default) and
    // the dark ink/green text family, not the flat text default.
    assert.ok(
      f.brand.palette.bg && f.brand.palette.bg !== '#ffffff',
      `bg slot derives from CSS (got ${f.brand.palette.bg})`
    );
    assert.ok(
      ['#22301f', '#1d4633', '#0e2c1f'].includes(f.brand.palette.text),
      `text slot is the ink/green family (got ${f.brand.palette.text})`
    );
    n += 2;

    group('Part 1 Victoria-shaped CSS fixture', n);
  }

  /* ================================================================== */
  /* Part 2 — precedence: tokens > css > flat; flat keeps 156 values     */
  /* ================================================================== */
  {
    let n = 0;
    // Structured tokens disagree with BOTH the CSS and the flat fields:
    // tokens win (they are the site's declared design system).
    const tokensModel = {
      theme: {
        ...VICTORIA_MODEL.theme,
        colors: { primary: '#5b2a86', secondary: '#7D9B76', accent: '#C05F33', background: '#F7F1E3', text: '#22301F' },
        fonts: { heading: 'Fraunces', body: 'Karla' },
      },
      pages: VICTORIA_MODEL.pages,
    };
    const tf = fp.computeFingerprint(tokensModel);
    assert.equal(tf.brand.palette.primary, '#5b2a86', 'structured colors.primary beats CSS and flat');
    assert.equal(tf.brand.palette.bg, '#f7f1e3', 'colors.background fills the bg slot');
    assert.equal(tf.brand.paletteSource, 'tokens');
    assert.equal(tf.brand.fontsSource, 'tokens');
    assert.equal(tf.brand.source, 'tokens');
    n += 5;

    // Flat-only fixture = Batch 156 behaviour on values (that suite's
    // base fixture), provenance now labelled 'theme'.
    const flatModel = {
      theme: {
        primary: '#1a56db',
        secondary: '#0e2a5c',
        bg: '#ffffff',
        text: '#1f2937',
        font: '"Karla", sans-serif',
        headingFont: '"Fraunces", serif',
        logoMode: 'text',
        logoUrl: '',
      },
      pages: simplePages(),
    };
    const ff = fp.computeFingerprint(flatModel);
    assert.equal(ff.brand.palette.primary, '#1a56db', 'flat-only: primary as Batch 156');
    assert.equal(ff.brand.palette.secondary, '#0e2a5c', 'flat-only: secondary as Batch 156');
    assert.equal(ff.brand.palette.accent, null, 'flat-only: no accent exists in the flat tier');
    assert.deepEqual(ff.brand.fonts, { heading: 'fraunces', body: 'karla' }, 'flat-only: pairing as Batch 156');
    assert.equal(ff.brand.paletteSource, 'theme');
    assert.equal(ff.brand.fontsSource, 'theme');
    assert.equal(ff.brand.source, 'theme');
    n += 7;

    group('Part 2 tier precedence', n);
  }

  /* ================================================================== */
  /* Part 3 — mixed provenance, per aspect                               */
  /* ================================================================== */
  {
    let n = 0;
    // Palette from tokens, fonts only in CSS → 'mixed' overall.
    const mixedA = {
      theme: {
        primary: '#1a56db',
        font: 'system-ui, sans-serif',
        headingFont: '',
        colors: { primary: '#1D4633', secondary: '#7D9B76', background: '#F7F1E3', text: '#22301F' },
        customCss: 'body{font-family:"Karla",sans-serif}h1{font-family:"Fraunces",serif}',
      },
      pages: simplePages(),
    };
    const ma = fp.computeFingerprint(mixedA);
    assert.equal(ma.brand.palette.primary, '#1d4633');
    assert.equal(ma.brand.paletteSource, 'tokens');
    assert.deepEqual(
      ma.brand.fonts,
      { heading: 'fraunces', body: 'karla' },
      'fonts fall to the CSS tier when tokens carry none'
    );
    assert.equal(ma.brand.fontsSource, 'css');
    assert.equal(ma.brand.source, 'mixed', 'differing aspect tiers combine to mixed');
    n += 5;

    // Fonts from tokens, palette only in CSS → also 'mixed'.
    const mixedB = {
      theme: {
        primary: '#1a56db',
        font: 'system-ui, sans-serif',
        fonts: { heading: 'Fraunces', body: 'Karla' },
        customCss: ':root{--pine:#1D4633}h1{color:var(--pine)}a{color:var(--pine)}.b{background:var(--pine)}',
      },
      pages: simplePages(),
    };
    const mb = fp.computeFingerprint(mixedB);
    assert.equal(mb.brand.palette.primary, '#1d4633');
    assert.equal(mb.brand.paletteSource, 'css');
    assert.equal(mb.brand.fontsSource, 'tokens');
    assert.equal(mb.brand.source, 'mixed');
    n += 4;

    group('Part 3 mixed provenance', n);
  }

  /* ================================================================== */
  /* Part 4 — CSS algorithm pins                                         */
  /* ================================================================== */
  {
    let n = 0;
    const cssOnly = (customCss, extra) => ({
      theme: { primary: '#1a56db', font: 'system-ui, sans-serif', customCss, ...(extra || {}) },
      pages: simplePages(),
    });

    // (a) A background tint used everywhere can never be primary:
    // cream (l≈0.93) fills every background; the saturated brand
    // colour used a handful of times still wins.
    const tint = fp.computeFingerprint(
      cssOnly(
        'body{background:#f7f1e3}.a{background:#f7f1e3}.b{background:#f7f1e3}.c{background:#f7f1e3}' +
          '.d{background:#f7f1e3}.e{background:#f7f1e3}h1{color:#8a3324}.x{color:#8a3324;border-color:#8a3324}'
      )
    );
    assert.equal(
      tint.brand.palette.primary,
      '#8a3324',
      'light tint excluded from candidacy despite dominating backgrounds'
    );
    assert.equal(tint.brand.palette.bg, '#f7f1e3', 'the tint lands in the bg slot instead');
    n += 2;

    // (b) A colour that exists ONLY as a variable definition scores
    // through its var() usages (the real sites' pattern).
    const varOnly = fp.computeFingerprint(
      cssOnly(':root{--brand:#2e6b34}.a{color:var(--brand)}.b{background:var(--brand)}h2{color:var(--brand)}')
    );
    assert.equal(varOnly.brand.palette.primary, '#2e6b34', 'var()-referenced colour resolves and scores');
    n++;

    // (c) Heading identity bonus: the accent fills more buttons, the
    // brand colour paints the headings — the brand colour wins.
    const bonus = fp.computeFingerprint(
      cssOnly(
        'h1,h2{color:#20503c}.btn{background:#d2691e}.btn2{background:#d2691e}.btn3{background:#d2691e}' +
          '.btn4{background:#d2691e}.chip{color:#d2691e}.tag{color:#d2691e}'
      )
    );
    assert.equal(bonus.brand.palette.primary, '#20503c', 'heading colour beats a louder accent (identity bonus)');
    n++;

    // (d) Neutral-only CSS yields NO css palette — the chain falls
    // through to the flat tier instead of calling grey a brand.
    const neutral = fp.computeFingerprint(
      cssOnly('body{background:#ffffff;color:#222222}.a{border-color:#cccccc;background:#f5f5f5}')
    );
    assert.equal(neutral.brand.paletteSource, 'theme', 'no saturated colour in CSS → flat tier supplies the palette');
    assert.equal(neutral.brand.palette.primary, '#1a56db');
    n += 2;

    // (e) One stray font rule cannot flip the pairing: a single h3
    // rule (weight 1) is under the evidence bar; the flat pairing
    // survives. Two h-rules worth of evidence does flip it.
    const stray = fp.computeFingerprint({
      theme: {
        primary: '#1a56db',
        font: '"Karla", sans-serif',
        headingFont: '"Fraunces", serif',
        customCss: 'h3{font-family:"Comic Neue",cursive}',
      },
      pages: simplePages(),
    });
    assert.equal(stray.brand.fonts.heading, 'fraunces', 'single low-weight font rule is not evidence');
    assert.equal(stray.brand.fontsSource, 'theme');
    const real = fp.computeFingerprint({
      theme: {
        primary: '#1a56db',
        font: '"Karla", sans-serif',
        headingFont: '"Fraunces", serif',
        customCss: 'h1{font-family:"Comic Neue",cursive}',
      },
      pages: simplePages(),
    });
    assert.equal(real.brand.fonts.heading, 'comic neue', 'an h1 font rule (weight 3) is evidence');
    // Per-slot resolution: the heading came from CSS while the body
    // still comes from the flat tier — that is exactly what the
    // 'mixed' fonts provenance label means.
    assert.equal(real.brand.fontsSource, 'mixed', 'heading from CSS + body from flat = mixed fonts provenance');
    n += 4;

    // (f) Dedupe: the same chrome CSS repeated on every page is
    // measured once — adding pages that repeat it cannot move the
    // fingerprint.
    const chromeCss = ':root{--brand:#2e6b34}h1{color:var(--brand)}body{font-family:"Karla",sans-serif}';
    const onePage = {
      theme: { primary: '#1a56db', font: 'system-ui, sans-serif' },
      pages: [
        {
          slug: 'index',
          sections: [
            { type: 'nav', content: {} },
            { type: 'html', content: { html: `<style>${chromeCss}</style><p>x</p>` } },
            { type: 'footer', content: {} },
          ],
        },
      ],
    };
    const sixPages = JSON.parse(JSON.stringify(onePage));
    for (let i = 1; i <= 5; i++) {
      sixPages.pages.push({
        slug: `p${i}`,
        sections: [
          { type: 'nav', content: {} },
          { type: 'html', content: { html: `<style>${chromeCss}</style><p>x</p>` } },
          { type: 'footer', content: {} },
        ],
      });
    }
    const brandOne = fp.computeFingerprint(onePage).brandHash;
    const brandSix = fp.computeFingerprint(sixPages).brandHash;
    assert.equal(brandSix, brandOne, 'repeating the same CSS on more pages does not move the brand half');
    n++;

    group('Part 4 CSS algorithm pins', n);
  }

  /* ================================================================== */
  /* Part 5 — determinism + half independence                            */
  /* ================================================================== */
  {
    let n = 0;
    const a = fp.computeFingerprint(VICTORIA_MODEL);
    const b = fp.computeFingerprint(JSON.parse(JSON.stringify(VICTORIA_MODEL)));
    assert.deepEqual(a, b, 'same effective model → identical fingerprint');
    const shuffled = {
      pages: VICTORIA_MODEL.pages,
      theme: Object.fromEntries(Object.entries(VICTORIA_MODEL.theme).reverse()),
    };
    assert.equal(fp.computeFingerprint(shuffled).hash, a.hash, 'stored key order cannot move the hash');
    n += 2;

    // A CSS-only change (swap the terra accent) moves the brand hash
    // and the fingerprint hash, and leaves the layout hash still.
    const reCss = JSON.parse(JSON.stringify(VICTORIA_MODEL));
    reCss.theme.customCss = reCss.theme.customCss.replace(/#C05F33/g, '#B03060');
    const r = fp.computeFingerprint(reCss);
    assert.notEqual(r.brandHash, a.brandHash, 'CSS change moves the brand hash');
    assert.notEqual(r.hash, a.hash, 'CSS change moves the fingerprint hash');
    assert.equal(r.layoutHash, a.layoutHash, 'CSS change leaves the layout half untouched');
    n += 3;

    group('Part 5 determinism + independence', n);
  }

  /* ================================================================== */
  /* Part 6 — similarity compares EFFECTIVE palettes                     */
  /* ================================================================== */
  {
    let n = 0;
    // Site A and site B share the stale flat primary #1a56db AND the
    // same layout/fonts — under Batch 156 they double-matched. Their
    // CSS brands differ (green vs rust), so now they must NOT flag.
    const siteA = {
      theme: {
        primary: '#1a56db',
        font: '"Karla", sans-serif',
        headingFont: '"Fraunces", serif',
        customCss:
          ':root{--b:#1D4633}body{font-family:"Karla",sans-serif}h1{font-family:"Fraunces",serif;color:var(--b)}a{color:var(--b)}',
      },
      pages: simplePages(),
    };
    const siteB = {
      theme: {
        primary: '#1a56db',
        font: '"Karla", sans-serif',
        headingFont: '"Fraunces", serif',
        customCss:
          ':root{--b:#C2511F}body{font-family:"Karla",sans-serif}h1{font-family:"Fraunces",serif;color:var(--b)}a{color:var(--b)}',
      },
      pages: simplePages(),
    };
    const fa = fp.computeFingerprint(siteA);
    const fb = fp.computeFingerprint(siteB);
    assert.equal(fa.brand.palette.primary, '#1d4633');
    assert.equal(fb.brand.palette.primary, '#c2511f');
    const cmp = fp.compareFingerprints(fa, fb);
    assert.equal(cmp.layoutMatch, true, 'layouts still match');
    assert.equal(cmp.brandClose, false, 'effective brands differ → brand not close');
    assert.equal(cmp.doubleMatch, false, 'no double-match on effective brands');
    n += 5;

    // Site C declares the same green via structured tokens: it DOES
    // double-match site A cross-workspace (report mode groups it as
    // flagged; same-workspace would be same-client).
    const siteC = {
      theme: {
        primary: '#1a56db',
        font: '"Karla", sans-serif',
        headingFont: '"Fraunces", serif',
        colors: { primary: '#1D4633' },
        fonts: { heading: 'Fraunces', body: 'Karla' },
      },
      pages: simplePages(),
    };
    const report = fp.similarityReport([
      { workspaceId: 1, websiteId: 1, name: 'A', fingerprint: fa },
      { workspaceId: 2, websiteId: 2, name: 'C', fingerprint: fp.computeFingerprint(siteC) },
      { workspaceId: 2, websiteId: 3, name: 'B', fingerprint: fb },
    ]);
    assert.equal(report.flagged.length, 1, 'tokens-green × css-green double-match is flagged');
    assert.equal(report.flagged[0].a.websiteId, 1);
    assert.equal(report.flagged[0].b.websiteId, 2);
    n += 3;

    group('Part 6 similarity on effective palettes', n);
  }

  console.log(`BATCH159 REGRESSION PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH159 REGRESSION FAIL:', (e && e.stack) || e);
  process.exit(1);
});
