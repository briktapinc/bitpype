'use strict';
/**
 * Batch 134 — WIDE BUG HUNT FIXES (Ely's order 2026-11-04: "find any
 * other bugs because we've made a lot of changes since sunday").
 * Two confirmed defects from the hunt over Batches 111–128:
 *
 *   1. WIFI PASSWORD IN ANONYMOUS PAYLOADS — Batch 126's contract is
 *      that a WiFi QR code's password exists only inside the rendered
 *      code image, but the resolved payload (WIFI:T:…;P:<password>;;)
 *      rode three anonymous surfaces verbatim: the module-embed
 *      payload (publicQrCodePayload), the shared-layer item
 *      description (moduleShare qrcode provider — which also feeds
 *      newsletter blocks mailed to subscribers), and the categories
 *      public item cards built on the shared layer. Fixes: the embed
 *      payload ships an empty payload for wifi codes (the renderer
 *      never reads it), and the shared item describes a wifi code by
 *      network name only.
 *   2. LEAD DELETE / MERGE CASCADES MISS THE WINDOW TABLES — the
 *      Batch 122/124–128 tables are lead_id-keyed with no FK to
 *      leads, and leadEngine's deleteLead drop list + merge
 *      treatments never learned them. Deleting a lead orphaned its
 *      products/variant tree/orders+line items (buyer emails
 *      included), QR codes, photo submissions + config, checkout
 *      config, shared refs and LeadScout capture events; merging a
 *      lead silently stranded the same set on the dead lead (a
 *      merged shop kept its products but lost every variant; orders
 *      moved without their line items). Fixes: deleteLead drops the
 *      tables (children first, modulePurgeSteps order); merges move
 *      them, dedupe shared refs by their unique key, treat the two
 *      per-lead configs as singletons, remap category (scope, slug)
 *      clashes onto the keeper's twin, and sweep variant-tree rows
 *      whose product the slug dedupe deleted.
 *
 *   Part 1 — source pins for every fix.
 *   Part 2 — engine (in-process): the three WiFi surfaces, the
 *     deleteLead orphan inventory (must be EMPTY), the merge battery
 *     (moves, clash remap, singleton survival, dedupe, sweep).
 *   Part 3 — HTTP over the real server: anonymous embed + category
 *     payloads carry no password; the QR image route still serves.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b134-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch134', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 21).toString('base64');

const PORT = 31494;
const BASE = `http://127.0.0.1:${PORT}`;
const WIFI_PW = ['Hunt', 'Wifi', 'Pw', '9241'].join('-');

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
    return { raw: text };
  }
}

const LEAD_DEL = 13401;
const LEAD_KEEP = 13402;
const LEAD_DROP = 13403;
let WS_ID;
let db;

(async () => {
  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const smSrc = read('server/siteModules.js');
    const pubIdx = smSrc.indexOf('function publicQrCodePayload');
    assert.ok(pubIdx > 0, 'publicQrCodePayload exists');
    const pubBody = smSrc.slice(pubIdx, pubIdx + 1600);
    assert.ok(
      pubBody.includes("code.target_kind === 'wifi' ? '' : resolved.payload"),
      'embed payload blanks the resolved payload for wifi codes'
    );
    n += 2;

    const shareSrc = read('server/moduleShare.js');
    const qrIdx = shareSrc.indexOf("kind: 'provider',\n    read(db, leadId) {\n      return modules\n        .listQrCodes");
    assert.ok(qrIdx > 0, 'moduleShare qrcode provider located');
    const qrBody = shareSrc.slice(qrIdx, qrIdx + 1400);
    assert.ok(qrBody.includes("c.target_kind === 'wifi'"), 'shared qrcode item special-cases wifi');
    assert.ok(qrBody.includes('WiFi network:'), 'shared wifi description is the network label, not the payload');
    n += 3;

    const leSrc = read('src/leadEngine.js');
    for (const t of [
      'ecommerce_order_items',
      'ecommerce_product_variants',
      'ecommerce_product_option_values',
      'ecommerce_product_options',
      'ecommerce_orders',
      'ecommerce_products',
      'module_qrcodes',
      'photocapture_submissions',
      'photocapture_configs',
      'checkout_configs',
      'module_shared_refs',
      'leadscout_events',
    ]) {
      assert.ok(leSrc.includes(`drop('${t}')`), `deleteLead drops ${t}`);
      n++;
    }
    for (const t of [
      'module_qrcodes',
      'photocapture_submissions',
      'ecommerce_order_items',
      'ecommerce_product_options',
      'ecommerce_product_option_values',
      'ecommerce_product_variants',
      'module_categories',
      'module_category_assignments',
    ]) {
      assert.ok(leSrc.includes(`'${t}',`), `merge moves ${t}`);
      n++;
    }
    assert.ok(
      leSrc.includes("module_shared_refs: ['consumer_type', 'consumer_id', 'provider_type', 'role']"),
      'merge dedupes shared refs by their unique key'
    );
    assert.ok(leSrc.includes("'photocapture_configs',"), 'merge treats photocapture_configs as singleton');
    assert.ok(leSrc.includes("'checkout_configs',"), 'merge treats checkout_configs as singleton');
    assert.ok(leSrc.includes('category (scope, slug) clash remap'), 'merge carries the category clash remap');
    assert.ok(leSrc.includes('variant-tree sweep'), 'merge carries the variant-tree sweep');
    n += 5;
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
  const leadEngine = require(path.join(root, 'src/leadEngine.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a134@example.invalid',
    password: ['batch134', 'owner', 'pass'].join('-'),
    name: 'A134',
    workspaceName: 'Batch134 WS',
  });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  leadEngine.ensureLeadColumns(db);

  function leadTablesWithLeadId() {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name)
      .filter((t) => db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'lead_id'));
  }
  function rowsFor(leadId) {
    const res = {};
    for (const t of leadTablesWithLeadId()) {
      const c = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE lead_id = ?`).get(leadId).c;
      if (c > 0) res[t] = c;
    }
    return res;
  }

  // A lead with the full window surface: variant product, WiFi QR,
  // categories + assignment, both configs, a photo submission, an
  // order with a line item, and a shared-layer ref.
  function seedLead(id, name, prefix, { fernSlug = `${prefix}-fern` } = {}) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      `${prefix}@example.invalid`,
      'customer'
    );
    const prod = sm.createProduct(db, id, {
      name: `${name} Fern`,
      slug: fernSlug,
      price_cents: 4200,
      status: 'published',
      options: [{ name: 'Pot', values: ['Nursery', 'Clay'] }],
      variants: [
        { values: ['Nursery'], price_cents: 4200, sku: `${prefix}-NUR`, available: 1 },
        { values: ['Clay'], price_cents: 4900, sku: `${prefix}-CLAY`, available: 1 },
      ],
    });
    sm.attachModule(db, id, 'qrcode', { workspaceId: WS_ID });
    const qr = sm.createQrCode(db, id, {
      name: 'Guest WiFi',
      target_kind: 'wifi',
      wifi_ssid: `${prefix}GuestNet`,
      wifi_auth: 'WPA',
      wifi_password: WIFI_PW,
      status: 'published',
    });
    const cat = cats.createCategory(db, id, { scope: 'ecommerce', name: 'Plants', status: 'published' });
    cats.assignItem(db, id, { consumer_type: 'ecommerce', item_id: prod.id, category_id: cat.id });
    sm.updatePhotoCaptureConfig(db, id, { heading: `${name} photos` });
    sm.updateCheckoutConfig(db, id, { success_message: `${name} thanks` });
    const sub = sm.createPhotoSubmission(db, id, {
      image_url: 'images/module-b134.jpg',
      name: 'Visitor',
      email: `v-${prefix}@example.invalid`,
      message: 'hi',
    });
    const order = db
      .prepare(
        `INSERT INTO ecommerce_orders (lead_id, status, amount_cents, currency, product_name, customer_email, stripe_key_source)
         VALUES (?, 'pending', 4200, 'USD', ?, ?, 'lead')`
      )
      .run(id, `${name} Fern`, `buyer-${prefix}@example.invalid`);
    db.prepare(
      `INSERT INTO ecommerce_order_items (order_id, lead_id, product_id, product_name, quantity, unit_price_cents, line_total_cents, currency, source_module)
       VALUES (?, ?, ?, ?, 1, 4200, 4200, 'USD', 'ecommerce')`
    ).run(Number(order.lastInsertRowid), id, prod.id, `${name} Fern`);
    share.setSharedRef(db, id, {
      consumer_type: 'newsletter',
      consumer_id: 1,
      provider_type: 'ecommerce',
      provider_id: prod.id,
      role: 'feature',
    });
    return { prod, qr, cat, sub };
  }

  /* ---- 2a: the WiFi surfaces ---- */
  {
    let n = 0;
    const seed = seedLead(LEAD_DEL, 'Delete Me Nursery', 'del');
    // Owner-side sanity: the stored code still resolves WITH its
    // payload for the owner image/download paths (fix is public-only).
    const resolved = sm.resolveQrCode(db, LEAD_DEL, seed.qr);
    assert.ok(resolved.payload.includes(WIFI_PW), 'owner resolution still carries the wifi payload');
    n++;

    const emb = sm.ensureEmbed(db, LEAD_DEL, 'qrcode', { workspaceId: WS_ID });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(emb.id);
    sm.updateQrCodeDisplay(db, LEAD_DEL, { qrcode_id: seed.qr.id }, { workspaceId: WS_ID });
    const pub = sm.publicQrCodePayload(db, LEAD_DEL, sm.getEmbedRow(db, LEAD_DEL, 'qrcode'));
    assert.ok(pub && pub.name === 'Guest WiFi', 'public payload serves the chosen wifi code');
    assert.equal(pub.payload, '', 'public embed payload carries NO wifi payload');
    assert.ok(!JSON.stringify(pub).includes(WIFI_PW), 'public embed payload contains the password nowhere');
    n += 3;

    const shared = share.readProviderItems(db, LEAD_DEL, 'qrcode');
    assert.equal(shared.length, 1, 'shared layer lists the wifi code');
    assert.ok(!JSON.stringify(shared).includes(WIFI_PW), 'shared item contains the password nowhere');
    assert.ok(shared[0].description.includes('delGuestNet'), 'shared wifi description names the network');
    n += 3;

    const qrCat = cats.createCategory(db, LEAD_DEL, { scope: 'qrcode', name: 'On tables', status: 'published' });
    cats.assignItem(db, LEAD_DEL, { consumer_type: 'qrcode', item_id: seed.qr.id, category_id: qrCat.id });
    const catItems = cats.publicCategoryItems(db, LEAD_DEL, qrCat);
    assert.equal(catItems.length, 1, 'category view lists the wifi code');
    assert.ok(!JSON.stringify(catItems).includes(WIFI_PW), 'category items contain the password nowhere');
    n += 2;

    // Non-wifi codes are untouched: their payload IS the public target.
    const link = sm.createQrCode(db, LEAD_DEL, {
      name: 'Menu link',
      target_kind: 'url',
      target_ref: 'https://menu.example.invalid/',
      status: 'published',
    });
    sm.updateQrCodeDisplay(db, LEAD_DEL, { qrcode_id: link.id }, { workspaceId: WS_ID });
    const pubLink = sm.publicQrCodePayload(db, LEAD_DEL, sm.getEmbedRow(db, LEAD_DEL, 'qrcode'));
    assert.equal(pubLink.payload, 'https://menu.example.invalid/', 'url code payload unchanged');
    n++;
    group('Part 2a wifi surfaces', n);
  }

  /* ---- 2b: deleteLead leaves nothing behind ---- */
  {
    let n = 0;
    const before = rowsFor(LEAD_DEL);
    assert.ok(Object.keys(before).length >= 10, `seed spans the window tables (${Object.keys(before).length})`);
    n++;
    leadEngine.deleteLead(db, LEAD_DEL);
    const after = rowsFor(LEAD_DEL);
    assert.deepEqual(after, {}, `deleteLead orphan inventory is empty (got ${JSON.stringify(after)})`);
    n++;
    group('Part 2b deleteLead cascade', n);
  }

  /* ---- 2c: mergeLeads moves the whole window surface ---- */
  let keepSeed;
  {
    let n = 0;
    keepSeed = seedLead(LEAD_KEEP, 'Keeper Nursery', 'keep', { fernSlug: 'fern' });
    const dropSeed = seedLead(LEAD_DROP, 'Drop Nursery', 'drop', { fernSlug: 'fern' });
    // A product only the dropped lead has — must move whole, variants
    // included — assigned to the dropped lead's (clashing) category.
    const solo = sm.createProduct(db, LEAD_DROP, {
      name: 'Solo Cactus',
      slug: 'solo-cactus',
      price_cents: 1500,
      status: 'published',
      options: [{ name: 'Size', values: ['S', 'L'] }],
      variants: [
        { values: ['S'], price_cents: 1500, sku: 'SOLO-S', available: 1 },
        { values: ['L'], price_cents: 2100, sku: 'SOLO-L', available: 1 },
      ],
    });
    cats.assignItem(db, LEAD_DROP, { consumer_type: 'ecommerce', item_id: solo.id, category_id: dropSeed.cat.id });
    // Keeper gives up its photo config so the singleton MOVE (not the
    // keeper-wins delete) is what the merge must do for it.
    db.prepare('DELETE FROM photocapture_configs WHERE lead_id = ?').run(LEAD_KEEP);
    // Keeper's wifi code joins a qrcode-scope category (Part 3 reads it
    // back over HTTP after the merge).
    const lobby = cats.createCategory(db, LEAD_KEEP, { scope: 'qrcode', name: 'Lobby', status: 'published' });
    cats.assignItem(db, LEAD_KEEP, { consumer_type: 'qrcode', item_id: keepSeed.qr.id, category_id: lobby.id });

    leadEngine.mergeLeads(db, LEAD_KEEP, [LEAD_DROP]);

    const stranded = rowsFor(LEAD_DROP);
    assert.deepEqual(stranded, {}, `nothing stays keyed to the dropped lead (got ${JSON.stringify(stranded)})`);
    n++;

    const soloNow = sm.getProduct(db, LEAD_KEEP, solo.id);
    assert.ok(soloNow, 'solo product moved to the keeper');
    const soloVars = db
      .prepare('SELECT COUNT(*) c FROM ecommerce_product_variants WHERE lead_id = ? AND product_id = ?')
      .get(LEAD_KEEP, solo.id).c;
    assert.equal(soloVars, 2, 'solo product kept BOTH variants through the merge');
    n += 2;

    const deadTree = ['ecommerce_product_variants', 'ecommerce_product_option_values', 'ecommerce_product_options']
      .map(
        (t) =>
          db
            .prepare(`SELECT COUNT(*) c FROM ${t} WHERE lead_id = ? AND product_id NOT IN (SELECT id FROM ecommerce_products)`)
            .get(LEAD_KEEP).c
      )
      .reduce((x, y) => x + y, 0);
    assert.equal(deadTree, 0, 'slug-clash product variant tree swept (no rows point at the deleted product)');
    const keeperFernVars = db
      .prepare('SELECT COUNT(*) c FROM ecommerce_product_variants WHERE lead_id = ? AND product_id = ?')
      .get(LEAD_KEEP, keepSeed.prod.id).c;
    assert.equal(keeperFernVars, 2, "keeper's own fern variants untouched");
    n += 2;

    assert.equal(db.prepare('SELECT COUNT(*) c FROM ecommerce_orders WHERE lead_id = ?').get(LEAD_KEEP).c, 2, 'both orders under the keeper');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ecommerce_order_items WHERE lead_id = ?').get(LEAD_KEEP).c, 2, 'order LINE ITEMS moved with their orders');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM module_qrcodes WHERE lead_id = ?').get(LEAD_KEEP).c, 2, 'both QR codes moved');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM photocapture_submissions WHERE lead_id = ?').get(LEAD_KEEP).c, 2, 'both photo submissions moved');
    n += 4;

    const keeperCats = db.prepare('SELECT * FROM module_categories WHERE lead_id = ?').all(LEAD_KEEP);
    const plants = keeperCats.filter((c) => c.scope === 'ecommerce' && c.slug === 'plants');
    assert.equal(plants.length, 1, 'category clash resolved to ONE keeper Plants category');
    assert.equal(plants[0].id, keepSeed.cat.id, "the keeper's own category row is the survivor");
    const soloAssign = db
      .prepare('SELECT category_id FROM module_category_assignments WHERE lead_id = ? AND consumer_type = ? AND item_id = ?')
      .get(LEAD_KEEP, 'ecommerce', solo.id);
    assert.ok(soloAssign && soloAssign.category_id === keepSeed.cat.id, "dropped lead's assignment re-pointed at the keeper twin");
    n += 3;

    const pcCfg = db.prepare('SELECT heading FROM photocapture_configs WHERE lead_id = ?').get(LEAD_KEEP);
    assert.ok(pcCfg && pcCfg.heading === 'Drop Nursery photos', 'photocapture config MOVED when the keeper had none');
    const coCfg = db.prepare('SELECT success_message FROM checkout_configs WHERE lead_id = ?').get(LEAD_KEEP);
    assert.ok(coCfg && coCfg.success_message === 'Keeper Nursery thanks', "checkout config: keeper's own wins the singleton");
    n += 2;

    const refs = db.prepare('SELECT * FROM module_shared_refs WHERE lead_id = ?').all(LEAD_KEEP);
    assert.equal(refs.length, 1, 'shared refs deduped to one row');
    assert.equal(Number(refs[0].provider_id), keepSeed.prod.id, "keeper's shared ref wins the dedupe");
    n += 2;
    group('Part 2c mergeLeads cascade', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
  {
    let n = 0;
    const qrEmb = sm.ensureEmbed(db, LEAD_KEEP, 'qrcode', { workspaceId: WS_ID });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(qrEmb.id);
    sm.updateQrCodeDisplay(db, LEAD_KEEP, { qrcode_id: keepSeed.qr.id }, { workspaceId: WS_ID });
    const catEmb = sm.ensureEmbed(db, LEAD_KEEP, 'categories', { workspaceId: WS_ID });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(catEmb.id);

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

      const qrToken = sm.getEmbedRow(db, LEAD_KEEP, 'qrcode').public_token;
      const res = await fetch(`${BASE}/api/v1/modules/public/${qrToken}`);
      assert.equal(res.status, 200, 'anonymous qrcode embed payload serves');
      const body = await res.text();
      assert.ok(!body.includes(WIFI_PW), 'HTTP embed payload contains the wifi password NOWHERE');
      const data = JSON.parse(body);
      const block = (data.data || data).qrcode;
      assert.ok(block && block.name === 'Guest WiFi', 'wifi block still renders (name present)');
      assert.equal(block.payload, '', 'wifi block payload is empty over HTTP');
      assert.ok(block.image_url, 'wifi block still carries its image url');
      n += 5;

      const catToken = sm.getEmbedRow(db, LEAD_KEEP, 'categories').public_token;
      const res2 = await fetch(`${BASE}/api/v1/modules/public/${catToken}?slug=lobby`);
      assert.equal(res2.status, 200, 'anonymous category view serves');
      const body2 = await res2.text();
      assert.ok(!body2.includes(WIFI_PW), 'HTTP category payload contains the wifi password NOWHERE');
      const data2 = JSON.parse(body2);
      const items = (data2.data || data2).category_items || [];
      assert.equal(items.length, 1, 'category view lists the wifi code');
      assert.ok(String(items[0].description || '').includes('keepGuestNet'), 'category card describes the network by name');
      n += 4;

      const res3 = await fetch(`${BASE}/api/v1/modules/public/${qrToken}/qrcode/${keepSeed.qr.id}.png`);
      assert.equal(res3.status, 200, 'QR image route still serves (the password lives only in the image)');
      assert.match(res3.headers.get('content-type') || '', /image\/png/);
      n += 2;
      group('Part 3 HTTP anonymous surfaces', n);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }

  console.log(`\nBATCH134 ALL PASS — ${groups.length} groups: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH134 FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
