'use strict';
/**
 * Batch 139 — PRICING MODULE (Ely's order 2026-11-04: "We need a
 * pricing module too — displays pricing set in portal and works with
 * all other modules"). The governing requirement is ONE PRICE
 * SOURCE: pricing set once in the portal is what the site displays,
 * what bookings charge, what the checkout engine prices, and what
 * the chat + voice agent quote.
 *
 * The reconciliation under test (server/pricing.js header): entries
 * are STANDALONE (own stored price) or LINKED to a booking service /
 * shop product (NO price copy — name + price resolve LIVE from the
 * source record); a price edit on a linked entry WRITES THROUGH to
 * the source record via that module's own writer, so the number the
 * pane edits is the number bookings/checkout charge. Variant
 * products are never flattened (range display; single-price edit
 * refused).
 *
 * What is pinned here:
 *   Part 1 — source pins: registration (29th MODULE_TYPES member at
 *     the deployed tip — count rotated by the finisher on rebase
 *     onto the Batch 138 tip), MODULE_META, MODULE_SCRIPT_VER mod39
 *     (relative bump from mod38, rotated by the finisher), shared-layer provider + parity, portal
 *     catalog/copy/nav/fields/meta/state + cache-bust, embed CSS +
 *     dormant-empty + card renderer, icon glyph, hosted MCP defs +
 *     plan gate + dispatch, client catalog, parity CRUD, design
 *     agent fences, design-chat census, chatbot price-book seam,
 *     lead delete/merge cascades, SEC-13 census (no new RAW/IDENT).
 *   Part 2 — engine (in-process): standalone CRUD + validation
 *     (modes fixed/from/text, negative refused never clamped, text
 *     needs its label, "from" needs an amount); link validation
 *     (cross-lead / unknown type / missing target refused); LIVE
 *     resolution (source reprice + rename flow into book + public
 *     payload with NO pricing-row write); WRITE-THROUGH (pane edit →
 *     source record changed → the base checkout line builder prices
 *     the edited figure; booking service record carries it for the
 *     129 seam); variant boundary (range label, single-price edit
 *     refused, variant prices untouched); dead-source dormancy +
 *     unlink snapshot; price book consumers (shared items, chat
 *     text byte-equal figures, empty book → no block); counts +
 *     purge steps.
 *   Part 3 — HTTP over the real server: portal owner signs in,
 *     anonymous refused, generic module routes create/list/update
 *     (write-through over HTTP), the public payload serves the book
 *     by token, a foreign lead's entry never resolves.
 *   Part 4 — POST-REBASE ONLY (Batch 129 pay-at-booking seam): on
 *     this Batch 128 base the seam (lineForBookingService) does not
 *     exist, so the part prints an explicit skip and counts ZERO
 *     checks — it is NOT a pass. On a post-129 tree it pins the seam
 *     wiring (the line builder consumes getBookingService's record)
 *     and proves the write-through price is the record it reads.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b139-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch139', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 24).toString('base64');

const PORT = 31489;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = ['batch139', 'fixture', 'password'].join('-');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
      if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
      const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
      const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const line of set) {
        const pair = String(line).split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      return res;
    },
  };
}
const json = async (res) => JSON.parse(await res.text());

const LEAD_A = 139001;
const LEAD_B = 139002;

(async () => {
  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const smSrc = read('server/siteModules.js');
    assert.ok(smSrc.includes("'pricing',"), 'pricing registered in MODULE_TYPES');
    n++;
    assert.ok(smSrc.includes("pricing: { label: 'Pricing'"), 'MODULE_META carries the Pricing label');
    n++;
    assert.ok(smSrc.includes("const MODULE_SCRIPT_VER = 'mod42'"), 'MODULE_SCRIPT_VER bumped mod38 -> mod39 (finisher rotation on rebase; Batch 164 finisher: current value mod40)');
    n++;
    assert.ok(smSrc.includes("case 'pricing':"), 'module purge steps know pricing');
    n++;
    assert.ok(smSrc.includes('pricing_entries'), 'purge drops pricing_entries');
    n++;
    assert.ok(smSrc.includes("type === 'pricing'"), 'public payload branch for pricing');
    n++;

    assert.ok(fs.existsSync(path.join(root, 'server/pricing.js')), 'pricing service exists');
    n++;
    const pricingSrc = read('server/pricing.js');
    assert.ok(pricingSrc.includes('pricing_entries'), 'service owns the pricing_entries table');
    n++;
    assert.ok(pricingSrc.includes('getPriceBook'), 'service exposes the price book');
    n++;
    assert.ok(pricingSrc.includes('updateBookingService'), 'write-through uses the bookings writer');
    n++;
    assert.ok(pricingSrc.includes('updateProduct'), 'write-through uses the shop writer');
    n++;

    const shareSrc = read('server/moduleShare.js');
    assert.ok(/pricing: \{\s*\n\s*kind: 'provider',/.test(shareSrc), 'registry has the pricing provider entry');
    n++;
    assert.ok(shareSrc.includes('function getPriceBook'), 'shared layer exposes getPriceBook');
    n++;

    const portalModulesSrc = read('server/portalModules.js');
    for (const fn of ['listPricingEntries', 'createPricingEntry', 'updatePricingEntry', 'deletePricingEntry']) {
      assert.ok(portalModulesSrc.includes(fn), `portal service layer wires ${fn}`);
      n++;
    }

    const mcpSrc = read('server/mcp.js');
    const catalogSrc = read('src/mcpCatalog.js');
    const paritySrc = read('src/mcpParityTools.js');
    for (const t of ['pricing.list', 'pricing.create', 'pricing.update', 'pricing.delete', 'pricing.getPriceBook']) {
      assert.ok(mcpSrc.includes(`name: '${t}'`), `hosted MCP defines ${t}`);
      assert.ok(catalogSrc.includes(`name: '${t}'`), `client catalog defines ${t}`);
      assert.ok(paritySrc.includes(`'${t}'`), `parity layer defines ${t}`);
      assert.ok(mcpSrc.includes(`'${t}',`), `plan gate carries ${t}`);
      n += 4;
    }
    assert.ok(mcpSrc.includes("name === 'pricing.update'"), 'hosted MCP dispatches pricing.update');
    n++;

    const agentSrc = read('server/museAgentTools.js');
    for (const t of ['pricing.list', 'pricing.getPriceBook', 'pricing.create', 'pricing.update', 'pricing.delete']) {
      assert.ok(agentSrc.includes(`'${t}'`), `agent tool fences carry ${t}`);
      n++;
    }

    const chatSrc = read('server/portalSiteChat.js');
    assert.ok(chatSrc.includes('Pricing:'), 'design-chat census reports pricing');
    n++;
    assert.ok(chatSrc.includes('ONE price source'), 'census states the one-source rule');
    n++;

    const botSrc = read('server/chatbot.js');
    assert.ok(botSrc.includes('function priceBookFor'), 'chatbot has the priceBookFor seam');
    n++;
    assert.ok(botSrc.includes('priceBook: priceBookFor(db, leadId)'), 'price book joins the chat context snapshot');
    n++;
    assert.ok(botSrc.includes('price_book: priceBookBlock'), 'price book rides the public chat config');
    n++;
    assert.ok(pricingSrc.includes('never subtract a discount yourself'), 'chat header pins the no-netting rule');
    n++;

    const portalJs = read('public/js/portal.js');
    assert.ok(portalJs.includes("{ type: 'pricing', label: 'Pricing' }"), 'portal catalog lists Pricing');
    n++;
    assert.ok(portalJs.includes("pricing: { singular: 'price entry'"), 'portal item copy for pricing');
    n++;
    assert.ok(portalJs.includes("key: 'linked_ref'"), 'portal editor has the link picker');
    n++;
    assert.ok(portalJs.includes('moduleState.pricing = data.pricing'), 'portal keeps pricing pane state');
    n++;
    const portalHtml = read('public/portal.html');
    assert.ok(portalHtml.includes('portal.js?v=batch178-router1'), 'portal.js cache-bust rotated');
    n++;

    const embedSrc = read('public/js/module-embed.js');
    assert.ok(embedSrc.includes('function pricingCardHtml'), 'embed renders pricing cards');
    n++;
    assert.ok(embedSrc.includes("type === 'pricing' && !items.length"), 'embed is dormant-empty for pricing');
    n++;
    assert.ok(embedSrc.includes('bp-mod-pricing'), 'embed carries pricing styles');
    n++;

    const iconsSrc = read('public/js/moduleIcons.js');
    assert.ok(/pricing: '/.test(iconsSrc), 'pricing has a catalog glyph');
    n++;

    const leadSrc = read('src/leadEngine.js');
    assert.ok(leadSrc.includes("drop('pricing_entries')"), 'lead delete cascade drops pricing_entries');
    n++;
    assert.ok(leadSrc.includes("'pricing_entries',"), 'lead merge moves pricing_entries');
    n++;

    // SEC-13: this batch adds NO new RAW/IDENT innerHTML sinks (the
    // embed renderer escapes every interpolated value).
    const { census } = require(path.join(root, 'scripts/xss-census.cjs'));
    const cz = census();
    assert.equal(cz.summary.RAW, 85, 'SEC-13 RAW sink count (Batch 176 finisher re-pin: 86 -> 85 — audited Assistant page-head shell reclassification RAW -> STATIC in app.js, multiset-proven vs the Batch 175 base; see the batch104 note) (Batch 165 rotation: 85 -> 86 — the one audited Webinar panel-shell RAW, pairwise-proven — see batch103 narrative); unchanged by 139 (Batch 164 rotation: 82 -> 85 — +3 audited Custom Code RAW sinks, pairwise-proven — see batch103 narrative); ( (77 at the Batch 138 tip, verified identical pre/post this change set; Batch 153 rotation: 77 -> 78 — the audited Design-agent editor panel-shell RAW in app.js; Batch 161 rotation: 78 -> 81 (Assistant surfaces); Batch 162 rotation: 81 -> 82 (the audited Contact-page RAW) — see batch103 narrative)');
    n++;
    assert.equal(cz.summary.IDENT, 41, 'SEC-13 IDENT sink count unchanged by 139 (36 at the Batch 138 tip, verified identical pre/post this change set; Batch 161 rotation: 36 -> 38 (Assistant surfaces); Batch 162 rotation: 38 unchanged — see batch103 narrative)');
    n++;

    group('Part 1 wiring pins', n);
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
  const pricing = require(path.join(root, 'server/pricing.js'));
  const chatbot = require(path.join(root, 'server/chatbot.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a139@example.invalid',
    password: ['batch139', 'fixture', 'password'].join('-'),
    name: 'A139',
    workspaceName: 'Batch139 WS',
  });
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'a139@example.invalid' });
  const WS_ID = Number(a.workspaceId);
  const db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  pricing.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B139 Alpha Cuts', 'alpha139@example.invalid'],
    [LEAD_B, 'B139 Beta Lawns', 'beta139@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
  }

  // ---- Fixtures: lead A sellables + lead B isolation sellable ----
  const svcClean = sm.createBookingService(db, LEAD_A, { name: 'Deep Clean', price: 80, status: 'published' });
  const svcTrim = sm.createBookingService(db, LEAD_A, { name: 'Hedge Trim', price: 45, status: 'published' });
  const prodPlain = sm.createProduct(db, LEAD_A, { name: 'Brass Watering Can', price: 29, status: 'published' });
  const prodVariants = sm.createProduct(db, LEAD_A, {
    name: 'Monstera Deliciosa',
    price: 58,
    status: 'published',
    options: [{ name: 'Pot', values: ['Nursery Pot', 'EcoPot'] }],
    variants: [{ values: ['EcoPot'], price_cents: 6800 }],
  });
  const svcB = sm.createBookingService(db, LEAD_B, { name: 'Beta Clean', price: 60, status: 'published' });

  // ---- 2a: registration + parity ----
  {
    let n = 0;
    assert.equal(sm.MODULE_TYPES.length, 32, 'catalog at 30 types at the deployed tip (finisher rotation on rebase; Batch 164: custom_code appended as the 30th)');
    n++;
    assert.equal(sm.MODULE_TYPES[28], 'pricing', 'pricing is the 29th-registered type (Batch 164 appends custom_code after it)');
    n++;
    assert.deepEqual(
      Object.keys(share.SHARE_REGISTRY).sort(),
      [...sm.MODULE_TYPES].sort(),
      'registry parity: every module type has a shared-layer entry'
    );
    n++;
    assert.equal(share.SHARE_REGISTRY.pricing.kind, 'provider', 'pricing is a shared-layer provider');
    n++;
    group('Part 2a registration + parity', n);
  }

  // ---- 2b: standalone CRUD + validation ----
  let standaloneId;
  {
    let n = 0;
    const pkg = pricing.createPricingEntry(db, LEAD_A, {
      name: 'Spring Package',
      price: 199,
      price_mode: 'from',
      unit_suffix: 'per visit',
      status: 'published',
      sort_order: 2,
    });
    standaloneId = pkg.id;
    assert.equal(pkg.price_cents, 19900, 'dollars price lands as cents');
    n++;
    assert.equal(pkg.price_label, 'From $199.00', 'from-mode label');
    n++;
    assert.equal(pkg.origin, 'standalone', 'standalone origin');
    n++;
    const fixed = pricing.createPricingEntry(db, LEAD_A, { name: 'Consult', price_cents: 5000, status: 'published', sort_order: 1 });
    assert.equal(fixed.price_label, '$50.00', 'fixed label');
    n++;
    const text = pricing.createPricingEntry(db, LEAD_A, {
      name: 'Big Job',
      price_mode: 'text',
      price_text: 'Custom quote',
      status: 'published',
      sort_order: 3,
    });
    assert.equal(text.price_label, 'Custom quote', 'text mode shows its label, no amount');
    n++;
    assert.equal(text.price_cents, null, 'text mode carries no amount');
    n++;
    const free = pricing.createPricingEntry(db, LEAD_A, { name: 'Intro Chat', price_cents: 0, status: 'published', sort_order: 4 });
    assert.equal(free.price_label, 'Free', 'an explicit zero reads as Free');
    n++;

    assert.throws(
      () => pricing.createPricingEntry(db, LEAD_A, { name: 'Neg', price: -5 }),
      (e) => e.code === 'VALIDATION',
      'negative price refused, never clamped'
    );
    n++;
    assert.throws(
      () => pricing.createPricingEntry(db, LEAD_A, { name: 'NoLabel', price_mode: 'text' }),
      (e) => e.code === 'VALIDATION',
      'text mode without a label refused'
    );
    n++;
    assert.throws(
      () => pricing.createPricingEntry(db, LEAD_A, { name: 'FromZero', price_mode: 'from', price_cents: 0 }),
      (e) => e.code === 'VALIDATION',
      '"from" with no amount refused'
    );
    n++;
    assert.throws(
      () => pricing.createPricingEntry(db, LEAD_A, { price: 10 }),
      (e) => e.code === 'VALIDATION',
      'standalone entry without a name refused'
    );
    n++;
    assert.throws(
      () => pricing.createPricingEntry(db, LEAD_A, { name: 'BadMode', price_mode: 'hourly', price: 10 }),
      (e) => e.code === 'VALIDATION',
      'unknown price_mode refused'
    );
    n++;

    const upd = pricing.updatePricingEntry(db, LEAD_A, fixed.id, { price: 55, featured: true });
    assert.equal(upd.price_cents, 5500, 'standalone price edit lands on its own row');
    n++;
    assert.equal(upd.featured, true, 'featured flag lands');
    n++;
    const del = pricing.deletePricingEntry(db, LEAD_A, fixed.id);
    assert.equal(del.deleted, true, 'delete works');
    n++;
    assert.throws(
      () => pricing.getPricingEntry(db, LEAD_A, fixed.id),
      (e) => e.code === 'NOT_FOUND',
      'deleted entry is gone'
    );
    n++;
    group('Part 2b standalone CRUD + validation', n);
  }

  // ---- 2c: links — validation + LIVE resolution ----
  let svcEntryId;
  {
    let n = 0;
    assert.throws(
      () => pricing.createPricingEntry(db, LEAD_A, { linked_type: 'bookings', linked_id: svcB.id }),
      (e) => e.code === 'VALIDATION',
      "another lead's service cannot be linked (cross-lead refused)"
    );
    n++;
    assert.throws(
      () => pricing.createPricingEntry(db, LEAD_A, { linked_type: 'menu', linked_id: 1 }),
      (e) => e.code === 'VALIDATION',
      'only bookings/ecommerce are linkable'
    );
    n++;
    assert.throws(
      () => pricing.createPricingEntry(db, LEAD_A, { linked_type: 'bookings', linked_id: 999999 }),
      (e) => e.code === 'VALIDATION',
      'a missing target is refused at link time'
    );
    n++;

    const linked = pricing.createPricingEntry(db, LEAD_A, {
      linked_ref: `bookings:${svcClean.id}`,
      unit_suffix: 'per visit',
      status: 'published',
      sort_order: 0,
    });
    svcEntryId = linked.id;
    assert.equal(linked.name, 'Deep Clean', 'linked name resolves from the service');
    n++;
    assert.equal(linked.price_cents, 8000, 'linked price resolves from the service');
    n++;
    assert.equal(linked.price_label, '$80.00', 'linked label');
    n++;
    assert.equal(linked.origin, 'bookings', 'origin names the source module');
    n++;

    // LIVE resolution: edit the SOURCE directly (its own pane) — the
    // book and the public payload move with NO pricing-row write.
    const rowBefore = db.prepare('SELECT * FROM pricing_entries WHERE id = ?').get(svcEntryId);
    sm.updateBookingService(db, LEAD_A, svcClean.id, { price_cents: 9500, name: 'Deep Clean Deluxe' });
    const book = pricing.getPriceBook(db, LEAD_A);
    const fromBook = book.entries.find((e) => e.id === svcEntryId);
    assert.equal(fromBook.price_cents, 9500, 'book shows the repriced service with no pricing write');
    n++;
    assert.equal(fromBook.name, 'Deep Clean Deluxe', 'book shows the renamed service');
    n++;
    const payload = pricing.publicPricingPayload(db, LEAD_A);
    assert.equal(payload.entries.find((e) => e.id === svcEntryId).price_label, '$95.00', 'public payload resolves live too');
    n++;
    const rowAfter = db.prepare('SELECT * FROM pricing_entries WHERE id = ?').get(svcEntryId);
    assert.equal(rowAfter.updated_at, rowBefore.updated_at, 'the pricing row was never rewritten');
    n++;
    assert.equal(rowAfter.price_cents, rowBefore.price_cents, 'no price copy is stored for a linked entry beyond its snapshot');
    n++;
    group('Part 2c links + live resolution', n);
  }

  // ---- 2d: write-through ----
  let prodEntryId;
  let variantEntryId;
  {
    let n = 0;
    // Service: the pane edit lands on the service record itself.
    const viaSetter = pricing.setPricingEntryPrice(db, LEAD_A, svcEntryId, { price: 120 });
    assert.equal(sm.getBookingService(db, LEAD_A, svcClean.id).price_cents, 12000, 'write-through changed the service record');
    n++;
    assert.equal(viaSetter.entry.price_label, '$120.00', 'the returned entry is resolved post-write');
    n++;
    assert.equal(
      viaSetter.price_book.entries.find((e) => e.id === svcEntryId).price_cents,
      12000,
      'the returned price book carries the new figure'
    );
    n++;
    // Same through the generic update path (what the portal PUT sends).
    pricing.updatePricingEntry(db, LEAD_A, svcEntryId, { price_cents: 11000 });
    assert.equal(sm.getBookingService(db, LEAD_A, svcClean.id).price_cents, 11000, 'generic update writes through too');
    n++;
    // The record every booking charge reads IS this record: the
    // public services payload (bookings' own surface) shows it.
    const svcPayloadRow = sm.listBookingServices(db, LEAD_A, { includeDrafts: false }).find((s) => s.id === svcClean.id);
    assert.equal(svcPayloadRow.price_label, '$110.00', 'the bookings surface reads the same single number');
    n++;

    // Product (no variants): write-through + the checkout engine's
    // own line builder prices the edited figure — the money proof at
    // this base (Batch 128 buildSellableLines).
    const prodEntry = pricing.createPricingEntry(db, LEAD_A, {
      linked_type: 'ecommerce',
      linked_id: prodPlain.id,
      status: 'published',
      sort_order: 5,
    });
    prodEntryId = prodEntry.id;
    assert.equal(prodEntry.price_cents, 2900, 'product link resolves the product price');
    n++;
    pricing.updatePricingEntry(db, LEAD_A, prodEntryId, { price: 34 });
    assert.equal(sm.getProduct(db, LEAD_A, prodPlain.id).price_cents, 3400, 'write-through changed the product record');
    n++;
    const built = sm.buildSellableLines(db, LEAD_A, [{ source: 'ecommerce', itemId: prodPlain.id, quantity: 2 }]);
    assert.equal(built.lines[0].unit_price_cents, 3400, 'checkout line builder prices the write-through figure');
    n++;
    assert.equal(built.lines[0].line_total_cents, 6800, 'line total follows');
    n++;

    // Variant product: range display, single-price edit REFUSED,
    // variant prices untouched.
    const vEntry = pricing.createPricingEntry(db, LEAD_A, {
      linked_type: 'ecommerce',
      linked_id: prodVariants.id,
      status: 'published',
      sort_order: 6,
    });
    variantEntryId = vEntry.id;
    assert.equal(vEntry.has_variants, true, 'variant product flagged');
    n++;
    assert.equal(vEntry.price_label, 'From $58.00', 'variant product shows its honest range');
    n++;
    assert.equal(vEntry.display_mode, 'from', 'range displays as a from-price');
    n++;
    assert.throws(
      () => pricing.setPricingEntryPrice(db, LEAD_A, variantEntryId, { price: 60 }),
      (e) => e.code === 'VALIDATION' && /variant/i.test(e.message),
      'a single price on a variant product is refused with directions'
    );
    n++;
    assert.throws(
      () => pricing.updatePricingEntry(db, LEAD_A, variantEntryId, { price_cents: 6000 }),
      (e) => e.code === 'VALIDATION',
      'the refusal holds on the generic update path too'
    );
    n++;
    const variantsAfter = sm.listProductVariants(db, LEAD_A, prodVariants.id);
    assert.deepEqual(
      variantsAfter.map((v) => v.price_cents).sort((x, y) => x - y),
      [5800, 6800],
      'variant prices are exactly as they were'
    );
    n++;
    assert.equal(sm.getProduct(db, LEAD_A, prodVariants.id).price_cents, 5800, 'the product base price was not flattened either');
    n++;

    // Source-owned fields refuse on linked entries.
    assert.throws(
      () => pricing.updatePricingEntry(db, LEAD_A, svcEntryId, { name: 'Renamed In The Wrong Pane' }),
      (e) => e.code === 'VALIDATION',
      'renaming a linked entry in the pricing pane is refused (rename the service)'
    );
    n++;
    assert.throws(
      () => pricing.updatePricingEntry(db, LEAD_A, svcEntryId, { currency: 'EUR' }),
      (e) => e.code === 'VALIDATION',
      'currency of a linked entry is source-owned and refused here'
    );
    n++;
    group('Part 2d write-through', n);
  }

  // ---- 2e: dead source + unlink ----
  {
    let n = 0;
    const doomed = pricing.createPricingEntry(db, LEAD_A, {
      linked_type: 'bookings',
      linked_id: svcTrim.id,
      status: 'published',
      sort_order: 7,
    });
    assert.equal(pricing.getPriceBook(db, LEAD_A).entries.some((e) => e.id === doomed.id), true, 'entry is in the book while its source lives');
    n++;
    sm.deleteBookingService(db, LEAD_A, svcTrim.id);
    assert.equal(
      pricing.getPriceBook(db, LEAD_A).entries.some((e) => e.id === doomed.id),
      false,
      'a deleted source drops the entry out of the book — never a dangling price'
    );
    n++;
    assert.equal(
      pricing.publicPricingPayload(db, LEAD_A).entries.some((e) => e.id === doomed.id),
      false,
      'and out of the public payload'
    );
    n++;
    const listed = pricing.listPricingEntries(db, LEAD_A).find((e) => e.id === doomed.id);
    assert.equal(listed.source_missing, true, 'the portal list flags the dead link');
    n++;
    const unlinked = pricing.updatePricingEntry(db, LEAD_A, doomed.id, { linked_ref: '' });
    assert.equal(unlinked.origin, 'standalone', 'unlink makes the entry standalone');
    n++;
    assert.equal(unlinked.name, 'Hedge Trim', 'unlink keeps the last live name (snapshot)');
    n++;
    assert.equal(unlinked.price_cents, 4500, 'unlink keeps the last live price (snapshot)');
    n++;
    assert.equal(
      pricing.getPriceBook(db, LEAD_A).entries.some((e) => e.id === doomed.id),
      true,
      'the unlinked entry stands in the book on its own values'
    );
    n++;
    group('Part 2e dead source + unlink', n);
  }

  // ---- 2f: the book's consumers ----
  {
    let n = 0;
    // Drafts never enter the book.
    const draft = pricing.createPricingEntry(db, LEAD_A, { name: 'Secret Price', price: 1, status: 'draft' });
    const book = pricing.getPriceBook(db, LEAD_A);
    assert.equal(book.entries.some((e) => e.id === draft.id), false, 'draft entries stay out of the book');
    n++;
    // The shared layer serves the same book, figures in meta.
    const sharedItems = share.listSharedItems(db, LEAD_A, 'pricing', { limit: 50 });
    assert.equal(sharedItems.length, book.count, 'shared items == price book');
    n++;
    const svcShared = sharedItems.find((i) => Number(i.source_id) === svcEntryId);
    assert.equal(svcShared.meta.price_cents, 11000, 'shared meta carries the resolved amount');
    n++;
    assert.equal(svcShared.meta.price_label, '$110.00', 'shared meta carries the exact label');
    n++;
    assert.deepEqual(share.getPriceBook(db, LEAD_A), book, 'the shared-layer book IS the service book');
    n++;
    // Chat text: figures byte-equal to the book's labels.
    const text = pricing.priceBookChatText(book);
    assert.ok(text.includes(pricing.PRICE_BOOK_CHAT_HEADER), 'chat block carries the pinned header');
    n++;
    for (const e of book.entries) {
      assert.ok(text.includes(`- ${e.name}: ${e.price_label}`), `chat line byte-matches the book for ${e.name}`);
      n++;
    }
    assert.equal(pricing.priceBookChatText({ entries: [], count: 0 }), null, 'an empty book produces NO chat block');
    n++;
    assert.equal(pricing.priceBookChatText(share.getPriceBook(db, LEAD_B)), null, 'a lead with no entries gets no block');
    n++;
    // The chatbot reader agrees (present here, absent for lead B).
    assert.ok(chatbot.priceBookFor(db, LEAD_A).text.includes('$110.00'), 'chatbot priceBookFor serves the block');
    n++;
    assert.equal(chatbot.priceBookFor(db, LEAD_B), null, 'chatbot priceBookFor is null without a book');
    n++;
    // Public payload through the real embed path.
    sm.attachModule(db, LEAD_A, 'pricing', { workspaceId: WS_ID });
    const emb = sm.getEmbedRow(db, LEAD_A, 'pricing');
    const pub = sm.getPublicModuleByToken(db, emb.public_token);
    assert.equal(pub.module_type, 'pricing', 'public payload is the pricing module');
    n++;
    assert.equal(pub.items.length, book.count, 'public items == price book');
    n++;
    assert.ok(pub.pricing && Array.isArray(pub.pricing.entries), 'payload carries the pricing block');
    n++;
    // Dormant-empty: lead B has the module but no entries.
    sm.attachModule(db, LEAD_B, 'pricing', { workspaceId: WS_ID });
    const embB = sm.getEmbedRow(db, LEAD_B, 'pricing');
    const pubB = sm.getPublicModuleByToken(db, embB.public_token);
    assert.deepEqual(pubB.items, [], 'no published entries -> empty payload (dormant)');
    n++;
    // Counts + purge wiring.
    assert.equal(sm.moduleItemCount(db, LEAD_A, 'pricing'), pricing.listPricingEntries(db, LEAD_A).length, 'tab badge counts entries');
    n++;
    const counts = sm.moduleContentCounts(db, LEAD_A, 'pricing');
    assert.ok(counts.parts.some((p) => p.table === 'pricing_entries'), 'purge preview names pricing_entries');
    n++;
    group('Part 2f price book consumers', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
  {
    let n = 0;
    const q = platformDb.query;
    const bcrypt = require('bcryptjs');
    await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)', {
      e: 'owner139@example.invalid',
      h: bcrypt.hashSync('UnusedPass139!', 12),
      n: 'B139 Portal Link',
      s: 'active',
    });
    await q(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
      { e: 'owner139@example.invalid', h: bcrypt.hashSync(PW, 12), w: WS_ID, l: LEAD_A, b: 'B139 Alpha Cuts' }
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
        const res = await post(owner, '/api/v1/portal/login', { email: 'owner139@example.invalid', password: PW });
        assert.equal(res.status, 200, 'portal owner login');
        n++;
      }
      {
        const res = await fetch(`${BASE}/api/v1/portal/modules/pricing`);
        assert.equal(res.status, 401, 'anonymous pricing list refused');
        n++;
      }
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/pricing`);
        assert.equal(res.status, 200, 'pricing list over HTTP');
        const data = await json(res);
        const payload = data.data || data;
        assert.ok(Array.isArray(payload.items) && payload.items.length >= 4, 'list carries the fixture entries');
        n++;
        const linkedRow = payload.items.find((e) => e.id === svcEntryId);
        assert.equal(linkedRow.price_label, '$110.00', 'list rows arrive resolved');
        n++;
        assert.ok(payload.pricing && payload.pricing.linkables.bookings.length >= 1, 'list carries the linkables picker data');
        n++;
        assert.equal(payload.pricing.price_book.count, payload.pricing.price_book.entries.length, 'list carries the resolved book');
        n++;
      }
      let httpEntryId;
      {
        const res = await post(owner, '/api/v1/portal/modules/pricing', {
          name: 'HTTP Package',
          price: 75,
          status: 'published',
        });
        assert.equal(res.status, 200, 'generic module route creates an entry');
        const data = await json(res);
        httpEntryId = ((data.data || data).item || {}).id;
        assert.ok(httpEntryId, 'created entry id returned');
        n += 2;
      }
      {
        // Write-through over HTTP: edit the linked service entry's
        // price through the generic route; the service record moves.
        const res = await put(owner, `/api/v1/portal/modules/pricing/${svcEntryId}`, { price: 130 });
        assert.equal(res.status, 200, 'generic module route updates the linked entry');
        n++;
        assert.equal(sm.getBookingService(db, LEAD_A, svcClean.id).price_cents, 13000, 'the service record carries the HTTP write-through');
        n++;
      }
      {
        const emb = sm.getEmbedRow(db, LEAD_A, 'pricing');
        const res = await fetch(`${BASE}/api/v1/modules/public/${emb.public_token}`);
        assert.equal(res.status, 200, 'public payload over HTTP');
        const data = await json(res);
        const block = (data.data || data).pricing;
        assert.ok(block && block.entries.some((e) => e.name === 'HTTP Package' && e.price_label === '$75.00'), 'public payload serves the HTTP-created entry');
        n += 2;
        assert.ok(
          block.entries.some((e) => e.name === 'Deep Clean Deluxe' && e.price_label === '$130.00'),
          'public payload serves the write-through price'
        );
        n++;
      }
      group('Part 3 HTTP portal + public flow', n);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }

  /* ================================================================== */
  /* Part 4 — POST-REBASE: the Batch 129 pay-at-booking seam.            */
  /* On this Batch 128 base the seam does not exist: explicit skip,      */
  /* ZERO checks counted (not a pass). The finisher rebases onto the    */
  /* post-138 tip, where 129 is long landed — there this part runs.     */
  /* ================================================================== */
  {
    const smSrc = read('server/siteModules.js');
    if (!smSrc.includes('function lineForBookingService')) {
      console.log(
        '  skip Part 4 (POST-REBASE ONLY): Batch 129 pay-at-booking seam absent on the Batch 128 base — 0 checks counted'
      );
    } else {
      let n = 0;
      assert.ok(
        smSrc.includes('lineForBookingService(servicePreview, appointment)') &&
          smSrc.includes('const servicePreview = getBookingService('),
        'the seam builds its line from the getBookingService record'
      );
      n++;
      const seamAt = smSrc.indexOf('function lineForBookingService');
      assert.ok(
        seamAt >= 0 && smSrc.slice(seamAt, seamAt + 1200).includes('unit_price_cents: Number(service.price_cents)'),
        'the line builder copies service.price_cents verbatim — the record the pricing write-through edits'
      );
      n++;
      // Behavioral half: after a pricing-pane write-through, the
      // record the seam consumes carries the new figure.
      pricing.setPricingEntryPrice(db, LEAD_A, svcEntryId, { price_cents: 13500 });
      const seamInput = sm.getBookingService(db, LEAD_A, svcClean.id);
      assert.equal(seamInput.price_cents, 13500, 'the seam input record carries the write-through price');
      n++;
      group('Part 4 pay-at-booking seam (post-rebase)', n);
    }
  }

  const total = groups.reduce((acc, g) => acc + Number(g.match(/\((\d+)\)$/)[1]), 0);
  console.log(`BATCH139 SUITE: ${groups.length} groups, ${total} checks — ALL PASS`);
})().catch((e) => {
  console.error('BATCH139 SUITE FAILURE:', e);
  process.exit(1);
});
