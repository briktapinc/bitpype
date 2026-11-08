'use strict';

/**
 * Batch 156 — SITE FINGERPRINT (Phase 1 of the future-enhancement plan;
 * spec: website-scout/section-variants-spec.md §4a).
 *
 * Every site has a fingerprint, in two halves, computed from the site's
 * STORED model (websites.theme + websites.pages) — never from rendered
 * output, and this module never touches a render path:
 *
 *   Layout half — per page, the ordered content-section types (the
 *     platform chrome types nav/footer are EXCLUDED: they are identical
 *     on every page of every site by construction, so they carry no
 *     design signal); the homepage's sequence is the primary signal.
 *     Plus the nav pattern (the set of nav-visible page slugs) and a
 *     hero-composition signal read from the homepage hero section's
 *     stored content shape (background image? primary CTA? secondary
 *     CTA? alignment when the model stores one).
 *   Brand half — the theme's font pairing (heading + body, reduced to
 *     the first family of each stored stack), the primary palette
 *     (primary/secondary/bg/text as stored, normalised to #rrggbb when
 *     they parse as hex), the logo treatment (theme.logoMode + whether
 *     a logo URL is stored), and the theme tone when stored.
 *
 * DETERMINISM: the same model always produces the identical object and
 * hash — the canonical JSON (recursively key-sorted) is the hash input,
 * so stored key order in the model cannot move the fingerprint.
 *
 * SIMILARITY (report mode only — the blocking QA gate is Phase 4):
 * two sites DOUBLE-MATCH only when BOTH halves collide:
 *   layout matches  = identical homepage content-section sequence AND
 *                     identical page-slug set;
 *   brand is close  = identical font pairing (heading AND body family)
 *                     AND palette distance under threshold.
 * Palette distance is CIE76 ΔE (Euclidean distance in CIELAB) on the
 * primary colour — ΔE ≈ 2.3 is the just-noticeable difference, so the
 * primary threshold of 10 already means "visibly the same colour,
 * shade neighbours at most"; the secondary colour, when both sites
 * store a parseable one, must be within 15. When a primary colour does
 * not parse as hex on either side, palette closeness falls back to
 * exact equality of the stored palette strings.
 *
 * Pairs inside one workspace are the same client's own sites: they are
 * reported separately as same-client and NEVER flagged.
 */

const crypto = require('node:crypto');

const FINGERPRINT_VERSION = 1;

/* Palette closeness thresholds (CIE76 ΔE; see header). */
const PALETTE_PRIMARY_MAX_DELTA_E = 10;
const PALETTE_SECONDARY_MAX_DELTA_E = 15;

/* Section types that are platform chrome, present by construction. */
const CHROME_TYPES = new Set(['nav', 'footer']);

/* ------------------------------------------------------------------ */
/* small pure helpers                                                  */
/* ------------------------------------------------------------------ */

/** Recursively key-sorted JSON — the canonical hash input. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function hashOf(value, chars) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, chars);
}

/** Page slugs in the stored model are extensionless, sometimes with a
 * leading slash on older rows: '/', '/index' and 'index' are one page. */
function normalizeSlug(slug) {
  let s = String(slug == null ? '' : slug).trim().toLowerCase();
  s = s.replace(/^\/+/, '').replace(/\.html$/, '');
  if (s === '' || s === 'index') return 'index';
  return s;
}

/** First family of a stored font stack, unquoted + lowercased. */
function fontFamily(stack) {
  if (typeof stack !== 'string' || !stack.trim()) return null;
  const first = stack.split(',')[0].trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
  return first || null;
}

/** Normalise a stored colour to #rrggbb when it parses as hex, else
 * keep the trimmed lowercase string (distance then falls back to
 * exact-equality, per the header). */
function normalizeColour(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^#?([0-9a-f]{6})$/);
  if (m) return `#${m[1]}`;
  const m3 = s.match(/^#?([0-9a-f]{3})$/);
  if (m3) return `#${m3[1].split('').map((c) => c + c).join('')}`;
  return s;
}

function isHexColour(v) {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v);
}

/* ------------------------------------------------------------------ */
/* colour distance — CIE76 ΔE over CIELAB                              */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgbToLab(r, g, b) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  // sRGB D65
  let x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  let y = (lr * 0.2126 + lg * 0.7152 + lb * 0.0722) / 1.0;
  let z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 ΔE between two #rrggbb colours; null when either is not hex. */
function colourDistance(a, b) {
  if (!isHexColour(a) || !isHexColour(b)) return null;
  const [l1, a1, b1] = rgbToLab(...hexToRgb(a));
  const [l2, a2, b2] = rgbToLab(...hexToRgb(b));
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/* ------------------------------------------------------------------ */
/* fingerprint computation                                             */
/* ------------------------------------------------------------------ */

function sectionTypes(page) {
  const sections = page && Array.isArray(page.sections) ? page.sections : [];
  return sections.map((s) => String((s && s.type) || '')).filter((t) => t && !CHROME_TYPES.has(t));
}

function heroSignal(homePage) {
  const sections = homePage && Array.isArray(homePage.sections) ? homePage.sections : [];
  const hero = sections.find((s) => s && s.type === 'hero');
  if (!hero) return { present: false, backgroundImage: false, cta: false, secondaryCta: false, align: null };
  const c = hero.content && typeof hero.content === 'object' ? hero.content : {};
  const imageField = c.backgroundImage || c.background_image || null;
  const imgObj = c.image && typeof c.image === 'object' ? c.image.url || c.image.src || null : null;
  return {
    present: true,
    backgroundImage: !!(imageField || imgObj || (typeof c.image === 'string' && c.image)),
    cta: !!(c.cta_text || c.cta_href || c.button_text || c.button_href),
    secondaryCta: !!(c.cta_secondary_text || c.cta_secondary_href),
    align: c.align || c.alignment || c.text_align || c.textAlign || null,
  };
}

/**
 * computeFingerprint({ theme, pages }) — theme/pages are the PARSED
 * stored model (objects, as domain.siteRow returns them). Pure.
 */
function computeFingerprint(model) {
  const theme = model && model.theme && typeof model.theme === 'object' ? model.theme : {};
  const pagesIn = model && Array.isArray(model.pages) ? model.pages : [];

  const pages = pagesIn.map((p) => ({
    slug: normalizeSlug(p && p.slug),
    sections: sectionTypes(p || {}),
    navVisible: !p || (p.navVisible !== false && p.hiddenInNav !== true && p.hidden_in_nav !== true),
  }));
  const homePage = pagesIn.find((p) => normalizeSlug(p && p.slug) === 'index') || pagesIn[0] || null;
  const home = pages.find((pg) => pg.slug === 'index') || pages[0] || { slug: 'index', sections: [] };

  const layout = {
    homeSlug: home.slug,
    homeSections: home.sections,
    pages: pages.map((p) => ({ slug: p.slug, sections: p.sections })),
    pageSlugs: [...new Set(pages.map((p) => p.slug))].sort(),
    navSlugs: [...new Set(pages.filter((p) => p.navVisible).map((p) => p.slug))].sort(),
    hero: heroSignal(homePage),
  };

  const headingStack = typeof theme.headingFont === 'string' && theme.headingFont.trim() ? theme.headingFont : theme.font;
  const brand = {
    fonts: { heading: fontFamily(headingStack), body: fontFamily(theme.font) },
    palette: {
      primary: normalizeColour(theme.primary),
      secondary: normalizeColour(theme.secondary),
      bg: normalizeColour(theme.bg),
      text: normalizeColour(theme.text),
    },
    logo: {
      mode: theme.logoMode === 'image' ? 'image' : 'text',
      hasUrl: !!(typeof theme.logoUrl === 'string' && theme.logoUrl.trim()),
    },
    tone: typeof theme.tone === 'string' && theme.tone.trim() ? theme.tone.trim().toLowerCase() : null,
  };

  const hash = hashOf({ layout, brand }, 16);
  const layoutHash = hashOf(layout, 12);
  const brandHash = hashOf(brand, 12);
  const summary = [
    `${brand.fonts.heading || '—'} + ${brand.fonts.body || '—'}`,
    brand.palette.primary || '—',
    `home: ${layout.homeSections.join('>') || '—'}`,
    `${layout.pageSlugs.length} page${layout.pageSlugs.length === 1 ? '' : 's'}`,
  ].join(' · ');

  return { version: FINGERPRINT_VERSION, layout, brand, hash, layoutHash, brandHash, summary };
}

/* ------------------------------------------------------------------ */
/* similarity                                                          */
/* ------------------------------------------------------------------ */

function sameSequence(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function sameSet(a, b) {
  return a.length === b.length && a.every((v) => b.includes(v));
}
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

/**
 * compareFingerprints(a, b) — the spec §4a double-match rule.
 * Returns the verdict plus the evidence for each half.
 */
function compareFingerprints(a, b) {
  const homeSectionsEqual = sameSequence(a.layout.homeSections, b.layout.homeSections);
  const pageSlugsEqual = sameSet(a.layout.pageSlugs, b.layout.pageSlugs);
  const layoutMatch = homeSectionsEqual && pageSlugsEqual;

  const fontsEqual =
    a.brand.fonts.heading != null &&
    b.brand.fonts.heading != null &&
    a.brand.fonts.heading === b.brand.fonts.heading &&
    a.brand.fonts.body === b.brand.fonts.body;

  const primaryDeltaE = colourDistance(a.brand.palette.primary, b.brand.palette.primary);
  const secondaryDeltaE = colourDistance(a.brand.palette.secondary, b.brand.palette.secondary);
  let paletteClose;
  if (primaryDeltaE != null) {
    paletteClose =
      primaryDeltaE <= PALETTE_PRIMARY_MAX_DELTA_E &&
      (secondaryDeltaE == null || secondaryDeltaE <= PALETTE_SECONDARY_MAX_DELTA_E);
  } else {
    // Non-hex stored palette: closeness is exact string equality.
    paletteClose = a.brand.palette.primary != null && a.brand.palette.primary === b.brand.palette.primary;
  }
  const brandClose = fontsEqual && paletteClose;

  return {
    layoutMatch,
    brandClose,
    doubleMatch: layoutMatch && brandClose,
    evidence: {
      homeSectionsEqual,
      pageSlugsEqual,
      fontsEqual,
      primaryDeltaE: round2(primaryDeltaE),
      secondaryDeltaE: round2(secondaryDeltaE),
      paletteClose,
    },
  };
}

/**
 * similarityReport(entries) — entries: [{ workspaceId, websiteId, name,
 * fingerprint }]. Cross-workspace double-matches are FLAGGED; pairs in
 * one workspace are the same client's own sites, listed separately and
 * never flagged. Clone families are a Phase 5 concept — no lineage
 * exists in the model yet, so v1 has no family exemption to apply.
 */
function similarityReport(entries) {
  const sorted = [...entries].sort(
    (x, y) => Number(x.workspaceId) - Number(y.workspaceId) || Number(x.websiteId) - Number(y.websiteId)
  );
  const flagged = [];
  const sameClient = [];
  let pairsChecked = 0;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      pairsChecked++;
      const cmp = compareFingerprints(sorted[i].fingerprint, sorted[j].fingerprint);
      if (!cmp.doubleMatch) continue;
      const pair = {
        a: { workspaceId: sorted[i].workspaceId, websiteId: sorted[i].websiteId, name: sorted[i].name },
        b: { workspaceId: sorted[j].workspaceId, websiteId: sorted[j].websiteId, name: sorted[j].name },
        evidence: cmp.evidence,
      };
      if (Number(sorted[i].workspaceId) === Number(sorted[j].workspaceId)) sameClient.push(pair);
      else flagged.push(pair);
    }
  }
  return { flagged, sameClient, counts: { sites: sorted.length, pairsChecked } };
}

module.exports = {
  FINGERPRINT_VERSION,
  PALETTE_PRIMARY_MAX_DELTA_E,
  PALETTE_SECONDARY_MAX_DELTA_E,
  computeFingerprint,
  compareFingerprints,
  similarityReport,
  colourDistance,
  canonicalJson,
  normalizeSlug,
  fontFamily,
  normalizeColour,
};
