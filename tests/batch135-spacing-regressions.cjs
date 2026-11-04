'use strict';
/**
 * Batch 135 — SPACING GUARANTEE (Ely, 2026-11-04: margins/padding are
 * a "major recurring issue" — "it seems like it cannot see what it's
 * doing"). Ships the platform fix drafted as Cursor prompt #6 on
 * 2026-10-20 and never implemented: renderer-guaranteed minimum inset
 * + edge-proximity QA at 390/980/1440.
 *
 *   Part 1 — pins: the six spacing floors live ONLY in
 *     public/css/tokens.css (Batch 111 single source); the engine
 *     guard + QA check parse them; doctrine carries the standing rule.
 *   Part 2 — real Chromium:
 *     (a) authored-flush site: plain flush CSS (sections 0, cards 4px,
 *         grid gap 0, even an !important hero rule) is RESCUED by the
 *         floor — computed insets meet the floors and QA passes; the
 *         authored patterns the floor cannot reach (negative-margin
 *         bleed, cards stacked outside any grid with 0 gap) FAIL QA
 *         with named px measurements.
 *     (b) well-spaced site passes QA at 390/980/1440.
 *     (c) the 2026-10-18 pattern (max-width wrap, no padding, on a
 *         full-document freestyle page) passes at 1440 and is CAUGHT
 *         at 980.
 *     (d) the floor lands on blocks rendered as <header> and <div>,
 *         not just <section> (the 2026-11-03 root cause).
 *   Part 3 — qaSite wiring (in-process DB): the `spacing` check is
 *     present, passes a well-spaced site, and fails the violating one
 *     with measurements in the detail. Skipped locally when the
 *     sandbox Node cannot load the Node-22 better-sqlite3 build; the
 *     in-image gate runs it for real.
 *   Part 4 — FINISHER SCOPE (2026-11-04 audit, 655 violations):
 *     (e) nav/footer CHROME is inside the floor: authored single-attr
 *         !important zero rules on chrome bands are beaten by the
 *         guard, and the QA section-pad measurement covers chrome;
 *     (f) wide tables scroll inside a .bp-table-scroll wrapper at
 *         390 instead of overflowing the page (Berks proof case);
 *     (g) module internals: bp-mod-book-row + bp-mod-news-card carry
 *         an internal-padding floor in module-embed.js (MODULE_SCRIPT_VER
 *         rotated to mod34 for the embed change).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b135-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch135', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 21).toString('base64');

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

const HERO = {
  type: 'hero',
  content: { heading: 'Reading Roofing Pros', sub: 'Fast, honest roof repairs across Berks County.' },
};
const SERVICES = {
  type: 'services',
  content: {
    heading: 'What we do',
    items: [
      { title: 'Repairs', text: 'Leak repairs done right the first time, guaranteed in writing.' },
      { title: 'Replacement', text: 'Full roof replacement finished in days, not weeks.' },
      { title: 'Gutters', text: 'Seamless gutters fitted, sealed and cleaned.' },
    ],
  },
};
const TEXT = {
  type: 'text',
  content: { heading: 'About the crew', body: 'A family crew serving Berks County for years.' },
};
const goodPages = () => [{ slug: 'index', title: 'Home', sections: [HERO, SERVICES, TEXT] }];

// ---------------------------------------------------------------------
// Part 1 — pins
// ---------------------------------------------------------------------
function part1() {
  let n = 0;
  const t = spacingQa.spacingTokens();
  check('tokens parse from tokens.css', () => {
    assert.deepEqual(t, {
      sectionInset: 28,
      sectionInsetMobile: 22,
      containerInset: 20,
      cardPad: 16,
      cardGap: 16,
      textInset: 16,
    });
    n += 1;
  });
  check('engine consumes the same parsed tokens', () => {
    assert.deepEqual(engine._spacingTokens(), t);
    n += 1;
  });
  check('no second literal copy of the floor numbers anywhere in src/server/public', () => {
    const defRe = /--bp-space-[a-z-]+\s*:\s*[0-9]/;
    const hits = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === 'node_modules') continue;
          walk(p);
        } else if (/\.(js|cjs|css|md)$/.test(ent.name)) {
          if (defRe.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
        }
      }
    };
    walk(path.join(root, 'src'));
    walk(path.join(root, 'server'));
    walk(path.join(root, 'public'));
    assert.deepEqual(hits, ['public/css/tokens.css']);
    n += 1;
  });
  check('siteCss appends the guard in BOTH branches; docShell ships the guard script', () => {
    const src = read('src/websiteEngine.js');
    assert.equal((src.match(/\$\{spacingGuardCss\(\)\}/g) || []).length, 2);
    assert.ok(src.includes('${spacingGuardScript()}'));
    assert.ok(src.includes('injectSpacingGuardScript(upsertFontLinks'));
    n += 1;
  });
  check('rendered pages carry guard css + script', () => {
    const html = engine.renderPage(goodPages()[0], goodPages(), {});
    assert.ok(html.includes('bitpype spacing guard'), 'guard css comment');
    assert.ok(html.includes('data-ws-spacing-guard="1"'), 'guard script tag');
    const minimal = engine.renderPage(goodPages()[0], goodPages(), { baseCss: false });
    assert.ok(minimal.includes('bitpype spacing guard'), 'guard also in baseCss-off branch');
    n += 1;
  });
  check('qaSite wires the spacing check through spacingQa.assessSpacing', () => {
    const src = read('src/websiteEngine.js');
    assert.ok(src.includes("require('../server/spacingQa')"));
    assert.ok(src.includes('assessSpacing(pages, theme, { renderPage })'));
    assert.ok(src.includes("'spacing',"));
    n += 1;
  });
  check('spacingQa measures at 390/980/1440 with text-node ranges', () => {
    const src = read('server/spacingQa.js');
    assert.ok(src.includes('DEFAULT_WIDTHS = [390, 980, 1440]'));
    assert.ok(src.includes('createTreeWalker'));
    assert.ok(src.includes('getClientRects'));
    n += 1;
  });
  check('doctrine: soul + default instructions carry the not-done-while-failing rule', () => {
    assert.ok(read('server/agent-soul.md').includes('A design is NOT done while the spacing check fails'));
    assert.ok(read('src/defaultDesignInstructions.js').includes('SPACING (platform-enforced'));
    n += 1;
  });
  check('finisher: guard selector covers chrome (no nav/footer exclusion); table treatment ships in guard css', () => {
    const src = read('src/websiteEngine.js');
    assert.ok(!src.includes('ws-footer-chrome):not'), 'chrome class exclusion gone');
    assert.ok(!src.includes('not([data-ws-section-type='), 'nav type exclusion gone');
    assert.ok(src.includes('SPACING_SECTION_SELECTOR'), 'selector constant present');
    assert.ok(
      /SPACING_SECTION_SELECTOR =\s*'\[data-ws-section-type\]/.test(src),
      'selector starts with the bare section attribute'
    );
    assert.ok(src.includes('.bp-table-scroll{overflow-x:auto'), 'table scroll wrapper css');
    assert.ok(src.includes('wrapTables()'), 'guard script wraps tables');
    n += 1;
  });
  check('finisher: spacingQa measures section-pad (chrome included)', () => {
    const src = read('server/spacingQa.js');
    assert.ok(src.includes("kind: 'section-pad'"), 'section-pad violation kind');
    assert.ok(src.includes('sectionInsetMobile'), 'mobile floor wired');
    n += 1;
  });
  check('finisher: module internals carry the padding floor; embed version rotated', () => {
    const embed = read('public/js/module-embed.js');
    assert.ok(embed.includes('bp-mod-book-row'), 'book row present');
    assert.ok(
      embed.includes('padding-left:var(--bp-space-card-pad,16px);padding-right:var(--bp-space-card-pad,16px);'),
      'book-row/news floor uses the token var'
    );
    assert.ok(embed.includes('.bp-mod-news-card{padding:var(--bp-space-card-pad,16px);}'), 'news-card unscoped floor');
    assert.ok(read('server/siteModules.js').includes("const MODULE_SCRIPT_VER = 'mod34'"), 'MODULE_SCRIPT_VER mod34');
    n += 1;
  });
  group('Part 1 pins', n);
}

// ---------------------------------------------------------------------
// Part 2 — real Chromium
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

async function part2() {
  let n = 0;
  const browser = await launchBrowser();
  try {
    // (d) floor lands on <header> and <div> blocks, not just <section>
    const dPages = [
      {
        slug: 'index',
        title: 'Home',
        sections: [HERO, { type: 'html', content: { html: '<div class="fx-d"><p>Freestyle block copy.</p></div>' } }],
      },
    ];
    const dHtml = engine.renderPage(dPages[0], dPages, {});
    const dProbe = (w) =>
      probe(browser, dHtml, w, () => {
        const hero = document.querySelector('[data-ws-section-type="hero"]');
        const html = document.querySelector('[data-ws-section-type="html"]');
        return {
          heroTag: hero && hero.tagName,
          htmlTag: html && html.tagName,
          heroPad: hero && getComputedStyle(hero).paddingLeft,
          htmlPad: html && getComputedStyle(html).paddingLeft,
        };
      });
    const dWide = await dProbe(1440);
    await acheck('(d) hero is a <header>, html block is a <div>; both get the 28px floor', async () => {
      assert.equal(dWide.heroTag, 'HEADER');
      assert.equal(dWide.htmlTag, 'DIV');
      assert.equal(dWide.heroPad, '28px');
      assert.equal(dWide.htmlPad, '28px');
      n += 1;
    });
    const dNarrow = await dProbe(390);
    await acheck('(d) both get the 22px mobile floor at 390', async () => {
      assert.equal(dNarrow.heroPad, '22px');
      assert.equal(dNarrow.htmlPad, '22px');
      n += 1;
    });

    // (a-rescue) authored flush, rescued by the floor
    const flushTheme = {
      baseCss: true,
      customCss: [
        '[data-ws-section-type]{padding-left:0;padding-right:0}',
        'section[data-ws-section-type="hero"]{padding-left:0!important;padding-right:0!important}',
        '.card{padding:4px}',
        '.grid,.cards-grid{gap:0}',
      ].join('\n'),
    };
    const aPages = goodPages();
    const aHtml = engine.renderPage(aPages[0], aPages, flushTheme);
    const aProbe = await probe(browser, aHtml, 1440, () => {
      const hero = document.querySelector('[data-ws-section-type="hero"]');
      const card = document.querySelector('.card');
      const grid = document.querySelector('.grid, .cards-grid');
      return {
        heroPad: hero && getComputedStyle(hero).paddingLeft,
        cardPad: card && getComputedStyle(card).paddingTop,
        gridGap: grid && getComputedStyle(grid).columnGap,
      };
    });
    await acheck('(a) floor rescues authored flush: hero 28px, card pad 16px, grid gap >= 16px', async () => {
      assert.equal(aProbe.heroPad, '28px');
      assert.equal(aProbe.cardPad, '16px');
      assert.ok(parseFloat(aProbe.gridGap) >= 16, `grid gap ${aProbe.gridGap}`);
      n += 1;
    });
    const aQa = await spacingQa.assessSpacing(aPages, flushTheme, { renderPage: engine.renderPage });
    await acheck('(a) QA passes the rescued flush fixture at all widths', async () => {
      assert.equal(aQa.pass, true, JSON.stringify(aQa.violations).slice(0, 300));
      n += 1;
    });

    // (a-caught) patterns the floor cannot reach FAIL with measurements
    const caughtPages = [
      {
        slug: 'index',
        title: 'Home',
        sections: [
          HERO,
          {
            type: 'html',
            content: {
              html:
                '<div class="fx-stack">' +
                '<div class="card"><h3>Stacked One</h3><p>First stacked card copy.</p></div>' +
                '<div class="card"><h3>Stacked Two</h3><p>Second stacked card copy.</p></div>' +
                '</div>' +
                '<p class="fx-bleed">This paragraph bleeds back to the viewport edge.</p>',
            },
          },
        ],
      },
    ];
    const caughtTheme = { baseCss: true, customCss: '.fx-bleed{margin-left:-28px;margin-right:-28px}' };
    const cQa = await spacingQa.assessSpacing(caughtPages, caughtTheme, { renderPage: engine.renderPage });
    await acheck('(a) QA FAILS the unrescuable fixture: touching stacked cards + bleed text', async () => {
      assert.equal(cQa.pass, false);
      const gaps = cQa.violations.filter((v) => v.kind === 'card-gap');
      assert.ok(gaps.length >= 1, 'card-gap violation present');
      assert.ok(
        gaps.every((v) => v.px === 0),
        `touching cards report 0px: ${JSON.stringify(gaps)}`
      );
      const bleed = cQa.violations.filter((v) => v.kind === 'text-edge' && v.width === 1440);
      assert.ok(bleed.length >= 1, `bleed caught at 1440: ${JSON.stringify(cQa.violations).slice(0, 300)}`);
      assert.ok(bleed.every((v) => v.px < 16));
      n += 1;
    });

    // (e) finisher: chrome bands are inside the floor — authored
    // single-attribute !important zero rules on nav/footer (the exact
    // pattern the audit found on Victoria) are beaten by the guard,
    // and QA's section-pad measurement covers the chrome bands.
    const ePages = [
      {
        slug: 'index',
        title: 'Home',
        sections: [
          { type: 'nav', content: { html: '<div class="fx-chrome"><span>Fixture Brand</span></div>' } },
          HERO,
          TEXT,
          { type: 'footer', content: { html: '<div class="fx-chrome"><p>Fixture footer copy.</p></div>' } },
        ],
      },
    ];
    const eTheme = {
      baseCss: true,
      customCss: [
        '[data-ws-section-type="nav"]{padding-left:0!important;padding-right:0!important}',
        '[data-ws-section-type="footer"]{padding-left:0!important;padding-right:0!important}',
      ].join('\n'),
    };
    const eHtml = engine.renderPage(ePages[0], ePages, eTheme);
    const eProbe = (w) =>
      probe(browser, eHtml, w, () => {
        const nav = document.querySelector('[data-ws-section-type="nav"]');
        const foot = document.querySelector('[data-ws-section-type="footer"]');
        return {
          navPad: nav && getComputedStyle(nav).paddingLeft,
          footPad: foot && getComputedStyle(foot).paddingLeft,
        };
      });
    const eWide = await eProbe(1440);
    await acheck(
      '(e) chrome floor at 1440: nav + footer wrappers at 28px despite authored !important zeros',
      async () => {
        assert.equal(eWide.navPad, '28px', `nav pad ${eWide.navPad}`);
        assert.equal(eWide.footPad, '28px', `footer pad ${eWide.footPad}`);
        n += 1;
      }
    );
    const eNarrow = await eProbe(390);
    await acheck('(e) chrome floor at 390: nav + footer wrappers at 22px', async () => {
      assert.equal(eNarrow.navPad, '22px', `nav pad ${eNarrow.navPad}`);
      assert.equal(eNarrow.footPad, '22px', `footer pad ${eNarrow.footPad}`);
      n += 1;
    });
    const eQa = await spacingQa.assessSpacing(ePages, eTheme, { renderPage: engine.renderPage });
    await acheck('(e) QA passes the chrome fixture (section-pad covers chrome, guard rescues it)', async () => {
      assert.equal(eQa.pass, true, JSON.stringify(eQa.violations).slice(0, 300));
      n += 1;
    });

    // (f) finisher: a wide table scrolls inside its band at 390 —
    // the Berks price-table pattern (100%-wide table, nowrap cells,
    // zero-padding container) must not overflow the page.
    const wideCells = Array.from(
      { length: 8 },
      (_, i) => `<th style="white-space:nowrap;padding:10px 18px">Column Heading ${i + 1}</th>`
    ).join('');
    const wideRow = Array.from(
      { length: 8 },
      (_, i) => `<td style="white-space:nowrap;padding:10px 18px">Cell value ${i + 1} long</td>`
    ).join('');
    const fPages = [
      {
        slug: 'index',
        title: 'Home',
        sections: [
          HERO,
          {
            type: 'html',
            content: {
              html: `<div class="fx-tbl"><table class="fx-wide"><thead><tr>${wideCells}</tr></thead><tbody><tr>${wideRow}</tr></tbody></table></div>`,
            },
          },
        ],
      },
    ];
    const fHtml = engine.renderPage(fPages[0], fPages, {});
    const fProbe = await probe(browser, fHtml, 390, () => {
      const doc = document.documentElement;
      return {
        overflow: Math.max(doc.scrollWidth, document.body.scrollWidth) - doc.clientWidth,
        wrapped: !!document.querySelector('.bp-table-scroll > table.fx-wide'),
      };
    });
    await acheck('(f) wide table wrapped in .bp-table-scroll; zero page overflow at 390', async () => {
      assert.equal(fProbe.wrapped, true, 'table wrapped by guard script');
      assert.ok(fProbe.overflow <= 0, `overflow ${fProbe.overflow}`);
      n += 1;
    });
    const fQa = await spacingQa.assessSpacing(fPages, {}, { renderPage: engine.renderPage });
    await acheck('(f) QA passes the wide-table fixture at all widths', async () => {
      assert.equal(fQa.pass, true, JSON.stringify(fQa.violations).slice(0, 300));
      n += 1;
    });

    // (b) well-spaced passes everywhere
    const bQa = await spacingQa.assessSpacing(goodPages(), {}, { renderPage: engine.renderPage });
    await acheck('(b) well-spaced site passes QA at 390/980/1440', async () => {
      assert.equal(bQa.pass, true, JSON.stringify(bQa.violations).slice(0, 300));
      n += 1;
    });

    // (c) the Oct-18 pattern on a full-document freestyle page
    const cPages = [
      {
        slug: 'index',
        title: 'Home',
        html:
          '<!DOCTYPE html><html><head><title>Fixture</title></head><body>' +
          '<div class="fx-wrap"><h1>Centered Wrap Heading</h1>' +
          '<p>Body copy that spans the full wrap so its glyphs reach the wrap edges whenever the wrap fills the viewport at tablet widths.</p></div>' +
          '</body></html>',
      },
    ];
    const cTheme = { customCss: '.fx-wrap{max-width:1000px;margin:0 auto;padding:0}' };
    const ccQa = await spacingQa.assessSpacing(cPages, cTheme, { renderPage: engine.renderPage });
    await acheck('(c) 980-only violation: 1440 clean, 980 caught (Oct 18 pattern)', async () => {
      assert.equal(ccQa.pass, false);
      assert.ok(
        !ccQa.violations.some((v) => v.width === 1440),
        `1440 must be clean: ${JSON.stringify(ccQa.violations).slice(0, 300)}`
      );
      assert.ok(
        ccQa.violations.some((v) => v.width === 980 && v.kind === 'text-edge'),
        `980 text-edge expected: ${JSON.stringify(ccQa.violations).slice(0, 300)}`
      );
      n += 1;
    });
  } finally {
    await browser.close();
  }
  group('Part 2 chromium geometry', n);
}

// ---------------------------------------------------------------------
// Part 3 — qaSite wiring (in-process DB, batch60 pattern)
// ---------------------------------------------------------------------
async function part3() {
  let Database;
  try {
    Database = require('better-sqlite3');
    const probeDb = new Database(':memory:');
    probeDb.close();
  } catch {
    console.log('  skip Part 3 (better-sqlite3 unavailable under this Node build — the in-image gate runs it)');
    groups.push('Part 3 qaSite wiring (skipped locally)');
    return;
  }
  let n = 0;
  const db = new Database(':memory:');
  db.exec(read('src/schema.sql'));
  engine.ensureTables(db);
  try {
    require(path.join(root, 'src/cfDomains.js')).ensureTables(db);
  } catch {
    /* optional */
  }
  try {
    require(path.join(root, 'server/siteModules.js')).ensureTables(db);
  } catch {
    /* optional */
  }
  try {
    require(path.join(root, 'server/siteAnalytics.js')).ensureTables(db);
  } catch {
    /* optional */
  }
  const lead = db.prepare(
    `INSERT INTO leads (id, business_name, category, phone, email, city, state, address, postal_code, country)
     VALUES (?, 'Spacing Fixture Co', 'Roofing', '(610) 555-0135', 'team@spacing.example', 'Reading', 'PA', '1 Gap Way', '19601', 'US')`
  );
  const site = db.prepare(
    `INSERT INTO websites (id, lead_id, name, industry, theme, pages, status, preview_url, custom_domain, updated_at)
     VALUES (?, ?, 'Spacing Fixture Co', 'roofing', ?, ?, 'draft', 'https://spacing.example', NULL, '2026-11-04 00:00:00')`
  );
  lead.run(7801);
  site.run(7801, 7801, JSON.stringify({}), JSON.stringify(goodPages()));
  lead.run(7802);
  const caughtPages = [
    {
      slug: 'index',
      title: 'Home',
      sections: [
        HERO,
        {
          type: 'html',
          content: {
            html:
              '<div class="fx-stack">' +
              '<div class="card"><h3>Stacked One</h3><p>First stacked card copy.</p></div>' +
              '<div class="card"><h3>Stacked Two</h3><p>Second stacked card copy.</p></div>' +
              '</div>',
          },
        },
      ],
    },
  ];
  site.run(7802, 7802, JSON.stringify({ baseCss: true, customCss: '' }), JSON.stringify(caughtPages));

  const qaGood = await engine.qaSite(db, 7801);
  const spGood = (qaGood.checks || []).find((c) => c.name === 'spacing');
  await acheck('qaSite: spacing check present and PASSING on the well-spaced site', async () => {
    assert.ok(spGood, `spacing check missing: ${JSON.stringify((qaGood.checks || []).map((c) => c.name))}`);
    assert.equal(spGood.pass, true, spGood.detail);
    n += 1;
  });
  const qaBad = await engine.qaSite(db, 7802);
  const spBad = (qaBad.checks || []).find((c) => c.name === 'spacing');
  await acheck('qaSite: spacing check FAILS the touching-cards site with measurements', async () => {
    assert.ok(spBad, 'spacing check missing on bad site');
    assert.equal(spBad.pass, false, spBad.detail);
    assert.ok(spBad.detail.includes('Spacing violations'), spBad.detail);
    assert.ok(spBad.detail.includes('card-gap'), spBad.detail);
    n += 1;
  });
  db.close();
  group('Part 3 qaSite wiring', n);
}

(async () => {
  console.log('Batch 135 — spacing guarantee regressions');
  part1();
  if (process.env.B135_SKIP_BROWSER === '1') {
    console.log('  skip Parts 2-3 (B135_SKIP_BROWSER=1 — local iteration only)');
  } else {
    await part2();
    await part3();
  }
  console.log(`\nBATCH135 REGRESSION PASS — ${passed} checks: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH135 FAIL:', (e && e.stack) || e);
  process.exit(1);
});
