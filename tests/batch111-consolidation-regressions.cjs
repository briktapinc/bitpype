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

check('S2.1 shared icon file carries all 25 glyphs + the fallback', () => {
  const icons = iconPathsOf(iconsJs);
  assert.equal(Object.keys(icons).length, 26, '26 module glyphs (Batch 126 finisher: +qrcode)');
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

/* ---------------- Step 3 — the .card blocks ---------------- */

const staffCss = read('public/styles.css');

check('S3.1 census: exactly eight bare-card blocks exist, all in portal.js module settings', () => {
  const count = (portalJs.match(/class=\\"card\\"/g) || []).length + (portalJs.match(/class="card"/g) || []).length;
  assert.equal(count, 8, 'eight module-settings .card blocks (Batch 124: Categories display-scopes panel; Batch 126 finisher: QR display panel is the eighth)');
  assert.ok(!portalHtml.includes('class="card"'), 'no static .card markup in portal.html');
});

check('S3.2 the portal gains a #sec-modules-scoped .card rule in the .panel language', () => {
  const idx = portalHtml.indexOf('#sec-modules .card {');
  assert.ok(idx > -1, 'scoped rule exists');
  const body = portalHtml.slice(idx, portalHtml.indexOf('}', idx));
  for (const decl of ['background: var(--surface)', 'border: 1px solid var(--border)', 'border-radius: var(--radius)', 'padding: 18px 20px', 'var(--shadow)'])
    assert.ok(body.includes(decl), `rule carries ${decl}`);
  assert.equal((portalHtml.match(/\n    \.card \{/g) || []).length, 0, 'no UNSCOPED .card rule in the portal (leak guard)');
});

check('S3.3 staff .card (styles.css) untouched by the portal fix', () => {
  const m = staffCss.match(/\.card,\n\.stat-card,\n\.panel \{([^}]*)\}/);
  assert.ok(m, 'staff card group rule intact');
  assert.ok(m[1].includes('padding: 18px 20px'), 'staff card padding intact');
});

/* ---------------- Step 4 — monolith split ---------------- */

const cpFacade = read('server/clientPortal.js');
const maFacade = read('server/museAgent.js');
const { clientPortalSource, museAgentSource } = require('./lib/monolithSource.cjs');

check('S4.1 clientPortal.js is a thin facade over 9 focused modules', () => {
  for (const m of ['portalAccounts', 'portalShared', 'portalSiteEdits', 'portalSocial', 'portalForms', 'portalModules', 'portalBilling', 'portalLeadScout', 'portalSiteChat'])
    assert.ok(cpFacade.includes(`require('./${m}')`), `facade requires ${m}`);
  assert.ok(cpFacade.split('\n').length < 250, `facade is thin (${cpFacade.split('\n').length} lines, was 5993)`);
  const cp = require(path.join(root, 'server', 'clientPortal.js'));
  assert.equal(Object.keys(cp).length, 145, 'facade exports the full surface (145 names; Batch 124 added saveCategoriesDisplaySettings; Batch 125 added the photo capture writes)');
  const chat = require(path.join(root, 'server', 'portalSiteChat.js'));
  assert.equal(cp.runSiteAgentChat, chat.runSiteAgentChat, 're-export identity: runSiteAgentChat');
  const edits = require(path.join(root, 'server', 'portalSiteEdits.js'));
  assert.equal(cp.applyClientTextEdits, edits.applyClientTextEdits, 're-export identity: applyClientTextEdits');
});

check('S4.2 museAgent.js keeps the loops; classifier/planner/tools/core split out', () => {
  for (const m of ['museAgentTools', 'museAgentCore', 'museAgentClassifier', 'museAgentPlanner'])
    assert.ok(maFacade.includes(`require('./${m}')`), `facade requires ${m}`);
  assert.ok(maFacade.split('\n').length < 900, `museAgent shrunk (${maFacade.split('\n').length} lines, was 1519)`);
  assert.ok(maFacade.includes('async function runPortalImproveLoop('), 'improve loop stays in museAgent.js');
  assert.ok(maFacade.includes('async function runJobLoop('), 'job loop stays in museAgent.js');
  const ma = require(path.join(root, 'server', 'museAgent.js'));
  // Batch 120: the facade gained ONE export — resolveAgentConfig,
  // the routed-config resolver the WP design chat + hands-off call.
  assert.equal(Object.keys(ma).length, 18, 'museAgent exports the full original surface + resolveAgentConfig (18 names)');
  const core = require(path.join(root, 'server', 'museAgentCore.js'));
  assert.equal(ma.resolveAgentConfig, core.resolveAgentConfig, 're-export identity: resolveAgentConfig');
  const clf = require(path.join(root, 'server', 'museAgentClassifier.js'));
  assert.equal(ma.classifyPortalChatIntent, clf.classifyPortalChatIntent, 're-export identity: classifyPortalChatIntent');
  const pln = require(path.join(root, 'server', 'museAgentPlanner.js'));
  assert.equal(ma.planPortalChange, pln.planPortalChange, 're-export identity: planPortalChange');
});

check('S4.3 prompt/doctrine text lives verbatim in the new homes (spot pins)', () => {
  const clf = read('server/museAgentClassifier.js');
  const pln = read('server/museAgentPlanner.js');
  assert.ok(clf.includes('function buildClassifierSystemPrompt('), 'classifier prompt builder moved');
  assert.ok(pln.includes('function buildPlannerSystemPrompt('), 'planner prompt builder moved');
  assert.ok(!maFacade.includes('function buildClassifierSystemPrompt('), 'no second copy left in museAgent.js');
  assert.ok(!cpFacade.includes('async function runSiteAgentChat('), 'no chat implementation left in the facade');
  const cps = clientPortalSource();
  const mas = museAgentSource();
  assert.ok(cps.includes('async function runSiteAgentChat('), 'reconstruction: chat pipeline present');
  assert.ok(mas.includes('function buildPortalSystemPrompt('), 'reconstruction: portal prompt present');
});

/* ---------------- Step 5 — design tokens ---------------- */

const tokensCss = read('public/css/tokens.css');
const rootVarsOf = (text) => {
  const m = text.match(/:root\s*\{(.*?)\n\s*\}/s);
  const out = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^\s*(--[\w-]+)\s*:\s*(.+?);?\s*$/);
    if (mm) out[mm[1]] = mm[2].replace(/;$/, '').trim();
  }
  return out;
};
const SHARED_TOKENS = ['--bg', '--surface', '--surface-2', '--ink', '--text', '--muted', '--border', '--border-strong', '--accent', '--accent-dark', '--accent-soft', '--danger', '--danger-dark', '--danger-soft', '--ok', '--ok-soft', '--warn', '--warn-soft', '--info', '--info-soft', '--gold', '--coral', '--plum', '--sidebar', '--sidebar-text', '--sidebar-muted', '--sidebar-w', '--shadow', '--shadow-lg', '--paper', '--teal'];

check('S5.1 tokens.css is the one canonical layer with the current values', () => {
  const tv = rootVarsOf(tokensCss);
  for (const t of SHARED_TOKENS) assert.ok(tv[t], `tokens.css defines ${t}`);
  assert.equal(tv['--surface'], '#fffaf4');
  assert.equal(tv['--bg'], '#f7f1e8');
  assert.equal(tv['--accent'], '#0e7a68');
  assert.equal(tv['--gold'], '#f0b429');
  assert.equal(tv['--paper'], 'var(--surface)');
  assert.equal(tv['--teal'], 'var(--accent)');
  assert.ok(tv['--font-body'].startsWith("Figtree, 'Segoe UI'"), 'font-body stack is the current stack');
  assert.equal(tv['--font-display'], 'Fraunces, Georgia, serif');
});

check('S5.2 neither shell redefines a shared token locally (single source)', () => {
  const pv = rootVarsOf(portalHtml);
  const sv = rootVarsOf(staffCss);
  for (const t of SHARED_TOKENS) {
    assert.ok(!(t in pv), `portal :root no longer defines ${t}`);
    assert.ok(!(t in sv), `staff :root no longer defines ${t}`);
  }
});

check('S5.3 shell-specific tokens stay local at their current values', () => {
  const pv = rootVarsOf(portalHtml);
  const sv = rootVarsOf(staffCss);
  assert.equal(pv['--radius'], '26px', 'portal radius unchanged');
  assert.equal(pv['--card-gap'], '16px', 'Batch 108 card standard unchanged');
  assert.equal(pv['--cream'], 'var(--surface-2)', 'portal cream alias unchanged');
  assert.equal(sv['--radius'], '14px', 'staff radius unchanged');
  assert.equal(sv['--radius-lg'], '26px', 'staff radius-lg unchanged');
  assert.equal(sv['--cream'], '#f7f1e8', 'staff cream unchanged');
});

check('S5.4 all styles.css consumers load tokens.css first; fonts consume tokens', () => {
  assert.ok(portalHtml.indexOf('/css/tokens.css') > -1 && portalHtml.indexOf('/css/tokens.css') < portalHtml.indexOf('<style>'), 'portal loads tokens before its styles');
  assert.ok(staffHtml.indexOf('/css/tokens.css') > -1 && staffHtml.indexOf('/css/tokens.css') < staffHtml.indexOf('/styles.css'), 'staff loads tokens before styles.css');
  const sms = read('public/sms-policy.html');
  assert.ok(sms.indexOf('/css/tokens.css') > -1 && sms.indexOf('/css/tokens.css') < sms.indexOf('/styles.css'), 'sms-policy loads tokens before styles.css');
  assert.ok(portalHtml.includes('font-family: var(--font-body)'), 'portal body consumes --font-body');
  assert.ok(staffCss.includes('font-family: var(--font-body)'), 'staff body consumes --font-body');
  assert.ok(!portalHtml.includes('font-family: Fraunces, Georgia, serif;'), 'no Fraunces literal left in portal');
  assert.ok(!staffCss.includes('font-family: Fraunces, Georgia, serif;'), 'no Fraunces literal left in staff css');
});

console.log(`BATCH111 REGRESSION PASS — ${n} checks so far (grows per consolidation step)`);
