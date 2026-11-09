'use strict';
/**
 * Batch 119 — subscription-failure suspension.
 *
 * Ely's order (2026-11-02): "If user fails to pay monthly subscription
 * suspend account and send them email every week with link and
 * instructions to renew." Plus his refinement: "Suspended account
 * means website produces an error."
 *
 * What this suite proves:
 *  Part 1 — source pins: schema tables in both dialects, the engine
 *    module + webhook hooks, the serve-time 503 gate mounted on the
 *    preview path, the portal narrowing, staff write block, admin
 *    surface, and the XSS census still at 407.
 *  Part 2 — engine + real webhook dispatch against real DBs:
 *    a first failure (past_due, retries pending) never suspends;
 *    'unpaid' (retries exhausted) suspends + writes serve markers +
 *    sends weekly email #1 through the claimed-send ledger; webhook
 *    replays are no-ops; the sweep respects the 7-day dedupe (clock
 *    injected, never waited out); a return to active restores
 *    (markers gone, emails stop); cancel-while-suspended terminates
 *    the episode; a second account is never touched; super admins
 *    are never suspended; portal resolution is per client (a renter
 *    covered by the owner's plan is not suspended by it).
 *  Part 3 — HTTP against a spawned server seeded SUSPENDED: the
 *    site preview answers 503 with a generic body (and a missing
 *    path inside the folder does not leak the themed 404), a
 *    never-suspended control site stays 200, the portal narrows to
 *    Billing (other panels 403 ACCOUNT_SUSPENDED, /me carries the
 *    state), staff writes 403 while reads + billing stay open, and
 *    the admin unsuspend restores the site to 200 and writes to OK.
 *
 * Env mirrors the other suites: DB_DRIVER follows REGRESSION_DB_DRIVER
 * so the MySQL gate leg exercises the same paths.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'batch119-'));
process.env.DB_DRIVER = DRIVER;
if (DRIVER === 'sqlite') process.env.SQLITE_PATH = path.join(TMP, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(TMP, 'workspaces');
process.env.EXPORT_ROOT = path.join(TMP, 'exports');
process.env.APP_URL = 'https://bitpype.example';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.SESSION_SECRET = ['batch119', 'fixture', 'secret', '0123456789abcdef'].join('-');

const PW = ['batch119', 'fixture', 'password'].join('-');
const DAY = 24 * 3600 * 1000;

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL - ${name}\n    ${(e && e.stack) || e}`);
  }
}

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* =============================== Part 1 =============================== */

async function part1() {
  console.log('Part 1 — source pins');

  await test('schema: suspension tables exist in BOTH dialect schemas', async () => {
    for (const f of ['sql/schema.sql', 'sql/schema.sqlite.sql']) {
      const src = readSrc(f);
      assert.ok(src.includes('CREATE TABLE IF NOT EXISTS subscription_suspensions'), f);
      assert.ok(src.includes('CREATE TABLE IF NOT EXISTS subscription_suspension_workspaces'), f);
      assert.ok(src.includes('last_weekly_email_at'), f);
    }
  });

  await test('engine module: exports the suspension surface', async () => {
    const m = require(path.join(ROOT, 'server/subscriptionSuspension.js'));
    for (const fn of [
      'suspendForSubscription',
      'restoreForUser',
      'restoreForSubscriptionEvent',
      'restoreForInvoice',
      'terminateForSubscription',
      'sendWeeklyRenewalEmail',
      'runSuspensionSweep',
      'getActiveSuspensionForUser',
      'getActiveSuspensionForWorkspace',
      'suspensionForPortalClient',
      'listActiveSuspensions',
    ]) {
      assert.strictEqual(typeof m[fn], 'function', fn);
    }
    assert.strictEqual(m.WEEK_MS, 7 * DAY);
  });

  await test('webhook hooks: billing dispatch wires suspend / restore / terminate', async () => {
    const src = readSrc('server/billing.js');
    assert.ok(src.includes('suspension.suspendForSubscription(obj, deps)'), 'unpaid → suspend');
    assert.ok(src.includes('suspension.restoreForSubscriptionEvent(obj, deps)'), 'active → restore');
    assert.ok(src.includes('suspension.terminateForSubscription(obj, deps)'), 'deleted → terminate');
    assert.ok(src.includes('restoreForInvoice(obj, deps)'), 'invoice.paid → restore');
    assert.ok(src.includes('next_payment_attempt == null'), 'final-failure signal pinned');
    assert.ok(src.includes('suspended: !!suspension'), 'summary carries the suspension state');
  });

  await test('sweep: lifecycle runSweep includes the suspension section', async () => {
    const src = readSrc('server/lifecycleComms.js');
    assert.ok(src.includes('runSuspensionSweep(deps)'));
    assert.ok(src.includes('sendClaimed,'), 'the claimed-send helper is exported for the engine');
  });

  await test('serve-time gate: 503 markers gate mounted on both preview mounts', async () => {
    const ps = readSrc('server/previewSecurity.js');
    assert.ok(ps.includes('function blockSuspendedPreviews'));
    assert.ok(ps.includes('subscription_site_suspensions'));
    assert.ok(ps.includes('503'), 'generic 503');
    const srv = readSrc('server.js');
    const mounts = srv.split('blockSuspendedPreviews').length - 1;
    assert.ok(mounts >= 2, `expected the gate on both mounts, found ${mounts}`);
  });

  await test('public module payloads: suspended assertion beside the archived one', async () => {
    const src = readSrc('server/siteModules.js');
    assert.ok(src.includes('function assertSiteNotSuspended'));
    assert.ok(src.includes("'SITE_UNAVAILABLE'"));
    const calls = src.split('assertSiteNotSuspended(db,').length - 1;
    assert.ok(calls >= 7, `expected >=7 public entry points gated, found ${calls}`);
  });

  await test('portal + staff + admin wiring', async () => {
    const portal = readSrc('server/routes/portal.js');
    assert.ok(portal.includes('portalSuspensionGuard'));
    assert.ok(portal.includes('router.use(requireClient, portalSuspensionGuard, portalTabGuard'));
    const mw = readSrc('server/middleware.js');
    assert.ok(mw.includes('async function blockSuspendedWrites'));
    const srv = readSrc('server.js');
    assert.ok(srv.split('blockSuspendedWrites').length - 1 >= 4, 'import + three mounts');
    assert.ok(srv.includes("item.method === 'tools/call'"), 'MCP calls gated while suspended');
    const admin = readSrc('server/routes/admin.js');
    assert.ok(admin.includes("router.get('/suspensions'"));
    assert.ok(admin.includes("router.post('/suspensions/:userId/unsuspend'"));
    const pb = readSrc('server/portalBilling.js');
    assert.ok(pb.includes('suspension,'), 'portal billing payload carries the episode');
  });

  await test('xss census at 504 sinks (Batch 162: +4 audited Contact-page sinks in app.js, pairwise-proven vs the landed 161 census — see batch103 narrative; Batch 161: +17 audited Assistant-surface sinks, pairwise-proven — see batch103 narrative; prior: Batch 133 additions; Batch 136 finisher +2 audited STATIC; Batch 137 finisher +1 audited SAFE in portal.js; Batch 138 finisher +4; Batch 139 finisher +2 audited safe-class; Batch 153 +1 BUILDER +1 RAW audited Design-agent editor sinks in app.js; Batch 156 +3 audited safe-class fingerprint sinks in app.js — see batch103 narrative)', async () => {
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/xss-census.cjs')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.ok(/innerHTML sinks: 504/.test(out), out.split('\n')[0]); // Batch 168: census 503 -> 504 (+1 benign STATIC clear in portal.js — see batch103 note)
  });

  await test('gate registration: allowlist + format scope carry batch119', async () => {
    assert.ok(readSrc('tests/run-regressions.cjs').includes("'batch119-suspension-regressions'"));
    const fmt = readSrc('tests/run-formatcheck.cjs');
    assert.ok(fmt.includes("'server/subscriptionSuspension.js'"));
    assert.ok(fmt.includes("'tests/batch119-suspension-regressions.cjs'"));
  });
}

/* =============================== Part 2 =============================== */

async function part2() {
  console.log('Part 2 — engine + webhook dispatch (real DBs)');
  const { query } = require(path.join(ROOT, 'server/db.js'));
  const workspace = require(path.join(ROOT, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(ROOT, 'server/workspaceDb.js'));
  const billing = require(path.join(ROOT, 'server/billing.js'));
  const suspension = require(path.join(ROOT, 'server/subscriptionSuspension.js'));

  const sent = [];
  let nowMs = Date.now();
  const deps = {
    sendMail: async (msg) => {
      sent.push(msg);
      return { sent: true, id: `test-${sent.length}` };
    },
    openDb: (wsId) => openWorkspaceDb(wsId),
    now: () => nowMs,
  };

  // The weekly email names the plan resolved from the subscription's
  // price (stripeClient.planIdFromPriceId reads platform settings).
  await query(`DELETE FROM platform_settings WHERE \`key\` = 'stripe.price_id_standard'`);
  await query(
    `INSERT INTO platform_settings (\`key\`, value) VALUES ('stripe.price_id_standard', 'price_fake_standard')`
  );

  async function makeAccount(email, subId) {
    const acct = await workspace.createUserWithWorkspace({ email, password: PW, name: email.split('@')[0] });
    await query(
      `UPDATE users SET stripe_customer_id = :cus, stripe_subscription_id = :sub,
              subscription_status = 'active', billing_plan = 'standard',
              subscription_price_id = 'price_fake_standard' WHERE id = :id`,
      { cus: `cus_${subId}`, sub: subId, id: acct.userId }
    );
    const db = openWorkspaceDb(acct.workspaceId);
    const leadInfo = db.prepare('INSERT INTO leads (business_name, email) VALUES (?, ?)').run(`Biz ${subId}`, email);
    const siteInfo = db
      .prepare('INSERT INTO websites (name, status, lead_id, theme, pages) VALUES (?, ?, ?, ?, ?)')
      .run(`Site ${subId}`, 'published', Number(leadInfo.lastInsertRowid), 'classic', '[]');
    return {
      userId: Number(acct.userId),
      workspaceId: Number(acct.workspaceId),
      leadId: Number(leadInfo.lastInsertRowid),
      siteId: Number(siteInfo.lastInsertRowid),
      email,
      subId,
    };
  }

  const subEvent = (id, a, status, extra = {}) => ({
    id,
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: a.subId,
        customer: `cus_${a.subId}`,
        status,
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        // Real Stripe subscription payloads always carry items with
        // the price — the plan resolution (and billing's own sync)
        // reads the tier from here.
        items: { data: [{ price: { id: 'price_fake_standard' } }] },
        metadata: { user_id: String(a.userId) },
        ...extra,
      },
    },
  });

  const markers = (a) => {
    try {
      return openWorkspaceDb(a.workspaceId)
        .prepare('SELECT * FROM subscription_site_suspensions WHERE website_id = ?')
        .all(a.siteId);
    } catch {
      return []; // marker table is created lazily at first suspension
    }
  };

  const A = await makeAccount('owner-a@fixture.test', 'sub_a119');
  const B = await makeAccount('owner-b@fixture.test', 'sub_b119');
  const C = await makeAccount('owner-c@fixture.test', 'sub_c119');

  await test('first failure (past_due, retries pending) does NOT suspend', async () => {
    sent.length = 0;
    await billing.handleWebhookEvent(subEvent('evt_a_pastdue', A, 'past_due'), deps);
    assert.strictEqual(await suspension.getActiveSuspensionForUser(A.userId, deps), null);
    assert.strictEqual(markers(A).length, 0);
    assert.strictEqual(sent.length, 0, 'no suspension mail on a recoverable failure');
    // A non-final invoice.payment_failed (Stripe will retry) also
    // never suspends. The branch retrieves the subscription from
    // Stripe mid-dispatch, which is unconfigured in this harness —
    // the dispatch error must still leave no suspension behind.
    const inv = {
      id: 'in_a_first',
      customer: `cus_${A.subId}`,
      subscription: A.subId,
      amount_due: 9900,
      currency: 'usd',
      next_payment_attempt: Math.floor(Date.now() / 1000) + 3 * 86400,
    };
    await billing
      .handleWebhookEvent({ id: 'evt_a_firstfail', type: 'invoice.payment_failed', data: { object: inv } }, deps)
      .catch(() => {});
    assert.strictEqual(await suspension.getActiveSuspensionForUser(A.userId, deps), null);
    assert.strictEqual(markers(A).length, 0);
  });

  await test("retries exhausted ('unpaid') suspends: episode, markers, weekly email #1", async () => {
    sent.length = 0;
    await billing.handleWebhookEvent(subEvent('evt_a_unpaid', A, 'unpaid'), deps);
    const ep = await suspension.getActiveSuspensionForUser(A.userId, deps);
    assert.ok(ep, 'episode row exists');
    assert.strictEqual(ep.status, 'active');
    assert.strictEqual(ep.subscription_id, A.subId);
    assert.strictEqual(Number(ep.weekly_email_count), 1, 'first weekly email went out at suspension');
    assert.strictEqual(markers(A).length, 1, 'serve marker written for the site');
    assert.strictEqual(Number(markers(A)[0].suspension_id), Number(ep.id));
    const mail = sent.find((m) => m.to === A.email);
    assert.ok(mail, 'weekly email addressed to the account owner');
    assert.ok(/suspended/i.test(mail.subject), mail.subject);
    assert.ok(
      /Standard plan/.test(mail.subject),
      `weekly email names the PAID plan even though the stored status already flipped to unpaid: ${mail.subject}`
    );
    assert.ok(mail.text.includes('/portal?panel=billing'), 'renewal link present');
    assert.ok(/unavailable/i.test(mail.text), 'copy says the website is unavailable');
    assert.ok(
      /reminder a week|weekly reminder/i.test(`${mail.text}\n${mail.footerNote || ''}`),
      'copy states the weekly cadence'
    );
    const claims = await query(
      `SELECT * FROM lifecycle_comms_sends WHERE kind = 'suspension_weekly' AND user_id = :uid`,
      { uid: A.userId }
    );
    assert.strictEqual(claims.length, 1);
    assert.strictEqual(claims[0].ref_key, `suspension_weekly:${ep.id}:1`);
    // Isolation: B and C untouched.
    assert.strictEqual(await suspension.getActiveSuspensionForUser(B.userId, deps), null);
    assert.strictEqual(await suspension.getActiveSuspensionForUser(C.userId, deps), null);
    assert.strictEqual(markers(B).length, 0);
    assert.strictEqual(markers(C).length, 0);
  });

  await test('webhook replay of the suspend event is a no-op (event claim)', async () => {
    const before = sent.length;
    const r = await billing.handleWebhookEvent(subEvent('evt_a_unpaid', A, 'unpaid'), deps);
    assert.strictEqual(r.duplicate, true);
    assert.strictEqual(sent.length, before, 'no second email');
    const eps = await query(`SELECT * FROM subscription_suspensions WHERE user_id = :uid`, { uid: A.userId });
    assert.strictEqual(eps.length, 1, 'still exactly one episode');
    // A fresh event id carrying the same state is also idempotent.
    await billing.handleWebhookEvent(subEvent('evt_a_unpaid_2', A, 'unpaid'), deps);
    assert.strictEqual(sent.length, before, 'already-suspended accounts get no extra email');
    assert.strictEqual(markers(A).length, 1);
  });

  await test('weekly dedupe: +3d silent, +8d sends #2, +9d silent', async () => {
    const t0 = nowMs;
    sent.length = 0;
    nowMs = t0 + 3 * DAY;
    let r = await suspension.runSuspensionSweep(deps);
    assert.strictEqual(r.sent.length, 0, JSON.stringify(r));
    nowMs = t0 + 8 * DAY;
    r = await suspension.runSuspensionSweep(deps);
    assert.strictEqual(r.sent.length, 1, JSON.stringify(r));
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].text.includes('still suspended'), 'follow-ups say the account is still suspended');
    const ep = await suspension.getActiveSuspensionForUser(A.userId, deps);
    assert.strictEqual(Number(ep.weekly_email_count), 2);
    nowMs = t0 + 9 * DAY;
    r = await suspension.runSuspensionSweep(deps);
    assert.strictEqual(r.sent.length, 0, 'never two in a 7-day period');
    nowMs = t0;
  });

  await test('payment recovery (subscription back to active) restores and stops the emails', async () => {
    sent.length = 0;
    await billing.handleWebhookEvent(subEvent('evt_a_active', A, 'active'), deps);
    assert.strictEqual(await suspension.getActiveSuspensionForUser(A.userId, deps), null);
    assert.strictEqual(markers(A).length, 0, 'serve markers cleared — site back exactly as it was');
    const rows = await query(`SELECT * FROM subscription_suspensions WHERE user_id = :uid`, { uid: A.userId });
    assert.strictEqual(rows[0].status, 'restored');
    assert.ok(rows[0].restored_at);
    nowMs = Date.now() + 30 * DAY;
    const r = await suspension.runSuspensionSweep(deps);
    assert.strictEqual(r.sent.length, 0, 'restored accounts leave the weekly cadence');
    assert.strictEqual(sent.filter((m) => m.to === A.email).length, 0);
    nowMs = Date.now();
  });

  await test('cancel while suspended: episode terminates, cancellation path owns the account', async () => {
    sent.length = 0;
    await billing.handleWebhookEvent(subEvent('evt_b_unpaid', B, 'unpaid'), deps);
    assert.ok(await suspension.getActiveSuspensionForUser(B.userId, deps));
    assert.strictEqual(markers(B).length, 1);
    const sendsAtSuspend = sent.filter((m) => m.to === B.email).length;
    assert.strictEqual(sendsAtSuspend, 1);
    const del = {
      id: 'evt_b_deleted',
      type: 'customer.subscription.deleted',
      data: { object: { id: B.subId, customer: `cus_${B.subId}`, metadata: { user_id: String(B.userId) } } },
    };
    await billing.handleWebhookEvent(del, deps).catch(() => {});
    assert.strictEqual(await suspension.getActiveSuspensionForUser(B.userId, deps), null);
    const rows = await query(`SELECT * FROM subscription_suspensions WHERE user_id = :uid`, { uid: B.userId });
    assert.strictEqual(rows[0].status, 'terminated');
    assert.strictEqual(markers(B).length, 0, 'suspension markers cleared on termination');
    nowMs = Date.now() + 30 * DAY;
    const r = await suspension.runSuspensionSweep(deps);
    assert.strictEqual(
      sent.filter((m) => m.to === B.email && /suspended/i.test(m.subject)).length,
      sendsAtSuspend,
      'no weekly email after termination'
    );
    assert.strictEqual(r.sent.length, 0);
    nowMs = Date.now();
  });

  await test('super admins are never suspended', async () => {
    const D = await makeAccount('admin-d@fixture.test', 'sub_d119');
    await query(`UPDATE users SET is_super_admin = 1 WHERE id = :id`, { id: D.userId });
    await billing.handleWebhookEvent(subEvent('evt_d_unpaid', D, 'unpaid'), deps);
    assert.strictEqual(await suspension.getActiveSuspensionForUser(D.userId, deps), null);
    assert.strictEqual(markers(D).length, 0);
  });

  await test('portal resolution is per client: owner suspended, covered renter is not', async () => {
    // Re-suspend A for this check.
    await billing.handleWebhookEvent(subEvent('evt_a_unpaid_3', A, 'unpaid'), deps);
    assert.ok(await suspension.getActiveSuspensionForUser(A.userId, deps));
    // suspensionForPortalClient reads only the client row's fields —
    // plain row shapes exercise the exact resolution the route uses.
    const ownerClient = {
      workspace_id: A.workspaceId,
      lead_id: A.leadId,
      email: A.email,
      user_type: 'owner',
    };
    const mine = await suspension.suspensionForPortalClient(ownerClient);
    assert.ok(mine && mine.suspended === true && mine.selfServe === true, JSON.stringify(mine));
    const renter = {
      workspace_id: A.workspaceId,
      lead_id: A.leadId,
      email: 'renter-a@fixture.test',
      user_type: 'renter',
    };
    const theirs = await suspension.suspensionForPortalClient(renter);
    assert.ok(
      theirs && theirs.suspended === true && theirs.selfServe === false,
      `a covered renter sees the workspace suspension but can never self-serve the owner's debt: ${JSON.stringify(theirs)}`
    );
    // Isolation proper: no episode exists FOR the renter, and no
    // weekly email was ever addressed to them.
    const renterEps = await query(
      `SELECT s.* FROM subscription_suspensions s JOIN users u ON u.id = s.user_id WHERE u.email = 'renter-a@fixture.test'`
    );
    assert.strictEqual(renterEps.length, 0);
    assert.strictEqual(sent.filter((m) => m.to === 'renter-a@fixture.test').length, 0);
    // Cleanup for part 3 determinism.
    await suspension.restoreForUser(A.userId, deps, { via: 'suite_cleanup', force: true });
  });
}

/* =============================== Part 3 =============================== */

async function part3() {
  console.log('Part 3 — HTTP: serve-time 503, portal narrowing, staff block, admin unsuspend');
  const { query } = require(path.join(ROOT, 'server/db.js'));
  const workspace = require(path.join(ROOT, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(ROOT, 'server/workspaceDb.js'));
  const bcrypt = require('bcryptjs');
  const suspension = require(path.join(ROOT, 'server/subscriptionSuspension.js'));

  // --- Seed: staff owner W (to be suspended) + control owner V ---
  const W = await workspace.createUserWithWorkspace({
    email: 'staff-w@fixture.test',
    password: PW,
    name: 'Staff W',
  });
  await query(
    `UPDATE users SET stripe_customer_id = 'cus_sub_w119', stripe_subscription_id = 'sub_w119',
            subscription_status = 'active', billing_plan = 'standard' WHERE id = :id`,
    { id: W.userId }
  );
  const wDb = openWorkspaceDb(W.workspaceId);
  const wLead = wDb
    .prepare('INSERT INTO leads (business_name, email) VALUES (?, ?)')
    .run('Suspended Biz', 'staff-w@fixture.test');
  const wSite = wDb
    .prepare('INSERT INTO websites (name, status, lead_id, theme, pages) VALUES (?, ?, ?, ?, ?)')
    .run('W Site', 'published', Number(wLead.lastInsertRowid), 'classic', '[]');
  const wFolder = `ws-${W.workspaceId}-site-${wSite.lastInsertRowid}`;
  const wDir = path.join(process.env.EXPORT_ROOT, wFolder);
  fs.mkdirSync(wDir, { recursive: true });
  fs.writeFileSync(path.join(wDir, 'index.html'), '<!doctype html><title>W</title><h1>W-SITE-MARKER</h1>');
  fs.writeFileSync(path.join(wDir, '404.html'), '<!doctype html><title>nf</title><h1>W-THEMED-404</h1>');

  const V = await workspace.createUserWithWorkspace({
    email: 'staff-v@fixture.test',
    password: PW,
    name: 'Staff V',
  });
  const vDb = openWorkspaceDb(V.workspaceId);
  const vLead = vDb
    .prepare('INSERT INTO leads (business_name, email) VALUES (?, ?)')
    .run('Control Biz', 'staff-v@fixture.test');
  const vSite = vDb
    .prepare('INSERT INTO websites (name, status, lead_id, theme, pages) VALUES (?, ?, ?, ?, ?)')
    .run('V Site', 'published', Number(vLead.lastInsertRowid), 'classic', '[]');
  const vFolder = `ws-${V.workspaceId}-site-${vSite.lastInsertRowid}`;
  const vDir = path.join(process.env.EXPORT_ROOT, vFolder);
  fs.mkdirSync(vDir, { recursive: true });
  fs.writeFileSync(path.join(vDir, 'index.html'), '<!doctype html><title>V</title><h1>V-SITE-MARKER</h1>');

  await query(
    `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
     VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
    {
      e: 'staff-w@fixture.test',
      h: bcrypt.hashSync(PW, 12),
      w: Number(W.workspaceId),
      l: Number(wLead.lastInsertRowid),
      b: 'Suspended Biz',
    }
  );

  const SA = await workspace.createUserWithWorkspace({
    email: 'root-sa@fixture.test',
    password: PW,
    name: 'Root SA',
  });
  await query(`UPDATE users SET is_super_admin = 1 WHERE id = :id`, { id: SA.userId });

  // Suspend W BEFORE the server boots (the live flip 200→503→200 is
  // proven in production; here the seeded state must be visible to a
  // fresh process purely from the DBs).
  const sentSeed = [];
  const ep = await suspension.suspendForSubscription(
    { id: 'sub_w119', customer: 'cus_sub_w119', status: 'unpaid', metadata: { user_id: String(W.userId) } },
    {
      sendMail: async (m) => {
        sentSeed.push(m);
        return { sent: true };
      },
      openDb: (id) => openWorkspaceDb(id),
    }
  );
  assert.ok(ep && ep.suspended === true && ep.suspension && ep.suspension.id, 'seed suspension created');
  assert.strictEqual(sentSeed.length, 1, 'seed suspension sent weekly email #1');

  const PORT = 20000 + Math.floor(Math.random() * 20000);
  const BASE = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));

  const jar = () => {
    const cookies = new Map();
    return {
      async fetch(url, opts = {}) {
        // x-forwarded-proto https: session cookies are Secure behind
        // the proxy — without it the server will not issue them.
        const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
        const cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
        if (cookie) headers.cookie = cookie;
        if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
        const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
        const setCookies =
          typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : [res.headers.get('set-cookie')].filter(Boolean);
        for (const sc of setCookies) {
          const pair = String(sc).split(';')[0];
          const eq = pair.indexOf('=');
          if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
        return res;
      },
    };
  };
  const post = async (j, p, body) => {
    const res = await j.fetch(`${BASE}${p}`, { method: 'POST', body: JSON.stringify(body || {}) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const get = async (j, p) => {
    const res = await j.fetch(`${BASE}${p}`);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const getText = async (p) => {
    const res = await fetch(`${BASE}${p}`);
    return { status: res.status, text: await res.text() };
  };

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        const r = await fetch(`${BASE}/healthz`);
        up = r.status === 200;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert.ok(up, 'server did not come up:\n' + serverLog.slice(-2000));

    await test('suspended site serves 503 generic; control site stays 200', async () => {
      const w = await getText(`/site-previews/${wFolder}/`);
      assert.strictEqual(w.status, 503, w.text.slice(0, 200));
      assert.ok(!w.text.includes('W-SITE-MARKER'), 'no site content leaks');
      assert.ok(/temporarily unavailable/i.test(w.text), 'generic error body');
      const missing = await getText(`/site-previews/${wFolder}/nope.html`);
      assert.strictEqual(missing.status, 503, 'a missing path must not leak the themed 404');
      assert.ok(!missing.text.includes('W-THEMED-404'));
      const v = await getText(`/site-previews/${vFolder}/`);
      assert.strictEqual(v.status, 200);
      assert.ok(v.text.includes('V-SITE-MARKER'));
    });

    const portalJar = jar();
    await test('portal narrows to billing while suspended', async () => {
      const login = await post(portalJar, '/api/v1/portal/login', {
        email: 'staff-w@fixture.test',
        password: PW,
      });
      assert.strictEqual(login.status, 200, JSON.stringify(login.body).slice(0, 200));
      const me = await get(portalJar, '/api/v1/portal/me');
      assert.strictEqual(me.status, 200);
      assert.ok(
        me.body.data.suspension && me.body.data.suspension.suspended === true,
        JSON.stringify(me.body.data.suspension)
      );
      const panel = await get(portalJar, '/api/v1/portal/newsletter');
      assert.strictEqual(panel.status, 403, JSON.stringify(panel.body).slice(0, 200));
      assert.strictEqual(panel.body.code, 'ACCOUNT_SUSPENDED');
      const billingRes = await get(portalJar, '/api/v1/portal/billing');
      assert.strictEqual(billingRes.status, 200, JSON.stringify(billingRes.body).slice(0, 200));
      assert.ok(billingRes.body.data.suspension && billingRes.body.data.suspension.suspended === true);
      assert.ok(/suspended/i.test(String(billingRes.body.data.notice || '')), 'billing panel explains the suspension');
    });

    // Staff sessions complete the platform's MFA enrollment flow
    // (login → enroll/start → TOTP confirm), the batch53 pattern.
    const totp = require(path.join(ROOT, 'src/totp.js'));
    const staffSession = async (email) => {
      const j = jar();
      const login = await post(j, '/api/v1/auth/login', { email, password: PW });
      assert.strictEqual(login.status, 200, JSON.stringify(login.body).slice(0, 200));
      assert.strictEqual(login.body.data.mfaRequired, true, 'staff login parks at the MFA challenge');
      const start = await post(j, '/api/v1/auth/mfa/enroll/start', {});
      assert.strictEqual(start.status, 200, JSON.stringify(start.body).slice(0, 200));
      const confirm = await post(j, '/api/v1/auth/mfa/enroll/confirm', {
        code: totp.totp(start.body.data.secret),
      });
      assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body).slice(0, 200));
      return j;
    };

    const staffJar = await staffSession('staff-w@fixture.test');
    await test('staff writes blocked; reads + billing summary stay open', async () => {
      const write = await post(staffJar, '/api/v1/leads', { business_name: 'Blocked Write Co' });
      assert.strictEqual(write.status, 403, JSON.stringify(write.body).slice(0, 300));
      assert.strictEqual(write.body.code, 'ACCOUNT_SUSPENDED');
      const reads = await get(staffJar, '/api/v1/leads');
      assert.strictEqual(reads.status, 200, 'reads continue while suspended');
      const summary = await get(staffJar, '/api/v1/billing/summary');
      assert.strictEqual(summary.status, 200, 'billing stays reachable so the owner can pay');
      assert.strictEqual(summary.body.data.suspended, true, JSON.stringify(summary.body).slice(0, 300));
    });

    const adminJar = await staffSession('root-sa@fixture.test');
    await test('admin sees the suspension and unsuspend restores site + writes', async () => {
      const list = await get(adminJar, '/api/v1/admin/suspensions');
      assert.strictEqual(list.status, 200, JSON.stringify(list.body).slice(0, 200));
      const mine = (list.body.data.suspensions || []).find((s) => Number(s.user_id) === Number(W.userId));
      assert.ok(mine, 'suspended account listed for staff');
      assert.ok(mine.suspended_at && mine.reason, 'reason + date visible');
      const un = await post(adminJar, `/api/v1/admin/suspensions/${W.userId}/unsuspend`, {});
      assert.strictEqual(un.status, 200, JSON.stringify(un.body).slice(0, 200));
      const w = await getText(`/site-previews/${wFolder}/`);
      assert.strictEqual(w.status, 200, 'site restored instantly');
      assert.ok(w.text.includes('W-SITE-MARKER'), 'restored content is the original content');
      const write = await post(staffJar, '/api/v1/leads', { business_name: 'Restored Write Co' });
      assert.ok(write.status === 200 || write.status === 201, `writes open again (${write.status})`);
    });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/* ================================ main ================================ */

(async () => {
  const { migrate } = require(path.join(ROOT, 'server/db.js'));
  await migrate();
  await part1();
  await part2();
  await part3();
  console.log(`\nbatch119-suspension-regressions: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error('batch119 suite crashed:', e);
  process.exit(1);
});
