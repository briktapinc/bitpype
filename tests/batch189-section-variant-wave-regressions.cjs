'use strict';
/**
 * Batch 189 — SECTION VARIANTS, FIRST WAVE (spec Batch B; Ely's
 * widening order 2026-11-14: mine the Assistant theme library AND
 * online component-layout research — every registry entry records
 * its `source`).
 *
 * 21 new variants across the six wave types:
 *   hero       split (themes), editorial (themes), showcase (online),
 *              corner (online)
 *   text_image stacked, overlap, sticky (all online — the library's
 *              split IS the standard; its alternating-rows pattern is
 *              a sequence property, not a per-section variant)
 *   reviews    featured, masonry, summary (online), spotlight (themes)
 *   gallery    bento, masonry, strip, rail (all online — the library
 *              gallery is the uniform grid + parameters only)
 *   faq        cards (themes), split, editorial (online)
 *   cta        row, plain (themes), recap (online)
 *
 *   Part 1 — source pins (renderer map, CSS blocks, sources).
 *   Part 2 — registry ↔ renderer parity for the wave: every
 *     non-standard registry id has a renderer, every renderer is
 *     registered, every entry carries agent metadata + a source.
 *   Part 3 — DATA INVARIANCE (spec Principle 1): per type, on
 *     max-content fixtures, every source string appears in the same
 *     order in the standard render and in EVERY variant render
 *     (subsequence — a variant may add derived chrome like the
 *     rating badge's suffix or the summary aggregate, never drop,
 *     reorder or alter content); href multiset and img-src multiset
 *     are identical across all renders of the type.
 *   Part 4 — GEOMETRY DISTINCTNESS in real Chromium: per type, the
 *     standard render and every variant produce measurably
 *     different layout boxes at 1440 (media position/size, heading
 *     width, first-card position, column structure) — two variant
 *     mixes of the same content are genuinely different pages.
 *   Part 5 — SPACING GUARANTEE per variant (spec §2.5): the
 *     platform geometry audit (assessSpacing, 390/980/1440) passes
 *     a max-content page carrying every variant.
 *   Part 6 — unset byte-identity re-proven: the Batch 188 golden
 *     pins still hold after stripping the (now longer) variant CSS
 *     block with the CURRENT variantCss().
 *   Part 7 — real write paths with real variants: setSectionVariant
 *     stores/clears; deliverJob delivers a variant payload and the
 *     stored site carries the selections (variantSelectionsForPages
 *     + variantPairSet — the Batch 190 anti-repeat ledger inputs);
 *     the portal layout save persists a variant.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b189-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch189', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 33).toString('base64');

const THEME = {
  primary: '#b3123f',
  secondary: '#1d1a16',
  bg: '#fffaf4',
  text: '#241d18',
  font: 'Nunito Sans',
  headingFont: 'Playfair Display',
  baseCss: true,
};

/* Max-content fixtures per wave type (the Batch 188 fixture content,
 * extended where a type needs more items to stress its geometry). */
const FIXTURES = {
  hero: {
    content: {
      headline: 'Cakes that steal the room',
      subheadline: 'Custom cakes designed around your celebration, baked to order in small batches.',
      cta_text: 'Start an order',
      cta_href: '#contact',
      cta_secondary_text: 'See the gallery',
      cta_secondary_href: '#gallery',
      rating: '4.9',
      review_count: 132,
      image: { url: 'images/hero-side.jpg', caption: 'Signature strawberry cake' },
    },
    strings: ['4.9', '132 customer reviews', 'Cakes that steal the room', 'Custom cakes designed around your celebration', 'Start an order', 'See the gallery'],
  },
  text_image: {
    content: {
      heading: 'Wedding cakes, tiered and tailored',
      body: 'Every tier is sketched with you first: flavours, colours, and the moment it has to land. Tastings run by appointment, and delivery is white-glove on the day. Bring a photo, a theme, or just a colour — the sketch starts there and the cake follows it exactly.',
      image: { url: 'images/wedding.jpg', caption: 'Three-tier wedding cake' },
      image_position: 'right',
      button: { text: 'Plan yours', href: '#contact' },
    },
    strings: ['Wedding cakes, tiered and tailored', 'Every tier is sketched with you first', 'Plan yours'],
  },
  reviews: {
    content: {
      title: 'What customers say',
      subtitle: 'Recent words from recent parties.',
      reviews: [
        { stars: 5, text: 'The cake was the most photographed thing at the wedding after the bride.', name: 'Amara O.' },
        { stars: 5, text: 'Ordered on a Tuesday panic for Saturday. It arrived perfect and tasted even better.', name: 'Devon R.' },
        { stars: 4, text: 'Our twins fought over the last slice. Ordering two next year.', name: 'Priya S.' },
        { stars: 5, text: 'She recreated my grandmother’s recipe card as sugar calligraphy. I cried.', name: 'Marta L.' },
        { stars: 3, text: 'Good cake, delivery ran twenty minutes late on a very hot day.', name: 'Jon K.' },
        { stars: 5, text: 'The nine-year-old designed it herself and the bakery made it real, flames and all.', name: 'Ruth B.' },
      ],
    },
    strings: [
      'What customers say',
      'Recent words from recent parties.',
      'The cake was the most photographed thing',
      'Amara O.',
      'Ordered on a Tuesday panic for Saturday',
      'Devon R.',
      'Our twins fought over the last slice',
      'Priya S.',
      'recipe card as sugar calligraphy',
      'Marta L.',
      'delivery ran twenty minutes late',
      'Jon K.',
      'The nine-year-old designed it herself',
      'Ruth B.',
    ],
  },
  gallery: {
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
    // Captions of URL images render nowhere as text in ANY gallery
    // renderer (photoFigure carries them as alt/credit only) — the
    // images themselves are covered by the img-src multiset check.
    strings: ['Recent work', 'A few favourites from the bench.'],
  },
  faq: {
    content: {
      title: 'Ordering questions',
      items: [
        { q: 'How much notice do you need?', a: 'Two weeks is comfortable; rush orders are sometimes possible — ask.' },
        { q: 'Is a deposit required?', a: 'Yes — a deposit books your date and is non-refundable.' },
        { q: 'Do you deliver?', a: 'Delivery is available locally for tiered cakes.' },
        { q: 'Can you match a photo?', a: 'Send it — designs are recreated in our own style, never copied.' },
        { q: 'What flavours do you offer?', a: 'Vanilla bean, chocolate, red velvet, lemon, and a rotating seasonal special.' },
        { q: 'Do you handle allergies?', a: 'Nut-free and gluten-free bakes are available; tell us at sketch time.' },
      ],
    },
    strings: [
      'Ordering questions',
      'How much notice do you need?',
      'Two weeks is comfortable',
      'Is a deposit required?',
      'a deposit books your date',
      'Do you deliver?',
      'Delivery is available locally',
      'Can you match a photo?',
      'never copied',
      'What flavours do you offer?',
      'rotating seasonal special',
      'Do you handle allergies?',
      'tell us at sketch time',
    ],
  },
  cta: {
    content: { title: 'Ready when the party is', text: 'Dates book out fast in June.', button_text: 'Start an order', button_href: '#contact' },
    strings: ['Ready when the party is', 'Dates book out fast in June.', 'Start an order'],
  },
};

const WAVE = {
  hero: ['split', 'editorial', 'showcase', 'corner'],
  text_image: ['stacked', 'overlap', 'sticky'],
  reviews: ['featured', 'masonry', 'summary', 'spotlight'],
  gallery: ['bento', 'masonry', 'strip', 'rail'],
  faq: ['cards', 'split', 'editorial'],
  cta: ['row', 'plain', 'recap'],
};

function textOf(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
function hrefsOf(html) {
  return [...String(html).matchAll(/href="([^"]*)"/g)].map((m) => m[1]).sort();
}
function imgsOf(html) {
  return [...String(html).matchAll(/<img[^>]+src="([^"]*)"/g)].map((m) => m[1]).sort();
}
function assertSubsequence(text, strings, label) {
  let pos = 0;
  for (const s of strings) {
    const i = text.indexOf(s, pos);
    assert.ok(i >= 0, `${label}: content string missing or out of order: "${s}"`);
    pos = i + s.length;
  }
}

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
    for (const fn of ['vHeroSplit', 'vHeroEditorial', 'vHeroShowcase', 'vHeroCorner', 'vTextImageStacked', 'vTextImageOverlap', 'vTextImageSticky', 'vReviewsFeatured', 'vReviewsMasonry', 'vReviewsSummary', 'vReviewsSpotlight', 'vGalleryBento', 'vGalleryMasonry', 'vGalleryStrip', 'vGalleryRail', 'vFaqCards', 'vFaqSplit', 'vFaqEditorial', 'vCtaRow', 'vCtaPlain', 'vCtaRecap']) {
      assert.ok(eng.includes(`function ${fn}(`), `renderer ${fn} ships`);
      n++;
    }
    const reg = read('src/sectionVariants.js');
    assert.ok(reg.includes('VARIANT_CSS_BLOCKS = ['), 'variant CSS blocks ship');
    assert.ok(reg.includes("source"), 'registry entries record their source');
    n += 2;
    group('Part 1 — source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — registry ↔ renderer parity for the wave                    */
  /* ================================================================== */
  {
    let n = 0;
    assert.deepEqual(variants.typesWithVariants().sort(), Object.keys(WAVE).sort(), 'exactly the six wave types carry variants');
    n++;
    for (const [type, ids] of Object.entries(WAVE)) {
      const registered = variants.idsFor(type).filter((i) => i !== 'standard');
      assert.deepEqual([...registered].sort(), [...ids].sort(), `${type}: registry ids == wave ids`);
      const rendered = Object.keys(engine.VARIANT_RENDERERS[type] || {});
      assert.deepEqual([...rendered].sort(), [...ids].sort(), `${type}: renderer ids == wave ids`);
      for (const id of ids) {
        const e = variants.getEntry(type, id);
        assert.ok(e, `${type}/${id} registered`);
        assert.ok(['themes', 'online'].includes(e.source), `${type}/${id} records a source`);
        for (const field of ['label', 'description', 'bestFor', 'avoidWhen']) {
          assert.ok(typeof e[field] === 'string' && e[field].trim().length > 10, `${type}/${id}: ${field}`);
        }
        assert.ok(e.contentBudget && typeof e.contentBudget === 'object', `${type}/${id}: contentBudget`);
      }
      n += 3;
    }
    // Source split is real, not decorative: both sources contribute.
    const all = Object.entries(WAVE).flatMap(([t, ids]) => ids.map((id) => variants.getEntry(t, id).source));
    assert.ok(all.includes('themes') && all.includes('online'), 'both sources contribute variants');
    n++;
    group('Part 2 — registry ↔ renderer parity', n);
  }

  /* ================================================================== */
  /* Part 3 — data invariance per type                                   */
  /* ================================================================== */
  {
    let n = 0;
    for (const [type, ids] of Object.entries(WAVE)) {
      const fx = FIXTURES[type];
      const renders = {};
      renders.standard = engine.sectionToHtml({ type, content: JSON.parse(JSON.stringify(fx.content)) }, THEME);
      for (const id of ids) {
        renders[id] = engine.sectionToHtml({ type, variant: id, content: JSON.parse(JSON.stringify(fx.content)) }, THEME);
        assert.ok(renders[id].includes(`data-variant="${id}"`), `${type}/${id}: root stamped`);
        assert.ok(!renders[id].includes('render error'), `${type}/${id}: renders clean`);
      }
      const baseHrefs = hrefsOf(renders.standard);
      const baseImgs = imgsOf(renders.standard);
      for (const [id, html] of Object.entries(renders)) {
        assertSubsequence(textOf(html), fx.strings, `${type}/${id}`);
        assert.deepEqual(hrefsOf(html), baseHrefs, `${type}/${id}: href multiset identical`);
        // The corner hero carries its photo as a CSS background (the
        // standard bleed hero does the same) — img sets compare on
        // the other renders; corner's text/href invariance stands.
        if (!(type === 'hero' && id === 'corner')) {
          assert.deepEqual(imgsOf(html), baseImgs, `${type}/${id}: img-src multiset identical`);
        }
        n += 3;
      }
      // Standard render of a variant-carrying fixture section is
      // untouched by the wave: no data-variant, no bpv- classes.
      assert.ok(!renders.standard.includes('data-variant'), `${type}: standard unstamped`);
      assert.ok(!renders.standard.includes('bpv-'), `${type}: standard carries no variant classes`);
      n += 2;
    }
    group('Part 3 — data invariance', n);
  }

  /* ================================================================== */
  /* Part 4 — geometry distinctness in real Chromium                     */
  /* ================================================================== */
  {
    let puppeteer;
    try {
      puppeteer = require(path.join(root, 'node_modules/puppeteer'));
    } catch {
      puppeteer = require('puppeteer');
    }
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    let n = 0;
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 1200 });
      for (const [type, ids] of Object.entries(WAVE)) {
        const fx = FIXTURES[type];
        const measure = async (variant) => {
          const section = { type, content: JSON.parse(JSON.stringify(fx.content)) };
          if (variant) section.variant = variant;
          const pages = [{ slug: '/', title: 'T', sections: [{ type: 'nav', content: { brand: 'B189' } }, section, { type: 'footer', content: {} }] }];
          const html = engine.renderPage(pages[0], pages, THEME);
          await page.setContent(html, { waitUntil: 'load' });
          return page.evaluate((t) => {
            const rootEl = document.querySelector(`[data-ws-section-type="${t}"]`);
            if (!rootEl) return null;
            const box = (el) => {
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
            };
            const imgs = [...rootEl.querySelectorAll('img')].map(box);
            const heads = [...rootEl.querySelectorAll('h1,h2')].map(box);
            const cards = [...rootEl.querySelectorAll('.card,.bpv-faq-card,.bpv-faq-row,.bpv-rev-row,.bpv-rev-item,details')].map(box);
            return { root: box(rootEl), imgs, heads, cards };
          }, type);
        };
        const base = await measure(null);
        assert.ok(base && base.root, `${type}: standard measured`);
        const sig = (m) => JSON.stringify(m);
        const seen = new Map([['standard', sig(base)]]);
        for (const id of ids) {
          const m = await measure(id);
          assert.ok(m && m.root, `${type}/${id}: measured`);
          assert.notEqual(sig(m), sig(base), `${type}/${id}: geometry differs from standard`);
          for (const [other, s] of seen) {
            assert.notEqual(sig(m), s, `${type}/${id}: geometry differs from ${other}`);
          }
          seen.set(id, sig(m));
          n += 2;
        }
        n++;
      }
    } finally {
      await browser.close();
    }
    group('Part 4 — geometry distinctness (Chromium)', n);
  }

  /* ================================================================== */
  /* Part 5 — spacing guarantee per variant (390/980/1440)               */
  /* ================================================================== */
  {
    const spacingQa = require(path.join(root, 'server/spacingQa.js'));
    let n = 0;
    // One max-content page per wave type, carrying a different
    // variant in each of two mixes; both mixes must pass the audit.
    const mixes = [
      { hero: 'split', text_image: 'stacked', reviews: 'featured', gallery: 'bento', faq: 'cards', cta: 'row' },
      { hero: 'corner', text_image: 'overlap', reviews: 'summary', gallery: 'strip', faq: 'editorial', cta: 'recap' },
      { hero: 'editorial', text_image: 'sticky', reviews: 'masonry', gallery: 'rail', faq: 'split', cta: 'plain' },
      { hero: 'showcase', text_image: 'stacked', reviews: 'spotlight', gallery: 'masonry', faq: 'cards', cta: 'row' },
    ];
    for (const [mi, mix] of mixes.entries()) {
      const sections = [{ type: 'nav', content: { brand: 'B189 Audit' } }];
      for (const [type, id] of Object.entries(mix)) {
        sections.push({ type, variant: id, content: JSON.parse(JSON.stringify(FIXTURES[type].content)) });
      }
      sections.push({ type: 'footer', content: { business_name: 'B189 Audit' } });
      const pages = [{ slug: '/', title: 'Audit', sections }];
      const res = await spacingQa.assessSpacing(pages, THEME, { renderPage: engine.renderPage });
      const violations = (res && res.violations) || [];
      assert.equal(
        violations.length,
        0,
        `mix ${mi + 1} (${Object.values(mix).join(',')}): spacing audit clean — ${res.detail || ''}`
      );
      n++;
    }
    group('Part 5 — spacing guarantee per variant', n);
  }

  /* ================================================================== */
  /* Part 6 — unset byte-identity re-proven (187 golden pins)            */
  /* ================================================================== */
  {
    let n = 0;
    // The Batch 188 golden fixture + pins, captured from the pristine
    // Batch 187 engine. The wave changed variantCss() (the blocks are
    // no longer empty), so the strip uses the CURRENT block — the
    // pins themselves must still match exactly.
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
    const pages = [
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
    for (const s of pages[0].sections) {
      assert.equal(sha256(engine.sectionToHtml(s, THEME)), GOLDEN.sections[s.type], `section ${s.type} byte-identical`);
      n++;
    }
    const strip = (html) => String(html).split('\n' + variants.variantCss()).join('');
    const site = engine.renderSite(pages, THEME, { preview: true });
    assert.ok(site.includes(variants.variantCss()), 'variant CSS block present in the render');
    assert.equal(sha256(strip(site)), GOLDEN.renderSite, 'renderSite identical outside the variant block');
    assert.equal(sha256(strip(engine.renderPage(pages[0], pages, THEME))), GOLDEN.renderPageHome, 'home identical outside the block');
    assert.equal(sha256(strip(engine.renderPage(pages[1], pages, THEME))), GOLDEN.renderPageAbout, 'about identical outside the block');
    assert.ok(!strip(site).includes(' data-variant="'), 'no element stamped on a variant-free site (style block excluded)');
    n += 5;
    group('Part 6 — unset byte-identity re-proven', n);
  }

  /* ================================================================== */
  /* Part 7 — real write paths with real variants                        */
  /* ================================================================== */
  {
    let n = 0;
    const sec = () => ({ type: 'hero', content: { headline: 'Hi' } });
    const s1 = sec();
    structure.setSectionVariant(s1, 'split');
    assert.equal(s1.variant, 'split', 'a wave variant stores');
    structure.setSectionVariant(s1, 'standard');
    assert.ok(!('variant' in s1), 'clearing back to standard deletes the field');
    assert.deepEqual(structure.validateSectionVariants([Object.assign(sec(), { variant: 'corner' })]), [], 'wave variant validates clean');
    n += 3;

    const platformDb = require(path.join(root, 'server/db.js'));
    await platformDb.migrate();
    const workspace = require(path.join(root, 'server/workspace.js'));
    const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
    const portal = require(path.join(root, 'server/clientPortal.js'));
    const designJobs = require(path.join(root, 'src/designJobs.js'));
    const a = await workspace.createUserWithWorkspace({
      email: 'a189@example.invalid',
      password: ['batch189', 'pass'].join('-'),
      name: 'A189',
      workspaceName: 'Batch189 WS',
    });
    const WS_ID = Number(a.workspaceId);
    const LEAD_A = 189001;
    const db = openWorkspaceDb(WS_ID);
    designJobs.ensureTables(db);
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      LEAD_A,
      'B189 Fixture Bakery',
      'b189@example.invalid',
      'customer'
    );
    const job = designJobs.createJob(db, {
      leadId: LEAD_A,
      type: 'website',
      title: 'B189 variant delivery',
      instructions: 'Deliver with a variant mix.',
    });
    const payload = {
      name: 'B189 Fixture Bakery',
      theme: { primary: '#b3123f', secondary: '#1d1a16', bg: '#fffaf4', text: '#241d18' },
      pages: [
        {
          slug: '/',
          title: 'Home',
          sections: [
            { type: 'nav', content: { brand: 'B189 Fixture Bakery' } },
            { type: 'hero', variant: 'split', content: { headline: 'Cakes!', subheadline: 'Baked to order.' } },
            { type: 'reviews', variant: 'featured', content: { title: 'Words', reviews: [{ stars: 5, text: 'Great.', name: 'Jo' }] } },
            { type: 'cta', variant: 'row', content: { title: 'Order', button_text: 'Start', button_href: '#contact' } },
            { type: 'footer', content: { business_name: 'B189 Fixture Bakery' } },
          ],
        },
      ],
    };
    const delivered = await designJobs.deliverJob(db, Number(job.id), payload, null, {});
    assert.ok(delivered && delivered.website_id, 'variant payload delivers');
    const stored = JSON.parse(db.prepare('SELECT pages FROM websites WHERE id = ?').get(Number(delivered.website_id)).pages);
    const sel = variants.variantSelectionsForPages(stored);
    assert.equal(sel.heroVariant, 'split', 'ledger: hero variant recorded');
    assert.deepEqual(variants.variantPairSet(stored), ['cta:row', 'hero:split', 'reviews:featured'], 'ledger: pair set recorded');
    n += 3;
    // Portal layout save persists a variant.
    const siteRow = db.prepare('SELECT id FROM websites WHERE lead_id = ? ORDER BY id LIMIT 1').get(LEAD_A);
    const sections = JSON.parse(JSON.stringify(stored[0].sections));
    sections[1].variant = 'editorial';
    portal.applyClientLayoutSave(WS_ID, LEAD_A, { slug: '/', sections });
    const after = JSON.parse(db.prepare('SELECT pages FROM websites WHERE id = ?').get(Number(siteRow.id)).pages);
    assert.equal(after[0].sections[1].variant, 'editorial', 'layout save persists the variant');
    n++;
    group('Part 7 — real write paths', n);
  }

  console.log(`\nbatch189: all ${groups} groups passed`);
})().catch((e) => {
  console.error('batch189 FAILED:', e && e.message ? e.message : e);
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
