'use strict';
/**
 * Batch 111 — CONSOLIDATION PASS (Ely, 2026-10-31: "I'd rather have
 * it break now than on launch"). Behaviour-preserving: no new
 * features, no behaviour changes except the Step-3 .card styling
 * fix Ely had already seen flagged.
 *
 *   Step 1 — branch hygiene: master fast-forwarded to the Batch 110
 *            production tip (proven byte-identical to the running
 *            container, 496 files). Git-side; not pinned here.
 *   Step 2 — icon dedupe: MODULE_ICON_PATHS + MODULE_ICON_FALLBACK
 *            single-sourced in public/js/moduleIcons.js, loaded by
 *            BOTH shells before their main scripts; the two
 *            byte-identical per-file copies are gone. Glyphs are
 *            byte-for-byte the Batch 91 originals.
 *   (Later steps append their sections below.)
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const portalHtml = read('public/portal.html');
const staffHtml = read('public/index.html');
const portalJs = read('public/js/portal.js');
const appJs = read('public/js/app.js');
const iconsJs = read('public/js/moduleIcons.js');

let n = 0;
const check = (name, fn) => {
  fn();
  n += 1;
  console.log(`ok ${n} - ${name}`);
};

/* ---------------- Step 2 — one shared icon source ---------------- */

const iconPathsOf = (src) => {
  const m = src.match(/const MODULE_ICON_PATHS = \{(.*?)\n\};/s);
  assert.ok(m, 'MODULE_ICON_PATHS found in shared source');
  return Object.fromEntries([...m[1].matchAll(/(\w+): '([^']*)'/g)].map((x) => [x[1], x[2]]));
};

check('S2.1 shared icon file carries all 22 glyphs + the fallback', () => {
  const icons = iconPathsOf(iconsJs);
  assert.equal(Object.keys(icons).length, 22, '22 module glyphs');
  for (const [t, g] of Object.entries(icons)) assert.ok(g.includes('<'), `${t} glyph present`);
  assert.ok(iconsJs.includes("const MODULE_ICON_FALLBACK = '<rect x=\"4\" y=\"4\""), 'fallback defined once, in the shared file');
});

check('S2.2 glyphs are byte-for-byte the Batch 91 originals (spot pins)', () => {
  const icons = iconPathsOf(iconsJs);
  assert.equal(icons.blog, '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14.5 3.5V8H19"/><path d="M9 12.5h6.5"/><path d="M9 16h6.5"/>');
  assert.equal(icons.charts, '<path d="M4 4v16h16"/><rect x="7.2" y="12" width="2.9" height="8"/><rect x="11.6" y="8.5" width="2.9" height="11.5"/><rect x="16" y="14.5" width="2.9" height="5.5"/>');
  assert.equal(icons.datatables, '<rect x="3.5" y="4" width="17" height="16" rx="1.6"/><path d="M3.5 9.4h17"/><path d="M3.5 14.7h17"/><path d="M9.2 4v16"/><path d="M14.8 4v16"/>');
  assert.equal(icons.googlereviews, '<path d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.3l-5.1 2.7 1.1-5.6L3.8 9.5l5.7-.7z"/>');
});

check('S2.3 neither consumer carries its own copy any more', () => {
  assert.ok(!portalJs.includes('const MODULE_ICON_PATHS = {'), 'portal.js copy removed');
  assert.ok(!appJs.includes('const MODULE_ICON_PATHS = {'), 'app.js copy removed');
  assert.ok(!portalJs.includes('const MODULE_ICON_FALLBACK'), 'portal fallback removed');
  assert.ok(!appJs.includes('const MODULE_ICON_FALLBACK'), 'staff fallback removed');
  assert.ok(portalJs.includes('MODULE_ICON_PATHS[type] || MODULE_ICON_FALLBACK'), 'portal consumption intact');
  assert.ok(appJs.includes('MODULE_ICON_PATHS[type] || MODULE_ICON_FALLBACK'), 'staff consumption intact');
});

check('S2.4 both shells load the shared file BEFORE their main script', () => {
  const p = portalHtml.indexOf('/js/moduleIcons.js');
  const a = staffHtml.indexOf('/js/moduleIcons.js');
  assert.ok(p > -1 && p < portalHtml.indexOf('/js/portal.js'), 'portal order');
  assert.ok(a > -1 && a < staffHtml.indexOf('/js/app.js'), 'staff order');
});

console.log(`BATCH111 REGRESSION PASS — ${n} checks so far (grows per consolidation step)`);
