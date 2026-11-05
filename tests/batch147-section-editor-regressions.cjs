'use strict';
/**
 * Batch 147 — NATIVE SECTION EDITOR (Ely's order 2026-11-05).
 *
 * A GrapesJS-style editor built on the platform's own page model:
 * the portal gets an "Edit layout" mode whose canvas is a server
 * render of the section list (never exported HTML), with drag
 * reorder + keyboard-usable up/down, duplicate, delete, an ADD
 * palette, session undo, and safe layout knobs — saved through the
 * EXISTING page update path (domain.sitesSave) so editor saves and
 * design saves can never diverge. Original code; no GrapesJS source.
 *
 *   Part 1 — source pins (routes, bridge, originality, census 442).
 *   Part 2 — pure model ops: movable-slot moves produce exact lists;
 *     nav/footer locked; hero/banner pinned; duplicate deep-copies
 *     with fresh identity; fences refuse; delete refuses chrome;
 *     structural validation; padding floor REFUSES sub-floor values;
 *     background writes the existing content field.
 *   Part 3 — portal API on a fixture site: descriptors, palette,
 *     section building through the design path's own structures.
 *   Part 4 — save round-trips through the real update path (version
 *     snapshot written; re-read returns the edited model), and an
 *     editor save interleaved with design-path saves cannot corrupt
 *     the page.
 *   Part 5 — save rejections: foreign tokens, fenced duplicates,
 *     structural violations, sub-floor padding, invalid colour,
 *     freeform pages.
 *   Part 6 — singleton semantics: duplicating a module mount leaves
 *     the singleton embed + settings rows untouched; deleting one of
 *     two mounts keeps the module live; deleting the LAST mount
 *     unpublishes the embed (data kept) and the mount never
 *     resurrects through sync.
 *   Part 7 — canvas render: layout renders stamp section roots and
 *     inline the bridge; plain renders carry neither; an unsaved
 *     model renders in the canvas without touching stored pages.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b147-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch147', 'test', 'session', 'secret', 'value'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 21).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const LEAD_A = 147001;
const LEAD_B = 147002;
let WS_ID;
let db;

const types = (sections) => sections.map((s) => s.type);

(async () => {
  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const routes = read('server/routes/portal.js');
    assert.ok(routes.includes("router.get('/site/layout'"), 'GET /site/layout route exists');
    n++;
    assert.ok(routes.includes("router.post('/site/layout'"), 'POST /site/layout route exists');
    n++;
    assert.ok(routes.includes("router.post('/site/layout/section'"), 'POST /site/layout/section route exists');
    n++;
    assert.ok(routes.includes("router.post('/site/layout/render'"), 'POST /site/layout/render route exists');
    n++;
    const chat = read('server/portalSiteChat.js');
    for (const fn of ['getClientLayoutEditor', 'buildClientLayoutSection', 'applyClientLayoutSave']) {
      assert.ok(chat.includes(`function ${fn}`), `portal wrapper ${fn} exists`);
      n++;
    }
    assert.ok(chat.includes('domain.sitesSave'), 'editor save goes through domain.sitesSave (the real update path)');
    n++;
    const bridge = read('public/js/layout-bridge.js');
    assert.ok(bridge.includes('bp-layout-bridge'), 'canvas bridge posts bp-layout-bridge messages');
    n++;
    assert.ok(!/\.innerHTML\s*=/.test(bridge), 'bridge builds its toolbar with DOM APIs (no innerHTML)');
    n++;
    const engine = read('src/websiteEngine.js');
    assert.ok(engine.includes('data-bp-layout-section'), 'engine stamps layout section roots');
    n++;
    assert.ok(engine.includes('layout-bridge.js'), 'engine inlines the layout bridge for layout renders');
    n++;
    const portalHtml = read('public/portal.html');
    assert.ok(portalHtml.includes('id="btn-layout"'), 'portal has the Layout button');
    n++;
    assert.ok(portalHtml.includes('id="layout-bar"'), 'portal has the layout bar');
    n++;
    // Originality: no GrapesJS code or references anywhere in the app.
    for (const rel of [
      'src/siteStructure.js',
      'src/websiteEngine.js',
      'server/portalSiteChat.js',
      'public/js/layout-bridge.js',
      'public/js/portal.js',
    ]) {
      assert.ok(!/grapesjs/i.test(read(rel)), `${rel} carries no GrapesJS code`);
      n++;
    }
    // SEC-13 census unchanged — the new portal code adds no sinks.
    const { census } = require(path.join(root, 'scripts/xss-census.cjs'));
    assert.equal(census().summary.total, 446, 'SEC-13 census total unchanged by Batch 147');
    n++;
    group('Part 1 — source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — pure model ops                                             */
  /* ================================================================== */
  {
    let n = 0;
    const structure = require(path.join(root, 'src/siteStructure.js'));
    const base = () => [
      { type: 'nav', content: {} },
      { type: 'hero', id: 'hero', content: {} },
      { type: 'text', id: 'a', content: { heading: 'A' } },
      { type: 'services', id: 'b', content: {} },
      { type: 'text', id: 'c', content: { heading: 'C' } },
      { type: 'footer', content: {} },
    ];
    const ids = (list) => list.map((s) => s.id || s.type);

    // Movable-slot move: a (idx2) dropped past c lands after c; nav,
    // hero and footer keep their absolute slots.
    let r = structure.moveSectionToIndex(base(), 2, 4);
    assert.equal(r.changed, true);
    assert.deepEqual(ids(r.sections), ['nav', 'hero', 'b', 'c', 'a', 'footer']);
    n += 2;
    // Move c to the very top: it can only reach the first movable slot
    // (after the pinned hero).
    r = structure.moveSectionToIndex(base(), 4, 0);
    assert.deepEqual(ids(r.sections), ['nav', 'hero', 'c', 'a', 'b', 'footer']);
    n++;
    // Dropping past the footer clamps to the last movable slot.
    r = structure.moveSectionToIndex(base(), 2, 99);
    assert.deepEqual(ids(r.sections), ['nav', 'hero', 'b', 'c', 'a', 'footer']);
    n++;
    // Locked sections refuse to move.
    for (const idx of [0, 1, 5]) {
      r = structure.moveSectionToIndex(base(), idx, 3);
      assert.equal(r.changed, false, `index ${idx} is locked`);
      assert.equal(r.reason, 'locked');
      n += 2;
    }
    // Input is never mutated.
    const frozen = base();
    structure.moveSectionToIndex(frozen, 2, 4);
    assert.deepEqual(ids(frozen), ['nav', 'hero', 'a', 'b', 'c', 'footer']);
    n++;

    // Duplicate: deep copy after the source, fresh identity, and the
    // copy is independent of the source object.
    const dup = structure.duplicateSectionAt(base(), 2);
    assert.equal(dup.changed, true);
    assert.equal(dup.sections.length, 7);
    assert.equal(dup.section.id, 'a-copy');
    assert.equal(dup.sections[3].id, 'a-copy');
    dup.section.content.heading = 'Changed';
    assert.equal(dup.sections[2].content.heading, 'A', 'duplicate is a deep copy');
    n += 5;
    // Duplicate again from the same source: identity stays unique.
    const dup2 = structure.duplicateSectionAt(dup.sections, 2);
    assert.equal(dup2.section.id, 'a-copy-2');
    n++;
    // Chrome cannot duplicate.
    for (const idx of [0, 5]) {
      const bad = structure.duplicateSectionAt(base(), idx);
      assert.equal(bad.changed, false);
      assert.equal(bad.reason, 'chrome');
      n += 2;
    }
    // Fenced module types refuse with a reason.
    for (const mt of ['chatbot', 'checkout']) {
      const bad = structure.duplicateSectionAt(base(), 2, mt);
      assert.equal(bad.changed, false, `${mt} duplicate fenced`);
      assert.equal(bad.reason, 'fenced_module');
      assert.ok(bad.message && bad.message.length > 10, 'fence carries a reason');
      n += 3;
    }
    // A non-fenced module duplicates its reference freely.
    const okDup = structure.duplicateSectionAt(base(), 2, 'bookings');
    assert.equal(okDup.changed, true);
    n++;

    // Delete: chrome refuses, content goes.
    for (const idx of [0, 5]) {
      const bad = structure.removeSectionAt(base(), idx);
      assert.equal(bad.changed, false);
      assert.equal(bad.reason, 'chrome');
      n += 2;
    }
    const del = structure.removeSectionAt(base(), 3);
    assert.equal(del.changed, true);
    assert.deepEqual(ids(del.sections), ['nav', 'hero', 'a', 'c', 'footer']);
    n += 2;

    // Structural validation.
    assert.deepEqual(structure.validateEditorSections(base()), []);
    n++;
    assert.equal(structure.validateEditorSections([{ type: 'text' }, { type: 'nav' }])[0].code, 'NAV_NOT_FIRST');
    n++;
    assert.equal(structure.validateEditorSections([{ type: 'nav' }, { type: 'nav' }])[0].code, 'NAV_DUPLICATE');
    n++;
    assert.equal(structure.validateEditorSections([{ type: 'footer' }, { type: 'text' }])[0].code, 'FOOTER_NOT_LAST');
    n++;
    assert.equal(
      structure.validateEditorSections([{ type: 'text' }, { type: 'footer' }, { type: 'footer' }])[0].code,
      'FOOTER_DUPLICATE'
    );
    n++;

    // Padding knob: writes the existing style field, floor REFUSES.
    const sec = { type: 'text', content: {}, style: 'color:red' };
    structure.setSectionPaddingPx(sec, 64);
    assert.equal(structure.getSectionPaddingPx(sec), 64);
    assert.ok(sec.style.includes('color:red'), 'other declarations preserved');
    n += 2;
    assert.throws(() => structure.setSectionPaddingPx({ type: 'text', content: {} }, 21), /spacing floor/);
    n++;
    assert.throws(
      () => structure.setSectionPaddingPx({ type: 'text', content: {} }, 4),
      (e) => e.code === 'PADDING_BELOW_FLOOR'
    );
    n++;
    assert.equal(structure.layoutPaddingFloorPx(), 22, 'floor parsed from tokens.css (Batch 135 mobile inset)');
    n++;
    structure.setSectionPaddingPx(sec, null);
    assert.equal(structure.getSectionPaddingPx(sec), null, 'padding clears back to the site default');
    n++;

    // Background knob: writes the existing content field only.
    const bgSec = { type: 'text', content: {} };
    structure.setSectionBackground(bgSec, '#0e7a68');
    assert.equal(bgSec.content.backgroundColor, '#0e7a68');
    assert.equal(structure.getSectionBackground(bgSec), '#0e7a68');
    n += 2;
    assert.throws(
      () => structure.setSectionBackground(bgSec, 'url(evil)'),
      (e) => e.code === 'INVALID_COLOR'
    );
    n++;
    structure.setSectionBackground(bgSec, '');
    assert.ok(!('backgroundColor' in bgSec.content), 'background clears');
    n++;
    group('Part 2 — pure model ops', n);
  }

  /* ================================================================== */
  /* Setup — workspace, leads, modules, fixture sites                    */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const portal = require(path.join(root, 'server/clientPortal.js'));
  const structure = require(path.join(root, 'src/siteStructure.js'));
  const engine = require(path.join(root, 'src/websiteEngine.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a147@example.invalid',
    password: ['batch147', 'test', 'password'].join('-'),
    name: 'A147',
    workspaceName: 'Batch147 WS',
  });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B147 Plant Shop', 'aplants147@example.invalid'],
    [LEAD_B, 'B147 Freeform Co', 'bfree147@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
  }
  const bookings = sm.attachModule(db, LEAD_A, 'bookings', { workspaceId: WS_ID }).embed;
  const checkout = sm.attachModule(db, LEAD_A, 'checkout', { workspaceId: WS_ID }).embed;
  assert.ok(bookings.public_token && checkout.public_token, 'fixture embeds carry tokens');

  const theme = { primary: '#0e7a68', secondary: '#6d4ea3', bg: '#fffaf4', text: '#1c140f' };
  const pagesA = [
    {
      slug: '/',
      title: 'Home',
      sections: [
        { type: 'nav', content: { brand: 'B147 Plant Shop' } },
        { type: 'hero', id: 'hero-1', content: { headline: 'Plants!', subheadline: 'Green things.' } },
        { type: 'text', id: 'intro', content: { heading: 'Intro', body: 'Hello.' } },
        {
          type: 'site_module',
          content: { module_type: 'bookings', public_token: bookings.public_token, title: 'Book a visit' },
        },
        { type: 'footer', content: {} },
      ],
    },
  ];
  db.prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)').run(
    LEAD_A,
    'B147 Plant Shop',
    'draft',
    JSON.stringify(pagesA),
    JSON.stringify(theme)
  );
  db.prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)').run(
    LEAD_B,
    'B147 Freeform Co',
    'draft',
    JSON.stringify([{ slug: '/', title: 'Home', html: '<html><body><h1>Free</h1></body></html>' }]),
    JSON.stringify(theme)
  );

  /* ================================================================== */
  /* Part 3 — portal API: descriptors, palette, section building         */
  /* ================================================================== */
  {
    let n = 0;
    const ed = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    assert.equal(ed.freeform, false);
    assert.equal(ed.descriptors.length, 5);
    n += 2;
    const [nav, hero, text, mod, footer] = ed.descriptors;
    assert.deepEqual(
      [nav.canDelete, nav.canDuplicate, nav.movable, footer.canDelete, footer.movable],
      [false, false, false, false, false],
      'nav/footer are locked chrome'
    );
    n++;
    assert.deepEqual(
      [hero.movable, hero.canDuplicate, hero.canDelete],
      [false, true, true],
      'hero is pinned but editable'
    );
    n++;
    assert.deepEqual([text.movable, text.canDuplicate, text.canDelete], [true, true, true]);
    n++;
    assert.equal(mod.moduleType, 'bookings', 'site_module section resolves its module type');
    assert.equal(mod.canDuplicate, true, 'bookings mount may duplicate (shared singleton reference)');
    n += 2;
    assert.equal(ed.tokens[bookings.public_token], 'bookings', 'token map resolves mounts for the client');
    n++;
    assert.equal(ed.palette.content.length, 15, 'palette offers the renderer-backed content types');
    assert.ok(!ed.palette.modules.some((m) => m.type === 'chatbot'), 'sitewide chatbot is not a placeable section');
    assert.equal(ed.palette.modules.length, 27, 'palette = MODULE_TYPES minus the sitewide type');
    n += 3;
    assert.equal(ed.padding.floor, 22);
    n++;

    const edB = portal.getClientLayoutEditor(WS_ID, LEAD_B, '/');
    assert.equal(edB.freeform, true, 'freeform pages report freeform (editor fences itself off)');
    n++;

    // Building sections reuses the design path's structures.
    const faq = portal.buildClientLayoutSection(WS_ID, LEAD_A, { kind: 'content', type: 'faq' });
    assert.equal(faq.section.type, 'faq');
    assert.equal(faq.section.content.items[0].q, 'Question?', 'content sections come from defaultSectionContent');
    n += 2;
    const gal = portal.buildClientLayoutSection(WS_ID, LEAD_A, { kind: 'module', moduleType: 'gallery' });
    assert.equal(gal.section.type, 'html', 'module mounts are built by insertModuleSection (html wrapper)');
    assert.equal(gal.section.content.module_type, 'gallery');
    const galRow = db
      .prepare('SELECT * FROM site_module_embeds WHERE lead_id = ? AND module_type = ?')
      .get(LEAD_A, 'gallery');
    assert.equal(gal.section.content.public_token, galRow.public_token, 'mount carries the lead’s real embed token');
    n += 3;
    assert.throws(
      () => portal.buildClientLayoutSection(WS_ID, LEAD_A, { kind: 'module', moduleType: 'chatbot' }),
      (e) => e.code === 'INVALID',
      'sitewide module cannot be built as a section'
    );
    n++;
    assert.throws(
      () => portal.buildClientLayoutSection(WS_ID, LEAD_A, { kind: 'content', type: 'nav' }),
      (e) => e.code === 'INVALID',
      'chrome types are not in the ADD palette'
    );
    n++;
    group('Part 3 — portal API surface', n);
  }

  /* ================================================================== */
  /* Part 4 — save round-trip + design-path interleave                   */
  /* ================================================================== */
  let savedModel;
  {
    let n = 0;
    const ed = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    let work = JSON.parse(JSON.stringify(ed.sections));
    // Reorder: bookings mount to the first movable slot.
    work = structure.moveSectionToIndex(work, 3, 2).sections;
    assert.deepEqual(types(work), ['nav', 'hero', 'site_module', 'text', 'footer']);
    n++;
    // Duplicate the text section (fresh identity expected).
    const dup = structure.duplicateSectionAt(work, 3);
    work = dup.sections;
    // Add the gallery mount built in Part 3 + knobs on the text copy.
    const gal = portal.buildClientLayoutSection(WS_ID, LEAD_A, { kind: 'module', moduleType: 'gallery' });
    work.splice(2, 0, gal.section);
    const copyIdx = work.findIndex((s) => s.id === 'intro-copy');
    structure.setSectionBackground(work[copyIdx], '#f0b429');
    structure.setSectionPaddingPx(work[copyIdx], 64);

    const versionsBefore = db.prepare('SELECT COUNT(*) c FROM website_versions').get().c;
    const saved = portal.applyClientLayoutSave(WS_ID, LEAD_A, { slug: '/', sections: work });
    assert.ok(saved.version, 'save returns a version');
    const versionsAfter = db.prepare('SELECT COUNT(*) c FROM website_versions').get().c;
    assert.ok(
      versionsAfter > versionsBefore,
      'editor save writes version snapshots through the real update path (same count behaviour as the structure save)'
    );
    n += 2;

    const re = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    assert.deepEqual(types(re.sections), types(work), 're-read returns the edited section list');
    const ids = re.sections.map((s) => s.id).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, 'section ids unique after duplicate');
    const rt = re.sections.find((s) => s.id === 'intro-copy');
    assert.equal(rt.content.backgroundColor, '#f0b429', 'background knob round-trips');
    assert.equal(structure.getSectionPaddingPx(rt), 64, 'padding knob round-trips');
    n += 4;
    savedModel = JSON.parse(JSON.stringify(re.sections));

    // Design-path save interleaved: insert a CTA through the existing
    // structure API — it must see (and preserve) the editor's model.
    const ins = portal.applyClientStructureReorder(WS_ID, LEAD_A, {
      scope: 'sections',
      action: 'insertSection',
      pageIndex: 0,
      afterIndex: 1,
      sectionType: 'cta',
    });
    assert.ok(ins.version, 'structure save succeeds after editor save');
    const re2 = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    assert.ok(types(re2.sections).includes('cta'), 'editor re-read sees the design-path insert');
    const rt2 = re2.sections.find((s) => s.id === 'intro-copy');
    assert.ok(rt2 && rt2.content.backgroundColor === '#f0b429', 'editor changes survive the design-path save');
    assert.equal(structure.getSectionPaddingPx(rt2), 64);
    n += 4;

    // And back the other way: an editor save preserves the insert.
    const work2 = JSON.parse(JSON.stringify(re2.sections));
    const heroIdx = work2.findIndex((s) => s.type === 'hero');
    structure.setSectionBackground(work2[heroIdx], '#e5f6f2');
    portal.applyClientLayoutSave(WS_ID, LEAD_A, { slug: '/', sections: work2 });
    const re3 = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    assert.ok(types(re3.sections).includes('cta'), 'design-path insert survives the next editor save');
    assert.equal(re3.sections.find((s) => s.type === 'hero').content.backgroundColor, '#e5f6f2');
    savedModel = JSON.parse(JSON.stringify(re3.sections));
    n += 2;
    group('Part 4 — save round-trip + interleave', n);
  }

  /* ================================================================== */
  /* Part 5 — save rejections                                            */
  /* ================================================================== */
  {
    let n = 0;
    const fresh = () => JSON.parse(JSON.stringify(savedModel));
    const expectCode = (sections, code, slug = '/') => {
      assert.throws(
        () => portal.applyClientLayoutSave(WS_ID, LEAD_A, { slug, sections }),
        (e) => e.code === code,
        `save refuses with ${code}`
      );
      n++;
    };
    const foreign = fresh();
    foreign.push({ type: 'site_module', content: { module_type: 'blog', public_token: 'tok_foreign_147' } });
    // keep footer last for a clean token-only failure
    foreign.splice(foreign.length - 2, 0, foreign.pop());
    expectCode(foreign, 'INVALID_TOKEN');

    const twoCheckout = fresh();
    const coMount = {
      type: 'site_module',
      content: { module_type: 'checkout', public_token: checkout.public_token, title: 'Checkout' },
    };
    twoCheckout.splice(twoCheckout.length - 1, 0, coMount, JSON.parse(JSON.stringify(coMount)));
    expectCode(twoCheckout, 'FENCED_DUPLICATE');

    const navMoved = fresh();
    const navSec = navMoved.shift();
    navMoved.splice(1, 0, navSec);
    expectCode(navMoved, 'INVALID_STRUCTURE');

    const subFloor = fresh();
    subFloor[2] = Object.assign({}, subFloor[2], { style: 'padding-top:4px;padding-bottom:64px' });
    expectCode(subFloor, 'PADDING_BELOW_FLOOR');

    const badColor = fresh();
    badColor[2] = JSON.parse(JSON.stringify(badColor[2]));
    badColor[2].content = Object.assign({}, badColor[2].content, {
      backgroundColor: 'url(javascript:alert(1))',
    });
    expectCode(badColor, 'INVALID_COLOR');

    assert.throws(
      () => portal.applyClientLayoutSave(WS_ID, LEAD_B, { slug: '/', sections: [{ type: 'text', content: {} }] }),
      (e) => e.code === 'FREEFORM_PAGE',
      'freeform pages refuse layout saves'
    );
    n++;
    // A refused save changes nothing.
    const re = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    assert.deepEqual(types(re.sections), types(savedModel), 'refused saves leave the stored model untouched');
    n++;
    group('Part 5 — save rejections', n);
  }

  /* ================================================================== */
  /* Part 6 — singleton semantics                                        */
  /* ================================================================== */
  {
    let n = 0;
    const embedCount = () =>
      db
        .prepare('SELECT COUNT(*) c FROM site_module_embeds WHERE lead_id = ? AND module_type = ?')
        .get(LEAD_A, 'bookings').c;
    const embedFlags = () =>
      db
        .prepare('SELECT published, embed_enabled FROM site_module_embeds WHERE lead_id = ? AND module_type = ?')
        .get(LEAD_A, 'bookings');
    const settingsCount = () => {
      const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='booking_settings'").get();
      if (!t) return null;
      return db.prepare('SELECT COUNT(*) c FROM booking_settings WHERE lead_id = ?').get(LEAD_A).c;
    };
    assert.equal(embedCount(), 1, 'one bookings embed row (singleton)');
    const settingsBefore = settingsCount();
    n++;

    // Duplicate the bookings mount + save: singleton untouched.
    let model = JSON.parse(JSON.stringify(savedModel));
    const mountIdx = model.findIndex((s) => s.type === 'site_module');
    assert.ok(mountIdx > 0, 'fixture has a bookings mount');
    const dup = structure.duplicateSectionAt(model, mountIdx, 'bookings');
    assert.equal(dup.changed, true);
    model = dup.sections;
    portal.applyClientLayoutSave(WS_ID, LEAD_A, { slug: '/', sections: model });
    assert.equal(embedCount(), 1, 'duplicating a mount does NOT duplicate the embed row');
    assert.equal(settingsCount(), settingsBefore, 'duplicating a mount does NOT touch the settings row');
    const two = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/').sections.filter((s) => s.type === 'site_module');
    assert.equal(two.length, 2, 'two mounts on the page');
    assert.equal(
      two[0].content.public_token,
      two[1].content.public_token,
      'both mounts reference the same singleton embed'
    );
    n += 4;

    // Delete ONE mount: module stays live.
    model = JSON.parse(JSON.stringify(portal.getClientLayoutEditor(WS_ID, LEAD_A, '/').sections));
    model.splice(
      model.findIndex((s) => s.type === 'site_module'),
      1
    );
    const save1 = portal.applyClientLayoutSave(WS_ID, LEAD_A, { slug: '/', sections: model });
    assert.deepEqual(save1.unpublishedModules, [], 'no unpublish while a mount remains');
    assert.deepEqual(
      [Number(embedFlags().published), Number(embedFlags().embed_enabled)],
      [1, 1],
      'embed stays published with one mount left'
    );
    n += 2;

    // Delete the LAST mount: embed unpublishes, data survives, and the
    // mount does not resurrect through the save's module sync.
    model = JSON.parse(JSON.stringify(portal.getClientLayoutEditor(WS_ID, LEAD_A, '/').sections));
    model.splice(
      model.findIndex((s) => s.type === 'site_module'),
      1
    );
    const save2 = portal.applyClientLayoutSave(WS_ID, LEAD_A, { slug: '/', sections: model });
    assert.deepEqual(save2.unpublishedModules, ['bookings'], 'last-mount removal reports the unpublish');
    assert.deepEqual(
      [Number(embedFlags().published), Number(embedFlags().embed_enabled)],
      [0, 0],
      'embed unpublished with detach flags (data kept)'
    );
    assert.equal(settingsCount(), settingsBefore, 'module data rows survive the unpublish');
    const after = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    assert.ok(!after.sections.some((s) => s.type === 'site_module'), 'removed mount does not resurrect after sync');
    n += 4;
    group('Part 6 — singleton semantics', n);
  }

  /* ================================================================== */
  /* Part 7 — canvas render                                              */
  /* ================================================================== */
  {
    let n = 0;
    const pages = [
      {
        slug: '/',
        title: 'Home',
        sections: [
          { type: 'nav', content: { brand: 'Render Co' } },
          { type: 'text', content: { heading: 'CanvasHeading147', body: 'Body' } },
          { type: 'footer', content: {} },
        ],
      },
    ];
    const layoutHtml = engine.renderPageAt(pages, theme, { layoutEditor: true, preview: true, pageSlug: '/' });
    assert.equal(
      (layoutHtml.match(/data-bp-layout-section="1"/g) || []).length,
      3,
      'layout render stamps every section root'
    );
    assert.ok(layoutHtml.includes('bp-layout-bridge'), 'layout render inlines the bridge');
    n += 2;
    const plainHtml = engine.renderPageAt(pages, theme, { preview: true, pageSlug: '/' });
    assert.ok(!plainHtml.includes('data-bp-layout-section'), 'plain render carries no layout markers');
    assert.ok(!plainHtml.includes('bp-layout-bridge'), 'plain render carries no bridge');
    n += 2;

    // Unsaved model renders in the canvas; stored pages do not change.
    const stored = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    const unsaved = JSON.parse(JSON.stringify(stored.sections));
    unsaved.splice(unsaved.length - 1, 0, { type: 'heading', content: { heading: 'UnsavedHeading147', level: 2 } });
    const rendered = portal.renderClientSite(WS_ID, LEAD_A, {
      editable: false,
      layoutEditor: true,
      layoutSections: unsaved,
      pageSlug: '/',
    });
    assert.ok(rendered.html.includes('UnsavedHeading147'), 'canvas renders the unsaved model');
    assert.ok(rendered.html.includes('data-bp-layout-section'), 'canvas render is layout-decorated');
    const storedAfter = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    assert.ok(
      !JSON.stringify(storedAfter.sections).includes('UnsavedHeading147'),
      'canvas render never persists the unsaved model'
    );
    n += 3;
    group('Part 7 — canvas render', n);
  }

  console.log(`\nBatch 147 section-editor regressions: ALL GREEN — ${groups.length} groups`);
  for (const g of groups) console.log(`  - ${g}`);
})().catch((e) => {
  console.error('Batch 147 section-editor regressions FAILED:', e);
  process.exit(1);
});
