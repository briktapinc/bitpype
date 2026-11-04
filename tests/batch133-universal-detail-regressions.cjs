'use strict';
/**
 * Batch 133 — UNIVERSAL DETAIL PAGE (Ely, 2026-11-04: "a checkout page
 * that takes whatever module is served to it as the detail page").
 *
 * What this pins:
 *   Part 1 — source pins: DETAIL_TYPES + detailExportContext in
 *     siteModules (MODULE_TYPES stays 28 — detail is a page surface,
 *     not a module type), MODULE_SCRIPT_VER mod34, the shared-layer
 *     link generator (categories.categoryItemLink) emitting
 *     /detail/<type>/<key>, the export side (buildDetailPage,
 *     injectDetailMeta, the /detail/* rewrite, detail.html emission,
 *     the SEO-context detail threading), and the client side
 *     (detailHref/cardHref gated on the export meta, mountDetail,
 *     the not-found page state, the Batch 130 ?bpItem= fallback left
 *     byte-intact, the checkout wire point + its 'bp-cart-' key, the
 *     gallery photo hook stub, the Batch 131 mount-point note).
 *   Part 2 — in-process: detailExportContext carries exactly the
 *     detail-capable types with live embeds; getPublicModuleItem
 *     (the detail page's resolution path) resolves a published item
 *     per type with its detail fields (product: options/variants/
 *     From-price), refuses draft, foreign and missing keys with
 *     NOT_FOUND; category item links point at detail URLs; a fixture
 *     export ships detail.html with the type→token config, chrome,
 *     the _redirects rewrite, and detail-enabled list pages.
 *   Part 3 — HTTP over the real server: the public item route serves
 *     the variant product for the detail page, 404s draft/foreign/
 *     missing with code NOT_FOUND, and module-embed.js serves at
 *     mod34 with the detail boot.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch133-'));
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'app.db');
process.env.SQLITE_PATH = process.env.DB_PATH;
['.env', 'app.db', 'data.db', 'leads.db', 'platform.db'].forEach((name) => {
  process.env[name.toUpperCase().replace(/\W/g, '_') + '_PATH'] = path.join(process.env.REGRESSION_TMPDIR, name);
});
process.env.SESSION_SECRET = ['b133', 'regression', 'session', 'secret', 'for', 'tests'].join('-');
process.env.COOKIE_SECURE = 'false';
// Standard suite header (Batch 127 lesson): the real-server boot
// refuses production mode without these two lines.
process.env.CAPTCHA_OPTIONAL = '1';
process.env.APP_URL = 'https://bitpype.test';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';
process.env.STRIPE_TEST_MODE = process.env.STRIPE_TEST_MODE || 'true';

const root = path.resolve(__dirname, '..');
const PORT = 39133;
const BASE = `http://127.0.0.1:${PORT}`;
const LEAD_A = 13301;
const LEAD_B = 13302;

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

(async () => {
  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const smSrc = read('server/siteModules.js');
    assert.ok(smSrc.includes('const DETAIL_TYPES = ['), 'siteModules declares DETAIL_TYPES');
    n++;
    assert.ok(smSrc.includes('function detailExportContext(db, leadId)'), 'detailExportContext exists');
    n++;
    assert.ok(
      smSrc.includes("const MODULE_SCRIPT_VER = 'mod35'"),
      'MODULE_SCRIPT_VER bumped to mod34 (Batch 133); Batch 131 finisher rotation to mod35'
    );
    n++;
    const typesBlock = /const MODULE_TYPES = \[([\s\S]*?)\];/.exec(smSrc);
    assert.ok(typesBlock, 'MODULE_TYPES block found');
    n++;
    assert.equal(
      (typesBlock[1].match(/'/g) || []).length / 2,
      28,
      'MODULE_TYPES still 28 — detail is not a module type (27 at Batch 128 checkout; Batch 131 comments is the 28th; 133 adds none)'
    );
    n++;
    for (const t of [
      'blog',
      'ecommerce',
      'courses',
      'gallery',
      'directory',
      'faq',
      'testimonials',
      'team',
      'events',
      'bookings',
      'categories',
      'offers',
      'menu',
      'careers',
      'video',
    ]) {
      assert.ok(new RegExp(`const DETAIL_TYPES = \\[[\\s\\S]*?'${t}'`).test(smSrc), `DETAIL_TYPES includes ${t}`);
      n++;
    }
    const detailBlock = /const DETAIL_TYPES = \[([\s\S]*?)\];/.exec(smSrc)[1];
    for (const t of [
      'chatbot',
      'members',
      'newsletter',
      'photocapture',
      'qrcode',
      'socialfeed',
      'estimate',
      'calltracking',
      'datatables',
      'charts',
      'googlereviews',
    ]) {
      assert.ok(!detailBlock.includes(`'${t}'`), `DETAIL_TYPES excludes ${t}`);
      n++;
    }

    const catsSrc = read('server/categories.js');
    assert.ok(
      catsSrc.includes('`/detail/${uniformItem.source_type}/${encodeURIComponent(String(key))}`'),
      'category item links point at the detail page'
    );
    n++;
    assert.ok(!catsSrc.includes('?bpItem=${encodeURIComponent'), 'category links no longer generate ?bpItem= URLs');
    n++;

    const engineSrc = read('src/websiteEngine.js');
    assert.ok(engineSrc.includes('function buildDetailPage(pages, theme, opts)'), 'export builds the detail page');
    n++;
    assert.ok(
      engineSrc.includes("'/detail/* /item 200'") ||
        engineSrc.includes('`/detail/* /item 200`') ||
        engineSrc.includes("'/detail/* /item 200'"),
      'redirects carry the detail rewrite'
    );
    n++;
    assert.ok(
      engineSrc.includes("'/detail/* /item 200'") || engineSrc.includes('/detail/* /item 200'),
      'detail rewrite line present'
    );
    n++;
    assert.ok(engineSrc.includes('function injectDetailMeta(html)'), 'export stamps detail-enabled pages');
    n++;
    assert.ok(engineSrc.includes("path.join(outDir, 'item.html')"), 'export writes item.html (the detail shell)');
    n++;
    assert.ok(
      engineSrc.includes('mods.detailExportContext(db, lead.id)'),
      'SEO export context threads the detail context'
    );
    n++;
    assert.ok(engineSrc.includes('data-bitpype-detail-root="1"'), 'detail shell carries the detail root');
    n++;
    assert.ok(engineSrc.includes('id="bp-detail-config"'), 'detail shell carries the config JSON');
    n++;

    const embedSrc = read('public/js/module-embed.js');
    assert.ok(embedSrc.includes('function detailHref(type, key)'), 'embed builds detail URLs');
    n++;
    assert.ok(embedSrc.includes("'/detail/' + encodeURIComponent(type)"), 'detail URL shape is /detail/<type>/<key>');
    n++;
    assert.ok(embedSrc.includes('function cardHref(key)'), 'card links route through cardHref');
    n++;
    assert.ok(embedSrc.includes('meta[name="bitpype-detail"]'), 'detail links gated on the export meta');
    n++;
    assert.ok(embedSrc.includes("activeDetailType !== 'blog'"), 'blog keeps its static detail pages');
    n++;
    assert.ok(embedSrc.includes('function mountDetail()'), 'embed boots the detail page');
    n++;
    assert.ok(embedSrc.includes('function renderDetailNotFound(root, listPath)'), 'not-found page state exists');
    n++;
    assert.ok(embedSrc.includes('function detailApplyMeta(data)'), 'detail page sets title/meta from the item');
    n++;
    assert.ok(embedSrc.includes('BATCH 133 CHECKOUT WIRE POINT'), 'checkout wire point is marked');
    n++;
    assert.ok(
      embedSrc.includes("var key = 'bp-cart-' + String(checkoutToken || '');") ||
        embedSrc.includes("'bp-cart-' + String(checkoutToken"),
      'wire point uses the Batch 128 cart key'
    );
    n++;
    assert.ok(
      embedSrc.includes('function detailAddToCart(checkoutToken, line)'),
      'wire point function exists with the pinned signature'
    );
    n++;
    assert.ok(embedSrc.includes('function wireDetailCheckout(root, data)'), 'detail checkout wiring exists');
    n++;
    assert.ok(embedSrc.includes('function detailPhotoSellableHook(root, data)'), 'gallery photo hook stub exists');
    n++;
    assert.ok(embedSrc.includes('Batch 131 mount point'), 'comments mount point is documented in the detail boot');
    n++;
    // Batch 130 compat: the ?bpItem= NOT_FOUND fallback must stay intact.
    assert.ok(
      embedSrc.includes("j.code === 'NOT_FOUND') {\n          return loadPayload('').then(handlePayload);") ||
        embedSrc.includes("return loadPayload('').then(handlePayload);"),
      'Batch 130 list fallback intact'
    );
    n++;
    assert.ok(embedSrc.includes('function itemHref(key)'), 'legacy ?bpItem= link builder retained for in-app surfaces');
    n++;
    group('Part 1 source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — in-process: context, resolution, links, fixture export     */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const cats = require(path.join(root, 'server/categories.js'));
  const engine = require(path.join(root, 'src/websiteEngine.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a133@example.invalid',
    password: ['B133', 'Workspace', 'Pass'].join('-') + '!',
    name: 'A133',
    workspaceName: 'Batch133 WS',
  });
  const WS_ID = Number(a.workspaceId);
  const db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B133 Plant Shop', 'plants133@example.invalid'],
    [LEAD_B, 'B133 Rival Shop', 'rival133@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
  }

  let shopToken = '';
  let blogToken = '';
  let monstera;
  {
    let n = 0;
    assert.deepEqual(
      [...sm.DETAIL_TYPES].sort(),
      [
        'blog',
        'bookings',
        'careers',
        'categories',
        'courses',
        'directory',
        'ecommerce',
        'events',
        'faq',
        'gallery',
        'menu',
        'offers',
        'team',
        'testimonials',
        'video',
      ].sort(),
      'DETAIL_TYPES is exactly the getPublicModuleItem-resolvable set'
    );
    n++;

    const shop = sm.attachModule(db, LEAD_A, 'ecommerce', { workspaceId: WS_ID, appUrl: 'https://example.test' });
    const blog = sm.attachModule(db, LEAD_A, 'blog', { workspaceId: WS_ID, appUrl: 'https://example.test' });
    sm.attachModule(db, LEAD_A, 'newsletter', { workspaceId: WS_ID, appUrl: 'https://example.test' });
    shopToken = shop.embed ? shop.embed.public_token : sm.getEmbedRow(db, LEAD_A, 'ecommerce').public_token;
    blogToken = blog.embed ? blog.embed.public_token : sm.getEmbedRow(db, LEAD_A, 'blog').public_token;
    assert.ok(shopToken && blogToken, 'fixture embeds carry public tokens');
    n++;

    const ctx = sm.detailExportContext(db, LEAD_A);
    assert.equal(ctx.types.ecommerce.token, shopToken, 'detail context carries the shop token');
    n++;
    assert.equal(ctx.types.ecommerce.page, 'shop', 'detail context carries the shop list page');
    n++;
    assert.equal(ctx.types.blog.page, 'blog', 'detail context carries the blog list page');
    n++;
    assert.ok(!('newsletter' in ctx.types), 'non-detail types never enter the detail context');
    n++;
    assert.deepEqual(sm.detailExportContext(db, LEAD_B), { types: {} }, 'a lead with no embeds gets an empty context');
    n++;
    assert.deepEqual(sm.detailExportContext(db, 0), { types: {} }, 'invalid lead gets an empty context');
    n++;

    monstera = sm.createProduct(db, LEAD_A, {
      name: 'Monstera Deliciosa',
      price: 58,
      status: 'published',
      options: [{ name: 'Pot', values: ['Nursery Pot', 'EcoPot'] }],
      variants: [{ values: ['EcoPot'], price_cents: 6800 }],
    });
    const draft = sm.createProduct(db, LEAD_A, { name: 'Secret Fern', price: 10, status: 'draft' });
    const rival = sm.createProduct(db, LEAD_B, { name: 'Rival Plant', price: 20, status: 'published' });
    const post = sm.createBlogPost(db, LEAD_A, {
      title: 'Watering Your Monstera',
      body_html: '<p>Water weekly.</p>',
      status: 'published',
    });
    assert.ok(post.slug, 'blog fixture has a slug');
    n++;

    // Typed resolution — the exact call the detail page's fetch makes.
    const item = sm.getPublicModuleItem(db, shopToken, monstera.slug || String(monstera.id));
    assert.equal(item.module_type, 'ecommerce', 'product resolves under its own type');
    n++;
    assert.equal(item.item.name, 'Monstera Deliciosa', 'product detail carries the product');
    n++;
    assert.equal(item.item.has_variants, true, 'product detail carries the variant structure');
    n++;
    assert.deepEqual(
      item.item.options.map((o) => o.name),
      ['Pot'],
      'product detail carries the option axes'
    );
    n++;
    assert.equal(item.item.price_label, 'From $58.00', 'product detail carries the From price');
    n++;
    const eco = item.item.variants.find((v) => v.values[0] === 'EcoPot');
    assert.equal(eco.price_cents, 6800, 'product detail carries per-variant prices');
    n++;

    const postItem = sm.getPublicModuleItem(db, blogToken, post.slug);
    assert.equal(postItem.item.title, 'Watering Your Monstera', 'blog detail resolves by slug');
    n++;
    assert.ok(String(postItem.item.body_html).includes('Water weekly'), 'blog detail carries the full body');
    n++;

    for (const [tok, key, why] of [
      [shopToken, draft.slug || String(draft.id), 'draft product'],
      [shopToken, rival.slug || String(rival.id), 'foreign product'],
      [shopToken, 'no-such-plant', 'missing product'],
      [blogToken, monstera.slug || String(monstera.id), 'product slug under the blog token (typed target)'],
    ]) {
      let code = '';
      try {
        sm.getPublicModuleItem(db, tok, key);
      } catch (e) {
        code = e.code || '';
      }
      assert.equal(code, 'NOT_FOUND', `${why} refuses with NOT_FOUND`);
      n++;
    }

    // Shared-layer links (categories view cards).
    const cat = cats.createCategory(db, LEAD_A, { scope: 'ecommerce', name: 'Best Sellers', status: 'published' });
    cats.assignItem(db, LEAD_A, { consumerType: 'ecommerce', itemId: monstera.id, categoryId: cat.id });
    sm.attachModule(db, LEAD_A, 'categories', { workspaceId: WS_ID, appUrl: 'https://example.test' });
    const catToken = sm.getEmbedRow(db, LEAD_A, 'categories').public_token;
    const catItem = sm.getPublicModuleItem(db, catToken, cat.slug || String(cat.id));
    const linked = (catItem.category_items || []).find((ci) => Number(ci.source_id) === Number(monstera.id));
    assert.ok(linked, 'category view includes the assigned product');
    n++;
    assert.equal(
      linked.link_url,
      `/detail/ecommerce/${monstera.slug || monstera.id}`,
      'category card link_url is the product detail URL'
    );
    n++;
    group('Part 2 context + resolution + links', n);
  }

  /* ---- fixture export ---- */
  {
    let n = 0;
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch133-export-'));
    const pages = [
      { slug: '/', title: 'Home', sections: [{ type: 'heading', content: { title: 'B133 Plants' } }] },
      { slug: 'shop', title: 'Shop', sections: [{ type: 'heading', content: { title: 'Shop' } }] },
    ];
    const detailCtx = sm.detailExportContext(db, LEAD_A);
    const written = engine.writeStaticPages(pages, {}, outDir, {
      seo: {
        baseUrl: 'https://plants133.example',
        business: null,
        moduleFaqItems: [],
        gscToken: '',
        blog: null,
        detail: detailCtx,
      },
      siteUpdatedAt: '2026-11-04T00:00:00.000Z',
    });
    assert.ok(written.files.includes('item.html'), 'export ships item.html (the detail shell)');
    n++;
    const monsteraKey = monstera.slug || String(monstera.id);
    assert.ok(
      Array.isArray(detailCtx.types.ecommerce.items) && detailCtx.types.ecommerce.items.includes(monsteraKey),
      'detail context enumerates published item keys for per-item shells'
    );
    n++;
    assert.ok(
      written.files.includes(`detail/ecommerce/${monsteraKey}.html`),
      'export ships a real shell file for the published product (rewrite-independent)'
    );
    n++;
    const detailHtml = fs.readFileSync(path.join(outDir, 'item.html'), 'utf8');
    assert.ok(detailHtml.includes('data-bitpype-detail-root="1"'), 'detail.html carries the detail root');
    n++;
    assert.ok(detailHtml.includes(shopToken), 'detail.html config carries the shop token');
    n++;
    assert.ok(
      detailHtml.includes('"ecommerce"') && detailHtml.includes('"page":"shop"'),
      'detail.html config maps type → token + list page'
    );
    n++;
    assert.ok(
      detailHtml.includes('module-embed.js?v=mod35'),
      'detail.html loads the module embed script at mod35 (Batch 131 finisher rotation)'
    );
    n++;
    const redirects = fs.readFileSync(path.join(outDir, '_redirects'), 'utf8');
    assert.ok(
      redirects.includes('/detail/* /item 200'),
      '_redirects rewrites detail URLs to the detail page (extensionless target)'
    );
    n++;
    const shopHtml = fs.readFileSync(path.join(outDir, 'shop.html'), 'utf8');
    assert.ok(shopHtml.includes('name="bitpype-detail"'), 'exported list pages are stamped detail-enabled');
    n++;
    const built = engine.buildDetailPage(pages, {}, { seo: { detail: detailCtx } });
    assert.ok(built.includes('data-bitpype-detail-root="1"'), 'buildDetailPage renders the shell directly');
    n++;
    assert.equal(
      engine.injectDetailMeta('<html><head><title>x</title></head></html>').includes('name="bitpype-detail"'),
      true,
      'injectDetailMeta stamps a head'
    );
    n++;
    assert.equal(
      engine.injectDetailMeta('<p>no head</p>'),
      '<p>no head</p>',
      'injectDetailMeta leaves headless HTML untouched'
    );
    n++;
    group('Part 2 fixture export', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
  {
    let n = 0;
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

      const slug = monstera.slug || String(monstera.id);
      const okRes = await fetch(`${BASE}/api/v1/modules/public/${shopToken}?slug=${encodeURIComponent(slug)}`);
      assert.equal(okRes.status, 200, 'detail resolution serves over HTTP');
      n++;
      const okJson = await json(okRes);
      assert.equal(okJson.data.item.name, 'Monstera Deliciosa', 'HTTP detail payload carries the product');
      n++;
      assert.equal(okJson.data.item.price_label, 'From $58.00', 'HTTP detail payload carries the From price');
      n++;
      assert.equal(okJson.data.item.variants.length, 2, 'HTTP detail payload carries both variants');
      n++;

      for (const [key, why] of [
        ['secret-fern', 'draft product'],
        ['rival-plant', 'foreign product'],
        ['no-such-plant', 'missing product'],
      ]) {
        const res = await fetch(`${BASE}/api/v1/modules/public/${shopToken}?slug=${encodeURIComponent(key)}`);
        assert.equal(res.status, 404, `${why} 404s over HTTP`);
        n++;
        const body = await json(res);
        assert.equal(body.code, 'NOT_FOUND', `${why} answers code NOT_FOUND (the detail page's not-found trigger)`);
        n++;
      }

      const jsRes = await fetch(`${BASE}/js/module-embed.js?v=mod35`);
      assert.equal(jsRes.status, 200, 'module-embed.js serves');
      n++;
      const jsText = await jsRes.text();
      assert.ok(jsText.includes('function mountDetail()'), 'served embed carries the detail boot');
      n++;
      assert.ok(jsText.includes("'/detail/' + encodeURIComponent(type)"), 'served embed builds detail URLs');
      n++;
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
    group('Part 3 HTTP', n);
  }

  console.log(`\nBatch 133 universal detail: ALL PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH133 FAIL:', e && e.message ? e.message : e);
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
