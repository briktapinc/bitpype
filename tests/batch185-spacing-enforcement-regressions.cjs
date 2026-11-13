'use strict';
/**
 * Batch 185 — SPACING ENFORCEMENT, PLATFORM-LEVEL (Ely, 2026-11-13:
 * "The fix should apply to future sites too. This has been an issue
 * we've been trying to address since the beginning."). Trigger: Ely's
 * screen recording of website 52 (1HP) on mobile showing, on a build
 * whose QA reported clean —
 *   (a) fixed-height service cards with text spilling past borders,
 *   (b) a band heading overlapping its own body text + a card
 *       overlapping the band above it,
 *   (c) FAQ items overlapping each other.
 * Batch 135's floor + QA were blind to all three: no content-clip,
 * no text-spill, no overlap measurement existed, module cards
 * (.bp-mod-*-card) sat outside the card selectors, and QA never
 * measured the exported artifact.
 *
 *   Part 1 — pins: geometry audit exports + default-on wiring, the
 *     guard script's un-clip rescue, the module-embed floor block for
 *     the whole bp-mod card family, MODULE_SCRIPT_VER mod43, the
 *     export stamp wiring in domain.js, floor numbers unchanged.
 *   Part 2 — real Chromium fixtures reproducing (a)/(b)/(c) exactly:
 *     the LEGACY Batch 135 measurement passes every defect fixture
 *     (the blindness, proven in-suite), the geometry audit catches
 *     each with its named kind, the platform-.card fixed-height
 *     variant is auto-rescued by the guard script, and a well-spaced
 *     site stays clean (no false positives from the new checks).
 *   Part 3 — export audit unit: assessExportedFiles over fixture
 *     files on disk (the shipped-artifact measurement sitesExport
 *     stamps onto every export).
 *   Part 4 — qaSite wiring (in-process DB): the spacing check fails
 *     the heading-overlap site with measurements and passes the
 *     well-spaced site. Skipped locally when better-sqlite3 cannot
 *     load under the sandbox Node; the in-image gate runs it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b185-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch185', 'test', 'session', 'secret'].join('-');
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

const LONG_COPY =
  'Every signing is checked page by page before the packet leaves the table. ' +
  'Identification is verified, signatures are witnessed in person, and the ' +
  'completed documents are returned the same day whenever the appointment ' +
  'finishes before the evening courier cutoff. Borrowers get a plain-language ' +
  'walkthrough of each document before anyone picks up a pen.';
const htmlSection = (html) => ({ type: 'html', content: { html } });
const fixturePage = (html) => [{ slug: 'index', title: 'Home', sections: [HERO, htmlSection(html)] }];

// ---------------------------------------------------------------------
// Part 1 — pins
// ---------------------------------------------------------------------
function part1() {
  let n = 0;
  check('floor numbers unchanged (28/22 law is Ely-set, not this batch)', () => {
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
  check('spacingQa exports the geometry audit + export audit', () => {
    assert.equal(typeof spacingQa.measureGeometryInPage, 'function');
    assert.equal(typeof spacingQa.assessExportedFiles, 'function');
    assert.equal(typeof spacingQa.measureSpacingInPage, 'function', 'legacy measure retained');
    assert.ok(spacingQa.GEOMETRY_CARD_SELECTOR.includes('.bp-mod-dt-card'), 'module cards in the audited set');
    n += 1;
  });
  check('assessSpacing defaults to the geometry measurement (legacy opt-out only)', () => {
    const src = read('server/spacingQa.js');
    assert.ok(src.includes('opts.geometry === false ? measureSpacingInPage : measureGeometryInPage'));
    for (const kind of ['content-clip', 'text-spill', 'sibling-overlap', 'text-overlap']) {
      assert.ok(src.includes(`kind: '${kind}'`), `geometry kind ${kind} present`);
    }
    n += 1;
  });
  check('guard script carries the fixed-height un-clip rescue', () => {
    const src = read('src/websiteEngine.js');
    assert.ok(src.includes('function unclip(el)'), 'unclip present');
    assert.ok(src.includes('el.scrollHeight>el.clientHeight+1'), 'rescue keyed on real overflow');
    assert.ok(src.includes('unclip(el);'), 'rescue runs on the card set');
    n += 1;
  });
  check('module-embed floor covers the whole bp-mod card family; sub-floor paddings floored', () => {
    const embed = read('public/js/module-embed.js');
    assert.ok(embed.includes('Batch 185 — module spacing floor'), 'floor block present');
    assert.ok(
      embed.includes('.bp-mod-dt-card,.bp-mod-gr-card,.bp-mod-member-card,.bp-mod-price-card,.bp-mod-empty-card,.bp-mod-news-card,.bp-mod-job,.bp-mod-tier{padding:var(--bp-space-card-pad,16px);}'),
      'unscoped padding floor for server-rendered mounts'
    );
    assert.ok(embed.includes('padding:max(0.85rem,var(--bp-space-card-pad,16px)) 1rem'), 'faq details padding floored');
    assert.ok(embed.includes('padding:max(0.95rem,var(--bp-space-card-pad,16px)) 1.05rem 1.1rem'), 'social body padding floored');
    n += 1;
  });
  check('guard guarantees the grid display mode + faq item gap (1HP root cause)', () => {
    const src = read('src/websiteEngine.js');
    assert.ok(
      src.includes('.grid,.cards-grid,.gallery-grid,.contact-grid,.footer-grid,.hero-grid,.cols,.text-image-grid{display:grid}'),
      'display:grid guaranteed for the platform grid containers (baseCss-off builds dropped it)'
    );
    assert.ok(
      src.includes('section[data-ws-section-type="faq"] details{margin-top:0;margin-bottom:var(--bp-space-card-gap)}'),
      'faq items floored apart'
    );
    assert.ok(
      src.includes('.cols-2,.cols-3,.cols-4,.text-image-grid,.cards-grid.cols-2,.cards-grid.cols-3,.cards-grid.cols-4{grid-template-columns:1fr!important}'),
      'mobile single-column collapse guaranteed with the display mode'
    );
    assert.ok(src.includes('".card,.review-card,.col-cell"'), 'guard script raises col-cell padding too');
    n += 1;
  });
  check('booking slot rows take the standard gap token', () => {
    assert.ok(
      read('public/js/module-embed.js').includes('gap:var(--bp-space-card-gap,16px);'),
      'slots gap single-sourced from the token'
    );
    n += 1;
  });
  check('MODULE_SCRIPT_VER rotated to mod43 for the embed change', () => {
    const sm = require(path.join(root, 'server/siteModules.js'));
    assert.equal(sm.MODULE_SCRIPT_VER, 'mod43');
    assert.ok(read('public/embed/module.html').includes('module-embed.js?v=mod43'), 'standalone viewer pin rotated');
    n += 1;
  });
  check('export path stamps the geometry audit (sitesExport + sitesPreview)', () => {
    const src = read('server/domain.js');
    assert.ok(src.includes('async function attachSpacingAudit'), 'shared audit helper');
    assert.ok(src.includes('assessExportedFiles(exported)'), 'audit runs over the shipped files');
    assert.ok(src.includes('spacing_audit.${Number(siteId)}'), 'settings stamp written');
    assert.ok((src.match(/attachSpacingAudit\(db/g) || []).length >= 2, 'wired into export AND preview');
    n += 1;
  });
  check('doctrine tells builders the new catches by name', () => {
    const d = read('src/defaultDesignInstructions.js');
    assert.ok(d.includes('CLIPPED inside fixed-height boxes'), 'clip named');
    assert.ok(d.includes('OVERLAPPING siblings or text'), 'overlap named');
    n += 1;
  });
  group('Part 1 pins', n);
}

// ---------------------------------------------------------------------
// Part 2 — real Chromium: the 1HP defect fixtures
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

async function probe(browser, html, width, fn) {
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
    return await page.evaluate(fn);
  } finally {
    await page.close();
  }
}

async function part2() {
  let n = 0;
  const geo = (pages, theme) => spacingQa.assessSpacing(pages, theme, { renderPage: engine.renderPage });
  const legacy = (pages, theme) =>
    spacingQa.assessSpacing(pages, theme, { renderPage: engine.renderPage, geometry: false });

  // (a1) CLIP — fixed-height box, overflow hidden, authored class.
  const clipPages = fixturePage(`<div class="fx-clip"><h3>Loan Document Signing</h3><p>${LONG_COPY}</p></div>`);
  const clipTheme = {
    customCss: '.fx-clip{height:120px;overflow:hidden;border:1px solid #999;background:#fff;padding:20px;max-width:340px}',
  };
  const clipLegacy = await legacy(clipPages, clipTheme);
  await acheck('(a1) legacy 135 measurement is BLIND to the clipped fixed-height box', async () => {
    assert.equal(clipLegacy.pass, true, JSON.stringify(clipLegacy.violations).slice(0, 300));
    n += 1;
  });
  const clipGeo = await geo(clipPages, clipTheme);
  await acheck('(a1) geometry audit catches it as content-clip', async () => {
    assert.equal(clipGeo.pass, false);
    const hits = clipGeo.violations.filter((v) => v.kind === 'content-clip');
    assert.ok(hits.length >= 1, JSON.stringify(clipGeo.violations).slice(0, 400));
    assert.ok(hits.every((v) => v.px > 0), 'clip depth measured in px');
    n += 1;
  });

  // (a2) SPILL — same box, overflow visible: glyphs paint past the border.
  const spillPages = fixturePage(`<div class="fx-spill"><h3>Apostille Processing</h3><p>${LONG_COPY}</p></div>`);
  const spillTheme = {
    customCss: '.fx-spill{height:110px;border:1px solid #999;background:#fff;padding:20px;max-width:340px}',
  };
  const spillLegacy = await legacy(spillPages, spillTheme);
  await acheck('(a2) legacy 135 measurement is BLIND to text spilling past the border', async () => {
    assert.equal(spillLegacy.pass, true, JSON.stringify(spillLegacy.violations).slice(0, 300));
    n += 1;
  });
  const spillGeo = await geo(spillPages, spillTheme);
  await acheck('(a2) geometry audit catches it as text-spill', async () => {
    assert.equal(spillGeo.pass, false);
    const hits = spillGeo.violations.filter((v) => v.kind === 'text-spill');
    assert.ok(hits.length >= 1, JSON.stringify(spillGeo.violations).slice(0, 400));
    n += 1;
  });

  // (a3) AUTO-RESCUE — platform .card, authored fixed height, stacked
  // (not a grid item): the guard script grows the box to fit, and the
  // geometry audit then measures the page clean.
  const rescuePages = fixturePage(
    '<div class="fx-stack2">' +
      `<div class="card fx-fixed"><h3>Signature Verifications</h3><p>${LONG_COPY}</p></div>` +
      '<div class="card"><h3>General Notary Acts</h3><p>Short copy fits anywhere.</p></div>' +
      '</div>'
  );
  const rescueTheme = { customCss: '.fx-fixed{height:110px;overflow:hidden}.fx-stack2 .card + .card{margin-top:20px}' };
  const rescueHtml = engine.renderPage(rescuePages[0], rescuePages, rescueTheme);
  const browser = await launchBrowser();
  try {
    const probeRes = await probe(browser, rescueHtml, 390, () => {
      const el = document.querySelector('.fx-fixed');
      return {
        clipDelta: el.scrollHeight - el.clientHeight,
        height: getComputedStyle(el).height,
      };
    });
    await acheck('(a3) guard script un-clips the fixed-height platform card at runtime', async () => {
      assert.ok(probeRes.clipDelta <= 1, `card still clipped by ${probeRes.clipDelta}px`);
      n += 1;
    });
  } finally {
    await browser.close();
  }
  const rescueGeo = await geo(rescuePages, rescueTheme);
  await acheck('(a3) geometry audit passes the rescued page (auto-fix, not just detection)', async () => {
    assert.equal(rescueGeo.pass, true, JSON.stringify(rescueGeo.violations).slice(0, 400));
    n += 1;
  });

  // (b1) TEXT-OVERLAP — heading pulled down over its own paragraph.
  const bandPages = fixturePage(
    '<div class="fx-band"><h2 class="fx-h">No office trip. No waiting room.</h2>' +
      '<p class="fx-p">The notary travels to the signer — home, office, hospital or care facility — anywhere in the county.</p></div>'
  );
  const bandTheme = { customCss: '.fx-band{background:#2b2b2e;color:#fff;padding:28px}.fx-h{margin:0 0 -18px;color:#fff}.fx-p{margin:0}' };
  const bandLegacy = await legacy(bandPages, bandTheme);
  await acheck('(b1) legacy 135 measurement is BLIND to the heading sitting on its paragraph', async () => {
    assert.equal(bandLegacy.pass, true, JSON.stringify(bandLegacy.violations).slice(0, 300));
    n += 1;
  });
  const bandGeo = await geo(bandPages, bandTheme);
  await acheck('(b1) geometry audit catches it as text-overlap', async () => {
    assert.equal(bandGeo.pass, false);
    const hits = bandGeo.violations.filter((v) => v.kind === 'text-overlap');
    assert.ok(hits.length >= 1, JSON.stringify(bandGeo.violations).slice(0, 400));
    n += 1;
  });

  // (b2) SIBLING-OVERLAP — a card pulled up over the band above it.
  const stackPages = fixturePage(
    '<div class="fx-band2"><p>Mobile and on-site service across the county, evenings included.</p></div>' +
      '<div class="fx-card2"><h3>At your location</h3><p>We meet where the signing happens.</p></div>'
  );
  const stackTheme = {
    customCss:
      '.fx-band2{background:#2b2b2e;color:#fff;padding:24px}.fx-card2{background:#fff;border:1px solid #999;padding:20px;margin-top:-24px}',
  };
  const stackLegacy = await legacy(stackPages, stackTheme);
  await acheck('(b2) legacy 135 measurement is BLIND to the card overlapping the band', async () => {
    assert.equal(stackLegacy.pass, true, JSON.stringify(stackLegacy.violations).slice(0, 300));
    n += 1;
  });
  const stackGeo = await geo(stackPages, stackTheme);
  await acheck('(b2) geometry audit catches it as sibling-overlap', async () => {
    assert.equal(stackGeo.pass, false);
    const hits = stackGeo.violations.filter((v) => v.kind === 'sibling-overlap');
    assert.ok(hits.length >= 1, JSON.stringify(stackGeo.violations).slice(0, 400));
    n += 1;
  });

  // (c) FAQ OVERLAP — the platform faq module's own details items
  // stacked into each other by a negative margin (the 1HP pattern).
  // The pull here (-30px !important) is stronger than the guard's
  // margin floor can absorb — the residue class the audit must catch.
  const faqPages = [
    {
      slug: 'index',
      title: 'Home',
      sections: [
        HERO,
        {
          type: 'faq',
          content: {
            heading: 'Questions',
            items: [
              { q: 'What ID do I need?', a: 'A current government photo ID for every signer.' },
              { q: 'Where do we meet?', a: 'At your home, office, or any public place in the county.' },
              { q: 'How fast can you come?', a: 'Same-day and last-minute appointments are welcome.' },
            ],
          },
        },
      ],
    },
  ];
  const faqTheme = { customCss: 'section[data-ws-section-type="faq"] details{margin-top:-30px!important}' };
  const faqLegacy = await legacy(faqPages, faqTheme);
  await acheck('(c) legacy 135 measurement is BLIND to overlapping FAQ items', async () => {
    assert.equal(faqLegacy.pass, true, JSON.stringify(faqLegacy.violations).slice(0, 300));
    n += 1;
  });
  const faqGeo = await geo(faqPages, faqTheme);
  await acheck('(c) geometry audit catches the FAQ overlap', async () => {
    assert.equal(faqGeo.pass, false);
    const hits = faqGeo.violations.filter((v) => v.kind === 'sibling-overlap' || v.kind === 'text-overlap');
    assert.ok(hits.length >= 1, JSON.stringify(faqGeo.violations).slice(0, 400));
    n += 1;
  });

  // (c2) the SAME overlap WITHOUT !important is auto-fixed by the
  // guard's faq margin floor — the audit then measures the page clean.
  const faqFixedGeo = await geo(faqPages, {
    customCss: 'section[data-ws-section-type="faq"] details{margin-top:-14px}',
  });
  await acheck('(c2) geometry audit passes the faq overlap the floor auto-fixed (no !important)', async () => {
    assert.equal(faqFixedGeo.pass, true, JSON.stringify(faqFixedGeo.violations).slice(0, 400));
    n += 1;
  });

  // (e) THE ROOT CAUSE — a baseCss-off build: the services renderer
  // emits .cards-grid with only an inline grid-template-columns; the
  // display:grid rule lived in the dropped base CSS. The guard now
  // guarantees the display mode in every render.
  const svcPages = [
    {
      slug: 'index',
      title: 'Home',
      sections: [
        HERO,
        {
          type: 'cards',
          content: {
            title: 'Services',
            cols: 3,
            items: [
              { title: 'Loan Signing', text: 'Refinance, purchase and HELOC packages signed at your table.' },
              { title: 'Apostille', text: 'Document authentication for international use, handled end to end.' },
              { title: 'General Notary', text: 'Acknowledgments, jurats and oaths anywhere in the county.' },
            ],
          },
        },
      ],
    },
  ];
  const svcTheme = { baseCss: false };
  const svcHtml = engine.renderPage(svcPages[0], svcPages, svcTheme);
  const browserE = await launchBrowser();
  try {
    const gridProbe = await probe(browserE, svcHtml, 980, () => {
      const g = document.querySelector('.cards-grid');
      const cards = Array.from(document.querySelectorAll('.cards-grid .card'));
      const cs = getComputedStyle(g);
      let stackGap = null;
      if (cards.length >= 2) {
        const a = cards[0].getBoundingClientRect();
        const b = cards[1].getBoundingClientRect();
        stackGap = Math.round((b.left > a.right - 1 ? b.left - a.right : b.top - a.bottom) * 10) / 10;
      }
      return { display: cs.display, stackGap };
    });
    await acheck('(e) baseCss-off build: .cards-grid computes to display:grid with real gaps', async () => {
      assert.equal(gridProbe.display, 'grid', JSON.stringify(gridProbe));
      assert.ok(gridProbe.stackGap >= 16, `card gap ${gridProbe.stackGap}px`);
      n += 1;
    });
  } finally {
    await browserE.close();
  }
  const svcGeo = await geo(svcPages, svcTheme);
  await acheck('(e) geometry audit passes the baseCss-off cards page', async () => {
    assert.equal(svcGeo.pass, true, JSON.stringify(svcGeo.violations).slice(0, 400));
    n += 1;
  });

  // (f) FREESTYLE BAND — a background band with zero padding of its
  // own (the 1HP charcoal band): text sits ON the box edge. The old
  // card-only clearance check could not see it; the generalized box
  // clearance check can.
  const bandFxPages = fixturePage(`<div class="fx-band"><h2>Mobile Service</h2><p>${LONG_COPY}</p></div>`);
  const bandFxTheme = { customCss: '.fx-band{background:#2b2b2e;color:#fff;padding:0}' };
  const bandFxLegacy = await legacy(bandFxPages, bandFxTheme);
  await acheck('(f) legacy 135 measurement is BLIND to text on a freestyle band edge', async () => {
    assert.equal(bandFxLegacy.pass, true, JSON.stringify(bandFxLegacy.violations).slice(0, 300));
    n += 1;
  });
  const bandFxGeo = await geo(bandFxPages, bandFxTheme);
  await acheck('(f) geometry audit catches it as card-text against the band box', async () => {
    assert.equal(bandFxGeo.pass, false);
    const hits = bandFxGeo.violations.filter((v) => v.kind === 'card-text');
    assert.ok(hits.length >= 1, JSON.stringify(bandFxGeo.violations).slice(0, 400));
    n += 1;
  });

  // (g) COL-CELL — column cells shipped with no padding at all; the
  // guard script raises them to the card-pad floor at runtime.
  const colPages = fixturePage(
    '<div class="cols" style="grid-template-columns:1fr 1fr">' +
      '<div class="col-cell"><h3>First column</h3><p>Column copy that used to sit on the cell edge.</p></div>' +
      '<div class="col-cell"><h3>Second column</h3><p>More copy in the second cell of the row.</p></div>' +
      '</div>'
  );
  const colHtml = engine.renderPage(colPages[0], colPages, {});
  const browserG = await launchBrowser();
  try {
    const colProbe = await probe(browserG, colHtml, 980, () => {
      const c = document.querySelector('.col-cell');
      const cs = getComputedStyle(c);
      return { pl: parseFloat(cs.paddingLeft) || 0, pt: parseFloat(cs.paddingTop) || 0 };
    });
    await acheck('(g) guard script raises col-cell padding to the floor', async () => {
      assert.ok(colProbe.pl >= 16 && colProbe.pt >= 16, JSON.stringify(colProbe));
      n += 1;
    });
  } finally {
    await browserG.close();
  }

  // (d) module cards are inside the audited card set now: two
  // bp-mod cards touching in a server-rendered mount pattern.
  const modPages = fixturePage(
    '<div class="bp-mod-dt-card"><h3>Directory One</h3><p>First listing copy.</p></div>' +
      '<div class="bp-mod-dt-card"><h3>Directory Two</h3><p>Second listing copy.</p></div>'
  );
  const modGeo = await geo(modPages, {});
  await acheck('(d) geometry audit measures module cards (card-gap fires on touching bp-mod cards)', async () => {
    assert.equal(modGeo.pass, false);
    const hits = modGeo.violations.filter((v) => v.kind === 'card-gap');
    assert.ok(hits.length >= 1, JSON.stringify(modGeo.violations).slice(0, 400));
    n += 1;
  });

  // no false positives: the well-spaced reference site stays clean
  // under the geometry audit at all widths.
  const goodGeo = await geo(goodPages(), {});
  await acheck('well-spaced site passes the geometry audit at 390/980/1440 (no false positives)', async () => {
    assert.equal(goodGeo.pass, true, JSON.stringify(goodGeo.violations).slice(0, 400));
    n += 1;
  });

  group('Part 2 chromium defect fixtures', n);
}

// ---------------------------------------------------------------------
// Part 3 — export audit unit (the shipped-artifact measurement)
// ---------------------------------------------------------------------
async function part3() {
  let n = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b185-export-'));
  const doc = (body, css) =>
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:sans-serif}${css || ''}</style></head><body>${body}</body></html>`;
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    doc(
      '<section data-ws-section-type="hero" style="padding:48px 28px"><h1>Clean Fixture</h1><p>Well spaced copy with room to breathe.</p></section>'
    )
  );
  fs.writeFileSync(
    path.join(dir, 'defect.html'),
    doc(
      '<section data-ws-section-type="html" style="padding:28px">' +
        '<div class="band2"><p>Mobile and on-site service across the county.</p></div>' +
        '<div class="card2"><h3>At your location</h3><p>We meet where the signing happens.</p></div></section>',
      '.band2{background:#2b2b2e;color:#fff;padding:24px}.card2{background:#fff;border:1px solid #999;padding:20px;margin-top:-24px}'
    )
  );
  const cleanOnly = await spacingQa.assessExportedFiles({ dir, files: ['index.html'] });
  await acheck('export audit: clean file passes, one file audited', async () => {
    assert.equal(cleanOnly.pass, true, cleanOnly.detail);
    assert.equal(cleanOnly.filesAudited, 1);
    assert.equal(cleanOnly.totalViolations, 0);
    n += 1;
  });
  const withDefect = await spacingQa.assessExportedFiles({ dir, files: ['index.html', 'defect.html'] });
  await acheck('export audit: the shipped defect file is measured and reported by kind', async () => {
    assert.equal(withDefect.pass, false);
    assert.equal(withDefect.filesAudited, 2);
    assert.ok((withDefect.byKind['sibling-overlap'] || 0) >= 1, JSON.stringify(withDefect.byKind));
    assert.ok(withDefect.violations.every((v) => typeof v.page === 'string' && typeof v.width === 'number'));
    n += 1;
  });
  group('Part 3 export audit', n);
}

// ---------------------------------------------------------------------
// Part 4 — qaSite wiring (in-process DB, batch135 pattern)
// ---------------------------------------------------------------------
async function part4() {
  let Database;
  try {
    Database = require('better-sqlite3');
    const probeDb = new Database(':memory:');
    probeDb.close();
  } catch {
    console.log('  skip Part 4 (better-sqlite3 unavailable under this Node build — the in-image gate runs it)');
    groups.push('Part 4 qaSite wiring (skipped locally)');
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
     VALUES (?, 'Geometry Fixture Co', 'Notary', '(610) 555-0136', 'team@geometry.example', 'Reading', 'PA', '2 Gap Way', '19601', 'US')`
  );
  const site = db.prepare(
    `INSERT INTO websites (id, lead_id, name, industry, theme, pages, status, preview_url, custom_domain, updated_at)
     VALUES (?, ?, 'Geometry Fixture Co', 'notary', ?, ?, 'draft', 'https://geometry.example', NULL, '2026-11-13 00:00:00')`
  );
  lead.run(7851);
  site.run(7851, 7851, JSON.stringify({}), JSON.stringify(goodPages()));
  lead.run(7852);
  const overlapPages = fixturePage(
    '<div class="fx-band"><h2 class="fx-h">No office trip. No waiting room.</h2>' +
      '<p class="fx-p">The notary travels to the signer — home, office, hospital or care facility.</p></div>'
  );
  site.run(
    7852,
    7852,
    JSON.stringify({
      baseCss: true,
      customCss: '.fx-band{background:#2b2b2e;color:#fff;padding:28px}.fx-h{margin:0 0 -18px;color:#fff}.fx-p{margin:0}',
    }),
    JSON.stringify(overlapPages)
  );

  const qaGood = await engine.qaSite(db, 7851);
  const spGood = (qaGood.checks || []).find((c) => c.name === 'spacing');
  await acheck('qaSite: spacing check passes the well-spaced site under the geometry audit', async () => {
    assert.ok(spGood, `spacing check missing: ${JSON.stringify((qaGood.checks || []).map((c) => c.name))}`);
    assert.equal(spGood.pass, true, spGood.detail);
    n += 1;
  });
  const qaBad = await engine.qaSite(db, 7852);
  const spBad = (qaBad.checks || []).find((c) => c.name === 'spacing');
  await acheck('qaSite: spacing check FAILS the heading-overlap site (the 1HP symptom, now a hard QA failure)', async () => {
    assert.ok(spBad, 'spacing check missing on the overlap site');
    assert.equal(spBad.pass, false, spBad.detail);
    assert.ok(spBad.detail.includes('text-overlap'), spBad.detail);
    n += 1;
  });
  db.close();
  group('Part 4 qaSite wiring', n);
}

(async () => {
  console.log('Batch 185 — spacing enforcement regressions');
  part1();
  if (process.env.B185_SKIP_BROWSER === '1') {
    console.log('  skip Parts 2-4 (B185_SKIP_BROWSER=1 — local iteration only)');
  } else {
    await part2();
    await part3();
    await part4();
  }
  console.log(`\nBATCH185 REGRESSION PASS — ${passed} checks: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH185 FAIL:', (e && e.stack) || e);
  process.exit(1);
});
