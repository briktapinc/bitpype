'use strict';
/**
 * Batch 91 — module buttons become small clickable cards with icons
 * (Ely, 2026-10-30: "Design module buttons as small clickable cards
 * instead, 5 or 6 in a row whichever allows them to fit so they don't
 * look like crammed up buttons" + "Add icons to make it cool"; scope
 * confirmed for BOTH the client portal and the staff app).
 *
 * Presentation only — no behavior, endpoint, permission or catalog
 * changes. Pins:
 *   A — portal Modules panel: the module type tabs are now a card
 *       grid (5 across on desktop: the 932px portal column fits ~175px
 *       cards at 5, ~145px at 6 — 5 is the roomy fit; steps 4/3/2 on
 *       narrower screens), whole-card <button> click target, hover +
 *       focus-visible + is-active states, "On site" live pill, count
 *       meta line; the old .module-tab treatment is gone.
 *   B — portal icon system: a curated inline-SVG family beside the
 *       catalog (MODULE_ICON_PATHS), one glyph per module type,
 *       generic fallback, charts + datatables included, no emoji /
 *       no external refs. Batch 111: the map is single-sourced in
 *       public/js/moduleIcons.js, loaded by BOTH shells before their
 *       main scripts — B2 pins that shared-source wiring (the two
 *       byte-identical per-file copies are gone);
 *       the Batch 29 effective-set filter and the click delegation
 *       are untouched.
 *   C — portal Insert-block picker: entries are mini cards in a 2-up
 *       grid carrying the same icon family; every data-structure-*
 *       hook the picker logic depends on is unchanged.
 *   D — staff Modules page: the catalog chips are now icon cards in a
 *       6-across grid (the staff view is ~1390px wide, so 6 fits
 *       roomy), display-only exactly as the chips were; the shared
 *       .chip styles other staff surfaces use are untouched, and the
 *       installs table + delete flow are unchanged.
 *   E — no-behavior-change guards: module catalog still 25 types on
 *       server + portal; attach/detach/purge controls intact.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const portalHtml = read('public/portal.html');
const portalJs = read('public/js/portal.js');
const appJs = read('public/js/app.js');
const staffHtml = read('public/index.html');
const moduleIconsJs = read('public/js/moduleIcons.js');
const staffCss = read('public/styles.css');

let n = 0;
const check = (name, fn) => {
  fn();
  n += 1;
  console.log(`ok ${n} - ${name}`);
};

/* ---------------- A — portal Modules panel card grid ---------------- */

check('A1 side nav is a 5-across card grid on desktop', () => {
  const m = portalHtml.match(/\.modules-side-nav \{([^}]*)\}/);
  assert.ok(m, 'modules-side-nav rule exists');
  assert.ok(m[1].includes('display: grid'), 'grid display');
  assert.ok(m[1].includes('grid-template-columns: repeat(5, minmax(0, 1fr))'), '5 columns at desktop width');
  // Batch 108: the gap is the portal-wide --card-gap standard (16px),
  // superseding the original 12px pin — one uniform card gap everywhere.
  assert.ok(m[1].includes('gap: var(--card-gap)'), 'uniform card gap (Batch 108)');
});

check('A2 grid steps down 4 / 3 / 2 on narrower screens', () => {
  assert.ok(portalHtml.includes('@media (max-width: 900px)') && portalHtml.includes('grid-template-columns: repeat(4, minmax(0, 1fr))'), '4 across <=900px');
  assert.ok(portalHtml.includes('@media (max-width: 700px)') && portalHtml.includes('grid-template-columns: repeat(3, minmax(0, 1fr))'), '3 across <=700px');
  assert.ok(portalHtml.includes('@media (max-width: 520px)') && portalHtml.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'), '2 across <=520px');
});

check('A3 module card styles: roomy padding, hover, focus, active', () => {
  const m = portalHtml.match(/\.module-card \{([^}]*)\}/);
  assert.ok(m, 'module-card rule exists');
  assert.ok(m[1].includes('padding: 14px'), 'generous internal padding');
  assert.ok(m[1].includes('border-radius: 16px'), 'card radius');
  assert.ok(m[1].includes('cursor: pointer'), 'clickable affordance');
  assert.ok(portalHtml.includes('.module-card:hover'), 'hover state');
  assert.ok(portalHtml.includes('.module-card:focus-visible'), 'visible keyboard focus');
  assert.ok(portalHtml.includes('.module-card.is-active'), 'selected state');
  assert.ok(portalHtml.includes('.module-card-live'), 'on-site pill');
  assert.ok(portalHtml.includes('.module-card-icon'), 'icon chip');
});

check('A4 old tab treatment is gone; layout is a single column stack', () => {
  assert.ok(!portalHtml.includes('.module-tab'), 'no .module-tab CSS left in portal.html');
  assert.ok(!portalJs.includes('module-tab'), 'no module-tab markup left in portal.js');
  assert.ok(!portalHtml.includes('grid-template-columns: minmax(168px, 220px) minmax(0, 1fr)'), 'old sidebar grid removed');
  const m = portalHtml.match(/\.modules-admin \{([^}]*)\}/);
  assert.ok(m && m[1].includes('flex-direction: column'), 'modules-admin stacks: cards above, admin below');
});

check('A5 group headings span the grid; panel structure intact', () => {
  const m = portalHtml.match(/\.modules-side-group \{([^}]*)\}/);
  assert.ok(m && m[1].includes('grid-column: 1 / -1'), 'group label spans all columns');
  assert.ok(portalHtml.includes('id="modules-type-tabs"'), 'nav container id unchanged');
  assert.ok(portalHtml.includes('id="modules-app"'), 'modules app container unchanged');
});

/* ---------------- B — icon system + render ---------------- */

const moduleTypesOf = (src) => {
  const m = src.match(/const MODULE_TYPES = \[(.*?)\];/s);
  assert.ok(m, 'MODULE_TYPES found');
  return [...m[1].matchAll(/type: '([a-z]+)'/g)].map((x) => x[1]);
};
const iconPathsOf = (src) => {
  const m = src.match(/const MODULE_ICON_PATHS = \{(.*?)\n\};/s) || src.match(/const MODULE_ICON_PATHS = \{(.*?)\n  \};/s);
  assert.ok(m, 'MODULE_ICON_PATHS found');
  return Object.fromEntries([...m[1].matchAll(/(\w+): '([^']*)'/g)].map((x) => [x[1], x[2]]));
};

check('B1 every portal module type has an icon; fallback exists', () => {
  const types = moduleTypesOf(portalJs);
  const icons = iconPathsOf(moduleIconsJs);
  assert.equal(types.length, 30, 'portal catalog 30 types (Batch 124: categories; Batch 125: photocapture; Batch 128: checkout; Batch 131: comments; Batch 139: pricing)');
  for (const t of types) assert.ok(icons[t] && icons[t].includes('<'), `${t} has a glyph`);
  assert.ok(icons.charts, 'charts has its own glyph');
  assert.ok(icons.datatables, 'datatables has its own glyph');
  assert.ok(moduleIconsJs.includes('const MODULE_ICON_FALLBACK'), 'generic fallback defined in the shared source');
  assert.ok(portalJs.includes('MODULE_ICON_PATHS[type] || MODULE_ICON_FALLBACK'), 'fallback wired into moduleIconSvg');
});

check('B2 both shells consume the ONE shared icon source (Batch 111)', () => {
  const types = moduleTypesOf(portalJs);
  const icons = iconPathsOf(moduleIconsJs);
  for (const t of types) assert.ok(icons[t], `shared map has ${t}`);
  assert.ok(!portalJs.includes('const MODULE_ICON_PATHS = {'), 'portal.js no longer carries its own copy');
  assert.ok(!appJs.includes('const MODULE_ICON_PATHS = {'), 'app.js no longer carries its own copy');
  assert.ok(!portalJs.includes('const MODULE_ICON_FALLBACK'), 'portal.js no longer defines the fallback');
  assert.ok(!appJs.includes('const MODULE_ICON_FALLBACK'), 'app.js no longer defines the fallback');
  const pIdx = portalHtml.indexOf('/js/moduleIcons.js');
  const aIdx = staffHtml.indexOf('/js/moduleIcons.js');
  assert.ok(pIdx > -1 && pIdx < portalHtml.indexOf('/js/portal.js'), 'portal.html loads moduleIcons.js before portal.js');
  assert.ok(aIdx > -1 && aIdx < staffHtml.indexOf('/js/app.js'), 'index.html loads moduleIcons.js before app.js');
  assert.ok(appJs.includes('MODULE_ICON_PATHS[type] || MODULE_ICON_FALLBACK'), 'staff fallback wiring intact');
});

check('B3 icon family is one stroke system, no emoji, no external refs', () => {
  const m = moduleIconsJs.match(/const MODULE_ICON_PATHS = \{(.*?)\n\};/s);
  assert.ok(m);
  assert.ok([...m[1]].every((ch) => ch.charCodeAt(0) < 128), 'icon paths are pure ASCII (no emoji)');
  assert.ok(!m[1].includes('http'), 'no external references in icon paths');
  const svg = portalJs.match(/function moduleIconSvg\(type\) \{\s*return `<svg([^`]*)>/);
  assert.ok(svg, 'moduleIconSvg builds the svg');
  assert.ok(svg[1].includes('viewBox="0 0 24 24"'), 'shared 24x24 grid');
  assert.ok(svg[1].includes('stroke-width="1.8"'), 'shared stroke weight');
  assert.ok(svg[1].includes('stroke="currentColor"'), 'currentColor stroke');
  assert.ok(!portalJs.includes('iconify') && !portalJs.includes('font-awesome') && !appJs.includes('font-awesome'), 'no icon font/CDN');
});

check('B4 card render: whole-card button, icon, live pill, count meta', () => {
  const fn = portalJs.slice(portalJs.indexOf('function renderModuleTypeTabs()'));
  const body = fn.slice(0, fn.indexOf('\n  function '));
  assert.ok(body.includes('class="module-card'), 'renders module-card');
  assert.ok(body.includes('data-module-type="${esc(type)}"'), 'type hook unchanged');
  assert.ok(body.includes('role="tab"') && body.includes('aria-selected'), 'tab semantics kept');
  assert.ok(body.includes("sel ? ' is-active' : ''"), 'selected state kept');
  assert.ok(body.includes('moduleIconSvg(type)'), 'icon rendered per type');
  assert.ok(body.includes('moduleIconTint(type)'), 'group tint applied');
  assert.ok(body.includes('module-card-live'), 'on-site pill rendered');
  assert.ok(body.includes('module-card-meta'), 'meta line rendered');
  assert.ok(body.includes('moduleCopy(type).plural'), 'meta text is catalog data (item noun), not invented copy');
});

check('B5 behavior guards: effective-set filter + click delegation untouched', () => {
  assert.ok(portalJs.includes('if (summaryList.length && !summary) return \'\';'), 'Batch 29 filter intact (restricted types never render)');
  assert.ok(portalJs.includes("ev.target.closest('[data-module-type]')"), 'delegated click handler intact');
  assert.ok(portalJs.includes("moduleState.current = btn.getAttribute('data-module-type')"), 'selection flow intact');
});

/* ---------------- C — Insert-block picker mini cards ---------------- */

check('C1 picker entries render as mini cards with icons', () => {
  const fn = portalJs.slice(portalJs.indexOf('function renderBlockPickerGroups('));
  const body = fn.slice(0, fn.indexOf('\n  function '));
  assert.ok(body.includes('class="picker-card"'), 'picker-card class on entries');
  assert.ok(body.includes('picker-card-icon'), 'icon chip on entries');
  assert.ok(body.includes('blockIconSvg(b.type)'), 'design blocks use block glyphs');
  assert.ok(body.includes("blockIconSvg('form')"), 'forms use the form glyph');
  assert.ok(body.includes('moduleIconSvg(m.type)'), 'site modules reuse the module glyphs');
});

check('C2 picker hooks unchanged (insert logic depends on them)', () => {
  const fn = portalJs.slice(portalJs.indexOf('function renderBlockPickerGroups('));
  const body = fn.slice(0, fn.indexOf('\n  function '));
  for (const hook of ['data-structure-section-type', 'data-structure-cols', 'data-structure-form-id', 'data-structure-module-type']) {
    assert.ok(body.includes(hook), `${hook} still emitted`);
  }
  assert.ok(portalJs.includes("ev.target.closest('[data-structure-module-type]')"), 'module pick delegation intact');
  assert.ok(portalJs.includes("ev.target.closest('[data-structure-section-type]')"), 'section pick delegation intact');
  assert.ok(portalJs.includes("ev.target.closest('[data-structure-form-id]')"), 'form pick delegation intact');
});

check('C3 picker CSS: 2-up mini-card grid in a widened modal', () => {
  assert.ok(portalHtml.includes('.modal.structure-module-modal { max-width: 560px; }'), 'modal widened for cards');
  const m = portalHtml.match(/\.structure-block-group \{([^}]*)\}/);
  assert.ok(m && m[1].includes('grid-template-columns: 1fr 1fr'), 'groups render 2-up');
  assert.ok(portalHtml.includes('.picker-card-icon'), 'picker icon chip styled');
  assert.ok(portalHtml.includes('.structure-module-list button:focus-visible'), 'picker keyboard focus visible');
});

/* ---------------- D — staff Modules page catalog cards ---------------- */

check('D1 staff catalog renders icon cards, not chips', () => {
  const fn = appJs.slice(appJs.indexOf('async function pageModules()'));
  const body = fn.slice(0, fn.indexOf('\nasync function ') > 0 ? fn.indexOf('\nasync function ') : fn.length);
  assert.ok(body.includes('class="modcat-grid"'), 'catalog grid container');
  assert.ok(body.includes('class="modcat-card"'), 'catalog cards');
  assert.ok(body.includes('moduleIconSvg(c.type)'), 'per-type icon');
  assert.ok(body.includes('installed</span>'), 'installed count meta kept');
  assert.ok(!body.includes('<div class="chips">${catalog'), 'old chips row gone from the Modules page');
});

check('D2 staff catalog is ONE horizontally scrollable row (Batch 115)', () => {
  // Batch 115 (Ely's order 2026-11-01, from his screenshot): the
  // wrapped 6/4/3/2 grid this check used to pin is gone BY HIS
  // DIRECT INSTRUCTION — the catalog is a single flex row with
  // native horizontal scroll at every width, uniform fixed-width
  // cards, and the Batch 108 16px gap standard.
  const m = staffCss.match(/\.modcat-grid \{([^}]*)\}/);
  assert.ok(m, 'modcat-grid rule exists');
  assert.ok(m[1].includes('display: flex'), 'catalog is a flex row');
  assert.ok(m[1].includes('flex-wrap: nowrap'), 'row never wraps');
  assert.ok(m[1].includes('overflow-x: auto'), 'row scrolls horizontally');
  assert.ok(m[1].includes('gap: 16px'), 'uniform 16px gap (Batch 108 card standard)');
  assert.ok(!/\.modcat-grid\s*\{[^}]*grid-template-columns/.test(staffCss), 'no modcat grid columns remain at any breakpoint');
  const card = staffCss.match(/\.modcat-card \{([^}]*)\}/);
  assert.ok(card && card[1].includes('flex: 0 0 171px'), 'cards uniform fixed width (the measured 1440 grid width), never shrink');
  assert.ok(staffCss.includes('.modcat-icon'), 'icon chip styles');
});

check('D3 shared chip styles and staff delete flow untouched', () => {
  assert.ok(staffCss.includes('.chip {'), 'shared .chip styles remain for other surfaces');
  assert.ok(staffCss.includes('.chip.active'), 'shared .chip states remain');
  assert.ok(appJs.includes('data-mod-del'), 'per-install delete hook intact');
  assert.ok(appJs.includes('adminDeleteModuleInstall'), 'delete endpoint wiring intact');
  assert.ok(appJs.includes('adminClearAllModules'), 'clear-all wiring intact');
});

/* ---------------- E — no behavior / catalog change ---------------- */

check('E1 module catalog unchanged on server and portal', () => {
  const sm = require(path.join(root, 'server/siteModules.js'));
  assert.equal(sm.MODULE_TYPES.length, 30, 'server catalog 30 types (Batch 124: categories; Batch 125: photocapture added; Batch 128: checkout; Batch 131: comments; Batch 139: pricing)');
  assert.ok(sm.MODULE_TYPES.includes('charts') && sm.MODULE_TYPES.includes('datatables'), 'charts + datatables still present');
  assert.equal(moduleTypesOf(portalJs).length, 30, 'portal catalog 30 types (Batch 125: photocapture added; Batch 128: checkout; Batch 131: comments; Batch 139: pricing)');
});

check('E2 attach / detach / purge controls intact in the portal panel', () => {
  for (const id of ['btn-modules-attach', 'btn-modules-detach', 'btn-modules-purge', 'btn-modules-new', 'modules-target-page']) {
    assert.ok(portalHtml.includes(`id="${id}"`), `${id} present`);
  }
});

console.log(`BATCH91-MODULE-CARDS: ${n} checks passed`);
