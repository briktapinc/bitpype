'use strict';
/**
 * Batch 128 — the Checkout MODULE (Ely: "if not lets add one") and
 * the completed shop money path behind it, incl. SELLING GALLERY
 * PHOTOS (Ely: "I can SELL photos").
 *
 * The batch wraps the Batch 19/51 shop plumbing (per-lead shop
 * Stripe keys in server/shopStripe.js, single-product checkout,
 * ecommerce_orders, the signed shop webhook) into a first-class
 * module type `checkout` and generalizes the sellable line:
 * { source, itemId, quantity, variantId? } priced SERVER-SIDE
 * through the source module's own rows — ecommerce products (photo
 * snapshotted from the product row) and gallery photos (priced on
 * gallery_images.price_cents, published albums only, sold ×1,
 * delivered as the download on the paid success state).
 *
 * What this pins:
 *   Part 1 — source pins: `checkout` is the 25th MODULE_TYPE with
 *     catalog metadata, MODULE_SCRIPT_VER mod32, an explicit
 *     NON-provider moduleShare entry (parity at 25), the cart/order
 *     tables + functions, the public checkout-cart route + lead-
 *     scoped order-status, the portal panes + config route, the
 *     embed cart/checkout surface (photos on lines, placeholder for
 *     photoless, photo download delivery), gallery price support,
 *     MCP/catalog/parity/agent surfaces, the census line, and the
 *     cache-busts.
 *   Part 2 — engine (in-process, real modules): checkout config
 *     CRUD, shop key MODE surfaced in status + mode-mix saves
 *     refused (membership saves unaffected), the generic sellable
 *     line (server pricing with tampered client prices ignored,
 *     photo lines with the exact image, every refusal: unpriced /
 *     draft-album / foreign-lead / qty>1 photo, external-link
 *     product, mixed currency, draft product, unknown source,
 *     pre-variants variantId), categories refusing the checkout
 *     scope, and the public payloads (shop + gallery name the
 *     checkout page/token; checkout payload carries config + cart
 *     state; detached checkout stops serving).
 *   Part 3 — money flows against a STUBBED Stripe boundary (the
 *     production-regressions load() VM pattern; stub clients
 *     remember which secret built them): cart checkout records a
 *     pending order + line items and charges the LEAD's keys; the
 *     legacy single buy records exactly one line; the shop webhook
 *     verifies with the shop's own secret, pays the order, and a
 *     replay changes nothing; expired marks the order expired; a
 *     failing session create leaves a 'failed' order, never a
 *     phantom; an unconfigured shop writes NO order; live keys run
 *     the same path in live mode (mode is configuration, the proof
 *     itself never touches a real Stripe).
 *   Part 4 — HTTP over the real server: portal owner session reads
 *     the checkout block (config + payments + orders) and the shop
 *     orders, the config PUT round-trips, public refusal paths
 *     (detached token 404, empty cart 400), and order-status lead
 *     scoping (own token reads the order WITH its photo line; a
 *     foreign lead's token gets 404).
 *
 * NEGATIVE hooks (source pins only):
 *   B128_NEGATIVE=no-type      checkout leaves MODULE_TYPES
 *   B128_NEGATIVE=no-registry  registry drops the checkout entry
 *   B128_NEGATIVE=no-embed     module-embed loses renderCheckout
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch128-'));
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'app.db');
process.env.SQLITE_PATH = process.env.DB_PATH;
['.env', 'app.db', 'data.db', 'leads.db', 'platform.db'].forEach((name) => {
  process.env[name.toUpperCase().replace(/\W/g, '_') + '_PATH'] = path.join(process.env.REGRESSION_TMPDIR, name);
});
process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqlite';
process.env.APP_SECRET = ['b128', 'app', 'secret'].join('-');
process.env.SESSION_SECRET = ['batch128', 'regression', 'session', 'secret'].join('-');
// Batch 128 finisher: the gate image boots NODE_ENV=production, and
// the spawned fixture server refuses to boot without this pair —
// sibling suites 125/126/132 carry the same two lines in-header.
process.env.CAPTCHA_OPTIONAL = '1';
process.env.APP_URL = 'https://bitpype.test';
process.env.COOKIE_SECURE = 'false';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';
process.env.STRIPE_TEST_MODE = process.env.STRIPE_TEST_MODE || 'true';

const root = path.resolve(__dirname, '..');
const PORT = 39128;
const BASE = `http://127.0.0.1:${PORT}`;
const LEAD_A = 12801;
const LEAD_B = 12802;
const LEAD_D = 12804;
const LEAD_E = 12805;
const LEAD_F = 12806;
const LEAD_G = 12807;
const PW = ['B128', 'Portal', 'Pass', '9'].join('-') + '!';
const NEGATIVE = process.env.B128_NEGATIVE || '';
// Fixture Stripe material — fragment-assembled at runtime, never a
// credential literal in the file (write-path redaction hazard).
const SK_TEST = ['sk', 'test', 'FIXTURE128ALPHA'].join('_');
const SK_LIVE = ['sk', 'live', 'FIXTURE128BETA'].join('_');
const SK_FAIL = ['sk', 'test', 'FAIL128CREATE'].join('_');
const PK_TEST = ['pk', 'test', 'fixture128'].join('_');
const PK_LIVE = ['pk', 'live', 'fixture128'].join('_');
const WHSEC = ['whsec', 'fixture128signing'].join('_');

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

/* The production-regressions load() VM harness: a module loader with
 * per-file mocks, so the Stripe boundary can be stubbed while the
 * real shop code runs. Unmocked relative deps fall back to the real
 * require (same SQL-level code, same db handle). */
const SPLIT_MODULES = new Set([
  'portalAccounts',
  'portalShared',
  'portalSiteEdits',
  'portalSocial',
  'portalForms',
  'portalModules',
  'portalBilling',
  'portalLeadScout',
  'portalSiteChat',
  'museAgentTools',
  'museAgentCore',
  'museAgentClassifier',
  'museAgentPlanner',
  'aiRouting',
  'paymentsConfig', // Batch 129: the unified payments config joins the stubbed module graph
]);
function load(file, mocks) {
  const cache = new Map();
  const inner = (f) => {
    if (cache.has(f)) return cache.get(f);
    const module = { exports: {} };
    cache.set(f, module.exports);
    vm.runInNewContext(
      fs.readFileSync(path.join(root, f), 'utf8'),
      {
        module,
        exports: module.exports,
        require: (name) => {
          if (Object.hasOwn(mocks, name)) return mocks[name];
          if (!name.startsWith('.')) return require(name);
          if (SPLIT_MODULES.has(path.basename(name))) return inner('server/' + path.basename(name) + '.js');
          return require(path.join(root, path.dirname(f), name));
        },
        process: { env: process.env },
        console,
        Buffer,
        URL,
        Date,
        setTimeout,
        clearTimeout,
      },
      { filename: f }
    );
    cache.set(f, module.exports);
    return module.exports;
  };
  return inner(file);
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
    if (NEGATIVE !== 'no-type') {
      assert.ok(smSrc.includes("'checkout',"), 'checkout registered in MODULE_TYPES');
      n++;
    }
    assert.ok(smSrc.includes("checkout: { label: 'Checkout'"), 'MODULE_META carries the Checkout label');
    n++;
    assert.ok(smSrc.includes("const MODULE_SCRIPT_VER = 'mod32'"), 'MODULE_SCRIPT_VER bumped to mod32');
    n++;
    assert.ok(smSrc.includes('CREATE TABLE IF NOT EXISTS ecommerce_order_items'), 'order line-items table exists');
    n++;
    assert.ok(smSrc.includes('CREATE TABLE IF NOT EXISTS checkout_configs'), 'checkout config table exists');
    n++;
    assert.ok(smSrc.includes('function buildSellableLines'), 'the generic sellable line builder exists');
    n++;
    assert.ok(smSrc.includes('function createCartCheckoutByToken'), 'cart checkout entry point exists');
    n++;
    assert.ok(smSrc.includes('function getSellableGalleryImage'), 'gallery sellable resolver exists');
    n++;
    assert.ok(smSrc.includes('price_cents INTEGER NOT NULL DEFAULT 0'), 'gallery photos carry a price column');
    n++;

    const shareSrc = read('server/moduleShare.js');
    if (NEGATIVE !== 'no-registry') {
      assert.ok(
        /checkout: \{\s*\n\s*kind: 'none',/.test(shareSrc),
        'moduleShare registry: checkout is an explicit NON-provider'
      );
      n++;
    }
    assert.ok(shareSrc.includes('orders are private'), 'registry entry states why (orders are private)');
    n++;

    const pubSrc = read('server/routes/modulesPublic.js');
    assert.ok(pubSrc.includes("router.post('/:token/checkout-cart'"), 'public cart checkout route exists');
    n++;
    assert.ok(pubSrc.includes('Number(order.lead_id) !== Number(embed.lead_id)'), 'order-status is lead-scoped');
    n++;
    assert.ok(pubSrc.includes('listShopOrderItems'), 'order-status returns the recorded line items');
    n++;

    const notifySrc = read('server/ownerNotify.js');
    assert.ok(notifySrc.includes('ecommerce_order_items'), 'owner order email names the line items');
    n++;

    const embedSrc = read('public/js/module-embed.js');
    if (NEGATIVE !== 'no-embed') {
      assert.ok(embedSrc.includes('function renderCheckout'), 'embed renders the Checkout module surface');
      n++;
    }
    assert.ok(embedSrc.includes("'/checkout-cart'"), 'embed posts the cart to the checkout-cart route');
    n++;
    assert.ok(embedSrc.includes('data-bp-add-photo'), 'priced gallery photos get an Add to cart button');
    n++;
    assert.ok(embedSrc.includes('data-bp-add'), 'cart-mode products get Add to cart');
    n++;
    assert.ok(embedSrc.includes('bp-mod-cart-thumb-empty'), 'photoless lines get a placeholder, never a broken image');
    n++;
    assert.ok(embedSrc.includes('Download photo'), 'paid photo lines deliver the download on the success state');
    n++;
    assert.ok(embedSrc.includes('bp-cart-'), 'the shared cart is keyed by the checkout token');
    n++;

    const portalJs = read('public/js/portal.js');
    assert.ok(portalJs.includes("{ type: 'checkout', label: 'Checkout' }"), 'portal catalog lists Checkout');
    n++;
    assert.ok(portalJs.includes('function renderCheckoutPanel'), 'portal has the Checkout pane renderer');
    n++;
    assert.ok(portalJs.includes('function shopOrdersHtml'), 'portal renders orders with line items');
    n++;
    assert.ok(portalJs.includes("api('/modules/checkout/config'"), 'portal saves checkout settings via its route');
    n++;
    const portalHtml = read('public/portal.html');
    assert.ok(portalHtml.includes('id="modules-checkout-panel"'), 'portal.html hosts the checkout panel');
    n++;
    assert.ok(portalHtml.includes('id="modules-shop-orders-panel"'), 'portal.html hosts the shop orders panel');
    n++;
    assert.ok(portalHtml.includes('portal.js?v=batch128-checkout1'), 'portal.js cache-bust rotated');
    n++;
    const portalRoutes = read('server/routes/portal.js');
    assert.ok(portalRoutes.includes("router.put('/modules/checkout/config'"), 'portal config route registered');
    n++;

    const mcpSrc = read('server/mcp.js');
    assert.ok(mcpSrc.includes("name: 'checkout.getConfig'"), 'hosted MCP carries checkout.getConfig');
    n++;
    assert.ok(mcpSrc.includes("name: 'checkout.listOrders'"), 'hosted MCP carries checkout.listOrders');
    n++;
    const catalogSrc = read('src/mcpCatalog.js');
    assert.ok(catalogSrc.includes("name: 'checkout.updateConfig'"), 'src catalog carries checkout.updateConfig');
    n++;
    const paritySrc = read('src/mcpParityTools.js');
    assert.ok(paritySrc.includes("'checkout.listOrders': parityEntry"), 'parity tools carry checkout.listOrders');
    n++;
    const agentSrc = read('server/museAgentTools.js');
    assert.ok(agentSrc.includes("'checkout.getConfig',"), 'agent readonly fence carries checkout.getConfig');
    n++;
    assert.ok(agentSrc.includes("'checkout.updateConfig',"), 'agent write fence carries checkout.updateConfig');
    n++;
    const censusSrc = read('server/portalSiteChat.js');
    assert.ok(censusSrc.includes('Checkout module: attached'), 'design-chat census names the checkout state');
    n++;
    group('Part 1 source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — engine (in-process, real modules)                          */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const share = require(path.join(root, 'server/moduleShare.js'));
  const cats = require(path.join(root, 'server/categories.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a128@example.invalid',
    password: PW,
    name: 'A128',
    workspaceName: 'Batch128 WS',
  });
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'a128@example.invalid' });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B128 Alpha Studio', 'alpha128@example.invalid'],
    [LEAD_B, 'B128 Beta Studio', 'beta128@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
    db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (?, ?, ?, ?)').run(
      id,
      name + ' Site',
      '{}',
      JSON.stringify([
        {
          slug: 'index',
          title: 'Home',
          sections: [
            { type: 'nav', content: {} },
            { type: 'footer', content: {} },
          ],
        },
      ])
    );
  }
  const attach = (leadId, type) =>
    sm.attachModule(db, leadId, type, { workspaceId: WS_ID, appUrl: 'https://example.test' });
  const tokenOf = (leadId, type) => sm.getEmbedRow(db, leadId, type).public_token;

  // ---- Fixtures: products + gallery for A; a product for B ----
  const mug = sm.createProduct(db, LEAD_A, {
    name: 'Enamel Mug',
    price_cents: 2500,
    currency: 'USD',
    image_url: 'https://img.example/mug.jpg',
    status: 'published',
  });
  const plain = sm.createProduct(db, LEAD_A, { name: 'Plain Sticker', price_cents: 1000, status: 'published' });
  const euro = sm.createProduct(db, LEAD_A, {
    name: 'Euro Print',
    price_cents: 3000,
    currency: 'EUR',
    status: 'published',
  });
  const ext = sm.createProduct(db, LEAD_A, {
    name: 'External Thing',
    price_cents: 500,
    checkout_url: 'https://elsewhere.example/buy',
    status: 'published',
  });
  const draftProd = sm.createProduct(db, LEAD_A, { name: 'Secret Draft', price_cents: 700, status: 'draft' });
  const betaProd = sm.createProduct(db, LEAD_B, { name: 'Beta Widget', price_cents: 1100, status: 'published' });
  const albumPub = sm.createAlbum(db, LEAD_A, {
    title: 'Bay Collection',
    status: 'published',
    images: [
      { image_url: 'https://img.example/sunset.jpg', caption: 'Sunset over the bay', price_cents: 4000 },
      { image_url: 'https://img.example/free.jpg', caption: 'Free sample' },
    ],
  });
  const pricedPhoto = albumPub.images.find((im) => Number(im.price_cents) === 4000);
  const freePhoto = albumPub.images.find((im) => Number(im.price_cents) === 0);
  const albumDraft = sm.createAlbum(db, LEAD_A, {
    title: 'Unreleased',
    status: 'draft',
    images: [{ image_url: 'https://img.example/hidden.jpg', caption: 'Hidden gem', price_cents: 900 }],
  });
  const hiddenPhoto = albumDraft.images[0];

  {
    let n = 0;
    assert.equal(sm.MODULE_TYPES.length, 27, 'catalog at 27 types');
    assert.equal(sm.MODULE_TYPES[26], 'checkout', 'checkout is the 27th type');
    n += 2;
    assert.deepEqual(
      Object.keys(share.SHARE_REGISTRY).sort(),
      [...sm.MODULE_TYPES].sort(),
      'moduleShare registry parity at 27 types'
    );
    n++;
    assert.equal(share.SHARE_REGISTRY.checkout.kind, 'none', 'checkout is a deliberate non-provider');
    n++;

    // Checkout config: default + round-trip + the 300-char cap.
    assert.equal(sm.getCheckoutConfig(db, LEAD_A).success_message, '', 'config defaults empty');
    n++;
    const cfg = sm.updateCheckoutConfig(db, LEAD_A, { success_message: '  Thanks a bunch!  ' });
    assert.equal(cfg.success_message, 'Thanks a bunch!', 'config saves (trimmed)');
    n++;
    assert.equal(sm.getCheckoutConfig(db, LEAD_A).success_message, 'Thanks a bunch!', 'config round-trips');
    n++;
    const capped = sm.updateCheckoutConfig(db, LEAD_A, { success_message: 'x'.repeat(301) });
    assert.equal(capped.success_message.length, 300, 'success message is capped at 300 chars');
    n++;
    sm.updateCheckoutConfig(db, LEAD_A, { success_message: 'Thanks a bunch!' });
    assert.equal(sm.getCheckoutConfig(db, LEAD_B).success_message, '', 'config is lead-scoped');
    n++;
    group('Part 2a registry + checkout config', n);
  }

  {
    let n = 0;
    // Mode is surfaced before any keys exist, and mode-mixed saves
    // are refused — a test publishable key can never pair with a
    // live secret again (the two used to be able to diverge
    // silently, and nothing anywhere said which mode would run).
    const before = sm.shopStripeStatus(db, LEAD_A);
    assert.equal(before.connected, false);
    assert.equal(before.mode, null, 'status carries mode (null when unconfigured)');
    n += 2;
    assert.throws(
      () => sm.saveShopStripeKeys(db, LEAD_A, { publishable_key: PK_TEST, secret_key: SK_LIVE }),
      (e) => e.code === 'VALIDATION' && /same Stripe mode/.test(e.message),
      'pk_test + sk_live refused at save'
    );
    n++;
    assert.equal(sm.shopStripeStatus(db, LEAD_A).connected, false, 'a refused save writes nothing');
    n++;
    // Batch 129 SUPERSEDES the Batch 128 expectation that used to
    // live here ("membership key save unaffected by the shop mode
    // rule"): the streamline made ONE payments config behind both
    // surfaces, so the mode-mix refusal now applies to a membership
    // save too — a test publishable key can never pair with a live
    // secret in the unified config, whichever pane saved it.
    assert.throws(
      () => sm.saveMembershipStripeKeys(db, LEAD_A, { publishable_key: PK_TEST, secret_key: SK_LIVE }),
      (e) => e.code === 'VALIDATION' && /same Stripe mode/.test(e.message),
      'Batch 129: the unified config refuses a mixed-mode membership save'
    );
    n++;
    assert.equal(sm.membershipStripeStatus(db, LEAD_A).connected, false, 'a refused membership save writes nothing');
    n++;
    const saved = sm.saveShopStripeKeys(db, LEAD_A, {
      publishable_key: PK_TEST,
      secret_key: SK_TEST,
      webhook_secret: WHSEC,
    });
    assert.equal(saved.connected, true);
    assert.equal(saved.mode, 'test', 'status reports test mode from the saved secret');
    n += 2;
    assert.ok(!JSON.stringify(saved).includes(SK_TEST), 'status never carries the secret');
    n++;
    group('Part 2b shop key modes', n);
  }

  {
    let n = 0;
    const lines = (items) => sm.buildSellableLines(db, LEAD_A, items);
    // Server-side pricing: the client contributes ids + qty only —
    // price fields smuggled into a line are ignored, not trusted.
    const one = lines([{ source: 'ecommerce', itemId: mug.id, quantity: 2, price_cents: 1, price: 0.01 }]);
    assert.equal(one.lines[0].unit_price_cents, 2500, 'product priced from its row, tampered price ignored');
    assert.equal(one.lines[0].line_total_cents, 5000);
    assert.equal(one.lines[0].image_url, 'https://img.example/mug.jpg', 'line carries the product photo');
    assert.equal(one.currency, 'USD');
    n += 4;
    const legacyShape = lines([{ productId: plain.id, quantity: 1 }]);
    assert.equal(legacyShape.lines[0].product_name, 'Plain Sticker', 'productId-shaped lines still resolve');
    assert.equal(legacyShape.lines[0].image_url, '', 'a photoless product lines up with an empty photo ref');
    n += 2;
    // The photo sellable: price + title + the photo itself resolve
    // from the gallery side; the album rides in source_meta.
    const photo = lines([{ source: 'gallery', itemId: pricedPhoto.id, quantity: 1 }]);
    assert.equal(photo.lines[0].unit_price_cents, 4000, 'photo priced from gallery_images.price_cents');
    assert.equal(photo.lines[0].product_name, 'Sunset over the bay', 'photo title from its caption');
    assert.equal(photo.lines[0].image_url, 'https://img.example/sunset.jpg', 'the photo IS the line image');
    assert.equal(JSON.parse(photo.lines[0].source_meta).album_id, albumPub.id, 'line records the album');
    n += 4;
    const mixed = lines([
      { source: 'ecommerce', itemId: mug.id, quantity: 1 },
      { source: 'gallery', itemId: pricedPhoto.id, quantity: 1 },
    ]);
    assert.equal(mixed.lines.length, 2, 'product + photo mix in one cart (same lead shop Stripe)');
    n++;
    const refusals = [
      [[], 'VALIDATION', 'empty cart'],
      [[{ source: 'gallery', itemId: freePhoto.id, quantity: 1 }], 'VALIDATION', 'unpriced photo is not for sale'],
      [[{ source: 'gallery', itemId: pricedPhoto.id, quantity: 2 }], 'VALIDATION', 'photos sell one at a time'],
      [[{ source: 'gallery', itemId: hiddenPhoto.id, quantity: 1 }], 'NOT_FOUND', 'draft-album photo never resolves'],
      [
        [{ source: 'ecommerce', itemId: betaProd.id, quantity: 1 }],
        'NOT_FOUND',
        "another lead's product never resolves",
      ],
      [
        [{ source: 'ecommerce', itemId: ext.id, quantity: 1 }],
        'VALIDATION',
        'external-link product keeps its own path',
      ],
      [[{ source: 'ecommerce', itemId: draftProd.id, quantity: 1 }], 'NOT_FOUND', 'draft product never resolves'],
      [
        [
          { source: 'ecommerce', itemId: euro.id, quantity: 1 },
          { source: 'gallery', itemId: pricedPhoto.id, quantity: 1 },
        ],
        'VALIDATION',
        'mixed-currency cart refused',
      ],
      [[{ source: 'bookings', itemId: 1, quantity: 1 }], 'VALIDATION', 'unknown/unplugged source refused'],
      [
        [{ source: 'ecommerce', itemId: mug.id, quantity: 1, variantId: 999 }],
        'VALIDATION',
        'a variant id before Batch 127 lands is refused, never guessed',
      ],
    ];
    for (const [items, code, label] of refusals) {
      assert.throws(
        () => lines(items),
        (e) => e.code === code,
        label
      );
      n++;
    }
    // Categories: checkout items are not categorizable content — the
    // taxonomy's assertAssignable refuses the scope because the
    // shared-layer entry is a non-provider.
    const cat = cats.createCategory(db, LEAD_A, { scope: 'blog', name: 'Guides' });
    assert.throws(
      () => cats.assignItem(db, LEAD_A, { consumerType: 'checkout', itemId: 1, categoryId: cat.id }),
      (e) => e.code === 'VALIDATION' && /cannot be categorized/.test(e.message),
      'categories.assign refuses the checkout scope'
    );
    n++;
    group('Part 2c generic sellable lines', n);
  }

  {
    let n = 0;
    attach(LEAD_A, 'ecommerce');
    attach(LEAD_A, 'gallery');
    attach(LEAD_A, 'checkout');
    attach(LEAD_B, 'checkout');
    const shopPayload = sm.getPublicModuleByToken(db, tokenOf(LEAD_A, 'ecommerce'));
    assert.equal(shopPayload.checkout_page, '/checkout', 'shop payload names the checkout page');
    assert.equal(shopPayload.checkout_token, tokenOf(LEAD_A, 'checkout'), 'shop payload carries the cart token');
    const mugPayload = shopPayload.items.find((p) => p.id === mug.id);
    assert.equal(mugPayload.stripe_checkout, true, 'shop is configured → products are stripe-buyable');
    n += 3;
    const galleryPayload = sm.getPublicModuleByToken(db, tokenOf(LEAD_A, 'gallery'));
    const albumPayload = galleryPayload.items.find((al) => al.id === albumPub.id);
    const pricedPayload = albumPayload.images.find((im) => im.id === pricedPhoto.id);
    const freePayload = albumPayload.images.find((im) => im.id === freePhoto.id);
    assert.equal(pricedPayload.for_sale, true, 'priced photo is shaped for sale');
    assert.equal(pricedPayload.price_label, '$40.00');
    assert.equal(freePayload.for_sale, false, 'unpriced photo stays display-only');
    assert.equal(galleryPayload.checkout_page, '/checkout', 'gallery payload names the checkout page');
    n += 4;
    const checkoutPayload = sm.getPublicModuleByToken(db, tokenOf(LEAD_A, 'checkout'));
    assert.equal(
      checkoutPayload.checkout.config.success_message,
      'Thanks a bunch!',
      'checkout payload carries its config'
    );
    assert.equal(checkoutPayload.checkout.cart.configured, true, 'checkout payload carries the payment state');
    assert.equal(checkoutPayload.checkout.cart.mode, 'test');
    assert.equal(checkoutPayload.checkout.shop_page, '/shop');
    assert.equal(checkoutPayload.checkout.gallery_page, '/gallery');
    n += 5;
    const dormantPayload = sm.getPublicModuleByToken(db, tokenOf(LEAD_B, 'checkout'));
    assert.equal(dormantPayload.checkout.cart.configured, false, 'an unconfigured shop reads dormant, not broken');
    assert.equal(dormantPayload.checkout.cart.mode, null);
    assert.equal(dormantPayload.checkout.shop_page, null, 'no shop attached → no shop back-link');
    n += 3;
    // Detach stops the checkout serving on the same predicate as the
    // shop: payload 404s and cart checkout refuses.
    sm.detachModule(db, LEAD_B, 'checkout');
    assert.throws(
      () => sm.getPublicModuleByToken(db, tokenOf(LEAD_B, 'checkout')),
      (e) => e.code === 'NOT_FOUND',
      'detached checkout payload 404s'
    );
    n++;
    await assert.rejects(
      () =>
        sm.createCartCheckoutByToken(
          db,
          tokenOf(LEAD_B, 'checkout'),
          { items: [{ source: 'ecommerce', itemId: 1, quantity: 1 }], returnUrl: 'https://example.test/checkout' },
          {}
        ),
      (e) => e.code === 'NOT_FOUND',
      'detached checkout refuses cart checkout'
    );
    n++;
    group('Part 2d public payloads', n);
  }

  /* ================================================================== */
  /* Part 3 — money flows against a stubbed Stripe boundary              */
  /* ================================================================== */
  {
    let n = 0;
    const crypto128 = require('node:crypto');
    const boxKey128 = crypto128.randomBytes(32);
    const box128 = {
      PREFIX: 'enc:v1:',
      hasKey: () => true,
      isEncrypted: (v) => typeof v === 'string' && v.startsWith('enc:v1:'),
      encryptValue(plain) {
        if (plain == null || plain === '' || box128.isEncrypted(plain)) return plain;
        const iv = crypto128.randomBytes(12);
        const cipher = crypto128.createCipheriv('aes-256-gcm', boxKey128, iv);
        const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
        return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
      },
      decryptValue(stored) {
        if (!box128.isEncrypted(stored)) return stored;
        const buf = Buffer.from(stored.slice('enc:v1:'.length), 'base64');
        const decipher = crypto128.createDecipheriv('aes-256-gcm', boxKey128, buf.subarray(0, 12));
        decipher.setAuthTag(buf.subarray(12, 28));
        return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
      },
      encryptSetting: (k, v) => box128.encryptValue(v),
      decryptSetting: (k, v) => box128.decryptValue(v),
    };
    // Stub Stripe whose clients remember WHICH secret built them —
    // the key-selection assertions prove which layer a call ran on.
    const stub128 = { sessions: [] };
    function StubStripe128(secretKey) {
      return {
        __secret: secretKey,
        checkout: {
          sessions: {
            create: async (params) => {
              if (String(secretKey).includes('FAIL128')) throw new Error('Stub Stripe: session create failed');
              stub128.sessions.push({ secret: secretKey, params });
              return {
                id: 'cs_test_128_' + stub128.sessions.length,
                url: 'https://checkout.stripe.test/cs128/' + stub128.sessions.length,
              };
            },
          },
        },
        webhooks: {
          constructEvent: (body, sig, secret) => {
            if (sig !== 'sig:' + secret)
              throw new Error('No signatures found matching the expected signature for payload.');
            return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
          },
        },
        accounts: {
          retrieve: async () => ({ id: 'acct_stub128', charges_enabled: true, payouts_enabled: true }),
        },
        balance: { retrieve: async () => ({ available: [], pending: [] }) },
      };
    }
    const mocksSM128 = {
      '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
      '../src/websiteEngine': require(path.join(root, 'src/websiteEngine.js')),
      './portalContacts': require(path.join(root, 'server/portalContacts.js')),
      '../src/secretBox': box128,
      './membershipStripe': {
        getClient: () => {
          throw new Error('membership Stripe is not exercised in batch128');
        },
      },
      './shopStripe': null, // filled in below, before any checkout call
    };
    const sm128 = load('server/siteModules.js', mocksSM128);
    const ss128 = load('server/shopStripe.js', {
      stripe: StubStripe128,
      '../src/secretBox': box128,
      './siteModules': sm128,
    });
    mocksSM128['./shopStripe'] = ss128;
    sm128.ensureTables(db);

    for (const [id, name] of [
      [LEAD_D, 'B128 Delta Prints'],
      [LEAD_E, 'B128 Live Mode'],
      [LEAD_F, 'B128 Failing Stripe'],
      [LEAD_G, 'B128 No Keys'],
    ]) {
      db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
        id,
        name,
        `lead${id}@example.invalid`,
        'customer'
      );
      db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (?, ?, ?, ?)').run(
        id,
        name + ' Site',
        '{}',
        JSON.stringify([
          {
            slug: 'index',
            title: 'Home',
            sections: [
              { type: 'nav', content: {} },
              { type: 'footer', content: {} },
            ],
          },
        ])
      );
    }
    const attach128 = (leadId, type) =>
      sm128.attachModule(db, leadId, type, { workspaceId: WS_ID, appUrl: 'https://example.test' });
    const token128 = (leadId, type) => sm128.getEmbedRow(db, leadId, type).public_token;

    // Lead D: full storefront — shop + gallery + checkout, own TEST keys.
    attach128(LEAD_D, 'ecommerce');
    attach128(LEAD_D, 'gallery');
    attach128(LEAD_D, 'checkout');
    const mugD = sm128.createProduct(db, LEAD_D, {
      name: 'Delta Mug',
      price_cents: 2500,
      image_url: 'https://img.example/delta-mug.jpg',
      status: 'published',
    });
    const plainD = sm128.createProduct(db, LEAD_D, { name: 'Delta Sticker', price_cents: 1000, status: 'published' });
    const albumD = sm128.createAlbum(db, LEAD_D, {
      title: 'Delta Gallery',
      status: 'published',
      images: [{ image_url: 'https://img.example/delta-print.jpg', caption: 'Delta Print', price_cents: 4000 }],
    });
    const photoD = albumD.images[0];
    sm128.saveShopStripeKeys(db, LEAD_D, { publishable_key: PK_TEST, secret_key: SK_TEST, webhook_secret: WHSEC });

    // ---- Cart checkout: mixed product + photo, tampered prices ----
    const cart = await sm128.createCartCheckoutByToken(
      db,
      token128(LEAD_D, 'checkout'),
      {
        items: [
          { source: 'ecommerce', itemId: mugD.id, quantity: 2, price_cents: 1 },
          { source: 'gallery', itemId: photoD.id, quantity: 1, price_cents: 1 },
        ],
        returnUrl: 'https://fixture.test/checkout',
      },
      {}
    );
    assert.ok(cart.url.includes('checkout.stripe.test'), 'cart checkout returns the Stripe session URL');
    assert.ok(cart.orderId > 0);
    n += 2;
    const cartSession = stub128.sessions[stub128.sessions.length - 1];
    assert.equal(cartSession.secret, SK_TEST, "the session ran on the LEAD's own shop keys");
    assert.equal(cartSession.params.line_items.length, 2, 'one Stripe line per cart line');
    assert.deepEqual(
      cartSession.params.line_items.map((li) => li.price_data.unit_amount),
      [2500, 4000],
      'Stripe amounts are the SERVER prices — tampered client prices never reach Stripe'
    );
    assert.deepEqual(
      cartSession.params.line_items.map((li) => li.quantity),
      [2, 1]
    );
    assert.equal(cartSession.params.metadata.bitpype_order_id, String(cart.orderId));
    assert.ok(cartSession.params.success_url.includes('order=success'), 'success returns to the checkout page');
    n += 6;
    const cartOrder = sm128.listShopOrdersWithItems(db, LEAD_D).find((o) => o.id === cart.orderId);
    assert.equal(cartOrder.status, 'pending', 'order starts pending');
    assert.equal(cartOrder.amount_cents, 9000, 'order total is the server-priced sum');
    // Batch 129: keys saved through the portal save path now land in
    // the ONE unified payments config, so the order truthfully
    // records 'unified' (Batch 128 expected 'lead', when the save
    // wrote the shop key store). The legacy 'lead' source still
    // occurs for pre-129 rows that were never re-saved — Batch 129's
    // own suite covers that fallback.
    assert.equal(cartOrder.stripe_key_source, 'unified');
    assert.equal(cartOrder.items.length, 2, 'both lines recorded');
    const photoLine = cartOrder.items.find((it) => it.source_module === 'gallery');
    assert.equal(photoLine.image_url, 'https://img.example/delta-print.jpg', 'order line carries the photo itself');
    assert.equal(photoLine.product_id, photoD.id);
    assert.equal(JSON.parse(photoLine.source_meta).album_id, albumD.id, 'order line records which album sold');
    const mugLine = cartOrder.items.find((it) => it.source_module === 'ecommerce');
    assert.equal(mugLine.image_url, 'https://img.example/delta-mug.jpg', 'order line snapshots the product photo');
    n += 8;

    // ---- Legacy single-product buy: still one path, gains a line ----
    const single = await sm128.createShopCheckoutByToken(
      db,
      token128(LEAD_D, 'ecommerce'),
      { productId: plainD.id, returnUrl: 'https://fixture.test/shop' },
      {}
    );
    const singleOrder = sm128.listShopOrdersWithItems(db, LEAD_D).find((o) => o.id === single.orderId);
    assert.equal(singleOrder.items.length, 1, 'the legacy buy records exactly one line item');
    assert.equal(singleOrder.amount_cents, 1000);
    assert.equal(singleOrder.product_id, plainD.id, 'the legacy order keeps its product link');
    n += 3;

    // ---- Shop webhook: verify with the shop's secret, pay, replay ----
    const completedBody = JSON.stringify({
      id: 'evt_128_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: cart.sessionId,
          payment_status: 'paid',
          payment_intent: 'pi_128_cart',
          customer_details: { email: 'buyer128@example.invalid' },
          metadata: { bitpype_order_id: String(cart.orderId), bitpype_lead_id: String(LEAD_D) },
        },
      },
    });
    assert.throws(
      () => ss128.constructEventForShop(db, completedBody, 'sig:wrong-secret', JSON.parse(completedBody)),
      /signature/i,
      'a bad signature never verifies'
    );
    n++;
    const verified = ss128.constructEventForShop(db, completedBody, 'sig:' + WHSEC, JSON.parse(completedBody));
    // Batch 129: the lead's keys live in the unified config now, so
    // the verifying layer reports 'unified' (was 'lead' in 128).
    assert.equal(verified.source, 'unified', "verified against the lead's own webhook secret");
    n++;
    const applied = sm128.applyShopStripeEvent(db, verified.event);
    assert.equal(applied.status, 'paid');
    const paidOrder = sm128.listShopOrdersWithItems(db, LEAD_D).find((o) => o.id === cart.orderId);
    assert.equal(paidOrder.status, 'paid', 'webhook marks the order paid');
    assert.equal(paidOrder.customer_email, 'buyer128@example.invalid', 'buyer email lands on the order');
    n += 3;
    const replay = sm128.applyShopStripeEvent(db, verified.event);
    assert.equal(replay.status, 'paid', 'a replayed event is a no-op success');
    assert.equal(
      sm128.listShopOrders(db, LEAD_D).filter((o) => o.id === cart.orderId).length,
      1,
      'replay never double-records the order'
    );
    n += 2;
    const expired = sm128.applyShopStripeEvent(db, {
      id: 'evt_128_2',
      type: 'checkout.session.expired',
      data: { object: { id: single.sessionId } },
    });
    assert.equal(expired.status, 'expired', 'an abandoned checkout lands in a clearly-marked expired state');
    n++;

    // ---- Failure + absence discipline ----
    attach128(LEAD_F, 'checkout');
    const failProd = sm128.createProduct(db, LEAD_F, { name: 'Fragile', price_cents: 800, status: 'published' });
    sm128.saveShopStripeKeys(db, LEAD_F, { publishable_key: PK_TEST, secret_key: SK_FAIL, webhook_secret: WHSEC });
    await assert.rejects(
      () =>
        sm128.createCartCheckoutByToken(
          db,
          token128(LEAD_F, 'checkout'),
          {
            items: [{ source: 'ecommerce', itemId: failProd.id, quantity: 1 }],
            returnUrl: 'https://fixture.test/checkout',
          },
          {}
        ),
      (e) => e.code === 'SHOP_CHECKOUT_FAILED',
      'a failed session create surfaces as SHOP_CHECKOUT_FAILED'
    );
    n++;
    const failOrders = sm128.listShopOrders(db, LEAD_F);
    assert.equal(failOrders.length, 1);
    assert.equal(
      failOrders[0].status,
      'failed',
      'the failed attempt is a marked incomplete state, never a phantom sale'
    );
    n += 2;
    attach128(LEAD_G, 'checkout');
    const gProd = sm128.createProduct(db, LEAD_G, { name: 'Keyless', price_cents: 800, status: 'published' });
    await assert.rejects(
      () =>
        sm128.createCartCheckoutByToken(
          db,
          token128(LEAD_G, 'checkout'),
          {
            items: [{ source: 'ecommerce', itemId: gProd.id, quantity: 1 }],
            returnUrl: 'https://fixture.test/checkout',
          },
          {}
        ),
      (e) => e.code === 'SHOP_STRIPE_NOT_CONFIGURED',
      'an unconfigured shop refuses before any order exists'
    );
    n++;
    assert.equal(sm128.listShopOrders(db, LEAD_G).length, 0, 'no order row is written for an unconfigured shop');
    n++;

    // ---- Live mode is configuration, not a different path ----
    attach128(LEAD_E, 'checkout');
    const eProd = sm128.createProduct(db, LEAD_E, { name: 'Live Widget', price_cents: 1200, status: 'published' });
    sm128.saveShopStripeKeys(db, LEAD_E, { publishable_key: PK_LIVE, secret_key: SK_LIVE, webhook_secret: WHSEC });
    assert.equal(sm128.shopStripeStatus(db, LEAD_E).mode, 'live', 'live keys read as live mode');
    n++;
    const liveCart = await sm128.createCartCheckoutByToken(
      db,
      token128(LEAD_E, 'checkout'),
      { items: [{ source: 'ecommerce', itemId: eProd.id, quantity: 1 }], returnUrl: 'https://fixture.test/checkout' },
      {}
    );
    assert.ok(liveCart.orderId > 0, 'the same cart path runs under a live configuration');
    assert.equal(
      stub128.sessions[stub128.sessions.length - 1].secret,
      SK_LIVE,
      "the live lead's session ran on ITS keys — leads never share a money path"
    );
    n += 2;
    // ---- Batch 127 variant wire (finisher): variants ride the cart ----
    // The build's resolveShopVariant stub refused every variant; the
    // finisher wired it to Batch 127's variant tables. These checks
    // pin the wire end to end: add -> session -> order snapshot.
    {
      let m = 0;
      const fernD = sm128.createProduct(db, LEAD_D, {
        name: 'Variant Fern',
        price_cents: 3000,
        status: 'published',
        options: [{ name: 'Pot', values: ['Nursery Pot', 'EcoPot', 'Terracotta'] }],
        variants: [
          { values: ['EcoPot'], price_cents: 4500, sku: 'FERN-ECO' },
          { values: ['Terracotta'], available: false },
        ],
      });
      assert.equal(fernD.has_variants, true, 'fixture product carries variants');
      const ecoV = fernD.variants.find((v) => v.label === 'EcoPot');
      const terraV = fernD.variants.find((v) => v.label === 'Terracotta');
      assert.equal(ecoV.price_cents, 4500);
      assert.equal(terraV.available, false);
      m += 3;

      // Mixed cart: variant product line + priced photo line.
      const vcart = await sm128.createCartCheckoutByToken(
        db,
        token128(LEAD_D, 'checkout'),
        {
          items: [
            { source: 'ecommerce', itemId: fernD.id, variantId: ecoV.id, quantity: 1 },
            { source: 'gallery', itemId: photoD.id, quantity: 1 },
          ],
          returnUrl: 'https://fixture.test/checkout',
        },
        {}
      );
      const vSession = stub128.sessions[stub128.sessions.length - 1];
      assert.equal(
        vSession.params.line_items[0].price_data.product_data.name,
        'Variant Fern — EcoPot',
        'the Stripe line is named Product — Variant Label'
      );
      assert.equal(
        vSession.params.line_items[0].price_data.unit_amount,
        4500,
        'the Stripe line charges the VARIANT price, not the base price'
      );
      assert.equal(
        vSession.params.metadata.bitpype_product_id,
        undefined,
        'a multi-line cart carries no single-product metadata'
      );
      m += 3;
      const vOrder = sm128.listShopOrdersWithItems(db, LEAD_D).find((o) => o.id === vcart.orderId);
      const vLine = vOrder.items.find((it) => it.source_module === 'ecommerce');
      assert.equal(vLine.variant_id, ecoV.id, 'order line snapshots the variant id');
      assert.equal(vLine.variant_label, 'EcoPot', 'order line snapshots the variant label');
      assert.equal(vLine.unit_price_cents, 4500, 'order line snapshots the variant price');
      assert.equal(vOrder.amount_cents, 8500, 'order total prices the variant line at variant price');
      m += 4;

      // Single-line variant cart: order row + session metadata carry
      // the variant identity (Batch 127's order-level snapshot).
      const vSingle = await sm128.createCartCheckoutByToken(
        db,
        token128(LEAD_D, 'checkout'),
        {
          items: [{ source: 'ecommerce', itemId: fernD.id, variantId: ecoV.id, quantity: 2 }],
          returnUrl: 'https://fixture.test/checkout',
        },
        {}
      );
      const vsSession = stub128.sessions[stub128.sessions.length - 1];
      assert.equal(vsSession.params.metadata.bitpype_product_id, String(fernD.id));
      assert.equal(vsSession.params.metadata.bitpype_variant_id, String(ecoV.id), 'session metadata names the variant');
      const vsRow = db
        .prepare('SELECT variant_id, variant_label FROM ecommerce_orders WHERE id = ?')
        .get(vSingle.orderId);
      assert.equal(vsRow.variant_id, ecoV.id, 'one-line order row snapshots variant_id');
      assert.equal(vsRow.variant_label, 'EcoPot', 'one-line order row snapshots variant_label');
      m += 4;

      // The legacy single-product path takes the same variant wire.
      const vLegacy = await sm128.createShopCheckoutByToken(
        db,
        token128(LEAD_D, 'ecommerce'),
        { productId: fernD.id, variantId: ecoV.id, returnUrl: 'https://fixture.test/shop' },
        {}
      );
      const vlSession = stub128.sessions[stub128.sessions.length - 1];
      assert.equal(vlSession.params.line_items[0].price_data.product_data.name, 'Variant Fern — EcoPot');
      assert.equal(vlSession.params.line_items[0].price_data.unit_amount, 4500);
      assert.equal(vlSession.params.metadata.bitpype_variant_id, String(ecoV.id));
      const vlRow = db
        .prepare('SELECT variant_id, variant_label FROM ecommerce_orders WHERE id = ?')
        .get(vLegacy.orderId);
      assert.equal(vlRow.variant_id, ecoV.id);
      m += 4;

      // Refusals: the variant rules are identical on both paths.
      await assert.rejects(
        () =>
          sm128.createCartCheckoutByToken(
            db,
            token128(LEAD_D, 'checkout'),
            {
              items: [{ source: 'ecommerce', itemId: fernD.id, quantity: 1 }],
              returnUrl: 'https://fixture.test/checkout',
            },
            {}
          ),
        /Choose the product options before checkout/,
        'a variant product with no chosen variant is refused, never base-priced'
      );
      m++;
      await assert.rejects(
        () =>
          sm128.createCartCheckoutByToken(
            db,
            token128(LEAD_D, 'checkout'),
            {
              items: [{ source: 'ecommerce', itemId: fernD.id, variantId: terraV.id, quantity: 1 }],
              returnUrl: 'https://fixture.test/checkout',
            },
            {}
          ),
        /currently unavailable/,
        'an unavailable variant is refused'
      );
      m++;
      await assert.rejects(
        () =>
          sm128.createCartCheckoutByToken(
            db,
            token128(LEAD_D, 'checkout'),
            {
              items: [{ source: 'ecommerce', itemId: plainD.id, variantId: ecoV.id, quantity: 1 }],
              returnUrl: 'https://fixture.test/checkout',
            },
            {}
          ),
        /has no options to choose/,
        'a variantId on a variant-less product is refused'
      );
      m++;
      const fern2D = sm128.createProduct(db, LEAD_D, {
        name: 'Other Fern',
        price_cents: 2000,
        status: 'published',
        options: [{ name: 'Pot', values: ['Clay'] }],
      });
      await assert.rejects(
        () =>
          sm128.createCartCheckoutByToken(
            db,
            token128(LEAD_D, 'checkout'),
            {
              items: [{ source: 'ecommerce', itemId: fernD.id, variantId: fern2D.variants[0].id, quantity: 1 }],
              returnUrl: 'https://fixture.test/checkout',
            },
            {}
          ),
        /no longer available/,
        "another product's variant never resolves"
      );
      m++;
      await assert.rejects(
        () =>
          sm128.createShopCheckoutByToken(
            db,
            token128(LEAD_D, 'ecommerce'),
            { productId: fernD.id, returnUrl: 'https://fixture.test/shop' },
            {}
          ),
        /Choose the product options before checkout/,
        'the single-product path refuses an unchosen variant too'
      );
      m++;
      group('Part 3b variant wire (Batch 127)', m);
    }

    group('Part 3 stubbed-Stripe money flows', n);
  }

  /* ================================================================== */
  /* Part 4 — HTTP over the real server                                  */
  /* ================================================================== */
  {
    let n = 0;
    const q = platformDb.query;
    const bcrypt = require('bcryptjs');
    await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)', {
      e: 'owner128@example.invalid',
      h: bcrypt.hashSync(['Unused', 'Pass', '128'].join('') + '!', 12),
      n: 'B128 Portal Link',
      s: 'active',
    });
    await q(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
      { e: 'owner128@example.invalid', h: bcrypt.hashSync(PW, 12), w: WS_ID, l: LEAD_A, b: 'B128 Alpha Studio' }
    );
    // A paid order on lead A, written directly, for the order-status
    // reads (the money flow itself is proven in Part 3).
    const httpOrderInfo = db
      .prepare(
        `INSERT INTO ecommerce_orders (lead_id, product_id, product_name, amount_cents, currency, status, stripe_session_id, customer_email)
         VALUES (?, ?, ?, ?, 'USD', 'paid', 'cs_http_128', 'httpbuyer@example.invalid')`
      )
      .run(LEAD_A, mug.id, 'Enamel Mug', 2500);
    const httpOrderId = Number(httpOrderInfo.lastInsertRowid);
    db.prepare(
      `INSERT INTO ecommerce_order_items (order_id, lead_id, product_id, product_name, source_module, image_url, unit_price_cents, quantity, line_total_cents, currency)
       VALUES (?, ?, ?, 'Enamel Mug', 'ecommerce', 'https://img.example/mug.jpg', 2500, 1, 2500, 'USD')`
    ).run(httpOrderId, LEAD_A, mug.id);

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
        const res = await post(owner, '/api/v1/portal/login', { email: 'owner128@example.invalid', password: PW });
        assert.equal(res.status, 200, 'portal owner login');
        n++;
      }
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/checkout`);
        assert.equal(res.status, 200, 'checkout pane loads');
        const payload = (await json(res)).data;
        assert.ok(payload.checkout, 'checkout block rides the pane payload');
        assert.equal(payload.checkout.payments.connected, true, 'pane shows the connected shop Stripe');
        assert.equal(payload.checkout.effective_mode, 'test', 'pane shows test mode honestly');
        assert.ok(Array.isArray(payload.checkout.orders), 'pane carries the orders read');
        assert.ok(
          payload.checkout.orders.some((o) => o.id === httpOrderId && o.items && o.items.length === 1),
          'pane orders carry their line items'
        );
        n += 6;
      }
      {
        const res = await put(owner, '/api/v1/portal/modules/checkout/config', {
          success_message: 'HTTP thanks!',
        });
        assert.equal(res.status, 200, 'checkout config PUT');
        const savedCfg = (await json(res)).data.config;
        assert.equal(savedCfg.success_message, 'HTTP thanks!', 'config round-trips over HTTP');
        n += 2;
        const list = await owner.fetch(`${BASE}/api/v1/portal/modules/ecommerce`);
        const shopPayloadHttp = (await json(list)).data;
        assert.ok(Array.isArray(shopPayloadHttp.shop.orders), 'shop pane carries orders too');
        assert.equal(shopPayloadHttp.shop.effective_mode, 'test', 'shop pane shows the mode');
        n += 2;
      }
      const shopTokenA = tokenOf(LEAD_A, 'ecommerce');
      const checkoutTokenA = tokenOf(LEAD_A, 'checkout');
      const foreignToken = tokenOf(LEAD_B, 'checkout'); // detached in Part 2; still resolves lead B
      {
        const res = await fetch(`${BASE}/api/v1/modules/public/${shopTokenA}`);
        const payload = (await json(res)).data;
        assert.equal(payload.checkout_page, '/checkout', 'public shop payload names the checkout page over HTTP');
        n++;
      }
      {
        const res = await fetch(`${BASE}/api/v1/modules/public/${foreignToken}/checkout-cart`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ source: 'ecommerce', itemId: 1, quantity: 1 }] }),
        });
        assert.equal(res.status, 404, 'cart checkout under a detached checkout token 404s');
        n++;
        const empty = await fetch(`${BASE}/api/v1/modules/public/${checkoutTokenA}/checkout-cart`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [] }),
        });
        assert.equal(empty.status, 400, 'an empty cart is refused before Stripe is touched');
        n++;
      }
      {
        const res = await fetch(`${BASE}/api/v1/modules/public/${shopTokenA}/order-status?session_id=cs_http_128`);
        assert.equal(res.status, 200, 'order-status reads under the owning lead’s token');
        const data = (await json(res)).data;
        assert.equal(data.status, 'paid');
        assert.equal(data.items.length, 1, 'order-status returns the recorded lines');
        assert.equal(data.items[0].imageUrl, 'https://img.example/mug.jpg', 'the line photo rides the read');
        assert.equal(data.items[0].source, 'ecommerce');
        n += 5;
        const foreign = await fetch(
          `${BASE}/api/v1/modules/public/${foreignToken}/order-status?session_id=cs_http_128`
        );
        assert.equal(foreign.status, 404, "another lead's token cannot read the order — strict isolation");
        n++;
        const noSession = await fetch(`${BASE}/api/v1/modules/public/${shopTokenA}/order-status`);
        assert.equal(noSession.status, 400, 'order-status requires the session credential');
        n++;
      }
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
    group('Part 4 HTTP', n);
  }

  console.log(`\nBatch 128 checkout suite: ${groups.length} groups passed`);
  for (const g of groups) console.log(`  - ${g}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
