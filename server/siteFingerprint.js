'use strict';

/**
 * Batch 156 — SITE FINGERPRINT (Phase 1 of the future-enhancement plan;
 * spec: website-scout/section-variants-spec.md §4a).
 * Batch 159 — the brand half reads the site's EFFECTIVE design (below).
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
 *   Brand half — the site's EFFECTIVE palette + font pairing (see the
 *     precedence below), the logo treatment (theme.logoMode + whether
 *     a logo URL is stored), and the theme tone when stored.
 *
 * EFFECTIVE BRAND — WHY (Batch 159): Batch 156 read only the legacy
 * flat theme fields (theme.primary, theme.font…). On real sites those
 * fields can be stale platform defaults stamped at creation (#1a56db
 * blue on Berks, Toofty AND Victoria) while the design that actually
 * paints lives elsewhere in the same stored model. The brand half now
 * resolves EACH aspect (palette, fonts) through the site's own design
 * sources, in this precedence order, first source that yields a value
 * wins (per slot: palette resolves primary/secondary/accent/bg/text
 * independently through the same chain; fonts resolve heading/body
 * independently):
 *
 *   1. 'tokens' — the site's declared design tokens:
 *      theme.colors {primary, secondary, accent, bg|background, text}
 *      and theme.fonts {heading, body}. These are the tokens the
 *      design/deliver + theme-bar flows write, and on every production
 *      site that carries them they agree with the site's CSS.
 *   2. 'css' — the site's own CSS, pooled from (in this order):
 *      theme.customCss; <style> blocks in theme.customHead; <style>
 *      blocks + style="" attributes in theme.partials.headerHtml /
 *      footerHtml; <style> blocks + style="" attributes in every
 *      page's html sections (content.html) and raw page html. Parts
 *      are whitespace-normalised and de-duplicated (the shared chrome
 *      CSS repeats on every page — the design is measured once, not
 *      once per page). CSS variables are collected (last definition
 *      in pooled order wins) and var() references resolved (≤5 passes)
 *      BEFORE counting, because real sites declare their palette as
 *      :root variables (--pine:#1D4633) and reference them by name.
 *   3. 'theme' — the legacy flat theme fields, exactly as Batch 156
 *      read them (theme.primary/secondary/bg/text, theme.font with
 *      theme.headingFont preferred for headings).
 *
 * CSS PALETTE ALGORITHM (deterministic; pinned by the batch159 suite):
 *   - Declarations are read from leaf CSS rules (brace-matched, so
 *     @media nesting works) plus bare style="" attribute lists.
 *   - Every hex colour (#rgb or #rrggbb, normalised to #rrggbb) in a
 *     declaration value scores ONCE per declaration, weighted by the
 *     declaration's role: foreground (color and friends) 3, mid
 *     (border/outline/fill/stroke/shadow) 2, background 1, other 1.
 *   - IDENTITY BONUS: a colour declared as `color` in a rule whose
 *     selector targets h1–h6 scores +8 — the colour a site sets its
 *     headings in is its identity colour; buttons/accents are its
 *     conversion colour, and on real CSS the accent otherwise
 *     out-counts the brand colour (Victoria: terra buttons vs pine
 *     headings/links/wordmark).
 *   - PRIMARY CANDIDACY (HSL cut-offs): saturation ≥ 0.15 AND
 *     0.05 ≤ lightness ≤ 0.80. Near-neutrals (whites, blacks, greys,
 *     paper/cream tints above l 0.80) can never be primary; when no
 *     saturated colour exists at all the CSS tier yields no palette
 *     and the chain falls through.
 *   - primary = highest score among candidates; secondary and accent
 *     = the next two distinct candidates. Ties break on the hex
 *     string, ascending, so the result never depends on scan order.
 *   - The bg slot = the most background-role-used colour with
 *     lightness ≥ 0.85; the text slot = the most foreground-used
 *     colour with lightness ≤ 0.30 (ties: total score, then hex).
 * CSS FONTS: font-family declarations in leaf rules, var()-resolved.
 *   Heading evidence: rules selecting h1 (weight 3), h2 (2), h3–h6
 *   (1); body evidence: rules selecting body/html (2) or * (1). A
 *   family must score ≥ 2 to be taken from CSS (one stray rule cannot
 *   flip a pairing). Stacks reduce to their first NON-generic family
 *   (sans-serif/serif/system-ui/… are fallbacks, not brand fonts).
 *
 * PROVENANCE: brand.paletteSource / brand.fontsSource record which
 * tier supplied the aspect's headline value ('tokens' | 'css' |
 * 'theme'; fontsSource is 'mixed' when heading and body came from
 * different tiers), and brand.source is the two combined ('mixed'
 * when they differ). The ledger can therefore be honest about how
 * confident each fingerprint is.
 *
 * DETERMINISM: the same model always produces the identical object
 * and hash — the canonical JSON (recursively key-sorted) is the hash
 * input, so stored key order in the model cannot move the fingerprint.
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
 * exact equality of the stored palette strings. Batch 159 note: the
 * comparison now runs on the EFFECTIVE palettes above — the ΔE rule
 * itself is unchanged from Batch 156.
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
  let s = String(slug == null ? '' : slug)
    .trim()
    .toLowerCase();
  s = s.replace(/^\/+/, '').replace(/\.html$/, '');
  if (s === '' || s === 'index') return 'index';
  return s;
}

/** First family of a stored font stack, unquoted + lowercased. */
function fontFamily(stack) {
  if (typeof stack !== 'string' || !stack.trim()) return null;
  const first = stack
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim()
    .toLowerCase();
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
  if (m3)
    return `#${m3[1]
      .split('')
      .map((c) => c + c)
      .join('')}`;
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

/** HSL saturation + lightness of a #rrggbb colour (candidacy cut-offs). */
function hexToHsl(hex) {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { s: 0, l };
  const d = max - min;
  return { s: l > 0.5 ? d / (2 - max - min) : d / (max + min), l };
}

/* ------------------------------------------------------------------ */
/* CSS tier — pool the site's own CSS from the stored model            */
/* ------------------------------------------------------------------ */

function styleBlocks(html) {
  const out = [];
  if (typeof html !== 'string') return out;
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let x;
  while ((x = re.exec(html))) out.push(x[1]);
  return out;
}

function styleAttrs(html) {
  const out = [];
  if (typeof html !== 'string') return out;
  const re = /style\s*=\s*"([^"]*)"|style\s*=\s*'([^']*)'/gi;
  let x;
  while ((x = re.exec(html))) out.push(x[1] !== undefined ? x[1] : x[2] || '');
  return out;
}

/** HTML carried by one section, wherever the model stores it. */
function sectionHtml(section) {
  if (!section || typeof section !== 'object') return null;
  if (typeof section.html === 'string') return section.html;
  const c = section.content;
  if (c && typeof c === 'object' && typeof c.html === 'string') return c.html;
  return null;
}

/**
 * Pool the model's CSS in precedence order (header, tier 2):
 * customCss, customHead <style>, partials, then per-page section and
 * raw-page <style> blocks + style="" attributes. Returns the pooled
 * stylesheet text plus the bare attribute declaration lists. Parts are
 * whitespace-normalised and de-duplicated so CSS repeated on every
 * page (the shared chrome) is measured once.
 */
function poolCss(theme, pages) {
  const rawParts = [];
  const rawAttrs = [];
  const pushHtml = (html) => {
    if (typeof html !== 'string' || !html) return;
    rawParts.push(...styleBlocks(html));
    rawAttrs.push(...styleAttrs(html));
  };
  if (typeof theme.customCss === 'string' && theme.customCss.trim()) rawParts.push(theme.customCss);
  pushHtml(theme.customHead);
  const partials = theme.partials && typeof theme.partials === 'object' ? theme.partials : {};
  pushHtml(partials.headerHtml);
  pushHtml(partials.footerHtml);
  for (const page of pages) {
    if (!page || typeof page !== 'object') continue;
    pushHtml(page.html);
    const sections = Array.isArray(page.sections) ? page.sections : [];
    for (const s of sections) pushHtml(sectionHtml(s));
  }
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const parts = [...new Set(rawParts.map(norm).filter(Boolean))];
  const attrs = [...new Set(rawAttrs.map(norm).filter(Boolean))];
  return { cssText: parts.join('\n'), attrDecls: attrs };
}

/** CSS variable definitions from the pooled text (last wins). */
function collectCssVars(cssText) {
  const vars = new Map();
  const re = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let x;
  while ((x = re.exec(cssText))) vars.set(x[1].toLowerCase(), x[2].trim());
  return vars;
}

/** Substitute var(--name) / var(--name, fallback) from the definitions. */
function resolveCssVars(cssText, vars) {
  let out = cssText;
  for (let pass = 0; pass < 5; pass++) {
    const next = out.replace(/var\(\s*--([a-zA-Z0-9-]+)\s*(?:,([^)]*))?\)/gi, (whole, name, fallback) => {
      const v = vars.get(String(name).toLowerCase());
      if (v !== undefined) return v;
      return fallback !== undefined ? fallback : whole;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Leaf rules of a stylesheet: [selector, body] for blocks whose body
 * holds no nested block (so @media nesting yields its inner rules). */
function leafRules(cssText) {
  const text = String(cssText).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = [];
  const stack = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      stack.push(cur.trim());
      cur = '';
    } else if (ch === '}') {
      const body = cur;
      const sel = stack.pop() || '';
      if (!body.includes('{')) out.push([sel, body]);
      cur = '';
    } else {
      cur += ch;
    }
  }
  return out;
}

/** [prop, value] pairs from a declaration body or a style="" list. */
function declarationsOf(body) {
  const out = [];
  for (const part of String(body).split(';')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (prop && value) out.push([prop, value]);
  }
  return out;
}

const FG_PROPS = new Set(['color', '-webkit-text-fill-color', 'text-decoration-color', 'caret-color']);
const BG_PROPS = new Set(['background', 'background-color', 'background-image']);
const MID_PROPS = new Set([
  'border',
  'border-color',
  'border-top',
  'border-bottom',
  'border-left',
  'border-right',
  'border-top-color',
  'border-bottom-color',
  'border-left-color',
  'border-right-color',
  'outline',
  'outline-color',
  'fill',
  'stroke',
  'box-shadow',
  'column-rule-color',
]);
const ROLE_WEIGHT = { fg: 3, mid: 2, bg: 1, other: 1 };
const HEADING_COLOUR_BONUS = 8;

function roleOfProp(prop) {
  if (FG_PROPS.has(prop)) return 'fg';
  if (BG_PROPS.has(prop)) return 'bg';
  if (MID_PROPS.has(prop)) return 'mid';
  return 'other';
}

function selectorTargetsHeading(selector) {
  return /(^|[,\s>+~])h[1-6](?=[\s.#[:>,+~]|$)/i.test(String(selector || ''));
}

/* Primary candidacy cut-offs (HSL; see header). */
const CANDIDATE_SAT_MIN = 0.15;
const CANDIDATE_L_MIN = 0.05;
const CANDIDATE_L_MAX = 0.8;
const BG_SLOT_L_MIN = 0.85;
const TEXT_SLOT_L_MAX = 0.3;

/** Unique normalised hex colours in a declaration value. */
function hexesIn(value) {
  const out = new Set();
  const re = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  let x;
  while ((x = re.exec(value))) out.add(normalizeColour(`#${x[1]}`));
  return out;
}

/** Score every hex in the resolved CSS by declaration role. */
function scoreCssColours(rules, attrDecls) {
  const scores = new Map();
  const bump = (hex, role, bonus) => {
    if (!scores.has(hex)) scores.set(hex, { score: 0, fg: 0, mid: 0, bg: 0, other: 0 });
    const e = scores.get(hex);
    e.score += ROLE_WEIGHT[role] + (bonus || 0);
    e[role] += 1;
  };
  const scanDecls = (decls, selector) => {
    const heading = selector != null && selectorTargetsHeading(selector);
    for (const [prop, value] of decls) {
      const role = roleOfProp(prop);
      const bonus = heading && prop === 'color' ? HEADING_COLOUR_BONUS : 0;
      for (const hex of hexesIn(value)) bump(hex, role, bonus);
    }
  };
  for (const [selector, body] of rules) scanDecls(declarationsOf(body), selector);
  for (const attr of attrDecls) scanDecls(declarationsOf(attr), null);
  return scores;
}

/** Palette from scored colours (header algorithm), or all-null slots. */
function paletteFromScores(scores) {
  const entries = [...scores.entries()].map(([hex, v]) => ({ hex, ...v, ...hexToHsl(hex) }));
  const byScore = (a, b) => b.score - a.score || (a.hex < b.hex ? -1 : 1);
  const candidates = entries
    .filter((e) => e.s >= CANDIDATE_SAT_MIN && e.l >= CANDIDATE_L_MIN && e.l <= CANDIDATE_L_MAX)
    .sort(byScore);
  const bgPool = entries
    .filter((e) => e.bg > 0 && e.l >= BG_SLOT_L_MIN)
    .sort((a, b) => b.bg - a.bg || b.score - a.score || (a.hex < b.hex ? -1 : 1));
  const textPool = entries
    .filter((e) => e.fg > 0 && e.l <= TEXT_SLOT_L_MAX)
    .sort((a, b) => b.fg - a.fg || b.score - a.score || (a.hex < b.hex ? -1 : 1));
  return {
    primary: candidates[0] ? candidates[0].hex : null,
    secondary: candidates[1] ? candidates[1].hex : null,
    accent: candidates[2] ? candidates[2].hex : null,
    bg: bgPool[0] ? bgPool[0].hex : null,
    text: textPool[0] ? textPool[0].hex : null,
  };
}

const GENERIC_FAMILIES = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  '-apple-system',
  'blinkmacsystemfont',
  'inherit',
  'initial',
  'unset',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
]);

/** First NON-generic family of a font stack (the brand font, if any). */
function brandFamily(stack) {
  if (typeof stack !== 'string' || !stack.trim()) return null;
  for (const part of stack.split(',')) {
    const fam = part
      .trim()
      .replace(/\s*!important$/, '')
      .replace(/^["']|["']$/g, '')
      .trim()
      .toLowerCase();
    if (fam && !GENERIC_FAMILIES.has(fam)) return fam;
  }
  return null;
}

const CSS_FONT_MIN_SCORE = 2;

function headingWeight(selector) {
  const sel = String(selector || '').toLowerCase();
  if (/(^|[,\s>+~])h1(?=[\s.#[:>,+~]|$)/.test(sel)) return 3;
  if (/(^|[,\s>+~])h2(?=[\s.#[:>,+~]|$)/.test(sel)) return 2;
  if (/(^|[,\s>+~])h[3-6](?=[\s.#[:>,+~]|$)/.test(sel)) return 1;
  return 0;
}

function bodyWeight(selector) {
  const sel = String(selector || '')
    .trim()
    .toLowerCase();
  if (/(^|[,\s>+~])(body|html)(?=[\s.#[:>,+~]|$)/.test(sel)) return 2;
  if (sel === '*') return 1;
  return 0;
}

/** Font pairing from leaf rules (header algorithm). */
function fontsFromRules(rules) {
  const headingScores = new Map();
  const bodyScores = new Map();
  const bump = (map, fam, w) => map.set(fam, (map.get(fam) || 0) + w);
  for (const [selector, body] of rules) {
    let stack = null;
    for (const [prop, value] of declarationsOf(body)) {
      if (prop === 'font-family') stack = value; // last declaration wins
    }
    if (stack == null) continue;
    const fam = brandFamily(stack);
    if (!fam) continue;
    const hw = headingWeight(selector);
    if (hw) bump(headingScores, fam, hw);
    const bw = bodyWeight(selector);
    if (bw) bump(bodyScores, fam, bw);
  }
  const winner = (map) => {
    const ranked = [...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return ranked.length && ranked[0][1] >= CSS_FONT_MIN_SCORE ? ranked[0][0] : null;
  };
  return { heading: winner(headingScores), body: winner(bodyScores) };
}

/** The CSS tier's palette + fonts for a model, or null slots. */
function cssTier(theme, pages) {
  const { cssText, attrDecls } = poolCss(theme, pages);
  if (!cssText && !attrDecls.length) {
    return {
      palette: { primary: null, secondary: null, accent: null, bg: null, text: null },
      fonts: { heading: null, body: null },
    };
  }
  const resolved = resolveCssVars(cssText, collectCssVars(cssText));
  const rules = leafRules(resolved);
  return { palette: paletteFromScores(scoreCssColours(rules, attrDecls)), fonts: fontsFromRules(rules) };
}

/* ------------------------------------------------------------------ */
/* brand derivation — the three tiers, per-slot resolution             */
/* ------------------------------------------------------------------ */

/** Tier 1 ('tokens'): the declared design tokens, when present. */
function tokensTier(theme) {
  const colors = theme.colors && typeof theme.colors === 'object' ? theme.colors : {};
  const fonts = theme.fonts && typeof theme.fonts === 'object' ? theme.fonts : {};
  return {
    palette: {
      primary: normalizeColour(typeof colors.primary === 'string' ? colors.primary : null),
      secondary: normalizeColour(typeof colors.secondary === 'string' ? colors.secondary : null),
      accent: normalizeColour(typeof colors.accent === 'string' ? colors.accent : null),
      bg: normalizeColour(
        typeof colors.bg === 'string' ? colors.bg : typeof colors.background === 'string' ? colors.background : null
      ),
      text: normalizeColour(typeof colors.text === 'string' ? colors.text : null),
    },
    fonts: {
      heading: fontFamily(typeof fonts.heading === 'string' ? fonts.heading : null),
      body: fontFamily(typeof fonts.body === 'string' ? fonts.body : null),
    },
  };
}

/** Tier 3 ('theme'): the legacy flat fields, exactly as Batch 156. */
function flatTier(theme) {
  const headingStack =
    typeof theme.headingFont === 'string' && theme.headingFont.trim() ? theme.headingFont : theme.font;
  return {
    palette: {
      primary: normalizeColour(theme.primary),
      secondary: normalizeColour(theme.secondary),
      accent: null,
      bg: normalizeColour(theme.bg),
      text: normalizeColour(theme.text),
    },
    fonts: { heading: fontFamily(headingStack), body: fontFamily(theme.font) },
  };
}

/** First non-null slot value across tiers, with its tier name. */
function resolveSlot(tiers, aspect, slot) {
  for (const [name, tier] of tiers) {
    const v = tier[aspect][slot];
    if (v != null) return { value: v, source: name };
  }
  return { value: null, source: null };
}

/**
 * deriveBrand(theme, pages) — the EFFECTIVE brand half.
 * Returns the palette, the font pairing, and the provenance labels.
 */
function deriveBrand(theme, pages) {
  const tiers = [
    ['tokens', tokensTier(theme)],
    ['css', cssTier(theme, pages)],
    ['theme', flatTier(theme)],
  ];

  const palette = {};
  const paletteSlotSources = {};
  for (const slot of ['primary', 'secondary', 'accent', 'bg', 'text']) {
    const r = resolveSlot(tiers, 'palette', slot);
    palette[slot] = r.value;
    paletteSlotSources[slot] = r.source;
  }
  const paletteSource = paletteSlotSources.primary || 'theme';

  const heading = resolveSlot(tiers, 'fonts', 'heading');
  const body = resolveSlot(tiers, 'fonts', 'body');
  const fonts = { heading: heading.value, body: body.value };
  let fontsSource;
  if (heading.source && body.source && heading.source !== body.source) fontsSource = 'mixed';
  else fontsSource = heading.source || body.source || 'theme';

  const source = paletteSource === fontsSource ? paletteSource : 'mixed';

  return {
    fonts,
    palette,
    logo: {
      mode: theme.logoMode === 'image' ? 'image' : 'text',
      hasUrl: !!(typeof theme.logoUrl === 'string' && theme.logoUrl.trim()),
    },
    tone: typeof theme.tone === 'string' && theme.tone.trim() ? theme.tone.trim().toLowerCase() : null,
    paletteSource,
    fontsSource,
    source,
  };
}

/* ------------------------------------------------------------------ */
/* fingerprint computation                                             */
/* ------------------------------------------------------------------ */

function sectionTypes(page) {
  const sections = page && Array.isArray(page.sections) ? page.sections : [];
  return sections
    .map((s) => {
      const t = String((s && s.type) || '');
      if (!t) return '';
      // Batch 188 — the §4a layout fingerprint is the ordered set of
      // (type → variant): a section carrying a non-standard variant
      // contributes "type@variant". Variant-free sections contribute
      // the bare type, so every existing site's layout hash is
      // unchanged until someone actually picks a variant.
      const v =
        s && typeof s.variant === 'string' && s.variant.trim() && s.variant.trim() !== 'standard'
          ? s.variant.trim()
          : '';
      // Batch 199 — a section carrying a script contributes a "+js"
      // suffix ("+3d" when it declares the WebGL library), so a
      // scripted section never fingerprints as identical to its
      // static twin. Script-free sections are unchanged, so every
      // existing site's layout hash stands until a script is added.
      const jsSuffix =
        s && typeof s.js === 'string' && s.js.trim()
          ? Array.isArray(s.libs) && s.libs.includes('three')
            ? '+3d'
            : '+js'
          : '';
      return (v ? `${t}@${v}` : t) + jsSuffix;
    })
    .filter((t) => t && !CHROME_TYPES.has(t.split('@')[0].split('+')[0]));
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

  const brand = deriveBrand(theme, pagesIn);

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
 * compareFingerprints(a, b) — the spec §4a double-match rule, run on
 * the EFFECTIVE brands (Batch 159). Returns the verdict plus the
 * evidence for each half.
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
  // Batch 159: exported for the regression suite.
  deriveBrand,
  cssTier,
  poolCss,
  resolveCssVars,
  collectCssVars,
};
