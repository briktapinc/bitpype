'use strict';

/* ------------------------------------------------------------------ */
/* Batch 188 — SECTION VARIANTS: the registry (spec §4).               */
/*                                                                     */
/* Every module-backed section type gains layout VARIANTS: genuinely   */
/* different presentations of the SAME section data (spec Principle    */
/* 1 — data/presentation split over the Batch 122 shared layer). The   */
/* variant lives on the section as `section.variant`, a registry id    */
/* stored ONLY when non-default (Principle 2, the Batch 148 rule):     */
/* absent = "standard" = today's renderer code path, byte-identical.   */
/*                                                                     */
/* This module is the SINGLE SOURCE the picker, the design agent, MCP  */
/* validation and QA all read (spec §4). Agent-facing metadata is a    */
/* required part of every entry — description / bestFor / avoidWhen /  */
/* contentBudget / supportsTone — so the design agent understands a    */
/* variant instead of picking by name. An entry missing any field      */
/* fails the registry parity check in the batch188 suite.              */
/*                                                                     */
/* Batch 188 (foundation) registers ONLY "standard" for every type:    */
/* the field, the registry, the renderer dispatch and the picker       */
/* exist, and no render changes anywhere. Batch 189 adds the first     */
/* variant wave (hero, text_image, reviews, gallery, faq, cta).        */
/* ------------------------------------------------------------------ */

const STANDARD = 'standard';

const TONE_BOTH = ['light', 'dark'];

/** Standard-entry metadata factory — every renderer type gets one. */
function standardEntry(type, label, description, bestFor, avoidWhen, contentBudget) {
  return {
    type,
    id: STANDARD,
    label,
    description,
    bestFor,
    avoidWhen,
    contentBudget,
    supportsTone: TONE_BOTH,
  };
}

/**
 * Non-standard entry factory (Batch 189 wave). `source` records where
 * the composition came from — 'themes' (mined from the Assistant
 * theme library, live registry + staged templates) or 'online'
 * (component-layout research) — so the wave's provenance stays
 * auditable per type.
 */
function variantEntry(type, id, label, description, bestFor, avoidWhen, contentBudget, source) {
  return { type, id, label, description, bestFor, avoidWhen, contentBudget, supportsTone: TONE_BOTH, source };
}

const REGISTRY = [
  standardEntry(
    'hero',
    'Classic centred',
    'Centred headline stack over a gradient or full-bleed background image, with up to two call-to-action buttons and an optional rating badge. A side photo replaces the background treatment when no background image is set.',
    'A single clear offer with a strong headline; the safe default for most homepages.',
    'When the page needs the product or person visible beside the words rather than behind them — use a split composition instead.',
    { maxTitleChars: 90, maxBodyChars: 240 }
  ),
  variantEntry(
    'hero',
    'split',
    'Split — text left, media right',
    'Two columns: rating badge, headline, subheadline and CTAs left-aligned in a 55% text column; the photo fills a full-height 45% media panel on the right. Stacks copy-over-media on mobile.',
    'A business with one strong photo that should sit beside the pitch, not behind it — services, makers, storefronts.',
    'When there is no photo worth half the hero — an empty or weak panel wastes the space; use editorial or the standard centred hero.',
    { maxTitleChars: 80, maxBodyChars: 200 },
    'themes'
  ),
  variantEntry(
    'hero',
    'editorial',
    'Editorial — oversized type, media below',
    'The headline runs oversized across the full width; subheadline and CTAs sit in a narrow column offset to the right beneath it; the photo follows as a wide band below the type. Left-aligned, generous whitespace.',
    'Strong-voice brands and portfolios where the words are the visual and the photo is supporting proof.',
    'When the headline is short or weak — the oversized type exposes it; and when the CTA must be the first thing seen.',
    { maxTitleChars: 70, maxBodyChars: 200 },
    'themes'
  ),
  variantEntry(
    'hero',
    'showcase',
    'Showcase — centred stack, media below',
    'A single centred column — badge, headline, subheadline, CTAs — with the photo below at full container width, cropped by the section foot. Nothing competes with the message until the image arrives.',
    'One simple offer with one action, where the copy carries the page and the photo is proof underneath.',
    'On image-led pages where the photo IS the message (use corner or split), and when content below the fold matters immediately on mobile.',
    { maxTitleChars: 80, maxBodyChars: 200 },
    'online'
  ),
  variantEntry(
    'hero',
    'corner',
    'Corner panel — full-bleed photo, anchored copy',
    'The photo fills the hero edge to edge; all copy (badge, headline, subheadline, CTAs) lives in one solid panel anchored to the bottom-left corner over the image. Falls back to the standard gradient ground when no image is set.',
    'Places, food, hospitality and physical work where one extraordinary photograph is the selling point.',
    'Without a high-resolution, wide photo — there is nowhere to hide a poor one; and when the photo subject sits bottom-left where the panel lands.',
    { maxTitleChars: 70, maxBodyChars: 160 },
    'online'
  ),
  standardEntry(
    'text_image',
    'Classic side-by-side',
    'Two-column row: text (heading, lede, optional button) beside a photo, image on the right by default or flipped left. The services/about workhorse.',
    'Explaining one service or one idea with a supporting photo.',
    'When there is no photo worth showing, or the copy is a long read — a text or stacked composition carries it better.',
    { maxTitleChars: 80, maxBodyChars: 600 }
  ),
  variantEntry(
    'text_image',
    'stacked',
    'Stacked — heading, wide media, two-column text',
    'Heading row on top, the photo as a wide band beneath it, then the body set in two narrow columns under the image with the button under the first column. Reads like an article, not a split.',
    'Image-led services (finished work, venues, food) with longer explanatory copy that deserves a reading layout.',
    'When the copy is one short paragraph — the two columns look empty; and when the button must sit beside the heading for conversion.',
    { maxTitleChars: 80, maxBodyChars: 900 },
    'online'
  ),
  variantEntry(
    'text_image',
    'overlap',
    'Overlap — text card over the media edge',
    'The photo takes about two-thirds of the width; the text (heading, body, button) sits in a solid card pulled across the photo\u2019s inner edge, vertically centred. On mobile the overlap is removed and the card stacks under the photo.',
    'One flagship service per page with shorter, punchier copy that benefits from an editorial lift over a plain split.',
    'With long body copy — the growing card swallows the photo; and over busy photos if the card edge distracts from the subject.',
    { maxTitleChars: 70, maxBodyChars: 420 },
    'online'
  ),
  variantEntry(
    'text_image',
    'sticky',
    'Sticky media — photo holds while text scrolls',
    'The photo column sticks at 45% width while a taller text column (heading plus longer body) scrolls beside it. On mobile the photo simply leads the stack.',
    'Longer service descriptions, process or detail copy where the visual is a constant reference while the reader works through the text.',
    'When the text is short — there is nothing to scroll against and the sticky column is dead weight.',
    { maxTitleChars: 80, maxBodyChars: 1400 },
    'online'
  ),
  standardEntry(
    'reviews',
    'Classic review cards',
    'Equal card grid: star row, quote, reviewer name. Every review gets the same weight.',
    'A set of comparable short reviews where no single voice should dominate.',
    'When one review is the story (a spotlight composition serves it better), or reviews are long-form.',
    { maxItems: 12, maxBodyChars: 400 }
  ),
  variantEntry(
    'reviews',
    'featured',
    'Featured — one story large, the rest in a grid',
    'The first review spans the full width as a large-type feature row; the remaining reviews sit in the classic equal card grid beneath it. Same reviews, same order — one voice is given the headline weight.',
    'When one detailed review tells the whole story and the rest are supporting voices.',
    'When the first review is ordinary — at feature size it looks inflated; reorder the reviews so the strongest leads.',
    { maxItems: 12, maxBodyChars: 500 },
    'online'
  ),
  variantEntry(
    'reviews',
    'masonry',
    'Masonry — natural heights in columns',
    'Reviews flow through three CSS columns at their natural heights (two on tablet, one on mobile), each card intact. Uneven lengths become a staggered wall of proof instead of empty card bottoms.',
    'Many reviews (six or more) of very uneven length, where the volume itself is the argument.',
    'When reading order matters — columns read down, then across; and on minimal premium pages where the stagger reads as clutter.',
    { maxItems: 12, maxBodyChars: 600 },
    'online'
  ),
  variantEntry(
    'reviews',
    'summary',
    'Summary split — aggregate rail, reviews as rows',
    'A left rail carries the aggregate computed from the reviews themselves (average stars and count) with the section title; the right column lists the reviews as stacked horizontal rows divided by rules. The rail sticks on desktop.',
    'Review-driven local businesses where the overall score is the headline claim and individual quotes are the evidence.',
    'With only two or three reviews — a summary rail over so few looks manufactured; use the classic grid.',
    { maxItems: 12, maxBodyChars: 500 },
    'online'
  ),
  variantEntry(
    'reviews',
    'spotlight',
    'Spotlight — large centred quotes, stacked',
    'No cards: each review is a large centred pull-quote in a narrow column — stars above, quote at display size, name in spaced caps below — stacked with generous air between them.',
    'Fewer, stronger reviews (one to four) that deserve to be read slowly; editorial and premium pages.',
    'With many reviews — the stack becomes very tall; use the grid or masonry instead.',
    { maxItems: 4, maxBodyChars: 400 },
    'themes'
  ),
  standardEntry(
    'gallery',
    'Classic uniform grid',
    'Uniform three-column grid of photos with captions, up to six images, 4:3 crops.',
    'A tidy portfolio set where every image matters equally.',
    'When one image is the hero piece (a mosaic gives it the weight), or the set is a story better told as a strip.',
    { maxItems: 6 }
  ),
  variantEntry(
    'gallery',
    'bento',
    'Bento — first image featured in a mosaic',
    'An asymmetric mosaic: the first image spans two columns and two rows; the remaining images fill the single cells around it. On mobile the mosaic becomes a plain stack with the featured image first.',
    'A set with one hero shot that should dominate plus supporting details — a finished job and its close-ups.',
    'When the images arrive in arbitrary order and none deserves prominence — bento hard-codes "image 1 is the star".',
    { maxItems: 6 },
    'online'
  ),
  variantEntry(
    'gallery',
    'masonry',
    'Masonry — natural aspect columns',
    'Images keep their native aspect ratios and stack at natural heights through CSS columns (three on desktop, two on tablet, one on mobile), caption under each. Nothing is cropped.',
    'Mixed portrait/landscape photography where each photo\u2019s composition matters — events, documentary work, portfolios.',
    'When a strict sequence matters (columns flow down, then across) or captions must align on a baseline.',
    { maxItems: 6 },
    'online'
  ),
  variantEntry(
    'gallery',
    'strip',
    'Strip — horizontal scroll-snap row',
    'One horizontal strip of large tiles (about 80% of the container each) with scroll-snap; the next tile peeks to invite the swipe. No JavaScript — a native scrollable row. Vertical cost stays one tile tall.',
    'Big immersive images on mobile-heavy pages, and galleries placed mid-page where vertical space is scarce.',
    'When every image must be seen without interaction — tiles past the first are hidden until scrolled.',
    { maxItems: 6 },
    'online'
  ),
  variantEntry(
    'gallery',
    'rail',
    'Rail — featured image with thumbnail rail',
    'One large featured image (about two-thirds) on the left; the remaining images stack as a vertical rail of smaller captioned tiles on the right. On mobile it becomes featured image, then the rail as a list.',
    'A "main result plus supporting angles" story: one finished piece with detail shots beside it; showroom-style sets.',
    'When all images are equal in importance — the hierarchy misleads; and with long captions, which do not fit rail tiles.',
    { maxItems: 6 },
    'online'
  ),
  standardEntry(
    'faq',
    'Classic stacked questions',
    'Full-width stacked disclosure rows, one question per row, answers expand in place.',
    'Short-to-medium FAQ lists (up to about eight questions) read top to bottom.',
    'Long FAQ lists scan better in two columns; very short lists may not need card chrome at all.',
    { maxItems: 20, maxBodyChars: 800 }
  ),
  variantEntry(
    'faq',
    'cards',
    'Open cards — every answer visible, two-column grid',
    'No collapsing: each question and its answer form a self-contained card in a two-column grid (one column on mobile), question as the card heading, answer always visible beneath it.',
    'Up to about six short-answer questions — pricing and objection FAQs where visitors compare answers without clicking; every answer stays visible to search engines and print.',
    'With long answers — the cards go ragged and the section very tall; use the classic accordion or the split.',
    { maxItems: 8, maxBodyChars: 400 },
    'themes'
  ),
  variantEntry(
    'faq',
    'split',
    'Split — sticky heading, accordion beside it',
    'Two columns: the section title sits in a sticky left column while the classic disclosure list runs down the right column. On mobile the title simply heads the stack.',
    'Longer FAQ sets (six to twelve questions) on dedicated or pricing pages, where the heading should stay in view while scanning.',
    'With four or fewer questions — the sticky rail sits beside a short list with dead space below it.',
    { maxItems: 12, maxBodyChars: 800 },
    'online'
  ),
  variantEntry(
    'faq',
    'editorial',
    'Editorial rows — question and answer columns',
    'All open, no cards and no collapsing: each pair is a full-width ruled row split into a question column (about one-third) and an answer column (two-thirds). On mobile the pair stacks.',
    'A few (three to six) weighty questions with substantive answers — trust, compliance and process explanations in an editorial tone.',
    'For large FAQ sets — this is the tallest geometry per question; use the accordion forms.',
    { maxItems: 6, maxBodyChars: 900 },
    'online'
  ),
  standardEntry(
    'cta',
    'Classic centred band',
    'Centred call-to-action band card: headline, optional line of text, one button, on the secondary colour.',
    'A single decisive next step at the end of a page.',
    'When the CTA should sit quietly beside running text rather than interrupting it as a band.',
    { maxTitleChars: 70, maxBodyChars: 160 }
  ),
  variantEntry(
    'cta',
    'row',
    'Action row — copy left, button right',
    'A single horizontal row inside the band: headline and text stacked in the left two-thirds, the button vertically centred in the right third. On mobile it stacks centred. The lowest vertical cost of any CTA form.',
    'Mid-page CTAs between sections, and warm pages where the pitch needs one line and the ask should not interrupt.',
    'When the headline runs past about six words or the text past one line — the row unbalances and squeezes the button column.',
    { maxTitleChars: 60, maxBodyChars: 120 },
    'themes'
  ),
  variantEntry(
    'cta',
    'plain',
    'Plain — centred stack, no band',
    'The centred stack (headline, text, button) with no panel and no background — just section air around it. The quietest closing form.',
    'Minimal and editorial sites, and pages whose neighbouring sections already carry strong bands.',
    'When the CTA is the page\u2019s primary conversion point — with no band it is easy to scroll past.',
    { maxTitleChars: 70, maxBodyChars: 160 },
    'themes'
  ),
  variantEntry(
    'cta',
    'recap',
    'Recap — headline left, text and button right',
    'Two columns inside the band: the headline alone in the left column; the text and the button stacked, top-aligned, in the right column. On mobile it collapses to a single stack.',
    'Final CTAs where the headline is a strong closing statement and the text carries the last reassurance before the click.',
    'With a short headline the left column is mostly void, and the two reading starts slow comprehension versus a single stack.',
    { maxTitleChars: 60, maxBodyChars: 160 },
    'online'
  ),
  standardEntry(
    'cards',
    'Classic card grid',
    'Uniform card grid (2–4 columns) of titled items with optional photo, icon chip and text.',
    'Sets of comparable items — services, cakes types, features — scanned at a glance.',
    'When items differ wildly in importance or length; a list or columns composition absorbs that better.',
    { maxItems: 12, maxBodyChars: 300 }
  ),
  standardEntry(
    'benefits',
    'Classic benefit cards',
    'Card grid with a numbered or icon chip per benefit, title and short text.',
    'Short "why us" proof points in comparable chunks.',
    'When the points are really one flowing argument — a text section carries it better.',
    { maxItems: 9, maxBodyChars: 220 }
  ),
  standardEntry(
    'services',
    'Classic services list',
    "The services section's standard composition (title, subtitle, item grid).",
    'Listing the services a business offers, in comparable chunks.',
    'When one service deserves a full text_image treatment of its own.',
    { maxItems: 12, maxBodyChars: 300 }
  ),
  standardEntry(
    'about',
    'Classic about block',
    "The about section's standard composition (heading plus paragraphs).",
    'A straightforward business story in a few paragraphs.',
    'When the story is really a person + photo story — text_image tells it warmer.',
    { maxBodyChars: 1200 }
  ),
  standardEntry(
    'columns',
    'Classic columns',
    'Even multi-column layout of independent cells (text, lists, media) in 1–4 columns.',
    'Side-by-side comparisons, steps, or grouped facts of similar weight.',
    'When one column must dominate — a text_image or hero composition has the hierarchy.',
    { maxItems: 4, maxBodyChars: 600 }
  ),
  standardEntry(
    'text',
    'Classic text block',
    'Single readable text column (heading plus body), measure-limited.',
    'Any straightforward passage of copy.',
    'When the passage needs a visual partner — text_image or columns.',
    { maxBodyChars: 2000 }
  ),
  standardEntry(
    'heading',
    'Classic heading',
    'A standalone section heading at the chosen level.',
    'Breaking a long page into named parts.',
    'Never wrong; it carries no composition risk.',
    { maxTitleChars: 100 }
  ),
  standardEntry(
    'image',
    'Classic image block',
    'A standalone photo at container width with optional caption/credit.',
    'One image that deserves its own moment.',
    'When the image belongs inside a gallery set instead.',
    {}
  ),
  standardEntry(
    'contact_form',
    'Classic contact form',
    'The native contact form section — contact details plus the managed form binding. A flow, not a layout: no variants (spec §8 Batch C rule).',
    'The contact page of any site.',
    'Never substitute a hand-rolled form; this section binds the native flow.',
    {}
  ),
  standardEntry(
    'map_placeholder',
    'Classic map block',
    'Dashed map placeholder block with a pin and address lines.',
    'Showing a service location before a live map embed exists.',
    'When no location should be shown at all.',
    {}
  ),
  standardEntry(
    'hours',
    'Classic hours table',
    'Two-column hours table, day against times.',
    'Publishing opening hours compactly.',
    'When hours are irregular prose rather than a weekly table.',
    {}
  ),
  standardEntry(
    'booking_button',
    'Classic booking button',
    'A centred oversized call/booking button block.',
    'A single phone-first conversion point.',
    'When a full bookings module is attached — place the module instead.',
    {}
  ),
  standardEntry(
    'social_links',
    'Classic social row',
    'A wrapping row of social network links with icons.',
    'A light social presence strip, usually near the footer.',
    'When social proof is the point — reviews carry quotes, this carries links only.',
    { maxItems: 8 }
  ),
  standardEntry(
    'site_module',
    'Classic module mount',
    'The in-page mount for a published site module (Batch 122 shared layer). The module renders its own surface; the section only places it. Functional modules get no layout variants (spec §8).',
    'Placing any published module on a page.',
    'Never restyle the module from here — module surfaces are configured in the Modules tab.',
    {}
  ),
  standardEntry(
    'bitpype_form',
    'Classic form embed',
    'The managed portal form embed mount. A flow, not a layout: no variants.',
    'Placing a published custom form on a page.',
    'Never substitute hand-rolled form HTML.',
    {}
  ),
  standardEntry(
    'form',
    'Classic form embed',
    'Alias of the managed portal form embed mount. A flow, not a layout: no variants.',
    'Placing a published custom form on a page.',
    'Never substitute hand-rolled form HTML.',
    {}
  ),
  standardEntry(
    'custom',
    'Classic custom block',
    'The generic fallback block for a section type with no dedicated renderer (heading + body).',
    'One-off structured content that fits no named type.',
    'When a named type fits — its renderer and variants are richer.',
    { maxBodyChars: 1200 }
  ),
  standardEntry(
    'html',
    'Freestyle HTML',
    'Author-supplied HTML rendered as-is inside the section wrapper. Freestyle composition is the author’s own — variants do not apply.',
    'Bespoke compositions the modular types cannot express.',
    'When a modular type expresses it — modules stay editable and measurable.',
    {}
  ),
  standardEntry(
    'nav',
    'Platform chrome — navigation',
    'Site navigation chrome. Chrome has its own rules (mobile nav standard, logo rule) and is OUT of the variant system in v1 (spec decision D5).',
    'Every page carries exactly one nav, first.',
    'Never variant-switched in v1.',
    {}
  ),
  standardEntry(
    'footer',
    'Platform chrome — footer',
    'Site footer chrome. Chrome has its own rules and is OUT of the variant system in v1 (spec decision D5).',
    'Every page carries exactly one footer, last.',
    'Never variant-switched in v1.',
    {}
  ),
];

/** Types whose sections may carry a non-standard variant in v1 (D5: chrome never). */
const CHROME_TYPES = new Set(['nav', 'footer']);

const BY_TYPE = new Map();
for (const entry of REGISTRY) {
  if (!BY_TYPE.has(entry.type)) BY_TYPE.set(entry.type, []);
  BY_TYPE.get(entry.type).push(entry);
}

function entriesFor(type) {
  return BY_TYPE.get(String(type || '')) || [];
}

function idsFor(type) {
  return entriesFor(type).map((e) => e.id);
}

function getEntry(type, id) {
  return entriesFor(type).find((e) => e.id === id) || null;
}

function isRegisteredType(type) {
  return BY_TYPE.has(String(type || ''));
}

/** A variant id is valid for a type when the registry carries it. */
function isValidVariant(type, id) {
  if (typeof id !== 'string' || !id) return false;
  return !!getEntry(type, id);
}

/**
 * The section's effective variant id: the stored id when set, else
 * "standard" (Principle 2 — absent means standard, always).
 */
function variantOf(section) {
  const raw = section && typeof section.variant === 'string' ? section.variant.trim() : '';
  return raw || STANDARD;
}

/** True when the section carries a stored, non-default variant id. */
function hasStoredVariant(section) {
  return variantOf(section) !== STANDARD;
}

/** Types that offer at least one non-standard variant. */
function typesWithVariants() {
  return [...BY_TYPE.keys()].filter((t) => entriesFor(t).some((e) => e.id !== STANDARD));
}

/**
 * Agent/picker-facing registry summary: per type, the entries in
 * registry (curated) order with full agent metadata (spec §4/§6).
 */
function registrySummary() {
  const types = {};
  for (const [type, entries] of BY_TYPE) {
    types[type] = entries.map((e) => ({
      id: e.id,
      label: e.label,
      description: e.description,
      bestFor: e.bestFor,
      avoidWhen: e.avoidWhen,
      contentBudget: e.contentBudget,
      supportsTone: e.supportsTone,
      source: e.source || null,
    }));
  }
  return { version: 1, standard: STANDARD, types };
}

/**
 * A site's variant selections, in page order — the raw material of the
 * §4a layout fingerprint and the Batch 190 anti-repeat ledger. Only
 * sections with a stored non-standard variant appear in `selections`;
 * `heroVariant` always resolves (absent hero variant = "standard",
 * absent hero section = null).
 */
function variantSelectionsForPages(pages) {
  const selections = [];
  let heroVariant = null;
  let heroSeen = false;
  for (const page of Array.isArray(pages) ? pages : []) {
    const sections = page && Array.isArray(page.sections) ? page.sections : [];
    sections.forEach((section, index) => {
      if (!section || typeof section.type !== 'string') return;
      if (section.type === 'hero' && !heroSeen) {
        heroSeen = true;
        heroVariant = variantOf(section);
      }
      if (hasStoredVariant(section)) {
        selections.push({
          page: typeof page.slug === 'string' ? page.slug : '',
          index,
          type: section.type,
          variant: variantOf(section),
        });
      }
    });
  }
  return { heroVariant, selections };
}

/** The (type → variant) pair set of a site, as sorted "type:variant" strings. */
function variantPairSet(pages) {
  const pairs = new Set();
  for (const sel of variantSelectionsForPages(pages).selections) {
    pairs.add(`${sel.type}:${sel.variant}`);
  }
  return [...pairs].sort();
}

/* ------------------------------------------------------------------ */
/* Variant CSS (spec §4/§5). Appended by the engine's siteCss AFTER    */
/* authored CSS, like the spacing guard: rules are scoped under        */
/* section[data-ws-section-type="<type>"][data-variant="<id>"] so a    */
/* rule can only match a section that carries that variant — a         */
/* variant-free site matches none of them and renders exactly as       */
/* before (the block itself is the only byte delta, pairwise-proven    */
/* in the batch188/189 suites, the Batch 185–187 re-pin pattern).      */
/*                                                                     */
/* §5 shared text primitives come FIRST: one token-driven definition   */
/* of eyebrow/topper, section title, body text and solid button,       */
/* consumed by every variant layout. Standard renderers keep their     */
/* existing per-module styles as overrides where they differ (spec     */
/* §5: convergence without a visual regression); new variants are      */
/* built on the primitives from the start. NO hard-coded brand         */
/* colour or font anywhere in this block (Principle 3).                */
/* ------------------------------------------------------------------ */

const PRIMITIVES_CSS = [
  '.bp-topper{display:block;font-size:.78rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--ws-primary);margin-bottom:10px}',
  '.bp-title{font-family:var(--ws-heading-font,var(--ws-font));font-size:1.8rem;line-height:1.25;color:var(--ws-secondary);margin-bottom:8px}',
  '.bp-text{color:var(--ws-text);opacity:.82;line-height:1.65}',
  '.bp-btn-solid{display:inline-block;background:var(--ws-primary);color:#fff;padding:13px 26px;border-radius:8px;font-weight:800;text-decoration:none}',
].join('\n');

/**
 * Variant rule blocks (Batch 189 wave). Every rule is scoped under
 * [data-ws-section-type="<type>"][data-variant="<id>"] so it can only
 * match a section carrying that variant. Layouts are built on the
 * §5 primitives' tokens (var(--ws-*)); no hard-coded brand colour or
 * font. Each block carries its own ≤700px recomposition — overlap,
 * mosaic and split geometries stack explicitly on mobile.
 */
const VARIANT_CSS_BLOCKS = [
  /* hero — split */
  [
    '[data-ws-section-type="hero"][data-variant="split"] .bpv-hero-split{display:grid;grid-template-columns:55fr 45fr;gap:36px;align-items:stretch}',
    '[data-ws-section-type="hero"][data-variant="split"] .bpv-hero-copy{display:flex;flex-direction:column;justify-content:center;text-align:left}',
    '[data-ws-section-type="hero"][data-variant="split"] .bpv-hero-side{display:flex}',
    '[data-ws-section-type="hero"][data-variant="split"] .bpv-hero-side figure{flex:1;margin:0}',
    '[data-ws-section-type="hero"][data-variant="split"] .bpv-hero-side img{width:100%;height:100%;min-height:280px;object-fit:cover;border-radius:12px;display:block}',
    '[data-ws-section-type="hero"][data-variant="split"] .bpv-hero-media{flex:1;border-radius:12px;background-size:cover;background-position:center;min-height:280px}',
    '@media (max-width:700px){[data-ws-section-type="hero"][data-variant="split"] .bpv-hero-split{grid-template-columns:1fr}[data-ws-section-type="hero"][data-variant="split"] .bpv-hero-side img,[data-ws-section-type="hero"][data-variant="split"] .bpv-hero-media{min-height:200px}}',
  ].join('\n'),
  /* hero — editorial */
  [
    '[data-ws-section-type="hero"][data-variant="editorial"] .bpv-ed-title{font-size:clamp(2.4rem,6vw,4.2rem);line-height:1.08;text-align:left;max-width:14ch}',
    '[data-ws-section-type="hero"][data-variant="editorial"] .bpv-ed-sub{margin-left:38%;max-width:520px;text-align:left}',
    '[data-ws-section-type="hero"][data-variant="editorial"] .bpv-ed-media{margin-top:40px}',
    '[data-ws-section-type="hero"][data-variant="editorial"] .bpv-ed-media figure{margin:0}',
    '[data-ws-section-type="hero"][data-variant="editorial"] .bpv-ed-media img{width:100%;aspect-ratio:21/9;object-fit:cover;border-radius:12px;display:block}',
    '[data-ws-section-type="hero"][data-variant="editorial"] .bpv-ed-media-div{aspect-ratio:21/9;border-radius:12px;background-size:cover;background-position:center}',
    '@media (max-width:700px){[data-ws-section-type="hero"][data-variant="editorial"] .bpv-ed-sub{margin-left:0}[data-ws-section-type="hero"][data-variant="editorial"] .bpv-ed-media img,[data-ws-section-type="hero"][data-variant="editorial"] .bpv-ed-media-div{aspect-ratio:16/10}}',
  ].join('\n'),
  /* hero — showcase */
  [
    '[data-ws-section-type="hero"][data-variant="showcase"] .bpv-sc-stack{text-align:center;max-width:760px;margin:0 auto}',
    '[data-ws-section-type="hero"][data-variant="showcase"] .bpv-sc-media{margin-top:36px}',
    '[data-ws-section-type="hero"][data-variant="showcase"] .bpv-sc-media figure{margin:0}',
    '[data-ws-section-type="hero"][data-variant="showcase"] .bpv-sc-media img{width:100%;aspect-ratio:16/8;object-fit:cover;border-radius:12px 12px 0 0;display:block}',
    '[data-ws-section-type="hero"][data-variant="showcase"] .bpv-sc-media-div{aspect-ratio:16/8;border-radius:12px 12px 0 0;background-size:cover;background-position:center}',
  ].join('\n'),
  /* hero — corner */
  [
    '[data-ws-section-type="hero"][data-variant="corner"]{background-size:cover;background-position:center}',
    '[data-ws-section-type="hero"][data-variant="corner"] .bpv-corner-wrap{display:flex;align-items:flex-end;min-height:420px}',
    '[data-ws-section-type="hero"][data-variant="corner"] .bpv-corner-panel{background:var(--ws-secondary);color:#fff;border-radius:12px;padding:28px;max-width:520px;text-align:left}',
    '[data-ws-section-type="hero"][data-variant="corner"] .bpv-corner-panel h1{color:#fff}',
    '[data-ws-section-type="hero"][data-variant="corner"] .bpv-corner-panel p{color:#fff;opacity:.88}',
    '@media (max-width:700px){[data-ws-section-type="hero"][data-variant="corner"] .bpv-corner-wrap{min-height:0}[data-ws-section-type="hero"][data-variant="corner"] .bpv-corner-panel{max-width:none}}',
  ].join('\n'),
  /* text_image — stacked */
  [
    '[data-ws-section-type="text_image"][data-variant="stacked"] .bpv-ti-media{margin:20px 0 24px}',
    '[data-ws-section-type="text_image"][data-variant="stacked"] .bpv-ti-media figure{margin:0}',
    '[data-ws-section-type="text_image"][data-variant="stacked"] .bpv-ti-media img{width:100%;aspect-ratio:21/9;object-fit:cover;border-radius:12px;display:block}',
    '[data-ws-section-type="text_image"][data-variant="stacked"] .bpv-ti-cols{column-count:2;column-gap:36px;text-align:left}',
    '@media (max-width:700px){[data-ws-section-type="text_image"][data-variant="stacked"] .bpv-ti-cols{column-count:1}[data-ws-section-type="text_image"][data-variant="stacked"] .bpv-ti-media img{aspect-ratio:16/10}}',
  ].join('\n'),
  /* text_image — overlap */
  [
    '[data-ws-section-type="text_image"][data-variant="overlap"] .bpv-ti-overlap{display:grid;grid-template-columns:repeat(12,1fr);align-items:center}',
    '[data-ws-section-type="text_image"][data-variant="overlap"] .bpv-ti-media{grid-column:1/9;grid-row:1}',
    '[data-ws-section-type="text_image"][data-variant="overlap"] .bpv-ti-media figure{margin:0}',
    '[data-ws-section-type="text_image"][data-variant="overlap"] .bpv-ti-media img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;display:block}',
    '[data-ws-section-type="text_image"][data-variant="overlap"] .bpv-ti-card{grid-column:8/13;grid-row:1;background:var(--ws-bg);border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:28px;box-shadow:0 18px 40px rgba(0,0,0,.14);text-align:left}',
    '@media (max-width:700px){[data-ws-section-type="text_image"][data-variant="overlap"] .bpv-ti-overlap{display:block}[data-ws-section-type="text_image"][data-variant="overlap"] .bpv-ti-card{margin-top:16px}}',
  ].join('\n'),
  /* text_image — sticky */
  [
    '[data-ws-section-type="text_image"][data-variant="sticky"] .bpv-ti-sticky{display:grid;grid-template-columns:45fr 55fr;gap:36px;align-items:start}',
    '[data-ws-section-type="text_image"][data-variant="sticky"] .bpv-ti-media{position:sticky;top:24px}',
    '[data-ws-section-type="text_image"][data-variant="sticky"] .bpv-ti-media figure{margin:0}',
    '[data-ws-section-type="text_image"][data-variant="sticky"] .bpv-ti-media img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;display:block}',
    '[data-ws-section-type="text_image"][data-variant="sticky"] .bpv-ti-copy{text-align:left}',
    '@media (max-width:700px){[data-ws-section-type="text_image"][data-variant="sticky"] .bpv-ti-sticky{grid-template-columns:1fr}[data-ws-section-type="text_image"][data-variant="sticky"] .bpv-ti-media{position:static}}',
  ].join('\n'),
  /* reviews — featured */
  [
    '[data-ws-section-type="reviews"][data-variant="featured"] .bpv-rev-feature{border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:32px;margin-bottom:20px;text-align:left;background:var(--ws-bg)}',
    '[data-ws-section-type="reviews"][data-variant="featured"] .bpv-rev-feature .bpv-rev-quote{font-family:var(--ws-heading-font,var(--ws-font));font-size:1.6rem;line-height:1.4}',
  ].join('\n'),
  /* reviews — masonry */
  [
    '[data-ws-section-type="reviews"][data-variant="masonry"] .bpv-rev-masonry{column-count:3;column-gap:20px;text-align:left}',
    '[data-ws-section-type="reviews"][data-variant="masonry"] .bpv-rev-masonry .card{break-inside:avoid;margin-bottom:20px}',
    '@media (max-width:980px){[data-ws-section-type="reviews"][data-variant="masonry"] .bpv-rev-masonry{column-count:2}}',
    '@media (max-width:700px){[data-ws-section-type="reviews"][data-variant="masonry"] .bpv-rev-masonry{column-count:1}}',
  ].join('\n'),
  /* reviews — summary */
  [
    '[data-ws-section-type="reviews"][data-variant="summary"] .bpv-rev-split{display:grid;grid-template-columns:30fr 70fr;gap:36px;align-items:start;text-align:left}',
    '[data-ws-section-type="reviews"][data-variant="summary"] .bpv-rev-rail{position:sticky;top:24px}',
    '[data-ws-section-type="reviews"][data-variant="summary"] .bpv-rev-avg{font-family:var(--ws-heading-font,var(--ws-font));font-size:2.6rem;line-height:1.18;margin-bottom:8px}',
    '[data-ws-section-type="reviews"][data-variant="summary"] .bpv-rev-row{padding:18px 16px;border-bottom:1px solid rgba(0,0,0,.12)}',
    '@media (max-width:700px){[data-ws-section-type="reviews"][data-variant="summary"] .bpv-rev-split{grid-template-columns:1fr}[data-ws-section-type="reviews"][data-variant="summary"] .bpv-rev-rail{position:static}}',
  ].join('\n'),
  /* reviews — spotlight */
  [
    '[data-ws-section-type="reviews"][data-variant="spotlight"] .bpv-rev-spot{max-width:820px;margin:0 auto;text-align:center}',
    '[data-ws-section-type="reviews"][data-variant="spotlight"] .bpv-rev-item{padding:30px 16px;border-bottom:1px solid rgba(0,0,0,.1)}',
    '[data-ws-section-type="reviews"][data-variant="spotlight"] .bpv-rev-item:last-child{border-bottom:0}',
    '[data-ws-section-type="reviews"][data-variant="spotlight"] .bpv-rev-quote{font-family:var(--ws-heading-font,var(--ws-font));font-size:1.7rem;line-height:1.4}',
    '[data-ws-section-type="reviews"][data-variant="spotlight"] .bpv-rev-who{margin-top:12px;font-size:.8rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--ws-primary)}',
  ].join('\n'),
  /* gallery — bento */
  [
    '[data-ws-section-type="gallery"][data-variant="bento"] .bpv-gal-bento{display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:1fr;gap:16px}',
    '[data-ws-section-type="gallery"][data-variant="bento"] .bpv-cell-first{grid-column:span 2;grid-row:span 2}',
    '[data-ws-section-type="gallery"][data-variant="bento"] figure{margin:0;height:100%}',
    '[data-ws-section-type="gallery"][data-variant="bento"] figure img{width:100%;height:100%;aspect-ratio:auto;object-fit:cover;border-radius:12px;display:block}',
    '[data-ws-section-type="gallery"][data-variant="bento"] .ph{height:100%;border-radius:12px}',
    '@media (max-width:700px){[data-ws-section-type="gallery"][data-variant="bento"] .bpv-gal-bento{grid-template-columns:1fr}[data-ws-section-type="gallery"][data-variant="bento"] .bpv-cell-first{grid-column:auto;grid-row:auto}}',
  ].join('\n'),
  /* gallery — masonry */
  [
    '[data-ws-section-type="gallery"][data-variant="masonry"] .bpv-gal-masonry{column-count:3;column-gap:16px}',
    '[data-ws-section-type="gallery"][data-variant="masonry"] figure{margin:0 0 16px;break-inside:avoid}',
    '[data-ws-section-type="gallery"][data-variant="masonry"] figure img{width:100%;aspect-ratio:auto;object-fit:cover;border-radius:12px;display:block}',
    '[data-ws-section-type="gallery"][data-variant="masonry"] .ph{margin-bottom:16px;border-radius:12px;break-inside:avoid}',
    '@media (max-width:980px){[data-ws-section-type="gallery"][data-variant="masonry"] .bpv-gal-masonry{column-count:2}}',
    '@media (max-width:700px){[data-ws-section-type="gallery"][data-variant="masonry"] .bpv-gal-masonry{column-count:1}}',
  ].join('\n'),
  /* gallery — strip */
  [
    '[data-ws-section-type="gallery"][data-variant="strip"] .bpv-gal-strip{display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:10px}',
    '[data-ws-section-type="gallery"][data-variant="strip"] .bpv-strip-cell{flex:0 0 80%;scroll-snap-align:start}',
    '[data-ws-section-type="gallery"][data-variant="strip"] figure{margin:0}',
    '[data-ws-section-type="gallery"][data-variant="strip"] figure img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:12px;display:block}',
    '[data-ws-section-type="gallery"][data-variant="strip"] .ph{border-radius:12px;aspect-ratio:16/10}',
    '@media (max-width:700px){[data-ws-section-type="gallery"][data-variant="strip"] .bpv-strip-cell{flex-basis:86%}}',
  ].join('\n'),
  /* gallery — rail */
  [
    '[data-ws-section-type="gallery"][data-variant="rail"] .bpv-gal-rail{display:grid;grid-template-columns:65fr 35fr;gap:16px;align-items:start}',
    '[data-ws-section-type="gallery"][data-variant="rail"] .bpv-rail-main figure{margin:0}',
    '[data-ws-section-type="gallery"][data-variant="rail"] .bpv-rail-main img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;display:block}',
    '[data-ws-section-type="gallery"][data-variant="rail"] .bpv-rail-side{display:flex;flex-direction:column;gap:16px}',
    '[data-ws-section-type="gallery"][data-variant="rail"] .bpv-rail-side figure{margin:0}',
    '[data-ws-section-type="gallery"][data-variant="rail"] .bpv-rail-side img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:12px;display:block}',
    '[data-ws-section-type="gallery"][data-variant="rail"] .ph{border-radius:12px}',
    '@media (max-width:700px){[data-ws-section-type="gallery"][data-variant="rail"] .bpv-gal-rail{grid-template-columns:1fr}}',
  ].join('\n'),
  /* faq — cards */
  [
    '[data-ws-section-type="faq"][data-variant="cards"] .bpv-faq-cards{display:grid;grid-template-columns:1fr 1fr;gap:16px;text-align:left}',
    '[data-ws-section-type="faq"][data-variant="cards"] .bpv-faq-card{border:1px solid rgba(0,0,0,.1);border-radius:12px;padding:22px;background:var(--ws-bg)}',
    '[data-ws-section-type="faq"][data-variant="cards"] .bpv-faq-card h3{margin-bottom:8px}',
    '@media (max-width:700px){[data-ws-section-type="faq"][data-variant="cards"] .bpv-faq-cards{grid-template-columns:1fr}}',
  ].join('\n'),
  /* faq — split */
  [
    '[data-ws-section-type="faq"][data-variant="split"] .bpv-faq-split{display:grid;grid-template-columns:35fr 65fr;gap:36px;align-items:start;text-align:left}',
    '[data-ws-section-type="faq"][data-variant="split"] .bpv-faq-head{position:sticky;top:24px}',
    '@media (max-width:700px){[data-ws-section-type="faq"][data-variant="split"] .bpv-faq-split{grid-template-columns:1fr}[data-ws-section-type="faq"][data-variant="split"] .bpv-faq-head{position:static}}',
  ].join('\n'),
  /* faq — editorial */
  [
    '[data-ws-section-type="faq"][data-variant="editorial"] .bpv-faq-row{display:grid;grid-template-columns:35fr 65fr;gap:28px;padding:20px 16px;border-bottom:1px solid rgba(0,0,0,.12);text-align:left}',
    '@media (max-width:700px){[data-ws-section-type="faq"][data-variant="editorial"] .bpv-faq-row{grid-template-columns:1fr;gap:8px}}',
  ].join('\n'),
  /* cta — row */
  [
    '[data-ws-section-type="cta"][data-variant="row"] .bpv-cta-row{display:flex;align-items:center;gap:28px;text-align:left}',
    '[data-ws-section-type="cta"][data-variant="row"] .bpv-cta-copy{flex:1}',
    '[data-ws-section-type="cta"][data-variant="row"] .bpv-cta-action{flex:0 0 auto}',
    '@media (max-width:700px){[data-ws-section-type="cta"][data-variant="row"] .bpv-cta-row{flex-direction:column;text-align:center}}',
  ].join('\n'),
  /* cta — plain */
  ['[data-ws-section-type="cta"][data-variant="plain"] .bpv-cta-plain{text-align:center;max-width:720px;margin:0 auto}'].join('\n'),
  /* cta — recap */
  [
    '[data-ws-section-type="cta"][data-variant="recap"] .bpv-cta-recap{display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:start;text-align:left}',
    '@media (max-width:700px){[data-ws-section-type="cta"][data-variant="recap"] .bpv-cta-recap{grid-template-columns:1fr}}',
  ].join('\n'),
];

function variantCss() {
  return [PRIMITIVES_CSS, ...VARIANT_CSS_BLOCKS].filter(Boolean).join('\n');
}

module.exports = {
  STANDARD,
  REGISTRY,
  variantCss,
  CHROME_TYPES,
  entriesFor,
  idsFor,
  getEntry,
  isRegisteredType,
  isValidVariant,
  variantOf,
  hasStoredVariant,
  typesWithVariants,
  registrySummary,
  variantSelectionsForPages,
  variantPairSet,
};
