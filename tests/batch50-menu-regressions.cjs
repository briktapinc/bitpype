'use strict';
/**
 * Batch 50 — staff sidebar submenus (Ely 2026-10-28: "the menu on the
 * side is getting too long can we convert some to sub menu").
 *
 * The sidebar stays static HTML in public/index.html (anchors carry
 * icons + labels, unchanged); public/js/navGroups.js is the data-driven
 * structure (NAV_TOP_LEVEL + NAV_GROUPS) that app.js uses for
 * expand/collapse state, and this file pins the two to each other:
 *
 *  - the full sidebar inventory (28 items: label + href + route — the
 *    25 pre-Batch-50 items plus Batch 49's Finance, Batch 71's Mailing
 *    list and Batch 80's Partner earnings) survives verbatim —
 *    no item lost, no label renamed, no route moved;
 *  - every inventory route appears EXACTLY ONCE across the config;
 *  - group membership + labels are pinned;
 *  - the Money group carries Batch 49's Finance item, slotted into the
 *    reserved FINANCE_SLOT at integration;
 *  - auto-expand logic (navResolveExpanded) is unit-tested: the group
 *    holding the current route always opens, stored choices persist
 *    for the rest, top-level routes force nothing;
 *  - HTML structure: one keyboard-focusable toggle button per group
 *    (aria-expanded + aria-controls wired to a real submenu id),
 *    sections ship WITHOUT .collapsed (no-JS = full menu), the Admin
 *    anchor keeps id="nav-admin" + hidden inside the System group;
 *  - app.js wiring: localStorage key, toggle handler, syncNavGroups
 *    called from navigate(), navGroups.js loaded before app.js;
 *  - CSS hooks: collapsed submenus hide, chevron rotates, the mobile
 *    off-canvas rule is untouched.
 *
 * NEGATIVE PROOF (run at build time): removing 'archives' from the
 * Work group in navGroups.js fails the exactly-once check → restored,
 * green.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}

const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const navSrc = fs.readFileSync(path.join(root, 'public/js/navGroups.js'), 'utf8');
const NavGroups = require(path.join(root, 'public/js/navGroups.js'));

/* The sidebar inventory, in sidebar order: the pre-Batch-50 flat list
   plus Batch 49's Finance (which joined the flat sidebar after Billing
   and now sits in the Money group). [route, label] — href is `#/<route>`. */
const INVENTORY = [
  ['dashboard', 'Dashboard'],
  ['leads', 'Leads'],
  ['websites', 'Websites'],
  ['fingerprints', 'Fingerprints'], // Batch 156: the fingerprint ledger joins the top level beside Websites
  ['archives', 'Archives'],
  ['domains', 'Domains'],
  ['design', 'Design'],
  ['outreach', 'Outreach'],
  ['pipeline', 'Pipeline'],
  ['forms', 'Forms'],
  ['leadscout', 'LeadScout'],
  ['bookings', 'Bookings'],
  ['shop', 'Shop'],
  ['memberships', 'Memberships'],
  ['calls', 'Calls'],
  ['seo', 'SEO'],
  ['rentals', 'Rentals'],
  ['modules', 'Modules'],
  ['courses', 'Courses'],
  ['social', 'Social'],
  ['analytics', 'Analytics'],
  ['jobs', 'Jobs'],
  ['mcp', 'MCP'],
  ['settings', 'Settings'],
  ['billing', 'Billing'],
  ['finance', 'Finance'],
  // Batch 80: Partner earnings joins the Money group (partner-only
  // hidden gate, unhidden for partner accounts at boot). Deliberate
  // inventory growth, not drift.
  ['partner-earnings', 'Partner earnings'],
  ['admin', 'Admin'],
  // Batch 71: the Admin mailing list joins the System group (super-admin
  // hidden gate, like Admin). Deliberate inventory growth, not drift.
  ['mailing-list', 'Mailing list'],
];

function sidebarAnchors() {
  const start = indexHtml.indexOf('<nav class="nav-links"');
  const end = indexHtml.indexOf('</nav>', start);
  assert.ok(start >= 0 && end > start, 'sidebar nav exists in index.html');
  const nav = indexHtml.slice(start, end);
  const out = [];
  const re = /<a\s+href="([^"]+)"\s+data-route="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(nav)) !== null) {
    const label = m[3].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ');
    out.push({ href: m[1], route: m[2], label });
  }
  return out;
}

check('inventory: all items (25 pre-Batch-50 + Finance + Batch 71 Mailing list + Batch 80 Partner earnings + Batch 156 Fingerprints) survive with labels + routes unchanged', () => {
  const anchors = sidebarAnchors();
  assert.equal(anchors.length, INVENTORY.length, `expected ${INVENTORY.length} sidebar anchors, got ${anchors.length}`);
  const byRoute = new Map(anchors.map((a) => [a.route, a]));
  for (const [route, label] of INVENTORY) {
    const a = byRoute.get(route);
    assert.ok(a, `sidebar still links ${route}`);
    assert.equal(a.href, `#/${route}`, `${route} href unchanged`);
    assert.equal(a.label, label, `${route} label unchanged (no renames)`);
  }
});

check('config: every inventory route appears exactly once across top-level + groups', () => {
  const all = [...NavGroups.NAV_TOP_LEVEL, ...NavGroups.NAV_GROUPS.flatMap((g) => g.items)];
  assert.equal(all.length, INVENTORY.length, `config covers ${all.length} routes, inventory has ${INVENTORY.length}`);
  assert.deepEqual([...all].sort(), INVENTORY.map(([r]) => r).sort(), 'config route set == inventory route set');
  assert.equal(new Set(all).size, all.length, 'no route appears twice');
});

check('config: top-level daily drivers + group labels/membership pinned', () => {
  assert.deepEqual(NavGroups.NAV_TOP_LEVEL, ['dashboard', 'leads', 'websites', 'fingerprints']); // Batch 156: fingerprints top-level
  assert.deepEqual(
    NavGroups.NAV_GROUPS.map((g) => [g.id, g.label]),
    [
      ['work', 'Work'],
      ['domains-calls', 'Domains & Calls'],
      ['site-tools', 'Site tools'],
      ['money', 'Money'],
      ['system', 'System'],
    ]
  );
  const byId = Object.fromEntries(NavGroups.NAV_GROUPS.map((g) => [g.id, g.items]));
  assert.deepEqual(byId['work'], ['archives', 'design', 'outreach', 'pipeline']);
  assert.deepEqual(byId['domains-calls'], ['domains', 'calls']);
  assert.deepEqual(byId['site-tools'], [
    'forms', 'leadscout', 'bookings', 'shop', 'memberships', 'seo', 'rentals', 'modules', 'courses', 'social', 'analytics',
  ]);
  assert.deepEqual(byId['system'], ['jobs', 'mcp', 'settings', 'admin', 'mailing-list']);
});

check('config: Money group carries Billing + Finance (Batch 49 slotted into the FINANCE_SLOT) + Partner earnings (Batch 80)', () => {
  const money = NavGroups.NAV_GROUPS.find((g) => g.id === 'money');
  assert.deepEqual(money.items, ['billing', 'finance', 'partner-earnings'], 'Money holds Billing + Finance + Partner earnings after integration');
  assert.equal(NavGroups.navGroupForRoute('finance'), 'money', 'finance routes to the Money group');
  assert.ok(!navSrc.includes('FINANCE_SLOT'), 'the FINANCE_SLOT marker is consumed by the integration');
});

check('logic: navGroupForRoute maps grouped routes, null for top-level/unknown', () => {
  assert.equal(NavGroups.navGroupForRoute('calls'), 'domains-calls');
  assert.equal(NavGroups.navGroupForRoute('billing'), 'money');
  assert.equal(NavGroups.navGroupForRoute('seo'), 'site-tools');
  assert.equal(NavGroups.navGroupForRoute('admin'), 'system');
  assert.equal(NavGroups.navGroupForRoute('dashboard'), null);
  assert.equal(NavGroups.navGroupForRoute('websites'), null);
  assert.equal(NavGroups.navGroupForRoute('fingerprints'), null); // Batch 156: top-level, no group
  assert.equal(NavGroups.navGroupForRoute('nope'), null);
  assert.equal(NavGroups.navGroupForRoute(''), null);
});

check('logic: navResolveExpanded auto-expands the active group and persists the rest', () => {
  // First visit, route inside a group → only that group opens.
  assert.deepEqual(NavGroups.navResolveExpanded('seo', {}), { 'site-tools': true });
  // Stored choice for another group is respected alongside the forced one.
  assert.deepEqual(NavGroups.navResolveExpanded('seo', { work: false }), { work: false, 'site-tools': true });
  // A group the user explicitly closed re-opens when they navigate into it.
  assert.deepEqual(NavGroups.navResolveExpanded('design', { work: false }), { work: true });
  // Top-level route forces nothing; stored state passes through untouched.
  assert.deepEqual(NavGroups.navResolveExpanded('leads', { 'site-tools': true }), { 'site-tools': true });
  // Input is never mutated.
  const stored = { work: false };
  NavGroups.navResolveExpanded('design', stored);
  assert.deepEqual(stored, { work: false }, 'stored map not mutated');
});

check('html: one accessible toggle per group, wired to a real submenu; sections ship expanded', () => {
  for (const g of NavGroups.NAV_GROUPS) {
    const btn = new RegExp(`<button type="button" class="nav-group-toggle" data-nav-toggle="${g.id}" aria-expanded="[^"]*" aria-controls="nav-sub-${g.id}">`);
    assert.ok(btn.test(indexHtml), `${g.id} toggle button with aria wiring`);
    assert.ok(indexHtml.includes(`<div class="nav-submenu" id="nav-sub-${g.id}"`), `${g.id} submenu exists`);
    assert.ok(indexHtml.includes(`<div class="nav-section" data-nav-group="${g.id}">`), `${g.id} section wrapper exists`);
  }
  assert.equal((indexHtml.match(/data-nav-toggle=/g) || []).length, NavGroups.NAV_GROUPS.length, 'exactly one toggle per group');
  assert.ok(!indexHtml.includes('nav-section collapsed'), 'no section ships collapsed — without JS the full menu stays reachable');
});

check('html: grouped anchors live inside their group submenu; Admin keeps its hidden gate', () => {
  for (const g of NavGroups.NAV_GROUPS) {
    const start = indexHtml.indexOf(`id="nav-sub-${g.id}"`);
    const end = indexHtml.indexOf('</nav>', start);
    const region = indexHtml.slice(start, end);
    for (const route of g.items) {
      const at = region.indexOf(`data-route="${route}"`);
      assert.ok(at >= 0, `${route} anchor is inside the ${g.id} submenu`);
      // its anchor must come before the next section starts
      const nextSection = region.indexOf('data-nav-group=', at);
      assert.ok(nextSection === -1 || at < nextSection, `${route} sits in ${g.id}, not a later group`);
    }
  }
  assert.ok(indexHtml.includes('id="nav-admin"'), 'Admin anchor keeps id="nav-admin"');
  assert.ok(/data-route="admin"[^>]*class="hidden"/.test(indexHtml), 'Admin anchor keeps the hidden class gate');
  assert.ok(indexHtml.includes('id="shell-automation"'), 'automation status link below the nav is untouched');
});

check('app.js wiring: persistence key, toggle handler, navigate() sync, script order', () => {
  assert.ok(appSrc.includes("'scout.navGroups'"), 'expansion state persists under scout.navGroups');
  assert.ok(appSrc.includes("querySelector('[data-nav-toggle]')") || appSrc.includes('[data-nav-toggle]'), 'toggle buttons are queried');
  assert.ok(appSrc.includes("addEventListener('click'"), 'toggle click handler registered');
  assert.ok(appSrc.includes('navResolveExpanded(route, navStoredState)'), 'navigate-time resolution uses the pure helper');
  assert.ok(appSrc.includes('syncNavGroups(route);'), 'navigate() syncs the sidebar groups');
  assert.ok(appSrc.includes("setAttribute('aria-expanded'"), 'aria-expanded is kept in sync with state');
  const navScript = indexHtml.indexOf('/js/navGroups.js');
  const appScript = indexHtml.indexOf('/js/app.js');
  assert.ok(navScript >= 0 && appScript > navScript, 'navGroups.js loads before app.js');
});

check('css: collapsed state hides submenus, chevron rotates, mobile off-canvas untouched', () => {
  assert.ok(css.includes('.nav-section.collapsed .nav-submenu'), 'collapsed submenu rule exists');
  assert.ok(css.includes('.nav-group-toggle'), 'toggle styling exists');
  assert.ok(css.includes('.nav-section.collapsed .nav-chevron'), 'chevron rotation rule exists');
  assert.ok(/\.nav-group-toggle:focus-visible/.test(css), 'keyboard focus style on toggles');
  assert.ok(/@media \(max-width: 900px\)[\s\S]*?\.app-shell\.nav-open \.sidebar/.test(css), 'mobile drawer rule unchanged');
  assert.ok(/\.sidebar\s*\{[^}]*overflow-y: auto/.test(css), 'sidebar stays scrollable so no group can be clipped');
});

console.log(`batch50-menu-regressions: ${results.length} checks passed`);
for (const name of results) console.log(`  ok - ${name}`);
console.log(JSON.stringify({ file: 'batch50-menu-regressions', checks: results.length, passed: true }));
