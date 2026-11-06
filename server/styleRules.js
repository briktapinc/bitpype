'use strict';

/**
 * Scoped style rules — the implementor's element-style capability
 * for the portal design chat (Batch 94).
 *
 * The in-chat agent could previously change only GLOBAL theme
 * colours, so a canonical small job — "make all H3s dark grey" —
 * was refused and queued ("my editing tools only change overall
 * text colors, not H3-specific styling"). This module is the safe
 * core of the fix: it validates ONE style declaration at a time
 * (selector from a strict grammar, property from an allowlist,
 * value validated per property) and upserts it into a managed
 * block inside the site's own theme.customCss — the style layer
 * every render already applies. No arbitrary CSS can be injected:
 * selectors, properties and values are all rebuilt from validated
 * parts, so a rule can never break out of its declaration block.
 *
 * Pure module (no DB, no I/O) so the four-role rebuild can lift it
 * as the implementor's style tool unchanged.
 */

const BLOCK_START = '/* bitpype:chat-rules:start */';
const BLOCK_END = '/* bitpype:chat-rules:end */';
const MAX_DECLARATIONS = 80;
const MAX_BLOCK_CHARS = 10000;

const TAGS = new Set([
  'body', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'ul', 'ol', 'li',
  'blockquote', 'small', 'strong', 'em', 'span', 'div', 'button', 'input',
  'label', 'td', 'th', 'img', 'figure', 'figcaption',
]);

// Grammar: [section-scope] (tag [.class] | .class)
//   section[data-ws-section-type="hero"] h3
//   h3            .price-card            section[…] .card
const SELECTOR_RE =
  /^(?:section\[data-ws-section-type="([a-z0-9_-]{1,40})"\]\s+)?(?:([a-z][a-z0-9]*)(\.[a-zA-Z][\w-]{0,60})?|(\.[a-zA-Z][\w-]{0,60}))$/i;

const COLOR_PROPS = new Set(['color', 'background-color', 'border-color']);
const LENGTH_PROPS = new Set([
  'font-size', 'letter-spacing', 'margin-top', 'margin-bottom', 'padding-top', 'padding-bottom',
]);
const ENUM_PROPS = {
  'font-style': new Set(['normal', 'italic']),
  'text-transform': new Set(['none', 'uppercase', 'lowercase', 'capitalize']),
  'text-decoration': new Set(['none', 'underline', 'line-through']),
};
const ALL_PROPS = new Set([
  ...COLOR_PROPS,
  ...LENGTH_PROPS,
  ...Object.keys(ENUM_PROPS),
  'font-weight',
  'font-family',
  'line-height',
]);

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeHex(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (s[0] !== '#') s = `#${s}`;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  return s.toLowerCase();
}

/** Canonical selector string, or null when outside the grammar. */
function validateSelector(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!s || s.length > 120) return null;
  const m = SELECTOR_RE.exec(s);
  if (!m) return null;
  const [, sectionTypeRaw, tagRaw, tagClass, loneClass] = m;
  const tag = tagRaw ? tagRaw.toLowerCase() : null;
  const sectionType = sectionTypeRaw ? sectionTypeRaw.toLowerCase() : null;
  if (tag && !TAGS.has(tag)) return null;
  const subject = tag ? tag + (tagClass || '') : loneClass;
  if (!subject) return null;
  return sectionType ? `section[data-ws-section-type="${sectionType}"] ${subject}` : subject;
}

/** { property, value } normalized, or throws a coded error. */
function validateDeclaration(propertyRaw, valueRaw) {
  const property = String(propertyRaw == null ? '' : propertyRaw).trim().toLowerCase();
  if (!ALL_PROPS.has(property)) {
    throw coded('INVALID_PROPERTY', `Property "${property}" is not in the style-rule allowlist`);
  }
  const value = String(valueRaw == null ? '' : valueRaw).trim();
  if (COLOR_PROPS.has(property)) {
    const hex = normalizeHex(value);
    if (!hex) throw coded('INVALID_VALUE', `${property} needs a hex colour (#RRGGBB), got "${value}"`);
    return { property, value: hex };
  }
  if (LENGTH_PROPS.has(property)) {
    if (!/^\d+(?:\.\d+)?(px|rem|em|%)$/.test(value) || value.length > 12) {
      throw coded('INVALID_VALUE', `${property} needs a length like 20px / 1.25rem, got "${value}"`);
    }
    return { property, value };
  }
  if (property === 'line-height') {
    if (!/^(\d+(?:\.\d+)?)(px|rem|em|%)?$/.test(value) || value.length > 12) {
      throw coded('INVALID_VALUE', `line-height needs a number or length, got "${value}"`);
    }
    return { property, value };
  }
  if (property === 'font-weight') {
    if (!/^(normal|bold|bolder|lighter|[1-9]00)$/.test(value)) {
      throw coded('INVALID_VALUE', `font-weight needs normal/bold/100–900, got "${value}"`);
    }
    return { property, value };
  }
  if (property === 'font-family') {
    if (value.length > 120 || !/^[\w\s,'".-]+$/.test(value) || /[;{}<>]/.test(value)) {
      throw coded('INVALID_VALUE', `font-family needs a plain font name or stack, got "${value}"`);
    }
    return { property, value };
  }
  const allowed = ENUM_PROPS[property];
  if (allowed && !allowed.has(value.toLowerCase())) {
    throw coded('INVALID_VALUE', `${property} must be one of ${[...allowed].join(' | ')}, got "${value}"`);
  }
  return { property, value: value.toLowerCase() };
}

function extractBlock(css) {
  const s = String(css || '');
  const start = s.indexOf(BLOCK_START);
  const end = s.indexOf(BLOCK_END);
  if (start < 0 || end < 0 || end < start) return { before: s, inner: '', after: '' };
  return {
    before: s.slice(0, start),
    inner: s.slice(start + BLOCK_START.length, end),
    after: s.slice(end + BLOCK_END.length),
  };
}

/** Ordered [{ selector, declarations: [{ property, value }] }] from the managed block only. */
function parseStyleRules(css) {
  const { inner } = extractBlock(css);
  const rules = [];
  const lineRe = /^(.+?) \{ (.+) \}$/;
  for (const line of inner.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = lineRe.exec(t);
    if (!m) continue;
    const declarations = [];
    for (const part of m[2].split(';')) {
      const d = part.trim();
      if (!d) continue;
      const idx = d.indexOf(':');
      if (idx < 1) continue;
      declarations.push({ property: d.slice(0, idx).trim(), value: d.slice(idx + 1).trim() });
    }
    if (declarations.length) rules.push({ selector: m[1].trim(), declarations });
  }
  return rules;
}

/** Flat [{ selector, property, value }] — what tests / inspectors read. */
function listStyleRules(css) {
  const out = [];
  for (const rule of parseStyleRules(css)) {
    for (const d of rule.declarations) out.push({ selector: rule.selector, property: d.property, value: d.value });
  }
  return out;
}

function renderBlock(rules) {
  const lines = rules.map(
    (r) => `${r.selector} { ${r.declarations.map((d) => `${d.property}: ${d.value};`).join(' ')} }`
  );
  return `${BLOCK_START}\n${lines.join('\n')}\n${BLOCK_END}`;
}

function spliceBlock(css, rules) {
  const { before, after } = extractBlock(css);
  if (!rules.length) {
    // Drop the managed block entirely, keeping the author's own
    // CSS on either side of where the block sat.
    const head = before.replace(/\s+$/, '');
    const tail = after.replace(/^\s+/, '');
    if (!head) return tail;
    if (!tail) return head;
    return `${head}\n${tail}`;
  }
  const block = renderBlock(rules);
  if (block.length > MAX_BLOCK_CHARS) {
    throw coded('TOO_MANY_RULES', 'The chat style-rule block is full — consolidate rules first');
  }
  const head = before.replace(/\s+$/, '');
  const tail = after.replace(/^\s+/, '');
  return `${head ? `${head}\n` : ''}${block}${tail ? `\n${tail}` : ''}`;
}

/**
 * Batch 152 — split theme.customCss into the owner-editable portion
 * and the managed chat-rules block. The portal's Custom CSS field
 * shows/saves ONLY `editable`; the managed block rides along
 * untouched so an owner save can never clobber the design chat's
 * style rules. `managedBlock` is the block's exact stored bytes
 * (markers included), or '' when the stylesheet carries no block.
 */
function splitManagedBlock(css) {
  const s = String(css || '');
  const start = s.indexOf(BLOCK_START);
  const end = s.indexOf(BLOCK_END);
  if (start < 0 || end < 0 || end < start) return { editable: s, managedBlock: '' };
  const { before, after } = extractBlock(s);
  const head = before.replace(/\s+$/, '');
  const tail = after.replace(/^\s+/, '');
  const editable = !head ? tail : !tail ? head : `${head}\n${tail}`;
  return { editable, managedBlock: s.slice(start, end + BLOCK_END.length) };
}

/**
 * Batch 152 — inverse of splitManagedBlock: re-append the managed
 * block, byte-for-byte, after the owner's edited CSS. Canonical
 * form (editable trimmed of trailing whitespace + '\n' + block) is
 * a fixed point: split(reattach(e, b)) returns the same editable
 * and block, so repeated owner saves of unchanged CSS are
 * byte-identical through the canonical save path (Batch 149).
 */
function reattachManagedBlock(editableCss, managedBlock) {
  const block = String(managedBlock || '');
  if (!block) return String(editableCss || '');
  const editable = String(editableCss || '').replace(/\s+$/, '');
  if (!editable) return block;
  return `${editable}\n${block}`;
}

/**
 * Insert or replace one declaration. value === null removes it.
 * Returns the new customCss. Throws coded errors on bad input.
 */
function upsertStyleRule(css, { selector: rawSelector, property: rawProperty, value: rawValue }) {
  const selector = validateSelector(rawSelector);
  if (!selector) {
    throw coded(
      'INVALID_SELECTOR',
      `Selector "${String(rawSelector).slice(0, 80)}" is outside the allowed grammar (element, .class, or section-scoped element)`
    );
  }
  const removing = rawValue == null;
  const decl = removing
    ? { property: String(rawProperty || '').trim().toLowerCase(), value: null }
    : validateDeclaration(rawProperty, rawValue);
  if (!ALL_PROPS.has(decl.property)) {
    throw coded('INVALID_PROPERTY', `Property "${decl.property}" is not in the style-rule allowlist`);
  }
  const rules = parseStyleRules(css);
  const ruleIdx = rules.findIndex((r) => r.selector === selector);
  if (removing) {
    if (ruleIdx >= 0) {
      rules[ruleIdx].declarations = rules[ruleIdx].declarations.filter((d) => d.property !== decl.property);
      if (!rules[ruleIdx].declarations.length) rules.splice(ruleIdx, 1);
    }
    return spliceBlock(css, rules);
  }
  const total = rules.reduce((sum, r) => sum + r.declarations.length, 0);
  if (ruleIdx >= 0) {
    const existing = rules[ruleIdx].declarations.findIndex((d) => d.property === decl.property);
    if (existing >= 0) rules[ruleIdx].declarations[existing] = decl;
    else {
      if (total + 1 > MAX_DECLARATIONS) throw coded('TOO_MANY_RULES', `Style-rule cap (${MAX_DECLARATIONS}) reached`);
      rules[ruleIdx].declarations.push(decl);
    }
  } else {
    if (total + 1 > MAX_DECLARATIONS) throw coded('TOO_MANY_RULES', `Style-rule cap (${MAX_DECLARATIONS}) reached`);
    rules.push({ selector, declarations: [decl] });
  }
  return spliceBlock(css, rules);
}

module.exports = {
  BLOCK_START,
  BLOCK_END,
  MAX_DECLARATIONS,
  validateSelector,
  validateDeclaration,
  parseStyleRules,
  listStyleRules,
  upsertStyleRule,
  splitManagedBlock,
  reattachManagedBlock,
  normalizeHex,
};
