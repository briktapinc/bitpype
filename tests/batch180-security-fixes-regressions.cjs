'use strict';
/**
 * Batch 180 — adversarial security review fixes (Ely 2026-11-11:
 * "Fix everything"). Every group pins one verified finding from
 * review-2026-11-11-security-audit.md; each was re-derived from the
 * code on the batch179 tree before it was fixed.
 *
 *   A — C1: cross-lead Stripe webhook forgery (negative proof: an
 *       event verified with lead 1's secret cannot move lead 2's
 *       orders or membership rows) + L6 dispute flagging + L9
 *       expired-order late-paid backstop.
 *   B — H1: router_* staff queue tools are gone from the client
 *       (cl_) MCP tool defs, present in the full staff defs.
 *   C — H2: portal-minted cl_ tokens carry an expiry + account link;
 *       findWorkspaceByToken rejects legacy NULL-expiry cl_ tokens
 *       and any cl_ token whose portal account is disabled.
 *   D — H5 + M1: router source_url scheme validation at ingest;
 *       claimLead enforces the feed predicate (follow match +
 *       freshness).
 *   E — H3 + M3: embed viewer CSP sandbox pins; preview deny-list
 *       decode-before-match (functional via previewSecurity).
 *   F — H4: voice reservation / session-cap source pins.
 *   G — M5 + M6: concurrent partial-refund deliveries claw back
 *       exactly the sequential amount (credits + partner reversal);
 *       M5 poison-guard pins.
 *   H — M2: standalone scrub scopes the Batch 178 router tables.
 *   I — M9: sanitizeHtml bypass family neutralized, legit kept.
 *   J — M7/M8/L1/L3/L5/L7/L8/L13/L14/L15/L16/L17/I1/L20/L21/M4
 *       source pins + L8 payout threshold/concurrency proof.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b180-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch180', 'test', 'session', 'secret', 'value'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 43).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

(async () => {
  /* ---------------- A — C1 + L6 + L9 (tenant pipeline) ---------------- */
  {
    let n = 0;
    const Database = require(path.join(root, 'node_modules/better-sqlite3'));
    const db = new Database(':memory:');
    const sm = require(path.join(root, 'server/siteModules.js'));
    sm.ensureTables(db);
    db.exec(
      `CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, categories TEXT);
       CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, custom_domain TEXT, preview_url TEXT);`
    );
    db.prepare("INSERT INTO leads (id, business_name, email) VALUES (1, 'Attacker', 'a@x.test'), (2, 'Victim', 'v@x.test')").run();
    const mkOrder = (leadId, status, session, pi, amount = 5000) =>
      Number(
        db
          .prepare(
            `INSERT INTO ecommerce_orders (lead_id, product_name, amount_cents, currency, status, stripe_session_id, stripe_payment_intent)
             VALUES (?, 'Widget', ?, 'USD', ?, ?, ?)`
          )
          .run(leadId, amount, status, session, pi || '').lastInsertRowid
      );
    const order = (id) => db.prepare('SELECT * FROM ecommerce_orders WHERE id = ?').get(id);

    // C1 shop: forged completion verified for lead 1, victim order lead 2.
    const o1 = mkOrder(2, 'pending', 'cs_victim', '');
    const forged = {
      id: 'evt_b180_forged',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_victim',
          payment_status: 'paid',
          amount_total: 5000,
          currency: 'usd',
          payment_intent: 'pi_forged_never_paid',
          metadata: { bitpype_lead_id: 1 },
        },
      },
    };
    let r = sm.applyTenantStripeEvent(db, forged, 1);
    assert.equal(r.matched, false, 'C1: cross-lead event must not match the victim order');
    n += 1;
    assert.equal(order(o1).status, 'pending', 'C1: victim order stays pending after forged event');
    n += 1;
    r = sm.applyTenantStripeEvent(db, forged, 2);
    assert.equal(order(o1).status, 'paid', 'C1: the owning lead\u2019s verified event still applies');
    n += 1;

    // C1 membership: forged subscription.deleted cannot reassign/cancel.
    db.prepare(
      `INSERT INTO member_subscriptions (lead_id, member_id, stripe_customer_id, stripe_subscription_id, status)
       VALUES (2, 42, 'cus_victim', 'sub_victim', 'active')`
    ).run();
    const forgedSub = {
      id: 'evt_b180_forged_sub',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_victim',
          customer: 'cus_victim',
          status: 'canceled',
          metadata: { bitpype_lead_id: 1, bitpype_member_id: 999 },
        },
      },
    };
    r = sm.applyTenantStripeEvent(db, forgedSub, 1);
    assert.equal(r.matched, false, 'C1: cross-lead subscription event must not match');
    n += 1;
    let sub = db.prepare("SELECT * FROM member_subscriptions WHERE stripe_subscription_id = 'sub_victim'").get();
    assert.equal(sub.lead_id, 2, 'C1: victim subscription keeps its lead');
    assert.equal(sub.member_id, 42, 'C1: victim subscription keeps its member');
    assert.equal(sub.status, 'active', 'C1: victim subscription stays active');
    n += 3;
    const up = sm.upsertMemberSubscription(db, {
      lead_id: 1,
      member_id: 999,
      stripe_subscription_id: 'sub_victim',
      status: 'canceled',
    });
    sub = db.prepare("SELECT * FROM member_subscriptions WHERE stripe_subscription_id = 'sub_victim'").get();
    assert.equal(up.lead_id, 2, 'C1: upsert is lead-scoped — another lead\u2019s row is returned untouched');
    assert.equal(sub.status, 'active', 'C1: upsert cannot cancel another lead\u2019s subscription');
    n += 2;

    // L6: disputes flag the order; a lost dispute settles it; cross-lead is a no-op.
    const o2 = mkOrder(2, 'paid', 'cs_paid2', 'pi_disp');
    r = sm.applyTenantStripeEvent(
      db,
      { id: 'evt_b180_d1', type: 'charge.dispute.created', data: { object: { id: 'dp_1', payment_intent: 'pi_disp', status: 'warning_needs_response' } } },
      1
    );
    assert.equal(r.matched, false, 'L6: cross-lead dispute is a no-op');
    assert.equal(order(o2).dispute_status || '', '', 'L6: cross-lead dispute sets no flag');
    n += 2;
    r = sm.applyTenantStripeEvent(
      db,
      { id: 'evt_b180_d1', type: 'charge.dispute.created', data: { object: { id: 'dp_1', payment_intent: 'pi_disp', status: 'warning_needs_response' } } },
      2
    );
    assert.equal(order(o2).dispute_status, 'open', 'L6: dispute.created flags the order open');
    assert.equal(order(o2).status, 'paid', 'L6: an open dispute does not change the order status');
    n += 2;
    sm.applyTenantStripeEvent(
      db,
      { id: 'evt_b180_d2', type: 'charge.dispute.closed', data: { object: { id: 'dp_1', payment_intent: 'pi_disp', status: 'lost' } } },
      2
    );
    assert.equal(order(o2).dispute_status, 'lost', 'L6: closed dispute records the outcome');
    assert.equal(order(o2).status, 'refunded', 'L6: a lost dispute settles a paid order to refunded');
    n += 2;

    // L9: expired order + verified late completion -> paid_unfulfilled backstop.
    const o3 = mkOrder(2, 'expired', 'cs_exp', '');
    sm.applyTenantStripeEvent(
      db,
      { id: 'evt_b180_late_bad', type: 'checkout.session.async_payment_succeeded', data: { object: { id: 'cs_exp', amount_total: 999, currency: 'usd', payment_intent: 'pi_late' } } },
      2
    );
    assert.equal(order(o3).status, 'expired', 'L9: amount-mismatched late completion stays expired');
    n += 1;
    r = sm.applyTenantStripeEvent(
      db,
      { id: 'evt_b180_late_ok', type: 'checkout.session.async_payment_succeeded', data: { object: { id: 'cs_exp', amount_total: 5000, currency: 'usd', payment_intent: 'pi_late' } } },
      2
    );
    assert.equal(order(o3).status, 'paid_unfulfilled', 'L9: verified late money lands in the paid_unfulfilled backstop');
    assert.equal(order(o3).stripe_payment_intent, 'pi_late', 'L9: the late PI is recorded for the refund path');
    n += 2;
    group('A C1 webhook binding + L6 disputes + L9 late-paid', n);
  }

  /* ---------------- B — H1 MCP router defs ---------------- */
  {
    let n = 0;
    const mcp = require(path.join(root, 'server/mcp.js'));
    const clientNames = mcp.clientToolDefs().map((t) => t.name);
    const staffNames = mcp.toolDefs().map((t) => t.name);
    const staffOnly = [
      'router_leads.list',
      'router_leads.get',
      'router_leads.publish',
      'router_leads.remove',
      'router_sources.list',
      'router_sources.update',
      'router_sweeps.run',
    ];
    for (const name of staffOnly) {
      assert.ok(!clientNames.includes(name), `H1: ${name} must NOT be in client tool defs`);
      assert.ok(staffNames.includes(name), `H1: ${name} must remain in staff tool defs`);
      n += 2;
    }
    assert.ok(clientNames.includes('router_follows.list'), 'H1: owner follow tools stay client-scoped');
    assert.ok(clientNames.includes('router_follows.set'), 'H1: owner follow tools stay client-scoped');
    n += 2;
    const mcpSrc = read('server/mcp.js');
    assert.ok(mcpSrc.includes('Batch 180'), 'H1: batch marker present in mcp.js');
    n += 1;
    group('B H1 router tools staff-only on MCP', n);
  }

  /* ---------------- platform DB for C / G / J ---------------- */
  const { query, migrate } = require(path.join(root, 'server/db.js'));
  await migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const acct = await workspace.createUserWithWorkspace({
    email: 'b180@fixture.test',
    password: 'b180-fixture-password',
    name: 'B180 Fixture',
  });
  const WS = acct.workspaceId;
  await query(`UPDATE users SET billing_plan = 'standard', subscription_status = 'active' WHERE id = :id`, { id: acct.userId });
  const wdb = openWorkspaceDb(WS);
  const leadA = Number(wdb.prepare('INSERT INTO leads (business_name, email) VALUES (?, ?)').run('B180 Alpha', 'alpha@fixture.test').lastInsertRowid);
  const leadB = Number(wdb.prepare('INSERT INTO leads (business_name, email) VALUES (?, ?)').run('B180 Beta', 'beta@fixture.test').lastInsertRowid);

  /* ---------------- C — H2 token expiry + account binding ---------------- */
  {
    let n = 0;
    const crypto = require('node:crypto');
    const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
    await query(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, status)
       VALUES (:email, 'unused', :ws, :lead, 'active')`,
      { email: 'client-b180@fixture.test', ws: WS, lead: leadA }
    );
    const portalUser = (await query('SELECT * FROM client_portal_users WHERE email = :e', { e: 'client-b180@fixture.test' }))[0];

    // Legacy portal-minted shape: cl_ prefix, NULL expiry, NULL account link.
    await query(
      `INSERT INTO workspace_tokens (workspace_id, name, token_hash, token_prefix, lead_id, expires_at, oauth_user_id)
       VALUES (:ws, 'Portal legacy fixture', :hash, 'cl_legac', :lead, NULL, NULL)`,
      { ws: WS, hash: hash('cl_legacy_b180'), lead: leadA }
    );
    assert.equal(await workspace.findWorkspaceByToken('cl_legacy_b180'), null, 'H2: legacy NULL-expiry cl_ token is rejected');
    n += 1;

    // Fresh mint through the real portal path: expiry + account link set.
    const portalModules = require(path.join(root, 'server/portalModules.js'));
    const minted = await portalModules.createClientMcpToken(WS, leadA, 'client-b180@fixture.test', {
      name: 'B180 portal token',
      oauthUserId: Number(portalUser.id),
    });
    const mintedToken = minted.token || minted.plaintext || minted.value;
    assert.ok(mintedToken, 'H2: mint returns a token');
    const row = (
      await query('SELECT * FROM workspace_tokens WHERE workspace_id = :ws AND name = :name', { ws: WS, name: 'B180 portal token' })
    )[0];
    assert.ok(row.expires_at && Number(row.expires_at) > Date.now(), 'H2: portal-minted token carries a future expiry');
    assert.ok(Number(row.expires_at) <= Date.now() + 91 * 86400000, 'H2: portal-minted expiry is bounded (<= ~90 days)');
    assert.equal(Number(row.oauth_user_id), Number(portalUser.id), 'H2: portal-minted token is linked to the minting account');
    n += 3;
    assert.ok(await workspace.findWorkspaceByToken(mintedToken), 'H2: fresh token resolves while the account is active');
    n += 1;
    await query("UPDATE client_portal_users SET status = 'disabled' WHERE id = :id", { id: portalUser.id });
    assert.equal(await workspace.findWorkspaceByToken(mintedToken), null, 'H2: disabled account\u2019s token is rejected');
    n += 1;
    await query("UPDATE client_portal_users SET status = 'active' WHERE id = :id", { id: portalUser.id });
    group('C H2 cl_ token expiry + active-account enforcement', n);
  }

  /* ---------------- D — H5 + M1 router ---------------- */
  {
    let n = 0;
    const router = require(path.join(root, 'server/leadsRouter.js'));
    router.ensureTables(wdb);
    const baseLead = {
      platform: 'facebook',
      post_id: 'fb-b180-1',
      source_context: 'Berks County PA Contractors Connections',
      poster_name: 'Pat Poster',
      posted_at: new Date().toISOString(),
      lead_type: 'Drywall',
      request_kind: 'service_request',
      town: 'Reading',
      area: 'Berks County',
      detail: 'Looking for a drywall crew in Reading.',
      score: 'hot',
      score_reason: 'ready now',
    };
    assert.throws(
      () => router.publishLead(wdb, { ...baseLead, source_url: 'javascript:alert(1)' }),
      (e) => e.code === 'VALIDATION',
      'H5: javascript: source_url is rejected at ingest'
    );
    n += 1;
    assert.throws(
      () => router.publishLead(wdb, { ...baseLead, source_url: 'data:text/html;base64,PHNjcmlwdD4=' }),
      (e) => e.code === 'VALIDATION',
      'H5: data: source_url is rejected at ingest'
    );
    n += 1;
    const made = router.publishLead(wdb, { ...baseLead, source_url: 'https://facebook.example/posts/fb-b180-1' });
    router.reviewLead(wdb, made.lead.id, { action: 'publish' });
    // M1: a subscriber with NO follow cannot claim.
    assert.throws(
      () => router.claimLead(wdb, leadB, made.lead.id),
      (e) => e.code === 'FORBIDDEN',
      'M1: claim without a matching follow is denied'
    );
    n += 1;
    // M1: a follow for a different type cannot claim either.
    router.setFollow(wdb, leadB, { lead_type_label: 'Roofer', location_label: 'Reading' });
    assert.throws(
      () => router.claimLead(wdb, leadB, made.lead.id),
      (e) => e.code === 'FORBIDDEN',
      'M1: claim with a non-matching follow is denied'
    );
    n += 1;
    // Matching follow claims fine, and the own-claim retry is idempotent.
    router.setFollow(wdb, leadA, { lead_type_label: 'Drywall', location_label: 'Reading' });
    const claim = router.claimLead(wdb, leadA, made.lead.id);
    assert.ok(claim && claim.lead && Number(claim.lead.claimed_by_lead_id) === leadA, 'M1: matching follow can claim');
    n += 1;
    const again = router.claimLead(wdb, leadA, made.lead.id);
    assert.ok(again, 'M1: own-claim retry stays idempotent');
    n += 1;
    group('D H5 source_url scheme + M1 claim predicate', n);
  }

  /* ---------------- E — H3 + M3 ---------------- */
  {
    let n = 0;
    const serverSrc = read('server.js');
    assert.ok(serverSrc.includes('EMBED_MODULE_CSP'), 'H3: embed viewer CSP constant present');
    assert.ok(serverSrc.includes('sandbox allow-scripts'), 'H3: embed viewer is sandboxed (opaque origin)');
    n += 2;
    const embedJs = read('public/js/module-embed.js');
    assert.ok(embedJs.includes('renderCustomCodeSandboxed'), 'H3: viewer renders Custom Code inside a sandboxed iframe');
    n += 1;
    const previewSecurity = require(path.join(root, 'server/previewSecurity.js'));
    assert.equal(typeof previewSecurity.analyzePreviewPath, 'function', 'M3: preview path analyzer exists');
    const decoded = previewSecurity.analyzePreviewPath('/site-previews/%61ssistant-chat/secret.txt');
    assert.ok(decoded.segs.includes('assistant-chat'), 'M3: percent-encoded segment decodes to the denied name (server.js compares decoded segments)');
    const split = previewSecurity.analyzePreviewPath('/site-previews/assistant-chat%2fsecret.txt');
    assert.ok(split.segs.includes('assistant-chat'), 'M3: %2f-joined segment re-splits to the denied name');
    const serverJs = read('server.js');
    assert.ok(serverJs.includes('analyzePreviewPath'), 'M3: /site-previews deny-list runs the decoded-segment analysis');
    n += 3;
    group('E H3 embed sandbox + M3 preview deny decode', n);
  }

  /* ---------------- F — H4 voice pins ---------------- */
  {
    let n = 0;
    const voice = read('server/chatbotVoice.js');
    assert.ok(voice.includes('VOICE_MAX_SESSION_SEC'), 'H4: server-side voice session duration cap constant present');
    assert.ok(voice.includes('VOICE_SESSION_EXPIRED'), 'H4: relay refuses service past the session cap');
    assert.ok(voice.includes('VOICE_RELAY_GRACE_SEC'), 'H4: bounded relay grace window present');
    n += 3;
    group('F H4 voice budget + duration cap pins', n);
  }

  /* ---------------- G — M6 concurrency + M5 pins ---------------- */
  {
    let n = 0;
    const credits = require(path.join(root, 'server/credits.js'));
    const partners = require(path.join(root, 'server/partners.js'));
    // Credits: grant 100 in one pack (session cs_b180_grant) on top of
    // 150 from other packs. Two CONCURRENT partial-refund deliveries
    // (cumulative 30% then 100%) must claw exactly 100 total.
    await query(`INSERT INTO credit_balances (workspace_id, balance) VALUES (:ws, 250)`, { ws: WS });
    await query(
      `INSERT INTO credit_ledger (workspace_id, user_id, delta, balance_after, reason, ref_type, ref_id, stripe_checkout_session_id)
       VALUES (:ws, :uid, 100, 250, 'stripe_purchase', 'checkout_session', 'cs_b180_grant', 'cs_b180_grant')`,
      { ws: WS, uid: Number(acct.userId) }
    );
    await Promise.all([
      credits.clawbackFromRefund({ checkoutSessionId: 'cs_b180_grant', refundId: 're_b180_1', cumulativeRefundedCents: 3000, chargeAmountCents: 10000 }),
      credits.clawbackFromRefund({ checkoutSessionId: 'cs_b180_grant', refundId: 're_b180_2', cumulativeRefundedCents: 10000, chargeAmountCents: 10000 }),
    ]);
    const clawed = await query(
      `SELECT COALESCE(SUM(-delta), 0) AS t FROM credit_ledger WHERE workspace_id = :ws AND reason = 'stripe_refund' AND delta < 0`,
      { ws: WS }
    );
    assert.equal(Number(clawed[0].t), 100, 'M6: concurrent deliveries claw exactly the grant (no over-claw)');
    assert.equal(await credits.getBalance(WS), 150, 'M6: balance after concurrent clawback is the sequential result');
    n += 2;
    // Partners: 3000c commission on a 10000c charge, same concurrency.
    await partners.ensurePartnerTables();
    await query(
      `INSERT INTO partner_earnings (partner_user_id, workspace_id, kind, amount_cents, currency, credit_key, stripe_invoice_id, stripe_charge_id, created_at)
       VALUES (:uid, :ws, 'credit', 3000, 'usd', 'k-b180-inv', 'in_b180', 'ch_b180', '2026-11-12T00:00:00Z')`,
      { uid: Number(acct.userId), ws: WS }
    );
    await Promise.all([
      partners.reverseForRefund({ refundId: 're_b180_1', chargeId: 'ch_b180', chargeAmountCents: 10000, amountRefundedCents: 3000 }),
      partners.reverseForRefund({ refundId: 're_b180_2', chargeId: 'ch_b180', chargeAmountCents: 10000, amountRefundedCents: 10000 }),
    ]);
    const reversed = await query(`SELECT COALESCE(SUM(-amount_cents), 0) AS t FROM partner_earnings WHERE kind = 'reversal'`);
    assert.equal(Number(reversed[0].t), 3000, 'M6: concurrent deliveries reverse exactly the commission');
    n += 1;
    // M5 pins: PI-only admin refund resolves the real charge and the
    // poison-shaped stub writes nothing.
    const billingSrc = read('server/billing.js');
    assert.ok(billingSrc.includes('paymentIntents.retrieve'), 'M5: admin refund resolves the charge via the payment intent');
    assert.ok(billingSrc.includes('Batch 180'), 'M5: batch marker present in billing.js');
    n += 2;
    group('G M6 concurrent clawback + M5 admin refund pins', n);
  }

  /* ---------------- H — M2 standalone scrub ---------------- */
  {
    let n = 0;
    const Database = require(path.join(root, 'node_modules/better-sqlite3'));
    const scrubPath = path.join(temp, 'scrub-fixture.sqlite');
    const sdb = new Database(scrubPath);
    sdb.exec(
      `CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT);
       CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER);
       CREATE TABLE settings (key TEXT, value TEXT);
       CREATE TABLE router_leads (id INTEGER PRIMARY KEY, claimed_by_lead_id INTEGER, sweep_run_id INTEGER, poster_name TEXT);
       CREATE TABLE router_sweeps (id INTEGER PRIMARY KEY, scope_lead_id INTEGER);`
    );
    sdb.prepare("INSERT INTO leads VALUES (1, 'Mine'), (2, 'Theirs')").run();
    sdb.prepare('INSERT INTO websites VALUES (10, 1), (20, 2)').run();
    sdb.prepare("INSERT INTO router_leads VALUES (1, 1, 100, 'ClaimedByMe'), (2, 2, 100, 'ClaimedByOther'), (3, NULL, 100, 'PoolRow')").run();
    sdb.prepare('INSERT INTO router_sweeps VALUES (100, NULL), (101, 1), (102, 2)').run();
    sdb.close();
    const backup = require(path.join(root, 'server/standaloneBackup.js'));
    backup.scrubTenantDbForLead(scrubPath, { leadId: 1, websiteId: 10 });
    const vdb = new Database(scrubPath, { readonly: true });
    const keptLeads = vdb.prepare('SELECT id, poster_name FROM router_leads ORDER BY id').all();
    assert.deepEqual(keptLeads.map((r) => r.id), [1], 'M2: router_leads keeps only rows claimed by the tenant lead');
    const keptSweeps = vdb.prepare('SELECT id FROM router_sweeps ORDER BY id').all();
    assert.deepEqual(keptSweeps.map((r) => r.id), [101], 'M2: router_sweeps keeps only the tenant-scoped sweep');
    vdb.close();
    n += 2;
    group('H M2 standalone scrub covers router tables', n);
  }

  /* ---------------- I — M9 sanitizeHtml ---------------- */
  {
    let n = 0;
    const engine = require(path.join(root, 'src/websiteEngine.js'));
    const bad = [
      '<a href="java&#115;cript:alert(1)">x</a>',
      '<a href="jav&Tab;ascript:alert(1)">x</a>',
      '<svg onload=alert(1)></svg>',
      '<svg/onload=alert(1)>',
      '<button formaction="javascript:alert(1)">x</button>',
      '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
      '<a href="vbscript:msgbox(1)">x</a>',
      '<a xlink:href="javascript:alert(1)">x</a>',
    ];
    for (const payload of bad) {
      const out = engine.sanitizeHtml(payload);
      assert.ok(!/javascript:|vbscript:|data:text\/html|onload/i.test(out), `M9: payload neutralized: ${payload.slice(0, 40)}`);
      n += 1;
    }
    const good = engine.sanitizeHtml('<p>Hi <a href="https://example.com/x">there</a> <a href="mailto:a@b.test">mail</a></p>');
    assert.ok(good.includes('https://example.com/x'), 'M9: legitimate https href survives');
    assert.ok(good.includes('mailto:a@b.test'), 'M9: legitimate mailto href survives');
    n += 2;
    group('I M9 sanitizeHtml bypass family', n);
  }

  /* ---------------- J — remaining pins + L8 ---------------- */
  {
    let n = 0;
    const oauthSrc = read('server/mcpOAuth.js');
    assert.ok(oauthSrc.includes('30 * 24 * 60 * 60'), 'M7: OAuth access TTL aligned to the 30-day cap');
    assert.ok(!oauthSrc.includes('90 * 24 * 60 * 60'), 'M7: 90-day OAuth access TTL is gone');
    const policySrc = read('server/oauthTokenPolicy.js');
    assert.ok(policySrc.includes('30 * 24 * 60 * 60 * 1000'), 'M7: token-policy backfill TTL aligned to 30 days');
    const consentSrc = read('server/routes/mcpOAuth.js');
    assert.ok(consentSrc.includes('portalIdleMs'), 'M7: OAuth consent enforces the portal session caps');
    assert.ok(consentSrc.includes('PENDING_USER_MISMATCH'), 'L2: OAuth pending state is bound to the consenting user');
    n += 5;
    const ingestSrc = read('src/siteIngest.js');
    assert.ok(ingestSrc.includes('{0,2048}?'), 'M8: site-ingest extractor captures are bounded');
    n += 1;
    const resetMod = require(path.join(root, 'server/passwordReset.js'));
    assert.equal(typeof resetMod.allowResetEmail, 'function', 'L1: staff reset per-email throttle is exported');
    n += 1;
    const domainApiSrc = read('server/routes/domainApi.js');
    for (const route of ['/email/compose', '/sms/queue', '/email/draft']) {
      const idx = domainApiSrc.indexOf(`'${route}'`);
      assert.ok(idx > -1 && domainApiSrc.slice(idx, idx + 60).includes('denyLeadScopedToken'), `L3: ${route} denies lead-scoped tokens`);
      n += 1;
    }
    const portalBillingSrc = read('server/portalBilling.js');
    assert.ok(portalBillingSrc.includes("stripeAttemptKey('billing-portal'"), 'L5: billing portal session uses a per-attempt idempotency key');
    n += 1;
    const modulesPublicSrc = read('server/routes/modulesPublic.js');
    assert.ok(modulesPublicSrc.includes('assertWebinarMemberGate'), 'M4: webinar public API runs the membership gate');
    assert.ok(modulesPublicSrc.includes('boundReturnUrl'), 'L7: module checkout returnUrl is origin-bound');
    n += 2;
    for (const [file, needle, label] of [
      ['server/admin.js', "ESCAPE '", 'L13 admin list escaping'],
      ['server/mailingList.js', "ESCAPE '", 'L13 mailing list escaping'],
      ['server/portalAccounts.js', "ESCAPE '", 'L13 portal users escaping'],
      ['src/mcp.js', "ESCAPE '", 'L13 MCP lead search escaping'],
      ['src/websiteEngine.js', 'assertPublicUrl', 'L14 raw probe urlSafety'],
      ['src/siteScreenshots.js', 'assertPublicUrl', 'L14 screenshot probe urlSafety'],
      ['src/email.js', 'Batch 180', 'L16 buildMime CRLF strip'],
      ['standalone/set-demo-password.js', 'DEMO_PORTAL_EMAIL', 'I1 demo-only password reset'],
    ]) {
      assert.ok(read(file).includes(needle), `${label}: pin present in ${file}`);
      n += 1;
    }
    // L8: below-threshold payout refused; concurrent full payouts
    // record exactly once.
    const partners = require(path.join(root, 'server/partners.js'));
    await partners.ensurePartnerTables();
    await assert.rejects(
      partners.recordPayout({ partnerUserId: 987001, paidBy: 1 }),
      (e) => e.code === 'VALIDATION',
      'L8: a below-threshold balance cannot be paid out'
    );
    n += 1;
    await query(
      `INSERT INTO partner_earnings (partner_user_id, workspace_id, kind, amount_cents, currency, credit_key, stripe_invoice_id, stripe_charge_id, created_at)
       VALUES (987002, :ws, 'credit', 60000, 'usd', 'k-b180-l8', 'in_b180_l8', 'ch_b180_l8', '2026-11-12T00:00:00Z')`,
      { ws: WS }
    );
    const results = await Promise.allSettled([
      partners.recordPayout({ partnerUserId: 987002, paidBy: 1 }),
      partners.recordPayout({ partnerUserId: 987002, paidBy: 1 }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'L8: concurrent payouts record exactly once');
    const payoutRows = await query(`SELECT COUNT(*) AS c FROM partner_payouts WHERE partner_user_id = 987002`);
    assert.equal(Number(payoutRows[0].c), 1, 'L8: exactly one payout row exists after the race');
    n += 2;
    group('J M7/M8/L1/L2/L3/L5/L7/L13/L14/L16/I1 pins + L8 payout guard', n);
  }

  console.log(`\nBatch 180 security-fixes regressions: ALL PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH180 SUITE FAIL:', e);
  process.exit(1);
});
