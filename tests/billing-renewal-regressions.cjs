'use strict';
/**
 * Batch 37 — subscription renewal email + cancel-at-period-end truth +
 * site-offline at subscription end (Ely's spec, 2026-10-27):
 *
 *   1. RENEWAL EMAIL — invoice.paid with billing_reason
 *      'subscription_cycle' and a NEWLY inserted payment row sends the
 *      billing user exactly one branded renewal email (plan, amount,
 *      next renewal date, their domain, durable manage/cancel link
 *      /portal?panel=billing). Duplicate event ids AND duplicate
 *      invoice deliveries resend nothing. 'subscription_create' (first
 *      payment — Batch 36 / signup territory) sends NO renewal email.
 *      A mail failure still lets the webhook succeed.
 *   2. CANCEL = PERIOD END — scheduleCancelAtPeriodEnd already set
 *      cancel_at_period_end; pinned here against regression, and its
 *      message now states the date + "your website stays live until
 *      then". Neither the cancel call nor a subscription.updated event
 *      disables any site. Resume clears the flag.
 *   3. SITE DISABLES AT PERIOD END — customer.subscription.deleted
 *      archives the owner's live site(s) (Batch 27 primitive via
 *      websiteEngine.deleteWebsite), unlinks their custom domains, and
 *      records subscription_site_disables rows (prior state, reason
 *      'subscription_ended'). Idempotent on replay; other users' sites
 *      untouched; an orphan subscription deletion (user tracks a
 *      different live sub) disables nothing.
 *
 * Negative proofs: dropping the billing_reason check fails the
 * subscription_create case; dropping the inserted-gate fails the
 * duplicate-invoice case; reverting the cancel message fails the copy
 * checks; removing the deleted-branch hook fails the disable cases;
 * triggering the disable on subscription.updated fails the
 * not-yet-ended cases.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || process.env.DB_DRIVER || 'sqlite';

const root = path.resolve(__dirname, '..');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}

const OCT27 = Math.floor(Date.UTC(2026, 9, 27) / 1000);
const NOV27 = Math.floor(Date.UTC(2026, 10, 27) / 1000);

/* ---------------- workspace tenant DBs (SQLite) ---------------- */
function makeWorkspaceDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT);
    CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, name TEXT, status TEXT,
      custom_domain TEXT, preview_url TEXT, archived_at TEXT);
    CREATE TABLE site_domains (id INTEGER PRIMARY KEY, website_id INTEGER, lead_id INTEGER,
      domain_name TEXT, status TEXT, pages_project TEXT, public_url TEXT);
    CREATE TABLE domain_transactions (id INTEGER PRIMARY KEY, lead_id INTEGER, website_id INTEGER,
      billing_user_id INTEGER, domain TEXT, status TEXT);
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT, message TEXT);
  `);
  return db;
}
const wsDb = { 1: makeWorkspaceDb(), 2: makeWorkspaceDb() };
// ws1: user 7's lead + published site with a linked domain; a second
// site reached ONLY via domain_transactions.billing_user_id.
wsDb[1].prepare("INSERT INTO leads (id, business_name, email) VALUES (71, 'Owner Biz', 'owner@fixture.test')").run();
wsDb[1].prepare("INSERT INTO websites (id, lead_id, name, status, custom_domain, preview_url) VALUES (701, 71, 'Owner Site', 'published', 'owner-site.com', 'https://owner-site.com')").run();
wsDb[1].prepare("INSERT INTO site_domains (website_id, lead_id, domain_name, status, pages_project, public_url) VALUES (701, 71, 'owner-site.com', 'linked', 'owner-proj', 'https://owner-site.com')").run();
wsDb[1].prepare("INSERT INTO leads (id, business_name, email) VALUES (72, 'Txn Biz', 'someone-else@fixture.test')").run();
wsDb[1].prepare("INSERT INTO websites (id, lead_id, name, status, custom_domain, preview_url) VALUES (702, 72, 'Txn Site', 'published', 'txn-site.com', 'https://txn-site.com')").run();
wsDb[1].prepare("INSERT INTO site_domains (website_id, lead_id, domain_name, status, pages_project, public_url) VALUES (702, 72, 'txn-site.com', 'linked', 'txn-proj', 'https://txn-site.com')").run();
wsDb[1].prepare("INSERT INTO domain_transactions (lead_id, website_id, billing_user_id, domain, status) VALUES (72, 702, 7, 'txn-site.com', 'live')").run();
// ws2: user 8 (control) and user 9 (orphan-guard) sites.
wsDb[2].prepare("INSERT INTO leads (id, business_name, email) VALUES (81, 'Other Biz', 'other@fixture.test')").run();
wsDb[2].prepare("INSERT INTO websites (id, lead_id, name, status, custom_domain, preview_url) VALUES (801, 81, 'Other Site', 'published', 'other-site.com', 'https://other-site.com')").run();
wsDb[2].prepare("INSERT INTO leads (id, business_name, email) VALUES (82, 'Third Biz', 'third@fixture.test')").run();
wsDb[2].prepare("INSERT INTO websites (id, lead_id, name, status, custom_domain, preview_url) VALUES (802, 82, 'Third Site', 'published', 'third-site.com', 'https://third-site.com')").run();

/* ---------------- server-layer (MySQL-shaped) fake ---------------- */
const users = new Map();
function addUser(row) {
  users.set(row.id, {
    name: '', status: 'active', is_super_admin: 0, deleted_at: null,
    stripe_customer_id: null, stripe_subscription_id: null, subscription_status: 'none',
    subscription_price_id: '', billing_plan: 'free', current_period_end: null,
    ...row,
  });
}
addUser({ id: 7, email: 'owner@fixture.test', stripe_customer_id: 'cus_7', stripe_subscription_id: 'sub_7', subscription_status: 'active', subscription_price_id: 'price_standard', billing_plan: 'standard', current_period_end: '2026-11-27 00:00:00' });
addUser({ id: 8, email: 'other@fixture.test', stripe_customer_id: 'cus_8', stripe_subscription_id: 'sub_8', subscription_status: 'active', subscription_price_id: 'price_standard', billing_plan: 'standard' });
addUser({ id: 9, email: 'third@fixture.test', stripe_customer_id: 'cus_9', stripe_subscription_id: 'sub_9', subscription_status: 'active', subscription_price_id: 'price_standard', billing_plan: 'standard' });
const members = [
  { workspace_id: 1, user_id: 7, role: 'member' },
  { workspace_id: 2, user_id: 8, role: 'owner' },
  { workspace_id: 2, user_id: 9, role: 'member' },
];
const payments = [];
const stripeEvents = new Set();
let nextPaymentId = 1;
const ACTIVE = new Set(['active', 'trialing', 'past_due']);

async function fakeQuery(sql, params = {}) {
  const s = String(sql);
  if (s.includes('INSERT INTO stripe_events')) {
    if (stripeEvents.has(params.id)) {
      throw Object.assign(new Error('UNIQUE constraint failed: stripe_events.event_id'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    }
    stripeEvents.add(params.id);
    return {};
  }
  if (s.includes('DELETE FROM stripe_events')) { stripeEvents.delete(params.id); return {}; }
  if (s.includes('SELECT id FROM payments')) {
    const row = payments.find((p) => p.stripe_invoice_id === params.iid);
    return row ? [{ id: row.id }] : [];
  }
  if (s.includes('INSERT INTO payments')) {
    const row = { id: nextPaymentId++, user_id: params.userId, stripe_invoice_id: params.invoiceId, amount_cents: params.amount, status: params.status };
    payments.push(row);
    return { insertId: row.id };
  }
  if (s.includes('SELECT id FROM users WHERE stripe_customer_id')) {
    const u = [...users.values()].find((x) => x.stripe_customer_id === params.cid);
    return u ? [{ id: u.id }] : [];
  }
  if (s.includes('SELECT id FROM users WHERE stripe_subscription_id')) {
    const u = [...users.values()].find((x) => x.stripe_subscription_id === params.sid);
    return u ? [{ id: u.id }] : [];
  }
  if (s.includes('FROM users WHERE id')) {
    const u = users.get(Number(params.id));
    return u ? [u] : [];
  }
  if (s.includes('FROM users WHERE email')) {
    const u = [...users.values()].find((x) => x.email === params.email);
    return u ? [u] : [];
  }
  if (s.includes('UPDATE users SET')) {
    const u = users.get(Number(params.id));
    if (!u) return { affectedRows: 0 };
    if (s.includes('subscription_status NOT IN')) {
      const mayWrite =
        !u.stripe_subscription_id || u.stripe_subscription_id === params.subId || !ACTIVE.has(String(u.subscription_status || ''));
      if (!mayWrite) return { affectedRows: 0 };
    }
    u.stripe_subscription_id = params.subId;
    u.subscription_status = params.status;
    u.subscription_price_id = params.priceId;
    u.billing_plan = params.plan;
    u.current_period_end = params.periodEnd;
    return { affectedRows: 1 };
  }
  if (s.includes('SELECT workspace_id FROM workspace_members')) {
    let rows = members.filter((m) => m.user_id === Number(params.uid));
    if (s.includes('ORDER BY')) rows = rows.slice(0, 1);
    return rows.map((m) => ({ workspace_id: m.workspace_id }));
  }
  if (s.includes('FROM workspace_members')) return [];
  return [];
}

/* ---------------- Stripe stub ---------------- */
const stripeSubs = new Map();
function makeSub(id, customer, userId) {
  const sub = {
    id, customer, status: 'active',
    metadata: { user_id: String(userId), plan: 'standard' },
    items: { data: [{ id: 'si_' + id, price: { id: 'price_standard' } }] },
    current_period_end: NOV27,
    cancel_at_period_end: false,
  };
  stripeSubs.set(id, sub);
  return sub;
}
makeSub('sub_7', 'cus_7', 7);
makeSub('sub_8', 'cus_8', 8);
makeSub('sub_9', 'cus_9', 9);
const stripeUpdates = [];
const stripeStub = {
  subscriptions: {
    retrieve: async (id) => {
      const s = stripeSubs.get(id);
      if (!s) throw new Error('No such subscription: ' + id);
      return s;
    },
    update: async (id, params) => {
      stripeUpdates.push({ id, params });
      const s = stripeSubs.get(id);
      Object.assign(s, params);
      return s;
    },
  },
};

/* ---------------- injected deps ---------------- */
const archiveCalls = [];
const archiveSite = (db, id) => {
  archiveCalls.push(id);
  const site = db.prepare('SELECT * FROM websites WHERE id = ?').get(id);
  if (site.archived_at) return { id, archived: true, alreadyArchived: true };
  db.prepare("UPDATE websites SET archived_at = datetime('now') WHERE id = ?").run(id);
  return { id, archived: true, alreadyArchived: false };
};
const unlinkCalls = [];
const unlinkDomain = async (db, domain) => {
  unlinkCalls.push(domain);
  db.prepare("UPDATE site_domains SET status = 'unlinked' WHERE domain_name = ?").run(domain);
  db.prepare('UPDATE websites SET custom_domain = NULL WHERE custom_domain = ?').run(domain);
  return { ok: true, domain };
};
const deps = {
  query: fakeQuery,
  openDb: (ws) => wsDb[ws],
  archiveSite,
  unlinkDomain,
  sendMail: null, // set per-scenario
};

/* ---------------- module under test ---------------- */
function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    module,
    exports: module.exports,
    require: (name) => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (!name.startsWith('.')) return require(name);
      throw new Error('Unexpected dependency: ' + name);
    },
    process: { env: {} },
    console,
    Buffer,
    URL,
    Date,
    setTimeout,
    clearTimeout,
  }, { filename: file });
  return module.exports;
}

const billing = load('server/billing.js', {
  './db': { query: fakeQuery, driver: () => 'sqlite' },
  './platform': { getPlatformSetting: async (k, fb) => fb || '' },
  './plans': require(path.join(root, 'server/plans.js')),
  // Batch 145 (F17): billing.js gained the shared invoice-shape
  // helper — a pure module, loaded for real like ./plans.
  './stripeShapes': require(path.join(root, 'server/stripeShapes.js')),
  // Batch 154 (§9): billing.js gained the deterministic Stripe
  // idempotency-key helper — also a pure module, loaded for real.
  './stripeIdempotency': require(path.join(root, 'server/stripeIdempotency.js')),
  './stripeClient': {
    getStripe: async () => stripeStub,
    getPriceIdForPlan: async (plan) => 'price_' + plan,
    getConfiguredPriceIds: async () => ({ standard: 'price_standard', pro: 'price_pro', premium: 'price_premium' }),
    planIdFromPriceId: async (id) => ({ price_standard: 'standard', price_pro: 'pro', price_premium: 'premium' })[id] || null,
    getPublishableKey: async () => '',
    integrationId: () => 'fixture',
    appUrl: () => 'https://bitpype.test',
  },
  './credits': {
    packConfig: async () => ({ priceId: '', packAmount: 0 }),
    grantFromCheckoutSession: async () => {},
    freezeWorkspaceCredits: async () => {},
    summaryForWorkspace: async () => ({}),
    clawbackFromRefund: async () => {},
  },
  './appUrls': { staffUrl: () => 'https://bitpype.test/app#/billing' },
  './referrals': { tryAwardForPaidUser: async () => {} },
  './domainFlow': { onDomainCheckoutPaid: async () => {} },
  './mailer': { sendPlatformMail: async () => ({ sent: true }) },
  './workspaceDb': { openWorkspaceDb: (ws) => wsDb[ws] },
  '../src/websiteEngine': { deleteWebsite: archiveSite },
  '../src/cfDomains': { unlinkDomain },
});

/* ---------------- scenarios ---------------- */
const results = [];
function check(name, fn) { fn(); results.push(name); }
async function acheck(name, fn) { await fn(); results.push(name); }

const sentMail = [];
deps.sendMail = async (mail) => { sentMail.push(mail); return { sent: true }; };

function cycleInvoice(id, invoiceId) {
  return {
    id: invoiceId, object: 'invoice', billing_reason: 'subscription_cycle',
    amount_paid: 9900, amount_due: 9900, currency: 'usd', status: 'paid',
    customer: 'cus_7', subscription: 'sub_7', created: OCT27, period_end: NOV27,
    number: 'INV-' + invoiceId, payment_intent: 'pi_' + invoiceId, charge: 'ch_' + invoiceId,
    lines: { data: [{ period: { start: OCT27, end: NOV27 } }] },
  };
}
const siteRow = (ws, id) => wsDb[ws].prepare('SELECT * FROM websites WHERE id = ?').get(id);
const disableRow = (ws, id) => {
  // The bookkeeping table is created lazily by the disable path itself.
  const exists = wsDb[ws]
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subscription_site_disables'")
    .get();
  if (!exists) return undefined;
  return wsDb[ws].prepare('SELECT * FROM subscription_site_disables WHERE website_id = ?').get(id);
};

async function main() {
  /* ----- 1A: cycle renewal sends exactly one renewal email ----- */
  await acheck('renewal: subscription_cycle invoice.paid emails the user once with plan, amount, next date, domain, manage link', async () => {
    const res = await billing.handleWebhookEvent(
      { id: 'evt_cycle_1', type: 'invoice.paid', data: { object: cycleInvoice(1, 'in_cycle_1') } },
      deps
    );
    assert.equal(res.ok, true);
    assert.equal(sentMail.length, 1, 'exactly one email');
    const mail = sentMail[0];
    assert.equal(mail.to, 'owner@fixture.test');
    const body = JSON.stringify(mail);
    assert.ok(body.includes('Standard'), 'plan name present');
    assert.ok(body.includes('$99.00'), 'amount paid present');
    assert.ok(body.includes('November 27, 2026'), 'next renewal date present');
    assert.ok(body.includes('owner-site.com'), 'client domain present');
    assert.ok(body.includes('stay live until November 27, 2026'), 'cancel-keeps-site-live copy present');
    assert.equal(mail.cta.url, 'https://bitpype.test/portal?panel=billing', 'durable portal billing deep link');
    assert.equal(payments.filter((p) => p.stripe_invoice_id === 'in_cycle_1').length, 1, 'payment recorded once');
  });

  /* ----- 1B: duplicates never resend ----- */
  await acheck('renewal: duplicate event id is claimed once; a redelivered invoice under a new event id still sends nothing', async () => {
    const dupEvent = await billing.handleWebhookEvent(
      { id: 'evt_cycle_1', type: 'invoice.paid', data: { object: cycleInvoice(1, 'in_cycle_1') } },
      deps
    );
    assert.equal(dupEvent.duplicate, true);
    const dupInvoice = await billing.handleWebhookEvent(
      { id: 'evt_cycle_1b', type: 'invoice.paid', data: { object: cycleInvoice(1, 'in_cycle_1') } },
      deps
    );
    assert.equal(dupInvoice.ok, true, 'redelivery processes but dedupes at the payment row');
    assert.equal(sentMail.length, 1, 'still exactly one renewal email');
    assert.equal(payments.filter((p) => p.stripe_invoice_id === 'in_cycle_1').length, 1, 'still one payment row');
  });

  /* ----- 1C: first payment is NOT a renewal ----- */
  await acheck('renewal: subscription_create invoice.paid sends NO renewal email', async () => {
    const inv = { ...cycleInvoice(2, 'in_create_1'), billing_reason: 'subscription_create' };
    const res = await billing.handleWebhookEvent(
      { id: 'evt_create_1', type: 'invoice.paid', data: { object: inv } },
      deps
    );
    assert.equal(res.ok, true);
    assert.equal(sentMail.length, 1, 'no new email for the first payment');
    assert.equal(payments.filter((p) => p.stripe_invoice_id === 'in_create_1').length, 1, 'first payment still recorded');
  });

  /* ----- 1D: mail failure never fails the webhook ----- */
  await acheck('renewal: sendMail throwing still returns webhook ok and keeps the payment', async () => {
    const failingDeps = { ...deps, sendMail: async () => { throw new Error('SMTP boom'); } };
    const res = await billing.handleWebhookEvent(
      { id: 'evt_cycle_2', type: 'invoice.paid', data: { object: cycleInvoice(3, 'in_cycle_2') } },
      failingDeps
    );
    assert.equal(res.ok, true);
    assert.equal(payments.filter((p) => p.stripe_invoice_id === 'in_cycle_2').length, 1, 'payment recorded despite mail failure');
  });

  /* ----- 2: cancel = period end, truth in the message, site untouched ----- */
  await acheck('cancel: scheduleCancelAtPeriodEnd sets cancel_at_period_end and states the date + website-stays-live truth', async () => {
    stripeUpdates.length = 0;
    const res = await billing.scheduleCancelAtPeriodEnd(7);
    assert.equal(res.action, 'cancel_at_period_end');
    assert.equal(stripeUpdates.length, 1);
    assert.equal(stripeUpdates[0].params.cancel_at_period_end, true, 'Stripe told to cancel at period end, not now');
    assert.deepEqual(Object.keys(stripeUpdates[0].params), ['cancel_at_period_end'], 'cancel call changes nothing else');
    assert.ok(res.message.includes('November 27, 2026'), 'message states the period-end date');
    assert.ok(res.message.includes('your website stays live until then'), 'message states the website stays live');
    assert.ok(res.message.includes('comes offline'), 'message states what happens after');
    assert.equal(siteRow(1, 701).archived_at, null, 'site NOT disabled by scheduling a cancel');
    assert.equal(disableRow(1, 701), undefined, 'no disable bookkeeping on cancel');
  });
  await acheck('cancel: subscription.updated (cancel_at_period_end) does NOT disable the site', async () => {
    const sub = stripeSubs.get('sub_7');
    const res = await billing.handleWebhookEvent(
      { id: 'evt_upd_1', type: 'customer.subscription.updated', data: { object: { ...sub } } },
      deps
    );
    assert.equal(res.ok, true);
    assert.equal(siteRow(1, 701).archived_at, null, 'site still live inside the paid period');
    assert.equal(siteRow(1, 702).archived_at, null, 'txn-mapped site still live too');
    assert.equal(disableRow(1, 701), undefined);
  });
  await acheck('cancel: resume clears cancel_at_period_end (reactivation path intact)', async () => {
    stripeUpdates.length = 0;
    const res = await billing.resumeSubscription(7);
    assert.equal(res.action, 'resumed');
    assert.equal(stripeUpdates[0].params.cancel_at_period_end, false);
    // Re-schedule so the deletion scenario below starts from a pending cancel.
    await billing.scheduleCancelAtPeriodEnd(7);
  });

  /* ----- 3: subscription.deleted takes the site offline, idempotently ----- */
  await acheck('end: customer.subscription.deleted archives the owner sites, unlinks domains, records prior state + reason', async () => {
    const dead = { ...stripeSubs.get('sub_7'), status: 'canceled', cancel_at_period_end: true, current_period_end: OCT27 };
    const res = await billing.handleWebhookEvent(
      { id: 'evt_del_1', type: 'customer.subscription.deleted', data: { object: dead } },
      deps
    );
    assert.equal(res.ok, true);
    assert.equal(users.get(7).billing_plan, 'free', 'plan downgraded by the existing sync');
    assert.equal(users.get(7).subscription_status, 'canceled');
    assert.ok(siteRow(1, 701).archived_at, 'lead-mapped site archived');
    assert.ok(siteRow(1, 702).archived_at, 'txn-mapped site archived');
    const rec = disableRow(1, 701);
    assert.ok(rec, 'bookkeeping row recorded');
    assert.equal(rec.reason, 'subscription_ended');
    assert.equal(rec.prior_status, 'published');
    assert.equal(rec.prior_custom_domain, 'owner-site.com');
    assert.equal(rec.subscription_id, 'sub_7');
    assert.equal(rec.user_id, 7);
    assert.ok(rec.disabled_at, 'timestamp recorded');
    assert.equal(siteRow(1, 701).custom_domain, null, 'custom domain detached');
    assert.equal(
      wsDb[1].prepare("SELECT status FROM site_domains WHERE domain_name = 'owner-site.com'").get().status,
      'unlinked',
      'domain unlinked from the Pages project'
    );
    assert.ok(unlinkCalls.includes('owner-site.com') && unlinkCalls.includes('txn-site.com'), 'both domains unlinked');
    assert.equal(siteRow(2, 801).archived_at, null, "another user's site untouched");
    assert.equal(disableRow(2, 801), undefined, 'no bookkeeping for the other user');
  });
  await acheck('end: replaying the disable is a no-op (idempotent)', async () => {
    const before701 = siteRow(1, 701).archived_at;
    const dead = { ...stripeSubs.get('sub_7'), status: 'canceled' };
    const out = await billing.disableSitesForEndedSubscription(dead, deps);
    assert.equal(out.disabled.length, 0, 'nothing disabled twice');
    assert.ok(out.skipped.some((s) => s.websiteId === 701 && s.reason === 'already_disabled'));
    assert.equal(siteRow(1, 701).archived_at, before701, 'archive stamp unchanged');
    const dupEvent = await billing.handleWebhookEvent(
      { id: 'evt_del_1', type: 'customer.subscription.deleted', data: { object: dead } },
      deps
    );
    assert.equal(dupEvent.duplicate, true, 'duplicate webhook delivery claimed once');
  });
  await acheck('end: an orphan subscription deletion disables nothing while a different live sub is tracked', async () => {
    const orphan = { id: 'sub_9_orphan', customer: 'cus_9', status: 'canceled', metadata: { user_id: '9' }, items: { data: [{ price: { id: 'price_standard' } }] }, current_period_end: OCT27 };
    const out = await billing.disableSitesForEndedSubscription(orphan, deps);
    assert.equal(out.skipped, 'other_subscription_tracked');
    assert.equal(siteRow(2, 802).archived_at, null, 'site of the still-live subscription untouched');
  });

  console.log(JSON.stringify({ file: 'billing-renewal-regressions', passed: true, checks: results.length }));
  for (const name of results) console.log('  ok -', name);
}

main().catch((e) => {
  console.error(JSON.stringify({ file: 'billing-renewal-regressions', passed: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
