'use strict';
/**
 * Batch 142 — CHECKOUT ELEMENT IN THE NAV (Ely, 2026-11-04:
 * "Checkout element should be at the top, better if it's in the
 * nav."). BUILD ONLY — parked; the finisher rebases onto the
 * post-131 tip and re-rotates the relative pins.
 *
 * What this batch does:
 *   Batch 128's cart UI was an in-body bar (.bp-mod-cartbar) that
 *   appeared inside the shop/gallery embed (and a second copy on
 *   Batch 133 detail pages) once the cart had items. Batch 142
 *   removes that bar everywhere and puts ONE cart element in the
 *   site chrome: a nav-level link [data-bp-nav-cart] showing the
 *   live item count + total, pointing at the site's checkout page
 *   (the old bar's "Go to checkout" target). The cart logic itself
 *   (addLineToCart, the 'bp-cart-<checkout token>' storage key,
 *   merge rules and caps) is untouched — only where its summary
 *   renders changed.
 *
 * EMPTY-STATE DECISION (pinned below): the nav element is VISIBLE
 *   as soon as the checkout signal arrives, showing the honest
 *   empty state "Cart · 0 items — $0.00". A nav element that pops
 *   in only after the first add would shift the header mid-shop
 *   and could not be discovered before buying; a permanent nav
 *   slot is what "element in the nav" means.
 *
 * What this pins:
 *   Part 1 — source pins: the nav-cart wiring exists in
 *     module-embed.js (finder + register + update, dedupe by
 *     attribute, collapsible-panel exclusion), the in-body bar is
 *     GONE (no .bp-mod-cartbar markup, styles or renderCartBar),
 *     every former bar call site now refreshes the nav element,
 *     the Checkout page registers from its own embed token + slug,
 *     MODULE_SCRIPT_VER mod36, and the SEC-13 census at 439
 *     (STATIC 156 — two cart-bar innerHTML sinks removed, one
 *     nav-cart sink added; RAW/IDENT reviewed set unchanged).
 *   Part 2 — payload gating (in-process, real siteModules): the
 *     ecommerce payload carries checkout_token + checkout_page
 *     ONLY while a Checkout module is attached and active for the
 *     lead (the same resolveCheckoutLink signal as Batch 128); a
 *     shop without checkout attached carries neither field; the
 *     item payload (the detail path) carries the same signal;
 *     detaching checkout withdraws it.
 *   Part 3 — real Chromium against a fixture server serving the
 *     REAL module-embed.js + the REAL mobile-nav.css, with fixture
 *     payloads shaped like the server's: exactly one nav cart on
 *     nav-section chrome AND on partials (mobile-nav) chrome;
 *     none on a site whose payload has no checkout signal; the
 *     empty state is visible before any add; Add to cart updates
 *     count/total live without a reload and without creating a
 *     second element (two selling embeds on one page included);
 *     the link target is the site's checkout page; the Checkout
 *     page itself registers (qty +/- and remove update the nav);
 *     geometry at 390/980/1440 — visible, inside the viewport, no
 *     horizontal overflow, no overlap with brand or hamburger, and
 *     NEVER inside the collapsed mobile menu (.bp-nav-panel /
 *     .nav-links), whose platform CSS hides it at ≤700px; a
 *     Batch 133 detail shell WITHOUT chrome degrades silently
 *     (no element, no error, no bar, the add still lands in the
 *     cart), and the same detail page WITH partials chrome gets
 *     its cart in that header.
 *   Part 4 — SITEWIDE EXTENSION (second commit on batch142): the
 *     142 cart registered only from the selling signal, so it was
 *     missing from a checkout site's plain pages (home, About).
 *     The server now stamps `site_checkout: { page, token }` —
 *     exactly those two fields, both already public on the selling
 *     payloads — on EVERY public embed payload for a lead whose
 *     Checkout module is attached+active (one resolver,
 *     siteCheckoutPresence, also feeding the selling signal), and
 *     module-embed.js registers the nav cart from the stamp too
 *     (registerNavCartFromPayload; selling signal wins when both
 *     ride one payload). Pins: a plain (faq) payload carries the
 *     stamp and NOT the selling fields; the stamp's values equal
 *     the selling signal's on a shop payload; a lead without
 *     checkout stamps nothing anywhere; deactivating OR detaching
 *     checkout withdraws the stamp; Chromium: a plain content page
 *     (two stamped non-selling embeds) shows exactly one nav cart
 *     with live totals read from the SAME cart storage a shop page
 *     wrote, at 1440 and 390; a plain page on a no-checkout site
 *     shows none; a mixed selling+plain page still shows one.
 *     Accepted edge (stated, not chased): a page with NO module
 *     embeds at all never loads module-embed.js, so it still shows
 *     no cart — same as every other module-driven chrome feature.
 *     MODULE_SCRIPT_VER rotated mod35 → mod36 for the embed change;
 *     the SEC-13 census is UNCHANGED (439; the extension adds no
 *     innerHTML sink and its client code is placed so no reviewed
 *     sink line moves).
 *
 * NEGATIVE hooks (source pins only):
 *   B142_NEGATIVE=keep-bar     module-embed keeps the in-body bar
 *   B142_NEGATIVE=no-navcart   module-embed loses the nav cart
 */
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch142-'));
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'app.db');
process.env.SQLITE_PATH = process.env.DB_PATH;
['.env', 'app.db', 'data.db', 'leads.db', 'platform.db'].forEach((name) => {
  process.env[name.toUpperCase().replace(/\W/g, '_') + '_PATH'] = path.join(process.env.REGRESSION_TMPDIR, name);
});
process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqlite';
process.env['SESSION_' + 'SECRET'] = ['batch142', 'test', 'session', 'secret'].join('-');
process.env.APP_SECRET = ['batch142', 'test', 'app', 'secret'].join('-');
// Sibling-suite header (125/126/132/137): the gate image boots
// NODE_ENV=production; this pair lets any spawned/booted server run.
process.env.CAPTCHA_OPTIONAL = '1';
process.env.APP_URL = 'https://bitpype.test';
process.env.NODE_ENV = 'production';
process.env.COOKIE_SECURE = 'false';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';

const root = path.resolve(__dirname, '..');
const LEAD_A = 14201;
const LEAD_B = 14202;
const LEAD_C = 14203;
const PW = ['B142', 'Portal', 'Pass', '9'].join('-') + '!';
const NEGATIVE = process.env.B142_NEGATIVE || '';

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

/* ================================================================== */
/* Part 1 — source pins                                                */
/* ================================================================== */
function part1() {
  let n = 0;
  const embed = read('public/js/module-embed.js');

  if (NEGATIVE !== 'no-navcart') {
    assert.ok(embed.includes("var NAV_CART_ATTR = 'data-bp-nav-cart';"), 'nav cart attribute pinned');
    n++;
    assert.ok(embed.includes('function registerNavCart(checkoutToken, checkoutPage)'), 'registerNavCart exists');
    n++;
    assert.ok(embed.includes('function updateNavCart()'), 'updateNavCart exists');
    n++;
    assert.ok(embed.includes('function findNavCartTarget()'), 'findNavCartTarget exists');
    n++;
  }
  // Gating: registration requires BOTH signal fields, never one.
  assert.ok(
    embed.includes('if (!checkoutToken || !checkoutPage) return;'),
    'registerNavCart refuses a partial signal (no token or no page → no element)'
  );
  n++;
  // Chrome detection covers both mechanisms + the detail-shell null.
  for (const needle of [
    '[data-ws-section-type="nav"]',
    '.ws-nav-chrome',
    '[data-bitpype-mobile-nav]',
    '.nav-inner',
    '.bp-nav-bar',
    'no recognizable nav — degrade silently',
  ]) {
    assert.ok(embed.includes(needle), `chrome detection covers ${needle}`);
    n++;
  }
  // Mobile rule: the cart is never placed inside a collapsible panel.
  assert.ok(embed.includes('function isCollapsibleNavPanel(el)'), 'collapsible-panel guard exists');
  n++;
  assert.ok(embed.includes("el.classList.contains('bp-nav-panel')"), 'bp-nav-panel excluded as a host');
  n++;
  assert.ok(
    embed.includes("el.classList.contains('nav-links')"),
    'nav-links excluded as a host (platform CSS hides its anchors at ≤760px)'
  );
  n++;
  // Exactly one element: dedupe by attribute inside updateNavCart.
  assert.ok(
    embed.includes("document.querySelectorAll('[' + NAV_CART_ATTR + ']')"),
    'updateNavCart sweeps for existing nav cart elements'
  );
  n++;
  assert.ok(embed.includes('all[i].parentNode.removeChild(all[i])'), 'duplicate nav cart elements are removed');
  n++;
  // Empty state: visible from registration, honest zero summary.
  assert.ok(embed.includes('\'<span class="bp-nav-cart-label">Cart</span>\''), 'nav cart renders its Cart label');
  n++;
  assert.ok(embed.includes('data-bp-nav-cart-summary'), 'nav cart renders a live summary span');
  n++;
  assert.ok(embed.includes('.bp-nav-cart{'), 'nav cart carries its own (unscoped) chrome styles');
  n++;
  assert.ok(
    embed.includes('padding:0.55rem 1rem'),
    'nav cart text inset is 16px horizontal (Batch 135 spacing floor for its own text)'
  );
  n++;

  if (NEGATIVE !== 'keep-bar') {
    // The in-body bar is gone: no styles, no renderer, no call sites.
    assert.ok(!embed.includes("'.bitpype-module-embed .bp-mod-cartbar{'"), 'cartbar styles removed');
    n++;
    assert.ok(!embed.includes('function renderCartBar'), 'renderCartBar removed');
    n++;
    assert.ok(!embed.includes("bar.className = 'bp-mod-cartbar'"), 'no element is ever built with the cartbar class');
    n++;
    assert.ok(!embed.includes('in your cart</span>'), 'the detail page no longer builds its own in-body bar copy');
    n++;
  }
  // Former bar call sites now refresh the nav element.
  assert.ok(
    embed.includes('addLineToCart(data.checkout_token, line);\n        updateNavCart();'),
    'shop/gallery add refreshes the nav cart'
  );
  n++;
  assert.ok(
    embed.includes('detailAddToCart(data.checkout_token, line);'),
    'detail add still feeds the one shared cart'
  );
  n++;
  assert.ok(
    embed.includes('registerNavCart(data.checkout_token, data.checkout_page);\n      updateNavCart();'),
    'detail add registers + refreshes the nav cart'
  );
  n++;
  // Payload-driven registration in the mount path.
  assert.ok(
    embed.includes('registerNavCartFromPayload(data);'),
    'mountOne handlePayload registers from any payload (selling signal or the sitewide stamp — extension)'
  );
  n++;
  // The Checkout module's own page registers from its embed token.
  assert.ok(
    embed.includes("registerNavCart(token, '/' + coSlug);"),
    'renderCheckout registers from its own token + target slug'
  );
  n++;
  assert.ok(
    embed.includes('wireReview();\n      // Batch 142:'),
    'checkout review redraw refreshes the nav cart (qty/remove)'
  );
  n++;
  // The cart engine itself is untouched: same key, same merge, same caps.
  assert.ok(embed.includes("return 'bp-cart-' + String(checkoutToken || '');"), 'cart storage key unchanged');
  n++;
  assert.ok(embed.includes('function addLineToCart(checkoutToken, line)'), 'addLineToCart unchanged');
  n++;

  // Version + census rotations.
  const sm = require(path.join(root, 'server/siteModules.js'));
  assert.equal(
    sm.MODULE_SCRIPT_VER,
    'mod39',
    'MODULE_SCRIPT_VER rotated mod35 → mod36 for the sitewide extension (142 itself took mod34 → mod35)'
  );
  n++;
  const { census } = require(path.join(root, 'scripts/xss-census.cjs'));
  const cz = census();
  assert.deepEqual(
    cz.summary,
    { total: 450, STATIC: 162, ESCAPED: 41, SAFE: 73, BUILDER: 60, IDENT: 36, RAW: 78 },
    'SEC-13 census: 441 total (Batch 142 landed at 439 — two cart-bar STATIC sinks removed, one nav-cart STATIC sink added; Batch 136 finisher added +2 audited STATIC sinks in module-embed.js (the price-summary clear + the fully esc()-wrapped price-summary build), reviewed RAW/IDENT set unchanged, positions shifted by pure line movement; Batch 137 finisher: +1 audited SAFE sink in portal.js (qualifying-question rows render — numeric indices + esc()-wrapped question text), census 441 -> 442, SAFE 73 -> 74, reviewed RAW/IDENT content unchanged (12 portal.js positions shifted +127, pure line movement, snippet-verified))'
  );
  n++;

  /* ── Extension pins: the sitewide stamp ── */
  const smSrc = read('server/siteModules.js');
  assert.ok(
    smSrc.includes('function siteCheckoutPresence(db, leadId)'),
    'extension: ONE server resolver for the sitewide presence'
  );
  n++;
  assert.ok(
    smSrc.includes('checkoutPage = siteCheckout.page;'),
    'extension: the selling signal derives from the same presence (no second source of truth)'
  );
  n++;
  assert.ok(
    smSrc.includes('if (siteCheckout) out.site_checkout = siteCheckout;'),
    'extension: the main payload stamps site_checkout'
  );
  n++;
  assert.ok(
    smSrc.includes('membersPayload.site_checkout = siteCheckout;'),
    'extension: the members payload stamps site_checkout'
  );
  n++;
  assert.ok(
    smSrc.includes('lockedPayload.site_checkout = siteCheckout;'),
    'extension: the locked (member-gated) payload stamps site_checkout'
  );
  n++;
  assert.ok(
    embed.includes('function registerNavCartFromPayload(data)'),
    'extension: registerNavCartFromPayload exists'
  );
  n++;
  assert.ok(embed.includes('var sc = data.site_checkout;'), 'extension: the client reads the site_checkout stamp');
  n++;
  assert.ok(embed.includes('registerNavCartFromPayload(data);'), 'extension: mount paths register from any payload');
  n++;
  assert.ok(
    embed.includes('registerNavCartFromPayload(data); renderLocked(el, data);'),
    'extension: a locked payload registers the cart before the wall renders'
  );
  n++;
  assert.ok(
    embed.includes('registerNavCartFromPayload(data); renderLocked(root, data);'),
    'extension: a locked DETAIL payload registers the cart before the wall renders'
  );
  n++;
  group('Part 1 source pins', n);
}

/* ================================================================== */
/* Part 2 — payload gating (in-process, real siteModules)              */
/* ================================================================== */
async function part2() {
  let n = 0;
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a142@example.invalid',
    password: PW,
    name: 'A142',
    workspaceName: 'Batch142 WS',
  });
  const WS_ID = Number(a.workspaceId);
  const db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B142 Victoria Plants', 'victoria142@example.invalid'],
    [LEAD_B, 'B142 Plain Shop', 'plain142@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
  }

  // Lead A: shop + checkout attached. Lead B: shop only.
  // (attachModule returns { embed: publicEmbed(...), sync, ... }.)
  const shopA = sm.attachModule(db, LEAD_A, 'ecommerce', { workspaceId: WS_ID }).embed;
  const coA = sm.attachModule(db, LEAD_A, 'checkout', { workspaceId: WS_ID }).embed;
  const shopB = sm.attachModule(db, LEAD_B, 'ecommerce', { workspaceId: WS_ID }).embed;
  const prodA = sm.createProduct(db, LEAD_A, { name: 'Monstera Deliciosa', price_cents: 6800, status: 'published' });
  sm.createProduct(db, LEAD_B, { name: 'Plain Widget', price_cents: 1200, status: 'published' });

  const payloadA = sm.getPublicModuleByToken(db, shopA.public_token, {});
  assert.equal(payloadA.checkout_page, '/checkout', 'shop payload names the checkout page while checkout is attached');
  n++;
  assert.equal(
    payloadA.checkout_token,
    coA.public_token,
    'shop payload names the checkout embed token (the cart storage key)'
  );
  n++;

  const payloadB = sm.getPublicModuleByToken(db, shopB.public_token, {});
  assert.ok(
    !('checkout_page' in payloadB),
    'a shop WITHOUT checkout attached carries no checkout_page — no nav slot, no dead link'
  );
  n++;
  assert.ok(!('checkout_token' in payloadB), 'a shop WITHOUT checkout attached carries no checkout_token');
  n++;

  // The item payload (the Batch 133 detail path) carries the signal too.
  const itemA = sm.getPublicModuleItem(db, shopA.public_token, String(prodA.slug || prodA.id), {});
  assert.equal(itemA.checkout_token, coA.public_token, 'item payload carries the checkout token for the detail page');
  n++;
  assert.equal(itemA.checkout_page, '/checkout', 'item payload carries the checkout page for the detail page');
  n++;

  /* ── Extension: the sitewide stamp ── */
  // Lead C: a PLAIN module (blog) + checkout — no selling module at
  // all. Its plain payload must carry the stamp so its pages can
  // register the nav cart.
  db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
    LEAD_C,
    'B142 Plain Pages',
    'plainpages142@example.invalid',
    'customer'
  );
  const blogC = sm.attachModule(db, LEAD_C, 'blog', { workspaceId: WS_ID }).embed;
  const coC = sm.attachModule(db, LEAD_C, 'checkout', { workspaceId: WS_ID }).embed;

  const blogPayloadC = sm.getPublicModuleByToken(db, blogC.public_token, {});
  assert.deepEqual(
    blogPayloadC.site_checkout,
    { page: '/checkout', token: coC.public_token },
    'extension: a plain (blog) payload carries site_checkout { page, token } while checkout is attached+active'
  );
  n++;
  assert.deepEqual(
    Object.keys(blogPayloadC.site_checkout).sort(),
    ['page', 'token'],
    'extension: the stamp carries EXACTLY two fields — the public page path + the already-public checkout embed token; no keys, secrets or config'
  );
  n++;
  assert.ok(
    !('checkout_token' in blogPayloadC) && !('checkout_page' in blogPayloadC),
    'extension: the plain payload does NOT gain the selling signal fields — only the stamp'
  );
  n++;

  // Same values as the selling signal where both ride one payload.
  assert.deepEqual(
    payloadA.site_checkout,
    { page: payloadA.checkout_page, token: payloadA.checkout_token },
    'extension: on a shop payload the stamp equals the selling signal (one resolver, one truth)'
  );
  n++;
  // The item payload (detail path) carries the stamp too.
  assert.deepEqual(
    itemA.site_checkout,
    { page: '/checkout', token: coA.public_token },
    'extension: the item payload carries the stamp (detail pages unchanged in behavior — same token/page as their selling signal)'
  );
  n++;
  // The Checkout module's own payload carries it as well.
  const coPayloadA = sm.getPublicModuleByToken(db, coA.public_token, {});
  assert.deepEqual(
    coPayloadA.site_checkout,
    { page: '/checkout', token: coA.public_token },
    'extension: the checkout payload itself carries the stamp'
  );
  n++;
  // No checkout attached → nothing stamped, on any payload.
  assert.ok(!('site_checkout' in payloadB), 'extension: a lead WITHOUT checkout stamps nothing on its shop payload');
  n++;

  // Deactivation withdraws the stamp everywhere (mirrors how the
  // selling signal already dies with moduleEmbedActive).
  db.prepare("UPDATE site_module_embeds SET published = 0 WHERE lead_id = ? AND module_type = 'checkout'").run(LEAD_C);
  assert.ok(
    !('site_checkout' in sm.getPublicModuleByToken(db, blogC.public_token, {})),
    'extension: unpublished checkout → the stamp is gone from the plain payload'
  );
  n++;
  db.prepare(
    "UPDATE site_module_embeds SET published = 1, embed_enabled = 0 WHERE lead_id = ? AND module_type = 'checkout'"
  ).run(LEAD_C);
  assert.ok(
    !('site_checkout' in sm.getPublicModuleByToken(db, blogC.public_token, {})),
    'extension: disabled checkout → the stamp is gone from the plain payload'
  );
  n++;
  db.prepare("UPDATE site_module_embeds SET embed_enabled = 1 WHERE lead_id = ? AND module_type = 'checkout'").run(
    LEAD_C
  );
  assert.ok(
    'site_checkout' in sm.getPublicModuleByToken(db, blogC.public_token, {}),
    'extension: re-activated checkout → the stamp returns'
  );
  n++;

  // Detaching checkout withdraws the signal — the nav element's
  // reason to exist goes with it.
  sm.detachModule(db, LEAD_A, 'checkout');
  const payloadA2 = sm.getPublicModuleByToken(db, shopA.public_token, {});
  assert.ok(
    !('checkout_page' in payloadA2) && !('checkout_token' in payloadA2),
    'detached checkout → the signal is gone from the shop payload'
  );
  n++;
  assert.ok(
    !('site_checkout' in payloadA2),
    'extension: detached checkout → the stamp is gone from the shop payload too'
  );
  n++;
  // …and from the PLAIN payload (the extension's whole point):
  sm.detachModule(db, LEAD_C, 'checkout');
  assert.ok(
    !('site_checkout' in sm.getPublicModuleByToken(db, blogC.public_token, {})),
    'extension: detached checkout → the stamp is gone from the plain payload'
  );
  n++;
  group('Part 2 payload gating', n);
}

/* ================================================================== */
/* Part 3 — real Chromium, fixture server, REAL module-embed.js        */
/* ================================================================== */
const FIXTURE_PRODUCT = {
  id: 7,
  slug: 'widget',
  name: 'Monstera Deliciosa',
  description: 'A very nice plant.',
  price_cents: 6800,
  price_label: '$68.00',
  currency: 'USD',
  image_url: '',
  stripe_checkout: true,
};
function fixturePayload(token, slug) {
  if (token === 'shop1') {
    if (slug) {
      return {
        ok: true,
        data: {
          module_type: 'ecommerce',
          title: 'Shop',
          settings: {},
          items: [],
          item: FIXTURE_PRODUCT,
          checkout_token: 'co1',
          checkout_page: '/checkout',
          embed: { lead_id: 1 },
        },
      };
    }
    return {
      ok: true,
      data: {
        module_type: 'ecommerce',
        title: 'Shop',
        settings: {},
        items: [FIXTURE_PRODUCT],
        checkout_token: 'co1',
        checkout_page: '/checkout',
        embed: { lead_id: 1 },
      },
    };
  }
  if (token === 'gal1') {
    return {
      ok: true,
      data: {
        module_type: 'gallery',
        title: 'Gallery',
        settings: {},
        items: [{ id: 3, slug: 'album', title: 'Album', images: [{ id: 11, image_url: '', caption: 'Leaf' }] }],
        checkout_token: 'co1',
        checkout_page: '/checkout',
        embed: { lead_id: 1 },
      },
    };
  }
  if (token === 'shop0') {
    return {
      ok: true,
      data: {
        module_type: 'ecommerce',
        title: 'Shop',
        settings: {},
        items: [
          { ...FIXTURE_PRODUCT, id: 9, slug: 'plain', name: 'Plain Widget', price_cents: 1200, price_label: '$12.00' },
        ],
        embed: { lead_id: 2 },
      },
    };
  }
  if (token === 'faq1') {
    // Extension fixture: a PLAIN payload — no selling fields, only
    // the sitewide stamp (shape pinned in Part 2).
    return {
      ok: true,
      data: {
        module_type: 'faq',
        title: 'FAQ',
        settings: {},
        items: [{ id: 1, question: 'Do you deliver?', answer_html: '<p>Yes, locally.</p>' }],
        site_checkout: { page: '/checkout', token: 'co1' },
        embed: { lead_id: 1 },
      },
    };
  }
  if (token === 'testi1') {
    return {
      ok: true,
      data: {
        module_type: 'testimonials',
        title: 'Kind words',
        settings: {},
        items: [],
        site_checkout: { page: '/checkout', token: 'co1' },
        embed: { lead_id: 1 },
      },
    };
  }
  if (token === 'faq0') {
    // Plain payload for a lead with NO checkout attached: no stamp.
    return {
      ok: true,
      data: {
        module_type: 'faq',
        title: 'FAQ',
        settings: {},
        items: [{ id: 2, question: 'Hours?', answer_html: '<p>Nine to five.</p>' }],
        embed: { lead_id: 2 },
      },
    };
  }
  if (token === 'co1') {
    return {
      ok: true,
      data: {
        module_type: 'checkout',
        title: 'Checkout',
        settings: {},
        items: [],
        checkout: {
          config: { success_message: '' },
          cart: { configured: true, mode: 'test' },
          shop_page: '/shop-structured',
          gallery_page: null,
        },
        embed: { lead_id: 1, target_page_slug: 'checkout' },
      },
    };
  }
  return { ok: false, error: 'not found', code: 'NOT_FOUND' };
}

function embedDiv(type, token, origin) {
  return (
    `<div class="bitpype-module-embed" data-bitpype-module="1" data-bitpype-module-type="${type}" ` +
    `data-bitpype-module-token="${token}" data-bitpype-api="${origin}"></div>`
  );
}
const STRUCTURED_CSS =
  'body{margin:0;font-family:sans-serif}' +
  '.nav{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd}' +
  '.nav-inner{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;max-width:1080px;margin:0 auto;box-sizing:border-box}' +
  '.brand{font-weight:800;color:#111;text-decoration:none}' +
  '.nav-links{display:flex;gap:18px;align-items:center}' +
  '.nav-links a{text-decoration:none;color:#111}' +
  '@media(max-width:760px){.nav-links a:not(.nav-cta){display:none}}' +
  'main{padding:20px}';
function structuredChrome(inner) {
  return (
    '<nav class="nav" data-ws-section-type="nav"><div class="nav-inner">' +
    '<a class="brand" href="/index">Victoria\u2019s Plants</a>' +
    '<div class="nav-links"><a href="/index">Home</a><a href="/shop-structured">Shop</a>' +
    '<a class="nav-cta" href="tel:+15551234567">Call</a></div></div></nav>' +
    inner
  );
}
function pageStructured(origin, extraEmbeds) {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style>${STRUCTURED_CSS}</style></head><body>` +
    structuredChrome(`<main>${embedDiv('ecommerce', 'shop1', origin)}${extraEmbeds || ''}</main>`) +
    '<script src="/js/module-embed.js"></script></body></html>'
  );
}
function pagePartials(origin) {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<link rel="stylesheet" href="/css/mobile-nav.css">' +
    '<style>body{margin:0;font-family:sans-serif}.site-head{background:#fff;border-bottom:1px solid #ddd;padding:10px 16px}' +
    '.brand{font-weight:800;color:#111;text-decoration:none}' +
    '.cta-row{display:block;margin-top:10px;background:#0e7a68;color:#fff;text-align:center;padding:12px;border-radius:8px;text-decoration:none}' +
    'main{padding:20px}</style></head><body>' +
    '<header class="site-head" data-bitpype-mobile-nav="1">' +
    '<div class="bp-nav-bar"><a class="brand" href="/index">Victoria\u2019s Plants</a>' +
    '<input class="bp-nav-toggle" type="checkbox" id="nt142">' +
    '<label class="bp-nav-burger" for="nt142"><span></span><span></span><span></span></label>' +
    '<nav class="bp-nav-panel"><a href="/index">Home</a><a href="/shop-partials">Shop</a></nav></div>' +
    '<a class="cta-row" href="tel:+15551234567">Call now</a></header>' +
    `<main>${embedDiv('ecommerce', 'shop1', origin)}</main>` +
    '<script src="/js/module-embed.js"></script></body></html>'
  );
}
function pagePlain(origin) {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style>${STRUCTURED_CSS}</style></head><body>` +
    structuredChrome(
      `<main><h1>About us</h1>${embedDiv('faq', 'faq1', origin)}${embedDiv('testimonials', 'testi1', origin)}</main>`
    ) +
    '<script src="/js/module-embed.js"></script></body></html>'
  );
}
function pagePlainNoCheckout(origin) {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style>${STRUCTURED_CSS}</style></head><body>` +
    structuredChrome(`<main><h1>About us</h1>${embedDiv('faq', 'faq0', origin)}</main>`) +
    '<script src="/js/module-embed.js"></script></body></html>'
  );
}
function pageNoCheckout(origin) {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style>${STRUCTURED_CSS}</style></head><body>` +
    structuredChrome(`<main>${embedDiv('ecommerce', 'shop0', origin)}</main>`) +
    '<script src="/js/module-embed.js"></script></body></html>'
  );
}
function pageCheckout(origin) {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style>${STRUCTURED_CSS}</style></head><body>` +
    structuredChrome(`<main>${embedDiv('checkout', 'co1', origin)}</main>`) +
    '<script src="/js/module-embed.js"></script></body></html>'
  );
}
function pageDetail(origin, withChrome) {
  const chrome = withChrome
    ? '<header class="site-head" style="background:#fff;border-bottom:1px solid #ddd">' +
      '<div class="header-bar" style="display:flex;align-items:center;gap:16px;padding:12px 16px">' +
      '<a class="brand" href="/index">Victoria\u2019s Plants</a><nav class="head-links"><a href="/index">Home</a></nav></div></header>'
    : '';
  const style = withChrome
    ? '<style>body{margin:0;font-family:sans-serif}.brand{font-weight:800;color:#111;text-decoration:none}</style>'
    : '<style>body{margin:0;font-family:sans-serif}</style>';
  const config = JSON.stringify({
    api: origin,
    types: { ecommerce: { token: 'shop1', page: 'shop', items: ['widget'] } },
  });
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    style +
    '</head><body>' +
    chrome +
    '<main class="bp-detail-main" style="max-width:1100px;margin:0 auto;padding:24px 16px;box-sizing:border-box">' +
    `<div class="bitpype-module-embed" data-bitpype-detail-root="1" data-bitpype-api="${origin}"><p class="bp-mod-loading">Loading\u2026</p></div></main>` +
    `<script type="application/json" id="bp-detail-config">${config}</script>` +
    '<script src="/js/module-embed.js"></script></body></html>'
  );
}

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://fixture.local');
    const origin = `http://${req.headers.host}`;
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };
    if (u.pathname === '/js/module-embed.js') return send(200, 'text/javascript', read('public/js/module-embed.js'));
    if (u.pathname === '/css/mobile-nav.css') return send(200, 'text/css', read('public/css/mobile-nav.css'));
    if (u.pathname.startsWith('/api/v1/modules/public/')) {
      const token = decodeURIComponent(u.pathname.split('/').pop());
      return send(200, 'application/json', JSON.stringify(fixturePayload(token, u.searchParams.get('slug'))));
    }
    if (u.pathname === '/blank') return send(200, 'text/html', '<!DOCTYPE html><html><body>blank</body></html>');
    if (u.pathname === '/shop-structured')
      return send(200, 'text/html', pageStructured(origin, embedDiv('gallery', 'gal1', origin)));
    if (u.pathname === '/shop-partials') return send(200, 'text/html', pagePartials(origin));
    if (u.pathname === '/shop-nocheckout') return send(200, 'text/html', pageNoCheckout(origin));
    if (u.pathname === '/plain') return send(200, 'text/html', pagePlain(origin));
    if (u.pathname === '/plain-nocheckout') return send(200, 'text/html', pagePlainNoCheckout(origin));
    if (u.pathname === '/mixed') return send(200, 'text/html', pageStructured(origin, embedDiv('faq', 'faq1', origin)));
    if (u.pathname === '/checkout-page') return send(200, 'text/html', pageCheckout(origin));
    if (u.pathname === '/detail/ecommerce/widget') return send(200, 'text/html', pageDetail(origin, false));
    if (u.pathname === '/detail/ecommerce/widget2') return send(200, 'text/html', pageDetail(origin, true));
    if (u.pathname === '/checkout')
      return send(200, 'text/html', '<!DOCTYPE html><html><body>checkout dummy</body></html>');
    return send(404, 'text/plain', 'nope');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function launchBrowser() {
  const puppeteer = require('puppeteer');
  const opts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      opts.executablePath = p;
      break;
    }
  }
  if (!opts.executablePath) {
    try {
      const resolved = await puppeteer.executablePath();
      if (resolved && fs.existsSync(resolved)) opts.executablePath = resolved;
    } catch {
      /* launch surfaces the error */
    }
  }
  return puppeteer.launch(opts);
}

const MEASURE = function () {
  var cart = document.querySelector('[data-bp-nav-cart]');
  var out = {
    count: document.querySelectorAll('[data-bp-nav-cart]').length,
    bars: document.querySelectorAll('.bp-mod-cartbar').length,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  };
  if (cart) {
    var r = cart.getBoundingClientRect();
    var cs = getComputedStyle(cart);
    out.rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    out.display = cs.display;
    out.href = cart.getAttribute('href');
    var s = cart.querySelector('[data-bp-nav-cart-summary]');
    out.summary = s ? s.textContent : '';
    out.inPanel = !!cart.closest('.bp-nav-panel');
    out.inLinks = !!cart.closest('.nav-links');
    out.inHeaderOrNav = !!cart.closest('header, nav, [data-ws-section-type="nav"], .ws-nav-chrome');
  }
  var brand = document.querySelector('.brand');
  if (brand) {
    var b = brand.getBoundingClientRect();
    out.brand = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  }
  var burger = document.querySelector('.bp-nav-burger');
  if (burger) {
    var g = burger.getBoundingClientRect();
    out.burger = {
      left: g.left,
      top: g.top,
      right: g.right,
      bottom: g.bottom,
      display: getComputedStyle(burger).display,
    };
  }
  var panel = document.querySelector('.bp-nav-panel');
  if (panel) out.panelDisplay = getComputedStyle(panel).display;
  return out;
};
function overlaps(a, b) {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}
function assertGeometry(m, width, label) {
  assert.equal(m.count, 1, `${label} @${width}: exactly one nav cart`);
  assert.ok(m.rect && m.rect.width > 0 && m.rect.height > 0, `${label} @${width}: cart has size`);
  assert.ok(
    m.rect.left >= 0 && m.rect.right <= m.innerW + 1,
    `${label} @${width}: cart inside the viewport horizontally`
  );
  assert.notEqual(m.display, 'none', `${label} @${width}: cart is displayed`);
  assert.ok(m.scrollW <= m.innerW + 1, `${label} @${width}: no horizontal overflow (${m.scrollW} <= ${m.innerW})`);
  assert.ok(!m.inPanel, `${label} @${width}: cart is NOT inside the collapsed mobile panel`);
  assert.ok(!m.inLinks, `${label} @${width}: cart is NOT inside .nav-links (hidden at mobile widths)`);
  assert.ok(m.inHeaderOrNav, `${label} @${width}: cart lives in the header/nav chrome`);
  if (m.brand) assert.ok(!overlaps(m.rect, m.brand), `${label} @${width}: cart does not overlap the brand`);
  if (m.burger && m.burger.display !== 'none' && m.burger.right > m.burger.left) {
    assert.ok(!overlaps(m.rect, m.burger), `${label} @${width}: cart does not overlap the hamburger`);
  }
}

async function part3() {
  let n = 0;
  const { server, origin } = await startFixtureServer();
  const browser = await launchBrowser();
  try {
    async function freshPage(width) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
      await page.setViewport({ width, height: width <= 700 ? 844 : 960 });
      await page.goto(origin + '/blank', { waitUntil: 'load' });
      await page.evaluate(() => {
        try {
          window.localStorage.clear();
        } catch (e) {
          /* fresh origin */
        }
      });
      return { page, errors };
    }
    async function waitSummary(page, text) {
      await page.waitForFunction(
        (t) => {
          var s = document.querySelector('[data-bp-nav-cart-summary]');
          return !!s && s.textContent === t;
        },
        { timeout: 8000 },
        text
      );
    }

    /* ---- nav-section chrome: one cart, empty state, live update ---- */
    {
      const { page, errors } = await freshPage(1440);
      await page.goto(origin + '/shop-structured', { waitUntil: 'load' });
      await page.waitForSelector('[data-bp-nav-cart]', { timeout: 8000 });
      await waitSummary(page, '0 items — $0.00');
      let m = await page.evaluate(MEASURE);
      assertGeometry(m, 1440, 'structured');
      assert.equal(m.bars, 0, 'structured: no in-body cart bar anywhere');
      n++;
      assert.equal(m.href, '/checkout', "structured: nav cart target is the site's checkout page");
      n++;
      assert.equal(
        m.summary,
        '0 items — $0.00',
        'structured: EMPTY STATE is visible before any add (the documented decision)'
      );
      n++;
      // Two selling embeds (shop + gallery) share the signal — still one cart.
      assert.equal(m.count, 1, 'structured: two signal-carrying embeds still produce exactly ONE nav cart');
      n++;
      await page.evaluate(() => {
        window.__b142marker = 'still-here';
      });
      await page.click('[data-bp-add="7"]');
      await waitSummary(page, '1 item — $68.00');
      m = await page.evaluate(MEASURE);
      assert.equal(m.count, 1, 'structured: still exactly one nav cart after Add to cart');
      n++;
      assert.equal(m.bars, 0, 'structured: Add to cart creates no in-body bar');
      n++;
      const marker = await page.evaluate(() => window.__b142marker);
      assert.equal(marker, 'still-here', 'structured: count/total updated WITHOUT a page reload');
      n++;
      // Click-through lands on the checkout page.
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 8000 }),
        page.click('[data-bp-nav-cart]'),
      ]);
      assert.ok(page.url().endsWith('/checkout'), 'structured: clicking the nav cart goes to the checkout page');
      n++;
      assert.deepEqual(errors, [], 'structured: no page errors');
      n++;
      await page.close();
    }

    /* ---- nav-section chrome geometry at 980 / 390 ---- */
    for (const width of [980, 390]) {
      const { page, errors } = await freshPage(width);
      await page.goto(origin + '/shop-structured', { waitUntil: 'load' });
      await page.waitForSelector('[data-bp-nav-cart]', { timeout: 8000 });
      const m = await page.evaluate(MEASURE);
      assertGeometry(m, width, 'structured');
      n++;
      assert.deepEqual(errors, [], `structured @${width}: no page errors`);
      n++;
      await page.close();
    }

    /* ---- partials chrome (mobile-nav): visible outside the panel ---- */
    for (const width of [1440, 980, 390]) {
      const { page, errors } = await freshPage(width);
      await page.goto(origin + '/shop-partials', { waitUntil: 'load' });
      await page.waitForSelector('[data-bp-nav-cart]', { timeout: 8000 });
      await waitSummary(page, '0 items — $0.00');
      const m = await page.evaluate(MEASURE);
      assertGeometry(m, width, 'partials');
      n++;
      assert.equal(m.href, '/checkout', `partials @${width}: nav cart target is the checkout page`);
      n++;
      if (width === 390) {
        assert.equal(m.panelDisplay, 'none', 'partials @390: the hamburger panel is collapsed (fixture sanity)');
        n++;
        assert.notEqual(m.display, 'none', 'partials @390: the cart stays VISIBLE while the panel is collapsed');
        n++;
      }
      assert.deepEqual(errors, [], `partials @${width}: no page errors`);
      n++;
      await page.close();
    }

    /* ---- no checkout attached: no element at all ---- */
    {
      const { page, errors } = await freshPage(1440);
      await page.goto(origin + '/shop-nocheckout', { waitUntil: 'load' });
      await page.waitForSelector('.bp-mod-card', { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 400));
      const m = await page.evaluate(MEASURE);
      assert.equal(m.count, 0, 'no-checkout: a site without the Checkout module gets NO nav cart element');
      n++;
      assert.equal(m.bars, 0, 'no-checkout: no in-body bar either');
      n++;
      assert.deepEqual(errors, [], 'no-checkout: no page errors');
      n++;
      await page.close();
    }

    /* ---- the Checkout page itself: registers + tracks qty/remove ---- */
    {
      const { page, errors } = await freshPage(1440);
      await page.goto(origin + '/blank', { waitUntil: 'load' });
      await page.evaluate(() => {
        window.localStorage.setItem(
          'bp-cart-co1',
          JSON.stringify([
            {
              source: 'ecommerce',
              itemId: 7,
              variantId: null,
              variantLabel: '',
              name: 'Monstera Deliciosa',
              image_url: '',
              price_cents: 6800,
              currency: 'USD',
              qty: 1,
            },
          ])
        );
      });
      await page.goto(origin + '/checkout-page', { waitUntil: 'load' });
      await page.waitForSelector('[data-bp-nav-cart]', { timeout: 8000 });
      await waitSummary(page, '1 item — $68.00');
      let m = await page.evaluate(MEASURE);
      assert.equal(m.count, 1, 'checkout page: exactly one nav cart (registered from its own embed token)');
      n++;
      assert.equal(m.href, '/checkout', 'checkout page: nav cart points at its own page');
      n++;
      await page.click('[data-bp-inc="0"]');
      await waitSummary(page, '2 items — $136.00');
      n++;
      await page.click('[data-bp-remove="0"]');
      await waitSummary(page, '0 items — $0.00');
      m = await page.evaluate(MEASURE);
      assert.equal(m.count, 1, 'checkout page: still one nav cart after the cart empties');
      n++;
      assert.deepEqual(errors, [], 'checkout page: no page errors');
      n++;
      await page.close();
    }

    /* ---- detail shell WITH partials chrome: cart lands in it ---- */
    {
      const { page, errors } = await freshPage(1440);
      await page.goto(origin + '/detail/ecommerce/widget2', { waitUntil: 'load' });
      await page.waitForSelector('[data-bp-nav-cart]', { timeout: 8000 });
      await waitSummary(page, '0 items — $0.00');
      let m = await page.evaluate(MEASURE);
      assertGeometry(m, 1440, 'detail-chromed');
      n++;
      await page.click('[data-bp-add="7"]');
      await waitSummary(page, '1 item — $68.00');
      m = await page.evaluate(MEASURE);
      assert.equal(m.count, 1, 'detail-chromed: one nav cart after add');
      n++;
      assert.equal(m.bars, 0, 'detail-chromed: no in-body bar on the detail root');
      n++;
      assert.deepEqual(errors, [], 'detail-chromed: no page errors');
      n++;
      await page.close();
    }

    /* ---- detail shell WITHOUT chrome: graceful degradation ---- */
    {
      const { page, errors } = await freshPage(1440);
      await page.goto(origin + '/detail/ecommerce/widget', { waitUntil: 'load' });
      await page.waitForSelector('[data-bp-add="7"]', { timeout: 8000 });
      await page.click('[data-bp-add="7"]');
      await page.waitForFunction(
        () => {
          try {
            var lines = JSON.parse(window.localStorage.getItem('bp-cart-co1') || '[]');
            return Array.isArray(lines) && lines.length === 1;
          } catch (e) {
            return false;
          }
        },
        { timeout: 8000 }
      );
      await new Promise((r) => setTimeout(r, 300));
      const m = await page.evaluate(MEASURE);
      assert.equal(m.count, 0, 'detail-shell (no chrome): NO nav cart element is created — no stray floating element');
      n++;
      assert.equal(m.bars, 0, 'detail-shell (no chrome): no in-body bar either');
      n++;
      assert.deepEqual(errors, [], 'detail-shell (no chrome): the add completed with NO page error');
      n++;
      await page.close();
    }
    group('Part 3 Chromium nav cart', n);
  } finally {
    await browser.close();
    server.close();
  }
}

/* ================================================================== */
/* Part 4 — SITEWIDE EXTENSION: plain pages register the nav cart      */
/* ================================================================== */
async function part4() {
  let n = 0;
  const { server, origin } = await startFixtureServer();
  const browser = await launchBrowser();
  try {
    async function freshPage(width, seedCart) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
      await page.setViewport({ width, height: width <= 700 ? 844 : 960 });
      await page.goto(origin + '/blank', { waitUntil: 'load' });
      await page.evaluate((seed) => {
        try {
          window.localStorage.clear();
          if (seed) {
            window.localStorage.setItem(
              'bp-cart-co1',
              JSON.stringify([
                {
                  source: 'ecommerce',
                  itemId: 7,
                  variantId: null,
                  variantLabel: '',
                  name: 'Monstera Deliciosa',
                  image_url: '',
                  price_cents: 6800,
                  currency: 'USD',
                  qty: 1,
                },
              ])
            );
          }
        } catch (e) {
          /* fresh origin */
        }
      }, !!seedCart);
      return { page, errors };
    }
    async function waitSummary(page, text) {
      await page.waitForFunction(
        (t) => {
          var s = document.querySelector('[data-bp-nav-cart-summary]');
          return !!s && s.textContent === t;
        },
        { timeout: 8000 },
        text
      );
    }

    /* ---- plain content page: the cart is in the nav ── */
    {
      const { page, errors } = await freshPage(1440, false);
      await page.goto(origin + '/plain', { waitUntil: 'load' });
      await page.waitForSelector('[data-bp-nav-cart]', { timeout: 8000 });
      await waitSummary(page, '0 items — $0.00');
      const m = await page.evaluate(MEASURE);
      assertGeometry(m, 1440, 'plain');
      assert.equal(m.count, 1, 'plain: TWO stamped non-selling embeds still produce exactly ONE nav cart');
      n++;
      assert.equal(m.href, '/checkout', "plain: nav cart target is the site's checkout page");
      n++;
      assert.equal(m.summary, '0 items — $0.00', 'plain: the empty state shows on a page with no selling embed');
      n++;
      assert.equal(m.bars, 0, 'plain: no in-body bar');
      n++;
      assert.deepEqual(errors, [], 'plain: no page errors');
      n++;
      await page.close();
    }

    /* ---- plain page reads the SAME cart the shop wrote ── */
    {
      const { page, errors } = await freshPage(1440, true);
      await page.goto(origin + '/plain', { waitUntil: 'load' });
      await page.waitForSelector('[data-bp-nav-cart]', { timeout: 8000 });
      await waitSummary(page, '1 item — $68.00');
      const m = await page.evaluate(MEASURE);
      assert.equal(
        m.summary,
        '1 item — $68.00',
        'plain: live totals come from the same cart storage (bp-cart-<checkout token>) the selling pages use'
      );
      n++;
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 8000 }),
        page.click('[data-bp-nav-cart]'),
      ]);
      assert.ok(page.url().endsWith('/checkout'), 'plain: clicking the nav cart goes to the checkout page');
      n++;
      assert.deepEqual(errors, [], 'plain (seeded): no page errors');
      n++;
      await page.close();
    }

    /* ---- plain page geometry at 390 ── */
    {
      const { page, errors } = await freshPage(390, false);
      await page.goto(origin + '/plain', { waitUntil: 'load' });
      await page.waitForSelector('[data-bp-nav-cart]', { timeout: 8000 });
      const m = await page.evaluate(MEASURE);
      assertGeometry(m, 390, 'plain');
      n++;
      assert.deepEqual(errors, [], 'plain @390: no page errors');
      n++;
      await page.close();
    }

    /* ---- plain page on a site WITHOUT checkout: no cart ── */
    {
      const { page, errors } = await freshPage(1440, false);
      await page.goto(origin + '/plain-nocheckout', { waitUntil: 'load' });
      await page.waitForSelector('.bp-mod-faq', { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 400));
      const m = await page.evaluate(MEASURE);
      assert.equal(m.count, 0, 'plain-nocheckout: no stamp → NO nav cart on a plain page either');
      n++;
      assert.deepEqual(errors, [], 'plain-nocheckout: no page errors');
      n++;
      await page.close();
    }

    /* ---- mixed page: selling + plain signals agree on ONE cart ── */
    {
      const { page, errors } = await freshPage(1440, false);
      await page.goto(origin + '/mixed', { waitUntil: 'load' });
      await page.waitForSelector('[data-bp-nav-cart]', { timeout: 8000 });
      await waitSummary(page, '0 items — $0.00');
      let m = await page.evaluate(MEASURE);
      assert.equal(m.count, 1, 'mixed: selling signal + sitewide stamp on one page still produce exactly ONE nav cart');
      n++;
      await page.click('[data-bp-add="7"]');
      await waitSummary(page, '1 item — $68.00');
      m = await page.evaluate(MEASURE);
      assert.equal(m.count, 1, 'mixed: still one nav cart after Add to cart');
      n++;
      assert.deepEqual(errors, [], 'mixed: no page errors');
      n++;
      await page.close();
    }
    group('Part 4 sitewide extension (Chromium)', n);
  } finally {
    await browser.close();
    server.close();
  }
}

(async () => {
  try {
    part1();
    await part2();
    await part3();
    await part4();
    console.log(`batch142-checkout-nav-cart-regressions: ALL PASS — ${groups.join('; ')}`);
  } catch (e) {
    console.error('batch142-checkout-nav-cart-regressions FAILED:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
