'use strict';

// Batch 63 — lifecycle comms pack regressions.
//
// Covers every item of the pack against fake platform + workspace
// databases (real Batch 60/61 column shapes), a stub Stripe, and a
// captured mailer:
//   1. pre-renewal reminder (sweep, T-7, deduped per period)
//   2. domain pack (auto notice T-30, flip notice, lapse T-30/T-7 as
//      separate one-time sends, manual-renewal confirmation — sweep
//      state-diff + the domainRenewals reconcile hook)
//   3. cancel pack (confirmation via the billing flow AND the webhook
//      echo, T-3 sweep reminder, post-termination notice)
//   4. failed-payment email (per-invoice dedupe, honest copy)
//   5. plan-only first-payment receipt (never duplicates the domain
//      flow's email)
//   6. rental monthly statement (prior month, settled charges only)
//   7. contents-change notice (current owners of the changed plan)
// Plus: mailer failure never breaks a flow and releases the claim;
// sweep idempotence across two runs; billing.js dispatch integration
// (vm-loaded with the REAL lifecycleComms wired in).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL - ${name}: ${e.message}`);
  }
}

// ---------- fake platform DB (better-sqlite3 behind the db API) ----------
function namedToPositional(sql, params) {
  const order = [];
  const out = String(sql)
    .replace(/ON DUPLICATE KEY UPDATE/gi, 'ON CONFLICT DO UPDATE SET')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => {
      order.push(name);
      return '?';
    });
  return { sql: out, values: order.map((n) => (params[n] === undefined ? null : params[n])) };
}
function bindArgs(sql, params) {
  if (Array.isArray(params)) return { sql, values: params };
  if (params && typeof params === 'object') return namedToPositional(sql, params);
  return { sql, values: [] };
}
function makeDbApi(db) {
  const exec = (sql, params, mode) => {
    const b = bindArgs(sql, params);
    const stmt = db.prepare(b.sql);
    if (!stmt.reader) {
      const info = stmt.run(...b.values);
      return mode === 'run' ? { insertId: Number(info.lastInsertRowid), affectedRows: info.changes } : mode === 'get' ? null : [];
    }
    if (mode === 'get') return stmt.get(...b.values) || null;
    if (mode === 'run') {
      const rows = stmt.all(...b.values);
      return { insertId: 0, affectedRows: rows.length };
    }
    return stmt.all(...b.values);
  };
  return {
    query: async (sql, params) => exec(sql, params, 'query'),
    run: async (sql, params) => exec(sql, params, 'run'),
    get: async (sql, params) => exec(sql, params, 'get'),
    driver: () => 'sqlite',
  };
}

function freshPlatformDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, email TEXT, name TEXT, status TEXT DEFAULT 'active',
      is_super_admin INTEGER DEFAULT 0, stripe_customer_id TEXT,
      stripe_subscription_id TEXT, subscription_status TEXT,
      subscription_price_id TEXT, billing_plan TEXT, current_period_end TEXT,
      deleted_at TEXT, account_type TEXT DEFAULT 'standard'
    );
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workspace_id INTEGER,
      kind TEXT, stripe_invoice_id TEXT UNIQUE, stripe_payment_intent_id TEXT,
      stripe_charge_id TEXT, amount_cents INTEGER, currency TEXT, status TEXT,
      description TEXT, hosted_invoice_url TEXT, invoice_pdf TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE platform_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT,
      detail TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT, slug TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE workspace_members (workspace_id INTEGER, user_id INTEGER, role TEXT);
    CREATE TABLE subscription_site_disables (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workspace_id INTEGER,
      website_id INTEGER, custom_domain TEXT, stripe_subscription_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

function freshWorkspaceDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE websites (
      id INTEGER PRIMARY KEY, name TEXT, status TEXT, custom_domain TEXT,
      subscription_id TEXT, lead_id INTEGER, archived_at TEXT
    );
    CREATE TABLE site_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT, domain_name TEXT, website_id INTEGER,
      lead_id INTEGER, status TEXT, renewal_mode TEXT, renewal_auto_renew INTEGER,
      expires_at TEXT, registered_at TEXT, manual_renew_from_expiry TEXT,
      manual_renew_requested_at TEXT, renewal_checked_at TEXT, renewal_error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE domain_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, website_id INTEGER,
      domain TEXT, plan_id TEXT, billing_user_id INTEGER, stripe_session_id TEXT,
      stripe_subscription_id TEXT, stripe_customer_id TEXT,
      amount_paid_cents INTEGER, status TEXT DEFAULT 'pending_payment'
    );
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT NOT NULL, message TEXT NOT NULL,
      at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, contact_name TEXT);
    CREATE TABLE site_rentals (
      id INTEGER PRIMARY KEY, website_id INTEGER, tenant_lead_id INTEGER, status TEXT
    );
    CREATE TABLE site_rental_charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, rental_id INTEGER, status TEXT,
      credits_debited INTEGER DEFAULT 0, amount_due_cents INTEGER DEFAULT 0, settled_at TEXT
    );
  `);
  return db;
}

// ---------- vm loader ----------
function loadModule(rel, mocks) {
  const filename = path.join(ROOT, rel);
  const code = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const localRequire = (request) => {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    if (request.startsWith('node:') || !request.startsWith('.')) return require(request);
    throw new Error(`unmocked require in ${rel}: ${request}`);
  };
  const sandbox = {
    module,
    exports: module.exports,
    require: localRequire,
    __dirname: path.dirname(filename),
    __filename: filename,
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  new vm.Script(code, { filename }).runInContext(sandbox);
  return module.exports;
}

const DAY = 86400 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const sec = (ms) => Math.floor(ms / 1000);

// ---------- shared fakes ----------
let sent;
let failMail;
let platformDb;
let wsDbs;
let stripeSubs;

function resetWorld() {
  sent = [];
  failMail = false;
  platformDb = freshPlatformDb();
  wsDbs = new Map([[1, freshWorkspaceDb()], [2, freshWorkspaceDb()]]);
  stripeSubs = new Map();
}
const api = () => makeDbApi(platformDb);
const mailerStub = {
  sendPlatformMail: async (msg) => {
    if (failMail) throw new Error('SMTP down (test)');
    sent.push(msg);
    return { ok: true };
  },
  APP_URL: 'https://bitpype.com',
};
const platformStub = {
  getPlatformSetting: async () => undefined,
  setPlatformSetting: async () => {},
  audit: async () => {},
  savePlatformDefaultsSnapshot: async () => {},
};
const stripeApi = {
  subscriptions: {
    retrieve: async (id) => {
      const s = stripeSubs.get(id);
      if (!s) throw new Error(`No such subscription: ${id}`);
      return s;
    },
    update: async (id, patch) => {
      const s = stripeSubs.get(id);
      if (!s) throw new Error(`No such subscription: ${id}`);
      Object.assign(s, patch);
      return s;
    },
  },
  customers: { retrieve: async (id) => ({ id, email: null }) },
};
const stripeClientStub = {
  appUrl: () => 'https://bitpype.com',
  getSubscription: async (id) => stripeSubs.get(id) || null,
  isConfigured: () => true,
  getStripe: async () => stripeApi,
  getPriceIdForPlan: async (plan) => ({ standard: 'price_std', pro: 'price_pro', premium: 'price_prem' }[plan] || null),
  getConfiguredPriceIds: async () => ({ standard: 'price_std', pro: 'price_pro', premium: 'price_prem' }),
  planIdFromPriceId: (id) => ({ price_std: 'standard', price_pro: 'pro', price_prem: 'premium' }[id] || null),
  getPublishableKey: () => 'pk_test_x',
  integrationId: () => 'test',
};
const wsDbStub = { openWorkspaceDb: (id) => wsDbs.get(Number(id)) || null };
// billing.planOfUser is SYNCHRONOUS in the real module — mirror that.
const billingStub = { planOfUser: (u) => (u && u.billing_plan) || 'free' };

function loadComms() {
  return loadModule('server/lifecycleComms.js', {
    './db': api(),
    './platform': platformStub,
    './plans': require(path.join(ROOT, 'server/plans.js')),
    './mailer': mailerStub,
    './stripeClient': stripeClientStub,
    './workspaceDb': wsDbStub,
    './billing': billingStub,
  });
}

function addUser(row) {
  const cols = Object.keys(row);
  platformDb
    .prepare(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c]));
}
function addMember(ws, userId, role) {
  platformDb.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,?)').run(ws, userId, role);
}
function addWorkspace(id, name) {
  platformDb.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(id, name || `WS${id}`);
}
function stripeSub(id, { plan = 'standard', periodEndMs, cancel = false, unitAmount = 9900 } = {}) {
  const sub = {
    id,
    status: 'active',
    cancel_at_period_end: !!cancel,
    current_period_end: sec(periodEndMs),
    items: { data: [{ price: { id: { standard: 'price_std', pro: 'price_pro', premium: 'price_prem' }[plan], unit_amount: unitAmount, currency: 'usd' }, quantity: 1 }] },
  };
  stripeSubs.set(id, sub);
  return sub;
}
const claims = () => platformDb.prepare('SELECT ref_key, kind FROM lifecycle_comms_sends ORDER BY ref_key').all();

(async () => {
  // ============ 1. pre-renewal reminder ============
  await test('pre-renewal: T-7 window fires once with plan, date and amount; re-run is a no-op', async () => {
    resetWorld();
    const comms = loadComms();
    const endMs = Date.now() + 5 * DAY;
    addUser({ id: 1, email: 'owner@example.com', name: 'Owner One', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_r7', subscription_status: 'active', billing_plan: 'standard', current_period_end: iso(endMs) });
    stripeSub('sub_r7', { periodEndMs: endMs });
    const r1 = await comms.runSubscriptionSweep({});
    assert.strictEqual(r1.sent.length, 1, JSON.stringify(r1.skipped));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, 'owner@example.com');
    assert.ok(sent[0].subject.startsWith('Your Bitpype Standard plan renews on '), sent[0].subject);
    assert.ok(sent[0].subject.endsWith('— $99.00'), sent[0].subject);
    assert.strictEqual(sent[0].cta.url, 'https://bitpype.com/portal?panel=billing');
    assert.ok(claims().some((c) => c.ref_key.startsWith('pre_renewal:sub_r7:')), JSON.stringify(claims()));
    const r2 = await comms.runSubscriptionSweep({});
    assert.strictEqual(r2.sent.length, 0, 'second sweep must not re-send');
    assert.strictEqual(sent.length, 1);
  });

  await test('pre-renewal: outside the window and past_due are skipped', async () => {
    resetWorld();
    const comms = loadComms();
    const farMs = Date.now() + 20 * DAY;
    addUser({ id: 1, email: 'far@example.com', stripe_customer_id: 'cus_f', stripe_subscription_id: 'sub_far', subscription_status: 'active', billing_plan: 'pro', current_period_end: iso(farMs) });
    stripeSub('sub_far', { plan: 'pro', periodEndMs: farMs, unitAmount: 16900 });
    const dueMs = Date.now() + 3 * DAY;
    addUser({ id: 2, email: 'due@example.com', stripe_customer_id: 'cus_d', stripe_subscription_id: 'sub_due', subscription_status: 'past_due', billing_plan: 'pro', current_period_end: iso(dueMs) });
    stripeSub('sub_due', { plan: 'pro', periodEndMs: dueMs, unitAmount: 16900 });
    const r = await comms.runSubscriptionSweep({});
    assert.strictEqual(r.sent.length, 0);
    assert.strictEqual(sent.length, 0);
  });

  // ============ 3b. cancel reminder via sweep ============
  await test('cancel pack: sweep sends the T-3 reminder (not a renewal reminder), once', async () => {
    resetWorld();
    const comms = loadComms();
    const endMs = Date.now() + 2 * DAY;
    addUser({ id: 1, email: 'leaving@example.com', stripe_customer_id: 'cus_l', stripe_subscription_id: 'sub_cx', subscription_status: 'active', billing_plan: 'standard', current_period_end: iso(endMs) });
    stripeSub('sub_cx', { periodEndMs: endMs, cancel: true });
    const r = await comms.runSubscriptionSweep({});
    assert.strictEqual(sent.length, 1, JSON.stringify(r.skipped));
    assert.ok(sent[0].subject.includes('plan ends on'), sent[0].subject);
    assert.ok(sent[0].subject.includes('website goes offline'), sent[0].subject);
    assert.ok(sent[0].text.includes('website comes offline'), sent[0].text);
    assert.ok(sent[0].text.includes('stop renewing automatically'), sent[0].text);
    assert.strictEqual(r.sent.length, 1);
    await comms.runSubscriptionSweep({});
    assert.strictEqual(sent.length, 1, 'reminder must not repeat');
  });

  // ============ 3a. cancel confirmation + resume re-arm ============
  await test('cancel pack: confirmation deduped per subscription+period; resume re-arms it', async () => {
    resetWorld();
    const comms = loadComms();
    const endMs = Date.now() + 30 * DAY;
    addUser({ id: 1, email: 'cx@example.com', stripe_customer_id: 'cus_cx', stripe_subscription_id: 'sub_cc', subscription_status: 'active', billing_plan: 'pro', current_period_end: iso(endMs) });
    const sub = stripeSub('sub_cc', { plan: 'pro', periodEndMs: endMs, cancel: true, unitAmount: 16900 });
    const a = await comms.sendCancelConfirmation(sub, {});
    assert.strictEqual(a.sent, true);
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].subject.includes('is set to end on'), sent[0].subject);
    assert.ok(sent[0].text.includes('website stays live until then'), sent[0].text);
    const b = await comms.sendCancelConfirmation(sub, {});
    assert.strictEqual(b.sent, false, 'duplicate confirmation suppressed');
    assert.strictEqual(sent.length, 1);
    await comms.clearCancelClaims('sub_cc', {});
    const c = await comms.sendCancelConfirmation(sub, {});
    assert.strictEqual(c.sent, true, 'after resume, a fresh cancel notifies again');
    assert.strictEqual(sent.length, 2);
  });

  // ============ 3c. termination notice ============
  await test('cancel pack: termination notice covers archived sites + unlinked domains, once; orphan subs suppressed', async () => {
    resetWorld();
    const comms = loadComms();
    addUser({ id: 1, email: 'gone@example.com', stripe_customer_id: 'cus_g', stripe_subscription_id: 'sub_gone', subscription_status: 'canceled', billing_plan: 'standard' });
    const sub = { id: 'sub_gone', customer: 'cus_g' };
    const disable = {
      userId: 1,
      disabled: [{ workspaceId: 1, websiteId: 7, name: 'Bakery Site', unlinked: ['bakery.example'] }],
    };
    const r = await comms.sendTerminationNotice(sub, disable, {});
    assert.strictEqual(r.sent, true, JSON.stringify(r));
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].text.includes('bakery.example'), sent[0].text);
    assert.ok(sent[0].text.includes('archived — not deleted'), sent[0].text);
    assert.ok(sent[0].text.includes('reply to this email'), sent[0].text);
    const again = await comms.sendTerminationNotice(sub, disable, {});
    assert.strictEqual(again.sent, false);
    const orphan = await comms.sendTerminationNotice(sub, { skipped: 'other_subscription_tracked' }, {});
    assert.strictEqual(orphan.sent, false);
    assert.strictEqual(sent.length, 1);
  });

  // ============ 4. failed payment ============
  await test('failed payment: per-invoice dedupe, honest stays-active copy, zero-due skipped', async () => {
    resetWorld();
    const comms = loadComms();
    addUser({ id: 1, email: 'card@example.com', stripe_customer_id: 'cus_p', stripe_subscription_id: 'sub_p', subscription_status: 'past_due', billing_plan: 'standard' });
    const inv = { id: 'in_fail1', customer: 'cus_p', subscription: 'sub_p', amount_due: 9900, currency: 'usd' };
    const r = await comms.sendPaymentFailedEmail(inv, {});
    assert.strictEqual(r.sent, true, JSON.stringify(r));
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].subject.includes('Bitpype Standard payment of $99.00'), sent[0].subject);
    assert.ok(sent[0].text.includes('stays active while the payment is retried'), sent[0].text);
    const again = await comms.sendPaymentFailedEmail(inv, {});
    assert.strictEqual(again.sent, false);
    const zero = await comms.sendPaymentFailedEmail({ ...inv, id: 'in_zero', amount_due: 0 }, {});
    assert.strictEqual(zero.sent, false);
    assert.strictEqual(sent.length, 1);
  });

  // ============ 5. first-payment receipt ============
  await test('first payment: plan-only signup gets a receipt, once', async () => {
    resetWorld();
    const comms = loadComms();
    const endMs = Date.now() + 30 * DAY;
    addUser({ id: 1, email: 'new@example.com', stripe_customer_id: 'cus_n', stripe_subscription_id: 'sub_n', subscription_status: 'active', billing_plan: 'standard' });
    addWorkspace(1);
    addMember(1, 1, 'owner');
    const sub = stripeSub('sub_n', { periodEndMs: endMs });
    const inv = { id: 'in_first', customer: 'cus_n', subscription: 'sub_n', billing_reason: 'subscription_create', amount_paid: 9900, currency: 'usd' };
    const r = await comms.sendFirstPaymentReceipt(inv, { subscription: sub });
    assert.strictEqual(r.sent, true, JSON.stringify(r));
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].subject.includes('Payment received for your Bitpype Standard plan'), sent[0].subject);
    assert.ok(sent[0].text.includes('$99.00'), sent[0].text);
    const again = await comms.sendFirstPaymentReceipt(inv, { subscription: sub });
    assert.strictEqual(again.sent, false);
    const renewal = await comms.sendFirstPaymentReceipt({ ...inv, id: 'in_cyc', billing_reason: 'subscription_cycle' }, { subscription: sub });
    assert.strictEqual(renewal.sent, false, 'cycle invoices are not first payments');
    assert.strictEqual(sent.length, 1);
  });

  await test('first payment: a domain-flow signup is NOT emailed twice', async () => {
    resetWorld();
    const comms = loadComms();
    const endMs = Date.now() + 30 * DAY;
    addUser({ id: 2, email: 'dom@example.com', stripe_customer_id: 'cus_dm', stripe_subscription_id: 'sub_dm', subscription_status: 'active', billing_plan: 'standard' });
    addWorkspace(1);
    addMember(1, 2, 'owner');
    wsDbs.get(1).prepare('INSERT INTO domain_transactions (lead_id, domain, plan_id, billing_user_id, status, stripe_subscription_id) VALUES (99, ?, ?, 2, ?, ?)')
      .run('shop.example', 'standard', 'live', 'sub_dm');
    const sub = stripeSub('sub_dm', { periodEndMs: endMs });
    const inv = { id: 'in_dom', customer: 'cus_dm', subscription: 'sub_dm', billing_reason: 'subscription_create', amount_paid: 9900, currency: 'usd' };
    const r = await comms.sendFirstPaymentReceipt(inv, { subscription: sub });
    assert.strictEqual(r.sent, false);
    assert.strictEqual(r.reason, 'domain_flow_emailed');
    assert.strictEqual(sent.length, 0);
  });

  // ============ 2. domain pack (sweep) ============
  function seedDomain(ws, row) {
    const cols = Object.keys(row);
    wsDbs.get(ws).prepare(`INSERT INTO site_domains (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
  }
  async function seedDomainState(comms, domain, mode, expiresAt) {
    await comms.ensureCommsTables(api().query);
    platformDb.prepare('INSERT INTO lifecycle_domain_state (domain, workspace_id, mode, expires_at) VALUES (?, 1, ?, ?)').run(domain, mode, expiresAt);
  }

  await test('domain pack: auto notice T-30, lapse T-30 and T-7 as separate one-time sends', async () => {
    resetWorld();
    const comms = loadComms();
    addUser({ id: 1, email: 'domowner@example.com', stripe_customer_id: 'cus_do', stripe_subscription_id: 'sub_do', subscription_status: 'active', billing_plan: 'standard' });
    addWorkspace(1);
    addMember(1, 1, 'owner');
    const in20 = iso(Date.now() + 20 * DAY);
    const in5 = iso(Date.now() + 5 * DAY);
    seedDomain(1, { domain_name: 'auto.example', website_id: 11, status: 'linked', renewal_mode: 'auto', renewal_auto_renew: 1, expires_at: in20 });
    seedDomain(1, { domain_name: 'manual.example', website_id: 12, status: 'linked', renewal_mode: 'manual', renewal_auto_renew: 0, expires_at: in20 });
    seedDomain(1, { domain_name: 'manual7.example', website_id: 13, status: 'linked', renewal_mode: 'manual', renewal_auto_renew: 0, expires_at: in5 });
    const r1 = await comms.runDomainSweep({});
    assert.strictEqual(r1.sent.length, 3, JSON.stringify(r1.sent.map((s) => s.kind)));
    const subjects = sent.map((m) => m.subject);
    assert.ok(subjects.some((s) => s.startsWith('auto.example renews automatically')), subjects.join(' | '));
    assert.ok(subjects.some((s) => s.startsWith('manual.example expires on')), subjects.join(' | '));
    assert.ok(subjects.some((s) => s.startsWith('manual7.example expires in 7 days')), subjects.join(' | '));
    // The T-30 and T-7 warnings are DISTINCT deduped sends, and a
    // domain already inside its final week gets only the T-7 one.
    const keys = claims().map((c) => c.ref_key);
    assert.ok(keys.includes(`domain_lapse_30:manual.example:${in20.slice(0, 10)}`), keys.join(','));
    assert.ok(keys.includes(`domain_lapse_7:manual7.example:${in5.slice(0, 10)}`), keys.join(','));
    assert.ok(!keys.some((k) => k.startsWith('domain_lapse_30:manual7')), 'a domain inside 7 days gets the 7-day warning, not both');
    const lapse = sent.find((m) => m.subject.startsWith('manual.example expires'));
    assert.ok(lapse.text.includes('Renew/Extend Domain'), lapse.text);
    const r2 = await comms.runDomainSweep({});
    assert.strictEqual(r2.sent.length, 0, 'second sweep sends nothing new');
    assert.strictEqual(sent.length, 3);
  });

  await test('domain pack: flip notice and manual-renewal confirmation via state diff', async () => {
    resetWorld();
    const comms = loadComms();
    addUser({ id: 1, email: 'flip@example.com', stripe_customer_id: 'cus_fl', stripe_subscription_id: null, subscription_status: 'canceled', billing_plan: 'free' });
    addWorkspace(1);
    addMember(1, 1, 'owner');
    // flip.example: state says auto (last sweep), the row now says manual.
    const flipExpiry = iso(Date.now() + 200 * DAY);
    seedDomain(1, { domain_name: 'flip.example', website_id: 21, status: 'linked', renewal_mode: 'manual', renewal_auto_renew: 0, expires_at: flipExpiry });
    await seedDomainState(comms, 'flip.example', 'auto', flipExpiry);
    // renewed.example: manual both times, but the expiry jumped a year.
    const oldExpiry = iso(Date.now() + 100 * DAY);
    const newExpiry = iso(Date.now() + 465 * DAY);
    seedDomain(1, { domain_name: 'renewed.example', website_id: 22, status: 'linked', renewal_mode: 'manual', renewal_auto_renew: 0, expires_at: newExpiry });
    await seedDomainState(comms, 'renewed.example', 'manual', oldExpiry);
    const r = await comms.runDomainSweep({});
    assert.strictEqual(r.sent.length, 2, JSON.stringify(r.sent.map((s) => s.kind)));
    const flip = sent.find((m) => m.subject.startsWith('flip.example will no longer renew automatically'));
    assert.ok(flip, sent.map((m) => m.subject).join(' | '));
    assert.ok(flip.text.includes('Manual renewal only'), flip.text);
    const ren = sent.find((m) => m.subject.startsWith('renewed.example has been renewed'));
    assert.ok(ren, sent.map((m) => m.subject).join(' | '));
    await comms.runDomainSweep({});
    assert.strictEqual(sent.length, 2, 'transitions fire once');
  });

  await test('domain pack: first sighting records state and sends nothing (deploy-day no-op)', async () => {
    resetWorld();
    const comms = loadComms();
    addUser({ id: 1, email: 'quiet@example.com', stripe_customer_id: 'cus_q', stripe_subscription_id: 'sub_q', subscription_status: 'active', billing_plan: 'standard' });
    addWorkspace(1);
    addMember(1, 1, 'owner');
    // The production shape: one auto domain ~a year out.
    seedDomain(1, { domain_name: 'berks.example', website_id: 21, status: 'linked', renewal_mode: 'auto', renewal_auto_renew: 1, expires_at: iso(Date.now() + 364 * DAY) });
    const r = await comms.runDomainSweep({});
    assert.strictEqual(r.sent.length, 0);
    assert.strictEqual(sent.length, 0);
    const state = platformDb.prepare('SELECT * FROM lifecycle_domain_state WHERE domain = ?').get('berks.example');
    assert.ok(state && state.mode === 'auto', 'state recorded for future diffs');
  });

  await test('domain pack: dry run reports candidates without claiming or sending', async () => {
    resetWorld();
    const comms = loadComms();
    addUser({ id: 1, email: 'dry@example.com', stripe_customer_id: 'cus_dr', stripe_subscription_id: 'sub_dr', subscription_status: 'active', billing_plan: 'standard' });
    addWorkspace(1);
    addMember(1, 1, 'owner');
    seedDomain(1, { domain_name: 'dry.example', website_id: 31, status: 'linked', renewal_mode: 'auto', renewal_auto_renew: 1, expires_at: iso(Date.now() + 10 * DAY) });
    const r = await comms.runDomainSweep({ dryRun: true });
    assert.strictEqual(r.sent.length, 1, 'candidate reported');
    assert.strictEqual(sent.length, 0, 'nothing actually sent');
    assert.strictEqual(claims().length, 0, 'nothing claimed');
    const real = await comms.runDomainSweep({});
    assert.strictEqual(real.sent.length, 1);
    assert.strictEqual(sent.length, 1);
  });

  // ============ 6. rental statement ============
  await test('rental statement: prior-month settled charges summarized once; zero-activity skipped', async () => {
    resetWorld();
    const comms = loadComms();
    addWorkspace(1);
    const ws = wsDbs.get(1);
    ws.prepare('INSERT INTO websites (id, name, status) VALUES (41, ?, ?)').run('Rental Site', 'live');
    ws.prepare('INSERT INTO leads (id, business_name, email) VALUES (51, ?, ?)').run('Tenant Co', 'tenant@example.com');
    ws.prepare('INSERT INTO site_rentals (id, website_id, tenant_lead_id, status) VALUES (61, 41, 51, ?)').run('active');
    ws.prepare('INSERT INTO site_rentals (id, website_id, tenant_lead_id, status) VALUES (62, 41, 51, ?)').run('active');
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const prevSql = prev.toISOString().slice(0, 19).replace('T', ' ');
    ws.prepare('INSERT INTO site_rental_charges (rental_id, status, credits_debited, amount_due_cents, settled_at) VALUES (61, ?, 2, 1000, ?)').run('charged', prevSql);
    ws.prepare('INSERT INTO site_rental_charges (rental_id, status, credits_debited, amount_due_cents, settled_at) VALUES (61, ?, 1, 500, ?)').run('due', prevSql);
    // A charge from THIS month must not leak into last month's statement.
    ws.prepare('INSERT INTO site_rental_charges (rental_id, status, credits_debited, amount_due_cents, settled_at) VALUES (61, ?, 9, 9000, ?)').run('charged', iso(Date.now()).slice(0, 19).replace('T', ' '));
    const r = await comms.runRentalStatements({});
    assert.strictEqual(r.sent.length, 1, JSON.stringify(r));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, 'tenant@example.com');
    assert.ok(sent[0].subject.includes('Rental Site rental statement for'), sent[0].subject);
    assert.ok(sent[0].text.includes('2 charges settled'), sent[0].text);
    assert.ok(sent[0].text.includes('3 credits used'), sent[0].text);
    assert.ok(sent[0].text.includes('$15.00'), sent[0].text);
    await comms.runRentalStatements({});
    assert.strictEqual(sent.length, 1, 'statement is once per rental per month');
  });

  // ============ 7. contents-change notice ============
  await test('contents notice: only current owners of the changed plan, once per contents hash', async () => {
    resetWorld();
    const comms = loadComms();
    addWorkspace(1); addWorkspace(2); addWorkspace(3);
    addUser({ id: 1, email: 'pro1@example.com', billing_plan: 'pro', subscription_status: 'active' });
    addUser({ id: 2, email: 'pro2@example.com', billing_plan: 'pro', subscription_status: 'active' });
    addUser({ id: 3, email: 'std@example.com', billing_plan: 'standard', subscription_status: 'active' });
    addMember(1, 1, 'owner');
    addMember(2, 2, 'owner');
    addMember(3, 3, 'owner');
    const r = await comms.sendPlanContentsNotice('pro', {});
    assert.strictEqual(r.sent, 2, JSON.stringify(r));
    assert.deepStrictEqual(sent.map((m) => m.to).sort(), ['pro1@example.com', 'pro2@example.com']);
    assert.ok(sent[0].subject.includes("what's included has been updated"), sent[0].subject);
    assert.ok(sent[0].text.includes('Your price has not changed'), sent[0].text);
    const again = await comms.sendPlanContentsNotice('pro', {});
    assert.strictEqual(again.sent, 0, 'same contents hash does not re-notify');
    const bogus = await comms.sendPlanContentsNotice('bogus', {});
    assert.strictEqual(bogus.sent, 0);
    assert.strictEqual(sent.length, 2);
  });

  // ============ mailer failure resilience ============
  await test('mailer failure: send reports failure, claim released, retry succeeds', async () => {
    resetWorld();
    const comms = loadComms();
    const endMs = Date.now() + 30 * DAY;
    addUser({ id: 1, email: 'retry@example.com', stripe_customer_id: 'cus_rt', stripe_subscription_id: 'sub_rt', subscription_status: 'active', billing_plan: 'standard', current_period_end: iso(endMs) });
    const sub = stripeSub('sub_rt', { periodEndMs: endMs, cancel: true });
    failMail = true;
    const a = await comms.sendCancelConfirmation(sub, {});
    assert.strictEqual(a.sent, false);
    assert.strictEqual(claims().length, 0, 'a failed send must not hold the claim');
    failMail = false;
    const b = await comms.sendCancelConfirmation(sub, {});
    assert.strictEqual(b.sent, true);
    assert.strictEqual(sent.length, 1);
  });

  // ============ billing.js integration (real billing + real comms) ============
  function loadBilling(comms) {
    return loadModule('server/billing.js', {
      './db': api(),
      './platform': platformStub,
      './plans': require(path.join(ROOT, 'server/plans.js')),
      './stripeClient': stripeClientStub,
      './credits': {},
      './appUrls': { staffUrl: (p) => 'https://bitpype.com' + (p || '') },
      './mailer': mailerStub,
      './membershipAccess': { onSubscriptionTransition: async () => ({}) },
      './domainRenewals': { reconcileForSubscriptionEvent: async () => ({}) },
      './domainFlow': { onDomainCheckoutPaid: async () => ({}) },
      './workspaceDb': wsDbStub,
      './rentals': { closeRentalsForWebsite: async () => ({ closed: 0 }) },
      './lifecycleComms': comms,
      // Batch 80: billing's partner-earnings hook — no partners exist
      // in this fixture world, so every entry point is a no-op.
      './partners': {
        creditForInvoicePaid: async () => ({ credited: false, reason: 'no_partner' }),
        reverseForRefund: async () => ({ reversed: false }),
        reverseForDispute: async () => ({ reversed: false }),
      },
    });
  }
  const evt = (type, object) => ({ type, data: { object } });

  await test('billing integration: in-app cancel emails once; webhook echo does not double-send; resume + re-cancel emails again', async () => {
    resetWorld();
    const comms = loadComms();
    const billing = loadBilling(comms);
    const endMs = Date.now() + 30 * DAY;
    addUser({ id: 1, email: 'flow@example.com', stripe_customer_id: 'cus_f1', stripe_subscription_id: 'sub_f1', subscription_status: 'active', billing_plan: 'standard', current_period_end: iso(endMs) });
    stripeSub('sub_f1', { periodEndMs: endMs });
    const res = await billing.scheduleCancelAtPeriodEnd(1);
    assert.strictEqual(res.cancelAtPeriodEnd, true);
    assert.strictEqual(sent.length, 1, JSON.stringify(sent.map((m) => m.subject)));
    assert.ok(sent[0].subject.includes('is set to end on'), sent[0].subject);
    await billing.handleWebhookEvent(evt('customer.subscription.updated', stripeSubs.get('sub_f1')), {});
    assert.strictEqual(sent.length, 1, 'the webhook echo of the same cancel must not re-send');
    await billing.resumeSubscription(1);
    await billing.scheduleCancelAtPeriodEnd(1);
    assert.strictEqual(sent.length, 2, 'a fresh cancel after resume notifies again');
  });

  await test('billing integration: invoice.payment_failed webhook emails once per invoice', async () => {
    resetWorld();
    const comms = loadComms();
    const billing = loadBilling(comms);
    const endMs = Date.now() + 30 * DAY;
    addUser({ id: 1, email: 'pf@example.com', stripe_customer_id: 'cus_pf', stripe_subscription_id: 'sub_pf', subscription_status: 'active', billing_plan: 'standard', current_period_end: iso(endMs) });
    stripeSub('sub_pf', { periodEndMs: endMs });
    const inv = { id: 'in_pf1', customer: 'cus_pf', subscription: 'sub_pf', amount_due: 9900, currency: 'usd' };
    await billing.handleWebhookEvent(evt('invoice.payment_failed', inv), {});
    assert.strictEqual(sent.length, 1, JSON.stringify(sent.map((m) => m.subject)));
    assert.ok(sent[0].subject.includes("didn't go through"), sent[0].subject);
    await billing.handleWebhookEvent(evt('invoice.payment_failed', inv), {});
    assert.strictEqual(sent.length, 1, 'webhook replay must not re-send (per-invoice dedupe)');
  });

  await test('billing integration: invoice.paid (subscription_create) sends the plan receipt once, and no renewal email', async () => {
    resetWorld();
    const comms = loadComms();
    const billing = loadBilling(comms);
    const endMs = Date.now() + 30 * DAY;
    addUser({ id: 1, email: 'rc@example.com', stripe_customer_id: 'cus_rc', stripe_subscription_id: 'sub_rc', subscription_status: 'active', billing_plan: 'standard', current_period_end: iso(endMs) });
    addWorkspace(1);
    addMember(1, 1, 'owner');
    stripeSub('sub_rc', { periodEndMs: endMs });
    const inv = {
      id: 'in_rc1', customer: 'cus_rc', subscription: 'sub_rc',
      billing_reason: 'subscription_create', amount_paid: 9900, amount_due: 0, currency: 'usd',
      lines: { data: [{ period: { end: sec(endMs) } }] },
    };
    await billing.handleWebhookEvent(evt('invoice.paid', inv), {});
    assert.strictEqual(sent.length, 1, JSON.stringify(sent.map((m) => m.subject)));
    assert.ok(sent[0].subject.includes('Payment received'), sent[0].subject);
    await billing.handleWebhookEvent(evt('invoice.paid', inv), {});
    assert.strictEqual(sent.length, 1, 'replay must not re-send');
  });

  await test('billing integration: subscription.deleted archives the site and emails the termination notice once', async () => {
    resetWorld();
    const comms = loadComms();
    const billing = loadBilling(comms);
    addWorkspace(1);
    addUser({ id: 9, email: 'term@example.com', stripe_customer_id: 'cus_t', stripe_subscription_id: 'sub_t', subscription_status: 'active', billing_plan: 'standard' });
    addMember(1, 9, 'owner');
    const ws = wsDbs.get(1);
    // The disable flow resolves a user's sites through their leads
    // (lead email match), not through a subscription column.
    ws.prepare('INSERT INTO leads (id, business_name, email) VALUES (77, ?, ?)').run('Doomed Co', 'term@example.com');
    ws.prepare('INSERT INTO websites (id, name, status, custom_domain, lead_id) VALUES (5, ?, ?, ?, 77)')
      .run('Doomed Site', 'published', 'doomed.example');
    const deps = {
      archiveSite: async (db, id) => { db.prepare('UPDATE websites SET status = ? WHERE id = ?').run('archived', id); return {}; },
      unlinkDomain: async () => ({}),
    };
    const subObj = { id: 'sub_t', customer: 'cus_t' };
    await billing.handleWebhookEvent(evt('customer.subscription.deleted', subObj), deps);
    const site = ws.prepare('SELECT status FROM websites WHERE id = 5').get();
    assert.strictEqual(site.status, 'archived');
    const notice = sent.find((m) => m.to === 'term@example.com' && m.text.includes('doomed.example'));
    assert.ok(notice, JSON.stringify(sent.map((m) => m.subject)));
    await billing.handleWebhookEvent(evt('customer.subscription.deleted', subObj), deps);
    assert.strictEqual(sent.filter((m) => m.to === 'term@example.com').length, 1, 'termination notice is once per subscription');
  });

  // ============ domainRenewals neighbor: reconcile hook wiring ============
  function loadDomainRenewals(comms) {
    const billingForDR = {
      workspaceHasSubscription: async () => false,
      getUserBilling: async (id) => {
        const rows = await api().query('SELECT * FROM users WHERE id = :id', { id: Number(id) });
        return rows[0] || null;
      },
      isSubscribed: (u) => !!u && ['active', 'trialing', 'past_due'].includes(String(u.subscription_status || '')),
      ACTIVE_STATUSES: new Set(['active', 'trialing', 'past_due']),
    };
    return loadModule('server/domainRenewals.js', {
      './db': api(),
      './platform': platformStub,
      './billing': billingForDR,
      './workspaceDb': wsDbStub,
      './lifecycleComms': comms,
      '../src/cfDomains': {
        ensureTables: () => {},
        listRegistrations: async () => ({ domains: [] }),
        setRegistrationAutoRenew: async (db, name, val) => ({ autoRenew: !!val }),
      },
    });
  }

  await test('domainRenewals: reconcile calls the notifier on flip and on observed manual renewal', async () => {
    resetWorld();
    const comms = loadComms();
    const dr = loadDomainRenewals(comms);
    addWorkspace(1);
    addUser({ id: 1, email: 'hook@example.com', subscription_status: 'canceled', billing_plan: 'free' });
    addMember(1, 1, 'owner');
    const ws = wsDbs.get(1);
    const exp300 = iso(Date.now() + 300 * DAY);
    const oldExp = iso(Date.now() + 100 * DAY);
    const newExp = iso(Date.now() + 465 * DAY);
    ws.prepare('INSERT INTO site_domains (domain_name, website_id, status, renewal_mode, renewal_auto_renew, expires_at) VALUES (?, 3, ?, ?, 1, ?)')
      .run('hookflip.example', 'linked', 'auto', exp300);
    ws.prepare('INSERT INTO site_domains (domain_name, website_id, status, renewal_mode, renewal_auto_renew, expires_at, manual_renew_requested_at, manual_renew_from_expiry) VALUES (?, 4, ?, ?, 0, ?, ?, ?)')
      .run('obs.example', 'linked', 'manual', oldExp, iso(Date.now() - DAY), oldExp);
    const regs = {
      'hookflip.example': { domain: 'hookflip.example', expiresAt: exp300, autoRenew: false },
      'obs.example': { domain: 'obs.example', expiresAt: newExp, autoRenew: false },
    };
    const calls = [];
    await dr.reconcileWorkspace(ws, 1, {
      listRegistrations: async () => ({ domains: Object.values(regs) }),
      setRegistrationAutoRenew: async (db, name, val) => ({ autoRenew: !!val }),
      workspaceSubscribed: async () => false,
      notifyDomainEvent: async (db, wsId, ev) => { calls.push(ev); },
    });
    const types = calls.map((c) => `${c.type}:${c.domain}`).sort();
    assert.deepStrictEqual(types, ['flip:hookflip.example', 'manual_renewed:obs.example'], JSON.stringify(calls));
  });

  await test('domainRenewals: default wiring emails the owner on a flip (no injected notifier)', async () => {
    resetWorld();
    const comms = loadComms();
    const dr = loadDomainRenewals(comms);
    addWorkspace(1);
    addUser({ id: 1, email: 'wired@example.com', subscription_status: 'canceled', billing_plan: 'free' });
    addMember(1, 1, 'owner');
    const ws = wsDbs.get(1);
    const exp300 = iso(Date.now() + 300 * DAY);
    ws.prepare('INSERT INTO site_domains (domain_name, website_id, status, renewal_mode, renewal_auto_renew, expires_at) VALUES (?, 3, ?, ?, 1, ?)')
      .run('wired.example', 'linked', 'auto', exp300);
    await dr.reconcileWorkspaces([1], {
      openDb: (id) => wsDbs.get(Number(id)) || null,
      listRegistrations: async () => ({ domains: [{ domain: 'wired.example', expiresAt: exp300, autoRenew: false }] }),
      setRegistrationAutoRenew: async (db, name, val) => ({ autoRenew: !!val }),
      workspaceSubscribed: async () => false,
    });
    const flip = sent.find((m) => m.to === 'wired@example.com' && m.subject.startsWith('wired.example will no longer renew automatically'));
    assert.ok(flip, JSON.stringify(sent.map((m) => m.subject)));
  });

  console.log(`\nbatch63 lifecycle comms: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
