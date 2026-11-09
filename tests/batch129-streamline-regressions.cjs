'use strict';

/**
 * Batch 129 — STREAMLINE ALL (Ely: "Can we streamline all?" /
 * "so a change to the checkout module applies for all").
 *
 * The governing invariant: after 129 the Checkout module/engine is
 * the SINGLE place selling behavior lives — every selling surface
 * (shop products, gallery photos, bookings, memberships) consumes
 * it as the shared engine/config, with NO per-module forks of
 * checkout logic, session creation, totals, or webhook handling.
 *
 *   Part 1 — source pins: the unified payments config module, the
 *     DDL (lead_payment_configs, booking payment columns, the
 *     subscription origin column), both Stripe adapters delegating
 *     to it, the ONE webhook router mounted at the canonical path
 *     AND both legacy URLs (aliases), the booking payment redirect
 *     in the embed, mod32, and the platform's OWN billing webhook
 *     untouched by the streamline.
 *   Part 2 — config unification on the real modules: one save
 *     powers both surfaces; unified > legacy precedence per
 *     purpose; membership resolution NEVER reaches the workspace
 *     keys; the mode-mix refusal on BOTH surfaces (this supersedes
 *     Batch 128's "membership unaffected" expectation); blank-keeps
 *     migration of a legacy setup into the unified row on first
 *     save; one disconnect clears all three stores; cross-lead
 *     isolation; booking/subscription schema columns exist.
 *   Part 3 — stubbed-Stripe money flows incl. THE INVARIANT CHECK:
 *     cart, membership, and booking sessions are ALL built by the
 *     shared core's behavior (bitpype_purpose + bitpype_key_source
 *     stamps, the unified secret) with zero surface code touched;
 *     Buy-door and cart orders land in the identical shape; a photo
 *     still sells; a membership joins on the unified config; a
 *     pre-129 legacy subscription is left untouched by a unified
 *     save, its invoice event still verifies via the legacy secret
 *     through the unified candidate list, and its cancel tries the
 *     origin account first; a tier price minted on a legacy account
 *     self-heals onto the unified account at join; paid booking
 *     hold → pay → confirmed, hold → expire → slot released, lazy
 *     release of a lapsed hold, free booking unchanged; webhook
 *     replays are no-ops on both pipelines.
 *   Part 4 — HTTP: keys saved through the Shop payments route are
 *     visible as the unified config on the Members pane (one
 *     config, every surface) over real HTTP.
 *
 * Fixture Stripe material is fragment-assembled at runtime — no
 * credential-looking literal ever appears in this file.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch129-'));
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'app.db');
process.env.SQLITE_PATH = process.env.DB_PATH;
['.env', 'app.db', 'data.db', 'leads.db', 'platform.db'].forEach((name) => {
  process.env[name.toUpperCase().replace(/\W/g, '_') + '_PATH'] = path.join(process.env.REGRESSION_TMPDIR, name);
});
process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqlite';
process.env.APP_SECRET = ['b129', 'app', 'secret', 'batch129fixture'].join('-');
process.env.SESSION_SECRET = ['b129', 'session', 'secret', 'batch129fixture'].join('-');
process.env.COOKIE_SECURE = 'false';
// Finisher fix (AGENTS.md Batch 127 lesson): the real-server parts
// boot under the gate image's NODE_ENV=production, which refuses to
// run without Turnstile keys unless CAPTCHA_OPTIONAL=1, and requires
// APP_URL (sibling suites 125/126/127/128/132 all carry both lines).
// The builder's fixture APP_SECRET/SESSION_SECRET fragments also
// joined to under the 24-char production minimum (19 chars) — the
// MySQL gate leg's real-server boot refused them; both fixtures
// were lengthened past 24 chars by the finisher.
process.env.CAPTCHA_OPTIONAL = '1';
process.env.APP_URL = 'https://bitpype.test';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';
process.env.STRIPE_TEST_MODE = process.env.STRIPE_TEST_MODE || 'true';

const root = path.resolve(__dirname, '..');
const PORT = 39129;
const BASE = `http://127.0.0.1:${PORT}`;
const LEAD_A = 12901;
const LEAD_B = 12902;
const L_UNI = 12911;
const L_LEG = 12912;
const L_WS = 12913;
const L_NONE = 12914;
const PW = ['B129', 'Portal', 'Pass', '9'].join('-') + '!';
// Fixture Stripe material — fragment-assembled, never literals.
const SK_U1 = ['sk', 'test', 'FIXTURE129UNIFIED'].join('_');
const SK_U2 = ['sk', 'test', 'FIXTURE129SECOND'].join('_');
const SK_OLD = ['sk', 'test', 'FIXTURE129SHOPOLD'].join('_');
const SK_MOLD = ['sk', 'test', 'FIXTURE129MEMOLD'].join('_');
const SK_WS = ['sk', 'test', 'FIXTURE129WORKSPACE'].join('_');
const SK_LIVE = ['sk', 'live', 'FIXTURE129LIVE'].join('_');
const PK_TEST = ['pk', 'test', 'fixture129'].join('_');
const PK_LIVE = ['pk', 'live', 'fixture129'].join('_');
const WHSEC_U1 = ['whsec', 'fixture129unified'].join('_');
const WHSEC_U2 = ['whsec', 'fixture129second'].join('_');
const WHSEC_OLD = ['whsec', 'fixture129shopold'].join('_');
const WHSEC_MOLD = ['whsec', 'fixture129memold'].join('_');
const WHSEC_WS = ['whsec', 'fixture129workspace'].join('_');

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

/* The production-regressions load() VM harness (same as Batch 128's
 * suite): per-file mocks let the Stripe boundary be stubbed while
 * the real money code runs. */
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
  'paymentsConfig',
  'siteModules',
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

let WS_ID = null;
let db = null;

(async () => {
  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const pcSrc = read('server/paymentsConfig.js');
    assert.ok(pcSrc.includes('function saveCredentials'), 'the one write path exists');
    assert.ok(pcSrc.includes('function resolve('), 'the one resolution exists');
    assert.ok(pcSrc.includes('function webhookCandidates'), 'cross-store webhook candidates exist');
    assert.ok(pcSrc.includes('function constructEventAny'), 'unified webhook verification exists');
    assert.ok(pcSrc.includes('lead_payment_configs'), 'paymentsConfig reads the unified table');
    n += 5;

    const smSrc = read('server/siteModules.js');
    assert.ok(smSrc.includes('CREATE TABLE IF NOT EXISTS lead_payment_configs'), 'unified config DDL');
    assert.ok(smSrc.includes('ALTER TABLE bookings ADD COLUMN payment_state'), 'bookings gain payment_state');
    assert.ok(smSrc.includes('ALTER TABLE bookings ADD COLUMN payment_expires_at'), 'bookings gain the hold expiry');
    assert.ok(smSrc.includes('ALTER TABLE bookings ADD COLUMN payment_order_id'), 'bookings reference their order');
    assert.ok(
      smSrc.includes('ALTER TABLE member_subscriptions ADD COLUMN stripe_key_source'),
      'subscriptions record their origin layer'
    );
    // Batch 145 (external review F07): the hold window STAYS 30
    // minutes per Ely's ruling (2026-11-05 — a 60-minute variant
    // was built and reverted before deploy). Stripe's 30-minute
    // minimum session lifetime makes a 30-minute hold unpinnable
    // to its checkout session (the Batch 143 pin never engaged);
    // the session is capped at the earliest Stripe-permissible
    // expiry instead and the refund backstop covers late payment.
    assert.ok(smSrc.includes('BOOKING_PAYMENT_HOLD_MINUTES = 30'), 'the booking hold window is 30 minutes');
    assert.ok(
      smSrc.includes('async function createPublicBookingByToken'),
      'the booking token flow is async (it creates a checkout session)'
    );
    assert.ok(smSrc.includes('function applyTenantStripeEvent'), 'the ONE tenant-event dispatcher exists');
    assert.ok(smSrc.includes('function releaseExpiredBookingHolds'), 'the lazy hold sweep exists');
    assert.ok(smSrc.includes("bitpype_purpose: 'shop'"), 'shop sessions carry the shared purpose stamp');
    assert.ok(smSrc.includes("bitpype_purpose: 'membership'"), 'membership sessions carry the shared purpose stamp');
    assert.ok(smSrc.includes("const MODULE_SCRIPT_VER = 'mod41'"), 'MODULE_SCRIPT_VER bumped to mod32');
    n += 12;

    const ssSrc = read('server/shopStripe.js');
    assert.ok(ssSrc.includes("require('./paymentsConfig')"), 'shopStripe is an adapter over paymentsConfig');
    const msSrc = read('server/membershipStripe.js');
    assert.ok(msSrc.includes("require('./paymentsConfig')"), 'membershipStripe is an adapter over paymentsConfig');
    assert.ok(msSrc.includes('sub.stripe_key_source'), 'membership cancel is origin-aware');
    n += 3;

    const whSrc = read('server/routes/paymentsWebhook.js');
    assert.ok(whSrc.includes('applyTenantStripeEvent'), 'the unified webhook applies through the one dispatcher');
    assert.ok(whSrc.includes('constructEventAny'), 'the unified webhook verifies against every configured secret');
    const shopWhSrc = read('server/routes/shopWebhook.js');
    assert.ok(
      shopWhSrc.includes("require('./paymentsWebhook')"),
      'the legacy shop webhook URL is an alias of the one handler'
    );
    const memWhSrc = read('server/routes/membershipWebhook.js');
    assert.ok(
      memWhSrc.includes("require('./paymentsWebhook')"),
      'the legacy membership webhook URL is an alias of the one handler'
    );
    const serverSrc = read('server.js');
    assert.ok(serverSrc.includes("'/api/v1/payments/webhook'"), 'the canonical payments webhook is mounted');
    n += 5;

    const billingWhSrc = read('server/routes/stripeWebhook.js');
    assert.ok(
      !billingWhSrc.includes('paymentsConfig'),
      "the PLATFORM's own billing webhook is NOT part of the streamline"
    );
    assert.ok(
      !billingWhSrc.includes('applyTenantStripeEvent'),
      'the platform billing webhook never touches tenant events'
    );
    n += 2;

    const embedSrc = read('public/js/module-embed.js');
    assert.ok(
      embedSrc.includes('return_url: window.location.href'),
      'the booking embed sends a return URL (pay-at-booking can start)'
    );
    assert.ok(embedSrc.includes('j.data.payment.url'), 'the booking embed hands the visitor to the shared checkout');
    assert.ok(embedSrc.includes('Confirming your payment'), 'the booking embed confirms the payment return');
    n += 3;

    const pubSrc = read('server/routes/modulesPublic.js');
    assert.ok(pubSrc.includes('await domain.withDb'), 'the /book route awaits the async booking flow');
    n++;
    group('Part 1 source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — config unification (in-process, real modules)              */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const pc = require(path.join(root, 'server/paymentsConfig.js'));
  const realBox = require(path.join(root, 'src/secretBox.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a129@example.invalid',
    password: PW,
    name: 'A129',
    workspaceName: 'Batch129 WS',
  });
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'a129@example.invalid' });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name] of [
    [LEAD_A, 'B129 Alpha'],
    [LEAD_B, 'B129 Beta'],
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
  const seedLegacy = (table, leadId, pk, sk, wh) => {
    db.prepare(
      `INSERT INTO ${table} (lead_id, publishable_key, secret_key_enc, webhook_secret_enc, secret_key_last4)
       VALUES (?, ?, ?, ?, ?)`
    ).run(leadId, pk, realBox.encryptValue(sk), realBox.encryptValue(wh), sk.slice(-4));
  };

  {
    let n = 0;
    // Schema: the unified table + the new columns exist.
    const bookingCols = db
      .prepare('PRAGMA table_info(bookings)')
      .all()
      .map((c) => c.name);
    assert.ok(
      bookingCols.includes('payment_state') &&
        bookingCols.includes('payment_expires_at') &&
        bookingCols.includes('payment_order_id'),
      'bookings carry the payment link columns'
    );
    const subCols = db
      .prepare('PRAGMA table_info(member_subscriptions)')
      .all()
      .map((c) => c.name);
    assert.ok(subCols.includes('stripe_key_source'), 'member_subscriptions records the origin layer');
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lead_payment_configs'").get(),
      'lead_payment_configs exists'
    );
    n += 3;

    // ONE save powers BOTH surfaces.
    const savedShop = sm.saveShopStripeKeys(db, LEAD_A, {
      publishable_key: PK_TEST,
      secret_key: SK_U1,
      webhook_secret: WHSEC_U1,
    });
    assert.equal(savedShop.connected, true);
    assert.equal(savedShop.source, 'unified', 'the shop save reports the unified layer');
    const memStatus = sm.membershipStripeStatus(db, LEAD_A);
    assert.equal(memStatus.connected, true, 'a SHOP save connects memberships too — one config');
    assert.equal(memStatus.source, 'unified');
    assert.equal(memStatus.mode, 'test', 'membership status gains the mode (additive)');
    n += 5;
    // …and the reverse direction on the other lead.
    sm.saveMembershipStripeKeys(db, LEAD_B, { publishable_key: PK_TEST, secret_key: SK_U2, webhook_secret: WHSEC_U2 });
    const shopStatusB = sm.shopStripeStatus(db, LEAD_B);
    assert.equal(shopStatusB.connected, true, 'a MEMBERSHIP save connects the shop too — one config');
    assert.equal(shopStatusB.source, 'unified');
    n += 2;

    // Mode-mix refusal on BOTH surfaces, writing nothing.
    assert.throws(
      () => sm.saveShopStripeKeys(db, LEAD_A, { publishable_key: PK_LIVE, secret_key: SK_U1 }),
      (e) => e.code === 'VALIDATION' && /same Stripe mode/.test(e.message),
      'shop surface refuses a mixed-mode save'
    );
    assert.throws(
      () => sm.saveMembershipStripeKeys(db, LEAD_A, { publishable_key: PK_TEST, secret_key: SK_LIVE }),
      (e) => e.code === 'VALIDATION' && /same Stripe mode/.test(e.message),
      'membership surface refuses a mixed-mode save (Batch 129 discipline)'
    );
    assert.equal(pc.getUnifiedCredentials(db, LEAD_A).secretKey, SK_U1, 'refused saves wrote nothing');
    n += 3;

    // Precedence: divergent legacy rows lose to the unified row, per purpose.
    seedLegacy('shop_stripe_keys', LEAD_A, PK_TEST, SK_OLD, WHSEC_OLD);
    seedLegacy('membership_stripe_keys', LEAD_A, PK_TEST, SK_MOLD, WHSEC_MOLD);
    assert.equal(pc.resolve(db, LEAD_A, 'shop').source, 'unified', 'shop resolution prefers the unified row');
    assert.equal(pc.resolve(db, LEAD_A, 'shop').secretKey, SK_U1);
    assert.equal(
      pc.resolve(db, LEAD_A, 'membership').secretKey,
      SK_U1,
      'membership resolution prefers the unified row'
    );
    n += 3;

    // Membership NEVER resolves to the workspace keys; the shop does.
    const setSetting = (key, value) =>
      db
        .prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        )
        .run(key, value);
    setSetting('shop.stripe.secret_key', realBox.encryptSetting('shop.stripe.secret_key', SK_WS));
    setSetting('shop.stripe.publishable_key', realBox.encryptSetting('shop.stripe.publishable_key', PK_TEST));
    setSetting('shop.stripe.webhook_secret', realBox.encryptSetting('shop.stripe.webhook_secret', WHSEC_WS));
    const L2 = 12903;
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      L2,
      'B129 WsOnly',
      `lead${L2}@example.invalid`,
      'customer'
    );
    assert.equal(pc.resolve(db, L2, 'shop').source, 'workspace', 'shop falls back to the workspace keys');
    assert.equal(pc.resolve(db, L2, 'membership'), null, 'membership resolution NEVER reaches the workspace account');
    n += 2;

    // Blank-keeps migration: a legacy-only lead's first save carries
    // its working config into the unified row.
    const L3 = 12904;
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      L3,
      'B129 Legacy',
      `lead${L3}@example.invalid`,
      'customer'
    );
    seedLegacy('shop_stripe_keys', L3, PK_TEST, SK_OLD, WHSEC_OLD);
    const migrated = sm.saveShopStripeKeys(db, L3, { webhook_secret: WHSEC_U2 });
    assert.equal(migrated.source, 'unified', 'the first save writes the unified row');
    assert.equal(migrated.secret_key_last4, SK_OLD.slice(-4), 'the legacy secret carried over (blank keeps stored)');
    const migratedCreds = pc.getUnifiedCredentials(db, L3);
    assert.equal(migratedCreds.secretKey, SK_OLD, 'the unified row holds the migrated secret');
    assert.equal(migratedCreds.webhookSecret, WHSEC_U2, 'the newly supplied field wins');
    n += 4;

    // Disconnect is ONE action: all three stores clear.
    sm.clearMembershipStripeKeys(db, LEAD_A);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM lead_payment_configs WHERE lead_id = ?').get(LEAD_A).c,
      0,
      'unified row cleared'
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM shop_stripe_keys WHERE lead_id = ?').get(LEAD_A).c,
      0,
      'shop legacy row cleared'
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM membership_stripe_keys WHERE lead_id = ?').get(LEAD_A).c,
      0,
      'membership legacy row cleared'
    );
    assert.equal(sm.shopStripeStatus(db, LEAD_A).connected, false, 'shop reads disconnected');
    assert.equal(sm.membershipStripeStatus(db, LEAD_A).connected, false, 'memberships read disconnected');
    n += 5;

    // Cross-lead isolation on the unified config.
    assert.equal(
      sm.shopStripeStatus(db, LEAD_B).connected,
      true,
      "lead B's config is untouched by lead A's disconnect"
    );
    assert.equal(pc.resolve(db, LEAD_B, 'shop').secretKey, SK_U2);
    n += 2;
    group('Part 2 config unification', n);
  }

  /* ================================================================== */
  /* Part 3 — money flows against a stubbed Stripe boundary              */
  /* ================================================================== */
  {
    let n = 0;
    const crypto129 = require('node:crypto');
    const boxKey129 = crypto129.randomBytes(32);
    const box129 = {
      PREFIX: 'enc:v1:',
      hasKey: () => true,
      isEncrypted: (v) => typeof v === 'string' && v.startsWith('enc:v1:'),
      encryptValue(plain) {
        if (plain == null || plain === '' || box129.isEncrypted(plain)) return plain;
        const iv = crypto129.randomBytes(12);
        const cipher = crypto129.createCipheriv('aes-256-gcm', boxKey129, iv);
        const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
        return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
      },
      decryptValue(stored) {
        if (!box129.isEncrypted(stored)) return stored;
        const buf = Buffer.from(stored.slice('enc:v1:'.length), 'base64');
        const decipher = crypto129.createDecipheriv('aes-256-gcm', boxKey129, buf.subarray(0, 12));
        decipher.setAuthTag(buf.subarray(12, 28));
        return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
      },
      encryptSetting: (k, v) => box129.encryptValue(v),
      decryptSetting: (k, v) => box129.decryptValue(v),
    };
    // Stub Stripe: clients remember WHICH secret built them; prices
    // and products exist only on the account (secret) that created
    // them, so an account switch is observable, not assumed.
    const stub = {
      sessions: [],
      subUpdates: [],
      failSubSecrets: new Set(),
      pricesBySecret: new Map(),
      productsBySecret: new Map(),
      priceSeq: 0,
      productSeq: 0,
    };
    const registerFor = (map, secret, id) => {
      if (!map.has(secret)) map.set(secret, new Set());
      map.get(secret).add(id);
    };
    function StubStripe129(secretKey) {
      return {
        __secret: secretKey,
        checkout: {
          sessions: {
            create: async (params) => {
              stub.sessions.push({ secret: secretKey, params });
              return {
                id: 'cs_test_129_' + stub.sessions.length,
                url: 'https://checkout.stripe.test/cs129/' + stub.sessions.length,
              };
            },
          },
        },
        products: {
          create: async (params) => {
            const id = 'prod_129_' + ++stub.productSeq;
            registerFor(stub.productsBySecret, secretKey, id);
            return { id };
          },
          retrieve: async (id) => {
            if (!stub.productsBySecret.get(secretKey)?.has(id)) throw new Error('No such product (stub)');
            return { id };
          },
        },
        prices: {
          create: async (params) => {
            const id = 'price_129_' + ++stub.priceSeq;
            registerFor(stub.pricesBySecret, secretKey, id);
            return { id };
          },
          retrieve: async (id) => {
            if (!stub.pricesBySecret.get(secretKey)?.has(id)) throw new Error('No such price (stub)');
            return { id };
          },
        },
        subscriptions: {
          update: async (id, params) => {
            stub.subUpdates.push({ secret: secretKey, id, params });
            if (stub.failSubSecrets.has(secretKey))
              throw new Error('Subscription update failed on this account (stub)');
            return { id };
          },
        },
        webhooks: {
          constructEvent: (body, sig, secret) => {
            if (sig !== 'sig:' + secret)
              throw new Error('No signatures found matching the expected signature for payload.');
            return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
          },
        },
        accounts: { retrieve: async () => ({ id: 'acct_stub129', charges_enabled: true, payouts_enabled: true }) },
        balance: { retrieve: async () => ({ available: [], pending: [] }) },
      };
    }
    const mocksSM = {
      '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
      '../src/websiteEngine': require(path.join(root, 'src/websiteEngine.js')),
      './portalContacts': require(path.join(root, 'server/portalContacts.js')),
      '../src/secretBox': box129,
      './paymentsConfig': null, // filled below, before any money call
      './membershipStripe': null,
      './shopStripe': null,
    };
    const sm129 = load('server/siteModules.js', mocksSM);
    const pc129 = load('server/paymentsConfig.js', {
      stripe: StubStripe129,
      '../src/secretBox': box129,
      './siteModules': sm129,
    });
    mocksSM['./paymentsConfig'] = pc129;
    const ss129 = load('server/shopStripe.js', {
      stripe: StubStripe129,
      '../src/secretBox': box129,
      './siteModules': sm129,
      './paymentsConfig': pc129,
    });
    const ms129 = load('server/membershipStripe.js', {
      stripe: StubStripe129,
      '../src/secretBox': box129,
      './siteModules': sm129,
      './paymentsConfig': pc129,
    });
    mocksSM['./shopStripe'] = ss129;
    mocksSM['./membershipStripe'] = ms129;
    sm129.ensureTables(db);

    for (const [id, name] of [
      [L_UNI, 'B129 Unified Biz'],
      [L_LEG, 'B129 Legacy Biz'],
      [L_WS, 'B129 Workspace Biz'],
      [L_NONE, 'B129 No Keys Biz'],
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
    const attach129 = (leadId, type) =>
      sm129.attachModule(db, leadId, type, { workspaceId: WS_ID, appUrl: 'https://example.test' });
    const token129 = (leadId, type) => sm129.getEmbedRow(db, leadId, type).public_token;
    const lastSession = () => stub.sessions[stub.sessions.length - 1];

    /* ---- L_UNI: everything on the unified config ---- */
    attach129(L_UNI, 'ecommerce');
    attach129(L_UNI, 'checkout');
    attach129(L_UNI, 'gallery');
    attach129(L_UNI, 'members');
    attach129(L_UNI, 'bookings');
    sm129.saveShopStripeKeys(db, L_UNI, { publishable_key: PK_TEST, secret_key: SK_U1, webhook_secret: WHSEC_U1 });
    const mugU = sm129.createProduct(db, L_UNI, { name: 'Unified Mug', price_cents: 2500, status: 'published' });
    const albumU = sm129.createAlbum(db, L_UNI, {
      title: 'Unified Prints',
      status: 'published',
      images: [{ image_url: 'https://img.example/uni-print.jpg', caption: 'Uni Print', price_cents: 4000 }],
    });
    const photoU = albumU.images[0];

    // Cart (product + photo) through the shared core.
    const cart = await sm129.createCartCheckoutByToken(
      db,
      token129(L_UNI, 'checkout'),
      {
        items: [
          { source: 'ecommerce', itemId: mugU.id, quantity: 1 },
          { source: 'gallery', itemId: photoU.id, quantity: 1 },
        ],
        returnUrl: 'https://fixture.test/checkout',
      },
      {}
    );
    const cartSession = lastSession();
    assert.equal(cartSession.secret, SK_U1, 'cart ran on the unified secret');
    assert.equal(cartSession.params.metadata.bitpype_purpose, 'shop', 'cart session carries the shared purpose stamp');
    assert.equal(
      cartSession.params.metadata.bitpype_key_source,
      'unified',
      'cart session carries the shared key-source stamp'
    );
    const cartOrder = sm129.listShopOrdersWithItems(db, L_UNI).find((o) => o.id === cart.orderId);
    assert.equal(cartOrder.stripe_key_source, 'unified');
    assert.equal(cartOrder.items.length, 2, 'cart order records both lines');
    n += 5;

    // Buy door: the same engine, exactly one line, the same order shape.
    const single = await sm129.createShopCheckoutByToken(
      db,
      token129(L_UNI, 'ecommerce'),
      { productId: mugU.id, returnUrl: 'https://fixture.test/shop' },
      {}
    );
    const singleOrder = sm129.listShopOrdersWithItems(db, L_UNI).find((o) => o.id === single.orderId);
    assert.equal(singleOrder.items.length, 1, 'the Buy door records exactly one line');
    assert.deepEqual(
      Object.keys(singleOrder).sort(),
      Object.keys(cartOrder).sort(),
      'Buy-door and cart orders land in the IDENTICAL order shape (one engine, one order model)'
    );
    assert.deepEqual(
      Object.keys(singleOrder.items[0]).sort(),
      Object.keys(cartOrder.items[0]).sort(),
      'their line items share the identical shape too'
    );
    n += 3;

    // Membership join on the unified config.
    const tierSave = await ms129.saveMembershipTier(db, L_UNI, {
      name: 'Gold',
      price: 15,
      interval: 'month',
      active: true,
    });
    assert.equal(tierSave.stripe_state, 'connected', 'tier saved against the unified config');
    const memberU = sm129.signupMember(db, L_UNI, {
      name: 'Uni Member',
      email: 'uni@example.invalid',
      password: 'password123',
    });
    const memCheckout = await sm129.createMembershipCheckoutByToken(
      db,
      token129(L_UNI, 'members'),
      { tierId: tierSave.tier.id, returnUrl: 'https://fixture.test/members' },
      { memberSession: memberU.session.token }
    );
    const memSession = lastSession();
    assert.equal(memSession.secret, SK_U1, 'membership checkout ran on the SAME unified secret');
    assert.equal(memSession.params.mode, 'subscription');
    assert.equal(
      memSession.params.metadata.bitpype_purpose,
      'membership',
      'membership session carries the shared purpose stamp'
    );
    assert.equal(memSession.params.metadata.bitpype_key_source, 'unified');
    n += 5;

    // Its webhook lands through the unified verification + dispatcher.
    const memEventBody = JSON.stringify({
      id: 'evt_129_mem',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_129_mem',
          customer: 'cus_129_uni',
          subscription: 'sub_129_uni',
          payment_status: 'paid',
          metadata: memSession.params.metadata,
        },
      },
    });
    const verifiedMem = pc129.constructEventAny(db, L_UNI, memEventBody, 'sig:' + WHSEC_U1);
    assert.equal(verifiedMem.source, 'unified', 'membership event verified against the unified secret');
    const appliedMem = sm129.applyTenantStripeEvent(db, verifiedMem.event);
    assert.equal(appliedMem.pipeline, 'membership', 'the dispatcher routes member checkouts to the membership apply');
    const subU = sm129.listMemberSubscriptions(db, L_UNI, { memberId: memberU.member.id })[0];
    assert.equal(subU.status, 'active');
    assert.equal(subU.stripe_key_source, 'unified', 'the subscription records its origin layer');
    const appliedMemReplay = sm129.applyTenantStripeEvent(db, verifiedMem.event);
    assert.equal(appliedMemReplay.matched, true);
    assert.equal(
      sm129.listMemberSubscriptions(db, L_UNI, { memberId: memberU.member.id }).length,
      1,
      'replaying the membership event creates no second subscription'
    );
    n += 6;

    /* ---- Paid bookings on L_UNI (auto_confirm on) ---- */
    sm129.updateBookingSettings(db, L_UNI, { auto_confirm: true });
    const svcPaid = sm129.createBookingService(db, L_UNI, {
      name: 'Deep Clean',
      price_cents: 7500,
      duration_minutes: 60,
      status: 'published',
    });
    const svcFree = sm129.createBookingService(db, L_UNI, {
      name: 'Intro Call',
      price_cents: 0,
      duration_minutes: 30,
      status: 'published',
    });
    const day = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    db.prepare('INSERT INTO booking_hours (lead_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)').run(
      L_UNI,
      day.getDay(),
      '08:00',
      '20:00'
    );
    const bookAt = (svc, time) =>
      sm129.createPublicBookingByToken(
        db,
        token129(L_UNI, 'bookings'),
        {
          service_id: svc.id,
          starts_at: `${ymd}T${time}:00`,
          customer_name: 'Booker Bee',
          customer_email: 'booker@example.invalid',
          return_url: 'https://fixture.test/book',
        },
        {}
      );
    const slotFree = (svc, time) =>
      (sm129.listAvailableSlots(db, L_UNI, { date: ymd, serviceId: svc.id }).slots || []).some(
        (s) => s.starts_at === `${ymd}T${time}:00`
      );

    const held = await bookAt(svcPaid, '10:00');
    assert.ok(
      held.payment && held.payment.required === true && held.payment.url,
      'a priced booking answers with a checkout URL'
    );
    const heldRow = db.prepare('SELECT * FROM bookings WHERE id = ?').get(held.appointment.id);
    assert.equal(heldRow.payment_state, 'hold', 'the appointment starts as a payment hold');
    assert.equal(
      heldRow.status,
      'pending',
      'a hold is pending until the money lands (auto_confirm applies at payment)'
    );
    assert.ok(heldRow.payment_order_id > 0, 'the appointment references its order');
    assert.equal(slotFree(svcPaid, '10:00'), false, 'the held slot is unavailable to everyone else');
    const bookingSession = lastSession();
    assert.equal(bookingSession.secret, SK_U1, 'the booking checkout ran on the unified secret');
    assert.equal(bookingSession.params.metadata.bitpype_purpose, 'shop');
    assert.equal(bookingSession.params.metadata.bitpype_key_source, 'unified');
    const bookingOrder = sm129.listShopOrdersWithItems(db, L_UNI).find((o) => o.id === heldRow.payment_order_id);
    assert.equal(bookingOrder.items.length, 1);
    assert.equal(bookingOrder.items[0].source_module, 'bookings', 'the order line is the appointment itself');
    assert.equal(
      JSON.parse(bookingOrder.items[0].source_meta).appointment_id,
      held.appointment.id,
      'order and appointment reference each other'
    );
    n += 11;

    // Payment lands → hold settles, appointment confirms.
    const bookPaidEvent = {
      id: 'evt_129_book_paid',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: bookingOrder.stripe_session_id,
          payment_status: 'paid',
          payment_intent: 'pi_129_book',
          customer_details: { email: 'booker@example.invalid' },
          metadata: bookingSession.params.metadata,
        },
      },
    };
    const appliedBook = sm129.applyTenantStripeEvent(db, bookPaidEvent);
    assert.equal(appliedBook.pipeline, 'shop', 'a booking payment is a shop-pipeline order');
    const paidRow = db.prepare('SELECT * FROM bookings WHERE id = ?').get(held.appointment.id);
    assert.equal(paidRow.payment_state, 'paid');
    assert.equal(paidRow.status, 'confirmed', 'payment confirms the appointment (auto_confirm business)');
    const appliedBookReplay = sm129.applyTenantStripeEvent(db, bookPaidEvent);
    assert.equal(appliedBookReplay.status, 'paid');
    const paidRowReplay = db.prepare('SELECT * FROM bookings WHERE id = ?').get(held.appointment.id);
    assert.equal(paidRowReplay.payment_state, 'paid', 'replaying the paid event is a no-op on the appointment');
    n += 5;

    // Expiry: the checkout dies → the hold releases, the slot frees.
    const held2 = await bookAt(svcPaid, '11:00');
    const order2 = sm129.listShopOrdersWithItems(db, L_UNI).find((o) => o.id === held2.payment.order_id);
    assert.equal(slotFree(svcPaid, '11:00'), false);
    sm129.applyTenantStripeEvent(db, {
      id: 'evt_129_book_exp',
      type: 'checkout.session.expired',
      data: {
        object: {
          id: order2.stripe_session_id,
          metadata: { bitpype_order_id: String(order2.id), bitpype_lead_id: String(L_UNI) },
        },
      },
    });
    const expRow = db.prepare('SELECT * FROM bookings WHERE id = ?').get(held2.appointment.id);
    assert.equal(expRow.payment_state, 'released', 'an expired checkout releases the hold');
    assert.equal(expRow.status, 'cancelled');
    assert.equal(slotFree(svcPaid, '11:00'), true, 'the released slot is bookable again');
    n += 4;

    // Lazy release: a hold that simply lapses frees its slot on read.
    const held3 = await bookAt(svcPaid, '12:00');
    db.prepare("UPDATE bookings SET payment_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(
      held3.appointment.id
    );
    assert.equal(slotFree(svcPaid, '12:00'), true, 'a lapsed hold no longer blocks the slot');
    const lazyRow = db.prepare('SELECT * FROM bookings WHERE id = ?').get(held3.appointment.id);
    assert.equal(lazyRow.payment_state, 'released', 'the sweep flipped the lapsed hold');
    assert.equal(lazyRow.status, 'cancelled');
    n += 3;

    // Free booking: today's flow, untouched.
    const freeBooking = await bookAt(svcFree, '13:00');
    assert.equal(freeBooking.payment, undefined, 'a free booking never mentions payment');
    const freeRow = db.prepare('SELECT * FROM bookings WHERE id = ?').get(freeBooking.appointment.id);
    assert.equal(freeRow.payment_state, '', 'a free booking carries no payment state');
    assert.equal(freeRow.status, 'confirmed', 'a free booking follows auto_confirm exactly as before');
    n += 3;

    /* ---- THE INVARIANT: one shared-core behavior, three surfaces ----
     * Every checkout session created above — cart, Buy door,
     * membership, booking — was built by the shared core, so ALL of
     * them carry the purpose + key-source stamps and ALL ran on the
     * one unified secret, with zero per-surface code. */
    const stampedSurfaces = new Set();
    for (const s of stub.sessions) {
      if (s.secret !== SK_U1) continue;
      assert.equal(
        s.params.metadata.bitpype_key_source,
        'unified',
        'every unified session is stamped by the shared core'
      );
      assert.ok(s.params.metadata.bitpype_purpose, 'every unified session carries its purpose stamp');
      stampedSurfaces.add(
        s.params.mode === 'subscription' ? 'membership' : s.params.metadata.bitpype_order_id ? 'shop/bookings' : 'shop'
      );
    }
    assert.ok(stub.sessions.length >= 4, 'cart + buy + membership + booking sessions all exist');
    assert.ok(
      stampedSurfaces.has('membership') && stampedSurfaces.has('shop/bookings'),
      'the shared stamp is observable on multiple selling surfaces'
    );
    n += 3;

    /* ---- L_LEG: pre-129 legacy setup keeps working ---- */
    attach129(L_LEG, 'ecommerce');
    attach129(L_LEG, 'members');
    const seedLegacyStub = (table, leadId, sk, wh) => {
      db.prepare(
        `INSERT INTO ${table} (lead_id, publishable_key, secret_key_enc, webhook_secret_enc, secret_key_last4) VALUES (?, ?, ?, ?, ?)`
      ).run(leadId, PK_TEST, box129.encryptValue(sk), box129.encryptValue(wh), sk.slice(-4));
    };
    seedLegacyStub('shop_stripe_keys', L_LEG, SK_OLD, WHSEC_OLD);
    seedLegacyStub('membership_stripe_keys', L_LEG, SK_MOLD, WHSEC_MOLD);
    const prodL = sm129.createProduct(db, L_LEG, { name: 'Legacy Widget', price_cents: 1100, status: 'published' });
    const legacyBuy = await sm129.createShopCheckoutByToken(
      db,
      token129(L_LEG, 'ecommerce'),
      { productId: prodL.id, returnUrl: 'https://fixture.test/shop' },
      {}
    );
    assert.equal(lastSession().secret, SK_OLD, 'a legacy-only shop still checks out on its legacy keys');
    const legacyOrder = sm129.listShopOrdersWithItems(db, L_LEG).find((o) => o.id === legacyBuy.orderId);
    assert.equal(legacyOrder.stripe_key_source, 'lead', "the order truthfully records the 'lead' legacy layer");
    n += 2;

    // A pre-129 subscription: created under the membership keys, no
    // recorded origin ('' — membership by definition).
    const memberL = sm129.signupMember(db, L_LEG, {
      name: 'Legacy Member',
      email: 'legacy@example.invalid',
      password: 'password123',
    });
    const tierL = sm129.insertMembershipTier(
      db,
      L_LEG,
      { name: 'Legacy Gold', description: '', price_cents: 1500, interval: 'month', sort_order: 0 },
      { active: true }
    );
    const legacySub = sm129.upsertMemberSubscription(db, {
      lead_id: L_LEG,
      member_id: memberL.member.id,
      tier_id: tierL.id,
      stripe_customer_id: 'cus_129_leg',
      stripe_subscription_id: 'sub_129_leg',
      status: 'past_due',
    });
    assert.equal(legacySub.stripe_key_source, '', 'the pre-129 fixture records no origin layer');

    // The owner unifies (saves through the shop surface). The
    // in-flight subscription must not move.
    sm129.saveShopStripeKeys(db, L_LEG, { publishable_key: PK_TEST, secret_key: SK_U2, webhook_secret: WHSEC_U2 });
    const subAfterSave = sm129.listMemberSubscriptions(db, L_LEG, { memberId: memberL.member.id })[0];
    assert.equal(subAfterSave.id, legacySub.id, 'the unified save did not touch the existing subscription');
    assert.equal(subAfterSave.status, 'past_due');
    assert.equal(subAfterSave.stripe_key_source, '', 'its origin record is unchanged');
    n += 4;

    // Its invoice event still verifies — via the LEGACY membership
    // secret, through the unified candidate list — and applies.
    const invoiceBody = JSON.stringify({
      id: 'evt_129_inv',
      type: 'invoice.paid',
      data: { object: { id: 'in_129_leg', subscription: 'sub_129_leg', customer: 'cus_129_leg', metadata: {} } },
    });
    const verifiedInv = pc129.constructEventAny(db, L_LEG, invoiceBody, 'sig:' + WHSEC_MOLD);
    assert.equal(verifiedInv.source, 'membership', "the retired store's secret still verifies its own events");
    const appliedInv = sm129.applyTenantStripeEvent(db, verifiedInv.event);
    assert.equal(appliedInv.pipeline, 'membership');
    assert.equal(
      sm129.listMemberSubscriptions(db, L_LEG, { memberId: memberL.member.id })[0].status,
      'active',
      'invoice.paid revived the legacy subscription'
    );
    n += 3;

    // A shop event signed with the OLD shop secret also still verifies.
    const legacyShopBody = JSON.stringify({
      id: 'evt_129_oldshop',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: legacyOrder.stripe_session_id,
          payment_status: 'paid',
          payment_intent: 'pi_129_leg',
          customer_details: { email: 'legbuyer@example.invalid' },
          metadata: { bitpype_order_id: String(legacyOrder.id), bitpype_lead_id: String(L_LEG) },
        },
      },
    });
    const verifiedOld = pc129.constructEventAny(db, L_LEG, legacyShopBody, 'sig:' + WHSEC_OLD);
    assert.equal(verifiedOld.source, 'lead', 'the legacy shop secret remains a verification candidate');
    assert.equal(sm129.applyTenantStripeEvent(db, verifiedOld.event).status, 'paid');
    n += 2;

    // Tier-price account safety: a tier priced on the LEGACY account
    // self-heals onto the unified account at join time.
    const tierHealSave = await ms129.saveMembershipTier(db, L_LEG, {
      name: 'Heal Tier',
      price: 20,
      interval: 'month',
      active: true,
    });
    // ^ saved while the unified config already exists → priced on SK_U2.
    assert.ok(tierHealSave.tier.stripe_price_id, 'tier carries a price');
    // Simulate the pre-unification state: point the tier at a price
    // that exists only on the legacy account.
    const legacyPriceId = 'price_129_legacyminted';
    registerFor(stub.pricesBySecret, SK_MOLD, legacyPriceId);
    db.prepare('UPDATE membership_tiers SET stripe_price_id = ? WHERE id = ?').run(legacyPriceId, tierHealSave.tier.id);
    const memberL2 = sm129.signupMember(db, L_LEG, {
      name: 'Heal Member',
      email: 'heal@example.invalid',
      password: 'password123',
    });
    const healCheckout = await sm129.createMembershipCheckoutByToken(
      db,
      token129(L_LEG, 'members'),
      { tierId: tierHealSave.tier.id, returnUrl: 'https://fixture.test/members' },
      { memberSession: memberL2.session.token }
    );
    const healSession = lastSession();
    assert.equal(healSession.secret, SK_U2, 'the new join runs on the unified account');
    assert.notEqual(
      healSession.params.line_items[0].price,
      legacyPriceId,
      'the join did NOT use the price from the other account'
    );
    const healedTier = sm129.getMembershipTier(db, L_LEG, tierHealSave.tier.id);
    assert.equal(
      healedTier.stripe_price_id,
      healSession.params.line_items[0].price,
      'the tier row now points at the unified-account price'
    );
    n += 4;

    // Origin-aware cancel: the legacy subscription cancels on its
    // ORIGIN account first; when that account rejects, the unified
    // account is tried — never a silent wrong-account cancel.
    stub.failSubSecrets.add(SK_MOLD);
    const updatesBefore = stub.subUpdates.length;
    const cancelRes = await ms129.cancelMemberSubscription(db, L_LEG, memberL.member.id);
    assert.equal(cancelRes.stripe_called, true);
    const attempts = stub.subUpdates.slice(updatesBefore);
    assert.equal(attempts.length, 2, 'cancel tried the origin account, then the unified account');
    assert.equal(
      attempts[0].secret,
      SK_MOLD,
      'the ORIGIN (membership legacy) account is tried first for a pre-129 subscription'
    );
    assert.equal(attempts[1].secret, SK_U2, 'the unified account is the fallback');
    stub.failSubSecrets.delete(SK_MOLD);
    n += 4;

    /* ---- Workspace-only + no-keys leads ---- */
    db.prepare(
      "DELETE FROM settings WHERE key IN ('shop.stripe.secret_key', 'shop.stripe.publishable_key', 'shop.stripe.webhook_secret')"
    ).run();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'shop.stripe.secret_key',
      box129.encryptSetting('shop.stripe.secret_key', SK_WS)
    );
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'shop.stripe.publishable_key',
      box129.encryptSetting('shop.stripe.publishable_key', PK_TEST)
    );
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'shop.stripe.webhook_secret',
      box129.encryptSetting('shop.stripe.webhook_secret', WHSEC_WS)
    );
    assert.equal(pc129.resolve(db, L_WS, 'shop').source, 'workspace', 'shop resolution reaches the workspace layer');
    assert.equal(pc129.resolve(db, L_WS, 'membership'), null, 'membership resolution stops at the lead layers');
    assert.equal(pc129.resolve(db, L_NONE, 'membership'), null, 'a keyless lead has no membership resolution');
    assert.equal(
      ss129.isConfiguredForLead(db, L_NONE),
      true,
      'the shop can still run on the workspace fallback (unchanged semantics)'
    );
    assert.equal(ms129.isConnected(db, L_NONE), false, 'memberships cannot run on the workspace account');
    n += 5;
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
      e: 'owner129@example.invalid',
      h: bcrypt.hashSync(['Unused', 'Pass', '129'].join('') + '!', 12),
      n: 'B129 Portal Link',
      s: 'active',
    });
    await q(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
      { e: 'owner129@example.invalid', h: bcrypt.hashSync(PW, 12), w: WS_ID, l: LEAD_A, b: 'B129 Alpha' }
    );
    sm.attachModule(db, LEAD_A, 'ecommerce', { workspaceId: WS_ID, appUrl: 'https://example.test' });
    sm.attachModule(db, LEAD_A, 'members', { workspaceId: WS_ID, appUrl: 'https://example.test' });

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
        const res = await post(owner, '/api/v1/portal/login', { email: 'owner129@example.invalid', password: PW });
        assert.equal(res.status, 200, 'portal owner login');
        n++;
      }
      {
        // Save keys through the SHOP payments surface…
        const res = await put(owner, '/api/v1/portal/modules/ecommerce/payments', {
          publishable_key: PK_TEST,
          secret_key: SK_U1,
          webhook_secret: WHSEC_U1,
        });
        assert.equal(res.status, 200, 'shop payments save over HTTP');
        const saved = (await json(res)).data.payments;
        assert.equal(saved.connected, true);
        assert.equal(saved.source, 'unified', 'the HTTP save reports the unified layer');
        n += 3;
      }
      {
        // …and read them back on the MEMBERS pane: one config.
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/members`);
        assert.equal(res.status, 200, 'members pane loads');
        const payload = (await json(res)).data;
        assert.equal(payload.members.payments.connected, true, 'the members pane reads the SAME config the shop saved');
        assert.equal(payload.members.payments_unified.connected, true, 'members pane carries the unified status block');
        assert.equal(payload.members.payments_unified.source, 'unified');
        assert.equal(
          payload.members.webhook_path_unified,
          `/api/v1/payments/webhook/${WS_ID}`,
          'members pane names the canonical webhook URL'
        );
        n += 5;
      }
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/ecommerce`);
        assert.equal(res.status, 200, 'shop pane loads');
        const payload = (await json(res)).data;
        assert.equal(payload.shop.payments_unified.source, 'unified', 'shop pane carries the unified status block');
        assert.equal(payload.shop.webhook_path_unified, `/api/v1/payments/webhook/${WS_ID}`);
        assert.equal(
          payload.shop.effective_source,
          'lead',
          "the pre-129 effective_source vocabulary is unchanged ('lead' covers the unified layer)"
        );
        n += 3;
      }
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
    group('Part 4 HTTP', n);
  }

  console.log(`\nBatch 129 streamline suite: ${groups.length} groups passed`);
  for (const g of groups) console.log(`  - ${g}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
