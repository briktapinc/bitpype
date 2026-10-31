'use strict';

/**
 * Deterministic CSS cascade evaluator over RENDERED site HTML
 * (Batch 98 — Tier-1 v2 + the four-role rebuild's evidence layer).
 *
 * Why this exists: the design chat's planner needs to SEE the
 * site's current computed styles (review finding M1 — Tier-1 was
 * style-blind: it could not say what colour the H3s currently
 * are), and the Critic (Batch 99) must verify outcomes from the
 * rendered result, never from the implementor's say-so. Both
 * need the same question answered mechanically: "what does THIS
 * element compute to for THIS property, on a light or dark part
 * of the page?"
 *
 * The evaluator is the one proven live in the Batch 96 proof
 * (it caught a real cascade bug there), generalized: any
 * property, every matching element (not just the first),
 * light/dark context from the element's effective background,
 * and inheritance for the text properties CSS inherits.
 *
 * Supported selector shapes — the ones the renderer, themes and
 * chat rules actually emit: tag, .class, [attr="v"], descendant /
 * child combinators, comma groups, :root custom properties via
 * var(), inline styles, !important. Deliberately NOT a browser:
 * no pseudo-classes, no media queries (rules inside @media are
 * read as unconditional — the chat's own rules never use them,
 * and theme media rules affect layout widths far more than the
 * colours/typography verified here).
 */

const NAMED = {
  black: '#000000', white: '#ffffff', grey: '#808080', gray: '#808080',
  darkgrey: '#a9a9a9', darkgray: '#a9a9a9', dimgrey: '#696969', dimgray: '#696969',
  lightgrey: '#d3d3d3', lightgray: '#d3d3d3', silver: '#c0c0c0',
  red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a',
};

/** Normalize a CSS colour to #rrggbb (or the string 'transparent'). */
function normColor(raw, vars) {
  let v = String(raw || '').trim().toLowerCase().replace(/\s*!important\s*$/, '');
  if (!v) return null;
  if (v === 'transparent') return 'transparent';
  const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(v);
  if (varMatch) {
    if (vars && vars[varMatch[1]]) v = String(vars[varMatch[1]]).trim().toLowerCase();
    else if (varMatch[2]) v = varMatch[2].trim().toLowerCase();
    else return null;
  }
  if (NAMED[v]) return NAMED[v];
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return '#' + m[1].split('').map((c) => c + c).join('');
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return '#' + m[1];
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(v);
  if (m) {
    if (m[4] != null && Number(m[4]) === 0) return 'transparent';
    return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
  }
  return null;
}

/** 0..1 relative luminance of a #rrggbb colour, or null. */
function hexLuminance(hex) {
  const m = /^#([0-9a-f]{6})$/.exec(String(hex || ''));
  if (!m) return null;
  const chan = (i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
}

function parseCompound(text) {
  const out = { tag: null, classes: [], attrs: [] };
  const t = String(text).trim();
  const tagMatch = /^([a-zA-Z][\w-]*|\*)/.exec(t);
  if (tagMatch && tagMatch[1] !== '*') out.tag = tagMatch[1].toLowerCase();
  for (const cm of t.matchAll(/\.([\w-]+)/g)) out.classes.push(cm[1]);
  for (const am of t.matchAll(/\[([\w-]+)(?:\s*=\s*["']?([^"'\]]+)["']?)?\]/g)) {
    out.attrs.push({ name: am[1], value: am[2] || null });
  }
  return out;
}

function compoundSpecificity(c) {
  return { b: c.classes.length + c.attrs.length, c: c.tag ? 1 : 0 };
}

function matchCompound(el, c) {
  if (c.tag && el.tag !== c.tag) return false;
  for (const cl of c.classes) if (!el.classes.includes(cl)) return false;
  for (const at of c.attrs) {
    if (!(at.name in el.attrs)) return false;
    if (at.value != null && el.attrs[at.name] !== at.value) return false;
  }
  return true;
}

/** Specificity {b, c} when the selector matches the chain, else null. */
function selectorMatches(chain, sel) {
  const compounds = String(sel).split(/\s*>\s*|\s+/).filter(Boolean).map(parseCompound);
  if (!compounds.length) return null;
  if (!matchCompound(chain[chain.length - 1], compounds[compounds.length - 1])) return null;
  let ai = chain.length - 2;
  for (let ci = compounds.length - 2; ci >= 0; ci--) {
    let found = false;
    while (ai >= 0) {
      if (matchCompound(chain[ai], compounds[ci])) { found = true; ai -= 1; break; }
      ai -= 1;
    }
    if (!found) return null;
  }
  return compounds.reduce(
    (acc, c) => { const s = compoundSpecificity(c); return { b: acc.b + s.b, c: acc.c + s.c }; },
    { b: 0, c: 0 }
  );
}

/** Parse every <style> block in the document into flat rules. */
function parseDocument(html) {
  const vars = {};
  const rules = [];
  const source = String(html || '');
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let sm;
  let order = 0;
  while ((sm = styleRe.exec(source))) {
    // Strip CSS comments FIRST: the managed chat-rules block is
    // comment-delimited, and an unstripped comment's first word
    // parses as a bogus selector that silently kills the rule it
    // precedes (proof bug caught live in Batch 96).
    const css = sm[1].replace(/\/\*[\s\S]*?\*\//g, '');
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let rm;
    while ((rm = ruleRe.exec(css))) {
      const selectors = rm[1].split(',').map((s) => s.trim()).filter(Boolean);
      const body = rm[2];
      const decls = [];
      for (const part of body.split(';')) {
        const idx = part.indexOf(':');
        if (idx < 1) continue;
        const property = part.slice(0, idx).trim().toLowerCase();
        let value = part.slice(idx + 1).trim();
        if (!property || !value) continue;
        const important = /!important\s*$/i.test(value);
        if (important) value = value.replace(/\s*!important\s*$/i, '');
        decls.push({ property, value, important });
      }
      if (!decls.length) continue;
      for (const sel of selectors) {
        if (sel === ':root' || sel === 'html') {
          for (const d of decls) {
            if (d.property.startsWith('--')) vars[d.property] = d.value;
          }
        }
        rules.push({ sel, decls, order: order++ });
      }
    }
  }
  return { vars, rules };
}

const VOID_TAGS = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'wbr']);

/** Walk the tag stream → [{ tag, classes, attrs, style, chain, text }]. */
function listElements(html) {
  const source = String(html || '');
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)(\/?)>/g;
  const stack = [];
  const out = [];
  let tm;
  while ((tm = tagRe.exec(source))) {
    const [, closing, tagRaw, attrText, selfClose] = tm;
    const tag = tagRaw.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const attrs = {};
    for (const am of String(attrText || '').matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)')?/g)) {
      attrs[am[1]] = am[2] != null ? am[2] : am[3] != null ? am[3] : '';
    }
    const el = {
      tag,
      classes: String(attrs.class || '').split(/\s+/).filter(Boolean),
      attrs,
      style: attrs.style || '',
    };
    // A short text sample helps humans (and the Tier-1 map) tell
    // elements apart; it is NOT a full text extraction.
    const rest = source.slice(tagRe.lastIndex, tagRe.lastIndex + 160);
    const text = rest.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const chain = [...stack, el];
    out.push({ ...el, chain, text });
    if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el);
  }
  return out;
}

function inlineDecl(style, property) {
  const re = new RegExp(`(?:^|;)\\s*${property.replace(/-/g, '\\-')}\\s*:\\s*([^;]+)`, 'i');
  const m = re.exec(String(style || ''));
  if (!m) return null;
  const value = m[1].trim();
  return { value: value.replace(/\s*!important\s*$/i, ''), important: /!important\s*$/i.test(value) };
}

const INHERITED_PROPS = new Set(['color', 'font-family', 'font-weight', 'font-style', 'letter-spacing', 'text-transform']);

/**
 * The winning declared value for (element, property) from rules +
 * inline style, walking up the chain for inherited properties.
 * Returns { value, via } or null.
 */
function declaredValue(doc, chain, property) {
  for (let depth = chain.length - 1; depth >= 0; depth--) {
    const sub = chain.slice(0, depth + 1);
    const el = chain[depth];
    let best = null;
    for (const rule of doc.rules) {
      const spec = selectorMatches(sub, rule.sel);
      if (!spec) continue;
      for (const d of rule.decls) {
        // The `background` shorthand with a plain colour value IS
        // a background-color declaration for context purposes —
        // real themes use it constantly.
        if (
          d.property !== property &&
          !(
            property === 'background-color' &&
            d.property === 'background' &&
            normColor(d.value, doc.vars) &&
            normColor(d.value, doc.vars) !== 'transparent'
          )
        ) {
          continue;
        }
        const cand = { value: d.value, important: d.important, spec, order: rule.order, via: `rule "${rule.sel}"` };
        if (
          !best ||
          (cand.important && !best.important) ||
          (cand.important === best.important &&
            (cand.spec.b > best.spec.b ||
              (cand.spec.b === best.spec.b && cand.spec.c > best.spec.c) ||
              (cand.spec.b === best.spec.b && cand.spec.c === best.spec.c && cand.order > best.order)))
        ) {
          best = cand;
        }
      }
    }
    let inline = inlineDecl(el.style, property);
    if (!inline && property === 'background-color') {
      const short = inlineDecl(el.style, 'background');
      if (short && normColor(short.value, doc.vars) && normColor(short.value, doc.vars) !== 'transparent') {
        inline = short;
      }
    }
    if (inline && !(best && best.important && !inline.important)) {
      return { value: inline.value, via: 'inline style' };
    }
    if (best) return best;
    if (!INHERITED_PROPS.has(property)) return null;
  }
  return null;
}

/** Computed value for a property: colours normalized to hex. */
function computedValue(doc, chain, property) {
  const found = declaredValue(doc, chain, property);
  if (!found) return null;
  if (property === 'color' || property.endsWith('-color')) {
    return { value: normColor(found.value, doc.vars), raw: found.value, via: found.via };
  }
  let v = String(found.value).trim();
  const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(v);
  if (varMatch) {
    if (doc.vars[varMatch[1]]) v = String(doc.vars[varMatch[1]]).trim();
    else if (varMatch[2]) v = varMatch[2].trim();
  }
  return { value: v, raw: found.value, via: found.via };
}

/**
 * The element's effective background: the nearest self/ancestor
 * with a non-transparent background colour. Context is 'dark'
 * when its luminance < 0.35, else 'light' (an unknown background
 * defaults to light — these sites' pages are light by default,
 * and the renderer's body rule normally resolves it anyway).
 */
function elementContext(doc, chain) {
  for (let depth = chain.length - 1; depth >= 0; depth--) {
    const sub = chain.slice(0, depth + 1);
    const found = declaredValue(doc, sub, 'background-color');
    if (!found) continue;
    const hex = normColor(found.value, doc.vars);
    if (!hex || hex === 'transparent') continue;
    const lum = hexLuminance(hex);
    return { context: lum != null && lum < 0.35 ? 'dark' : 'light', background: hex };
  }
  return { context: 'light', background: null };
}

/**
 * Every element matching `selector`, with its computed value for
 * `property` and its light/dark context:
 * [{ value, raw, via, context, background, text }]
 */
function computedStyleValues(html, selector, property) {
  const doc = parseDocument(html);
  const els = listElements(html);
  const out = [];
  for (const el of els) {
    if (!selectorMatches(el.chain, selector)) continue;
    const computed = computedValue(doc, el.chain, property);
    const ctx = elementContext(doc, el.chain);
    out.push({
      value: computed ? computed.value : null,
      raw: computed ? computed.raw : null,
      via: computed ? computed.via : 'no rule',
      context: ctx.context,
      background: ctx.background,
      text: el.text,
    });
  }
  return out;
}

const KEY_TAGS = ['h1', 'h2', 'h3', 'h4', 'p', 'a'];

/**
 * Tier-1 v2: the current computed styles of the key text elements,
 * split by light/dark context — the planner's eyes (finding M1).
 * { h3: { light: { color, count }, dark: { color, count } }, ... }
 * Only contexts that actually occur are reported.
 */
function keyStyles(html) {
  const out = {};
  for (const tag of KEY_TAGS) {
    const values = computedStyleValues(html, tag, 'color');
    if (!values.length) continue;
    const byCtx = {};
    for (const v of values) {
      const slot = byCtx[v.context] || (byCtx[v.context] = { colors: new Set(), count: 0 });
      slot.count += 1;
      if (v.value) slot.colors.add(v.value);
    }
    const entry = {};
    for (const [ctx, slot] of Object.entries(byCtx)) {
      entry[ctx] = { colors: [...slot.colors].slice(0, 3), count: slot.count };
    }
    if (Object.keys(entry).length) out[tag] = entry;
  }
  return out;
}

/** One-line-per-element summary lines for the Tier-1 site map. */
function keyStyleLines(html) {
  const styles = keyStyles(html);
  const lines = [];
  for (const tag of KEY_TAGS) {
    const entry = styles[tag];
    if (!entry) continue;
    for ( const ctx of ['light', 'dark']) {
      const slot = entry[ctx];
      if (!slot) continue;
      lines.push(
        `${tag.toUpperCase()} text colour on ${ctx} sections: ${slot.colors.length ? slot.colors.join(', ') : '(inherited/default)'} (${slot.count} element${slot.count === 1 ? '' : 's'})`
      );
    }
  }
  return lines;
}

module.exports = {
  normColor,
  hexLuminance,
  parseDocument,
  listElements,
  selectorMatches,
  computedValue,
  elementContext,
  computedStyleValues,
  keyStyles,
  keyStyleLines,
};
