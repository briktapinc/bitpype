// @ts-check
'use strict';

/**
 * Batch 117 — WordPress design editing v1: the SHARED op vocabulary.
 *
 * The design chat may only ever speak in these structured ops, on
 * BOTH sides of the wire: the platform validates + compiles them
 * here, and the plugin (integrations/wordpress/.../design.php)
 * mirrors the same vocabulary and refuses anything outside it.
 * There is deliberately NO op for raw CSS, theme files, other
 * plugins, or page content — v1 edits exactly two layers:
 *
 *   Layer 1 — GLOBAL LOOK: named design tokens (colors / fonts /
 *             scales) compiled into a plugin-owned CSS layer.
 *   Layer 2 — BITPYPE ZONES: banner / hero / CTA sections the
 *             plugin itself renders, with structured fields only.
 *
 * The token → CSS compilation is deterministic: the same token
 * state always compiles to the same bytes, on the platform and in
 * the plugin, so a preview, an apply and an undo can be compared
 * byte-for-byte.
 */

const COLOR_TOKENS = [
  'primary_color',
  'secondary_color',
  'accent_color',
  'background_color',
  'surface_color',
  'text_color',
  'muted_text_color',
  'link_color',
  'button_background',
  'button_text_color',
  'header_background',
  'footer_background',
];

// Font keys → CSS font-family stacks. Keys in GOOGLE_FONTS are
// additionally loaded from Google Fonts by the plugin.
const FONT_STACKS = {
  system_sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  system_serif: "Georgia, 'Times New Roman', serif",
  georgia: "Georgia, 'Times New Roman', serif",
  arial: 'Arial, Helvetica, sans-serif',
  helvetica: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  verdana: 'Verdana, Geneva, sans-serif',
  trebuchet: "'Trebuchet MS', 'Lucida Grande', sans-serif",
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
  inter: "'Inter', sans-serif",
  roboto: "'Roboto', sans-serif",
  open_sans: "'Open Sans', sans-serif",
  lato: "'Lato', sans-serif",
  montserrat: "'Montserrat', sans-serif",
  poppins: "'Poppins', sans-serif",
  nunito: "'Nunito', sans-serif",
  merriweather: "'Merriweather', serif",
  playfair: "'Playfair Display', serif",
  source_sans: "'Source Sans 3', sans-serif",
};
const GOOGLE_FONTS = {
  inter: 'Inter',
  roboto: 'Roboto',
  open_sans: 'Open Sans',
  lato: 'Lato',
  montserrat: 'Montserrat',
  poppins: 'Poppins',
  nunito: 'Nunito',
  merriweather: 'Merriweather',
  playfair: 'Playfair Display',
  source_sans: 'Source Sans 3',
};
const FONT_TOKENS = ['heading_font', 'body_font'];

// Integer scale tokens with hard ranges.
const SCALE_TOKENS = {
  base_font_size: { min: 14, max: 20, unit: 'px' },
  border_radius: { min: 0, max: 24, unit: 'px' },
};

const ZONE_TYPES = ['banner', 'hero', 'cta'];
const ZONE_ACCENTS = ['primary', 'dark', 'light'];
const ZONE_ALIGNS = ['left', 'center'];
const ZONE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

const TOKEN_SET = new Set([...COLOR_TOKENS, ...FONT_TOKENS, ...Object.keys(SCALE_TOKENS)]);

function fail(code, message) {
  const e = /** @type {Error & { code?: string }} */ (new Error(message));
  e.code = code;
  return e;
}

/** Normalize a hex color to lowercase #rrggbb, or null when invalid. */
function normalizeColor(value) {
  const s = String(value == null ? '' : value)
    .trim()
    .toLowerCase();
  const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3)
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  return `#${hex}`;
}

/** Validate one token value; returns the normalized value or throws. */
function validateTokenValue(token, value) {
  if (COLOR_TOKENS.includes(token)) {
    const c = normalizeColor(value);
    if (!c) throw fail('INVALID_OP', `Token ${token} needs a hex color like #1a7f64`);
    return c;
  }
  if (FONT_TOKENS.includes(token)) {
    const key = String(value == null ? '' : value).trim();
    if (!Object.prototype.hasOwnProperty.call(FONT_STACKS, key)) {
      throw fail('INVALID_OP', `Token ${token} needs one of: ${Object.keys(FONT_STACKS).join(', ')}`);
    }
    return key;
  }
  if (Object.prototype.hasOwnProperty.call(SCALE_TOKENS, token)) {
    const spec = SCALE_TOKENS[token];
    const num = Number(value);
    if (!Number.isInteger(num) || num < spec.min || num > spec.max) {
      throw fail('INVALID_OP', `Token ${token} needs a whole number between ${spec.min} and ${spec.max}`);
    }
    return num;
  }
  throw fail('INVALID_OP', `Unknown design token: ${String(token).slice(0, 40)}`);
}

function cleanZoneText(value, max, label) {
  const s = String(value == null ? '' : value)
    .replace(/[<>{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  if (!s && label) throw fail('INVALID_OP', `Zone field ${label} is required`);
  return s;
}

function validateZoneFields(fields, { partial = false } = {}) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(f, k);
  if (!partial || has('headline')) out.headline = cleanZoneText(f.headline, 120, partial ? '' : 'headline');
  if (has('subtext') || !partial) out.subtext = cleanZoneText(f.subtext, 300, '');
  if (has('button_text') || !partial) out.button_text = cleanZoneText(f.button_text, 40, '');
  if (has('button_url') || !partial) {
    const url = String(f.button_url == null ? '' : f.button_url)
      .trim()
      .slice(0, 500);
    if (url) {
      let u = null;
      try {
        u = new URL(url);
      } catch {
        u = null;
      }
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || /[<>"'\s]/.test(url)) {
        throw fail('INVALID_OP', 'Zone button_url must be a valid http(s) URL');
      }
      out.button_url = url;
    } else {
      out.button_url = '';
    }
  }
  if (has('accent') || !partial) {
    const accent = String(f.accent == null ? 'primary' : f.accent).trim();
    if (!ZONE_ACCENTS.includes(accent))
      throw fail('INVALID_OP', `Zone accent must be one of: ${ZONE_ACCENTS.join(', ')}`);
    out.accent = accent;
  }
  if (has('align') || !partial) {
    const align = String(f.align == null ? 'center' : f.align).trim();
    if (!ZONE_ALIGNS.includes(align)) throw fail('INVALID_OP', `Zone align must be one of: ${ZONE_ALIGNS.join(', ')}`);
    out.align = align;
  }
  for (const key of Object.keys(f)) {
    if (!['headline', 'subtext', 'button_text', 'button_url', 'accent', 'align'].includes(key)) {
      throw fail('INVALID_OP', `Unknown zone field: ${String(key).slice(0, 40)}`);
    }
  }
  return out;
}

/**
 * Apply a list of ops to (tokens, zones) and return the resulting
 * state. ANY op outside the vocabulary throws INVALID_OP — callers
 * that must be lenient (the chat path, which drops model-invented
 * ops with disclosure) catch per-op via validateOpsLenient.
 */
function applyOps(tokensIn, zonesIn, ops) {
  if (!Array.isArray(ops) || !ops.length) throw fail('INVALID_OP', 'A proposal needs at least one change');
  if (ops.length > 24) throw fail('INVALID_OP', 'A proposal may contain at most 24 changes');
  const tokens = { ...(tokensIn && typeof tokensIn === 'object' ? tokensIn : {}) };
  const zones = {};
  for (const [id, z] of Object.entries(zonesIn && typeof zonesIn === 'object' ? zonesIn : {})) {
    zones[id] = { ...z, fields: { ...(z && z.fields ? z.fields : {}) } };
  }
  for (const op of ops) {
    if (!op || typeof op !== 'object') throw fail('INVALID_OP', 'Every change must be an object');
    if (op.type === 'set_token') {
      if (!TOKEN_SET.has(String(op.token || ''))) {
        throw fail('INVALID_OP', `Unknown design token: ${String(op.token || '').slice(0, 40)}`);
      }
      tokens[String(op.token)] = validateTokenValue(String(op.token), op.value);
    } else if (op.type === 'remove_token') {
      if (!TOKEN_SET.has(String(op.token || ''))) {
        throw fail('INVALID_OP', `Unknown design token: ${String(op.token || '').slice(0, 40)}`);
      }
      delete tokens[String(op.token)];
    } else if (op.type === 'zone_create') {
      const zone = op.zone && typeof op.zone === 'object' ? op.zone : {};
      const id = String(zone.id || '').trim();
      if (!ZONE_ID_RE.test(id)) throw fail('INVALID_OP', 'Zone id must be a short slug (letters, numbers, dashes)');
      if (zones[id]) throw fail('INVALID_OP', `Zone ${id} already exists`);
      if (!ZONE_TYPES.includes(String(zone.type || ''))) {
        throw fail('INVALID_OP', `Zone type must be one of: ${ZONE_TYPES.join(', ')}`);
      }
      zones[id] = { type: String(zone.type), fields: validateZoneFields(zone.fields) };
    } else if (op.type === 'zone_update') {
      const id = String(op.zoneId || '').trim();
      if (!zones[id]) throw fail('INVALID_OP', `Zone ${id || '?'} does not exist`);
      zones[id] = {
        type: zones[id].type,
        fields: { ...zones[id].fields, ...validateZoneFields(op.fields, { partial: true }) },
      };
    } else if (op.type === 'zone_remove') {
      const id = String(op.zoneId || '').trim();
      if (!zones[id]) throw fail('INVALID_OP', `Zone ${id || '?'} does not exist`);
      delete zones[id];
    } else {
      throw fail('INVALID_OP', `Unknown change type: ${String(op.type || '').slice(0, 40)}`);
    }
  }
  return { tokens, zones };
}

/**
 * Lenient variant for the chat path: valid ops apply, invalid ops
 * are collected with their reasons so the reply can disclose what
 * was dropped instead of silently staging something else.
 */
function applyOpsLenient(tokensIn, zonesIn, ops) {
  const applied = [];
  const dropped = [];
  let state = {
    tokens: { ...(tokensIn && typeof tokensIn === 'object' ? tokensIn : {}) },
    zones: JSON.parse(JSON.stringify(zonesIn && typeof zonesIn === 'object' ? zonesIn : {})),
  };
  for (const op of Array.isArray(ops) ? ops : []) {
    try {
      state = applyOps(state.tokens, state.zones, [op]);
      applied.push(op);
    } catch (e) {
      dropped.push({ op, reason: e.message || 'invalid' });
    }
  }
  return { tokens: state.tokens, zones: state.zones, applied, dropped };
}

/**
 * Compile a token state into the Layer 1 CSS layer. Deterministic:
 * fixed token order, fixed rule order, normalized values only.
 * Values reaching this function are already validated, so the
 * output needs no escaping beyond its construction.
 */
function compileCss(tokensIn) {
  const t = tokensIn && typeof tokensIn === 'object' ? tokensIn : {};
  const vars = [];
  const rules = [];
  const colorVar = {
    primary_color: '--bp-primary',
    secondary_color: '--bp-secondary',
    accent_color: '--bp-accent',
    background_color: '--bp-bg',
    surface_color: '--bp-surface',
    text_color: '--bp-text',
    muted_text_color: '--bp-muted',
    link_color: '--bp-link',
    button_background: '--bp-btn-bg',
    button_text_color: '--bp-btn-text',
    header_background: '--bp-header-bg',
    footer_background: '--bp-footer-bg',
  };
  for (const token of COLOR_TOKENS) {
    if (t[token]) vars.push(`${colorVar[token]}:${t[token]};`);
  }
  if (t.base_font_size) vars.push(`--bp-font-size:${Number(t.base_font_size)}px;`);
  if (t.border_radius != null && t.border_radius !== '') vars.push(`--bp-radius:${Number(t.border_radius)}px;`);
  if (vars.length) rules.push(`:root{${vars.join('')}}`);
  if (t.background_color) rules.push(`body{background-color:${t.background_color};}`);
  if (t.text_color) rules.push(`body{color:${t.text_color};}`);
  if (t.body_font) rules.push(`body{font-family:${FONT_STACKS[t.body_font]};}`);
  if (t.base_font_size) rules.push(`body{font-size:${Number(t.base_font_size)}px;}`);
  if (t.heading_font) rules.push(`h1,h2,h3,h4,h5,h6{font-family:${FONT_STACKS[t.heading_font]};}`);
  if (t.primary_color) rules.push(`h1,h2,h3{color:${t.primary_color};}`);
  if (t.link_color) rules.push(`a{color:${t.link_color};}`);
  if (t.muted_text_color)
    rules.push(`.has-text-color.has-secondary-color,figcaption,.wp-block-post-date{color:${t.muted_text_color};}`);
  if (t.header_background)
    rules.push(`header.wp-block-template-part,.site-header,header#masthead{background-color:${t.header_background};}`);
  if (t.footer_background)
    rules.push(`footer.wp-block-template-part,.site-footer,footer#colophon{background-color:${t.footer_background};}`);
  if (t.button_background || t.button_text_color || t.border_radius != null) {
    const bits = [];
    if (t.button_background) bits.push(`background-color:${t.button_background};`);
    if (t.button_text_color) bits.push(`color:${t.button_text_color};`);
    if (t.border_radius != null && t.border_radius !== '') bits.push(`border-radius:${Number(t.border_radius)}px;`);
    rules.push(
      `button,input[type="submit"],input[type="button"],.button,.wp-block-button__link,a.wp-block-button__link{${bits.join('')}}`
    );
  }
  if (t.surface_color) rules.push(`.card,.wp-block-group.has-background{background-color:${t.surface_color};}`);
  if (t.accent_color) rules.push(`::selection{background-color:${t.accent_color};}`);
  return rules.join('\n');
}

/** Google Fonts family names a token state needs loaded. */
function googleFontsFor(tokensIn) {
  const t = tokensIn && typeof tokensIn === 'object' ? tokensIn : {};
  const out = [];
  for (const token of FONT_TOKENS) {
    const fam = t[token] && GOOGLE_FONTS[t[token]];
    if (fam && !out.includes(fam)) out.push(fam);
  }
  return out;
}

/** One-line human summary of a single op (change log + UI). */
function describeOp(op) {
  if (!op || typeof op !== 'object') return 'change';
  if (op.type === 'set_token') return `Set ${String(op.token).replace(/_/g, ' ')} to ${String(op.value)}`;
  if (op.type === 'remove_token') return `Reset ${String(op.token).replace(/_/g, ' ')} to the theme default`;
  if (op.type === 'zone_create')
    return `Add a ${String(op.zone && op.zone.type ? op.zone.type : 'section')} section (${String(op.zone && op.zone.id ? op.zone.id : '')})`;
  if (op.type === 'zone_update') return `Update section ${String(op.zoneId || '')}`;
  if (op.type === 'zone_remove') return `Remove section ${String(op.zoneId || '')}`;
  return String(op.type || 'change');
}

module.exports = {
  COLOR_TOKENS,
  FONT_TOKENS,
  FONT_STACKS,
  GOOGLE_FONTS,
  SCALE_TOKENS,
  ZONE_TYPES,
  TOKEN_SET,
  normalizeColor,
  validateTokenValue,
  validateZoneFields,
  applyOps,
  applyOpsLenient,
  compileCss,
  googleFontsFor,
  describeOp,
};
