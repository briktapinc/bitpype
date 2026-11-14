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

const REGISTRY = [
  standardEntry(
    'hero',
    'Classic centred',
    'Centred headline stack over a gradient or full-bleed background image, with up to two call-to-action buttons and an optional rating badge. A side photo replaces the background treatment when no background image is set.',
    'A single clear offer with a strong headline; the safe default for most homepages.',
    'When the page needs the product or person visible beside the words rather than behind them — use a split composition instead.',
    { maxTitleChars: 90, maxBodyChars: 240 }
  ),
  standardEntry(
    'text_image',
    'Classic side-by-side',
    'Two-column row: text (heading, lede, optional button) beside a photo, image on the right by default or flipped left. The services/about workhorse.',
    'Explaining one service or one idea with a supporting photo.',
    'When there is no photo worth showing, or the copy is a long read — a text or stacked composition carries it better.',
    { maxTitleChars: 80, maxBodyChars: 600 }
  ),
  standardEntry(
    'reviews',
    'Classic review cards',
    'Equal card grid: star row, quote, reviewer name. Every review gets the same weight.',
    'A set of comparable short reviews where no single voice should dominate.',
    'When one review is the story (a spotlight composition serves it better), or reviews are long-form.',
    { maxItems: 12, maxBodyChars: 400 }
  ),
  standardEntry(
    'gallery',
    'Classic uniform grid',
    'Uniform three-column grid of photos with captions, up to six images, 4:3 crops.',
    'A tidy portfolio set where every image matters equally.',
    'When one image is the hero piece (a mosaic gives it the weight), or the set is a story better told as a strip.',
    { maxItems: 6 }
  ),
  standardEntry(
    'faq',
    'Classic stacked questions',
    'Full-width stacked disclosure rows, one question per row, answers expand in place.',
    'Short-to-medium FAQ lists (up to about eight questions) read top to bottom.',
    'Long FAQ lists scan better in two columns; very short lists may not need card chrome at all.',
    { maxItems: 20, maxBodyChars: 800 }
  ),
  standardEntry(
    'cta',
    'Classic centred band',
    'Centred call-to-action band card: headline, optional line of text, one button, on the secondary colour.',
    'A single decisive next step at the end of a page.',
    'When the CTA should sit quietly beside running text rather than interrupting it as a band.',
    { maxTitleChars: 70, maxBodyChars: 160 }
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

/** Variant rule blocks per type, filled by the Batch 189 wave. */
const VARIANT_CSS_BLOCKS = [];

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
