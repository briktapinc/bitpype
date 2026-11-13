'use strict';
/**
 * Batch 148 — SECTION LAYOUT KNOBS: CONTAINED vs FULL-WIDTH and
 * HIDE-ON-MOBILE (Ely's order 2026-11-05, extending the Batch 147
 * section editor with the two knobs 147 fenced off).
 *
 * Model: two fields ON the section object alongside `style` —
 *   width: 'full'        (absent = contained, today's behaviour)
 *   hideOnMobile: true   (absent = visible)
 * Setters delete the field at the default, so knob-free pages store
 * nothing new.
 *
 *   Part 1 — source pins (renderer hooks, ops, editor UI, census 442).
 *   Part 2 — pure model ops: set/unset round-trips, illegal values
 *     refused, chrome refused at op level, non-band module width
 *     refused, save-validation matrix, descriptor availability.
 *   Part 3 — BYTE-IDENTICAL DEFAULT: knob-free fixture pages render
 *     to the exact sha256 captured from the PRE-148 renderer (golden
 *     pins RE-PINNED at the Batch 185 finisher: Batch 185 deliberately
 *     extends the always-on spacing guard CSS — display:grid guarantee,
 *     mobile single-column collapse, faq margin floor — so every render
 *     changed bytes; the knob-free guarantee itself is unchanged: with
 *     no knobs set the output is exactly the current platform renderer's,
 *     and set-then-unset still returns to the pinned hash). (golden
 *     pins below; the footer carries the calendar year, so the pins
 *     hold for renders in 2026 — the structural no-bp-sec assertions
 *     are the year-proof half of the guarantee). Set-then-unset a
 *     knob and the render returns to the golden hash.
 *   Part 4 — renderer behaviour: band class + per-page rule block;
 *     per-page scoping; stacked preview.
 *   Part 5 — export materialization (writeStaticPages) matches the
 *     preview render; knob-free export carries neither class nor rule.
 *   Part 6 — real save path: knobs round-trip through
 *     applyClientLayoutSave; nav/footer knobs and illegal values are
 *     refused at save-validation level; refused saves change nothing.
 *   Part 7 — canvas: layout renders keep a mobile-hidden section
 *     visible (override rule ships), bridge badges/dims (source pins).
 *   Part 8 — spacing QA in real Chromium: a correctly built
 *     full-width band passes at 390/980/1440; bleed text inside a
 *     full-width band still fails text-edge; a mobile-hidden section
 *     is not measured on mobile but is measured on desktop.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b148-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch148', 'test', 'session', 'secret', 'value'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 21).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* Golden fixture — byte-for-byte the capture script used against the
 * pristine pre-148 engine (Batch 147 tip 0245d0e). */
const GOLDEN_THEME = { primary: '#0e7a68', secondary: '#6d4ea3', bg: '#fffaf4', text: '#1c140f', baseCss: true };
const goldenPages = () => [
  {
    slug: '/',
    title: 'Home',
    sections: [
      { type: 'nav', content: { brand: 'Golden Plants' } },
      { type: 'hero', id: 'hero-1', content: { headline: 'Plants!', subheadline: 'Green things for golden tests.' } },
      { type: 'text', id: 'intro', content: { heading: 'Intro', body: 'Hello from the golden fixture.' } },
      {
        type: 'services',
        id: 'svc',
        content: {
          heading: 'Services',
          items: [
            { title: 'Repotting', text: 'Fresh soil, bigger pot.' },
            { title: 'Pruning', text: 'Tidy cuts, healthy growth.' },
          ],
        },
      },
      {
        type: 'cta',
        id: 'cta-1',
        content: { heading: 'Visit us', text: 'Open weekends.', buttonText: 'Book', buttonHref: '/contact' },
      },
      { type: 'footer', content: {} },
    ],
  },
  {
    slug: '/about',
    title: 'About',
    sections: [
      { type: 'nav', content: { brand: 'Golden Plants' } },
      { type: 'heading', content: { heading: 'About us', level: 2 } },
      {
        type: 'site_module',
        content: { module_type: 'bookings', public_token: 'tok_golden_148', title: 'Book a visit' },
      },
      { type: 'html', content: { html: '<div class="golden-in"><p>Freestyle block copy.</p></div>' } },
      { type: 'footer', content: {} },
    ],
  },
];
const GOLDEN = {
  renderPageHome: '38d987084a59f410597fdc415e786a5c73f12905face549a20c9997d4456c89e',
  renderPageAbout: 'ab435b8e13e968ab5688470814bb21b704ded82a7125f92caba59a47b1b8315f',
  renderPageHomePreview: '05bd77c517a7ce941e74800887215218900ae207f74b86ea36809da3270bfb6d',
  renderSiteStacked: 'b84c191ccf929559d1d25b67bca65abffe267dd835fac623cb7aa1a4c1893d80',
  /* Export goldens: writeStaticPages output captured from the same
   * pristine pre-148 engine (the exporter adds its own transforms —
   * detail meta, legal links — on top of renderPage, so export pins
   * are pinned against export output, not render output). */
  exportIndex: '24077329e504bf5ce9426d8386ffd977e68f65ca1ae0e05d1e801eb9fe7af431',
  exportAbout: '9ba791b07cb92cbbd0c8122f60346300fe015262150e552d7f6c26a4a5872766',
};

const LEAD_A = 148001;
let WS_ID;

(async () => {
  const structure = require(path.join(root, 'src/siteStructure.js'));
  const engine = require(path.join(root, 'src/websiteEngine.js'));

  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const eng = read('src/websiteEngine.js');
    assert.ok(eng.includes('function sectionLayoutCss'), 'engine builds the per-page knob rule block');
    assert.ok(eng.includes('data-bp-section-layout'), 'rule block carries its own style marker');
    assert.ok(eng.includes('bp-sec-full') && eng.includes('bp-sec-nomobile'), 'engine stamps both knob classes');
    assert.ok(
      eng.includes('.bp-sec-full>.container{max-width:none}'),
      'full-width rule releases the band container (no !important)'
    );
    assert.ok(
      eng.includes('@media (max-width:700px){.bp-sec-nomobile{display:none!important}}'),
      'hide rule uses the platform 700px breakpoint'
    );
    n += 5;
    const st = read('src/siteStructure.js');
    for (const fn of [
      'getSectionWidth',
      'setSectionWidth',
      'getSectionHideOnMobile',
      'setSectionHideOnMobile',
      'validateSectionLayoutKnobs',
    ]) {
      assert.ok(st.includes(`function ${fn}`), `siteStructure has ${fn}`);
      n++;
    }
    const chat = read('server/portalSiteChat.js');
    assert.ok(chat.includes('validateSectionLayoutKnobs'), 'layout save re-validates the knobs server-side');
    n++;
    const portalJs = read('public/js/portal.js');
    for (const fn of ['layoutWidthKnob', 'layoutHideMobileKnob', 'layoutSetWidth', 'layoutSetHideMobile']) {
      assert.ok(portalJs.includes(`function ${fn}`), `portal has ${fn}`);
      n++;
    }
    const bridge = read('public/js/layout-bridge.js');
    assert.ok(bridge.includes('Hidden on mobile') && bridge.includes('Full width'), 'bridge badges both knobs');
    assert.ok(bridge.includes('bp-layout-dim'), 'bridge dims mobile-hidden sections');
    n += 2;
    const portalHtml = read('public/portal.html');
    assert.ok(
      portalHtml.includes('.layout-seg-btn') && portalHtml.includes('.layout-switch-row'),
      'portal styles the new knobs'
    );
    n++;
    const { census } = require(path.join(root, 'scripts/xss-census.cjs'));
    // Batch 156 rotation: census 450 -> 453 (+1 STATIC +1 ESCAPED +1 SAFE in app.js — the fingerprint surfaces), safe classes 336 -> 339, RAW 78 / IDENT 36 and the 114-entry reviewed set unchanged; baseline regenerated. Batch 161 rotation: census 453 -> 470 (+17 audited Assistant-surface sinks in app.js/portal.js, pairwise multiset-proven vs the 159 census — see batch103 narrative), safe classes 339 -> 351, RAW 81 / IDENT 38, reviewed set 119 entries; baseline regenerated.
    assert.equal(census().summary.total, 514, 'SEC-13 census total unchanged by Batch 148 (Batch 139 finisher rotation: +2 audited safe-class sinks, module-embed pricing renderer; Batch 153: census 448 -> 450 — +1 BUILDER +1 RAW in app.js, both the Admin Design-agent editor (rows build — every interpolated value esc()-wrapped; panel shell classified RAW by the conservative classifier, audited: its interpolations are a fixed literal seed note and the numeric limits only, no staff- or visitor-controlled string reaches it unescaped); BUILDER 59 -> 60, RAW 77 -> 78, safe classes 335 -> 336; remaining app.js RAW/IDENT movement is pure line shift from the editor + popup insertions, (file,kind,snippet) multiset diff vs the Batch 139 base = exactly these two sinks; baseline regenerated)');
    n++;
    group('Part 1 — source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — pure model ops                                             */
  /* ================================================================== */
  {
    let n = 0;
    const sec = () => ({ type: 'text', content: { heading: 'A' } });
    // Defaults: absent fields read as contained + visible.
    assert.equal(structure.getSectionWidth(sec()), 'contained');
    assert.equal(structure.getSectionHideOnMobile(sec()), false);
    n += 2;
    // Set + unset round-trips: the object returns to EXACTLY its
    // original shape (nothing stored at the default).
    const s = sec();
    const before = JSON.stringify(s);
    structure.setSectionWidth(s, 'full');
    assert.equal(s.width, 'full');
    assert.equal(structure.getSectionWidth(s), 'full');
    structure.setSectionWidth(s, 'contained');
    assert.ok(!('width' in s), 'contained clears the field');
    structure.setSectionHideOnMobile(s, true);
    assert.equal(s.hideOnMobile, true);
    assert.equal(structure.getSectionHideOnMobile(s), true);
    structure.setSectionHideOnMobile(s, false);
    assert.ok(!('hideOnMobile' in s), 'visible clears the field');
    assert.equal(JSON.stringify(s), before, 'set+unset returns the section to its exact original shape');
    n += 7;
    // Illegal values refused with codes.
    assert.throws(
      () => structure.setSectionWidth(sec(), 'wide'),
      (e) => e.code === 'INVALID_WIDTH'
    );
    assert.throws(
      () => structure.setSectionWidth(sec(), '100%'),
      (e) => e.code === 'INVALID_WIDTH'
    );
    assert.throws(
      () => structure.setSectionHideOnMobile(sec(), 'yes'),
      (e) => e.code === 'INVALID_HIDE_ON_MOBILE'
    );
    n += 3;
    // Chrome refused at OP level, both knobs.
    for (const type of ['nav', 'footer']) {
      assert.throws(
        () => structure.setSectionWidth({ type, content: {} }, 'full'),
        (e) => e.code === 'CHROME_KNOB'
      );
      assert.throws(
        () => structure.setSectionHideOnMobile({ type, content: {} }, true),
        (e) => e.code === 'CHROME_KNOB'
      );
      n += 2;
    }
    // Non-band module (chatbot overlay) refuses width, allows hide.
    assert.throws(
      () => structure.setSectionWidth({ type: 'site_module', content: {} }, 'full', 'chatbot'),
      (e) => e.code === 'WIDTH_NOT_AVAILABLE'
    );
    const mount = { type: 'site_module', content: {} };
    structure.setSectionWidth(mount, 'full', 'bookings');
    assert.equal(mount.width, 'full', 'band modules (bookings) may go full-width');
    n += 2;
    // Save-validation matrix.
    const clean = [sec(), Object.assign(sec(), { width: 'full' }), Object.assign(sec(), { hideOnMobile: true })];
    assert.deepEqual(
      structure.validateSectionLayoutKnobs(clean, () => null),
      [],
      'legal knobs validate clean'
    );
    n++;
    const codes = (list, resolver) => structure.validateSectionLayoutKnobs(list, resolver).map((p) => p.code);
    assert.ok(codes([Object.assign(sec(), { width: 'wide' })], () => null).includes('INVALID_WIDTH'));
    assert.ok(codes([Object.assign(sec(), { hideOnMobile: 'yes' })], () => null).includes('INVALID_HIDE_ON_MOBILE'));
    assert.ok(codes([{ type: 'nav', content: {}, width: 'full' }], () => null).includes('CHROME_KNOB'));
    assert.ok(codes([{ type: 'footer', content: {}, hideOnMobile: true }], () => null).includes('CHROME_KNOB'));
    assert.ok(
      codes([{ type: 'site_module', content: {}, width: 'full' }], () => 'chatbot').includes('WIDTH_NOT_AVAILABLE')
    );
    n += 5;
    // Descriptor availability + reported state.
    const dNav = structure.describeEditorSection({ type: 'nav', content: {} }, 0, () => null);
    assert.deepEqual([dNav.canWidth, dNav.canHideMobile], [false, false], 'chrome gets neither knob');
    const dText = structure.describeEditorSection(sec(), 1, () => null);
    assert.deepEqual(
      [dText.canWidth, dText.canHideMobile, dText.width, dText.hideOnMobile],
      [true, true, 'contained', false],
      'content section reports both knobs at defaults'
    );
    const dKnob = structure.describeEditorSection(
      Object.assign(sec(), { width: 'full', hideOnMobile: true }),
      2,
      () => null
    );
    assert.deepEqual([dKnob.width, dKnob.hideOnMobile], ['full', true], 'descriptor reports set knobs');
    const dChat = structure.describeEditorSection({ type: 'site_module', content: {} }, 3, () => 'chatbot');
    assert.deepEqual([dChat.canWidth, dChat.canHideMobile], [false, true], 'chatbot: no width, hide allowed');
    n += 4;
    group('Part 2 — pure model ops', n);
  }

  /* ================================================================== */
  /* Part 3 — byte-identical default (golden hashes)                     */
  /* ================================================================== */
  {
    let n = 0;
    const pages = goldenPages();
    assert.equal(
      sha256(engine.renderPage(pages[0], pages, GOLDEN_THEME)),
      GOLDEN.renderPageHome,
      'home render byte-identical'
    );
    assert.equal(
      sha256(engine.renderPage(pages[1], pages, GOLDEN_THEME)),
      GOLDEN.renderPageAbout,
      'about render byte-identical'
    );
    assert.equal(
      sha256(engine.renderPage(pages[0], pages, GOLDEN_THEME, { preview: true })),
      GOLDEN.renderPageHomePreview,
      'preview render byte-identical'
    );
    assert.equal(
      sha256(engine.renderSite(pages, GOLDEN_THEME, { preview: true })),
      GOLDEN.renderSiteStacked,
      'stacked preview byte-identical'
    );
    n += 4;
    const home = engine.renderPage(pages[0], pages, GOLDEN_THEME);
    assert.ok(!home.includes('bp-sec-'), 'knob-free render carries no knob classes');
    assert.ok(!home.includes('data-bp-section-layout'), 'knob-free render carries no rule block');
    n += 2;
    // Set then unset BOTH knobs on a section: render returns to golden.
    const pages2 = goldenPages();
    structure.setSectionWidth(pages2[0].sections[2], 'full');
    structure.setSectionHideOnMobile(pages2[0].sections[2], true);
    structure.setSectionWidth(pages2[0].sections[2], 'contained');
    structure.setSectionHideOnMobile(pages2[0].sections[2], false);
    assert.equal(
      sha256(engine.renderPage(pages2[0], pages2, GOLDEN_THEME)),
      GOLDEN.renderPageHome,
      'set+unset renders golden again'
    );
    n++;
    group('Part 3 — byte-identical default', n);
  }

  /* ================================================================== */
  /* Part 4 — renderer behaviour                                         */
  /* ================================================================== */
  {
    let n = 0;
    const pages = goldenPages();
    structure.setSectionWidth(pages[0].sections[3], 'full'); // services
    structure.setSectionHideOnMobile(pages[0].sections[4], true); // cta
    const home = engine.renderPage(pages[0], pages, GOLDEN_THEME);
    assert.ok(
      /data-ws-section-type="services"[^>]*class="[^"]*bp-sec-full/.test(home) ||
        /class="[^"]*bp-sec-full[^"]*"[^>]*data-ws-section-type="services"/.test(home),
      'full-width section root carries bp-sec-full'
    );
    assert.ok(/bp-sec-nomobile/.test(home), 'mobile-hidden section root carries bp-sec-nomobile');
    const block = /<style data-bp-section-layout="1">([^<]*)<\/style>/.exec(home);
    assert.ok(block, 'rule block emitted when knobs are set');
    assert.ok(block[1].includes('.bp-sec-full>.container{max-width:none}'), 'block carries the full-width rule');
    assert.ok(
      block[1].includes('@media (max-width:700px){.bp-sec-nomobile{display:none!important}}'),
      'block carries the ≤700px hide rule'
    );
    n += 5;
    // Per-page scoping: the untouched about page renders NO block.
    const about = engine.renderPage(pages[1], pages, GOLDEN_THEME);
    assert.ok(!about.includes('data-bp-section-layout'), 'rule block is per-page, not site-wide');
    assert.equal(sha256(about), GOLDEN.renderPageAbout, 'sibling page stays byte-identical');
    n += 2;
    // Width alone emits only the width rule; hide alone only the hide rule.
    assert.equal(
      engine.sectionLayoutCss([{ sections: [{ width: 'full' }] }]),
      '.bp-sec-full>.container{max-width:none}'
    );
    assert.equal(
      engine.sectionLayoutCss([{ sections: [{ hideOnMobile: true }] }]),
      '@media (max-width:700px){.bp-sec-nomobile{display:none!important}}'
    );
    assert.equal(engine.sectionLayoutCss([{ sections: [{}] }]), '', 'no knobs → empty rule block');
    n += 3;
    // Stacked preview includes the block (computed across pages).
    const stacked = engine.renderSite(pages, GOLDEN_THEME, { preview: true });
    assert.ok(stacked.includes('data-bp-section-layout'), 'stacked preview carries the rule block');
    n++;
    group('Part 4 — renderer behaviour', n);
  }

  /* ================================================================== */
  /* Part 5 — export materialization                                     */
  /* ================================================================== */
  {
    let n = 0;
    const pages = goldenPages();
    structure.setSectionWidth(pages[0].sections[2], 'full'); // text intro
    structure.setSectionHideOnMobile(pages[0].sections[3], true); // services
    const outDir = path.join(temp, 'export-knobbed');
    engine.writeStaticPages(pages, GOLDEN_THEME, outDir, {});
    const indexHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('bp-sec-full'), 'exported home carries the full-width class');
    assert.ok(indexHtml.includes('bp-sec-nomobile'), 'exported home carries the mobile-hidden class');
    const block = /<style data-bp-section-layout="1">([^<]*)<\/style>/.exec(indexHtml);
    assert.ok(block && block[1].includes('@media (max-width:700px)'), 'exported home carries the rule block');
    n += 3;
    const aboutHtml = fs.readFileSync(path.join(outDir, 'about.html'), 'utf8');
    assert.ok(!aboutHtml.includes('data-bp-section-layout'), 'exported sibling page carries no rule block');
    n++;
    const plainDir = path.join(temp, 'export-plain');
    engine.writeStaticPages(goldenPages(), GOLDEN_THEME, plainDir, {});
    const plainHtml = fs.readFileSync(path.join(plainDir, 'index.html'), 'utf8');
    assert.equal(sha256(plainHtml), GOLDEN.exportIndex, 'knob-free export is byte-identical to the pre-148 export');
    const plainAbout = fs.readFileSync(path.join(plainDir, 'about.html'), 'utf8');
    assert.equal(sha256(plainAbout), GOLDEN.exportAbout, 'knob-free about export is byte-identical too');
    n += 2;
    group('Part 5 — export materialization', n);
  }

  /* ================================================================== */
  /* Setup for Parts 6–7 — fixture workspace + site                      */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const portal = require(path.join(root, 'server/clientPortal.js'));
  const a = await workspace.createUserWithWorkspace({
    email: 'a148@example.invalid',
    password: ['batch148', 'test', 'password'].join('-'),
    name: 'A148',
    workspaceName: 'Batch148 WS',
  });
  WS_ID = Number(a.workspaceId);
  const db = openWorkspaceDb(WS_ID);
  db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
    LEAD_A,
    'B148 Plant Shop',
    'aplants148@example.invalid',
    'customer'
  );
  const theme148 = { primary: '#0e7a68', secondary: '#6d4ea3', bg: '#fffaf4', text: '#1c140f' };
  const pages148 = [
    {
      slug: '/',
      title: 'Home',
      sections: [
        { type: 'nav', content: { brand: 'B148 Plant Shop' } },
        { type: 'hero', id: 'hero-1', content: { headline: 'Plants!', subheadline: 'Green things.' } },
        { type: 'text', id: 'intro', content: { heading: 'Intro', body: 'Hello.' } },
        { type: 'footer', content: {} },
      ],
    },
  ];
  db.prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)').run(
    LEAD_A,
    'B148 Plant Shop',
    'draft',
    JSON.stringify(pages148),
    JSON.stringify(theme148)
  );

  /* ================================================================== */
  /* Part 6 — real save path: round-trip + refusals                      */
  /* ================================================================== */
  {
    let n = 0;
    // Descriptors through the real editor API carry the knob flags.
    const ed = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    const [dNav, , dText, dFooter] = ed.descriptors;
    assert.deepEqual(
      [dNav.canWidth, dNav.canHideMobile, dFooter.canWidth, dFooter.canHideMobile],
      [false, false, false, false],
      'editor API fences chrome knobs'
    );
    assert.deepEqual(
      [dText.canWidth, dText.canHideMobile, dText.width, dText.hideOnMobile],
      [true, true, 'contained', false],
      'editor API reports knob defaults'
    );
    n += 2;

    // Round-trip: set both knobs on the text section, save, re-read.
    const work = JSON.parse(JSON.stringify(ed.sections));
    structure.setSectionWidth(work[2], 'full');
    structure.setSectionHideOnMobile(work[2], true);
    portal.applyClientLayoutSave(WS_ID, LEAD_A, { slug: '/', sections: work });
    const re = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    const rt = re.sections.find((s) => s.id === 'intro');
    assert.equal(rt.width, 'full', 'width knob round-trips through the real save path');
    assert.equal(rt.hideOnMobile, true, 'hide knob round-trips through the real save path');
    const dRt = re.descriptors[re.sections.indexOf(rt)];
    assert.deepEqual([dRt.width, dRt.hideOnMobile], ['full', true], 'descriptors report the saved knobs');
    n += 3;

    // Unset both: the stored section carries NEITHER field again.
    const work2 = JSON.parse(JSON.stringify(re.sections));
    const t2 = work2.find((s) => s.id === 'intro');
    structure.setSectionWidth(t2, 'contained');
    structure.setSectionHideOnMobile(t2, false);
    portal.applyClientLayoutSave(WS_ID, LEAD_A, { slug: '/', sections: work2 });
    const re2 = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    const rt2 = re2.sections.find((s) => s.id === 'intro');
    assert.ok(!('width' in rt2) && !('hideOnMobile' in rt2), 'unset knobs store nothing');
    n++;

    // Refusals at SAVE-VALIDATION level (hand-crafted payloads).
    const fresh = () => JSON.parse(JSON.stringify(re2.sections));
    const expectCode = (sections, code) => {
      assert.throws(
        () => portal.applyClientLayoutSave(WS_ID, LEAD_A, { slug: '/', sections }),
        (e) => e.code === code,
        `save refuses with ${code}`
      );
      n++;
    };
    const navWide = fresh();
    navWide[0] = Object.assign({}, navWide[0], { width: 'full' });
    expectCode(navWide, 'CHROME_KNOB');
    const footerHidden = fresh();
    footerHidden[footerHidden.length - 1] = Object.assign({}, footerHidden[footerHidden.length - 1], {
      hideOnMobile: true,
    });
    expectCode(footerHidden, 'CHROME_KNOB');
    const badWidth = fresh();
    badWidth[2] = Object.assign({}, badWidth[2], { width: 'wide' });
    expectCode(badWidth, 'INVALID_WIDTH');
    const badHide = fresh();
    badHide[2] = Object.assign({}, badHide[2], { hideOnMobile: 'yes' });
    expectCode(badHide, 'INVALID_HIDE_ON_MOBILE');
    // A refused save changes nothing.
    const reAfter = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    assert.deepEqual(
      JSON.stringify(reAfter.sections),
      JSON.stringify(re2.sections),
      'refused saves leave the stored model untouched'
    );
    n++;
    group('Part 6 — save path round-trip + refusals', n);
  }

  /* ================================================================== */
  /* Part 7 — canvas behaviour                                           */
  /* ================================================================== */
  {
    let n = 0;
    const pages = [
      {
        slug: '/',
        title: 'Home',
        sections: [
          { type: 'nav', content: { brand: 'Canvas Co' } },
          { type: 'text', id: 'ghost', hideOnMobile: true, content: { heading: 'GhostHeading148', body: 'Boo.' } },
          { type: 'text', id: 'wide', width: 'full', content: { heading: 'WideHeading148', body: 'Wide.' } },
          { type: 'footer', content: {} },
        ],
      },
    ];
    const canvas = engine.renderPageAt(pages, theme148, { layoutEditor: true, preview: true, pageSlug: '/' });
    assert.ok(canvas.includes('GhostHeading148'), 'mobile-hidden section still renders in the canvas');
    assert.ok(
      /@media \(max-width:700px\)\{\[data-bp-layout-section\]\.bp-sec-nomobile\{display:block!important\}\}/.test(
        canvas
      ),
      'canvas ships the keep-visible override for mobile-hidden sections'
    );
    assert.ok(canvas.includes('.bp-layout-dim{opacity:.55}'), 'canvas ships the dim style');
    assert.ok(canvas.includes('data-bp-section-layout="1"'), 'canvas carries the page rule block');
    n += 4;
    // The plain (visitor) render of the same page hides nothing at the
    // HTML level — hiding is purely the ≤700px CSS rule.
    const plain = engine.renderPage(pages[0], pages, theme148);
    assert.ok(plain.includes('GhostHeading148'), 'hidden section content is in the document (CSS hides it on mobile)');
    assert.ok(!plain.includes('data-bp-layout-section'), 'plain render carries no canvas markers');
    n += 2;
    group('Part 7 — canvas behaviour', n);
  }

  /* ================================================================== */
  /* Part 8 — spacing QA in real Chromium                                */
  /* ================================================================== */
  {
    let n = 0;
    const spacingQa = require(path.join(root, 'server/spacingQa.js'));
    {
      const assess = async (pages, theme) => spacingQa.assessSpacing(pages, theme, { renderPage: engine.renderPage });

      const svcSection = (extra) =>
        Object.assign(
          {
            type: 'services',
            content: {
              heading: 'Services',
              items: [
                { title: 'Repotting', text: 'Fresh soil, bigger pot, happy roots.' },
                { title: 'Pruning', text: 'Tidy cuts, healthy growth all season.' },
                { title: 'Consult', text: 'A walkthrough of light, water and space.' },
              ],
            },
          },
          extra || {}
        );
      const baseTheme = { primary: '#0e7a68', bg: '#fffaf4', text: '#1c140f', baseCss: true };
      const mkPages = (sections) => [{ slug: '/', title: 'Home', sections }];

      // (a) A correctly built FULL-WIDTH band passes everywhere.
      const widePages = mkPages([
        { type: 'nav', content: { brand: 'QA Plants' } },
        { type: 'hero', content: { headline: 'Plants!', subheadline: 'Green things.' } },
        svcSection({ width: 'full' }),
        { type: 'footer', content: {} },
      ]);
      const wideQa = await assess(widePages, baseTheme);
      assert.equal(
        wideQa.pass,
        true,
        `full-width band passes spacing QA: ${JSON.stringify(wideQa.violations).slice(0, 300)}`
      );
      n++;

      // (b) Bleed text inside a full-width band still fails text-edge.
      const bleedPages = mkPages([
        { type: 'nav', content: { brand: 'QA Plants' } },
        {
          type: 'html',
          width: 'full',
          content: {
            html: '<p class="fx-bleed148">This paragraph bleeds back to the viewport edge.</p><p>Normal copy sits inside the inset.</p>',
          },
        },
        { type: 'footer', content: {} },
      ]);
      const bleedTheme = Object.assign({}, baseTheme, {
        customCss: '.fx-bleed148{margin-left:-28px;margin-right:-28px}',
      });
      const bleedQa = await assess(bleedPages, bleedTheme);
      assert.equal(bleedQa.pass, false, 'bleed inside a full-width band still fails QA');
      assert.ok(
        bleedQa.violations.some((v) => v.kind === 'text-edge' && v.width === 1440),
        `text-edge caught at 1440 inside the full-width band: ${JSON.stringify(bleedQa.violations).slice(0, 300)}`
      );
      n += 2;

      // (c) A mobile-hidden section is not measured on mobile (it is
      // display:none there) but IS measured on desktop.
      const ghostPages = mkPages([
        { type: 'nav', content: { brand: 'QA Plants' } },
        {
          type: 'html',
          hideOnMobile: true,
          content: { html: '<p class="fx-bleed148">Ghost bleed copy that only exists on desktop.</p>' },
        },
        { type: 'footer', content: {} },
      ]);
      const ghostQa = await assess(ghostPages, bleedTheme);
      assert.ok(
        ghostQa.violations.some((v) => v.kind === 'text-edge' && v.width === 1440),
        'hidden section still measured at desktop width'
      );
      assert.ok(
        !ghostQa.violations.some((v) => v.kind === 'text-edge' && v.width === 390),
        'hidden section not measured at mobile width (display:none)'
      );
      n += 2;
    }
    group('Part 8 — spacing QA (Chromium)', n);
  }

  console.log(`\nBatch 148 section-layout-knobs regressions: ALL GREEN — ${groups.length} groups`);
  for (const g of groups) console.log(`  - ${g}`);
})().catch((e) => {
  console.error('Batch 148 section-layout-knobs regressions FAILED:', e);
  process.exit(1);
});
