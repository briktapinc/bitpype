'use strict';
/**
 * Batch 144 — AUTH-GATE DARK GROUND + WHITE LOCKUP (Ely, 2026-11-05).
 *
 * Ely's standing logo rule (2026-10-30): the WHITE lockup goes on dark
 * backgrounds, the BLACK lockup on light ones — and his Batch 88
 * screenshot ruling puts the staff sign-in gate on the DARK ground
 * ("gate on the DARK ground", white lockup; the gate brand in app.js
 * already renders logo-white.png, pinned by batch87 A7). The Batch
 * 143 full review (§6) found the shipped gate CSS had drifted back
 * to the cream theme: .auth-card sat on --surface #fffaf4 with no
 * dark gate theme, so the white wordmark measured ~1:1 contrast —
 * effectively invisible. The CSS was the side that drifted; Batch 144
 * restores the dark ground in public/styles.css ONLY:
 *
 *   - .auth-gate backdrop and .auth-card ground resolve through the
 *     pinned token --sidebar (the staff sidebar's dark ground).
 *   - .auth-card carries a local token remap (--surface / --surface-2
 *     dark field grounds, --text / --ink the light sidebar text,
 *     --muted its tan, warm-brown borders, plus lightened --gate-link
 *     / --gate-error tones) so every shared component style inside
 *     the card — labels, inputs, tabs, hints, messages — resolves
 *     dark-scoped, and NO other surface changes.
 *
 * This suite pins the mechanism, not a screenshot: it parses the
 * actual token values out of public/css/tokens.css, resolves the
 * gate's declarations through them, and computes WCAG relative
 * luminance / contrast from those values. A token rename that keeps
 * the shape stays green; a drift back to a light ground goes red.
 * (The rendered visual proof on the real sign-in page is the
 * finisher's live check at deploy time.)
 *
 *   G1 the pinned ground token exists and is dark.
 *   G2 gate backdrop + card ground resolve through --sidebar; card
 *      text resolves through --sidebar-text.
 *   G3 both auth screens render the WHITE lockup, never the black.
 *   G4 wordmark-white vs gate ground contrast >= 4.5:1 (computed).
 *   G5 the ground rule holds off the gate too (Batch 146 ground
 *      audit correction): the marketing header band is DARK, so it
 *      takes the white lockup; the light marketing footer keeps the
 *      black lockup; branding defaults unchanged.
 *   G6 form controls are dark-scoped: the .auth-card remap makes the
 *      field ground dark, text light, muted >= 4.5:1 on the ground,
 *      and defines legible gate link/error tones.
 *   G7 gate-scoped overrides exist for links, error text and input
 *      placeholders, each >= 4.5:1 against its ground.
 *   G8 the global light theme is untouched — the remap is local.
 *
 * Static suite: boots no server, touches no database.
 * Run via tests/run-regressions.cjs.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}

/* ---------------- CSS parsing helpers ---------------- */

function declsOf(body) {
  const out = {};
  for (const part of String(body).split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (prop) out[prop] = value;
  }
  return out;
}

function ruleBody(css, re, label) {
  const m = css.match(re);
  assert.ok(m, `${label} rule exists`);
  return m[1];
}

/* Merge every :root block (tokens.css declares two). */
function rootTokens(css) {
  const out = {};
  for (const m of css.matchAll(/:root\s*\{([^}]*)\}/g)) Object.assign(out, declsOf(m[1]));
  return out;
}

/* Resolve var(--x) chains against a declaration map (local wins). */
function resolve(value, map, depth = 0) {
  if (value == null || depth > 6) return value;
  const next = String(value).replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, (all, name) =>
    Object.prototype.hasOwnProperty.call(map, name) ? map[name] : all
  );
  return next === value ? next : resolve(next, map, depth + 1);
}

function hexOf(value, label) {
  const m = String(value).match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/);
  assert.ok(m, `${label} resolves to a hex color (got: ${value})`);
  let h = m[0].slice(1);
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  return '#' + h.toLowerCase();
}

/* ---------------- WCAG luminance / contrast ---------------- */

function luminance(hex) {
  const c = hexOf(hex, 'luminance input').slice(1);
  const f = (i) => {
    const v = parseInt(c.substr(i, 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
}

function contrast(hexA, hexB) {
  const [hi, lo] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------------- The checks ---------------- */

/* Strip comments before parsing: declaration blocks in this codebase
   carry explanatory comments whose colons would corrupt the split. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const tokensCss = stripComments(read('public/css/tokens.css'));
const stylesCss = stripComments(read('public/styles.css'));
const tokens = rootTokens(tokensCss);

const gateBody = ruleBody(stylesCss, /\.auth-gate\s*\{([^}]*)\}/, '.auth-gate');
const cardBody = ruleBody(stylesCss, /\.auth-card\s*\{([^}]*)\}/, '.auth-card');
const card = declsOf(cardBody);
/* Effective declarations inside the card: globals overridden locally. */
const cardMap = { ...tokens, ...card };

check('G1 pinned ground token --sidebar exists in tokens.css and is dark', () => {
  assert.ok(tokens['--sidebar'], '--sidebar token is defined (the pinned gate ground)');
  const lum = luminance(tokens['--sidebar']);
  assert.ok(lum < 0.05, `--sidebar ${tokens['--sidebar']} is a dark ground (luminance ${lum.toFixed(4)} < 0.05)`);
});

check('G2 gate backdrop and card ground resolve through --sidebar; card text through --sidebar-text', () => {
  assert.ok(/var\(\s*--sidebar\s*\)/.test(gateBody), '.auth-gate background paints var(--sidebar)');
  assert.ok(/var\(\s*--sidebar\s*\)/.test(card.background || ''), '.auth-card background is var(--sidebar)');
  assert.ok(/var\(\s*--sidebar-text\s*\)/.test(card.color || ''), '.auth-card text color is var(--sidebar-text)');
  const groundHex = hexOf(resolve(card.background, cardMap), 'card ground');
  assert.equal(groundHex, hexOf(tokens['--sidebar'], '--sidebar'), 'card ground resolves to the --sidebar value');
});

check('G3 both auth screens render the WHITE lockup and never the black one', () => {
  const appNorm = read('public/js/app.js').replace(/\\/g, '');
  const blocks = appNorm.match(/<div class="auth-brand">.*?<\/div>/g) || [];
  assert.equal(blocks.length, 2, 'login + MFA screens each build an auth brand');
  for (const b of blocks) {
    assert.ok(b.includes('src="/brand/logo-white.png"'), 'auth gate renders the white lockup');
    assert.ok(!b.includes('logo-black'), 'the black lockup never renders on the dark gate');
  }
  assert.ok(fs.existsSync(path.join(root, 'public/brand/logo-white.png')), 'logo-white.png asset exists');
});

check('G4 wordmark white vs gate ground contrast >= 4.5:1, computed from the token values', () => {
  const ground = hexOf(tokens['--sidebar'], '--sidebar');
  const ratio = contrast('#ffffff', ground);
  assert.ok(ratio >= 4.5, `white wordmark on ${ground} is ${ratio.toFixed(2)}:1 (>= 4.5:1)`);
  const text = hexOf(resolve(card.color, cardMap), 'card text');
  const textRatio = contrast(text, ground);
  assert.ok(textRatio >= 4.5, `card text ${text} on the ground is ${textRatio.toFixed(2)}:1 (>= 4.5:1)`);
});

check(
  'G5 off-gate surfaces follow the ground rule (Batch 146: dark marketing nav -> white, light footer -> black)',
  () => {
    const home = read('public/home.html');
    /* Batch 146's rendered-ground audit corrected this check's original
     assumption: home.html's header band (.nav) is a DARK ground
     (rgba(28,20,15,0.97)), so its lockup is the white one; the
     footer sits on the cream body ground and keeps the black one.
     Full per-surface ground pins live in the batch146 suite. */
    const header = home.slice(home.indexOf('<header class="nav">'), home.indexOf('</header>'));
    assert.ok(
      header.includes('/brand/logo-white.png'),
      'marketing header (dark .nav ground, home.html) uses logo-white.png'
    );
    const footer = home.slice(home.indexOf('<footer>'), home.indexOf('</footer>'));
    assert.ok(footer.includes('/brand/logo-black.png'), 'marketing footer (light body ground) keeps logo-black.png');
    const branding = read('server/branding.js');
    assert.ok(
      branding.includes("logoDarkUrl: '/brand/logo-white.png'"),
      'branding default for dark screens is the white lockup'
    );
    assert.ok(
      branding.includes("logoLightUrl: '/brand/logo-black.png'"),
      'branding default for light screens is the black lockup'
    );
  }
);

check('G6 gate form controls are dark-scoped via the .auth-card token remap', () => {
  const ground = hexOf(tokens['--sidebar'], '--sidebar');
  /* Inputs paint background: var(--surface) from the shared component
     styles — under the card that token must resolve DARK. */
  assert.ok(card['--surface'], '.auth-card remaps --surface');
  const fieldGround = hexOf(resolve(card['--surface'], cardMap), 'gate --surface');
  assert.ok(
    luminance(fieldGround) < 0.05,
    `input ground ${fieldGround} is dark (luminance ${luminance(fieldGround).toFixed(4)})`
  );
  assert.ok(
    /background:\s*var\(--surface\)/.test(stylesCss),
    'shared input styles resolve background through var(--surface) (the remapped token)'
  );
  /* Labels and input text resolve through --text — must be LIGHT. */
  assert.ok(card['--text'], '.auth-card remaps --text');
  const textHex = hexOf(resolve(card['--text'], cardMap), 'gate --text');
  assert.ok(luminance(textHex) > 0.5, `gate text ${textHex} is light (luminance ${luminance(textHex).toFixed(3)})`);
  const onField = contrast(textHex, fieldGround);
  assert.ok(onField >= 4.5, `input text on the field ground is ${onField.toFixed(2)}:1 (>= 4.5:1)`);
  /* Secondary text (--muted: subs, hints, inactive tabs) >= 4.5:1 on the ground. */
  assert.ok(card['--muted'], '.auth-card remaps --muted');
  const mutedHex = hexOf(resolve(card['--muted'], cardMap), 'gate --muted');
  const mutedRatio = contrast(mutedHex, ground);
  assert.ok(mutedRatio >= 4.5, `gate muted ${mutedHex} on the ground is ${mutedRatio.toFixed(2)}:1 (>= 4.5:1)`);
  /* Input borders stay visible on the dark ground. */
  assert.ok(card['--border-strong'], '.auth-card remaps --border-strong');
  const borderHex = hexOf(resolve(card['--border-strong'], cardMap), 'gate --border-strong');
  const borderRatio = contrast(borderHex, ground);
  assert.ok(borderRatio >= 1.5, `input border ${borderHex} reads on the ground (${borderRatio.toFixed(2)}:1)`);
  /* The lightened gate tones are defined and legible on the ground. */
  for (const name of ['--gate-link', '--gate-error']) {
    assert.ok(card[name], `.auth-card defines ${name}`);
    const hex = hexOf(resolve(card[name], cardMap), name);
    const ratio = contrast(hex, ground);
    assert.ok(ratio >= 4.5, `${name} ${hex} on the ground is ${ratio.toFixed(2)}:1 (>= 4.5:1)`);
  }
});

check('G7 gate-scoped overrides exist for links, error text and placeholders', () => {
  const ground = hexOf(tokens['--sidebar'], '--sidebar');
  const linkBody = ruleBody(
    stylesCss,
    /\.auth-card a,\s*\.auth-card \.auth-links button\s*\{([^}]*)\}/,
    '.auth-card link override'
  );
  assert.ok(/var\(\s*--gate-link\s*\)/.test(linkBody), 'gate links use var(--gate-link)');
  const errBody = ruleBody(
    stylesCss,
    /\.auth-card \.msg\.err,\s*\.auth-card \.msg\.error,\s*\.auth-card \.error\s*\{([^}]*)\}/,
    '.auth-card error override'
  );
  assert.ok(/var\(\s*--gate-error\s*\)/.test(errBody), 'gate error text uses var(--gate-error)');
  const phBody = ruleBody(
    stylesCss,
    /\.auth-card input::placeholder,\s*\.auth-card textarea::placeholder\s*\{([^}]*)\}/,
    '.auth-card placeholder override'
  );
  const ph = declsOf(phBody);
  assert.ok(ph.color, 'gate placeholder color is set under the gate scope');
  const phHex = hexOf(resolve(ph.color, cardMap), 'gate placeholder');
  const fieldGround = hexOf(resolve(card['--surface'], cardMap), 'gate --surface');
  const phRatio = contrast(phHex, fieldGround);
  assert.ok(
    phRatio >= 4.5,
    `placeholder ${phHex} on the field ground ${fieldGround} is ${phRatio.toFixed(2)}:1 (>= 4.5:1)`
  );
  assert.ok(contrast(hexOf(card['--gate-error'], '--gate-error'), ground) >= 4.5, 'error tone legible on the ground');
});

check('G8 the global light theme is untouched — the dark remap is local to the gate', () => {
  assert.equal(tokens['--surface'], '#fffaf4', 'global --surface stays the cream card color');
  assert.equal(tokens['--bg'], '#f7f1e8', 'global --bg stays cream');
  assert.equal(tokens['--text'], '#1c140f', 'global --text stays ink');
  assert.equal(tokens['--sidebar'], '#1c140f', 'the gate ground is the sidebar ground, unchanged');
});

console.log(`batch144 auth-gate-dark checks passed (${results.length}):`);
for (const r of results) console.log('  - ' + r);
