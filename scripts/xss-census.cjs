'use strict';
/**
 * SEC-13 (Batch 103) — stored-XSS sink census.
 *
 * Scans the client surfaces that build HTML strings (staff app,
 * client portal, module embeds, public pages, export engine) for
 * innerHTML / insertAdjacentHTML sinks and classifies each one:
 *
 *   STATIC   — RHS is a plain string with no interpolation and no
 *              variable reference (compile-time constant markup).
 *   ESCAPED  — template/concatenation sink where EVERY interpolated
 *              expression is wrapped in a known escaper (esc(),
 *              escapeHtml(), …) or a numeric coercion.
 *   RAW      — anything else: a bare variable RHS, or at least one
 *              interpolation that is not provably escaped. RAW sinks
 *              are the review queue; the regression gate pins the
 *              reviewed RAW set so a NEW raw sink fails the build.
 *
 * Usage: node scripts/xss-census.cjs [--json] [file ...]
 * As a module: const { census } = require('./xss-census.cjs')
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILES = [
  'public/js/app.js',
  'public/js/portal.js',
  'public/js/module-embed.js',
  'public/js/form-embed.js',
  'public/js/chat-embed.js',
  'public/js/claim-preview.js',
  'public/js/captcha.js',
  'public/js/cookie-bar.js',
  'public/js/fonts.js',
  'public/domain-picker.html',
  'public/claim.html',
  'public/social-approve.html',
  'public/design-change.html',
  'public/authorize.html',
  'public/domain-success.html',
  'public/website-promo.html',
  'src/websiteEngine.js',
];

const ESCAPER_RE = /^(esc|escapeHtml|escapeAttr|escAttr|escHtml|escUrl|sanitizeHtml|Number|parseInt|parseFloat|Math\.)/;

/** Extract the RHS of an assignment starting at index `i` (just past
 * the operator), stopping at the statement-terminating ';' that sits
 * at nesting depth 0. Template literals are tracked so ';' and '${'
 * inside them don't confuse the scan. */
function readRhs(src, i) {
  let depth = 0;
  let braceDepth = 0;
  let inTpl = false;
  let inS = null; // quote char
  let start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    const prev = src[i - 1];
    if (inS) {
      if (c === inS && prev !== '\\') inS = null;
      continue;
    }
    if (inTpl) {
      if (c === '`' && prev !== '\\') inTpl = false;
      else if (c === '$' && src[i + 1] === '{') braceDepth++;
      else if (c === '}' && braceDepth > 0) braceDepth--;
      continue;
    }
    if (c === "'" || c === '"') inS = c;
    else if (c === '`') inTpl = true;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) return src.slice(start, i);
    else if (c === '\n' && depth === 0 && !inTpl) {
      // ASI safety: a newline outside any nesting also ends most
      // statements in this codebase's style — but only trust it if
      // the chunk so far doesn't end with an operator.
      const chunk = src.slice(start, i).trimEnd();
      if (!/[+?:.,&|=(]$/.test(chunk)) return src.slice(start, i);
    }
  }
  return src.slice(start, i);
}

/** Pull the top-level ${ ... } interpolation expressions out of a
 * template-literal-bearing string. */
function interpolations(rhs) {
  const out = [];
  let inTpl = false;
  for (let i = 0; i < rhs.length; i++) {
    const c = rhs[i];
    const prev = rhs[i - 1];
    if (c === '`' && prev !== '\\') inTpl = !inTpl;
    if (inTpl && c === '$' && rhs[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      for (; j < rhs.length && depth > 0; j++) {
        if (rhs[j] === '{') depth++;
        else if (rhs[j] === '}') depth--;
      }
      out.push(rhs.slice(i + 2, j - 1).trim());
      i = j - 1;
    }
  }
  return out;
}

/** Is one interpolation expression provably safe to inline as HTML?
 * Safe: escaper-wrapped; numeric coercion; a member chain ending in a
 * numeric-ish field (id/count/length/total/page…); a ternary whose
 * branches are literals or safe expressions; a nested template whose
 * own interpolations are all safe; a *Html builder variable (the
 * codebase convention: values named *Html are pre-built markup whose
 * own construction sites are census-visible). */
const FORMATTER_RE = /^(fmt|pretty|icon|badgeFor|stars|relTime|timeAgo|dateStr|money|moneyStr|cents|pct|percent|initials|avatarHtml|statusBadge|sevBadge|roleBadge|planBadge|kv|jsonPre)/;
// kv(k, v) escapes v unless a third `raw` arg is passed; the census
// baseline review verified zero `, true)` kv call sites (2026-10-31).

function interpSafe(expr) {
  const e = expr.trim();
  if (ESCAPER_RE.test(e)) return true;
  if (FORMATTER_RE.test(e)) return true; // local formatters: dates, money, enum labels
  if (/^\d+(\.\d+)?$/.test(e)) return true;
  if (/\.length$/.test(e) || /\.(id|count|total|page|pages|size|bytes|index|idx|num|qty|amount_cents)$/.test(e)) return true;
  if (/^[A-Za-z_$][\w.]*[Hh]tml$/.test(e)) return true; // *Html builder variable
  if (/^[A-Za-z_$][\w.]*\([^)]*\)$/.test(e) && /(Html|html|Row|row|Badge|badge|Chip|chip|Card|card|Item|item|Link|link|Thumb|thumb|Opts|opts|List|list)$/.test(e.split('(')[0])) return true; // builder call
  // Ternary with safe branches.
  const q = e.indexOf('?');
  if (q > 0) {
    const rest = e.slice(q + 1);
    const colon = rest.lastIndexOf(':');
    if (colon > 0) {
      const a = rest.slice(0, colon).trim();
      const b = rest.slice(colon + 1).trim();
      const litOrSafe = (x) => /^('[^']*'|"[^"]*"|''|"")$/.test(x) || interpSafe(x);
      if (litOrSafe(a) && litOrSafe(b)) return true;
    }
  }
  // Any expression CONTAINING template literals (map callbacks,
  // ternary branches, block bodies): every nested interpolation must
  // itself be safe. The non-template code around them (arrow params,
  // local consts) carries no markup by itself.
  if (e.includes('`')) {
    const inner = interpolations(e);
    if (inner.length > 0) return inner.every((x) => x !== e && interpSafe(x));
    return true; // a template with no interpolations is a literal
  }
  return false;
}

function classify(rhs) {
  const trimmed = rhs.trim();
  const interps = interpolations(trimmed);
  const unsafe = interps.filter((e) => !interpSafe(e));
  const hasConcatVar = /\+\s*[A-Za-z_$]/.test(trimmed) || /[A-Za-z_$][\w.[\]()]*\s*\+/.test(trimmed);
  if (interps.length === 0 && !hasConcatVar) {
    if (/^[A-Za-z_$][\w.]*$/.test(trimmed)) {
      // Bare identifier / member chain: *Html = pre-built markup
      // convention; numeric chains are value-safe; anything else is
      // an unprovable pre-computed value (review bucket IDENT).
      if (/[Hh]tml$/.test(trimmed)) return { kind: 'BUILDER', unsafe: [] };
      if (/\.length$/.test(trimmed) || /\.(id|count|total|page|pages|size|bytes)$/.test(trimmed)) return { kind: 'SAFE', unsafe: [] };
      return { kind: 'IDENT', unsafe: [trimmed] };
    }
    if (/^[A-Za-z_$][\w.]*\(/.test(trimmed)) {
      const fn = trimmed.split('(')[0];
      return /(Html|html|Row|row|Badge|badge|Chip|chip|Card|card|Item|item|Link|link|Thumb|thumb|Opts|opts|List|list)$/.test(fn)
        ? { kind: 'BUILDER', unsafe: [] }
        : { kind: 'IDENT', unsafe: [trimmed] };
    }
    return { kind: 'STATIC', unsafe: [] };
  }
  if (interps.length > 0 && unsafe.length === 0) {
    return { kind: interps.every((e) => ESCAPER_RE.test(e)) ? 'ESCAPED' : 'SAFE', unsafe: [] };
  }
  if (interps.length > 0) return { kind: 'RAW', unsafe };
  return { kind: 'RAW', unsafe: ['<string concatenation with variables>'] };
}

function censusFile(rel) {
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, 'utf8');
  const sinks = [];
  const re = /\.innerHTML\s*(\+?=)|insertAdjacentHTML\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    let rhs;
    if (m[0].startsWith('insertAdjacentHTML')) {
      // second argument is the HTML
      const open = src.indexOf('(', m.index);
      const comma = src.indexOf(',', open);
      rhs = readRhs(src, comma + 1);
    } else {
      rhs = readRhs(src, m.index + m[0].length);
    }
    const c = classify(rhs);
    sinks.push({ file: rel, line, kind: c.kind, unsafe: c.unsafe, snippet: rhs.trim().replace(/\s+/g, ' ').slice(0, 140) });
  }
  return sinks;
}

function census(files = DEFAULT_FILES) {
  const all = [];
  for (const f of files) {
    try {
      all.push(...censusFile(f));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  const summary = { total: all.length, STATIC: 0, ESCAPED: 0, SAFE: 0, BUILDER: 0, IDENT: 0, RAW: 0 };
  for (const s of all) summary[s.kind] = (summary[s.kind] || 0) + 1;
  return { sinks: all, summary };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => a !== '--json');
  const { sinks, summary } = census(files.length ? files : undefined);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ summary, sinks }, null, 2));
  } else {
    console.log(`innerHTML sinks: ${summary.total} (STATIC ${summary.STATIC}, ESCAPED ${summary.ESCAPED}, SAFE ${summary.SAFE}, BUILDER ${summary.BUILDER}, IDENT ${summary.IDENT}, RAW ${summary.RAW})`);
    for (const s of sinks.filter((x) => x.kind === 'RAW' || x.kind === 'IDENT')) {
      console.log(`${s.kind} ${s.file}:${s.line} — unsafe: ${s.unsafe.join(' | ').slice(0, 220)}`);
    }
  }
}

module.exports = { census, censusFile, classify, DEFAULT_FILES };
