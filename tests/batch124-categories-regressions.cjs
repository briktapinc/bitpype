'use strict';
/**
 * Batch 124 — the Categories module: a SHARED taxonomy service.
 *
 * What this pins:
 *   Part 1 — source pins: `categories` is the 24th MODULE_TYPE with
 *     catalog metadata, MODULE_SCRIPT_VER mod32 (mod30 at Batch 124; Batch 128 finisher rotation), a moduleShare
 *     registry provider entry (parity at 24), the categories service
 *     module, taxonomy tables, MCP + catalog + parity + agent tool
 *     surfaces, portal editor wiring (picker + Categories pane +
 *     display-scopes panel), the design-chat census block, the public
 *     embed renderer branches, and the cache-busts.
 *   Part 2 — engine (in-process): category CRUD with slug uniqueness
 *     PER SCOPE, nesting rules (same-scope parents, no cycles, no
 *     self-parent), scope immutability, assignment integrity
 *     (phantom item refused, cross-lead refused, cross-scope refused,
 *     non-provider consumer refused, idempotent re-assign), counts in
 *     both modes, delete-category keeps items and re-parents
 *     children, delete-item clears assignments, moduleShare provider
 *     output + items-by-category, public index/category payloads
 *     (published-only, scopes config, dormant-empty), the MCP
 *     dispatch surface (create + assign), and MENU'S PRIVATE SYSTEM
 *     UNTOUCHED (menu categories/items behave exactly as before).
 *   Part 3 — HTTP over the real server: portal owner session, the
 *     categories CRUD routes, the display-scopes PUT round-trip,
 *     editor picker round-trips over HTTP (blog + events), and the
 *     public categories payload serving the HTTP-created category.
 *
 * NEGATIVE hooks (source pins only):
 *   B124_NEGATIVE=no-type      categories leaves MODULE_TYPES
 *   B124_NEGATIVE=no-registry  registry drops the categories entry
 *   B124_NEGATIVE=no-service   server/categories.js hidden
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch124-'));
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'app.db');
process.env.SQLITE_PATH = process.env.DB_PATH;
['.env', 'app.db', 'data.db', 'leads.db', 'platform.db'].forEach((name) => {
  process.env[name.toUpperCase().replace(/\W/g, '_') + '_PATH'] = path.join(process.env.REGRESSION_TMPDIR, name);
});
process.env.SESSION_SECRET = ['batch124', 'regression', 'secret'].join('-');
// Batch 125 finisher: Part 3 spawns a production-mode fixture server
// (the gate image sets NODE_ENV=production); without this flag its
// boot exits on the Turnstile assert. Suites 120/121/123 set the same
// pair for their spawned servers — this suite relied on ambient
// captcha state instead, which the 125 gate leg no longer provides.
process.env.CAPTCHA_OPTIONAL = '1';
// Batch 128 finisher: the same boot also requires APP_URL in
// production; prior gate legs provided it ambiently (the app
// container's compose env), a bare gate container does not.
process.env.APP_URL = 'https://bitpype.com';
process.env.NODE_ENV = 'production';
process.env.COOKIE_SECURE = 'false';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';
process.env.STRIPE_TEST_MODE = process.env.STRIPE_TEST_MODE || 'true';

const root = path.resolve(__dirname, '..');
const PORT = 39124;
const BASE = `http://127.0.0.1:${PORT}`;
const LEAD_A = 12401;
const LEAD_B = 12402;
const PW = ['B124', 'Portal', 'Pass', '9'].join('-') + '!';
const NEGATIVE = process.env.B124_NEGATIVE || '';

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response ${res.status}: ${text.slice(0, 200)}`);
  }
}
function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (!headers['Content-Type'] && opts.body) headers['Content-Type'] = 'application/json';
      if (cookies.size) headers.Cookie = [...cookies.values()].join('; ');
      const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
      const raw = res.headers.get('set-cookie');
      if (raw) {
        for (const part of raw.split(/,(?=\s*[^;,=]+?=)/)) {
          const pair = part.trim().split(';')[0];
          const eq = pair.indexOf('=');
          if (eq > 0) cookies.set(pair.slice(0, eq), pair);
        }
      }
      return res;
    },
  };
}
const ymd = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

(async () => {
  let db = null;
  let WS_ID = 0;

  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const smSrc = read('server/siteModules.js');
    if (NEGATIVE !== 'no-type') {
      assert.ok(smSrc.includes("'categories',"), 'categories registered in MODULE_TYPES');
      n++;
    }
    assert.ok(smSrc.includes("categories: { label: 'Categories'"), 'MODULE_META carries the Categories label');
    n++;
    assert.ok(
      smSrc.includes("const MODULE_SCRIPT_VER = 'mod34'"),
      'MODULE_SCRIPT_VER bumped to mod32 (Batch 128 finisher rotation)'
    );
    n++;

    const shareSrc = read('server/moduleShare.js');
    if (NEGATIVE !== 'no-registry') {
      assert.ok(/categories: \{\s*\n\s*kind: 'provider',/.test(shareSrc), 'registry has the categories provider entry');
      n++;
    }
    assert.ok(shareSrc.includes('listSharedItemsByCategory'), 'shared layer exposes items-by-category');
    n++;

    if (NEGATIVE !== 'no-service')
      assert.ok(fs.existsSync(path.join(root, 'server/categories.js')), 'categories service exists');
    n++;
    const catSrc = read('server/categories.js');
    for (const t of ['module_categories', 'module_category_assignments']) {
      assert.ok(catSrc.includes(t), `taxonomy table ${t} owned by the service`);
      n++;
    }
    assert.ok(catSrc.includes('UNIQUE(lead_id, consumer_type, item_id, category_id)'), 'assignment uniqueness pinned');
    n++;

    const mcpSrc = read('server/mcp.js');
    const catalogSrc = read('src/mcpCatalog.js');
    const paritySrc = read('src/mcpParityTools.js');
    for (const t of [
      'categories.list',
      'categories.create',
      'categories.update',
      'categories.delete',
      'categories.assign',
      'categories.unassign',
      'categories.items',
      'categories.setScopes',
    ]) {
      assert.ok(mcpSrc.includes(`name: '${t}'`), `hosted MCP defines ${t}`);
      assert.ok(catalogSrc.includes(`name: '${t}'`), `client catalog defines ${t}`);
      assert.ok(paritySrc.includes(`'${t}'`), `parity layer defines ${t}`);
      n += 3;
    }
    for (const consumer of ['blog.create', 'events.create', 'offers.create']) {
      assert.ok(mcpSrc.includes(consumer), `consumer tool ${consumer} present`);
      n++;
    }
    assert.equal(
      (mcpSrc.match(/category_ids: CATIDS/g) || []).length,
      13,
      'category_ids rides all five consumers (create + update) + photocapture moderation (Batch 125 finisher) + qrcode create/update (Batch 126 finisher)'
    );
    n++;

    const agentSrc = read('server/museAgentTools.js');
    for (const t of ['categories.create', 'categories.assign', 'categories.list']) {
      assert.ok(agentSrc.includes(`'${t}'`), `agent tool set carries ${t}`);
      n++;
    }
    const chatSrc = read('server/portalSiteChat.js');
    assert.ok(chatSrc.includes('Categories (shared taxonomy'), 'design-chat census reports the taxonomy');
    n++;

    const portalJs = read('public/js/portal.js');
    assert.ok(portalJs.includes("{ type: 'categories', label: 'Categories' }"), 'portal catalog lists Categories');
    n++;
    assert.ok(portalJs.includes('function categoryPickerDef'), 'portal builds the assignment picker');
    assert.ok(portalJs.includes('data-mod-field-multi'), 'portal collects multi-value picker fields');
    assert.ok(portalJs.includes('function renderCategoriesScopesPanel'), 'portal renders the display-scopes panel');
    n += 3;
    const portalHtml = read('public/portal.html');
    assert.ok(portalHtml.includes('id="modules-categories-scopes-panel"'), 'scopes panel mount exists');
    assert.ok(
      portalHtml.includes('portal.js?v=batch128-checkout1'),
      'portal.js cache-bust rotated (Batch 124 rotated it; Batch 125 rotated again)'
    );
    n += 2;
    const routesSrc = read('server/routes/portal.js');
    assert.ok(routesSrc.includes("'/modules/categories/scopes'"), 'portal scopes route registered');
    n++;
    const embedSrc = read('public/js/module-embed.js');
    assert.ok(embedSrc.includes('function categoryCardHtml'), 'embed renders category cards');
    assert.ok(embedSrc.includes("type === 'categories'"), 'embed has the categories list branch');
    n += 2;
    const iconsSrc = read('public/js/moduleIcons.js');
    assert.ok(/categories: '/.test(iconsSrc), 'categories has a catalog glyph');
    n++;
    group('Part 1 taxonomy wiring pins', n);
  }

  /* ================================================================== */
  /* Part 2 — engine (in-process)                                        */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const share = require(path.join(root, 'server/moduleShare.js'));
  const cats = require(path.join(root, 'server/categories.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a124@example.invalid',
    password: ['batch124', 'ws', 'password'].join('-'),
    name: 'A124',
    workspaceName: 'Batch124 WS',
  });
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'a124@example.invalid' });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B124 Alpha Cuts', 'alpha124@example.invalid'],
    [LEAD_B, 'B124 Beta Lawns', 'beta124@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
  }

  // ---- Fixtures: lead A content + lead B isolation content ----
  const evPub = sm.createEvent(db, LEAD_A, { title: 'Harvest Festival', starts_at: ymd(10), status: 'published' });
  const evDraft = sm.createEvent(db, LEAD_A, { title: 'Unannounced Gala', starts_at: ymd(12), status: 'draft' });
  const postPub = sm.createBlogPost(db, LEAD_A, {
    title: 'Autumn Hair Guide',
    body_html: '<p>Guide</p>',
    status: 'published',
  });
  const postDraft = sm.createBlogPost(db, LEAD_A, { title: 'Draft Musings', body_html: '<p>x</p>', status: 'draft' });
  const albumA = sm.createAlbum(db, LEAD_A, {
    title: 'Salon Portfolio',
    status: 'published',
    images: [{ image_url: 'https://img.example/p1.jpg', caption: 'Cut' }],
  });
  const offerA = sm.createOffer(db, LEAD_A, { title: 'Fall Colour Deal', status: 'published', expires_at: ymd(30) });
  const listingA = sm.createListing(db, LEAD_A, { name: 'Alpha Cuts HQ', status: 'published' });
  const evB = sm.createEvent(db, LEAD_B, { title: 'Beta Event', starts_at: ymd(3), status: 'published' });
  // Menu's private system: one category + one item, created BEFORE any
  // taxonomy work so later assertions prove it never moved.
  const menuCat = sm.createMenuCategory(db, LEAD_A, { name: 'Mains', status: 'published' });
  sm.createMenuItem(db, LEAD_A, { name: 'House Cut', price: 25, category_id: menuCat.id, status: 'published' });

  // ---- 2a: CRUD, slugs, nesting ----
  {
    let n = 0;
    assert.equal(
      sm.MODULE_TYPES.length,
      27,
      'catalog at 27 types (Batch 125 added photocapture; Batch 126 finisher: qrcode; Batch 128: checkout)'
    );
    assert.equal(sm.MODULE_TYPES[23], 'categories', 'categories is the 24th type');
    n += 2;
    assert.deepEqual(
      Object.keys(share.SHARE_REGISTRY).sort(),
      [...sm.MODULE_TYPES].sort(),
      'registry parity at 27 types'
    );
    n++;

    const seasonal = cats.createCategory(db, LEAD_A, {
      scope: 'events',
      name: 'Seasonal',
      status: 'published',
      description: 'Things tied to the season.',
      image_url: 'https://img.example/seasonal.jpg',
    });
    assert.equal(seasonal.slug, 'seasonal');
    n++;
    const seasonalBlog = cats.createCategory(db, LEAD_A, { scope: 'blog', name: 'Seasonal', status: 'published' });
    assert.equal(seasonalBlog.slug, 'seasonal', 'same slug allowed in a different scope');
    n++;
    const seasonal2 = cats.createCategory(db, LEAD_A, { scope: 'events', name: 'Seasonal', status: 'published' });
    assert.notEqual(seasonal2.slug, 'seasonal', 'slug unique per lead+scope (suffixed on clash)');
    assert.ok(seasonal2.slug.startsWith('seasonal-'), 'clash keeps the readable prefix');
    n += 2;
    assert.throws(
      () => cats.createCategory(db, LEAD_A, { scope: 'not-a-module', name: 'Nope' }),
      (e) => e.code === 'VALIDATION',
      'scope must be a real module type'
    );
    n++;
    assert.throws(
      () => cats.createCategory(db, LEAD_A, { scope: 'events', name: '   ' }),
      (e) => e.code === 'VALIDATION',
      'a name is required'
    );
    n++;

    const parent = cats.createCategory(db, LEAD_A, { scope: 'events', name: 'Holidays', status: 'published' });
    const child = cats.createCategory(db, LEAD_A, {
      scope: 'events',
      name: 'Winter Holidays',
      status: 'published',
      parent_id: parent.id,
    });
    assert.equal(Number(child.parent_id), parent.id, 'child nests under the parent');
    n++;
    assert.throws(
      () => cats.createCategory(db, LEAD_A, { scope: 'blog', name: 'Bad Parent', parent_id: parent.id }),
      (e) => e.code === 'VALIDATION',
      'parent must live in the same scope'
    );
    n++;
    assert.throws(
      () => cats.updateCategory(db, LEAD_A, child.id, { parent_id: child.id }),
      (e) => e.code === 'VALIDATION',
      'a category cannot parent itself'
    );
    n++;
    assert.throws(
      () => cats.updateCategory(db, LEAD_A, parent.id, { parent_id: child.id }),
      (e) => e.code === 'VALIDATION',
      'parent cycles are refused'
    );
    n++;
    assert.throws(
      () => cats.updateCategory(db, LEAD_A, seasonal.id, { scope: 'blog' }),
      (e) => e.code === 'VALIDATION',
      'scope is immutable after create (assignments were made under it)'
    );
    n++;
    const renamed = cats.updateCategory(db, LEAD_A, seasonal.id, { name: 'Seasonal Events', slug: 'seasonal-events' });
    assert.equal(renamed.slug, 'seasonal-events', 'rename + re-slug works');
    n++;

    // Cross-lead: B cannot read or mutate A's category.
    assert.equal(cats.getCategory(db, LEAD_B, seasonal.id), null, 'category reads are lead-scoped');
    assert.throws(
      () => cats.updateCategory(db, LEAD_B, seasonal.id, { name: 'Hijack' }),
      (e) => e.code === 'NOT_FOUND',
      "another lead's category is invisible to updates"
    );
    n += 2;
    group('Part 2a category CRUD + slugs + nesting', n);

    // Stash for later parts.
    var C = { seasonal, seasonalBlog, seasonal2, parent, child };
  }

  // ---- 2b: assignment integrity ----
  {
    let n = 0;
    const { seasonal, seasonalBlog } = C;
    const out = cats.assignItem(db, LEAD_A, { consumerType: 'events', itemId: evPub.id, categoryId: seasonal.id });
    assert.equal(out.assigned, true);
    n++;
    const again = cats.assignItem(db, LEAD_A, { consumerType: 'events', itemId: evPub.id, categoryId: seasonal.id });
    assert.equal(again.assigned, true, 're-assign is idempotent');
    let rows = db
      .prepare('SELECT COUNT(*) AS c FROM module_category_assignments WHERE lead_id = ? AND item_id = ?')
      .get(LEAD_A, evPub.id);
    assert.equal(rows.c, 1, 'no duplicate assignment rows');
    n += 2;
    cats.assignItem(db, LEAD_A, { consumerType: 'events', itemId: evDraft.id, categoryId: seasonal.id });
    assert.throws(
      () => cats.assignItem(db, LEAD_A, { consumerType: 'events', itemId: 999999, categoryId: seasonal.id }),
      (e) => e.code === 'VALIDATION',
      'phantom items are refused'
    );
    n++;
    assert.throws(
      () => cats.assignItem(db, LEAD_A, { consumerType: 'events', itemId: evB.id, categoryId: seasonal.id }),
      (e) => e.code === 'VALIDATION',
      "another lead's item is refused"
    );
    n++;
    assert.throws(
      () => cats.assignItem(db, LEAD_A, { consumerType: 'blog', itemId: postPub.id, categoryId: seasonal.id }),
      (e) => e.code === 'VALIDATION',
      'an item cannot join a category of a different scope'
    );
    n++;
    assert.throws(
      () => cats.assignItem(db, LEAD_A, { consumerType: 'chatbot', itemId: 1, categoryId: seasonal.id }),
      (e) => e.code === 'VALIDATION',
      'non-provider consumers cannot hold assignments'
    );
    n++;
    assert.throws(
      () => cats.assignItem(db, LEAD_B, { consumerType: 'events', itemId: evB.id, categoryId: seasonal.id }),
      (e) => e.code === 'VALIDATION',
      "lead B cannot assign into lead A's category"
    );
    n++;

    // Counts: 'all' counts the draft event too; 'published' does not.
    const all = cats.listCategories(db, LEAD_A, { scope: 'events', counts: 'all' });
    const pub = cats.listCategories(db, LEAD_A, { includeDrafts: false, counts: 'published' });
    assert.equal(all.find((c) => c.id === seasonal.id).item_count, 2, 'all-count includes draft items');
    assert.equal(pub.find((c) => c.id === seasonal.id).item_count, 1, 'published-count excludes draft items');
    n += 2;

    // The editor path: category_ids on the item itself (all five wired
    // consumers round-trip through the same service).
    cats.assignItem(db, LEAD_A, { consumerType: 'blog', itemId: postPub.id, categoryId: seasonalBlog.id });
    const post2 = sm.updateBlogPost(db, LEAD_A, postPub.id, { category_ids: [seasonalBlog.id] });
    assert.deepEqual(post2.category_ids, [seasonalBlog.id], 'blog update keeps the picker value');
    const album2 = sm.updateAlbum(db, LEAD_A, albumA.id, { category_ids: [] });
    assert.deepEqual(album2.category_ids, [], 'gallery album accepts an empty picker');
    sm.updateAlbum(db, LEAD_A, albumA.id, {
      category_ids: [cats.createCategory(db, LEAD_A, { scope: 'gallery', name: 'Work', status: 'published' }).id],
    });
    const offerCat = cats.createCategory(db, LEAD_A, { scope: 'offers', name: 'Deals', status: 'published' });
    sm.updateOffer(db, LEAD_A, offerA.id, { category_ids: [offerCat.id] });
    const listCat = cats.createCategory(db, LEAD_A, { scope: 'directory', name: 'Locations', status: 'published' });
    sm.updateListing(db, LEAD_A, listingA.id, { category_ids: [listCat.id] });
    const lists = {
      blog: sm.listBlogPosts(db, LEAD_A, { includeDrafts: true }).find((p) => p.id === postPub.id),
      gallery: sm.listAlbums(db, LEAD_A, { includeDrafts: true }).find((a2) => a2.id === albumA.id),
      offers: sm.listOffers(db, LEAD_A, { includeDrafts: true }).find((o) => o.id === offerA.id),
      directory: sm.listListings(db, LEAD_A, { includeDrafts: true }).find((l) => l.id === listingA.id),
      events: sm.listEvents(db, LEAD_A, { includeDrafts: true }).find((e) => e.id === evPub.id),
    };
    assert.deepEqual(lists.blog.category_ids, [seasonalBlog.id], 'blog list carries category_ids');
    assert.equal(lists.gallery.category_ids.length, 1, 'gallery list carries category_ids');
    assert.deepEqual(lists.offers.category_ids, [offerCat.id], 'offers list carries category_ids');
    assert.deepEqual(lists.directory.category_ids, [listCat.id], 'directory list carries category_ids');
    assert.deepEqual(lists.events.category_ids, [seasonal.id], 'events list carries category_ids');
    n += 7;
    // Invalid picker payload refuses BEFORE the item write (the event
    // keeps its title when the category set is bogus).
    assert.throws(
      () => sm.updateEvent(db, LEAD_A, evPub.id, { title: 'Should Not Stick', category_ids: [seasonalBlog.id] }),
      (e) => e.code === 'VALIDATION',
      'a cross-scope picker value refuses the whole update'
    );
    assert.equal(
      sm.listEvents(db, LEAD_A, { includeDrafts: true }).find((e) => e.id === evPub.id).title,
      'Harvest Festival',
      'the refused update wrote nothing'
    );
    n += 2;

    // Unassign + delete semantics.
    cats.unassignItem(db, LEAD_A, { consumerType: 'events', itemId: evDraft.id, categoryId: seasonal.id });
    assert.deepEqual(cats.listItemCategoryIds(db, LEAD_A, 'events', evDraft.id), [], 'unassign clears the row');
    n++;
    const { child } = C;
    cats.assignItem(db, LEAD_A, { consumerType: 'events', itemId: evPub.id, categoryId: child.id });
    cats.deleteCategory(db, LEAD_A, C.parent.id);
    const childAfter = cats.getCategory(db, LEAD_A, child.id);
    assert.equal(childAfter.parent_id, null, 'deleting a parent re-parents its children to the root');
    n++;
    cats.deleteCategory(db, LEAD_A, child.id);
    const evStill = sm.listEvents(db, LEAD_A, { includeDrafts: true }).find((e) => e.id === evPub.id);
    assert.ok(evStill, 'deleting a category never deletes the item');
    assert.deepEqual(evStill.category_ids, [seasonal.id], 'only the deleted category assignment is gone');
    n += 2;
    sm.deleteEvent(db, LEAD_A, evPub.id);
    rows = db
      .prepare(
        'SELECT COUNT(*) AS c FROM module_category_assignments WHERE lead_id = ? AND item_id = ? AND consumer_type = ?'
      )
      .get(LEAD_A, evPub.id, 'events');
    assert.equal(rows.c, 0, 'deleting an item clears its assignments');
    n++;
    group('Part 2b assignment integrity', n);
  }

  // ---- 2c: shared layer reads ----
  {
    let n = 0;
    const { seasonal, seasonalBlog } = C;
    const items = share.listSharedItems(db, LEAD_A, 'categories');
    const sItem = items.find((i) => Number(i.source_id) === seasonal.id);
    assert.ok(sItem, 'categories surface as shared items');
    assert.deepEqual(
      Object.keys(sItem).sort(),
      ['date', 'description', 'image_url', 'link_url', 'meta', 'source_id', 'source_type', 'title'],
      'uniform item shape'
    );
    assert.equal(sItem.meta.scope, 'events');
    assert.equal(sItem.meta.item_count, 0, 'item_count is live (the event was deleted in 2b)');
    n += 4;
    // Rebuild one live assignment for the by-category read.
    const ev2 = sm.createEvent(db, LEAD_A, { title: 'Winter Market', starts_at: ymd(20), status: 'published' });
    cats.assignItem(db, LEAD_A, { consumerType: 'events', itemId: ev2.id, categoryId: seasonal.id });
    cats.assignItem(db, LEAD_A, { consumerType: 'events', itemId: evDraft.id, categoryId: seasonal.id });
    const byCat = share.listSharedItemsByCategory(db, LEAD_A, seasonal.id);
    assert.equal(byCat.category.name, 'Seasonal Events');
    assert.deepEqual(
      byCat.items.map((i) => i.title),
      ['Winter Market'],
      'items-by-category is published-only'
    );
    n += 2;
    assert.throws(
      () => share.listSharedItemsByCategory(db, LEAD_B, seasonal.id),
      (e) => e.code === 'VALIDATION',
      "lead B cannot resolve lead A's category"
    );
    n += 2;
    const summary = cats.categoriesSummary(db, LEAD_A);
    const evSummary = summary.find((s) => s.scope === 'events');
    assert.ok(
      evSummary && evSummary.published >= 2 && evSummary.assigned_items >= 2,
      'census summary counts the taxonomy'
    );
    n++;
    group('Part 2c shared-layer reads', n);
    var C2 = { ev2 };
  }

  // ---- 2d: public payloads ----
  {
    let n = 0;
    const { seasonal, seasonalBlog } = C;
    sm.updateCategoriesScopes(db, LEAD_A, ['events', 'blog']);
    sm.attachModule(db, LEAD_A, 'categories', { workspaceId: WS_ID });
    sm.attachModule(db, LEAD_A, 'events', { workspaceId: WS_ID });
    const emb = sm.getEmbedRow(db, LEAD_A, 'categories');
    assert.ok(emb && emb.public_token, 'categories embed exists with a public token');
    n++;
    const index = sm.getPublicModuleByToken(db, emb.public_token);
    const names = index.items.map((i) => i.name);
    assert.ok(names.includes('Seasonal Events') && names.includes('Seasonal'), 'index shows both configured scopes');
    const scopeLabels = (index.category_scopes || []).map((s) => s.label);
    assert.ok(scopeLabels.includes('Events') && scopeLabels.includes('Blog'), 'scope labels ride along');
    const sIdx = index.items.find((i) => Number(i.id) === seasonal.id);
    assert.equal(sIdx.item_count, 1, 'index counts published items only');
    n += 3;
    sm.updateCategoriesScopes(db, LEAD_A, ['blog']);
    const blogOnly = sm.getPublicModuleByToken(db, emb.public_token);
    assert.ok(
      blogOnly.items.every((i) => i.scope === 'blog'),
      'the display config narrows the index to the chosen scopes'
    );
    n++;
    sm.updateCategoriesScopes(db, LEAD_A, []);
    const view = sm.getPublicModuleItem(db, emb.public_token, seasonal.id);
    assert.equal(view.item.name, 'Seasonal Events');
    assert.equal(view.category_items.length, 1, 'category view lists the assigned published item');
    assert.ok(
      String(view.category_items[0].link_url).startsWith('/detail/events/'),
      'category items link to their own pages (Batch 133: the universal detail page; legacy ?bpItem= links still resolve on list pages)'
    );
    n += 3;
    const draftCat = cats.createCategory(db, LEAD_A, { scope: 'events', name: 'Hidden Shelf', status: 'draft' });
    const index2 = sm.getPublicModuleByToken(db, emb.public_token);
    assert.ok(!index2.items.some((i) => Number(i.id) === draftCat.id), 'draft categories stay off the public index');
    n++;
    sm.attachModule(db, LEAD_B, 'categories', { workspaceId: WS_ID });
    const embB = sm.getEmbedRow(db, LEAD_B, 'categories');
    const dormant = sm.getPublicModuleByToken(db, embB.public_token);
    assert.deepEqual(dormant.items, [], 'a lead with no categories renders dormant-empty');
    n++;
    group('Part 2d public categories payloads', n);
  }

  // ---- 2e: MCP dispatch surface (the design agent's path) ----
  {
    let n = 0;
    const mcp = require(path.join(root, 'server/mcp.js'));
    const made = await mcp.callTool(
      WS_ID,
      'categories.create',
      { leadId: LEAD_A, scope: 'events', name: 'Agent Shelf', status: 'published' },
      {}
    );
    assert.ok(made.ok && made.data && made.data.category, 'categories.create dispatches');
    const agentCat = made.data.category;
    n++;
    const asg = await mcp.callTool(
      WS_ID,
      'categories.assign',
      { leadId: LEAD_A, consumer_type: 'events', item_id: C2.ev2.id, category_id: agentCat.id },
      {}
    );
    assert.ok(asg.ok && asg.data.assigned, 'categories.assign dispatches');
    n++;
    const lst = await mcp.callTool(WS_ID, 'categories.list', { leadId: LEAD_A, scope: 'events' }, {});
    assert.ok(
      lst.data.categories.some((c) => c.id === agentCat.id),
      'categories.list sees the agent category'
    );
    n++;
    const itemsRes = await mcp.callTool(WS_ID, 'categories.items', { leadId: LEAD_A, category_id: agentCat.id }, {});
    assert.ok(
      itemsRes.data.items.some((i) => i.title === 'Winter Market'),
      'categories.items resolves through the shared layer'
    );
    n++;
    const bad = await mcp.callTool(
      WS_ID,
      'categories.assign',
      { leadId: LEAD_A, consumer_type: 'events', item_id: 424242, category_id: agentCat.id },
      {}
    );
    assert.ok(
      bad.ok === false && /exists for this business/.test(bad.error || ''),
      'phantom assignment over MCP is an error, not a write'
    );
    n++;
    group('Part 2e MCP dispatch surface', n);
  }

  // ---- 2f: menu's private system untouched ----
  {
    let n = 0;
    const menuCats = sm.listMenuCategories(db, LEAD_A);
    assert.equal(menuCats.length, 1, 'menu categories unchanged by the taxonomy service');
    assert.equal(menuCats[0].name, 'Mains');
    const items = sm.listMenuItems(db, LEAD_A, { includeDrafts: true });
    assert.equal(items.length, 1, 'menu items unchanged');
    assert.equal(Number(items[0].category_id), menuCat.id, 'menu items still join menu_categories');
    const taxRows = db.prepare('SELECT COUNT(*) AS c FROM module_categories WHERE lead_id = ?').get(LEAD_A);
    assert.ok(taxRows.c >= 5, 'taxonomy lives in its own tables');
    const menuInTax = db
      .prepare('SELECT COUNT(*) AS c FROM module_categories WHERE lead_id = ? AND name = ?')
      .get(LEAD_A, 'Mains');
    assert.equal(menuInTax.c, 0, 'no menu data leaked into the taxonomy tables');
    n += 5;
    group("Part 2f menu's private system untouched", n);
  }

  // ---- 2g: lead deletion sweeps the taxonomy (no orphans) ----
  {
    let n = 0;
    const LEAD_C = 12403;
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      LEAD_C,
      'B124 Gamma Doomed',
      'gamma124@example.invalid',
      'customer'
    );
    const gCat = cats.createCategory(db, LEAD_C, { scope: 'events', name: 'Doomed Shelf', status: 'published' });
    const gEv = sm.createEvent(db, LEAD_C, { title: 'Doomed Event', starts_at: ymd(5), status: 'published' });
    cats.assignItem(db, LEAD_C, { consumerType: 'events', itemId: gEv.id, categoryId: gCat.id });
    require(path.join(root, 'src/leadEngine.js')).deleteLead(db, LEAD_C);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM leads WHERE id = ?').get(LEAD_C).c, 0, 'lead deleted');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM module_categories WHERE lead_id = ?').get(LEAD_C).c,
      0,
      'lead deletion sweeps its categories'
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM module_category_assignments WHERE lead_id = ?').get(LEAD_C).c,
      0,
      'lead deletion sweeps its assignments'
    );
    n += 3;
    group('Part 2g lead deletion sweeps the taxonomy', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
  {
    let n = 0;
    const q = platformDb.query;
    const bcrypt = require('bcryptjs');
    await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)', {
      e: 'owner124@example.invalid',
      h: bcrypt.hashSync(['Unused', 'Pass', '124'].join('') + '!', 12),
      n: 'B124 Portal Link',
      s: 'active',
    });
    await q(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
      { e: 'owner124@example.invalid', h: bcrypt.hashSync(PW, 12), w: WS_ID, l: LEAD_A, b: 'B124 Alpha Cuts' }
    );

    const child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (b) => (output += b));
    child.stderr.on('data', (b) => (output += b));
    const closed = new Promise((resolve) => child.once('close', resolve));
    try {
      let ready = false;
      for (let i = 0; i < 300 && !ready; i++) {
        if (child.exitCode != null) throw new Error('server exited early: ' + output);
        try {
          const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
          if (r.ok) ready = true;
        } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(ready, 'server became ready');
      n++;

      const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
      const put = (jar, p, body) => jar.fetch(BASE + p, { method: 'PUT', body: JSON.stringify(body || {}) });
      const owner = makeJar();
      {
        const res = await post(owner, '/api/v1/portal/login', { email: 'owner124@example.invalid', password: PW });
        assert.equal(res.status, 200, 'portal owner login');
        n++;
      }
      {
        const res = await fetch(`${BASE}/api/v1/portal/modules/categories`);
        assert.equal(res.status, 401, 'anonymous categories list refused');
        n++;
      }
      // CRUD over the generic module routes.
      let httpCatId = 0;
      {
        const res = await post(owner, '/api/v1/portal/modules/categories', {
          scope: 'events',
          name: 'HTTP Shelf',
          status: 'published',
        });
        assert.equal(res.status, 200, 'category create over HTTP');
        const data = await json(res);
        httpCatId = Number((data.data || data).item.id);
        assert.ok(httpCatId > 0);
        n += 2;
        const list = await owner.fetch(`${BASE}/api/v1/portal/modules/categories`);
        const listData = await json(list);
        const payload = listData.data || listData;
        assert.ok(
          payload.items.some((c) => c.id === httpCatId),
          'category list over HTTP'
        );
        assert.ok(payload.taxonomy && Array.isArray(payload.taxonomy.scopes), 'list carries the display config');
        n += 2;
      }
      // Display-scopes round-trip.
      {
        const res = await put(owner, '/api/v1/portal/modules/categories/scopes', { scopes: ['events'] });
        assert.equal(res.status, 200, 'scopes PUT');
        const data = await json(res);
        assert.deepEqual((data.data || data).settings.scopes, ['events']);
        n += 2;
        const list = await owner.fetch(`${BASE}/api/v1/portal/modules/categories`);
        const payload = (await json(list)).data;
        assert.deepEqual(payload.taxonomy.scopes, ['events'], 'scopes persisted');
        n++;
        const back = await put(owner, '/api/v1/portal/modules/categories/scopes', { scopes: [] });
        assert.equal(back.status, 200, 'scopes reset');
        n++;
      }
      // Editor picker round-trips over HTTP (blog + events).
      {
        const blogList = await owner.fetch(`${BASE}/api/v1/portal/modules/blog`);
        const blogPayload = (await json(blogList)).data;
        const post = blogPayload.items.find((p) => p.title === 'Autumn Hair Guide');
        assert.ok(post && Array.isArray(post.category_ids), 'blog rows carry category_ids to the editor');
        n++;
        const blogCatList = await owner.fetch(`${BASE}/api/v1/portal/modules/categories?scope=blog`);
        const blogCat = ((await json(blogCatList)).data.items || []).find((c) => c.name === 'Seasonal');
        const res = await put(owner, `/api/v1/portal/modules/blog/${post.id}`, { category_ids: [blogCat.id] });
        assert.equal(res.status, 200, 'blog picker save');
        const saved = (await json(res)).data.item;
        assert.deepEqual(saved.category_ids, [blogCat.id], 'blog picker value persisted');
        n += 2;
        const clear = await put(owner, `/api/v1/portal/modules/blog/${post.id}`, { category_ids: [] });
        assert.deepEqual((await json(clear)).data.item.category_ids, [], 'blog picker clears');
        n++;
        const evList = await owner.fetch(`${BASE}/api/v1/portal/modules/events`);
        const evPayload = (await json(evList)).data;
        const ev = evPayload.items.find((e) => e.title === 'Winter Market');
        const res2 = await put(owner, `/api/v1/portal/modules/events/${ev.id}`, { category_ids: [httpCatId] });
        assert.equal(res2.status, 200, 'events picker save');
        assert.deepEqual((await json(res2)).data.item.category_ids, [httpCatId], 'events picker value persisted');
        n += 2;
      }
      // Public payload serves the HTTP-created category + its item.
      {
        sm.attachModule(db, LEAD_A, 'categories', { workspaceId: WS_ID });
        const emb = sm.getEmbedRow(db, LEAD_A, 'categories');
        const res = await fetch(`${BASE}/api/v1/modules/public/${emb.public_token}`);
        assert.equal(res.status, 200, 'public categories payload');
        const data = await json(res);
        const payload = data.data || data;
        assert.ok(
          payload.items.some((i) => i.name === 'HTTP Shelf'),
          'public index shows the HTTP category'
        );
        n += 2;
        const view = await fetch(`${BASE}/api/v1/modules/public/${emb.public_token}?slug=http-shelf`);
        const viewData = await json(view);
        const viewPayload = viewData.data || viewData;
        assert.ok(viewPayload.item, 'public category view resolves by slug');
        assert.ok(
          (viewPayload.category_items || []).some((i) => i.title === 'Winter Market'),
          'public category view lists the assigned event'
        );
        n += 2;
      }
      group('Part 3 HTTP portal + public flow', n);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }

  console.log(`\nBATCH124 ALL PASS — ${groups.length} groups: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH124 FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
