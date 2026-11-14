'use strict';
/**
 * Batch 188 — SECTION VARIANTS FOUNDATION (spec Batch A; Ely's pick
 * 2026-11-14: build the section-variant waves + anti-repeat rule).
 *
 * What 188 ships:
 *   - `section.variant` — a registry id stored ONLY when non-default
 *     (Batch 148 stored-only-when-set discipline). Absent = "standard"
 *     = today's renderer code path.
 *   - src/sectionVariants.js — THE registry: one manifest beside the
 *     renderer, agent metadata (description/bestFor/avoidWhen/
 *     contentBudget/supportsTone) required on every entry, read by
 *     the picker, the design agent (design.variants MCP tool), MCP
 *     validation and QA alike (spec §4).
 *   - Renderer dispatch in sectionToHtml + data-variant stamped on
 *     the section root ONLY when a valid non-standard variant is set.
 *   - §5 shared text primitives (.bp-topper/.bp-title/.bp-text/
 *     .bp-btn-solid) defined once in the variant CSS block appended
 *     by siteCss — the ONLY byte delta anywhere in 188: every rule is
 *     scoped to [data-variant] sections or new primitive classes, so
 *     a variant-free render is byte-identical once that block is
 *     stripped (Part 4 proves it against pins captured from the
 *     pristine Batch 187 engine).
 *   - Validation everywhere a section list is written: design.deliver
 *     (domain validatePages + designJobs validateWebsitePayload),
 *     website save (ipc mirror), portal layout save — an unknown id
 *     is rejected with the valid ids named; chrome carries none (D5).
 *   - QA check `section-variants-valid` reports unknown ids (spec §3:
 *     rendered as standard, REPORTED, never silently kept).
 *   - Picker shell in portal Layout mode: a Design select fed by the
 *     registry (getClientLayoutEditor ships registrySummary), canvas
 *     re-renders with the site's real content on change.
 *   - Fingerprint: the §4a layout half now reads (type → variant) —
 *     a section with a set variant contributes "type@variant";
 *     variant-free sites keep their exact pre-188 hashes (Part 6).
 *
 * 188 registers ONLY "standard" — no new compositions (that is the
 * Batch 189 wave). Every non-standard set in this suite is therefore
 * either a validation refusal or a render-time fallback.
 *
 *   Part 1 — source pins (registry, dispatch, MCP, picker, saves).
 *   Part 2 — registry parity: registry types == renderer types;
 *     metadata complete on every entry; one standard per type.
 *   Part 3 — pure model ops: set/unset round-trips, unknown ids
 *     refused naming the valid ids, chrome refused, save-validation
 *     matrix, descriptor availability.
 *   Part 4 — BYTE-IDENTICAL DEFAULT: golden pins captured from the
 *     pristine 187 engine; 188 renders match exactly per-section and
 *     match full-page after stripping exactly the variant CSS block.
 *   Part 5 — render-time tolerance: an unknown id (hand-edited data)
 *     renders the standard bytes and stamps no data-variant.
 *   Part 6 — fingerprint: variant-free hash == the 187 pin; a set
 *     variant moves the layout hash (and only the layout hash).
 *   Part 7 — real write paths (fixture workspace): layout editor
 *     descriptors + registry in the editor payload; layout save
 *     refuses a bogus variant and changes nothing; a clean save
 *     round-trips; deliverJob refuses unknown/chrome variants and
 *     delivers a clean payload.
 *   Part 8 — QA: section-variants-valid passes a clean site and
 *     fails a site carrying a bogus variant, naming it.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b188-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch188', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 31).toString('base64');

/* Fixture: the same pages the golden pins were captured with, from
 * the pristine Batch 187 engine (e4cd349). */
const THEME = {
  primary: '#b3123f',
  secondary: '#1d1a16',
  bg: '#fffaf4',
  text: '#241d18',
  font: 'Nunito Sans',
  headingFont: 'Playfair Display',
  baseCss: true,
};
function fixturePages() {
  return [
    {
      slug: '/',
      title: 'Home',
      sections: [
        {
          type: 'nav',
          content: {
            brand: 'Fixture Bakery',
            links: [
              { label: 'Home', href: '#home' },
              { label: 'Cakes', href: '#cakes' },
            ],
          },
        },
        {
          type: 'hero',
          id: 'hero-1',
          content: {
            headline: 'Cakes that steal the room',
            subheadline: 'Custom cakes designed around your celebration, baked to order in small batches.',
            cta_text: 'Start an order',
            cta_href: '#contact',
            cta_secondary_text: 'See the gallery',
            cta_secondary_href: '#gallery',
            rating: '4.9',
            review_count: 132,
            backgroundImage: 'images/hero-cake.jpg',
          },
        },
        {
          type: 'text_image',
          id: 'svc-1',
          content: {
            heading: 'Wedding cakes, tiered and tailored',
            body: 'Every tier is sketched with you first: flavours, colours, and the moment it has to land. Tastings run by appointment, and delivery is white-glove on the day.',
            image: { url: 'images/wedding.jpg', caption: 'Three-tier wedding cake' },
            image_position: 'right',
            button: { text: 'Plan yours', href: '#contact' },
          },
        },
        {
          type: 'reviews',
          id: 'rev-1',
          content: {
            title: 'What customers say',
            subtitle: 'Recent words from recent parties.',
            reviews: [
              { stars: 5, text: 'The cake was the most photographed thing at the wedding after the bride.', name: 'Amara O.' },
              { stars: 5, text: 'Ordered on a Tuesday panic for Saturday. It arrived perfect and tasted even better.', name: 'Devon R.' },
              { stars: 4, text: 'Our twins fought over the last slice. Ordering two next year.', name: 'Priya S.' },
              { stars: 5, text: 'She recreated my grandmother’s recipe card as sugar calligraphy. I cried.', name: 'Marta L.' },
            ],
          },
        },
        {
          type: 'gallery',
          id: 'gal-1',
          content: {
            title: 'Recent work',
            subtitle: 'A few favourites from the bench.',
            images: [
              { url: 'images/g1.jpg', caption: 'Strawberry gold' },
              { url: 'images/g2.jpg', caption: 'The big nine' },
              { url: 'images/g3.jpg', caption: 'Ninja flames' },
              { url: 'images/g4.jpg', caption: 'Game day green' },
              { url: 'images/g5.jpg', caption: 'Cookie cake' },
              { url: 'images/g6.jpg', caption: 'Go-kart twelve' },
            ],
          },
        },
        {
          type: 'faq',
          id: 'faq-1',
          content: {
            title: 'Ordering questions',
            items: [
              { q: 'How much notice do you need?', a: 'Two weeks is comfortable; rush orders are sometimes possible — ask.' },
              { q: 'Is a deposit required?', a: 'Yes — a deposit books your date and is non-refundable.' },
              { q: 'Do you deliver?', a: 'Delivery is available locally for tiered cakes.' },
              { q: 'Can you match a photo?', a: 'Send it — designs are recreated in our own style, never copied.' },
            ],
          },
        },
        {
          type: 'cta',
          id: 'cta-1',
          content: { title: 'Ready when the party is', text: 'Dates book out fast in June.', button_text: 'Start an order', button_href: '#contact' },
        },
        {
          type: 'footer',
          content: { business_name: 'Fixture Bakery', tagline: 'Custom cakes, designed loudly.', phone: '215-555-0100', email: 'hello@fixture.example' },
        },
      ],
    },
    {
      slug: '/about',
      title: 'About',
      sections: [
        { type: 'nav', content: { brand: 'Fixture Bakery' } },
        { type: 'heading', content: { heading: 'About the bakery', level: 2 } },
        { type: 'text', content: { heading: 'Small bench, big cakes', body: 'One oven, one designer, no shortcuts.' } },
        { type: 'footer', content: { business_name: 'Fixture Bakery' } },
      ],
    },
  ];
}

/* Golden pins — captured from the PRISTINE Batch 187 engine. */
const GOLDEN = {
  renderSite: '3a347e3242ad36f5d20397957edaa4670953ea04b2358e9e78a2306796735025',
  renderPageHome: '34dae7e82580234471776b9720b671954ad0bcf959e641c6cd716116f2544acb',
  renderPageAbout: '8b2d884a68941f3517043eee7788d18124e3dc9a83c31433bd56ea44d9be1819',
  sections: {
    nav: 'd23b26a2d11edaf2e9a331f180dfaa716b77d23567e083840486bddba80a207d',
    hero: 'bff1f2c1567a16783d5cbc09456779bb57491bd532a27799b2c6e68070d636e1',
    text_image: '09f819fe81a27d0efb2db2b4c58da0e0bbcca09644dfda750e985be4dbaa4d3e',
    reviews: '09959a89adc56dd8415d9bc6dc6eb53abf35a6e1469f27a3b5a942ac5ffc6ad5',
    gallery: 'a7f146d20bc59fd5ff90af994fda989e77f38b28de28ac33e7153f5cc39d9469',
    faq: '7f60e22af2531ece2a57618bcb40378f74bed3449996e2fdc8fd8cb30f7c8ee9',
    cta: '5fb94f34d6929b7d0e3a9f545c321a5729c921199dec23ae9cec3470fa50b7d2',
    footer: '76fb8518b11fab2821d04a66d12a6c47609f1ab196fcd89b42d6ec8e7811e433',
  },
  fingerprintHash: '3351a6b134ae8da5',
  fingerprintLayoutHash: 'b1f528f1455c',
};

let groups = 0;
function group(name, n) {
  groups += 1;
  console.log(`ok ${groups} - ${name} (${n} checks)`);
}

(async () => {
  const variants = require(path.join(root, 'src/sectionVariants.js'));
  const structure = require(path.join(root, 'src/siteStructure.js'));
  const engine = require(path.join(root, 'src/websiteEngine.js'));

  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const eng = read('src/websiteEngine.js');
    assert.ok(eng.includes('VARIANT_RENDERERS'), 'engine carries the variant dispatch map');
    assert.ok(eng.includes('data-variant'), 'engine stamps data-variant');
    assert.ok(eng.includes("'section-variants-valid'"), 'QA check ships');
    assert.ok(eng.includes('sectionVariants.variantCss()'), 'siteCss appends the variant block');
    n += 4;
    const mcp = read('server/mcp.js');
    assert.ok(mcp.includes("name: 'design.variants'"), 'design.variants tool def ships');
    assert.ok(mcp.includes("case 'design.variants'"), 'design.variants handler ships');
    n += 2;
    const portal = read('public/js/portal.js');
    assert.ok(portal.includes('layoutVariantKnob'), 'picker control ships in Layout mode');
    assert.ok(portal.includes('layoutSetVariant'), 'picker setter ships');
    n += 2;
    const psc = read('server/portalSiteChat.js');
    assert.ok(psc.includes('validateSectionVariants'), 'layout save re-checks variants');
    assert.ok(psc.includes('registrySummary'), 'layout editor payload ships the registry');
    n += 2;
    const dom = read('server/domain.js');
    assert.ok(dom.includes('UNKNOWN_VARIANT'), 'deliver validation names UNKNOWN_VARIANT');
    const dj = read('src/designJobs.js');
    assert.ok(dj.includes('validateSectionVariants'), 'deliverJob validates variants');
    const fp = read('server/siteFingerprint.js');
    assert.ok(fp.includes('@${v}'), 'fingerprint layout tokens carry the variant when set');
    n += 3;
    group('Part 1 — source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — registry parity + metadata                                 */
  /* ================================================================== */
  {
    let n = 0;
    const rendererTypes = Object.keys(engine.RENDERERS).sort();
    const registryTypes = [...new Set(variants.REGISTRY.map((e) => e.type))].sort();
    assert.deepEqual(registryTypes, rendererTypes, 'registry types == renderer types (parity)');
    n++;
    for (const type of rendererTypes) {
      const entries = variants.entriesFor(type);
      assert.equal(entries.filter((e) => e.id === 'standard').length, 1, `${type}: exactly one standard`);
      assert.equal(new Set(entries.map((e) => e.id)).size, entries.length, `${type}: ids unique`);
      for (const e of entries) {
        for (const field of ['label', 'description', 'bestFor', 'avoidWhen']) {
          assert.ok(typeof e[field] === 'string' && e[field].trim().length > 10, `${type}/${e.id}: ${field} present`);
        }
        assert.ok(e.contentBudget && typeof e.contentBudget === 'object', `${type}/${e.id}: contentBudget object`);
        assert.ok(Array.isArray(e.supportsTone) && e.supportsTone.includes('light'), `${type}/${e.id}: supportsTone`);
      }
      n += 2;
    }
    const summary = variants.registrySummary();
    assert.equal(summary.standard, 'standard');
    assert.deepEqual(Object.keys(summary.types).sort(), rendererTypes, 'summary covers every type');
    n += 2;
    group('Part 2 — registry parity + metadata', n);
  }

  /* ================================================================== */
  /* Part 3 — pure model ops                                             */
  /* ================================================================== */
  {
    let n = 0;
    const sec = () => ({ type: 'hero', content: { headline: 'Hi' } });
    assert.equal(structure.getSectionVariant(sec()), 'standard', 'absent reads as standard');
    const s1 = sec();
    structure.setSectionVariant(s1, 'standard');
    assert.ok(!('variant' in s1), 'setting standard stores nothing');
    structure.setSectionVariant(s1, null);
    assert.ok(!('variant' in s1), 'setting null stores nothing');
    n += 3;
    // An unregistered id is refused, with the valid ids named
    // (spec §3 error contract). (188 registered none; Batch 189 made
    // 'split' a real hero variant, so the refused id here is a
    // genuinely unknown one.)
    assert.throws(
      () => structure.setSectionVariant(sec(), 'bogus-id'),
      (e) => e.code === 'UNKNOWN_VARIANT' && /Valid variants: standard/.test(e.message)
    );
    n++;
    for (const type of ['nav', 'footer']) {
      assert.throws(
        () => structure.setSectionVariant({ type, content: {} }, 'split'),
        (e) => e.code === 'CHROME_VARIANT'
      );
      n++;
    }
    // Save-validation matrix.
    const codes = (list) => structure.validateSectionVariants(list).map((p) => p.code);
    assert.deepEqual(structure.validateSectionVariants([sec()]), [], 'absent validates clean');
    assert.ok(codes([Object.assign(sec(), { variant: 'bogus' })]).includes('UNKNOWN_VARIANT'));
    assert.ok(codes([Object.assign(sec(), { variant: 'standard' })]).includes('UNKNOWN_VARIANT'), 'stored standard refused');
    assert.ok(codes([Object.assign(sec(), { variant: 7 })]).includes('UNKNOWN_VARIANT'), 'non-string refused');
    assert.ok(codes([{ type: 'nav', content: {}, variant: 'split' }]).includes('CHROME_VARIANT'));
    n += 5;
    // Descriptor availability + state.
    const dNav = structure.describeEditorSection({ type: 'nav', content: {} }, 0, () => null);
    assert.equal(dNav.canVariant, false, 'chrome gets no variant control');
    const dHero = structure.describeEditorSection(sec(), 1, () => null);
    assert.equal(dHero.canVariant, true);
    assert.equal(dHero.variant, 'standard');
    assert.ok(dHero.variantOptions.some((o) => o.id === 'standard' && o.description), 'descriptor carries options + metadata');
    n += 4;
    group('Part 3 — pure model ops', n);
  }

  /* ================================================================== */
  /* Part 4 — byte-identical default (golden pins from the 187 engine)   */
  /* ================================================================== */
  {
    let n = 0;
    const pages = fixturePages();
    for (const s of pages[0].sections) {
      assert.equal(sha256(engine.sectionToHtml(s, THEME)), GOLDEN.sections[s.type], `section ${s.type} byte-identical`);
      n++;
    }
    const strip = (html) => String(html).split('\n' + variants.variantCss()).join('');
    const site = engine.renderSite(pages, THEME, { preview: true });
    assert.ok(site.includes(variants.variantCss()), 'variant CSS block is present in the render');
    assert.equal(sha256(strip(site)), GOLDEN.renderSite, 'renderSite identical outside the variant block');
    assert.equal(sha256(strip(engine.renderPage(pages[0], pages, THEME))), GOLDEN.renderPageHome, 'home identical outside the block');
    assert.equal(sha256(strip(engine.renderPage(pages[1], pages, THEME))), GOLDEN.renderPageAbout, 'about identical outside the block');
    assert.ok(!strip(site).includes(' data-variant="'), 'no element stamped anywhere on a variant-free site (style block excluded)');
    n += 5;
    // Set-then-unset returns to the golden bytes.
    const hero = pages[0].sections[1];
    structure.setSectionVariant(hero, 'standard');
    assert.equal(sha256(engine.sectionToHtml(hero, THEME)), GOLDEN.sections.hero, 'set-then-unset is the golden render');
    n++;
    group('Part 4 — byte-identical default', n);
  }

  /* ================================================================== */
  /* Part 5 — render-time tolerance for hand-edited unknown ids          */
  /* ================================================================== */
  {
    let n = 0;
    const pages = fixturePages();
    const hero = pages[0].sections[1];
    const bogus = JSON.parse(JSON.stringify(hero));
    bogus.variant = 'bogus-id';
    const html = engine.sectionToHtml(bogus, THEME);
    assert.equal(sha256(html), GOLDEN.sections.hero, 'unknown id renders the standard bytes');
    assert.ok(!html.includes('data-variant'), 'unknown id stamps no data-variant');
    const stored = JSON.parse(JSON.stringify(hero));
    stored.variant = 'standard';
    assert.equal(sha256(engine.sectionToHtml(stored, THEME)), GOLDEN.sections.hero, 'stored "standard" renders standard');
    n += 3;
    group('Part 5 — render-time tolerance', n);
  }

  /* ================================================================== */
  /* Part 6 — fingerprint: (type → variant) layout tokens                */
  /* ================================================================== */
  {
    let n = 0;
    const fp = require(path.join(root, 'server/siteFingerprint.js'));
    const base = fp.computeFingerprint({ name: 'Fixture Bakery', pages: fixturePages(), theme: THEME });
    assert.equal(base.hash, GOLDEN.fingerprintHash, 'variant-free fingerprint hash == the 187 pin');
    assert.equal(base.layoutHash, GOLDEN.fingerprintLayoutHash, 'variant-free layout hash == the 187 pin');
    n += 2;
    const p2 = fixturePages();
    p2[0].sections[1].variant = 'split';
    const moved = fp.computeFingerprint({ name: 'Fixture Bakery', pages: p2, theme: THEME });
    assert.notEqual(moved.layoutHash, base.layoutHash, 'a set variant moves the layout hash');
    assert.ok(moved.layout.homeSections.includes('hero@split'), 'home sequence carries hero@split');
    assert.equal(moved.brandHash, base.brandHash, 'brand half untouched by a variant');
    n += 3;
    group('Part 6 — fingerprint layout tokens', n);
  }

  /* ================================================================== */
  /* Setup for Parts 7–8 — fixture workspace + site                      */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const portal = require(path.join(root, 'server/clientPortal.js'));
  const designJobs = require(path.join(root, 'src/designJobs.js'));
  const a = await workspace.createUserWithWorkspace({
    email: 'a188@example.invalid',
    password: ['batch188', 'pass'].join('-'),
    name: 'A188',
    workspaceName: 'Batch188 WS',
  });
  const WS_ID = Number(a.workspaceId);
  const LEAD_A = 188001;
  const db = openWorkspaceDb(WS_ID);
  designJobs.ensureTables(db);
  db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
    LEAD_A,
    'B188 Fixture Bakery',
    'b188@example.invalid',
    'customer'
  );
  const pages188 = [
    {
      slug: '/',
      title: 'Home',
      sections: [
        { type: 'nav', content: { brand: 'B188 Fixture Bakery' } },
        { type: 'hero', id: 'hero-1', content: { headline: 'Cakes!', subheadline: 'Baked to order.' } },
        { type: 'text', id: 'intro', content: { heading: 'Intro', body: 'Hello.' } },
        { type: 'footer', content: {} },
      ],
    },
  ];
  const theme188 = { primary: '#b3123f', secondary: '#1d1a16', bg: '#fffaf4', text: '#241d18' };
  const siteInfo = db
    .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
    .run(LEAD_A, 'B188 Fixture Bakery', 'draft', JSON.stringify(pages188), JSON.stringify(theme188));
  const SITE_A = Number(siteInfo.lastInsertRowid);

  /* ================================================================== */
  /* Part 7 — real write paths                                           */
  /* ================================================================== */
  {
    let n = 0;
    // Editor payload: descriptors + registry ride along.
    const ed = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    const dHero = ed.descriptors.find((d) => d.type === 'hero');
    assert.ok(dHero && dHero.canVariant === true && dHero.variant === 'standard', 'descriptor reports the variant state');
    assert.ok(dHero.variantOptions.some((o) => o.id === 'standard'), 'descriptor carries registry options');
    assert.ok(ed.variants && ed.variants.types && ed.variants.types.hero, 'editor payload ships the registry');
    const dNav = ed.descriptors.find((d) => d.type === 'nav');
    assert.equal(dNav.canVariant, false, 'editor fences chrome variants');
    n += 4;
    // Layout save refuses a bogus variant and changes nothing.
    const before = db.prepare('SELECT pages FROM websites WHERE id = ?').get(SITE_A).pages;
    const bogusSections = JSON.parse(JSON.stringify(pages188[0].sections));
    bogusSections[1].variant = 'bogus-id';
    assert.throws(
      () => portal.applyClientLayoutSave(WS_ID, LEAD_A, { slug: '/', sections: bogusSections }),
      (e) => e.code === 'UNKNOWN_VARIANT'
    );
    assert.equal(db.prepare('SELECT pages FROM websites WHERE id = ?').get(SITE_A).pages, before, 'refused save changed nothing');
    n += 2;
    // Clean layout save round-trips.
    const saved = portal.applyClientLayoutSave(WS_ID, LEAD_A, { slug: '/', sections: pages188[0].sections });
    assert.ok(saved && saved.siteId === SITE_A, 'clean layout save succeeds');
    n++;
    // deliverJob: unknown variant refused with the valid ids named.
    const jobClean = designJobs.createJob(db, {
      leadId: LEAD_A,
      type: 'website',
      title: 'B188 clean delivery',
      instructions: 'Deliver the fixture site.',
    });
    const payload = (heroExtra) => ({
      name: 'B188 Fixture Bakery',
      theme: theme188,
      pages: [
        {
          slug: '/',
          title: 'Home',
          sections: [
            { type: 'nav', content: { brand: 'B188 Fixture Bakery' } },
            Object.assign({ type: 'hero', content: { headline: 'Cakes!', subheadline: 'Baked to order.' } }, heroExtra || {}),
            { type: 'cta', content: { title: 'Order', button_text: 'Start', button_href: '#contact' } },
            { type: 'footer', content: { business_name: 'B188 Fixture Bakery' } },
          ],
        },
      ],
    });
    const jobBogus = designJobs.createJob(db, {
      leadId: LEAD_A,
      type: 'website',
      title: 'B188 bogus variant delivery',
      instructions: 'Deliver with a bogus variant.',
    });
    await assert.rejects(
      () => designJobs.deliverJob(db, Number(jobBogus.id), payload({ variant: 'bogus-id' }), null, {}),
      (e) => e.code === 'UNKNOWN_VARIANT' && /Valid variants/.test(e.message),
      'deliverJob refuses an unknown variant, naming the valid ids'
    );
    n++;
    const jobChrome = designJobs.createJob(db, {
      leadId: LEAD_A,
      type: 'website',
      title: 'B188 chrome variant delivery',
      instructions: 'Deliver with a variant on the nav.',
    });
    const chromePayload = payload();
    chromePayload.pages[0].sections[0].variant = 'split';
    await assert.rejects(
      () => designJobs.deliverJob(db, Number(jobChrome.id), chromePayload, null, {}),
      (e) => e.code === 'CHROME_VARIANT',
      'deliverJob refuses a variant on chrome'
    );
    n++;
    const delivered = await designJobs.deliverJob(db, Number(jobClean.id), payload(), null, {});
    assert.ok(delivered && delivered.website_id, 'clean payload delivers and materializes a website');
    n++;
    group('Part 7 — real write paths', n);
  }

  /* ================================================================== */
  /* Part 8 — QA: section-variants-valid                                 */
  /* ================================================================== */
  {
    let n = 0;
    const clean = await engine.qaSite(db, SITE_A);
    const cClean = (clean.checks || []).find((c) => c.name === 'section-variants-valid');
    assert.ok(cClean, 'QA carries the variant check');
    assert.equal(cClean.pass, true, cClean.detail);
    n += 2;
    const badPages = JSON.parse(JSON.stringify(pages188));
    badPages[0].sections[1].variant = 'bogus-id';
    db.prepare('UPDATE websites SET pages = ? WHERE id = ?').run(JSON.stringify(badPages), SITE_A);
    const bad = await engine.qaSite(db, SITE_A);
    const cBad = (bad.checks || []).find((c) => c.name === 'section-variants-valid');
    assert.ok(cBad, 'QA carries the variant check on the bad site');
    assert.equal(cBad.pass, false, 'QA fails a bogus variant');
    assert.ok(/bogus-id/.test(cBad.detail), 'QA names the offending id');
    n += 3;
    group('Part 8 — QA variant check', n);
  }

  console.log(`\nbatch188: all ${groups} groups passed`);
})().catch((e) => {
  console.error('batch188 FAILED:', e && e.message ? e.message : e);
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
