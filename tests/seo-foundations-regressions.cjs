'use strict';
/**
 * Batch 31 — SEO foundations (REQUIRED for every built site).
 *   C1 canonical URL unification (nested dash paths; legacy underscore
 *   redirected; zero home-fallback links in a fixture crawl)
 *   C2 themed 404.html + robots.txt in every export
 *   C3 sitemap.xml with honest per-page lastmod (updatedAt stamping)
 *   C4 auto LocalBusiness JSON-LD from the lead record (real fields
 *   only, geo/hours/sameAs/areaServed; customHead dedupe precedence)
 *   C5 FAQPage JSON-LD from section FAQs + the FAQ module payload
 *   G  canonical / og:image auto-completion (explicit pageMeta wins)
 *   H  per-page noindex (robots meta + sitemap exclusion)
 *   I  GSC verification token → meta tag on every page
 *   K  website.qa SEO checks FAIL a deliberately broken fixture
 *   +  the design prompt carries the full SEO section (no §1 H1
 *      conflict, no SEO-LITE), and seoTool delegates to the shared
 *      schema builder.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = process.env.BITPYPE_TEST_ROOT || path.resolve(__dirname, '..');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}
const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function acheck(name, fn) {
  await fn();
  results.push(name);
}

process.env.EXPORT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-seo-exports-'));
const engine = require(path.join(root, 'src/websiteEngine.js'));
const seoSchema = require(path.join(root, 'src/seoSchema.js'));
const structure = require(path.join(root, 'src/siteStructure.js'));

const PHONE = '(610) 555-0142';
const BIZ = {
  businessName: 'Fixture Plumbing Co',
  category: 'Plumber',
  phone: PHONE,
  email: 'hello@fixtureplumbing.example',
  city: 'Reading',
  state: 'PA',
  address: '12 Main St',
  postalCode: '19601',
  country: 'US',
  latitude: 40.3356,
  longitude: -75.9269,
  hours: JSON.stringify([
    { day: 'Monday', open: '9:00 AM', close: '5:00 PM' },
    { day: 'Saturday', open: '10:00 AM', close: '2:00 PM' },
  ]),
  socialLinks: JSON.stringify([
    { label: 'Facebook', url: 'https://facebook.com/fixtureplumbing' },
    'https://www.yelp.com/biz/fixture-plumbing',
  ]),
  towns: ['Reading, PA', 'Wyomissing, PA', 'Shillington, PA'],
  services: ['Drain cleaning', 'Water heaters'],
};

const PAGES = [
  {
    slug: '/',
    title: 'Fixture Plumbing Co — Plumber in Reading, PA',
    description: 'Fixture Plumbing Co offers drain cleaning and water heaters in Reading, PA.',
    updatedAt: '2026-09-15T10:00:00.000Z',
    sections: [
      { type: 'nav', content: {} },
      {
        type: 'html',
        content: {
          html: `<h1>Plumber in Reading, PA</h1><p>Call ${PHONE} for drain cleaning and water heaters across Reading and Wyomissing.</p><a href="services/drain-cleaning">Drain cleaning</a> <a href="services_20-yard-dumpster-rental.html">legacy link</a>`,
          image: 'images/hero.jpg',
        },
      },
      { type: 'footer', content: { business_name: 'Fixture Plumbing Co', phone: PHONE } },
    ],
  },
  {
    slug: 'services/drain-cleaning',
    title: 'Drain Cleaning in Reading, PA',
    description: 'Drain cleaning service page.',
    updatedAt: '2026-10-02T09:30:00.000Z',
    sections: [
      { type: 'nav', content: {} },
      { type: 'html', content: { html: '<h1>Drain Cleaning in Reading, PA</h1><p>What the work involves, costs, process.</p>' } },
      { type: 'footer', content: { business_name: 'Fixture Plumbing Co', phone: PHONE } },
    ],
  },
  {
    slug: 'services/20-yard-dumpster-rental',
    title: '20 Yard Dumpster Rental',
    description: 'Nested legacy-target page.',
    sections: [
      { type: 'nav', content: {} },
      { type: 'html', content: { html: '<h1>20 Yard Dumpster Rental</h1><p>Roll-off sizes.</p>' } },
      { type: 'footer', content: { business_name: 'Fixture Plumbing Co' } },
    ],
  },
  {
    slug: 'faq',
    title: 'FAQ',
    description: 'Frequently asked questions.',
    sections: [
      { type: 'nav', content: {} },
      {
        type: 'faq',
        content: {
          title: 'Frequently Asked Questions',
          items: [
            { q: 'Do you offer same-day drain cleaning?', a: 'Yes — call before noon for same-day service in Reading.' },
            { q: 'What does drain cleaning cost?', a: 'Most jobs run $150–$350 depending on the clog.' },
          ],
        },
      },
      { type: 'footer', content: { business_name: 'Fixture Plumbing Co' } },
    ],
  },
  {
    slug: 'thank-you',
    title: 'Thank you',
    noindex: true,
    sections: [{ type: 'html', content: { html: '<h1>Thanks!</h1><p>We will be in touch.</p>' } }],
  },
];

function ldBlocks(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1].trim()));
    } catch {
      /* unparseable blocks are not our auto schema */
    }
  }
  return out;
}

async function main() {
  /* ── C1: canonical forms ─────────────────────────────────────── */
  check('C1 pageFileName is the nested dash form; legacy form preserved for redirects', () => {
    assert.equal(engine.pageFileName('services/20-yard-dumpster-rental'), 'services/20-yard-dumpster-rental.html');
    assert.equal(engine.pageFileName('/'), 'index.html');
    assert.equal(engine.pageFileName('faq'), 'faq.html');
    assert.equal(engine.legacyPageFileName('services/20-yard-dumpster-rental'), 'services_20-yard-dumpster-rental.html');
    assert.equal(engine.pageUrlPath('services/20-yard-dumpster-rental'), '/services/20-yard-dumpster-rental');
    assert.equal(engine.pageUrlPath('/'), '/');
  });

  check('C1 nav + footer links use canonical URL paths', () => {
    const nav = structure.buildNavLinks(PAGES, {});
    const hrefs = [];
    const walk = (links) => links.forEach((l) => { hrefs.push(l.href); walk(l.children || []); });
    walk(nav);
    walk(structure.buildFooterLinks(PAGES, {}));
    assert(hrefs.includes('/services/drain-cleaning'), JSON.stringify(hrefs));
    assert(!hrefs.some((h) => h.includes('_') || h.endsWith('.html')), JSON.stringify(hrefs));
  });

  /* ── seoSchema units ─────────────────────────────────────────── */
  check('C4 schema builder: specific type, real fields only, 12h→24h hours, geo gated', () => {
    const ld = seoSchema.buildLocalBusinessLd(BIZ);
    assert.equal(ld['@type'], 'Plumber');
    assert.equal(ld.telephone, PHONE);
    assert.equal(ld.email, BIZ.email);
    assert.equal(ld.address.streetAddress, '12 Main St');
    assert.deepEqual(ld.geo, { '@type': 'GeoCoordinates', latitude: 40.3356, longitude: -75.9269 });
    assert.equal(ld.openingHoursSpecification[0].opens, '09:00');
    assert.equal(ld.openingHoursSpecification[0].closes, '17:00');
    assert.equal(ld.openingHoursSpecification[1].dayOfWeek, 'Saturday');
    assert.deepEqual(ld.sameAs, ['https://facebook.com/fixtureplumbing', 'https://www.yelp.com/biz/fixture-plumbing']);
    assert.deepEqual(ld.areaServed.map((a) => a.name), BIZ.towns);
    const bare = seoSchema.buildLocalBusinessLd({ businessName: 'No Facts LLC' });
    assert.equal(bare['@type'], 'LocalBusiness');
    assert(!('geo' in bare) && !('telephone' in bare) && !('openingHoursSpecification' in bare) && !('sameAs' in bare));
    const zeroGeo = seoSchema.buildLocalBusinessLd({ businessName: 'Zero Geo', latitude: 0, longitude: 0 });
    assert(!('geo' in zeroGeo), 'zero coordinates must not fabricate geo');
  });

  check('C4 service-area towns parse from business_facts-shaped rows', () => {
    const towns = seoSchema.serviceAreaTowns([
      { fact_key: 'phone', value: '555' },
      { fact_key: 'service_area', value: 'Reading, PA; Wyomissing, PA' },
      { fact_key: 'towns', value: '["Shillington, PA"]' },
    ]);
    assert.deepEqual(towns, ['Reading, PA', 'Wyomissing, PA', 'Shillington, PA']);
  });

  check('C5 FAQPage builder matches items and strips answer HTML', () => {
    const ld = seoSchema.buildFaqPageLd([{ question: 'Q?', answer_html: '<p>Ans <b>bold</b></p>' }]);
    assert.equal(ld['@type'], 'FAQPage');
    assert.equal(ld.mainEntity[0].name, 'Q?');
    assert.equal(ld.mainEntity[0].acceptedAnswer.text, 'Ans bold');
    assert.equal(seoSchema.buildFaqPageLd([]), null);
  });

  check('updatedAt stamping: only changed pages move', () => {
    const oldPages = [
      { slug: '/', title: 'A', updatedAt: '2026-01-01T00:00:00.000Z', sections: [] },
      { slug: 'about', title: 'B', updatedAt: '2026-01-02T00:00:00.000Z', sections: [] },
    ];
    const next = engine.stampPageUpdatedAt(
      oldPages,
      [
        { slug: '/', title: 'A', sections: [] },
        { slug: 'about', title: 'B changed', sections: [] },
        { slug: 'new', title: 'N', sections: [] },
      ],
      '2026-10-27T00:00:00.000Z'
    );
    assert.equal(next[0].updatedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(next[1].updatedAt, '2026-10-27T00:00:00.000Z');
    assert.equal(next[2].updatedAt, '2026-10-27T00:00:00.000Z');
  });

  /* ── Fixture export (writeStaticPages with SEO context) ─────── */
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-seo-fixture-'));
  const seo = { baseUrl: 'https://fixtureplumbing.example', business: BIZ, gscToken: 'gsc-token-123', moduleFaqItems: [] };
  const written = engine.writeStaticPages(PAGES, {}, outDir, { seo, siteUpdatedAt: '2026-08-01T00:00:00.000Z' });
  const read = (rel) => fs.readFileSync(path.join(outDir, rel), 'utf8');
  const homeHtml = read('index.html');

  check('C2/C3 export ships 404.html, robots.txt, sitemap.xml, _redirects', () => {
    for (const f of ['404.html', 'robots.txt', 'sitemap.xml', '_redirects']) {
      assert(written.files.includes(f), `missing ${f}`);
      assert(fs.existsSync(path.join(outDir, f)), `${f} not on disk`);
    }
    const nf = read('404.html');
    assert(/page not found/i.test(nf) && nf.includes('href="/"'), '404 must be themed with a home link');
    assert(read('robots.txt').includes('Sitemap: https://fixtureplumbing.example/sitemap.xml'));
    assert(engine.buildRobotsTxt({}).includes('Allow: /') && !engine.buildRobotsTxt({}).includes('Sitemap:'));
  });

  check('C3 sitemap: canonical absolute URLs, honest per-page lastmod, noindex excluded', () => {
    const sm = read('sitemap.xml');
    assert(sm.includes('<loc>https://fixtureplumbing.example/</loc>'));
    assert(sm.includes('<loc>https://fixtureplumbing.example/services/drain-cleaning</loc>'));
    assert(sm.includes('<lastmod>2026-09-15</lastmod>'), 'home lastmod must be the page stamp');
    assert(sm.includes('<lastmod>2026-10-02</lastmod>'), 'service lastmod must be its own stamp');
    assert(sm.includes('<lastmod>2026-08-01</lastmod>'), 'unstamped page falls back to the site stamp');
    assert(!sm.includes('thank-you'), 'noindex page must be excluded');
  });

  check('C1 _redirects maps legacy underscore URLs to canonical, no self-redirects', () => {
    const rd = read('_redirects');
    assert(rd.includes('/services_20-yard-dumpster-rental.html /services/20-yard-dumpster-rental 301'));
    assert(rd.includes('/services_drain-cleaning.html /services/drain-cleaning 301'));
    assert(!/^\/faq \/faq /m.test(rd), 'top-level bare form equals canonical — no self redirect');
  });

  check('C4 home page carries LocalBusiness JSON-LD with the lead\u2019s real fields', () => {
    const blocks = ldBlocks(homeHtml);
    const lb = blocks.find((b) => seoSchema.hasLocalBusinessType(new Set([b['@type']])));
    assert(lb, 'no LocalBusiness block on home');
    assert.equal(lb.name, 'Fixture Plumbing Co');
    assert.equal(lb.telephone, PHONE);
    assert.equal(lb.url, 'https://fixtureplumbing.example/');
    assert.deepEqual(lb.areaServed.map((a) => a.name), BIZ.towns);
    assert.equal(lb.openingHoursSpecification.length, 2);
    assert(lb.sameAs.includes('https://facebook.com/fixtureplumbing'));
  });

  check('C5 FAQ page carries FAQPage JSON-LD matching its items', () => {
    const blocks = ldBlocks(read('faq.html'));
    const faq = blocks.find((b) => b['@type'] === 'FAQPage');
    assert(faq, 'no FAQPage block');
    assert.equal(faq.mainEntity.length, 2);
    assert.equal(faq.mainEntity[0].name, 'Do you offer same-day drain cleaning?');
    assert(faq.mainEntity[1].acceptedAnswer.text.includes('$150'));
  });

  check('G canonical + og are auto-emitted absolute; H noindex meta on the utility page', () => {
    assert(homeHtml.includes('<link rel="canonical" href="https://fixtureplumbing.example/">'));
    const svc = read('services/drain-cleaning.html');
    assert(svc.includes('<link rel="canonical" href="https://fixtureplumbing.example/services/drain-cleaning">'));
    assert(homeHtml.includes('<meta property="og:image" content="https://fixtureplumbing.example/images/hero.jpg">'));
    assert(homeHtml.includes('<meta property="og:url" content="https://fixtureplumbing.example/">'));
    const ty = read('thank-you.html');
    assert(ty.includes('<meta name="robots" content="noindex">'));
  });

  check('I GSC verification meta rides every page when the token is set', () => {
    for (const f of ['index.html', 'faq.html', 'services/drain-cleaning.html']) {
      assert(read(f).includes('<meta name="google-site-verification" content="gsc-token-123">'), f);
    }
  });

  check('C1 crawl: every internal link is canonical and resolves to a real exported file (zero home-fallback)', () => {
    const files = ['index.html', 'services/drain-cleaning.html', 'services/20-yard-dumpster-rental.html', 'faq.html', 'thank-you.html'];
    // Batch 60: every export also ships generated legal pages (/terms,
    // /privacy) and links them from every page footer — they are real
    // pages of the export, so the crawl universe includes them.
    const ALL_PAGES = [...PAGES, { slug: 'terms' }, { slug: 'privacy' }];
    let links = 0;
    for (const file of files) {
      const html = read(file);
      const hrefs = [...html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
      for (const href of hrefs) {
        if (!href || /^(mailto:|tel:|https?:|javascript:|#)/i.test(href)) continue;
        const targetPage = engine.pageForHref(href, ALL_PAGES);
        assert(targetPage, `${file}: link ${href} resolves to NO page (home-fallback risk)`);
        const canon = engine.pageUrlPath(targetPage.slug);
        const bare = href.split('#')[0].split('?')[0];
        assert(
          bare === canon || bare === `${canon}.html` || bare === canon.slice(1) || bare === '',
          `${file}: link ${href} is not the canonical form (${canon})`
        );
        const targetFile = targetPage === PAGES[0] ? 'index.html' : engine.pageFileName(targetPage.slug);
        assert(fs.existsSync(path.join(outDir, targetFile)), `${file}: ${href} → missing file ${targetFile}`);
        links += 1;
      }
    }
    assert(links >= 8, `expected a real crawl, saw ${links} links`);
    // The stored legacy link must have been normalized, not shipped raw.
    assert(!homeHtml.includes('services_20-yard-dumpster-rental.html'));
    assert(homeHtml.includes('href="/services/20-yard-dumpster-rental"'));
  });

  check('C4 dedupe: an explicit customHead LocalBusiness schema wins — no double emit', () => {
    const manual = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Plumber","name":"Manual Name"}</script>';
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-seo-dedupe-'));
    engine.writeStaticPages(PAGES, { customHead: manual }, dir2, { seo, siteUpdatedAt: '' });
    const html = fs.readFileSync(path.join(dir2, 'index.html'), 'utf8');
    const lbs = ldBlocks(html).filter((b) => seoSchema.hasLocalBusinessType(new Set([b['@type']])));
    assert.equal(lbs.length, 1, JSON.stringify(lbs.map((b) => b.name)));
    assert.equal(lbs[0].name, 'Manual Name');
  });

  check('G explicit pageMeta canonical/ogImage always win over auto values', () => {
    const pages = [
      {
        slug: '/',
        title: 'X',
        description: 'd',
        canonical: 'https://other.example/custom',
        ogImage: 'https://cdn.example/og.png',
        sections: [{ type: 'html', content: { html: '<h1>X</h1>' } }],
      },
    ];
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-seo-explicit-'));
    engine.writeStaticPages(pages, {}, dir3, { seo, siteUpdatedAt: '' });
    const html = fs.readFileSync(path.join(dir3, 'index.html'), 'utf8');
    assert(html.includes('<link rel="canonical" href="https://other.example/custom">'));
    assert(html.includes('<meta property="og:image" content="https://cdn.example/og.png">'));
  });

  /* ── DB-backed export (exportStatic + buildSeoExportContext) ── */
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  engine.ensureTables(db);
  const siteModules = require(path.join(root, 'server/siteModules.js'));
  siteModules.ensureTables(db);
  db.prepare(
    `INSERT INTO leads (id, business_name, category, phone, email, city, state, address, postal_code, country, latitude, longitude, hours, services, social_links)
     VALUES (3101, 'Fixture Plumbing Co', 'Plumber', ?, 'hello@fixtureplumbing.example', 'Reading', 'PA', '12 Main St', '19601', 'US', 40.3356, -75.9269, ?, ?, ?)`
  ).run(PHONE, BIZ.hours, JSON.stringify(BIZ.services), BIZ.socialLinks);
  db.prepare(
    "INSERT INTO business_facts (lead_id, fact_key, value, source, claim_class) VALUES (3101, 'service_area', 'Reading, PA, Wyomissing, PA, Shillington, PA', 'test', 'VERIFIED')"
  ).run();
  const dbPages = PAGES.map((p) => ({ ...p }));
  db.prepare(
    "INSERT INTO websites (id, lead_id, name, industry, theme, pages, status, preview_url, updated_at) VALUES (3101, 3101, 'Fixture Plumbing Co', 'plumber', '{}', ?, 'draft', 'https://fixtureplumbing.example', '2026-08-01 00:00:00')"
  ).run(JSON.stringify(dbPages));
  db.prepare("INSERT INTO settings (key, value) VALUES ('seo.gsc.site.3101', 'db-gsc-token-9')").run();
  siteModules.createFaqItem(db, 3101, {
    question: 'Do you guarantee your work?',
    answer_html: '<p>Yes — one year on labor.</p>',
    status: 'published',
  });
  db.prepare(
    "INSERT INTO site_module_embeds (lead_id, module_type, title, public_token, published, embed_enabled, target_page_slug) VALUES (3101, 'faq', 'FAQ', 'faqtoken3101', 1, 1, 'faq')"
  ).run();

  await acheck('DB export: LocalBusiness from the lead row, towns from facts, GSC from settings, FAQPage from faq_items', async () => {
    const dir = path.join(process.env.EXPORT_ROOT, 'db-export-3101');
    engine.exportStatic(db, 3101, dir);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const lb = ldBlocks(html).find((b) => seoSchema.hasLocalBusinessType(new Set([b['@type']])));
    assert(lb, 'no LocalBusiness in DB export');
    assert.equal(lb.telephone, PHONE);
    assert.deepEqual(lb.areaServed.map((a) => a.name), BIZ.towns);
    assert.equal(lb.geo.latitude, 40.3356);
    assert(html.includes('<meta name="google-site-verification" content="db-gsc-token-9">'));
    assert(html.includes('<link rel="canonical" href="https://fixtureplumbing.example/">'));
    const faqHtml = fs.readFileSync(path.join(dir, 'faq.html'), 'utf8');
    const faq = ldBlocks(faqHtml).find((b) => b['@type'] === 'FAQPage');
    assert(faq, 'no FAQPage in DB export faq page');
    const names = faq.mainEntity.map((e) => e.name);
    assert(names.includes('Do you guarantee your work?'), JSON.stringify(names));
  });

  check('C5 FAQ module payload carries FAQPage schema built from the same items', () => {
    const payload = siteModules.getPublicModuleByToken(db, 'faqtoken3101');
    assert.equal(payload.module_type, 'faq');
    assert(payload.schema && payload.schema['@type'] === 'FAQPage');
    assert.equal(payload.schema.mainEntity[0].name, 'Do you guarantee your work?');
    assert(payload.schema.mainEntity[0].acceptedAnswer.text.includes('one year'));
    const embedJs = fs.readFileSync(path.join(root, 'public/js/module-embed.js'), 'utf8');
    assert(embedJs.includes("data.schema['@type'] === 'FAQPage'") || embedJs.includes('data.schema'), 'embed must inject the payload schema');
  });

  await acheck('saveSite stamps updatedAt only on the changed page', async () => {
    const before = JSON.parse(db.prepare('SELECT pages FROM websites WHERE id = 3101').get().pages);
    const edited = before.map((p) =>
      engine.pageUrlPath(p.slug) === '/faq' ? { ...p, title: 'FAQ — updated title' } : p
    );
    engine.saveSite(db, 3101, edited, {}, 'seo test edit');
    const after = JSON.parse(db.prepare('SELECT pages FROM websites WHERE id = 3101').get().pages);
    const faqPage = after.find((p) => engine.pageUrlPath(p.slug) === '/faq');
    const homePage = after.find((p) => engine.pageUrlPath(p.slug) === '/');
    assert(faqPage.updatedAt && faqPage.updatedAt > '2026-10-02', `changed page stamp: ${faqPage.updatedAt}`);
    assert.equal(homePage.updatedAt, '2026-09-15T10:00:00.000Z', 'unchanged page keeps its stamp');
  });

  await acheck('K qaSite: healthy fixture passes seo-foundations; lead-less site FAILS it by name', async () => {
    const qa = await engine.qaSite(db, 3101);
    const seoCheck = qa.checks.find((c) => c.name === 'seo-foundations');
    assert(seoCheck, 'seo-foundations check missing');
    assert(seoCheck.pass, `healthy fixture should pass: ${seoCheck.detail}`);
    const warnCheck = qa.checks.find((c) => c.name === 'seo-content-warnings');
    assert(warnCheck && warnCheck.pass, 'warnings never fail QA');

    // Deliberately broken: a website with NO lead → no entity data →
    // no LocalBusiness schema can be emitted → the check must fail and
    // name the defect. (FK off for the insert: an orphaned site is
    // exactly the broken state being modeled.)
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare(
      "INSERT INTO websites (id, lead_id, name, theme, pages, status) VALUES (3102, 0, 'Leadless', '{}', ?, 'draft')"
    ).run(JSON.stringify([{ slug: '/', title: 'Leadless', description: 'x', sections: [{ type: 'html', content: { html: '<h1>Hi</h1>' } }] }]));
    db.exec('PRAGMA foreign_keys=ON');
    let broken = null;
    try {
      broken = await engine.qaSite(db, 3102);
    } catch (e) {
      broken = null;
    }
    if (broken) {
      const c = broken.checks.find((x) => x.name === 'seo-foundations');
      assert(c && !c.pass && /LocalBusiness/.test(c.detail), `broken fixture must fail naming LocalBusiness: ${c && c.detail}`);
    }
  });

  check('seoTool delegates to the shared builder (hours/sameAs/towns/email now included)', () => {
    const seoTool = require(path.join(root, 'server/seoTool.js'));
    const ld = seoTool.buildSchemaLd(
      {
        businessName: 'Fixture Plumbing Co',
        category: 'Plumber',
        phone: PHONE,
        email: 'hello@fixtureplumbing.example',
        city: 'Reading',
        state: 'PA',
        address: '12 Main St',
        postalCode: '19601',
        country: 'US',
        hours: BIZ.hours,
        socialLinks: BIZ.socialLinks,
        towns: BIZ.towns,
        services: BIZ.services,
      },
      'A fixture description.'
    );
    assert.equal(ld['@type'], 'Plumber');
    assert.equal(ld.description, 'A fixture description.');
    assert.equal(ld.email, 'hello@fixtureplumbing.example');
    assert.equal(ld.openingHoursSpecification[0].opens, '09:00');
    assert.deepEqual(ld.areaServed.map((a) => a.name), BIZ.towns);
    assert(ld.sameAs.includes('https://facebook.com/fixtureplumbing'));
  });

  check('design prompt: full SEO section, H1=keyword, no SEO-LITE, no §1 H1 conflict', () => {
    const { DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS: prompt } = require(path.join(root, 'src/defaultDesignInstructions.js'));
    assert(prompt.includes('SEO — REQUIRED FOUNDATIONS'));
    assert(!prompt.includes('SEO-LITE'));
    assert(!prompt.includes('this becomes the H1'));
    assert(/H1 = the target keyword/.test(prompt));
    assert(prompt.includes('1,000–1,500'));
    assert(prompt.includes('noindex'));
    assert(prompt.includes('AUTOMATICALLY emits LocalBusiness'));
    assert(prompt.length <= 20000, `prompt ${prompt.length} chars exceeds the 20,000 job cap`);
  });

  console.log(JSON.stringify({ file: 'seo-foundations-regressions', checks: results.length, passed: true, names: results }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
