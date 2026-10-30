'use strict';
/**
 * Batch 80 — Creator Partner program (Ely's terms, 2026-10-30).
 *
 * What shipped:
 *   - `partner` joins the user-type system: portalTabs USER_TYPES
 *     gains 'partner' with owner-equal factory defaults (admin
 *     defaults + per-user overrides apply unchanged), and platform
 *     staff users carry users.account_type = 'partner' (admin-created
 *     only — registration stays closed; there is no self-serve
 *     partner signup).
 *   - A partner works the staff app inside their OWN workspace only
 *     (membership scoping), can NEVER write settings (coded 403
 *     PARTNER_SETTINGS_FORBIDDEN on every settings choke point, REST
 *     + MCP), and platform-admin surfaces stay super-admin-only.
 *   - PURCHASE APPROVAL GATE: partner-initiated purchases create an
 *     approval request and execute NOTHING — domain_register,
 *     call_number_purchase, credits_checkout, domain_flow_complete,
 *     hostinger_deploy. Admin approve → the stored action executes;
 *     deny → closed, decision recorded.
 *   - EARNINGS: 30% (platform setting partners.commission_percent)
 *     of the subscription portion of every payment collected from
 *     customers in the partner's workspace, credited from the
 *     invoice.paid webhook branch, exactly once per invoice (UNIQUE
 *     credit_key). Refunds reverse proportionally; disputes reverse
 *     in full. Free ($0) payments credit nothing.
 *   - PAYOUTS: monthly, manual; eligible at a $500 accrued balance;
 *     admin records a payout (the app records it — money moves
 *     outside); gross — partners handle their own taxes.
 *   - Pages: /partner (application form → ws1 leads, source
 *     'partner-app', group 'Partner', tag 'partner-app'; NOT
 *     Hostinger-deploy-eligible) and /work-with-us (hub with four
 *     side-photo persona cards), both served by dedicated senders
 *     with the Batch 75 disclaimer injected; "Work with us" footer
 *     link across the marketing pages.
 *
 * Harness: unit checks + in-process webhook/facade flows + HTTP
 * tests against the real server booted on temp DBs (batch53/79
 * patterns). No live server, no real leads, no real money.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b80-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch80', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 11).toString('base64');

const PORT = 31480;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = ['batch80', 'fixture', 'password'].join('-');

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}

/* ===================================================================== */
/* Part A — static / unit checks                                          */
/* ===================================================================== */

function partA() {
  check('user types: partner registered with owner-equal factory defaults', () => {
    const pt = require(path.join(root, 'server', 'portalTabs.js'));
    assert.deepEqual(pt.USER_TYPES, ['owner', 'renter', 'partner']);
    assert.deepEqual(pt.FACTORY_DEFAULTS.tabs.partner, pt.FACTORY_DEFAULTS.tabs.owner);
    assert.deepEqual(pt.FACTORY_DEFAULTS.modules.partner, pt.FACTORY_DEFAULTS.modules.owner);
    assert.equal(pt.normalizeUserType('partner'), 'partner');
    assert.equal(pt.normalizeUserType('PARTNER'), 'partner');
    assert.equal(pt.isOwnerTier('partner'), true);
    assert.equal(pt.isOwnerTier('owner'), true);
    assert.equal(pt.isOwnerTier('renter'), false);
    const resolved = pt.resolveTypeDefaults(null);
    assert.deepEqual(resolved.tabs.partner, pt.FACTORY_DEFAULTS.tabs.partner, 'partner slice resolves from factory');
    const custom = pt.resolveTypeDefaults({ partner: { tabs: ['website'], modules: ['blog'] } });
    assert.deepEqual(custom.tabs.partner, ['website'], 'admin-configured partner defaults are honored');
    assert.deepEqual(custom.modules.partner, ['blog']);
  });

  check('partners math: commission + recurring-base extraction', () => {
    const partners = require(path.join(root, 'server', 'partners.js'));
    assert.equal(partners.commissionFor(9900, 30), 2970);
    assert.equal(partners.commissionFor(0, 30), 0);
    assert.equal(partners.commissionFor(1046, 30), 314);
    assert.equal(partners.PAYOUT_THRESHOLD_CENTS, 50000);
    const inv = {
      amount_paid: 10946,
      lines: {
        data: [
          { amount: 9900, price: { recurring: { interval: 'month' } } },
          { amount: 1046, price: null },
        ],
      },
    };
    assert.equal(partners.recurringBaseCents(inv), 9900, 'one-time domain line excluded');
    assert.equal(partners.recurringBaseCents({ amount_paid: 9900 }), 9900, 'no-lines fallback = amount_paid');
    assert.equal(partners.recurringBaseCents({ amount_paid: 0, lines: { data: [] } }), 0);
    assert.ok(partners.ACTION_KINDS.includes('domain_register'));
    assert.ok(partners.ACTION_KINDS.includes('hostinger_deploy'));
  });

  check('page: partner.html carries the free pitch, the terms and every form field', () => {
    const html = fs.readFileSync(path.join(root, 'public', 'partner.html'), 'utf8');
    assert.ok(html.includes('{{PUBLIC_URL}}') && html.includes('{{SUPPORT_EMAIL}}'), 'serve-time tokens');
    assert.ok(html.includes('30% of every monthly payment'), 'the 30% offer');
    assert.ok(html.includes('$500'), 'payout threshold');
    assert.ok(html.includes('Example math — not an earnings promise'), 'example-math note, visible');
    assert.ok(html.includes('BitPype does not guarantee customers, revenue or income'), 'no-guarantee sentence');
    assert.ok(html.includes('responsible for your own taxes'), 'gross payouts / own taxes');
    assert.ok(html.includes('You support your customers') || html.includes('You are their person'), 'partner supports own customers');
    assert.ok(html.includes('standard BitPype plans'), 'standard catalog');
    assert.ok(html.includes('double-checked') && html.includes('approved by our team'), 'purchase approval framing');
    assert.ok(html.includes('Want your own instance and 100%?'), 'Solo contrast');
    assert.ok(html.includes('href="/creator"') && html.includes('href="/solo"'), 'Solo links');
    assert.ok(html.includes('href="/work-with-us"'), 'footer hub link');
    for (const f of ['name="fullName"', 'name="email"', 'name="platform"', 'name="followerRange"', 'name="niche"', 'name="audience"', 'name="phone"']) {
      assert.ok(html.includes(f), `field ${f}`);
    }
    assert.ok(html.includes('/api/v1/partner/submit'), 'posts to the partner route');
    assert.ok(html.includes('/js/captcha.js'), 'shared Turnstile helper');
    assert.ok(!/what partners say|★★|★{2,}/i.test(html), 'no invented social proof');
  });

  check('page: work-with-us.html hubs all four opportunities with side photos', () => {
    const html = fs.readFileSync(path.join(root, 'public', 'work-with-us.html'), 'utf8');
    for (const href of ['href="/partner"', 'href="/creator"', 'href="/solo"', 'href="/landing"']) {
      assert.ok(html.includes(href), `persona CTA ${href}`);
    }
    for (const img of ['work-partner.jpg', 'work-creator.jpg', 'work-solo.jpg', 'work-software.jpg']) {
      assert.ok(html.includes(`/brand/${img}`), `photo ${img}`);
      const file = path.join(root, 'public', 'brand', img);
      assert.ok(fs.existsSync(file) && fs.statSync(file).size > 20000, `${img} is a real compressed asset`);
    }
    assert.ok(html.includes('30%'), 'partner share stated');
    assert.ok(html.includes('keep 100%'), 'creator keep-100% stated');
    assert.ok(html.includes('$1,999/month'), 'Solo price stated');
    assert.ok(html.includes('href="/work-with-us"'), 'footer hub link (self)');
  });

  check('footer: "Work with us" link present across the marketing pages', () => {
    for (const f of ['home.html', 'landing.html', 'solo.html', 'creator.html', 'partner.html', 'work-with-us.html', 'how-it-works.html', 'thankyou.html', 'how.html']) {
      const html = fs.readFileSync(path.join(root, 'public', f), 'utf8');
      assert.ok(html.includes('href="/work-with-us"'), `${f} footer link`);
    }
    const solo = fs.readFileSync(path.join(root, 'public', 'solo.html'), 'utf8');
    assert.equal(solo.split('href="/creator"').length - 1, 1, 'solo still carries exactly one /creator link (Batch 79 pin)');
  });

  check('wiring: server mounts + senders, SPA surfaces, admin account type', () => {
    const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(serverSrc.includes("app.use('/api/v1/partner', partnerRoutes)"), 'application API mounted');
    assert.ok(serverSrc.includes("app.use('/api/v1/partners', partnersRoutes)"), 'partner session API mounted');
    assert.ok(serverSrc.includes('sendPartnerPage') && serverSrc.includes('sendWorkWithUsPage'), 'dedicated senders');
    assert.ok(serverSrc.includes("app.get(['/partner', '/partner/']"), 'partner page route');
    assert.ok(serverSrc.includes("app.get(['/work-with-us', '/work-with-us/']"), 'hub page route');
    const routeSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'partner.js'), 'utf8');
    assert.ok(routeSrc.includes("source: 'partner-app'"), 'lead marker');
    assert.ok(routeSrc.includes("lead_group: 'Partner'") && routeSrc.includes("'partner-app'"), 'group + tag markers');
    assert.ok(routeSrc.includes('partner_application'), 'fold event type');
    const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
    assert.ok(appJs.includes('pagePartnerEarnings'), 'partner earnings page');
    assert.ok(appJs.includes("'partner-earnings': pagePartnerEarnings"), 'PAGES entry');
    assert.ok(appJs.includes('renderAdminPartners') && appJs.includes('renderAdminApprovals'), 'admin partners + approvals tabs');
    assert.ok(appJs.includes('data-toggle-partner'), 'users-table partner toggle');
    const navGroups = fs.readFileSync(path.join(root, 'public', 'js', 'navGroups.js'), 'utf8');
    assert.ok(navGroups.includes("'partner-earnings'"), 'nav group entry');
    const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('data-route="partner-earnings"'), 'sidebar anchor');
    const adminJs = fs.readFileSync(path.join(root, 'server', 'admin.js'), 'utf8');
    assert.ok(adminJs.includes('account_type'), 'admin user management carries account_type');
    // Dialect guard (live-proof find, Batch 80): db.driver is a
    // FUNCTION — partners.js must call it. Comparing the function
    // itself silently took the SQLite DDL branch on MySQL.
    const partnersSrc = fs.readFileSync(path.join(root, 'server', 'partners.js'), 'utf8');
    assert.ok(partnersSrc.includes("driver() === 'mysql'"), 'partners dialect check calls driver()');
    assert.ok(!/[^.]driver ===/.test(partnersSrc), 'no bare driver comparison remains');
  });

  check('deploy eligibility: a partner-app lead is NOT deploy-eligible (Batch 68 rule)', () => {
    const hd = require(path.join(root, 'server', 'hostingerDeploy.js'));
    assert.equal(hd.isSoftwareInterestLead({ source: 'partner-app', lead_group: 'Partner', tags: ['partner-app'] }), false);
    assert.equal(hd.isSoftwareInterestLead({ source: 'landing-software' }), true, 'sanity: the real marker still qualifies');
  });
}

/* ===================================================================== */
/* Part B — in-process: fixtures, earnings ledger, facade gates           */
/* ===================================================================== */

const F = {}; // fixture ids, filled by partB

async function partB() {
  const bcrypt = require('bcryptjs');
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const admin = require(path.join(root, 'server/admin.js'));
  const partners = require(path.join(root, 'server/partners.js'));
  const billing = require(path.join(root, 'server/billing.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const domainFlow = require(path.join(root, 'server/domainFlow.js'));

  // Workspace 1 = the application inbox workspace (batch79 pattern).
  await platformDb.query("INSERT INTO workspaces (id, name, slug) VALUES (1, 'Batch80 Inbox', 'batch80-inbox')");

  // Super admin (platform operator).
  const sa = await workspace.createUserWithWorkspace({
    email: 'super80@example.invalid',
    password: PW,
    name: 'Batch80 Super',
    workspaceName: 'Batch80 HQ',
  });
  F.superAdminId = Number(sa.userId);
  F.hqWorkspaceId = Number(sa.workspaceId);
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE id = :id', { id: F.superAdminId });

  // The partner — created the ONLY way a partner can be: by an admin.
  const pc = await admin.createUser({
    email: 'partner80@example.invalid',
    password: PW,
    name: 'Batch80 Partner',
    workspaceName: 'Partner80 Workspace',
    accountType: 'partner',
  });
  F.partnerId = Number(pc.userId);
  F.partnerWorkspaceId = Number(pc.workspaceId);

  // A second partner with a fresh, empty workspace (paywall proof).
  const p2 = await admin.createUser({
    email: 'partner80b@example.invalid',
    password: PW,
    name: 'Batch80 Partner Two',
    workspaceName: 'Partner80 Fresh',
    accountType: 'partner',
  });
  F.partner2Id = Number(p2.userId);
  F.partner2WorkspaceId = Number(p2.workspaceId);

  // Control: a standard (non-partner) OWNER inside the partner's
  // workspace — same role, different account type.
  const hash = (pw) => bcrypt.hashSync(pw, 12);
  const mkUser = async (email, name, wsId, role, extra = {}) => {
    const ins = await platformDb.query(
      'INSERT INTO users (email, password_hash, name, is_super_admin, status, stripe_customer_id) VALUES (:e, :h, :n, 0, :s, :cus)',
      { e: email, h: hash(PW), n: name, s: 'active', cus: extra.stripeCustomerId || null }
    );
    const uid = Number(ins.insertId);
    if (wsId) {
      await platformDb.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (:w, :u, :r)', {
        w: wsId,
        u: uid,
        r: role,
      });
    }
    return uid;
  };
  F.controlId = await mkUser('control80@example.invalid', 'Batch80 Control', F.partnerWorkspaceId, 'owner');
  // The partner workspace's paying customer (domain-flow shape: a
  // platform user + member of the workspace).
  F.customerId = await mkUser('customer80@example.invalid', 'Batch80 Customer', F.partnerWorkspaceId, 'member', {
    stripeCustomerId: 'cus_b80',
  });
  // A customer of a DIFFERENT (partnerless) workspace.
  F.otherCustomerId = await mkUser('other80@example.invalid', 'Batch80 Outsider', F.hqWorkspaceId, 'member', {
    stripeCustomerId: 'cus_b80_other',
  });

  // Partner-workspace fixtures: a lead + the attribution spine (a
  // domain transaction naming the subscription + the billing user).
  const pwdb = openWorkspaceDb(F.partnerWorkspaceId);
  domainFlow.ensureTables(pwdb);
  const leadIns = pwdb
    .prepare("INSERT INTO leads (business_name, email, status) VALUES ('Partner80 Biz', 'biz80@example.invalid', 'new')")
    .run();
  F.partnerLeadId = Number(leadIns.lastInsertRowid);
  pwdb
    .prepare(
      `INSERT INTO domain_transactions (lead_id, domain, plan_id, billing_user_id, stripe_subscription_id, stripe_customer_id, status)
       VALUES (?, 'customer80.example', 'standard', ?, 'sub_b80', 'cus_b80', 'paid')`
    )
    .run(F.partnerLeadId, F.customerId);
  F.partnerDb = pwdb;

  await checkAsync('fixtures: partner classification + admin-created accounts', async () => {
    assert.equal(await partners.getAccountType(F.partnerId), 'partner');
    assert.equal(await partners.isPartnerUser(F.partnerId), true);
    assert.equal(await partners.isPartnerUser(F.controlId), false);
    const row = await partners.partnerOfWorkspace(F.partnerWorkspaceId);
    assert.equal(Number(row.id), F.partnerId, 'partnerOfWorkspace resolves the partner');
    assert.equal(await partners.partnerOfWorkspace(F.hqWorkspaceId), null, 'HQ workspace has no partner');
    assert.equal(await partners.commissionRatePercent(), 30, 'default commission rate is 30');
  });

  const RECURRING = [{ amount: 9900, price: { recurring: { interval: 'month' } } }];
  const MIXED = [...RECURRING, { amount: 1046, price: null }];

  await checkAsync('earnings: domain-flow invoice credits 30% of the subscription portion only', async () => {
    const pay = await platformDb.query(
      `INSERT INTO payments (user_id, stripe_invoice_id, stripe_charge_id, amount_cents, currency, status)
       VALUES (:u, 'in_80_1', 'ch_80_1', 10946, 'usd', 'succeeded')`,
      { u: F.customerId }
    );
    const out = await partners.creditForInvoicePaid(
      { id: 'in_80_1', subscription: 'sub_b80', amount_paid: 10946, currency: 'usd', charge: 'ch_80_1', lines: { data: MIXED } },
      { paymentId: Number(pay.insertId) }
    );
    assert.equal(out.credited, true, JSON.stringify(out));
    assert.equal(out.amountCents, 2970, '30% of $99.00 — the $10.46 domain line earns nothing');
    assert.equal(await partners.balanceCents(F.partnerId), 2970);
  });

  await checkAsync('earnings: replaying the same invoice credits nothing twice (credit_key claim)', async () => {
    const out = await partners.creditForInvoicePaid(
      { id: 'in_80_1', subscription: 'sub_b80', amount_paid: 10946, currency: 'usd', charge: 'ch_80_1', lines: { data: MIXED } },
      {}
    );
    assert.equal(out.credited, false);
    assert.equal(out.duplicate, true);
    assert.equal(await partners.balanceCents(F.partnerId), 2970);
  });

  await checkAsync('earnings: the real webhook path credits via membership fallback, exactly once per invoice', async () => {
    const evt = {
      id: 'evt_80_1',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_80_2',
          customer: 'cus_b80',
          amount_paid: 9900,
          currency: 'usd',
          status: 'paid',
          lines: { data: RECURRING },
        },
      },
    };
    const r1 = await billing.handleWebhookEvent(evt);
    assert.equal(r1.ok, true);
    assert.equal(await partners.balanceCents(F.partnerId), 5940, 'second $99 payment credited');
    const r2 = await billing.handleWebhookEvent(evt); // same event id: claimed already
    assert.equal(r2.duplicate, true);
    assert.equal(await partners.balanceCents(F.partnerId), 5940, 'event replay changes nothing');
    const r3 = await billing.handleWebhookEvent({ ...evt, id: 'evt_80_1b' }); // new event, same invoice
    assert.equal(r3.ok, true);
    assert.equal(await partners.balanceCents(F.partnerId), 5940, 'invoice-level idempotency holds across events');
  });

  await checkAsync('earnings: a free-plan ($0) payment and a foreign workspace payment credit nothing', async () => {
    const free = await partners.creditForInvoicePaid(
      { id: 'in_80_free', customer: 'cus_b80', amount_paid: 0, currency: 'usd', lines: { data: [{ amount: 0, price: { recurring: {} } }] } },
      { payingUserId: F.customerId }
    );
    assert.equal(free.credited, false);
    const foreign = await partners.creditForInvoicePaid(
      { id: 'in_80_foreign', customer: 'cus_b80_other', amount_paid: 9900, currency: 'usd', lines: { data: RECURRING } },
      { payingUserId: F.otherCustomerId }
    );
    assert.equal(foreign.credited, false);
    assert.ok(['no_partner', 'no_workspace'].includes(foreign.reason), `no credit without a partner (reason: ${foreign.reason})`);
    const rows = await platformDb.query(
      "SELECT COUNT(*) AS c FROM partner_earnings WHERE partner_user_id = :u AND kind = 'credit'",
      { u: F.partnerId }
    );
    assert.equal(Number(rows[0].c), 2, 'still exactly two credit rows');
    assert.equal(await partners.balanceCents(F.partnerId), 5940);
  });

  await checkAsync('earnings: a full refund reverses the full commission, once', async () => {
    const evt = {
      id: 'evt_80_2',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_80_1',
          amount: 10946,
          amount_refunded: 10946,
          invoice: 'in_80_1',
          customer: 'cus_b80',
          refunds: { data: [{ id: 're_80_1', amount: 10946 }] },
        },
      },
    };
    await billing.handleWebhookEvent(evt);
    assert.equal(await partners.balanceCents(F.partnerId), 2970, 'refund of invoice 1 reversed its $29.70');
    await billing.handleWebhookEvent({ ...evt, id: 'evt_80_2b' });
    assert.equal(await partners.balanceCents(F.partnerId), 2970, 'refund replay does not reverse twice');
  });

  await checkAsync('earnings: partial refund reverses proportionally; dispute reverses the rest of a credit', async () => {
    // Invoice 4: another $99 subscription payment on the spine charge.
    const c4 = await partners.creditForInvoicePaid(
      { id: 'in_80_4', subscription: 'sub_b80', amount_paid: 10946, currency: 'usd', charge: 'ch_80_4', lines: { data: MIXED } },
      { payingUserId: F.customerId }
    );
    assert.equal(c4.credited, true);
    assert.equal(await partners.balanceCents(F.partnerId), 5940);
    const rev = await partners.reverseForRefund({
      refundId: 're_80_4',
      invoiceId: 'in_80_4',
      chargeId: 'ch_80_4',
      chargeAmountCents: 10946,
      amountRefundedCents: 5473, // exactly half the charge
    });
    assert.equal(rev.reversed, true);
    assert.equal(await partners.balanceCents(F.partnerId), 4455, 'half the commission reversed (2970 − 1485)');
    // Invoice 3 + dispute: full reversal of that credit.
    const c3 = await partners.creditForInvoicePaid(
      { id: 'in_80_3', subscription: 'sub_b80', amount_paid: 9900, currency: 'usd', charge: 'ch_80_3', lines: { data: RECURRING } },
      { payingUserId: F.customerId }
    );
    assert.equal(c3.credited, true);
    assert.equal(await partners.balanceCents(F.partnerId), 7425);
    await billing.handleWebhookEvent({
      id: 'evt_80_3',
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_80_1', charge: 'ch_80_3', amount: 9900 } },
    });
    assert.equal(await partners.balanceCents(F.partnerId), 4455, 'dispute reversed invoice 3 in full');
  });

  await checkAsync('hostinger facade gate: a partner actor creates an approval, never a deployment', async () => {
    const hd = require(path.join(root, 'server', 'hostingerDeploy.js'));
    const before = await platformDb.query('SELECT COUNT(*) AS c FROM partner_approval_requests');
    const out = await hd.startDeployment({
      workspaceId: F.partnerWorkspaceId,
      leadId: F.partnerLeadId,
      actorUserId: F.partnerId,
      confirmText: 'DEPLOY',
      confirmPriceCents: 100,
      confirmFirstPeriodCents: 100,
    });
    assert.equal(out.approvalRequired, true, JSON.stringify(out));
    const after = await platformDb.query('SELECT COUNT(*) AS c FROM partner_approval_requests');
    assert.equal(Number(after[0].c), Number(before[0].c) + 1, 'one approval request created');
    const deps = await platformDb.query('SELECT COUNT(*) AS c FROM deployments');
    assert.equal(Number(deps[0].c), 0, 'no deployment row exists');
    // An ADMIN actor is NOT gated — the facade proceeds to its normal
    // validation (this fixture lead is not a software-interest lead).
    await assert.rejects(
      () =>
        hd.startDeployment({
          workspaceId: F.partnerWorkspaceId,
          leadId: F.partnerLeadId,
          actorUserId: F.superAdminId,
          confirmText: 'DEPLOY',
          confirmPriceCents: 100,
          confirmFirstPeriodCents: 100,
        }),
      (e) => e.code === 'NOT_SOFTWARE_LEAD'
    );
    F.hostingerApprovalId = out.approvalId;
  });

  await checkAsync('payout eligibility flips at $500 and recordPayout moves the balance into a payout row', async () => {
    const top = await partners.creditForPayment({
      partnerUserId: F.partnerId,
      workspaceId: F.partnerWorkspaceId,
      invoiceId: 'in_80_top',
      baseCents: 200000,
      currency: 'usd',
    });
    assert.equal(top.credited, true);
    assert.equal(top.amountCents, 60000);
    const summary = await partners.earningsSummary(F.partnerId);
    assert.equal(summary.balanceCents, 64455);
    assert.equal(summary.eligible, true, 'balance ≥ $500 → eligible');
    assert.equal(summary.ratePercent, 30);
    const small = await partners.earningsSummary(F.partner2Id);
    assert.equal(small.balanceCents, 0);
    assert.equal(small.eligible, false, 'zero balance is not eligible');
    // The actual payout is recorded over HTTP in Part C (admin route).
    F.expectedPayoutCents = 64455;
  });
}

/* ===================================================================== */
/* Part C — HTTP: sessions, scope, settings denial, gates, payout, pages  */
/* ===================================================================== */

function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
      if (cookies.size) {
        headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      }
      if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
      const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
      const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const c of set) {
        const pair = String(c).split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return res;
    },
  };
}
async function resJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function partC() {
  const platformDb = require(path.join(root, 'server/db.js'));
  const partners = require(path.join(root, 'server/partners.js'));
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const totp = require(path.join(root, 'src/totp.js'));

  const { token: partnerWsToken } = await workspace.createWorkspaceToken(F.partnerWorkspaceId, 'batch80-partner');
  const { token: partner2WsToken } = await workspace.createWorkspaceToken(F.partner2WorkspaceId, 'batch80-partner2');
  const { token: hqWsToken } = await workspace.createWorkspaceToken(F.hqWorkspaceId, 'batch80-hq');
  const txnRow = F.partnerDb.prepare('SELECT id FROM domain_transactions LIMIT 1').get();
  F.txnId = Number(txnRow.id);

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
    for (let n = 0; n < 300 && !ready; n++) {
      if (child.exitCode != null) throw new Error('server exited early: ' + output);
      try {
        const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
        if (r.ok) ready = true;
      } catch {}
      if (!ready) await new Promise((r) => setTimeout(r, 200));
    }
    assert(ready, 'server did not become ready: ' + output);

    const post = (jar, p, body, headers) =>
      jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}), headers });
    const put = (jar, p, body, headers) =>
      jar.fetch(BASE + p, { method: 'PUT', body: JSON.stringify(body || {}), headers });
    const get = (jar, p, headers) => jar.fetch(BASE + p, { headers });

    async function enrollSession(email) {
      const jar = makeJar();
      let res = await post(jar, '/api/v1/auth/login', { email, password: PW });
      let body = await resJson(res);
      assert(res.status === 200 && body.data.mfaRequired === true, `login challenge for ${email}: ${JSON.stringify(body)}`);
      res = await post(jar, '/api/v1/auth/mfa/enroll/start', {});
      body = await resJson(res);
      const secret = body.data.secret;
      assert(secret, 'enroll start returns a secret');
      res = await post(jar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(secret) });
      body = await resJson(res);
      assert(res.status === 200 && body.data.user, `enroll confirm issues the session for ${email}`);
      return jar;
    }
    const superJar = await enrollSession('super80@example.invalid');
    const partnerJar = await enrollSession('partner80@example.invalid');
    const partner2Jar = await enrollSession('partner80b@example.invalid');
    const controlJar = await enrollSession('control80@example.invalid');
    check('staff sessions established (super admin, two partners, control owner)', () => {});

    await checkAsync('partner session: /me carries the partner classification', async () => {
      const res = await get(partnerJar, '/api/v1/auth/me');
      const body = await resJson(res);
      assert.equal(res.status, 200);
      assert.equal(body.data.isPartner, true);
      assert.equal(body.data.user.accountType, 'partner');
      const res2 = await get(controlJar, '/api/v1/auth/me');
      const body2 = await resJson(res2);
      assert.equal(body2.data.isPartner, false);
    });

    await checkAsync('scope: partner reads own workspace; a fresh partner workspace is not paywalled; other workspaces are invisible', async () => {
      let res = await get(partnerJar, '/api/v1/leads');
      assert.equal(res.status, 200, 'partner reads own workspace leads');
      res = await get(partner2Jar, '/api/v1/leads');
      assert.equal(res.status, 200, 'partner2 reads their fresh workspace (no 402 paywall)');
      res = await get(partnerJar, '/api/v1/leads', { 'x-workspace-id': String(F.hqWorkspaceId) });
      const body = await resJson(res);
      assert.equal(res.status, 403, `cross-workspace read denied (got ${res.status})`);
      assert.equal(body.error, 'NOT_A_MEMBER');
      res = await get(partnerJar, '/api/v1/settings', { 'x-workspace-id': String(F.hqWorkspaceId) });
      assert.equal(res.status, 403, 'cross-workspace settings read denied');
    });

    await checkAsync('settings denial: EVERY settings write 403s for a partner, and nothing changes', async () => {
      // Control writes first so there is a value to protect.
      let res = await put(controlJar, '/api/v1/settings', { key: 'ai.model.default', value: 'control-model' });
      assert.equal(res.status, 200, `control owner settings write works (${res.status})`);
      const attempts = [
        ['PUT', '/api/v1/settings', { key: 'ai.model.default', value: 'partner-hack' }],
        ['PUT', '/api/v1/settings/secret', { key: 'ai.api_key', value: 'sk-nope' }],
        ['POST', '/api/v1/settings/automation', { paused: true }],
        ['POST', '/api/v1/settings/mail-test', { to: 'x@example.invalid' }],
        ['PUT', '/api/v1/prompts/welcome', { body: 'partner prompt' }],
        ['POST', '/api/v1/prompts/welcome/reset', {}],
        ['PUT', '/api/v1/cloudflare', { zoneId: 'partner-zone' }],
        ['PUT', '/api/v1/discovery/schedule', { enabled: true }],
      ];
      for (const [method, p, body] of attempts) {
        const r = await (method === 'PUT' ? put(partnerJar, p, body) : post(partnerJar, p, body));
        const b = await resJson(r);
        assert.equal(r.status, 403, `${method} ${p} → 403 (got ${r.status}: ${JSON.stringify(b).slice(0, 120)})`);
        assert.equal(b.code, 'PARTNER_SETTINGS_FORBIDDEN', `${method} ${p} carries the partner code`);
      }
      const row = F.partnerDb
        .prepare("SELECT value FROM settings WHERE key = 'ai.model.default'")
        .get();
      assert.equal(row.value, 'control-model', 'the protected value is exactly what the control wrote');
    });

    await checkAsync('platform surfaces: partner 403 everywhere; super admin reaches the partners view', async () => {
      for (const p of ['/api/v1/admin/overview', '/api/v1/admin/users', '/api/v1/admin/partners', '/api/v1/admin/partner-approvals']) {
        const res = await get(partnerJar, p);
        assert.equal(res.status, 403, `partner GET ${p} → 403 (got ${res.status})`);
      }
      const res = await put(partnerJar, '/api/v1/admin/settings', { key: 'x', value: 'y' });
      assert.equal(res.status, 403, 'partner platform settings write → 403');
      const okRes = await get(superJar, '/api/v1/admin/partners');
      const okBody = await resJson(okRes);
      assert.equal(okRes.status, 200);
      const mine = okBody.data.partners.find((p) => Number(p.userId) === F.partnerId);
      assert.ok(mine, 'partner listed for the admin');
      assert.equal(mine.balanceCents, 64455, 'admin sees the accrued balance');
      assert.equal(mine.eligible, true);
    });

    const approvalsBefore = Number(
      (await platformDb.query('SELECT COUNT(*) AS c FROM partner_approval_requests'))[0].c
    );
    let registerApprovalId;
    let creditsApprovalId;
    await checkAsync('purchase gate: partner purchases create approvals and execute NOTHING', async () => {
      let res = await post(partnerJar, '/api/v1/domains/register', { domain: 'gate80.example', leadId: F.partnerLeadId });
      let body = await resJson(res);
      assert.equal(res.status, 202, `register gated (got ${res.status}: ${JSON.stringify(body).slice(0, 160)})`);
      assert.equal(body.data.approvalRequired, true);
      registerApprovalId = body.data.approvalId;

      res = await post(partnerJar, '/api/v1/admin-area/calls/numbers/purchase', {
        leadId: F.partnerLeadId,
        phoneNumber: '+16105550100',
      });
      body = await resJson(res);
      assert.equal(res.status, 202, 'call number purchase gated');
      assert.equal(body.data.approvalRequired, true);

      res = await post(partnerJar, '/api/v1/billing/credits/checkout', { workspaceId: F.partnerWorkspaceId });
      body = await resJson(res);
      assert.equal(res.status, 202, 'credits checkout gated');
      assert.equal(body.data.approvalRequired, true);
      creditsApprovalId = body.data.approvalId;

      res = await post(partnerJar, `/api/v1/admin-area/domain-transactions/${F.txnId}/complete`, {});
      body = await resJson(res);
      assert.equal(res.status, 202, 'domain-flow completion gated');
      assert.equal(body.data.approvalRequired, true);

      const count = Number((await platformDb.query('SELECT COUNT(*) AS c FROM partner_approval_requests'))[0].c);
      assert.equal(count, approvalsBefore + 4, 'four new pending approvals');
      const txnCount = F.partnerDb.prepare('SELECT COUNT(*) AS c FROM domain_transactions').get().c;
      assert.equal(txnCount, 1, 'no new domain transaction — nothing executed');
      const pending = await partners.listApprovals({ status: 'pending', requestedBy: F.partnerId });
      assert.ok(pending.length >= 4, 'approvals visible in the queue');

      // Control (standard owner, same workspace + role): NOT gated.
      res = await post(controlJar, '/api/v1/billing/credits/checkout', { workspaceId: F.partnerWorkspaceId });
      assert.notEqual(res.status, 202, 'control owner is not gated');
      const count2 = Number((await platformDb.query('SELECT COUNT(*) AS c FROM partner_approval_requests'))[0].c);
      assert.equal(count2, count, 'no approval created for the control');
    });

    await checkAsync('approval decisions: deny closes forever; approve executes the stored action', async () => {
      let res = await post(superJar, `/api/v1/admin/partner-approvals/${registerApprovalId}/decide`, { approve: false });
      let body = await resJson(res);
      assert.equal(res.status, 200, JSON.stringify(body).slice(0, 160));
      assert.equal(body.data.status, 'denied');
      res = await post(superJar, `/api/v1/admin/partner-approvals/${registerApprovalId}/decide`, { approve: true });
      assert.equal(res.status, 409, 'a decided request cannot be re-decided');

      res = await post(superJar, `/api/v1/admin/partner-approvals/${creditsApprovalId}/decide`, { approve: true });
      body = await resJson(res);
      assert.equal(res.status, 200);
      assert.equal(body.data.status, 'failed', 'the stored credits action RAN on approval (Stripe is unconfigured in the fixture, so it fails honestly)');
      assert.ok(body.data.result && body.data.result.error, 'the execution error is recorded on the request');
      // The partner can see their own requests + outcomes.
      const mine = await partners.listApprovals({ requestedBy: F.partnerId });
      assert.equal(mine.find((a) => a.id === registerApprovalId).status, 'denied');
      assert.equal(mine.find((a) => a.id === creditsApprovalId).status, 'failed');
    });

    await checkAsync('MCP surface: partner-workspace token cannot write settings; a registration becomes an approval', async () => {
      const rpc = async (token, name, args) => {
        const res = await fetch(`${BASE}/mcp`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        });
        const body = await resJson(res);
        const text = body.result && body.result.content && body.result.content[0] && body.result.content[0].text;
        return text ? JSON.parse(text) : body;
      };
      const denied = await rpc(partnerWsToken, 'settings.set', { key: 'ai.model.default', value: 'mcp-hack' });
      assert.equal(denied.ok, false);
      assert.ok(String(denied.error).includes('PARTNER_SETTINGS_FORBIDDEN'), JSON.stringify(denied).slice(0, 200));
      const gated = await rpc(partnerWsToken, 'domains.register', { domain: 'mcp80.example', leadId: F.partnerLeadId });
      assert.equal(gated.ok, true);
      assert.equal(gated.data.approvalRequired, true, 'MCP registration gated into an approval');
      const allowed = await rpc(hqWsToken, 'settings.set', { key: 'ai.model.default', value: 'hq-model' });
      assert.equal(allowed.ok, true, 'non-partner workspace MCP settings write unaffected');
      // Token paywall exemption: partner2's fresh workspace has no
      // paying customer, yet its token reads the API fine.
      const res = await fetch(`${BASE}/api/v1/leads`, { headers: { authorization: `Bearer ${partner2WsToken}` } });
      assert.equal(res.status, 200, `partner2 token not paywalled (got ${res.status})`);
    });

    await checkAsync('payout: admin records the full balance; partner sees it; a second payout is refused', async () => {
      let res = await post(superJar, `/api/v1/admin/partners/${F.partnerId}/payouts`, {
        method: 'Stripe',
        note: 'Batch80 fixture payout',
      });
      let body = await resJson(res);
      assert.equal(res.status, 200, JSON.stringify(body).slice(0, 200));
      assert.equal(body.data.amountCents, F.expectedPayoutCents);
      assert.equal(body.data.balanceCents, 0);
      assert.equal(await partners.balanceCents(F.partnerId), 0, 'payable balance zeroed into the payout record');

      res = await get(partnerJar, '/api/v1/partners/me');
      body = await resJson(res);
      assert.equal(res.status, 200);
      assert.equal(body.data.balanceCents, 0);
      assert.equal(body.data.payouts.length, 1, 'payout history shows the recorded payout');
      assert.equal(body.data.payouts[0].method, 'Stripe');
      assert.ok(body.data.terms.taxes.includes('responsible for your own taxes'), 'tax terms ride the partner view');
      assert.ok(body.data.entries.length >= 5, 'per-payment history present');

      res = await get(controlJar, '/api/v1/partners/me');
      assert.equal(res.status, 403, 'non-partner session is refused the partner area');

      res = await post(superJar, `/api/v1/admin/partners/${F.partnerId}/payouts`, { method: 'Stripe' });
      assert.equal(res.status, 400, 'nothing left to pay out → refused');
    });

    /* ---------------- partner application form ---------------- */
    const wdb1 = openWorkspaceDb(1);
    const leadCount1 = () => wdb1.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
    const leadByEmail1 = (email) => wdb1.prepare('SELECT * FROM leads WHERE email = ?').get(email);
    const APP = {
      fullName: 'Pat Partner',
      email: 'pat@example.invalid',
      platform: 'instagram',
      followerRange: '10k-50k',
      niche: 'Local food trucks',
      audience: 'Followers opening food businesses; many ask how to get a website with online ordering.',
      phone: '+1 610-555-0142',
    };
    await checkAsync('application: validation matrix → coded 400, nothing written', async () => {
      const cases = [
        { ...APP, fullName: '' },
        { ...APP, email: 'nope' },
        { ...APP, platform: 'myspace' },
        { ...APP, followerRange: 'huge' },
        { ...APP, niche: '' },
        { ...APP, audience: '' },
        { ...APP, phone: 'call me' },
        {},
      ];
      for (const body of cases) {
        const res = await post(makeJar(), '/api/v1/partner/submit', body);
        const b = await resJson(res);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(b.code, 'VALIDATION');
      }
      assert.equal(leadCount1(), 0);
    });

    let appLeadId = null;
    await checkAsync('application: valid submit creates ONE partner-app lead; repeat folds with an event', async () => {
      let res = await post(makeJar(), '/api/v1/partner/submit', APP);
      let body = await resJson(res);
      assert.equal(res.status, 200, JSON.stringify(body).slice(0, 200));
      appLeadId = body.data.id;
      assert.equal(leadCount1(), 1);
      const row = leadByEmail1(APP.email);
      assert.equal(row.source, 'partner-app');
      assert.equal(row.source_ref, 'partner');
      assert.equal(row.lead_group, 'Partner');
      assert.equal(row.category, 'Partner');
      assert.ok(JSON.parse(row.tags || '[]').includes('partner-app'), 'partner-app tag');
      assert.ok(row.notes.includes('Applied for the BitPype Partner program'), 'application note');
      res = await post(makeJar(), '/api/v1/partner/submit', { ...APP, phone: '+1 215-555-0100' });
      body = await resJson(res);
      assert.equal(res.status, 200);
      assert.equal(body.data.id, appLeadId, 'fold returns the same lead');
      assert.equal(leadCount1(), 1, 'still exactly one lead');
      const ev = wdb1
        .prepare("SELECT COUNT(*) AS c FROM lead_events WHERE lead_id = ? AND type = 'partner_application'")
        .get(appLeadId);
      assert.equal(ev.c, 1, 'fold recorded as a partner_application event');
    });

    /* ---------------- pages ---------------- */
    const getText = async (p) => {
      const res = await fetch(BASE + p);
      return { status: res.status, text: await res.text(), type: res.headers.get('content-type') || '' };
    };
    await checkAsync('pages: /partner + /work-with-us serve 200 with copy, disclaimer, photos', async () => {
      const p = await getText('/partner');
      assert.equal(p.status, 200);
      assert.ok(p.text.includes('Build for your audience'), 'partner hero');
      assert.ok(p.text.includes('Example math — not an earnings promise'), 'example-math note served');
      assert.ok(p.text.includes('bp-earnings-disclaimer'), 'Batch 75 disclaimer injected');
      assert.ok(p.text.includes('href="/work-with-us"'), 'footer hub link served');
      assert.ok(!p.text.includes('{{'), 'no token leakage');
      const w = await getText('/work-with-us');
      assert.equal(w.status, 200);
      assert.ok(w.text.includes('Four doors'), 'hub hero');
      for (const href of ['href="/partner"', 'href="/creator"', 'href="/solo"', 'href="/landing"']) {
        assert.ok(w.text.includes(href), `hub CTA ${href}`);
      }
      assert.ok(w.text.includes('bp-earnings-disclaimer'), 'hub disclaimer injected');
      for (const img of ['work-partner.jpg', 'work-creator.jpg', 'work-solo.jpg', 'work-software.jpg']) {
        const res = await fetch(`${BASE}/brand/${img}`);
        assert.equal(res.status, 200, `${img} serves`);
        assert.ok((res.headers.get('content-type') || '').includes('image/jpeg'), `${img} is a JPEG`);
        await res.arrayBuffer();
      }
    });

    await checkAsync('footer link lands on the served marketing pages', async () => {
      for (const p of ['/', '/landing', '/solo', '/creator']) {
        const r = await getText(p);
        assert.equal(r.status, 200, `${p} 200`);
        assert.ok(r.text.includes('href="/work-with-us"'), `${p} carries the Work with us footer link`);
      }
    });

    await checkAsync('registration stays closed while partner applications work', async () => {
      await platformDb.query(
        "INSERT INTO platform_settings (key, value) VALUES ('registration.open', '0') ON CONFLICT(key) DO UPDATE SET value = '0'"
      );
      const res = await post(makeJar(), '/api/v1/auth/register', {
        name: 'Nope',
        email: 'nope80@example.invalid',
        password: 'whatever-123',
      });
      const body = await resJson(res);
      assert.equal(res.status, 403, JSON.stringify(body).slice(0, 160));
      assert.equal(body.error, 'REGISTRATION_DISABLED');
    });
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

(async () => {
  partA();
  await partB();
  await partC();
  console.log(JSON.stringify({ file: 'batch80-partner-regressions', checks: results.length, passed: true }));
  console.log(results.map((r) => `ok - ${r}`).join('\n'));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
