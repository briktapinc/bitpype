'use strict';
/**
 * Batch 127 — first-class product variants for the ecommerce module.
 *
 * What this pins:
 *   Part 1 — source pins: the three variant tables + order columns,
 *     MODULE_SCRIPT_VER mod32 (Batch 127 landed mod30; Batch 128 finisher rotation +1), the variant engine exports, the
 *     storefront selector wiring (data-bp-axis / wireVariantPicker /
 *     data-bp-variant), the portal variant editor + collect hook, the
 *     MCP + catalog options/variants params, the public checkout
 *     route's variantId passthrough, the shared-layer display-price
 *     rule, and the portal cache-bust.
 *   Part 2 — engine (in-process): variant-less products unchanged;
 *     matrix generation (1 axis, 2 axes) with base-price defaults;
 *     per-variant price/SKU/label/availability overrides in both
 *     values shapes (array + object); the display-price rule (lowest
 *     AVAILABLE variant; lowest overall when none available) and the
 *     "From $X" label; integrity refusals (duplicate combination —
 *     case-insensitive, duplicate group/value, >2 groups, unknown
 *     value, variants without options, failed create stores nothing);
 *     reconciliation (axis rename keeps prices by position, value
 *     removal drops its variants, options [] clears, partial update
 *     untouched, variants-only update, delete clears rows); checkout
 *     through a stubbed shopStripe (order carries variant id + label
 *     + variant amount; Stripe session name/metadata carry the
 *     variant; missing/unavailable/foreign selections refused with
 *     NO order written; variant-less checkout byte-identical in
 *     behavior); shared-layer items + categories composition on a
 *     Victoria-shaped fixture; public payloads; MCP dispatch.
 *   Part 3 — HTTP over the real server: portal owner session creates
 *     a variant product through the portal modules API, the list
 *     returns the structure, the public payload serves it, and a
 *     public checkout attempt without Stripe fails clean with no
 *     order row.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch127-'));
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'app.db');
process.env.SQLITE_PATH = process.env.DB_PATH;
['.env', 'app.db', 'data.db', 'leads.db', 'platform.db'].forEach((name) => {
  process.env[name.toUpperCase().replace(/\W/g, '_') + '_PATH'] = path.join(process.env.REGRESSION_TMPDIR, name);
});
process.env.SESSION_SECRET = ['batch127', 'regression', 'secret'].join('-');
process.env.COOKIE_SECURE = 'false';
// Finisher fix: Part 3 boots the real server; under the gate
// image's NODE_ENV=production the boot refuses to run without
// Turnstile keys unless CAPTCHA_OPTIONAL=1, and requires APP_URL
// (the sibling suites 125/126/132 set both lines; the builder's
// local runs never exposed the gaps because NODE_ENV was unset
// there and APP_URL with it).
process.env.CAPTCHA_OPTIONAL = '1';
process.env.APP_URL = 'https://bitpype.test';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';
process.env.STRIPE_TEST_MODE = process.env.STRIPE_TEST_MODE || 'true';

const root = path.resolve(__dirname, '..');
const PORT = 39127;
const BASE = `http://127.0.0.1:${PORT}`;
const LEAD_A = 12701;
const LEAD_B = 12702;
const PW = ['B127', 'Portal', 'Pass', '9'].join('-') + '!';

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

(async () => {
  let db = null;
  let WS_ID = 0;

  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const smSrc = read('server/siteModules.js');
    for (const t of ['ecommerce_product_options', 'ecommerce_product_option_values', 'ecommerce_product_variants']) {
      assert.ok(smSrc.includes(`CREATE TABLE IF NOT EXISTS ${t}`), `variant table ${t} in ensureTables`);
      n++;
    }
    assert.ok(smSrc.includes('UNIQUE(product_id, combo_key)'), 'variant combination uniqueness pinned in DDL');
    n++;
    assert.ok(smSrc.includes("orderCols.includes('variant_id')"), 'orders gain variant_id via guarded ALTER');
    n++;
    assert.ok(smSrc.includes("orderCols.includes('variant_label')"), 'orders gain variant_label via guarded ALTER');
    n++;
    assert.ok(
      smSrc.includes("const MODULE_SCRIPT_VER = 'mod34'"),
      'MODULE_SCRIPT_VER bumped to mod32 (Batch 128 finisher rotation)'
    );
    n++;
    for (const fn of [
      'function setProductOptions',
      'function listProductVariants',
      'function getProductVariant',
      'function productDisplayPriceCents',
      'function productPriceLabel',
      'function publicProductShape',
      'function reconcileProductVariantsFromInput',
    ]) {
      assert.ok(smSrc.includes(fn), `engine has ${fn}`);
      n++;
    }
    assert.ok(smSrc.includes("byLead('ecommerce_product_variants'"), 'lead purge sweeps variant rows');
    n++;

    const shareSrc = read('server/moduleShare.js');
    assert.ok(
      shareSrc.includes('price_cents: modules.productDisplayPriceCents(db, leadId, p)'),
      'shared layer prices products by the display rule'
    );
    n++;

    const embedSrc = read('public/js/module-embed.js');
    assert.ok(embedSrc.includes('function wireVariantPicker'), 'embed wires the variant picker');
    n++;
    assert.ok(embedSrc.includes('data-bp-axis="'), 'embed renders one selector per axis');
    n++;
    assert.ok(embedSrc.includes("btn.getAttribute('data-bp-variant')"), 'buy button carries the chosen variant');
    n++;
    assert.ok(embedSrc.includes('payload.variantId'), 'checkout payload carries variantId');
    n++;

    const portalSrc = read('public/js/portal.js');
    assert.ok(portalSrc.includes('function renderProductVariantEditor'), 'portal has the variant editor');
    n++;
    assert.ok(portalSrc.includes('out.options = readVariantGroupsFromDom()'), 'portal collect ships options/variants');
    n++;
    assert.ok(read('public/portal.html').includes('/js/portal.js?v=batch128-checkout1'), 'portal.js cache-busted');
    n++;

    const mcpSrc = read('server/mcp.js');
    assert.equal(
      (mcpSrc.match(/options: \{ type: 'array', items: \{ type: 'object' \} \}/g) || []).length >= 2,
      true,
      'hosted MCP declares options on create+update'
    );
    n++;
    const catalogSrc = read('src/mcpCatalog.js');
    assert.equal(
      (catalogSrc.match(/options: \{ type: 'array', items: \{ type: 'object' \} \}/g) || []).length >= 2,
      true,
      'client catalog declares options on create+update'
    );
    n++;

    const pubSrc = read('server/routes/modulesPublic.js');
    assert.ok(pubSrc.includes('variantId: body.variantId'), 'public checkout route passes variantId through');
    n++;
    group('Part 1 source pins', n);
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
    email: 'a127@example.invalid',
    password: ['Ws127', 'Owner', 'Pass'].join('-') + '!',
    name: 'A127',
    workspaceName: 'Batch127 WS',
  });
  WS_ID = Number(a.workspaceId);
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'a127@example.invalid' });
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B127 Plant Shop', 'plants127@example.invalid'],
    [LEAD_B, 'B127 Rival Shop', 'rival127@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
  }

  // ---- 2a: CRUD + matrix generation ----
  let plain;
  let monstera;
  let palm;
  {
    let n = 0;
    plain = sm.createProduct(db, LEAD_A, { name: 'Plain Fern', price: 24, status: 'published' });
    assert.equal(plain.has_variants, false, 'variant-less product reports has_variants=false');
    n++;
    assert.deepEqual(plain.options, [], 'variant-less product has no option groups');
    n++;
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM ecommerce_product_variants WHERE product_id = ?').get(plain.id).c,
      0,
      'variant-less product writes no variant rows'
    );
    n++;
    assert.equal(sm.productPriceLabel(db, LEAD_A, plain), '$24.00', 'variant-less price label is the base price');
    n++;
    assert.equal(sm.productDisplayPriceCents(db, LEAD_A, plain), 2400, 'variant-less display price is the base price');
    n++;

    monstera = sm.createProduct(db, LEAD_A, {
      name: 'Monstera Deliciosa',
      price: 58,
      status: 'published',
      options: [{ name: 'Pot', values: ['Nursery Pot', 'EcoPot'] }],
      variants: [{ values: ['EcoPot'], price_cents: 6800, sku: 'MON-ECO', label: 'EcoPot (recycled)' }],
    });
    assert.equal(monstera.has_variants, true, 'optioned product reports has_variants=true');
    n++;
    assert.equal(monstera.variants.length, 2, 'one axis of 2 values makes 2 variants');
    n++;
    const nursery = monstera.variants.find((v) => v.label === 'Nursery Pot');
    assert.equal(nursery.price_cents, 5800, 'unmentioned combination defaults to the base price');
    n++;
    assert.equal(nursery.available, true, 'unmentioned combination defaults to available');
    n++;
    const eco = monstera.variants.find((v) => v.values[0] === 'EcoPot');
    assert.equal(eco.price_cents, 6800, 'override price lands on the right combination');
    n++;
    assert.equal(eco.sku, 'MON-ECO', 'override SKU lands');
    n++;
    assert.equal(eco.label, 'EcoPot (recycled)', 'label override wins the display label');
    n++;
    assert.equal(sm.productDisplayPriceCents(db, LEAD_A, monstera), 5800, 'display price = lowest available variant');
    n++;
    assert.equal(sm.productPriceLabel(db, LEAD_A, monstera), 'From $58.00', 'price range reads as From $min');
    n++;

    palm = sm.createProduct(db, LEAD_A, {
      name: 'Parlor Palm',
      price: 40,
      status: 'published',
      options: [
        { name: 'Pot', values: ['Nursery', 'Eco'] },
        { name: 'Size', values: ['Small', 'Large'] },
      ],
      variants: [{ values: { Pot: 'Eco', Size: 'Large' }, price_cents: 9100, available: false }],
    });
    assert.equal(palm.variants.length, 4, 'two axes of 2 values make a 4-variant matrix');
    n++;
    assert.deepEqual(
      palm.variants.map((v) => v.label),
      ['Nursery · Small', 'Nursery · Large', 'Eco · Small', 'Eco · Large'],
      'matrix order follows axis order'
    );
    n++;
    const ecoLarge = palm.variants.find((v) => v.label === 'Eco · Large');
    assert.equal(ecoLarge.price_cents, 9100, 'object-form values address the right combination');
    n++;
    assert.equal(ecoLarge.available, false, 'object-form override sets availability off');
    n++;
    // Single-price collapse: make every available variant the same price.
    const fig = sm.createProduct(db, LEAD_A, {
      name: 'Fig',
      price: 30,
      status: 'published',
      options: [{ name: 'Size', values: ['Small', 'Large'] }],
    });
    assert.equal(sm.productPriceLabel(db, LEAD_A, fig), '$30.00', 'uniform variant prices collapse to one label');
    n++;
    group('Part 2a CRUD + matrix generation', n);
  }

  // ---- 2b: integrity refusals ----
  {
    let n = 0;
    const before = db.prepare('SELECT COUNT(*) AS c FROM ecommerce_products WHERE lead_id = ?').get(LEAD_A).c;
    assert.throws(
      () =>
        sm.createProduct(db, LEAD_A, {
          name: 'Bad Dup',
          price: 10,
          options: [{ name: 'Pot', values: ['Eco'] }],
          variants: [
            { values: ['Eco'], price_cents: 100 },
            { values: ['eco'], price_cents: 200 },
          ],
        }),
      (e) => e.code === 'VALIDATION' && /Duplicate variant combination/.test(e.message),
      'duplicate combination refused (case-insensitive)'
    );
    n++;
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM ecommerce_products WHERE lead_id = ?').get(LEAD_A).c,
      before,
      'a refused create stores nothing'
    );
    n++;
    assert.throws(
      () =>
        sm.createProduct(db, LEAD_A, {
          name: 'Bad Group',
          options: [
            { name: 'Pot', values: ['Eco'] },
            { name: 'pot', values: ['X'] },
          ],
        }),
      (e) => e.code === 'VALIDATION' && /Duplicate option group/.test(e.message),
      'duplicate option group refused'
    );
    n++;
    assert.throws(
      () => sm.createProduct(db, LEAD_A, { name: 'Bad Value', options: [{ name: 'Pot', values: ['Eco', 'ECO'] }] }),
      (e) => e.code === 'VALIDATION' && /Duplicate value/.test(e.message),
      'duplicate value refused'
    );
    n++;
    assert.throws(
      () =>
        sm.createProduct(db, LEAD_A, {
          name: 'Bad Axes',
          options: [
            { name: 'A', values: ['1'] },
            { name: 'B', values: ['1'] },
            { name: 'C', values: ['1'] },
          ],
        }),
      (e) => e.code === 'VALIDATION' && /at most 2 option groups/.test(e.message),
      'a third axis is refused'
    );
    n++;
    assert.throws(
      () =>
        sm.updateProduct(db, LEAD_A, monstera.id, {
          options: [{ name: 'Pot', values: ['Nursery Pot', 'EcoPot'] }],
          variants: [{ values: ['Clay'], price_cents: 100 }],
        }),
      (e) => e.code === 'VALIDATION' && /not a value of option group/.test(e.message),
      'unknown variant value refused'
    );
    n++;
    assert.throws(
      () => sm.createProduct(db, LEAD_A, { name: 'Orphan Variants', variants: [{ values: ['Eco'], price_cents: 1 }] }),
      (e) => e.code === 'VALIDATION' && /need option groups/.test(e.message),
      'variants without options refused on create'
    );
    n++;
    assert.throws(
      () => sm.updateProduct(db, LEAD_A, plain.id, { variants: [{ values: ['Eco'], price_cents: 1 }] }),
      (e) => e.code === 'VALIDATION' && /need option groups/.test(e.message),
      'variants without options refused on update'
    );
    n++;
    group('Part 2b integrity refusals', n);
  }

  // ---- 2c: reconciliation semantics ----
  {
    let n = 0;
    const renamed = sm.updateProduct(db, LEAD_A, palm.id, {
      options: [
        { name: 'Planter', values: ['Nursery', 'Eco'] },
        { name: 'Size', values: ['Small', 'Large'] },
      ],
    });
    assert.deepEqual(
      renamed.options.map((g) => g.name),
      ['Planter', 'Size'],
      'axis rename lands (groups match by position)'
    );
    n++;
    assert.equal(
      renamed.variants.find((v) => v.label === 'Eco · Large').price_cents,
      9100,
      'axis rename keeps variant prices'
    );
    n++;
    const partial = sm.updateProduct(db, LEAD_A, palm.id, { description: 'Likes shade.' });
    assert.equal(partial.has_variants, true, 'partial update leaves variants in place');
    n++;
    assert.equal(partial.variants.length, 4, 'partial update keeps the whole matrix');
    n++;
    const repriced = sm.updateProduct(db, LEAD_A, palm.id, {
      variants: [{ values: ['Nursery', 'Small'], price: 33.5 }],
    });
    assert.equal(
      repriced.variants.find((v) => v.label === 'Nursery · Small').price_cents,
      3350,
      'variants-only update overrides one combination (dollars accepted)'
    );
    n++;
    assert.equal(
      repriced.variants.find((v) => v.label === 'Eco · Large').available,
      false,
      'variants-only update leaves other combinations untouched'
    );
    n++;
    const shrunk = sm.updateProduct(db, LEAD_A, palm.id, {
      options: [
        { name: 'Planter', values: ['Nursery', 'Eco'] },
        { name: 'Size', values: ['Small'] },
      ],
    });
    assert.equal(shrunk.variants.length, 2, 'removing a value removes its variants');
    n++;
    assert.ok(
      shrunk.variants.every((v) => v.values[1] === 'Small'),
      'only the surviving value combinations remain'
    );
    n++;
    const cleared = sm.updateProduct(db, LEAD_A, palm.id, { options: [] });
    assert.equal(cleared.has_variants, false, 'options [] returns the product to single-price');
    n++;
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM ecommerce_product_options WHERE product_id = ?').get(palm.id).c,
      0,
      'clearing removes the option groups'
    );
    n++;
    const gone = sm.createProduct(db, LEAD_A, {
      name: 'Short Lived',
      price: 5,
      options: [{ name: 'Size', values: ['S', 'L'] }],
    });
    sm.deleteProduct(db, LEAD_A, gone.id);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM ecommerce_product_variants WHERE product_id = ?').get(gone.id).c,
      0,
      'deleting a product deletes its variants'
    );
    n++;
    group('Part 2c reconciliation semantics', n);
  }

  // ---- 2c2: value rename + reorder keep variant identity ----
  // (Finisher fix: the builder's first cut matched values and
  // combinations by string, so renaming a value silently rebuilt
  // its variants at the base price and re-enabled unavailable
  // ones. The deployed live proof caught it; these checks pin the
  // corrected semantics: values match by name, then — while the
  // group size is unchanged — by position, and variants match by
  // their value-id combination.)
  {
    let n = 0;
    const fig = sm.createProduct(db, LEAD_A, {
      name: 'Rename Fig',
      price: 50,
      status: 'published',
      options: [
        { name: 'Pot', values: ['Nursery', 'Eco'] },
        { name: 'Size', values: ['Small', 'Large'] },
      ],
      variants: [{ values: { Pot: 'Eco', Size: 'Large' }, price_cents: 9100, sku: 'FIG-ECO-L', available: false }],
    });
    const before = Object.fromEntries(fig.variants.map((v) => [v.label, v]));
    const renamedFig = sm.updateProduct(db, LEAD_A, fig.id, {
      options: [
        { name: 'Pot', values: ['Nursery', 'Eco Pot'] },
        { name: 'Size', values: ['Small', 'Large'] },
      ],
    });
    const ecoLarge2 = renamedFig.variants.find((v) => v.label === 'Eco Pot · Large');
    assert.ok(ecoLarge2, 'renamed combination exists');
    n++;
    assert.equal(ecoLarge2.id, before['Eco · Large'].id, 'value rename keeps the variant row');
    n++;
    assert.equal(ecoLarge2.price_cents, 9100, 'value rename keeps the override price');
    n++;
    assert.equal(ecoLarge2.available, false, 'value rename keeps the availability flag');
    n++;
    assert.equal(ecoLarge2.sku, 'FIG-ECO-L', 'value rename keeps the SKU');
    n++;
    assert.equal(
      renamedFig.variants.find((v) => v.label === 'Nursery · Small').id,
      before['Nursery · Small'].id,
      'untouched combinations keep their rows through a rename'
    );
    n++;
    // Reorder: swapping the Size values must not move prices
    // between combinations.
    const reordered = sm.updateProduct(db, LEAD_A, fig.id, {
      options: [
        { name: 'Pot', values: ['Nursery', 'Eco Pot'] },
        { name: 'Size', values: ['Large', 'Small'] },
      ],
    });
    const ecoLarge3 = reordered.variants.find((v) => v.label === 'Eco Pot · Large');
    assert.equal(ecoLarge3.id, before['Eco · Large'].id, 'value reorder keeps the variant row');
    n++;
    assert.equal(ecoLarge3.price_cents, 9100, 'value reorder keeps the price on its own combination');
    n++;
    // Rename + shrink in one update: the group size changed, so a
    // rename cannot be told apart from remove+add — the removed
    // value's variants go with it and the matrix is exactly the
    // surviving combinations.
    const shrunkFig = sm.updateProduct(db, LEAD_A, fig.id, {
      options: [
        { name: 'Pot', values: ['Nursery'] },
        { name: 'Size', values: ['Large', 'Small'] },
      ],
    });
    assert.equal(shrunkFig.variants.length, 2, 'shrunk matrix has only the surviving combinations');
    n++;
    assert.ok(
      shrunkFig.variants.every((v) => v.values[0] === 'Nursery'),
      'only Nursery combinations remain'
    );
    n++;
    group('Part 2c2 value rename + reorder identity (finisher fix)', n);
  }

  // ---- 2d: checkout carries the variant (stubbed shopStripe) ----
  {
    let n = 0;
    const shopStripe = require(path.join(root, 'server/shopStripe.js'));
    const sessions = [];
    const stubClient = {
      checkout: {
        sessions: {
          create: async (params) => {
            sessions.push(params);
            return {
              id: 'cs_test_127_' + sessions.length,
              url: 'https://checkout.stripe.test/cs127',
              payment_intent: 'pi_127',
            };
          },
        },
      },
    };
    const realResolve = shopStripe.resolveForLead;
    const realConfigured = shopStripe.isConfiguredForLead;
    shopStripe.resolveForLead = () => ({ source: 'lead', client: stubClient });
    shopStripe.isConfiguredForLead = () => true;
    try {
      sm.attachModule(db, LEAD_A, 'ecommerce', { workspaceId: WS_ID, appUrl: 'https://example.test' });
      const emb = sm.getEmbedRow(db, LEAD_A, 'ecommerce');
      const eco = monstera.variants.find((v) => v.values[0] === 'EcoPot');

      const co = await sm.createShopCheckoutByToken(
        db,
        emb.public_token,
        { productId: monstera.id, variantId: eco.id, returnUrl: 'https://site.example/shop.html' },
        {}
      );
      assert.equal(co.mode, 'stripe', 'variant checkout mints a session');
      n++;
      const order = db.prepare('SELECT * FROM ecommerce_orders WHERE id = ?').get(co.orderId);
      assert.equal(order.variant_id, eco.id, 'order records the variant id');
      n++;
      assert.equal(order.variant_label, 'EcoPot (recycled)', 'order snapshots the variant label');
      n++;
      assert.equal(order.amount_cents, 6800, 'order amount is the VARIANT price');
      n++;
      assert.equal(order.product_name, 'Monstera Deliciosa', 'order keeps the product name');
      n++;
      const sess = sessions[sessions.length - 1];
      assert.equal(sess.line_items[0].price_data.unit_amount, 6800, 'Stripe line prices from the variant row');
      n++;
      assert.ok(
        sess.line_items[0].price_data.product_data.name.includes('EcoPot (recycled)'),
        'Stripe line name carries the variant'
      );
      n++;
      assert.equal(sess.metadata.bitpype_variant_id, String(eco.id), 'session metadata carries the variant id');
      n++;

      const orderCount = () => db.prepare('SELECT COUNT(*) AS c FROM ecommerce_orders WHERE lead_id = ?').get(LEAD_A).c;
      const beforeOrders = orderCount();
      await assert.rejects(
        () =>
          sm.createShopCheckoutByToken(
            db,
            emb.public_token,
            { productId: monstera.id, returnUrl: 'https://site.example/shop.html' },
            {}
          ),
        (e) => e.code === 'VALIDATION',
        'variant product without a selection is refused'
      );
      n++;
      const unavailable = sm.createProduct(db, LEAD_A, {
        name: 'Ghost Orchid',
        price: 90,
        status: 'published',
        options: [{ name: 'Pot', values: ['EcoPot'] }],
        variants: [{ values: ['EcoPot'], available: false }],
      });
      await assert.rejects(
        () =>
          sm.createShopCheckoutByToken(
            db,
            emb.public_token,
            {
              productId: unavailable.id,
              variantId: unavailable.variants[0].id,
              returnUrl: 'https://site.example/shop.html',
            },
            {}
          ),
        (e) => e.code === 'VALIDATION' && /unavailable/.test(e.message),
        'an unavailable variant cannot be bought'
      );
      n++;
      const foreign = sm.createProduct(db, LEAD_B, {
        name: 'Rival Fern',
        price: 12,
        status: 'published',
        options: [{ name: 'Pot', values: ['EcoPot'] }],
      });
      await assert.rejects(
        () =>
          sm.createShopCheckoutByToken(
            db,
            emb.public_token,
            { productId: monstera.id, variantId: foreign.variants[0].id, returnUrl: 'https://site.example/shop.html' },
            {}
          ),
        (e) => e.code === 'NOT_FOUND',
        "another lead's variant id never resolves"
      );
      n++;
      await assert.rejects(
        () =>
          sm.createShopCheckoutByToken(
            db,
            emb.public_token,
            { productId: plain.id, variantId: eco.id, returnUrl: 'https://site.example/shop.html' },
            {}
          ),
        (e) => e.code === 'VALIDATION',
        'a variant id on a variant-less product is refused'
      );
      n++;
      assert.equal(orderCount(), beforeOrders, 'refused checkouts write no orders');
      n++;

      const coPlain = await sm.createShopCheckoutByToken(
        db,
        emb.public_token,
        { productId: plain.id, returnUrl: 'https://site.example/shop.html' },
        {}
      );
      const plainOrder = db.prepare('SELECT * FROM ecommerce_orders WHERE id = ?').get(coPlain.orderId);
      assert.equal(plainOrder.amount_cents, 2400, 'variant-less checkout still prices from the product');
      n++;
      assert.equal(plainOrder.variant_id, null, 'variant-less order has no variant id');
      n++;
      assert.equal(plainOrder.variant_label, '', 'variant-less order has an empty variant label');
      n++;
    } finally {
      shopStripe.resolveForLead = realResolve;
      shopStripe.isConfiguredForLead = realConfigured;
    }
    group('Part 2d checkout carries the variant', n);
  }

  // ---- 2e: shared layer + categories composition (Victoria shape) ----
  {
    let n = 0;
    const items = share.listSharedItems(db, LEAD_A, 'ecommerce');
    const sharedMonstera = items.find((i) => i.title === 'Monstera Deliciosa');
    assert.ok(sharedMonstera, 'shared layer lists the variant product');
    n++;
    assert.equal(sharedMonstera.meta.price_cents, 5800, 'shared price = lowest AVAILABLE variant price');
    n++;
    const shelf = cats.createCategory(db, LEAD_A, { scope: 'ecommerce', name: 'Best Sellers', status: 'published' });
    cats.assignItem(db, LEAD_A, { consumer_type: 'ecommerce', item_id: monstera.id, category_id: shelf.id });
    const shelfItems = share.listSharedItemsByCategory(db, LEAD_A, shelf.id).items;
    assert.ok(
      shelfItems.some((i) => i.source_type === 'ecommerce' && Number(i.source_id) === monstera.id),
      'categorized variant product resolves through items-by-category'
    );
    n++;
    const repriced = sm.updateProduct(db, LEAD_A, monstera.id, {
      variants: [{ values: ['Nursery Pot'], price_cents: 5100 }],
    });
    assert.equal(
      repriced.variants.find((v) => v.values[0] === 'Nursery Pot').price_cents,
      5100,
      'variant edit lands after categorization'
    );
    n++;
    const itemsAfter = share.listSharedItems(db, LEAD_A, 'ecommerce');
    assert.equal(
      itemsAfter.find((i) => i.title === 'Monstera Deliciosa').meta.price_cents,
      5100,
      'shared price follows variant edits, categories undisturbed'
    );
    n++;
    group('Part 2e shared layer + categories composition', n);
  }

  // ---- 2f: public payloads ----
  {
    let n = 0;
    const emb = sm.getEmbedRow(db, LEAD_A, 'ecommerce');
    const payload = sm.getPublicModuleByToken(db, emb.public_token);
    const pub = payload.items.find((p) => p.name === 'Monstera Deliciosa');
    assert.ok(pub, 'public payload lists the product');
    n++;
    assert.deepEqual(
      pub.options,
      [{ name: 'Pot', values: ['Nursery Pot', 'EcoPot'] }],
      'public payload carries the axes'
    );
    n++;
    assert.equal(pub.variants.length, 2, 'public payload carries the variants');
    n++;
    assert.equal(pub.variants[0].sku, undefined, 'SKUs never reach the public payload');
    n++;
    assert.equal(pub.price_label, 'From $51.00', 'public label follows the display rule after edits');
    n++;
    const detail = sm.getPublicModuleItem(db, emb.public_token, monstera.slug).item;
    assert.equal(detail.has_variants, true, 'product detail payload is variant-shaped');
    n++;
    assert.equal(
      detail.variants.find((v) => v.values[0] === 'EcoPot').price_label,
      '$68.00',
      'detail variant prices are labeled'
    );
    n++;
    group('Part 2f public payloads', n);
  }

  // ---- 2g: MCP dispatch surface ----
  {
    let n = 0;
    const mcp = require(path.join(root, 'server/mcp.js'));
    const made = await mcp.callTool(
      WS_ID,
      'ecommerce.create',
      {
        leadId: LEAD_A,
        name: 'Agent Aloe',
        price: 20,
        status: 'published',
        options: [{ name: 'Size', values: ['Small', 'Large'] }],
        variants: [{ values: ['Large'], price_cents: 2600 }],
      },
      {}
    );
    assert.ok(made.ok && made.data && made.data.product, 'ecommerce.create dispatches with options');
    n++;
    assert.equal(made.data.product.variants.length, 2, 'agent-created product has its matrix');
    n++;
    assert.equal(
      made.data.product.variants.find((v) => v.values[0] === 'Large').price_cents,
      2600,
      'agent override price lands'
    );
    n++;
    const listed = await mcp.callTool(WS_ID, 'ecommerce.list', { leadId: LEAD_A }, {});
    const agentAloe = listed.data.products.find((p) => p.name === 'Agent Aloe');
    assert.ok(agentAloe && agentAloe.has_variants, 'ecommerce.list returns the variant structure');
    n++;
    assert.equal(agentAloe.price_label, 'From $20.00', 'ecommerce.list label follows the display rule');
    n++;
    const stripped = await mcp.callTool(
      WS_ID,
      'ecommerce.update',
      { leadId: LEAD_A, id: made.data.product.id, options: [] },
      {}
    );
    assert.equal(stripped.data.product.has_variants, false, 'agent can remove variants with options []');
    n++;
    group('Part 2g MCP dispatch surface', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
  {
    let n = 0;
    const q = platformDb.query;
    const bcrypt = require('bcryptjs');
    await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)', {
      e: 'owner127@example.invalid',
      h: bcrypt.hashSync(['Unused', 'Pass', '127'].join('') + '!', 12),
      n: 'B127 Portal Link',
      s: 'active',
    });
    await q(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
      { e: 'owner127@example.invalid', h: bcrypt.hashSync(PW, 12), w: WS_ID, l: LEAD_A, b: 'B127 Plant Shop' }
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
      const owner = makeJar();
      {
        const res = await post(owner, '/api/v1/portal/login', { email: 'owner127@example.invalid', password: PW });
        assert.equal(res.status, 200, 'portal owner login');
        n++;
      }
      {
        const res = await fetch(`${BASE}/api/v1/portal/modules/ecommerce`);
        assert.equal(res.status, 401, 'anonymous product list refused');
        n++;
      }
      let httpProduct = null;
      {
        const res = await post(owner, '/api/v1/portal/modules/ecommerce', {
          name: 'HTTP Hoya',
          price: 44,
          status: 'published',
          options: [{ name: 'Pot', values: ['Nursery Pot', 'EcoPot'] }],
          variants: [{ values: ['EcoPot'], price_cents: 5200, sku: 'HOY-ECO' }],
        });
        const body = await json(res);
        assert.equal(res.status, 200, 'portal creates a variant product');
        httpProduct = body.data.item || body.data.product || body.item;
        assert.ok(httpProduct && httpProduct.id, 'created product returned');
        n++;
        assert.equal(httpProduct.variants.length, 2, 'portal-created product carries its matrix');
        n++;
        assert.equal(
          httpProduct.variants.find((v) => v.values[0] === 'EcoPot').price_cents,
          5200,
          'portal override price lands over HTTP'
        );
        n++;
      }
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/ecommerce`);
        const body = await json(res);
        const items = body.data.items || [];
        const listed = items.find((p) => p.name === 'HTTP Hoya');
        assert.ok(listed && listed.has_variants, 'portal list returns the variant structure');
        n++;
        assert.equal(listed.price_label, 'From $44.00', 'portal list label follows the display rule');
        n++;
      }
      const emb = sm.getEmbedRow(db, LEAD_A, 'ecommerce');
      {
        const res = await fetch(`${BASE}/api/v1/modules/public/${emb.public_token}`);
        const body = await json(res);
        const pub = (body.data.items || []).find((p) => p.name === 'HTTP Hoya');
        assert.ok(pub && pub.has_variants, 'public payload serves the HTTP-created variant product');
        n++;
      }
      {
        const ordersBefore = db.prepare('SELECT COUNT(*) AS c FROM ecommerce_orders WHERE lead_id = ?').get(LEAD_A).c;
        const variantId = httpProduct.variants.find((v) => v.values[0] === 'EcoPot').id;
        const res = await fetch(`${BASE}/api/v1/modules/public/${emb.public_token}/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productId: httpProduct.id,
            variantId,
            returnUrl: 'https://site.example/shop.html',
          }),
        });
        const body = await json(res);
        assert.ok(!body.ok, 'checkout without Stripe configured fails clean');
        n++;
        assert.ok(
          /STRIPE_NOT_CONFIGURED|not configured/i.test(JSON.stringify(body)),
          'failure names the missing shop Stripe config'
        );
        n++;
        assert.equal(
          db.prepare('SELECT COUNT(*) AS c FROM ecommerce_orders WHERE lead_id = ?').get(LEAD_A).c,
          ordersBefore,
          'a failed checkout writes no order'
        );
        n++;
      }
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
    group('Part 3 HTTP portal + public flow', n);
  }

  console.log(`\nBATCH127 ALL PASS — ${groups.length} groups: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('\nBATCH127 SUITE FAIL:', e);
  process.exit(1);
});
