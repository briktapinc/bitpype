'use strict';
/**
 * Batch 69 — domain renewal derivation done right (final-review
 * H-3, M-3, Low #11, Low #8).
 *   H-3:  a domain-flow domain's mode derives from the TRANSACTION's
 *         billing user FIRST. In the agency workspace the workspace
 *         answer is satisfied by the owner's super-admin bypass
 *         (user 1, subscription_status 'none'), so the old
 *         workspace-first derivation pinned every client domain to
 *         'auto' forever — payer cancels → still 'auto', registrar
 *         keeps charging the platform account, Batch 63's flip
 *         notice never fires. These checks run the DEFAULT
 *         derivation end-to-end against a ws1-shaped world (real
 *         billing queries against the seeded server DB).
 *   #11:  no qualifying transaction → lead-email → member-user
 *         resolution before concluding 'manual'.
 *   M-3:  a registrar list served by the legacy fallback
 *         (registrarError) is a FAILED sweep: renewal_error stamped,
 *         zero registrar writes, mode untouched.
 *   #8:   auto_renew = null is UNKNOWN (no PATCH loop, nothing
 *         persisted); a pending workflow never persists the desired
 *         state as observed; workflow links.self absolute URLs are
 *         used as-is (path), not prefixed with API_BASE.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = process.env.BITPYPE_TEST_ROOT || path.resolve(__dirname, '..');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}
const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function acheck(name, fn) {
  await fn();
  results.push(name);
}

process.env.EXPORT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bp69-exports-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bp69-server-')), 'server.db');
process.env.WORKSPACE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bp69-ws-'));

const engine = require(path.join(root, 'src/websiteEngine.js'));
const cfDomains = require(path.join(root, 'src/cfDomains.js'));
const renewals = require(path.join(root, 'server/domainRenewals.js'));
const serverDb = require(path.join(root, 'server/db.js'));
const { query } = serverDb;

/* ---------------- fixtures ---------------- */

const TXN_DDL = `
  CREATE TABLE IF NOT EXISTS domain_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    website_id INTEGER,
    domain TEXT NOT NULL,
    registrar_price_cents INTEGER,
    registrar_currency TEXT DEFAULT 'USD',
    plan_id TEXT NOT NULL,
    billing_user_id INTEGER,
    stripe_session_id TEXT,
    stripe_subscription_id TEXT,
    stripe_customer_id TEXT,
    amount_paid_cents INTEGER,
    status TEXT NOT NULL DEFAULT 'pending_payment',
    error TEXT,
    steps_json TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT,
    completed_at TEXT
  );`;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  engine.ensureTables(db);
  try { cfDomains.ensureTables(db); } catch { /* optional */ }
  db.exec(TXN_DDL);
  return db;
}

function siteDb({ leadId, email, domain, mode = null, autoRenew = null, expiresAt = null, txn = null }) {
  const db = makeDb();
  db.prepare(`INSERT INTO leads (id, business_name, email) VALUES (?, 'Fixture Co', ?)`).run(leadId, email);
  db.prepare(
    `INSERT INTO websites (id, lead_id, name, industry, theme, pages, status, updated_at)
     VALUES (?, ?, 'Fixture Co', 'widgets', '{}', '[]', 'live', '2026-10-01 00:00:00')`
  ).run(leadId, leadId);
  db.prepare(
    `INSERT INTO site_domains (website_id, lead_id, domain_name, status, source, renewal_mode, renewal_auto_renew, expires_at)
     VALUES (?, ?, ?, 'linked', 'registrar', ?, ?, ?)`
  ).run(leadId, leadId, domain, mode, autoRenew == null ? null : autoRenew ? 1 : 0, expiresAt);
  if (txn) {
    db.prepare(
      `INSERT INTO domain_transactions (lead_id, website_id, domain, plan_id, billing_user_id, status)
       VALUES (?, ?, ?, 'standard', ?, ?)`
    ).run(leadId, leadId, domain, txn.billingUserId, txn.status);
  }
  return db;
}

function cfMocks(registrar, calls) {
  return {
    listRegistrations: async () => ({ domains: registrar, source: 'registrations' }),
    setRegistrationAutoRenew: async (db, domain, val) => {
      calls.push({ domain, val });
      const reg = registrar.find((r) => r.domain === domain);
      if (reg) reg.autoRenew = val;
      return { domain, autoRenew: val, state: 'succeeded', pending: false };
    },
  };
}

async function seedServerWorld() {
  await serverDb.migrate();
  const addWs = (id) =>
    query(`INSERT INTO workspaces (id, name, slug) VALUES (:id, :name, :slug)`, {
      id, name: `WS ${id}`, slug: `ws-${id}`,
    });
  const addUser = (u) =>
    query(
      `INSERT INTO users (id, email, password_hash, name, is_super_admin, status, subscription_status, stripe_customer_id, stripe_subscription_id, billing_plan)
       VALUES (:id, :email, 'x', '', :sa, 'active', :sub, :cus, :subid, 'standard')`,
      {
        id: u.id, email: u.email, sa: u.superAdmin ? 1 : 0,
        sub: u.subscriptionStatus, cus: u.customer || null, subid: u.subscriptionId || null,
      }
    );
  const addMember = (ws, uid, role) =>
    query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (:ws, :uid, :role)`, { ws, uid, role });
  // ws1 shape: super-admin owner (subscription_status 'none'), client payer as plain member.
  await addWs(69); await addWs(70); await addWs(71); await addWs(72); await addWs(73);
  await addUser({ id: 1, email: 'agency@fixture.example', superAdmin: true, subscriptionStatus: 'none' });
  await addUser({ id: 5, email: 'client@fixture.example', subscriptionStatus: 'active', customer: 'cus_5', subscriptionId: 'sub_client5' });
  await addUser({ id: 7, email: 'freeowner@fixture.example', subscriptionStatus: 'none' });
  await addUser({ id: 8, email: 'portal@fixture.example', subscriptionStatus: 'active' });
  await addUser({ id: 9, email: 'eventclient@fixture.example', subscriptionStatus: 'active', customer: 'cus_9', subscriptionId: 'sub_9' });
  await addMember(69, 1, 'owner'); await addMember(69, 5, 'member');
  await addMember(70, 1, 'owner');
  await addMember(71, 7, 'owner');
  await addMember(72, 8, 'member');
  await addMember(73, 1, 'owner'); await addMember(73, 9, 'member');
}

async function setUserSub(userId, status) {
  await query(`UPDATE users SET subscription_status = :s WHERE id = :id`, { s: status, id: userId });
}

function domainRow(db, domain) {
  return db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get(domain);
}

/* ---------------- checks ---------------- */

async function main() {
  await seedServerWorld();

  // E2 (Berks-shaped pin) — payer active ⇒ 'auto' even when the
  // workspace answer is FALSE. Only the payer can produce 'auto'
  // here, which pins the derivation source.
  await setUserSub(5, 'active');
  {
    const calls = [];
    const registrar = [{ domain: 'dumpsterrentalreadingberks.com', status: 'active', expiresAt: '2027-10-28T00:00:00Z', autoRenew: false }];
    const db = siteDb({
      leadId: 6902, email: 'berks-lead@fixture.example', domain: 'dumpsterrentalreadingberks.com',
      mode: null, autoRenew: null, expiresAt: '2027-10-28T00:00:00Z',
      txn: { billingUserId: 5, status: 'live' },
    });
    const r = await renewals.reconcileWorkspace(db, 69, {
      ...cfMocks(registrar, calls),
      workspaceSubscribed: async () => false,
    });
    check('E2 Berks pin: payer active ⇒ auto (payer is the derivation source)', () => {
      assert.equal(r.domains[0].mode, 'auto');
      assert.deepEqual(calls, [{ domain: 'dumpsterrentalreadingberks.com', val: true }]);
      assert.equal(domainRow(db, 'dumpsterrentalreadingberks.com').renewal_mode, 'auto');
    });
  }

  // E1 (H-3) — ws1 shape end-to-end with ALL billing defaults: the
  // workspace check resolves TRUE via the super-admin bypass, yet
  // the payer decides. Payer active → 'auto'; payer's subscription
  // deleted → 'manual' + registrar OFF + Batch 63 flip notice.
  {
    const calls = [];
    const events = [];
    const registrar = [{ domain: 'client-domain.example', status: 'active', expiresAt: '2027-10-28T00:00:00Z', autoRenew: true }];
    const db = siteDb({
      leadId: 6901, email: 'unrelated-lead@fixture.example', domain: 'client-domain.example',
      mode: 'auto', autoRenew: true, expiresAt: '2027-10-28T00:00:00Z',
      txn: { billingUserId: 5, status: 'live' },
    });
    const deps = {
      ...cfMocks(registrar, calls),
      notifyDomainEvent: async (d, ws, ev) => { events.push(ev); },
      // NO workspaceSubscribed / domainBillingUser deps: the defaults
      // run against the seeded server DB (workspace = super-admin
      // bypass TRUE; payer = user 5).
    };
    const r1 = await renewals.reconcileWorkspace(db, 69, deps);
    check('E1a H-3: payer active ⇒ auto (registrar already on, no PATCH)', () => {
      assert.equal(r1.domains[0].mode, 'auto');
      assert.equal(calls.length, 0);
    });
    await setUserSub(5, 'canceled'); // customer.subscription.deleted landed
    const r2 = await renewals.reconcileWorkspace(db, 69, deps);
    check('E1b H-3: payer subscription deleted ⇒ manual + OFF + flip notice (workspace bypass must NOT rescue it)', () => {
      assert.equal(r2.domains[0].mode, 'manual');
      assert.deepEqual(calls, [{ domain: 'client-domain.example', val: false }]);
      const row = domainRow(db, 'client-domain.example');
      assert.equal(row.renewal_mode, 'manual');
      assert.equal(row.renewal_auto_renew, 0);
      assert.ok(events.some((e) => e.type === 'flip' && e.domain === 'client-domain.example'),
        `flip notice must fire, got ${JSON.stringify(events)}`);
    });
    await setUserSub(5, 'active');
  }

  // E3 — deriveDomainMode unit: an unsubscribed payer beats a TRUE
  // workspace value; a subscribed payer beats a FALSE one.
  {
    const db = makeDb();
    const row = { domain_name: 'unit.example', lead_id: null };
    const manual = await renewals.deriveDomainMode(db, 69, row, {
      domainBillingUser: async () => ({ userId: 5, subscribed: false }),
      workspaceSubscribedValue: true,
    });
    const auto = await renewals.deriveDomainMode(db, 69, row, {
      domainBillingUser: async () => ({ userId: 5, subscribed: true }),
      workspaceSubscribedValue: false,
    });
    check('E3 deriveDomainMode: payer verdict wins over the workspace value both ways', () => {
      assert.equal(manual, 'manual');
      assert.equal(auto, 'auto');
    });
  }

  // E4 — Ely-own fallback: no transaction, lead email matches no
  // user → the workspace rule decides exactly as before (super-admin
  // owner's own domain 'auto'; a free owner's domain 'manual').
  {
    const callsA = [];
    const regA = [{ domain: 'agency-own.example', status: 'active', expiresAt: '2027-01-01T00:00:00Z', autoRenew: true }];
    const dbA = siteDb({ leadId: 7001, email: 'nobody@fixture.example', domain: 'agency-own.example', mode: null, autoRenew: true });
    const rA = await renewals.reconcileWorkspace(dbA, 70, { ...cfMocks(regA, callsA) });
    const callsB = [];
    const regB = [{ domain: 'free-own.example', status: 'active', expiresAt: '2027-01-01T00:00:00Z', autoRenew: true }];
    const dbB = siteDb({ leadId: 7101, email: 'nobody2@fixture.example', domain: 'free-own.example', mode: null, autoRenew: true });
    const rB = await renewals.reconcileWorkspace(dbB, 71, { ...cfMocks(regB, callsB) });
    check('E4 fallback preserved: no payer + no lead match ⇒ workspace rule (agency own auto / free owner manual)', () => {
      assert.equal(rA.domains[0].mode, 'auto');
      assert.equal(callsA.length, 0);
      assert.equal(rB.domains[0].mode, 'manual');
      assert.deepEqual(callsB, [{ domain: 'free-own.example', val: false }]);
    });
  }

  // E5 (Low #11) — subscribed portal owner, domain has only a VOIDED
  // transaction (not qualifying). The owner is a plain MEMBER, so the
  // workspace owner/admin check is false; only the lead-email
  // resolution can produce 'auto'. Owner cancels → 'manual'.
  {
    await setUserSub(8, 'active');
    const calls = [];
    const registrar = [{ domain: 'admin-reg.example', status: 'active', expiresAt: '2027-06-01T00:00:00Z', autoRenew: false }];
    const db = siteDb({
      leadId: 7201, email: 'portal@fixture.example', domain: 'admin-reg.example',
      mode: null, autoRenew: false, expiresAt: '2027-06-01T00:00:00Z',
      txn: { billingUserId: 8, status: 'void' },
    });
    const r1 = await renewals.reconcileWorkspace(db, 72, { ...cfMocks(registrar, calls) });
    check('E5a Low #11: subscribed portal owner resolved via lead email ⇒ auto', () => {
      assert.equal(r1.domains[0].mode, 'auto');
      assert.deepEqual(calls, [{ domain: 'admin-reg.example', val: true }]);
    });
    await setUserSub(8, 'canceled');
    const r2 = await renewals.reconcileWorkspace(db, 72, { ...cfMocks(registrar, calls) });
    check('E5b Low #11: lead-email owner unsubscribed ⇒ manual (resolution decides, not just rescues)', () => {
      assert.equal(r2.domains[0].mode, 'manual');
      assert.deepEqual(calls[1], { domain: 'admin-reg.example', val: false });
    });
    await setUserSub(8, 'active');
  }

  // E6 (M-3) — legacy-served registrar list = failed sweep.
  {
    const calls = [];
    const db = siteDb({
      leadId: 7401, email: 'deg@fixture.example', domain: 'degraded.example',
      mode: 'auto', autoRenew: true, expiresAt: '2027-01-01T00:00:00Z',
    });
    const r = await renewals.reconcileWorkspace(db, 70, {
      listRegistrations: async () => ({ domains: [], source: 'legacy', registrarError: 'registrations exploded (HTTP 500)' }),
      setRegistrationAutoRenew: async (d, domain, val) => { calls.push({ domain, val }); return { autoRenew: val, pending: false }; },
      workspaceSubscribed: async () => true,
    });
    check('E6 M-3: legacy fallback stamps renewal_error, zero registrar writes, mode untouched', () => {
      assert.ok(r.error && r.error.includes('legacy fallback not trusted'), `error surfaced: ${r.error}`);
      assert.equal(r.source, 'legacy');
      assert.equal(r.domains.length, 0);
      assert.equal(calls.length, 0);
      const row = domainRow(db, 'degraded.example');
      assert.ok(row.renewal_error && row.renewal_error.includes('registrations exploded'), 'renewal_error stamped');
      assert.equal(row.renewal_mode, 'auto', 'stored mode not rewritten by a degraded sweep');
    });
  }

  // E6b (M-3) — source pin: the legacy fallback carries the flag.
  check('E6b M-3 source pin: listRegistrations legacy return carries registrarError', () => {
    const src = fs.readFileSync(path.join(root, 'src/cfDomains.js'), 'utf8');
    assert.ok(src.includes("source: 'legacy'"), 'legacy source labelled');
    assert.ok(src.includes('registrarError'), 'registrarError propagated, not swallowed');
  });

  // E7 (Low #8) — auto_renew null is UNKNOWN: no PATCH on either of
  // two sweeps, nothing persisted, mode still recorded.
  {
    const calls = [];
    const registrar = [{ domain: 'unknown-state.example', status: 'active', expiresAt: '2027-01-01T00:00:00Z', autoRenew: null }];
    const db = siteDb({ leadId: 7501, email: 'unk@fixture.example', domain: 'unknown-state.example', mode: null, autoRenew: null });
    const deps = { ...cfMocks(registrar, calls), workspaceSubscribed: async () => true };
    const r1 = await renewals.reconcileWorkspace(db, 70, deps);
    const r2 = await renewals.reconcileWorkspace(db, 70, deps);
    check('E7 Low #8: auto_renew=null ⇒ unknown, no PATCH loop, desired state never persisted', () => {
      assert.equal(calls.length, 0, 'no PATCH across two sweeps');
      assert.equal(r1.domains[0].autoRenewUnknown, true);
      assert.equal(r1.domains[0].changed, false);
      assert.equal(r2.domains[0].changed, false);
      const row = domainRow(db, 'unknown-state.example');
      assert.equal(row.renewal_auto_renew, null, 'unknown stays unknown in storage');
      assert.equal(row.renewal_mode, 'auto', 'mode derivation still recorded');
    });
  }

  // E8 (Low #8) — a pending workflow does not persist the desired
  // state; the next sweep observes the completed state write-free.
  {
    const calls = [];
    const registrar = [{ domain: 'pending-state.example', status: 'active', expiresAt: '2027-01-01T00:00:00Z', autoRenew: false }];
    const db = siteDb({
      leadId: 7601, email: 'pen@fixture.example', domain: 'pending-state.example',
      mode: 'auto', autoRenew: false, expiresAt: '2027-01-01T00:00:00Z',
    });
    const r1 = await renewals.reconcileWorkspace(db, 70, {
      listRegistrations: async () => ({ domains: registrar, source: 'registrations' }),
      setRegistrationAutoRenew: async (d, domain, val) => {
        calls.push({ domain, val });
        return { domain, autoRenew: val, state: 'running', pending: true }; // registrar has NOT applied it yet
      },
      workspaceSubscribed: async () => true,
    });
    check('E8a Low #8: pending workflow ⇒ stored state stays at the last observed value', () => {
      assert.equal(r1.domains[0].pending, true);
      assert.equal(r1.domains[0].registrarAutoRenewAfter, false);
      assert.equal(domainRow(db, 'pending-state.example').renewal_auto_renew, 0);
    });
    registrar[0].autoRenew = true; // workflow completed between sweeps
    const r2 = await renewals.reconcileWorkspace(db, 70, {
      ...cfMocks(registrar, calls),
      workspaceSubscribed: async () => true,
    });
    check('E8b Low #8: completed workflow observed next sweep with no second PATCH', () => {
      assert.equal(calls.length, 1, 'exactly one PATCH overall');
      assert.equal(r2.domains[0].registrarAutoRenewAfter, true);
      assert.equal(domainRow(db, 'pending-state.example').renewal_auto_renew, 1);
    });
  }

  // E9 (Low #8) — workflowSelfPath: absolute links.self used as-is.
  check('E9 Low #8: workflowSelfPath handles absolute / bare / pre-based self links', () => {
    assert.equal(
      cfDomains.workflowSelfPath('https://api.cloudflare.com/client/v4/accounts/ACC/registrar/workflows/WF'),
      '/client/v4/accounts/ACC/registrar/workflows/WF'
    );
    assert.equal(
      cfDomains.workflowSelfPath('https://api.cloudflare.com/client/v4/accounts/ACC/registrar/workflows/WF?foo=bar'),
      '/client/v4/accounts/ACC/registrar/workflows/WF?foo=bar'
    );
    assert.equal(cfDomains.workflowSelfPath('/accounts/ACC/registrar/workflows/WF'), '/client/v4/accounts/ACC/registrar/workflows/WF');
    assert.equal(cfDomains.workflowSelfPath('/client/v4/accounts/ACC/registrar/workflows/WF'), '/client/v4/accounts/ACC/registrar/workflows/WF');
  });

  // E10 (H-3 event path) — customer.subscription.deleted for the
  // payer reconciles through the DEFAULT user/workspace resolution
  // and flips the domain, firing the Batch 63 notice hook.
  {
    await setUserSub(9, 'active');
    const calls = [];
    const events = [];
    const registrar = [{ domain: 'event-domain.example', status: 'active', expiresAt: '2027-03-01T00:00:00Z', autoRenew: true }];
    const db = siteDb({
      leadId: 7301, email: 'eventlead@fixture.example', domain: 'event-domain.example',
      mode: 'auto', autoRenew: true, expiresAt: '2027-03-01T00:00:00Z',
      txn: { billingUserId: 9, status: 'live' },
    });
    const cfDeps = cfMocks(registrar, calls);
    await renewals.reconcileWorkspace(db, 73, { ...cfDeps, notifyDomainEvent: async (d, ws, ev) => { events.push(ev); } });
    await setUserSub(9, 'canceled');
    const r = await renewals.reconcileForSubscriptionEvent(
      { id: 'sub_9', customer: 'cus_9', metadata: { user_id: '9' } },
      'customer.subscription.deleted',
      {
        openDb: () => db,
        ...cfDeps,
        notifyDomainEvent: async (d, ws, ev) => { events.push(ev); },
      }
    );
    check('E10 H-3 event path: subscription.deleted flips the payer domain + notice fires', () => {
      assert.equal(r.domains.length, 1);
      assert.equal(r.domains[0].mode, 'manual');
      assert.deepEqual(calls, [{ domain: 'event-domain.example', val: false }]);
      assert.ok(events.some((e) => e.type === 'flip' && e.domain === 'event-domain.example'),
        `flip notice must fire on the event path, got ${JSON.stringify(events)}`);
    });
  }

  console.log(`batch69-renewal-derivation-regressions: ${results.length} checks passed`);
  for (const r of results) console.log(`  ✓ ${r}`);
}

main().catch((e) => {
  console.error('batch69-renewal-derivation-regressions FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
